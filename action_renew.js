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

// --- [辅助函数] ---
function getUsers() {
    // 这里保持你原有的读取逻辑
    return JSON.parse(process.env.USERS_JSON || '[]');
}

async function sendTelegram(msg) {
    if (!TG_BOT_TOKEN) return;
    try { await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: msg }); } catch (e) {}
}

// --- [核心执行逻辑] ---
(async () => {
    const users = getUsers();
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
        
        // 【关键】确保绿勾就绪
        console.log(">> 等待 Token 就绪...");
        for(let i=0; i<10; i++) {
            const hasToken = await page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]')?.value?.length > 20);
            if(hasToken) break;
            await page.waitForTimeout(2000);
        }

        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(8000);

        // 3. 续期流程 (带自动重试)
        if (SERVER_URL) await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
        
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`>> 检查 Renew 按钮 (尝试 ${attempt}/3)`);
            const renewBtn = page.locator('button:has-text("Renew")').first();
            
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForTimeout(3000);
                
                // 确认弹窗内的再次续期
                const modalBtn = page.locator('button:has-text("Confirm")').first(); // 假设弹窗按钮名为 Confirm
                if (await modalBtn.isVisible()) await modalBtn.click();
                
                console.log(">> 续期操作执行完毕");
                success = true;
                await sendTelegram(`✅ ${user.username} 续期成功`);
                break;
            }
            await page.reload();
            await page.waitForTimeout(5000);
        }
        
        if (!success) await sendTelegram(`❌ ${user.username} 续期失败`);
        await page.close();
    }
    await browser.close();
})();
