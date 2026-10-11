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
const MAX_LOGIN_ATTEMPTS = 2; // 改为 2 次尝试

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const delay = ms => new Promise(res => setTimeout(res, ms));
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

async function sendTGMessage(msg) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
        });
        console.log("📨 TG 通知发送成功！");
    } catch (e) {
        console.error("❌ 发送 TG 通知出错:", e.message);
    }
}

async function clearCookies(page) {
    try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach().catch(() => {});
    } catch (e) {}
}

// 检查是否获得了 Turnstile Token
async function checkTurnstileToken(page) {
    return await page.evaluate(() => {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        return (el && el.value && el.value.length > 20) ? el.value : null;
    }).catch(() => null);
}

// 填写表单（改用平滑的键盘输入，避免一次性注入触发风控）
async function fillLoginForm(page, user) {
    await page.focus('input[type="email"]');
    await page.type('input[type="email"]', user.username, { delay: 120 });
    await delay(500);

    await page.focus('input[type="password"]');
    await page.type('input[type="password"]', user.password, { delay: 120 });
    await delay(500);
}

async function loginWithRetry(page, user) {
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        console.log(`>> 登录尝试 ${attempt}/${MAX_LOGIN_ATTEMPTS}`);
        const tag = `${user.username}_a${attempt}`;
        try {
            await clearCookies(page);
            await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(3000);
            await snap(page, `${tag}_01_login_page`);

            await page.waitForSelector('input[type="email"]', { timeout: 15000 });
            await fillLoginForm(page, user);
            await snap(page, `${tag}_02_filled_form`);

            console.log(">> 静默等待 Cloudflare Turnstile 自动完成验证 (最大等待 35 秒)...");
            
            let verified = false;
            for (let i = 0; i < 35; i++) {
                const token = await checkTurnstileToken(page);
                if (token) {
                    verified = true;
                    console.log(`✅ 耗时 ${i} 秒，已成功自动获取 Turnstile Token！`);
                    break;
                }
                await delay(1000);
            }

            await snap(page, `${tag}_03_after_token_wait`);

            if (!verified) {
                console.log(`⚠️ 第 ${attempt} 次尝试: Turnstile 未自动通过`);
            } else {
                console.log("✅ Cloudflare 验证通过，点击登录...");
                await delay(1000);
                await page.click('button[type="submit"]');
                await delay(5000);
                
                const onLoginUrl = page.url().includes('/auth/login');
                if (!onLoginUrl) {
                    console.log("✅ 登录成功！");
                    return true;
                }
            }
        } catch (e) {
            console.log(`⚠️ 第 ${attempt} 次尝试出错: ${e.message}`);
        }

        if (attempt < MAX_LOGIN_ATTEMPTS) {
            await delay(5000);
        }
    }
    return false;
}

// ============ 主流程 ============

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);

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
        turnstile: true, // 保持 puppeteer-real-browser 自带的静默解决器开启
        disableXvfb: true
    };

    if (CHROME_PATH) connectOptions.customConfig.chromePath = CHROME_PATH;

    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            connectOptions.args.push(`--proxy-server=socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
        } catch (e) {}
    }

    let browser, page;
    try {
        const response = await connect(connectOptions);
        browser = response.browser;
        page = response.page;
    } catch (err) {
        process.exit(1);
    }

    await page.setViewport({ width: 1280, height: 720 }).catch(() => {});

    for (let user of users) {
        try {
            console.log(`=== 处理用户: ${user.username} ===`);
            const loginOk = await loginWithRetry(page, user);

            if (!loginOk) {
                console.error(`❌ 用户 ${user.username} 登录失败，跳过续期`);
                process.exitCode = 1;
                await sendTGMessage(`❌ <b>Katabump 登录失败</b>\n👤 用户: <code>${esc(user.username)}</code>`);
                continue;
            }

            if (SERVER_URL) {
                await page.goto(SERVER_URL, { waitUntil: 'networkidle2' });
                await delay(3000);
            }

            console.log(">> 登录成功，准备开始后续续期流程...");

        } catch (err) {
            console.error(`❌ 处理出错:`, err.message);
            process.exitCode = 1;
        }
    }

    await browser.close().catch(() => {});
    process.exit(process.exitCode || 0);
})();
