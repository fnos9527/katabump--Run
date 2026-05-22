const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 激活最高级别的 Stealth 隐藏插件，完美隐匿浏览器指纹
chromium.use(stealth);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;

// 初始化快照目录
const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        }, { timeout: 10000 });
        console.log('[Telegram] 文字通知发送成功。');
    } catch (e) {
        console.error('[Telegram] 文字通知发送失败:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] 正在通过系统通道发送快照图片...');
        const { exec } = require('child_process');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 图片发送失败:', err.message);
                else console.log('[Telegram] 快照图片发送成功。');
                resolve();
            });
        });
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const raw = process.env.USERS_JSON.trim();
            if (raw.startsWith('[') || raw.startsWith('{')) {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : (parsed.users || []);
            }
            return raw.split('\n').map(line => {
                const parts = line.trim().split(':');
                return parts.length >= 2 ? { username: parts[0].trim(), password: parts[1].trim() } : null;
            }).filter(Boolean);
        }
    } catch (e) {
        console.error('解析凭据发生错误，请检查 USERS_JSON 变量配置。');
    }
    return [];
}

/**
 * 核心：穿透 Shadow DOM 精准定位并安全点击 ALTCHA 验证码
 */
async function solveAltchaCaptcha(page) {
    console.log('正在检索网页中所有嵌套的框架环境...');
    const allFrames = page.frames();
    
    for (const frame of allFrames) {
        try {
            // 采用高级注入式查询，直接越过开放/封闭影子节点的层层阻隔，抓取底层的 checkbox
            const hasCheckbox = await frame.evaluate(() => {
                // 深度递归寻找 shadowRoot
                function findCheckboxInShadow(root) {
                    if (!root) return null;
                    const el = root.querySelector('input[type="checkbox"]');
                    if (el) return el;
                    
                    const children = root.querySelectorAll('*');
                    for (const child of children) {
                        if (child.shadowRoot) {
                            const found = findCheckboxInShadow(child.shadowRoot);
                            if (found) return found;
                        }
                    }
                    return null;
                }
                const foundEl = findCheckboxInShadow(document);
                if (foundEl) {
                    // 获取它在文档流中的绝对物理位置
                    const rect = foundEl.getBoundingClientRect();
                    return {
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                        visible: rect.width > 0 && rect.height > 0
                    };
                }
                return null;
            }).catch(() => null);

            if (hasCheckbox && hasCheckbox.visible) {
                console.log(`[穿透成功] 探测到 ALTCHA 验证框坐标: X=${hasCheckbox.x}, Y=${hasCheckbox.y}`);
                
                // 获取该 Frame 元素的绝对容器边界，换算出真实屏幕坐标
                const iframeElement = await frame.frameElement().catch(() => null);
                if (iframeElement) {
                    const box = await iframeElement.boundingBox();
                    if (box) {
                        const finalX = box.x + hasCheckbox.x;
                        const finalY = box.y + hasCheckbox.y;
                        
                        console.log(`[触控] 发射底层物理模拟点击，目标位置: (${finalX}, ${finalY})`);
                        await page.mouse.move(finalX, finalY, { steps: 5 });
                        await page.mouse.down();
                        await page.waitForTimeout(60 + Math.random() * 50);
                        await page.mouse.up();
                        return true;
                    }
                } else {
                    // 如果本身就在主文档中，直接点击
                    await page.mouse.click(hasCheckbox.x, hasCheckbox.y);
                    return true;
                }
            }
        } catch (e) {
            // 静默排除无权限跨域 Frame
        }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error('❌ 未能找到任何合法的用户账号，请检查凭据。');
        process.exit(1);
    }

    console.log(`成功载入了 ${users.length} 个用户的任务。`);
    console.log('正在构建原生隐形浏览器环境...');

    const launchOptions = {
        headless: false, // 必须为 false 以在 xvfb 虚拟桌面中生成指纹
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--window-size=1280,720'
        ]
    };

    if (HTTP_PROXY) {
        console.log(`[代理] 注入核心网络链路: ${HTTP_PROXY}`);
        launchOptions.proxy = { server: HTTP_PROXY };
    }

    // 采用标准且最稳固的启动逻辑，绝不卡死
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            // 步骤 1：清理状态并安全登录
            console.log('正在建立安全连接...');
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);

            // 检查是不是处于需要先登出的状态
            if (await page.locator('input[type="email"]').count() === 0) {
                console.log('检测到残留会话，正在强制注销重置...');
                await page.goto('https://dashboard.katabump.com/auth/logout', { waitUntil: 'networkidle' });
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle' });
                await page.waitForTimeout(2000);
            }

            console.log('正在输入凭据...');
            await page.locator('input[type="email"], input[name="email"]').first().fill(user.username);
            await page.waitForTimeout(200);
            await page.locator('input[type="password"]').first().fill(user.password);
            await page.waitForTimeout(500);

            console.log('点击登录按钮，等待系统鉴权...');
            const loginBtn = page.locator('button:has-text("Login"), button[type="submit"]').first();
            await loginBtn.click();
            await page.waitForTimeout(6000); // 留足跳转和写入 Cookie 的时间

            const currentUrl = page.url();
            const currentHtml = await page.content();

            if (currentUrl.includes('login') || currentHtml.includes('Incorrect password')) {
                console.error(`   >> ❌ 登录失败: 用户 [${user.username}] 账号密码错误或触发安全验证。`);
                const errShot = path.join(photoDir, `${safeUsername}_login_fail.png`);
                await page.screenshot({ path: errShot, fullPage: true });
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n请检查密码或代理状态。`, errShot);
                continue;
            }
            console.log('   >> 🔓 成功登录后台。');

            // 步骤 2：精准空降到目标续期页
            if (SERVER_URL) {
                console.log(`[路由直达] 正在全速空降至目标续期页面: ${SERVER_URL}`);
                await page.goto(SERVER_URL, { waitUntil: 'networkidle' });
                await page.waitForTimeout(4000);
            } else {
                console.log('[路由自动] 未配置 SERVER_URL，尝试通过首页 "See" 按钮导航...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                if (await seeLink.count() > 0) {
                    await seeLink.click();
                    await page.waitForTimeout(4000);
                } else {
                    console.error('   >> ❌ 未找到 "See" 链接且没有直达配置，跳过此用户。');
                    continue;
                }
            }

            // 步骤 3：核心续期循环重试机制
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 15; attempt++) {
                console.log(`\n[尝试 ${attempt}/15] 正在检查 Renew 状态...`);
                
                if (attempt > 1) {
                    await page.reload({ waitUntil: 'networkidle' });
                    await page.waitForTimeout(4000);
                }

                const renewBtn = page.locator('button:has-text("Renew")').first();
                if (await renewBtn.count() === 0 || !(await renewBtn.isVisible())) {
                    console.log('未发现可点击的 Renew 按钮，可能服务器已处于安全续期周期。');
                    break;
                }

                await renewBtn.click();
                console.log('激活续期弹窗，正在等待模态框载入...');
                await page.waitForTimeout(3000);

                const modal = page.locator('#renew-modal');
                if (await modal.count() === 0) {
                    console.log('模态框未按时渲染，触发安全重试...');
                    continue;
                }

                // 解决验证码
                console.log('触发影子节点扫描：尝试破解 ALTCHA 验证码...');
                await solveAltchaCaptcha(page);

                // 保存带有验证状态的现场快照
                const tsScreenshotName = `${safeUsername}_Turnstile_${attempt}.png`;
                const tsShotPath = path.join(photoDir, tsScreenshotName);
                await page.screenshot({ path: tsShotPath, fullPage: true });
                console.log(`   >> 📸 验证状态快照已留档: ${tsScreenshotName}`);
                
                await page.waitForTimeout(7000); // 留出充足的算力计算或验证通过时间

                console.log('   >> 点击弹窗内的确认提交 Renew 按钮...');
                const confirmBtn = modal.locator('button:has-text("Renew")').first();
                await confirmBtn.click();
                await page.waitForTimeout(4000);

                const postHtml = await page.content();

                // 校验 A：是否还没到续期时间
                if (postHtml.includes("can't renew your server yet") || postHtml.includes("You can't renew")) {
                    const match = postHtml.match(/as of\s+(.*?)\s+\(/);
                    const dateStr = match ? match[1] : '尚未到期';
                    console.log(`   >> ⏳ 续期条件未满足。下次允许可用时间: ${dateStr}`);
                    
                    const skipShot = path.join(photoDir, `${safeUsername}_skip.png`);
                    await page.screenshot({ path: skipShot, fullPage: true });
                    await sendTelegramMessage(`⏳ *未到续期时间*\n用户: ${user.username}\n下次可用: ${dateStr}`, skipShot);
                    renewSuccess = true;
                    break;
                }

                // 校验 B：提示验证码未通过
                if (postHtml.includes('complete the captcha') || postHtml.toLowerCase().includes('captcha')) {
                    console.log('   >> ⚠️ 验证码未命中或未计算完毕，即将刷新进入下一次重试...');
                    continue;
                }

                // 校验 C：弹窗消失或提示 success
                if (!(await modal.isVisible()) || postHtml.toLowerCase().includes('success')) {
                    console.log('   >> ✅ 恭喜！服务器续期圆满成功！');
                    const successShot = path.join(photoDir, `${safeUsername}_success.png`);
                    await page.screenshot({ path: successShot, fullPage: true });
                    await sendTelegramMessage(`✅ *服务器续期成功*\n账号: ${user.username}\n操作状态: 自动续期已顺利完成！`, successShot);
                    renewSuccess = true;
                    break;
                }
            }

        } catch (err) {
            console.error(`[流程中断] 运行时捕获到异常:`, err.message);
        }

        // 用户处理完毕后的全局最终状态快照
        try {
            const finalShot = path.join(photoDir, `${safeUsername}.png`);
            await page.screenshot({ path: finalShot, fullPage: true });
        } catch (e) { }
    }

    await browser.close();
    console.log('\n所有自动化调度任务处理完毕。');
    process.exit(0);
})();
