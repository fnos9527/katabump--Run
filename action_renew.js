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
        await axios.post(url, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' }, { timeout: 10000 });
    } catch (e) { }

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

/**
 * 攻坚型影子节点穿透点击：支持强制死等功能
 */
async function solveAnyCaptcha(page, typeName = "验证码", forceWait = false) {
    console.log(`[扫描] 正在搜寻 ${typeName}，强制死等状态: ${forceWait}...`);
    const allFrames = page.frames();
    
    // 如果开启强制死等，则在扫描开始前先死等 5 秒，给慢节点缓冲时间
    if (forceWait) {
        await page.waitForTimeout(5000);
    }

    for (const frame of allFrames) {
        try {
            const hasCheckbox = await frame.evaluate(() => {
                function findCheckboxInShadow(root) {
                    if (!root) return null;
                    // 精准匹配 Turnstile 的核心复选框，排除其他杂项
                    const el = root.querySelector('input[type="checkbox"], #cf-stage input');
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
                console.log(`   >> 🎯 [命中] 发现 ${typeName} 坐标: X=${hasCheckbox.x}, Y=${hasCheckbox.y}`);
                const iframeElement = await frame.frameElement().catch(() => null);
                if (iframeElement) {
                    const box = await iframeElement.boundingBox();
                    if (box) {
                        const finalX = box.x + hasCheckbox.x;
                        const finalY = box.y + hasCheckbox.y;
                        console.log(`   >> 👋 正在发射物理模拟点击，坐标: (${finalX}, ${finalY})`);
                        await page.mouse.move(finalX, finalY, { steps: 5 });
                        await page.mouse.down();
                        await page.waitForTimeout(150);
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
    console.log(`[扫描] 本轮未发现 ${typeName}。`);
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);

    console.log(`成功载入了 ${users.length} 个用户的任务。`);
    console.log('正在构建原生隐形浏览器环境...');

    const launchOptions = { headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720'] };
    if (HTTP_PROXY) launchOptions.proxy = { server: HTTP_PROXY };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });

    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            console.log('正在建立安全连接...');
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'commit' });
            
            console.log('等待邮箱输入框渲染...');
            const emailInput = page.locator('input[type="email"], input[name="email"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 30000 });

            console.log('正在输入凭据...');
            await emailInput.fill(user.username);
            await page.locator('input[type="password"]').first().fill(user.password);
            await page.waitForTimeout(1000);

            // 核心修复：开启针对登录页 Turnstile 的强制死等模式
            console.log('正在攻坚登录页 Cloudflare 人机验证 (强制死等 5 秒以确保加载)...');
            await solveAnyCaptcha(page, "Cloudflare 登录验证码", true);
            await page.waitForTimeout(3000);

            console.log('点击登录按钮...');
            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            
            console.log('等待安全鉴权与 Cookie 写入...');
            await page.waitForTimeout(10000); 

            // 空降至目标续期页
            if (SERVER_URL) {
                console.log(`[路由直达] 正在全速空降至目标续期页面: ${SERVER_URL}`);
                await page.goto(SERVER_URL, { waitUntil: 'commit' });
                await page.waitForTimeout(6000);
            } else {
                console.log('[路由自动] 尝试导航...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                await seeLink.click();
                await page.waitForTimeout(6000);
            }

            // 续期
            for (let attempt = 1; attempt <= 15; attempt++) {
                console.log(`\n[尝试 ${attempt}/15] 正在检查 Renew 状态...`);
                if (attempt > 1) {
                    await page.reload({ waitUntil: 'commit' });
                    await page.waitForTimeout(5000);
                }

                const renewBtn = page.locator('button:has-text("Renew"), [role="button"]:has-text("Renew"), button:has-text("renew")').first();
                if (await renewBtn.count() === 0 || !(await renewBtn.isVisible())) {
                    console.log('当前页面未发现 Renew 按钮，准备归档现场快照。');
                    // 抓取现场快照，用于判断是否卡在登录页
                    const tsShotPath = path.join(photoDir, `${safeUsername}_no_button_${attempt}.png`);
                    await page.screenshot({ path: tsShotPath, fullPage: true });
                    console.log(`   >> 📸 现场状态已存档: ${safeUsername}_no_button_${attempt}.png`);
                    continue;
                }

                await renewBtn.click();
                console.log('模态弹窗已激活，等待渲染...');
                await page.waitForTimeout(3000);

                const modal = page.locator('#renew-modal, .modal, [class*="modal"]').first();
                if (await modal.count() === 0) continue;

                console.log('影子节点扫描：尝试穿透破解 ALTCHA 验证码...');
                // 弹窗验证码不需要强制死等，直接扫描即可
                await solveAnyCaptcha(page, "弹窗 ALTCHA 验证码", false);

                await page.screenshot({ path: path.join(photoDir, `${safeUsername}_Renew_Modal_${attempt}.png`), fullPage: true });
                await page.waitForTimeout(7000); 

                console.log('   >> 点击确认按钮...');
                await modal.locator('button:has-text("Renew"), button[type="submit"]').first().click();
                await page.waitForTimeout(5000);

                const postHtml = await page.content();
                if (postHtml.includes("can't renew your server yet") || postHtml.includes("You can't renew")) {
                    console.log(`   >> ⏳ 续期条件未满足。下次可用时间: ${postHtml.match(/as of\s+(.*?)\s+\(/)[1]}`);
                    break;
                }

                if (postHtml.includes('complete the captcha') || postHtml.toLowerCase().includes('captcha')) continue;

                console.log('   >> ✅ 服务器续期成功！');
                const successShot = path.join(photoDir, `${safeUsername}_success.png`);
                await page.screenshot({ path: successShot, fullPage: true });
                await sendTelegramMessage(`✅ *服务器续期成功*\n账号: ${user.username}`, successShot);
                break;
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
