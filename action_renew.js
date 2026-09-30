const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// --- [配置项] ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;
const CHROME_PATH = process.env.CHROME_PATH ? process.env.CHROME_PATH.trim() : '';

const LOGIN_URL = 'https://dashboard.katabump.com/auth/login';
const MAX_LOGIN_ATTEMPTS = 3;      // 登录最大重试次数
const TURNSTILE_TIMEOUT_SEC = 60;  // 单次登录尝试中等待 Turnstile 的最长秒数

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// --- [小工具] ---
const delay = ms => new Promise(res => setTimeout(res, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function snap(page, label) {
    try {
        const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 已保存截图: ${label}`);
    } catch (e) {
        console.error(`⚠️ 截图失败 (${label}):`, e.message);
    }
}

// 提取用户配置 (支持 JSON 数组，或每行 "邮箱:密码"，密码中允许包含冒号)
function getUsers() {
    const raw = process.env.USERS_JSON || '';
    if (!raw) return [];
    try {
        if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch (e) {}
    return raw.split('\n').map(line => {
        const l = line.trim();
        const idx = l.indexOf(':');
        if (idx <= 0) return null;
        const username = l.slice(0, idx).trim();
        const password = l.slice(idx + 1).trim();
        return (username && password) ? { username, password } : null;
    }).filter(Boolean);
}

// 发送 Telegram 消息
async function sendTGMessage(msg) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log("⚠️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过发送 TG 通知。");
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
        });
        if (res.ok) {
            console.log("📨 TG 通知发送成功！");
        } else {
            console.error("❌ TG 通知发送失败:", await res.text());
        }
    } catch (e) {
        console.error("❌ 发送 TG 通知出错:", e.message);
    }
}

// 清除浏览器全部 Cookie (保证多账号之间互不串号，重试登录时也是干净状态)
async function clearCookies(page) {
    try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach().catch(() => {});
    } catch (e) {
        console.log(`⚠️ 清除 Cookie 失败: ${e.message}`);
    }
}

// 启动后打印环境信息，方便以后对比 "为什么昨天能过今天不能过"
async function logEnvironment(browser, page) {
    try { console.log(`>> Chrome 版本: ${await browser.version()}`); } catch (e) {}
    try {
        const ua = await page.evaluate(() => navigator.userAgent);
        const wd = await page.evaluate(() => navigator.webdriver);
        console.log(`>> UA: ${ua}`);
        console.log(`>> navigator.webdriver: ${wd}`);
    } catch (e) {}
    try {
        await page.goto('https://www.cloudflare.com/cdn-cgi/trace', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const text = await page.evaluate(() => document.body.innerText);
        const keep = text.split('\n').filter(l => /^(loc|colo|http|tls|warp)=/.test(l));
        console.log(`>> 浏览器出口信息: ${keep.join(' | ') || '(空)'}`);
    } catch (e) {
        console.log(`⚠️ 出口信息获取失败: ${e.message}`);
    }
}

// ============ Cloudflare Turnstile 相关 ============

async function getTurnstileToken(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        return (el && el.value && el.value.length > 20) ? el.value : null;
    }).catch(() => null);
}

// 找到 Turnstile 组件在页面中的位置
async function getTurnstileBox(page) {
    return await page.evaluate(() => {
        const pick = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width > 50 && r.height > 30 && r.width <= 500 && r.height <= 150) {
                return { x: r.x, y: r.y, w: r.width, h: r.height };
            }
            return null;
        };
        let box = pick(document.querySelector('iframe[src*="challenges.cloudflare.com"]'));
        if (box) return box;
        const input = document.querySelector('[name="cf-turnstile-response"]');
        box = pick(input && input.parentElement);
        if (box) return box;
        return pick(document.querySelector('.cf-turnstile, [data-sitekey]'));
    }).catch(() => null);
}

// 模拟人手：曲线移动 → 停顿 → 点击
async function humanClick(page, x, y) {
    await page.mouse.move(x - rand(80, 160), y - rand(30, 80), { steps: 12 });
    await page.mouse.move(x, y, { steps: 18 });
    await delay(rand(150, 350));
    await page.mouse.click(x, y, { delay: rand(60, 140) });
}

// 手动点击 Turnstile 复选框 (作为 puppeteer-real-browser 自动点击的兜底)
async function clickTurnstile(page) {
    const box = await getTurnstileBox(page);
    if (!box) {
        console.log("   ↳ 未找到 Turnstile 组件位置，跳过手动点击");
        return false;
    }
    // 复选框在组件左侧，距左边约 28px，垂直居中
    const x = box.x + 28 + rand(-3, 3);
    const y = box.y + box.h / 2 + rand(-3, 3);
    await humanClick(page, x, y);
    console.log(`   ↳ 已手动点击 Turnstile 复选框 (${Math.round(x)}, ${Math.round(y)})`);
    return true;
}

async function resetTurnstile(page) {
    await page.evaluate(() => {
        if (window.turnstile && typeof window.turnstile.reset === 'function') window.turnstile.reset();
    }).catch(() => {});
}

// 等待并协助完成 Turnstile。返回是否拿到 token
// 节奏: 0~10s 交给插件自动点击 → 10s 手动点一次 → 25s 重置再点 → 40s 重置再点 → 超时失败
async function solveTurnstile(page, totalSec = TURNSTILE_TIMEOUT_SEC) {
    const start = Date.now();
    const steps = [10, 25, 40];
    let stepIdx = 0;

    while ((Date.now() - start) / 1000 < totalSec) {
        if (await getTurnstileToken(page)) return true;

        const t = (Date.now() - start) / 1000;
        if (stepIdx < steps.length && t >= steps[stepIdx]) {
            console.log(`   ↳ ${Math.round(t)}s 仍未拿到 token，进行第 ${stepIdx + 1} 次辅助处理`);
            if (stepIdx > 0) {
                await resetTurnstile(page);
                await delay(3000);
            }
            await clickTurnstile(page);
            stepIdx++;
        }
        await delay(2000);
    }
    return !!(await getTurnstileToken(page));
}

// ============ 登录相关 ============

async function fillLoginForm(page, user) {
    await page.focus('input[type="email"]');
    await page.evaluate(() => { document.querySelector('input[type="email"]').value = ''; });
    await page.type('input[type="email"]', user.username, { delay: 100 });

    await page.focus('input[type="password"]');
    await page.evaluate(() => { document.querySelector('input[type="password"]').value = ''; });
    await page.type('input[type="password"]', user.password, { delay: 100 });

    const checkedEmail = await page.$eval('input[type="email"]', el => el.value);
    const checkedPassword = await page.$eval('input[type="password"]', el => el.value);

    if (checkedEmail !== user.username || checkedPassword !== user.password) {
        console.log("⚠️ 检测到模拟输入丢失字符，正在进行强制修正...");
        await page.evaluate((u, p) => {
            const emailEl = document.querySelector('input[type="email"]');
            const passEl = document.querySelector('input[type="password"]');
            emailEl.value = u;
            emailEl.dispatchEvent(new Event('input', { bubbles: true }));
            emailEl.dispatchEvent(new Event('change', { bubbles: true }));
            passEl.value = p;
            passEl.dispatchEvent(new Event('input', { bubbles: true }));
            passEl.dispatchEvent(new Event('change', { bubbles: true }));
        }, user.username, user.password);
    }
}

async function getLoginError(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[class*="alert"], [class*="danger"], [class*="error"]');
        const txt = el ? el.textContent.trim() : '';
        return txt && txt.length < 200 ? txt : null;
    }).catch(() => null);
}

// 提交后轮询判断是否登录成功 (离开登录页且不再有密码框)
async function waitLoginResult(page, timeoutSec = 20) {
    for (let i = 0; i < timeoutSec; i++) {
        await delay(1000);
        try {
            const onLoginUrl = page.url().includes('/auth/login');
            const hasPwd = await page.$('input[type="password"]');
            if (!onLoginUrl && !hasPwd) return true;
        } catch (e) {
            // 页面跳转中，上下文被销毁，继续轮询
        }
    }
    return false;
}

// 带重试的登录。每次尝试都会清 Cookie、重新加载页面，返回是否成功
async function loginWithRetry(page, user) {
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        console.log(`>> 登录尝试 ${attempt}/${MAX_LOGIN_ATTEMPTS}`);
        const tag = `${user.username}_a${attempt}`;
        try {
            await clearCookies(page);
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await delay(2000);
            await snap(page, `${tag}_01_login_page`);

            const hasForm = await page.waitForSelector('input[type="email"]', { timeout: 15000 })
                .then(() => true).catch(() => false);
            if (!hasForm) {
                if (!page.url().includes('/auth/login')) {
                    console.log("✅ 已处于登录状态");
                    return true;
                }
                const title = await page.title().catch(() => '');
                throw new Error(`未找到登录表单 (页面标题: "${title}")，可能被 Cloudflare 整页拦截`);
            }
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });

            await fillLoginForm(page, user);
            await snap(page, `${tag}_02_filled_form`);

            console.log(">> 等待 Cloudflare Turnstile 验证 (含自动/手动点击兜底)...");
            const verified = await solveTurnstile(page);
            await snap(page, `${tag}_03_after_token_wait`);

            if (!verified) {
                console.log(`⚠️ 第 ${attempt} 次尝试: Turnstile 未通过，不提交表单`);
            } else {
                console.log("✅ Cloudflare 验证通过，提交登录");
                await delay(rand(500, 1200));
                await page.click('button[type="submit"]');
                const ok = await waitLoginResult(page, 20);
                await snap(page, `${tag}_04_after_submit`);
                if (ok) {
                    console.log("✅ 登录成功");
                    return true;
                }
                const err = await getLoginError(page);
                console.log(`⚠️ 第 ${attempt} 次尝试: 登录未成功${err ? `，页面提示: ${err}` : ''}`);
            }
        } catch (e) {
            console.log(`⚠️ 第 ${attempt} 次尝试出错: ${e.message}`);
            await snap(page, `${tag}_ERROR`);
        }

        if (attempt < MAX_LOGIN_ATTEMPTS) {
            const wait = rand(5000, 9000);
            console.log(`>> ${Math.round(wait / 1000)} 秒后重试...`);
            await delay(wait);
        }
    }
    return false;
}

// ============ 页面信息提取 ============

// 提取页面上的 Expiry (到期时间)
async function getExpiryDate(page) {
    return await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        for (let el of allElements) {
            if (el.children.length === 0 && el.textContent.trim() === 'Expiry') {
                let sibling = el.nextElementSibling;
                while (sibling) {
                    const txt = sibling.textContent.trim();
                    if (/\d{4}-\d{2}-\d{2}/.test(txt)) {
                        return txt.match(/\d{4}-\d{2}-\d{2}/)[0];
                    }
                    sibling = sibling.nextElementSibling;
                }
                const parent = el.parentElement;
                if (parent) {
                    for (let sib of parent.children) {
                        const txt = sib.textContent.trim();
                        if (/\d{4}-\d{2}-\d{2}/.test(txt)) {
                            return txt.match(/\d{4}-\d{2}-\d{2}/)[0];
                        }
                    }
                }
            }
        }
        const bodyText = document.body.innerText;
        const match = bodyText.match(/Expiry\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/i) || bodyText.match(/Expiry\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
        if (match) return match[1];
        return null;
    });
}

// 提取页面上的红字警告提示
async function getWarningMessage(page) {
    return await page.evaluate(() => {
        const errorSelectors = [
            '[class*="danger"]', '[class*="error"]', '[class*="alert"]',
            '[class*="red"]', '.bg-red-100', '.text-red-500', '.bg-red-500'
        ];
        for (let selector of errorSelectors) {
            const elements = Array.from(document.querySelectorAll(selector));
            for (let el of elements) {
                const txt = el.textContent.trim();
                if (txt && txt.length > 5 && (txt.includes("can't") || txt.includes("cannot") || txt.includes("yet") || txt.includes("renew") || txt.includes("able to"))) {
                    return txt;
                }
            }
        }
        const divs = Array.from(document.querySelectorAll('div, p, span'));
        for (let d of divs) {
            const txt = d.textContent.trim();
            if (txt && (txt.includes("You can't renew") || txt.includes("You will be able to"))) {
                return txt;
            }
        }
        return null;
    });
}

// 根据按钮文本检查是否可见
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

// 点击主页面按钮
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

// ============ 主流程 ============

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error("❌ 未检测到合法的 USERS_JSON 配置");
        process.exit(1);
    }

    const connectOptions = {
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1280,720',
            '--lang=en-US'
        ],
        customConfig: {},
        turnstile: true,
        connectOption: {
            defaultViewport: { width: 1280, height: 720 }
        },
        disableXvfb: true,
        ignoreAllFlags: false
    };

    // 如果工作流指定了 Chrome 路径，则使用该 Chrome
    if (CHROME_PATH) {
        connectOptions.customConfig.chromePath = CHROME_PATH;
        console.log(`🌐 使用指定的 Chrome: ${CHROME_PATH}`);
    }

    // 代理只通过 --proxy-server 一处配置，避免与 proxy 字段重复冲突
    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            connectOptions.args.push(`--proxy-server=socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
            console.log(`📡 代理已配置为: socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
        } catch (e) {
            console.error("⚠️ 代理解析失败，继续使用直连模式:", e.message);
        }
    }

    let browser, page;
    try {
        console.log(">> 正在初始化真实指纹浏览器...");
        const response = await connect(connectOptions);
        browser = response.browser;
        page = response.page;
        console.log("✅ 浏览器创建成功");
    } catch (err) {
        console.error("❌ 浏览器启动失败，异常中断:", err.message);
        process.exit(1);
    }

    await page.setViewport({ width: 1280, height: 720 }).catch(() => {});
    await logEnvironment(browser, page);

    // 所有用户复用同一个页面 (pRB 的 Turnstile 自动处理挂在初始页面上)，每个用户前清 Cookie
    for (let user of users) {
        try {
            console.log(`=== 处理用户: ${user.username} ===`);

            // 1. 登录 (带重试，失败则直接通知并跳过该用户)
            const loginOk = await loginWithRetry(page, user);
            if (!loginOk) {
                console.error(`❌ 用户 ${user.username} 登录失败，跳过续期`);
                process.exitCode = 1;
                await sendTGMessage(
                    `❌ <b>Katabump 登录失败</b>\n` +
                    `👤 用户: <code>${esc(user.username)}</code>\n` +
                    `🛡 原因: Cloudflare 验证在 ${MAX_LOGIN_ATTEMPTS} 次尝试内均未通过，或账号密码有误\n` +
                    `📝 请查看工作流截图与日志中的 Chrome 版本/出口信息。`
                );
                continue;
            }

            // 2. 获取续期前参数
            if (SERVER_URL) {
                await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
                await delay(3000);
                await snap(page, `${user.username}_05_server_page`);
                if (page.url().includes('/auth/login')) {
                    console.error("❌ 打开服务器页面时被重定向回登录页，登录态无效");
                    process.exitCode = 1;
                    await sendTGMessage(
                        `❌ <b>Katabump 登录态无效</b>\n` +
                        `👤 用户: <code>${esc(user.username)}</code>\n` +
                        `📝 登录看似成功，但访问服务器页面时又被踢回登录页。`
                    );
                    continue;
                }
            }

            const expiryBefore = await getExpiryDate(page);
            console.log(`>> 续期前到期时间为: ${expiryBefore || "未能读取到日期"}`);

            let warningMsg = null;
            let expiryAfter = null;

            // 3. 执行续期弹窗与 ALTCHA 验证
            if (await isBtnVisibleByText(page, "Renew")) {
                console.log(">> 找到主页面 Renew 按钮，开始点击打开弹窗...");
                await clickBtnByText(page, "Renew");
                await delay(2000);
                await snap(page, `${user.username}_06_modal_opened`);

                console.log(">> 正在寻找弹窗中的 Renew 确认按钮...");

                const btnHandles = await page.$$('button');
                let targetRenewBtn = null;
                for (let handle of btnHandles) {
                    const text = await page.evaluate(el => el.textContent.trim(), handle);
                    const isVisible = await page.evaluate(el => el.offsetParent !== null, handle);
                    if (text === 'Renew' && isVisible) {
                        targetRenewBtn = handle;
                    }
                }

                if (targetRenewBtn) {
                    await targetRenewBtn.click();
                    console.log("✅ 成功物理点击弹窗中的 Renew 按钮，启动正常验证与提交流！");
                } else {
                    console.log("⚠️ 未能找到弹窗中的 Renew 按钮");
                }

                await delay(1000);
                await snap(page, `${user.username}_07_start_verifying`);

                // 轮询等待 ALTCHA 计算完成并自动提交
                console.log(">> 等待 PoW 算力验证完成与后端提交 (最大等待 90 秒)...");
                let altchaPassed = false;

                for (let i = 0; i < 90; i++) {
                    try {
                        const status = await page.evaluate(() => {
                            const bodyText = document.body.innerText;
                            if (bodyText.includes('Verifying...')) return 'verifying';
                            if (bodyText.includes('This will extend the life of your server')) return 'open';
                            return 'closed';
                        });

                        if (status === 'closed') {
                            console.log(`✅ 验证框已消失 (耗时约 ${i} 秒)，续期请求成功提交！`);
                            altchaPassed = true;
                            break;
                        }
                    } catch (error) {
                        // 捕获页面刷新导致的错误
                        if (error.message.includes('Execution context was destroyed') ||
                            error.message.includes('Target closed') ||
                            error.message.includes('Session closed')) {
                            console.log("✅ 捕获到页面已自动刷新 (Execution context destroyed)，证明请求提交成功！");
                            altchaPassed = true;
                            break;
                        }
                    }

                    if (i > 0 && i % 10 === 0) {
                        console.log(`... 算力验证仍在进行中 (${i} 秒)`);
                    }

                    await delay(1000);
                }

                if (!altchaPassed) {
                    console.log("⚠️ 90秒内弹窗未自动关闭，可能卡在 100% 或网络请求被拦截。");
                }

                console.log(">> 正在等待页面重新加载最新数据...");
                await delay(10000);

                // 如果跳转丢了目标页面，重新导航回去获取最终日期
                if (SERVER_URL && !page.url().includes(SERVER_URL)) {
                    await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
                    await delay(5000);
                }

                await snap(page, `${user.username}_08_after_renew_submit`);

                // 4. 获取续期后数据与警告信息
                warningMsg = await getWarningMessage(page);
                if (warningMsg) {
                    console.log(`🔴 检测到警告提示: ${warningMsg}`);
                }

                expiryAfter = await getExpiryDate(page);
                console.log(`>> 续期后到期时间为: ${expiryAfter || "未获取到日期"}`);

            } else {
                console.log("⚠️ 页面未发现 Renew 按钮，可能已被抢先占满或账号状态异常");
            }

            // 5. 结果逻辑比对
            const expiryBeforeDate = expiryBefore ? new Date(expiryBefore) : null;
            const expiryAfterDate = expiryAfter ? new Date(expiryAfter) : null;

            let isRenewed = false;
            let diffDays = 0;
            if (expiryBeforeDate && expiryAfterDate) {
                const diffTime = expiryAfterDate - expiryBeforeDate;
                diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays > 0) {
                    isRenewed = true;
                }
            }

            // 6. 构造 TG 消息格式
            let tgMsg = "";
            if (isRenewed) {
                tgMsg = `🎉 <b>Katabump 续期成功！</b>\n` +
                        `👤 用户: <code>${esc(user.username)}</code>\n` +
                        `📅 续期前到期日: <code>${esc(expiryBefore || "未知")}</code>\n` +
                        `📅 续期后到期日: <code>${esc(expiryAfter)}</code>\n` +
                        `⏳ 延长天数: <b>${diffDays}</b> 天`;
            } else if (warningMsg) {
                tgMsg = `⚠️ <b>Katabump 未到续期</b>\n` +
                        `👤 用户: <code>${esc(user.username)}</code>\n` +
                        `📅 当前到期日: <code>${esc(expiryBefore || "未知")}</code>\n` +
                        `🔴 页面提示: <i>${esc(warningMsg)}</i>`;
            } else {
                tgMsg = `⚠️ <b>Katabump 续期状态异常</b>\n` +
                        `👤 用户: <code>${esc(user.username)}</code>\n` +
                        `📅 到期时间未改变: <code>${esc(expiryBefore || "未知")}</code>\n` +
                        `📝 请检查工作流截图确认是否卡在其他元素遮挡处。`;
            }

            console.log(">> 正在发送 Telegram 消息通知...");
            await sendTGMessage(tgMsg);

        } catch (err) {
            console.error(`❌ 处理用户 ${user.username} 时发生内部错误:`, err.message);
            process.exitCode = 1;
            await snap(page, `${user.username}_ERROR`);
        }
    }

    console.log(">> 所有用户任务执行完毕，正在释放浏览器会话。");
    await browser.close().catch(() => {});
    process.exit(process.exitCode || 0);
})();
