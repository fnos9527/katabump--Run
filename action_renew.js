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
 * 影子节点兜底物理点击
 */
async function clickCaptchaIfVisible(page) {
    const allFrames = page.frames();
    for (const frame of allFrames) {
        try {
            const hasCheckbox = await frame.evaluate(() => {
                const el = document.querySelector('input[type="checkbox"], #cf-stage input, .cf-turnstile input');
                if (el) {
                    const rect = el.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible: rect.width > 0 && rect.height > 0 };
                }
                return null;
            }).catch(() => null);

            if (hasCheckbox && hasCheckbox.visible) {
                const iframeElement = await frame.frameElement().catch(() => null);
                if (iframeElement) {
                    const box = await iframeElement.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + hasCheckbox.x, box.y + hasCheckbox.y);
                        return true;
                    }
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
    if (HTTP_PROXY) launchOptions.proxy = { server: HTTP_PROXY };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            console.log('正在建立安全连接...');
            await page.goto('https://dashboard.katbump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);

            console.log('正在定位表单输入框...');
            const emailInput = page.locator('input[type="email"], input[name="email"]').first();
            const passwordInput = page.locator('input[type="password"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 20000 });

            console.log('正在录入账号与密码凭据...');
            await emailInput.focus();
            await emailInput.fill(user.username, { delay: 100 });
            await page.waitForTimeout(1000);
            await passwordInput.focus();
            await passwordInput.fill(user.password, { delay: 100 });
            await page.waitForTimeout(2000);

            // 🌟【精髓修改】：不盲目乱点，改用“智能 Token 捕获监听”机制
            console.log('【精准拦截监控】正在等待 Cloudflare 绿勾就绪并回传 Token...');
            let hasToken = false;
            
            for (let checkLoop = 1; checkLoop <= 10; checkLoop++) {
                // 每次检查前，尝试给可能需要点击的框做一个轻轻的物理探测
                await clickCaptchaIfVisible(page);

                // 检查隐藏的 Cloudflare 表单数据有没有生成出来
                hasToken = await page.evaluate(() => {
                    const el = document.querySelector('[name="cf-turnstile-response"], [name="g-recaptcha-response"]');
                    return el && el.value && el.value.length > 20;
                });

                if (hasToken) {
                    console.log(`   >> 🎉 [就绪] 底层 Token 写入成功 (第 ${checkLoop} 轮核验通过)`);
                    break;
                }

                console.log(`   >> ⏳ Token 仍在生成中，网页正在自动进行无感鉴权，等待 3 秒... (${checkLoop}/10)`);
                await page.waitForTimeout(3000);
            }

            // 再次保存有绿勾的现场状态
            await page.screenshot({ path: path.join(photoDir, `${safeUsername}_盾后状态.png`), fullPage: true });

            // 既然 Token 拿到了，原地沉淀 4 秒钟，绝对不抢跑
            console.log('防止瞬时并发拦截：原地固化 4 秒钟...');
            await page.waitForTimeout(4000);

            console.log('发出最终登录请求（点击 Login）...');
            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            
            console.log('正在同步安全鉴权与 Cookie 写入 (等待 10 秒)...');
            await page.waitForTimeout(10000); 

            // 路由直达控制台
            if (SERVER_URL) {
                console.log(`[路由直达] 正在全速空降至目标续期页面: ${SERVER_URL}`);
                await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(8000);
            } else {
                console.log('[路由自动] 正在寻找控制台入口...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                await seeLink.click();
                await page.waitForTimeout(8000);
            }

            // 续期模块（最多重试 3 次）
            let foundRenew = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`\n[尝试 ${attempt}/3] 正在检查 Renew 状态...`);
                if (attempt > 1) {
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(5000);
                }

                const renewBtn = page.locator('button:has-text("Renew"), [role="button"]:has-text("Renew"), button:has-text("renew")').first();
                if (await renewBtn.count() === 0 || !(await renewBtn.isVisible())) {
                    console.log('当前页面未发现可点击的 Renew 按钮。');
                    const tsShotPath = path.join(photoDir, `${safeUsername}_no_button_${attempt}.png`);
                    await page.screenshot({ path: tsShotPath, fullPage: true });
                    continue;
                }

                foundRenew = true;
                await renewBtn.click();
                console.log('模态弹窗已激活，等待渲染...');
                await page.waitForTimeout(3000);

                const modal = page.locator('#renew-modal, .modal, [class*="modal"]').first();
                if (await modal.count() === 0) continue;

                // 弹窗内的 ALTCHA 验证码也可以使用相同的检测模式
                await page.screenshot({ path: path.join(photoDir, `${safeUsername}_Renew_Modal_${attempt}.png`), fullPage: true });
                await page.waitForTimeout(6000); 

                console.log('   >> 点击确认续期按钮...');
                await modal.locator('button:has-text("Renew"), button[type="submit"]').first().click();
                await page.waitForTimeout(5000);

                const postHtml = await page.content();
                if (postHtml.includes("can't renew your server yet") || postHtml.includes("You can't renew")) {
                    console.log('   >> ⏳ 续期条件未满足：当前服务器尚不需要续期。');
                    break;
                }

                if (postHtml.includes('complete the captcha') || postHtml.toLowerCase().includes('captcha')) {
                    console.log('   >> ⚠️ 验证码未命中，准备下轮重试...');
                    continue;
                }

                console.log('   >> ✅ 服务器续期成功！');
                const successShot = path.join(photoDir, `${safeUsername}_success.png`);
                await page.screenshot({ path: successShot, fullPage: true });
                await sendTelegramMessage(`✅ *服务器续期成功*\n账号: ${user.username}`, successShot);
                break;
            }

            if (!foundRenew) {
                console.log('❌ 3次尝试后依然未能成功触发 Renew 续期流程。');
            }

        } catch (err) {
            console.error(`[流程中断] 捕获到异常:`, err.message);
        }

        try {
            await page.screenshot({ path: path.join(photoDir, `${safeUsername}_final.png`), fullPage: true });
        } catch (e) { }
    }

    await browser.close();
    process.exit(0);
})();
