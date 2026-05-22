const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : ''; 

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] 消息发送成功。');
    } catch (e) {
        console.error('[Telegram] 发送消息失败:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] 正在通过 curl 发送快照图片...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 发送图片失败:', err.message);
                else console.log('[Telegram] 快照图片发送成功。');
                resolve();
            });
        });
    }
}

// 激活 Stealth 指纹隐藏插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 已启用: ${PROXY_CONFIG.server}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式错误。');
        process.exit(1);
    }
}

// 核心：无感监听并计算 ALTCHA/Turnstile 验证码物理坐标的 Hook 脚本
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', axiosConfig);
        return true;
    } catch (error) {
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
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

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);
    if (PROXY_CONFIG && !(await checkProxy())) process.exit(1);

    await launchChrome();
    let browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }

    await page.addInitScript(INJECTED_SCRIPT);
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(3000);

            console.log('正在输入凭据...');
            const emailInput = page.locator('input[type="email"], input[name="email"]').first();
            await emailInput.fill(user.username);
            const pwdInput = page.locator('input[type="password"]').first();
            await pwdInput.fill(user.password);
            await page.waitForTimeout(1000);

            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            await page.waitForTimeout(5000);

            if (page.url().includes('login') || page.locator(':text("Incorrect password")').count() > 0) {
                console.error(`   >> ❌ 登录失败: 用户 ${user.username}`);
                continue;
            }

            // --- 优先采用 SERVER_URL 网址直达功能 ---
            if (SERVER_URL) {
                console.log(`[直达] 检测到直达链接，正在跨过 'See' 按钮直接空降至: ${SERVER_URL}`);
                await page.goto(SERVER_URL);
                await page.waitForTimeout(4000);
            } else {
                console.log('[路由] 未检测到直达网址配置，正在寻找网页 "See" 按钮...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                await seeLink.click();
                await page.waitForTimeout(4000);
            }

            // --- 进入 Renew 循环重试机制 ---
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                console.log(`\n[尝试 {attempt}/20] 正在寻找 Renew 按钮...`);
                
                if (attempt > 1) {
                    await page.reload();
                    await page.waitForTimeout(4000);
                }

                const renewBtn = page.locator('button:has-text("Renew")').first();
                if (await renewBtn.count() === 0 || !(await renewBtn.isVisible())) {
                    console.log('未找到 核心续期 按钮，跳过。');
                    break;
                }

                await renewBtn.click();
                console.log('核心续期按钮已点击。等待弹窗渲染...');
                await page.waitForTimeout(3000);

                const modal = page.locator('#renew-modal');
                if (await modal.count() === 0) {
                    console.log('弹窗没有及时展示，准备重试...');
                    continue;
                }

                console.log('正在通过 CDP 全局总线自动破解 ALTCHA 复选框...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }

                const tsScreenshotName = `${safeUsername}_Turnstile_${attempt}.png`;
                await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                console.log(`   >> 📸 快照已同步归档: ${tsScreenshotName}`);
                await page.waitForTimeout(6000); // 留出运算缓冲时间

                console.log('   >> 点击弹窗内部的最终提交 Renew 按钮...');
                const confirmBtn = modal.locator('button:has-text("Renew")').first();
                await confirmBtn.click();
                await page.waitForTimeout(4000);

                const currentText = await page.content();
                if (currentText.includes("can't renew your server yet") || currentText.includes("You can't renew")) {
                    const match = currentText.match(/as of\s+(.*?)\s+\(/);
                    let dateStr = match ? match[1] : '未知时间';
                    console.log(`   >> ⏳ 暂未到时间。下次可用时间: ${dateStr}`);
                    
                    const skipShotPath = path.join(photoDir, `${safeUsername}_skip.png`);
                    await page.screenshot({ path: skipShotPath, fullPage: true });
                    await sendTelegramMessage(`⏳ *暂无法续期 (未到期)*\n用户: ${user.username}\n下次可用: ${dateStr}`, skipShotPath);
                    renewSuccess = true;
                    break;
                }

                if (currentText.includes('complete the captcha') || currentText.toLowerCase().includes('captcha')) {
                    console.log('   >> ⚠️ 验证未完成或被风控拦截，进入安全刷新重试...');
                    continue;
                }

                if (!(await modal.isVisible()) || currentText.toLowerCase().includes('success')) {
                    console.log('   >> ✅ 续期圆满成功！');
                    const successShotPath = path.join(photoDir, `${safeUsername}_success.png`);
                    await page.screenshot({ path: successShotPath, fullPage: true });
                    await sendTelegramMessage(`✅ *服务器续期成功*\n用户: ${user.username}`, successShotPath);
                    renewSuccess = true;
                    break;
                }
            }

        } catch (err) {
            console.error(`流控异常:`, err);
        }

        try {
            const finalShotPath = path.join(photoDir, `${safeUsername}.png`);
            await page.screenshot({ path: finalShotPath, fullPage: true });
        } catch (e) { }
    }

    await browser.close();
    process.exit(0);
})();
