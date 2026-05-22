const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;

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
    } catch (e) {
        console.error('[Telegram] 发送失败:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        const { exec } = require('child_process');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => { exec(cmd, () => resolve()); });
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
    } catch (e) { }
    return [];
}

async function solveAltchaCaptcha(page) {
    const allFrames = page.frames();
    for (const frame of allFrames) {
        try {
            const hasCheckbox = await frame.evaluate(() => {
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
                    const rect = foundEl.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible: rect.width > 0 && rect.height > 0 };
                }
                return null;
            }).catch(() => null);

            if (hasCheckbox && hasCheckbox.visible) {
                console.log(`[穿透成功] 抓取到验证码坐标: X=${hasCheckbox.x}, Y=${hasCheckbox.y}`);
                const iframeElement = await frame.frameElement().catch(() => null);
                if (iframeElement) {
                    const box = await iframeElement.boundingBox();
                    if (box) {
                        const finalX = box.x + hasCheckbox.x;
                        const finalY = box.y + hasCheckbox.y;
                        await page.mouse.move(finalX, finalY, { steps: 5 });
                        await page.mouse.down();
                        await page.waitForTimeout(100);
                        await page.mouse.up();
                        return true;
                    }
                } else {
                    await page.mouse.click(hasCheckbox.x, hasCheckbox.y);
                    return true;
                }
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);

    console.log(`成功载入了 ${users.length} 个用户的任务。`);
    console.log('正在构建原生隐形浏览器环境...');

    const launchOptions = {
        headless: false, 
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1280,720'
        ]
    };

    if (HTTP_PROXY) {
        console.log(`[代理] 注入核心网络链路: ${HTTP_PROXY}`);
        launchOptions.proxy = { server: HTTP_PROXY };
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    // 超时时间放宽到 90 秒
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            console.log('正在建立安全连接 (全面移除 networkidle)...');
            // 改为 commit：只要服务器响应了，就立刻进去，不管后面的静态文件加载
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'commit' });
            
            console.log('等待邮箱输入框渲染...');
            const emailInput = page.locator('input[type="email"], input[name="email"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 30000 });

            console.log('正在输入凭据...');
            await emailInput.fill(user.username);
            await page.locator('input[type="password"]').first().fill(user.password);
            await page.waitForTimeout(500);

            console.log('点击登录按钮...');
            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            
            console.log('等待登录后的页面响应...');
            await page.waitForTimeout(8000); 

            // 步骤 2：精准空降至目标续期页
            if (SERVER_URL) {
                console.log(`[路由直达] 正在空降至目标续期页面: ${SERVER_URL}`);
                await page.goto(SERVER_URL, { waitUntil: 'commit' });
                await page.waitForTimeout(5000);
            } else {
                console.log('[路由自动] 尝试定位 "See" 按钮...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                await seeLink.click();
                await page.waitForTimeout(5000);
            }

            // 步骤 3：续期
            for (let attempt = 1; attempt <= 15; attempt++) {
                console.log(`\n[尝试 ${attempt}/15] 正在检查 Renew 状态...`);
                if (attempt > 1) {
                    await page.reload({ waitUntil: 'commit' });
                    await page.waitForTimeout(5000);
                }

                const renewBtn = page.locator('button:has-text("Renew")').first();
                if (await renewBtn.count() === 0 || !(await renewBtn.isVisible())) {
                    console.log('当前页面未发现可点击的 Renew 按钮。');
                    break;
                }

                await renewBtn.click();
                await page.waitForTimeout(3000);

                const modal = page.locator('#renew-modal');
                if (await modal.count() === 0) continue;

                console.log('触发影子节点扫描：尝试穿透破解 ALTCHA 验证码...');
                await solveAltchaCaptcha(page);

                const tsShotPath = path.join(photoDir, `${safeUsername}_Turnstile_${attempt}.png`);
                await page.screenshot({ path: tsShotPath, fullPage: true });
                await page.waitForTimeout(7000); 

                console.log('   >> 点击弹窗内的最终 Renew 确认按钮...');
                await modal.locator('button:has-text("Renew")').first().click();
                await page.waitForTimeout(5000);

                const postHtml = await page.content();
                if (postHtml.includes("can't renew your server yet") || postHtml.includes("You can't renew")) {
                    const match = postHtml.match(/as of\s+(.*?)\s+\(/);
                    const dateStr = match ? match[1] : '尚未到期';
                    console.log(`   >> ⏳ 续期条件未满足。下次可用时间: ${dateStr}`);
                    const skipShot = path.join(photoDir, `${safeUsername}_skip.png`);
                    await page.screenshot({ path: skipShot, fullPage: true });
                    await sendTelegramMessage(`⏳ *未到续期时间*\n用户: ${user.username}\n下次可用: ${dateStr}`, skipShot);
                    break;
                }

                if (postHtml.includes('complete the captcha') || postHtml.toLowerCase().includes('captcha')) {
                    console.log('   >> ⚠️ 验证未命中，即将重试...');
                    continue;
                }

                if (!(await modal.isVisible()) || postHtml.toLowerCase().includes('success')) {
                    console.log('   >> ✅ 服务器续期成功！');
                    const successShot = path.join(photoDir, `${safeUsername}_success.png`);
                    await page.screenshot({ path: successShot, fullPage: true });
                    await sendTelegramMessage(`✅ *服务器续期成功*\n账号: ${user.username}`, successShot);
                    break;
                }
            }

        } catch (err) {
            console.error(`[流程中断] 捕获到异常:`, err.message);
        }

        try {
            await page.screenshot({ path: path.join(photoDir, `${safeUsername}.png`), fullPage: true });
        } catch (e) { }
    }

    await browser.close();
    process.exit(0);
})();
