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

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// 截图小工具：任何时候都不应该让截图失败影响主流程
async function snap(page, label) {
    try {
        const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 已保存截图: ${label}`);
    } catch (e) {
        console.error(`⚠️ 截图失败 (${label}):`, e.message);
    }
}

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
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--window-size=1280,720',
            // 修复点: CI 容器里 /dev/shm 空间通常很小，Chromium 默认会用共享内存
            // 存储页面数据，空间不足时会导致渲染进程崩溃、页面被意外关闭。
            '--disable-dev-shm-usage'
        ] 
    };
    if (HTTP_PROXY) launchOptions.proxy = { server: HTTP_PROXY };

    const browser = await chromium.launch(launchOptions);

    for (let user of users) {
        let page;
        try {
            page = await browser.newPage();

            // 1. 【守护进程】自动过盾
            // 修复点: 循环体内部加 try/catch，页面关闭时主动 break 而不是抛出异常；
            // 调用处加 .catch() 兜底，防止任何遗漏的异常变成未捕获的 Promise 异常，
            // 从而打崩整个 Node 进程（原来的崩溃点就在这里）。
            const monitorCF = async () => {
                while (!page.isClosed()) {
                    try {
                        const frames = page.frames();
                        for (const frame of frames) {
                            const box = frame.locator('input[type="checkbox"], #cf-stage input, .cf-turnstile input').first();
                            if (await box.isVisible().catch(() => false)) await box.click().catch(() => {});
                        }
                        await page.waitForTimeout(2000);
                    } catch (e) {
                        // 页面已关闭或其他异常，直接结束守护循环，不再抛出
                        break;
                    }
                }
            };
            monitorCF().catch(() => {});

            // 2. 登录流程（已修正域名为 katabump.com）
            console.log(`=== 处理用户: ${user.username} ===`);
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await snap(page, `${user.username}_01_login_page`);

            await page.locator('input[type="email"]').fill(user.username);
            await page.locator('input[type="password"]').fill(user.password);
            await snap(page, `${user.username}_02_filled_form`);

            console.log(">> 等待 Token 就绪...");
            for (let i = 0; i < 10; i++) {
                const hasToken = await page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]')?.value?.length > 20).catch(() => false);
                if (hasToken) break;
                await page.waitForTimeout(2000);
            }
            await snap(page, `${user.username}_03_after_token_wait`);

            await page.locator('button[type="submit"]').click();
            await page.waitForTimeout(8000);
            await snap(page, `${user.username}_04_after_submit`);

            // 3. 续期流程
            if (SERVER_URL) {
                await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
                await snap(page, `${user.username}_05_server_page`);
            }

            let success = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const renewBtn = page.locator('button:has-text("Renew")').first();
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    await page.waitForTimeout(3000);
                    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Renew")').last();
                    if (await confirmBtn.isVisible()) await confirmBtn.click();
                    success = true;
                    await snap(page, `${user.username}_06_renew_clicked`);
                    break;
                }
                await snap(page, `${user.username}_06_attempt${attempt}_no_button`);
                await page.reload();
                await page.waitForTimeout(5000);
            }

            console.log(success ? `✅ ${user.username} 续期操作完成` : `⚠️ ${user.username} 未找到续期按钮`);
        } catch (err) {
            // 修复点: 单个用户处理失败不影响后续用户，记录日志后继续下一个
            console.error(`❌ 处理用户 ${user.username} 时出错:`, err.message);
            if (page && !page.isClosed()) await snap(page, `${user.username}_ERROR`);
        } finally {
            if (page && !page.isClosed()) await page.close().catch(() => {});
        }
    }
    await browser.close();
})();
