const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// --- [配置项] ---
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// 延迟小工具
const delay = ms => new Promise(res => setTimeout(res, ms));

// 截图小工具
async function snap(page, label) {
    try {
        const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 已保存截图: ${label}`);
    } catch (e) {
        console.error(`⚠️ 截图失败 (${label}):`, e.message);
    }
}

// 提取用户配置
function getUsers() {
    const raw = process.env.USERS_JSON || '';
    if (!raw) return [];
    try {
        if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch (e) {}
    return raw.split('\n').map(line => {
        const [username, password] = line.trim().split(':');
        return (username && password) ? { username: username.trim(), password: password.trim() } : null;
    }).filter(Boolean);
}

// 辅助函数：根据按钮文本检查是否在页面中可见
async function isBtnVisibleByText(page, text) {
    return await page.evaluate((txt) => {
        const elements = Array.from(document.querySelectorAll('button, a'));
        const btn = elements.find(el => {
            if (!el.textContent.trim().includes(txt)) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
        });
        return !!btn;
    }, text).catch(() => false);
}

// 辅助函数：通过按钮文本进行点击
async function clickBtnByText(page, text) {
    return await page.evaluate((txt) => {
        const elements = Array.from(document.querySelectorAll('button, a'));
        const btn = elements.find(el => el.textContent.trim().includes(txt));
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }, text).catch(() => false);
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error("❌ 未检测到合法的 USERS_JSON 配置");
        process.exit(1);
    }

    // 1. 配置浏览器连接参数
    const connectOptions = { 
        headless: false, // 必须为 false 才能在虚拟桌面中完美渲染、过盾并执行自动点击
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // 防止 CI 容器共享内存耗尽导致崩溃
            '--window-size=1280,720'
        ],
        customConfig: {},
        turnstile: true, // 核心：开启内置的 Cloudflare Turnstile 自动识别和对准点击功能
        connectOption: {
            defaultViewport: { width: 1280, height: 720 }
        },
        disableXvfb: true, // 禁用插件内置的 Xvfb。我们通过 Actions 外部的 xvfb-run 管理，防止冲突
        ignoreAllFlags: false
    };

    // 2. 解析 SOCKS5 代理参数
    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            connectOptions.proxy = {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port)
            };
            // 额外通过 chrome flags 注入 socks5 协议以确保连通性
            connectOptions.args.push(`--proxy-server=socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
            console.log(`📡 代理已配置为: socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
        } catch (e) {
            console.error("⚠️ 代理解析失败，继续使用直连模式:", e.message);
        }
    }

    // 3. 启动并连接至真实指纹浏览器
    let browser, firstPage;
    try {
        console.log(">> 正在初始化真实指纹浏览器...");
        const response = await connect(connectOptions);
        browser = response.browser;
        firstPage = response.page;
        console.log("✅ 浏览器创建成功");
    } catch (err) {
        console.error("❌ 浏览器启动失败，异常中断:", err.message);
        process.exit(1);
    }

    let isFirstUser = true;
    for (let user of users) {
        let page;
        try {
            if (isFirstUser) {
                page = firstPage;
                isFirstUser = false;
            } else {
                page = await browser.newPage();
            }

            // 设置视口大小以确保截图范围一致
            await page.setViewport({ width: 1280, height: 720 }).catch(() => {});

            // 4. 登录流程
            console.log(`=== 处理用户: ${user.username} ===`);
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await snap(page, `${user.username}_01_login_page`);

            // 等待输入框出现
            await page.waitForSelector('input[type="email"]', { timeout: 15000 });
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });

            // 清理输入框，防止残留
            await page.evaluate(() => {
                document.querySelector('input[type="email"]').value = '';
                document.querySelector('input[type="password"]').value = '';
            });

            // 模拟人类延迟键入
            await page.type('input[type="email"]', user.username, { delay: 50 });
            await page.type('input[type="password"]', user.password, { delay: 50 });
            await snap(page, `${user.username}_02_filled_form`);

            // 5. 等待验证通过与 Token 生成
            console.log(">> 等待 Cloudflare 自动检测 & Token 就绪...");
            let isVerified = false;
            for (let i = 0; i < 15; i++) {
                // 轮询验证码容器，检查 cf-turnstile-response 的 Token 长度是否就绪
                const hasToken = await page.evaluate(() => {
                    const el = document.querySelector('[name="cf-turnstile-response"]');
                    return el && el.value && el.value.length > 20;
                }).catch(() => false);

                if (hasToken) {
                    console.log("✅ Cloudflare 验证通过 (已自动获取授权 Token)");
                    isVerified = true;
                    break;
                }
                await delay(2000);
            }

            await snap(page, `${user.username}_03_after_token_wait`);

            if (!isVerified) {
                console.log("⚠️ 超过 30 秒仍未检测到 Token 生成，强行尝试提交...");
            }

            // 提交表单
            await page.click('button[type="submit"]');
            await delay(8000); // 等待页面重定向和鉴权加载完成
            await snap(page, `${user.username}_04_after_submit`);

            // 6. 续期流程
            if (SERVER_URL) {
                await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
                await snap(page, `${user.username}_05_server_page`);
            }

            let success = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (await isBtnVisibleByText(page, "Renew")) {
                    await clickBtnByText(page, "Renew");
                    await delay(3000);
                    
                    // 确认可能弹出的二次确认框
                    if (await isBtnVisibleByText(page, "Confirm")) {
                        await clickBtnByText(page, "Confirm");
                    } else if (await isBtnVisibleByText(page, "Renew")) {
                        await clickBtnByText(page, "Renew");
                    }

                    success = true;
                    await snap(page, `${user.username}_06_renew_clicked`);
                    break;
                }
                await snap(page, `${user.username}_06_attempt${attempt}_no_button`);
                await page.reload();
                await delay(5000);
            }

            console.log(success ? `✅ ${user.username} 续期操作完成` : `⚠️ ${user.username} 未在页面内检索到有效的续期入口`);

        } catch (err) {
            console.error(`❌ 处理用户 ${user.username} 时发生内部错误:`, err.message);
            if (page && !page.isClosed()) {
                await snap(page, `${user.username}_ERROR`);
            }
        } finally {
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
        }
    }

    console.log(">> 所有用户任务执行完毕，正在释放浏览器会话。");
    await browser.close();
})();
