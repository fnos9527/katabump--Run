const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

// --- [配置项] ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;

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

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);

    const launchOptions = { 
        headless: false, 
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--window-size=1280,720'] 
    };
    if (HTTP_PROXY) launchOptions.proxy = { server: HTTP_PROXY };

    const browser = await chromium.launch(launchOptions);

    for (let user of users) {
        const page = await browser.newPage();
        
        // 1. 【守护进程】自动过盾
        const monitorCF = async () => {
            while (!page.isClosed()) {
                try {
                    const frames = page.frames();
                    for (const frame of frames) {
                        const box = await frame.locator('input[type="checkbox"], #cf-stage input, .cf-turnstile input').first();
                        if (await box.isVisible()) await box.click();
                    }
                } catch (e) {}
                await page.waitForTimeout(2000);
            }
        };
        monitorCF();

        // 2. 登录流程（已修正域名为 katabump.com）
        console.log(`=== 处理用户: ${user.username} ===`);
        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
        
        await page.locator('input[type="email"]').fill(user.username);
        await page.locator('input[type="password"]').fill(user.password);
        
        console.log(">> 等待 Token 就绪...");
        for(let i=0; i<10; i++) {
            const hasToken = await page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]')?.value?.length > 20);
            if(hasToken) break;
            await page.waitForTimeout(2000);
        }

        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(8000);

        // 3. 续期流程
        if (SERVER_URL) await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
        
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const renewBtn = page.locator('button:has-text("Renew")').first();
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForTimeout(3000);
                const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Renew")').last();
                if (await confirmBtn.isVisible()) await confirmBtn.click();
                success = true;
                break;
            }
            await page.reload();
            await page.waitForTimeout(5000);
        }
        
        await page.close();
    }
    await browser.close();
})();
