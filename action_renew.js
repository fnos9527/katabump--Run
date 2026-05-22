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

// --- [修复后的数据读取逻辑] ---
function getUsers() {
    const raw = process.env.USERS_JSON || '';
    if (!raw) return [];
    
    // 尝试解析 JSON，如果失败则按行解析文本
    try {
        if (raw.trim().startsWith('[')) return JSON.parse(raw);
    } catch (e) {}

    return raw.split('\n').map(line => {
        const [username, password] = line.trim().split(':');
        return (username && password) ? { username: username.trim(), password: password.trim() } : null;
    }).filter(Boolean);
}

// --- [核心执行逻辑] ---
(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error("未发现有效的用户凭据，请检查 USERS_JSON 变量！");
        process.exit(1);
    }

    const browser = await chromium.launch({ 
        headless: false, 
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--window-size=1280,720'] 
    });

    for (let user of users) {
        const page = await browser.newPage();
        
        // 1. 【守护进程】后台循环点击验证码
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

        // 2. 登录流程
        console.log(`=== 处理用户: ${user.username} ===`);
        await page.goto('https://dashboard.katbump.com/auth/login', { waitUntil: 'domcontentloaded' });
        await page.locator('input[type="email"]').fill(user.username);
        await page.locator('input[type="password"]').fill(user.password);
        
        // 确保 Token 就绪
        console.log(">> 等待 Cloudflare Token 就绪...");
        for(let i=0; i<10; i++) {
            const hasToken = await page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]')?.value?.length > 20);
            if(hasToken) break;
            await page.waitForTimeout(2000);
        }

        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(10000);

        // 3. 续期流程
        if (SERVER_URL) await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
        
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`>> 尝试续期 (第 ${attempt} 次)`);
            const renewBtn = page.locator('button:has-text("Renew")').first();
            
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForTimeout(3000);
                
                // 点击弹窗确认
                const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Renew")').last();
                if (await confirmBtn.isVisible()) await confirmBtn.click();
                
                success = true;
                console.log(">> 续期完成");
                break;
            }
            await page.reload();
            await page.waitForTimeout(5000);
        }
        
        await page.close();
    }
    await browser.close();
})();
