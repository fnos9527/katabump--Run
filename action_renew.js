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

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);

    const launchOptions = { 
        headless: false, 
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720', '--ssl-version-min=tls1.2', '--ignore-certificate-errors'] 
    };
    if (HTTP_PROXY) launchOptions.proxy = { server: HTTP_PROXY };

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');

        try {
            console.log(`\n=== 正在处理用户 ${user.username} ===`);
            await page.goto('https://dashboard.katbump.com/auth/login', { waitUntil: 'domcontentloaded' });
            
            // 步骤 1：死等 CF 绿勾 (绝对前置条件)
            console.log('【第一步】等待 Cloudflare 绿勾通过...');
            let cfPassed = false;
            for (let j = 0; j < 15; j++) {
                const hasToken = await page.evaluate(() => {
                    const el = document.querySelector('[name="cf-turnstile-response"], [name="g-recaptcha-response"]');
                    return el && el.value && el.value.length > 20;
                });
                if (hasToken) {
                    cfPassed = true;
                    break;
                }
                await page.waitForTimeout(2000);
            }
            if (!cfPassed) throw new Error("CF 人机验证未通过，被拦截。");
            console.log('>> 绿勾已就绪，保持验证状态。');

            // 步骤 2：CF 通过后，再快速填充账号密码
            console.log('【第二步】安全录入凭据...');
            await page.locator('input[type="email"], input[name="email"]').fill(user.username);
            await page.locator('input[type="password"]').fill(user.password);
            await page.waitForTimeout(1000);

            // 步骤 3：点击登录
            console.log('【第三步】执行点击登录...');
            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            await page.waitForTimeout(10000);

            // 步骤 4：检查是否进入控制台
            if (SERVER_URL) await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
            
            // 续期循环
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`[尝试 ${attempt}/3] 检查 Renew...`);
                const renewBtn = page.locator('button:has-text("Renew")').first();
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    await page.waitForTimeout(5000);
                    console.log('✅ 续期操作执行完毕。');
                    break;
                }
                await page.reload();
                await page.waitForTimeout(5000);
            }
        } catch (err) {
            console.error(`异常:`, err.message);
        }
    }
    await browser.close();
})();
