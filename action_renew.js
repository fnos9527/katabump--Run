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

/**
 * 通杀型验证码穿透函数：支持检测任意 Shadow DOM 里的复选框 (Turnstile / ALTCHA)
 */
async function solveAnyCaptcha(page, typeName = "验证码") {
    console.log(`[扫描] 正在全力搜寻页面中的 ${typeName} 影子节点...`);
    const allFrames = page.frames();
    for (const frame of allFrames) {
        try {
            const hasCheckbox = await frame.evaluate(() => {
                function findCheckboxInShadow(root) {
                    if (!root) return null;
                    // 同时兼容 Turnstile 的 input 和 ALTCHA 的 input
                    const el = root.querySelector('input[type="checkbox"], #cf-stage input, .cf-turnstile input');
                    if (el) return el;
                    
                    // 深度递归遍历所有子元素的 ShadowRoot
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
                console.log(`   >> 🎯 [精准命中] 捕获到 ${typeName} 核心物理坐标: X=${hasCheckbox.x}, Y=${hasCheckbox.y}`);
                const iframeElement = await frame.frameElement().catch(() => null);
                if (iframeElement) {
                    const box = await iframeElement.boundingBox();
                    if (box) {
                        const finalX = box.x + hasCheckbox.x;
                        const finalY = box.y + hasCheckbox.y;
                        // 模拟真人鼠标轨迹微动并点击
                        await page.mouse.move(finalX, finalY, { steps: 5 });
                        await page.mouse.down();
                        await page.waitForTimeout(120);
                        await page.mouse.up();
                        console.log(`   >> 👋 物理点击模拟发射成功。`);
                        return true;
                    }
                } else {
                    await page.mouse.click(hasCheckbox.x, hasCheckbox.y);
                    return true;
                }
            }
        } catch (e) { }
    }
    console.log(`[扫描] 本轮未发现可点击的 ${typeName} 元素。`);
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

            // 核心修复：尝试攻克登录界面的 Cloudflare Turnstile 验证码
            console.log('正在检测登录页是否存在 Cloudflare 人机验证...');
            await solveAnyCaptcha(page, "Cloudflare 登录验证码");
            await page.waitForTimeout(3000);

            console.log('点击登录按钮...');
            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            
            console.log('等待安全鉴权与 Cookie 写入...');
            await page.waitForTimeout(10000); 

            // 保存登录结果快照，用于排查是否真的登录成功了
            const loginCheckShot = path.join(photoDir, `${safeUsername}_after_login.png`);
            await page.screenshot({ path: loginCheckShot, fullPage: true });
            console.log(`   >> 📸 登录后状态已存档: ${safeUsername}_after_login.png`);

            // 步骤 2：精准空降至目标续期页
            if (SERVER_URL) {
                console.log(`[路由直达] 正在空降至目标续期页面: ${SERVER_URL}`);
                await page.goto(SERVER_URL, { waitUntil: 'commit' });
                await page.waitForTimeout(6000);
            } else {
                console.log('[路由自动] 尝试定位 "See" 按钮...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                await seeLink.click();
                await page.waitForTimeout(6000);
            }

            // 再次保存空降后的快照，看看这里到底长啥样，为什么找不到 Renew 按钮
            const landingShot = path.join(photoDir, `${safeUsername}_landing_page.png`);
            await page.screenshot({ path: landingShot, fullPage: true });
            console.log(`   >> 📸 空降目标页状态已存档: ${safeUsername}_landing_page.png`);

            // 步骤 3：续期
            let foundRenew = false;
            for (let attempt = 1; attempt <= 15; attempt++) {
                console.log(`\n[尝试 ${attempt}/15] 正在检查 Renew 状态...`);
                if (attempt > 1) {
                    await page.reload({ waitUntil: 'commit' });
                    await page.waitForTimeout(5000);
                }

                // 允许模糊匹配大小写或者含有空格的 Renew 按钮
                const renewBtn = page.locator('button:has-text("Renew"), [role="button"]:has-text("Renew"), button:has-text("renew")').first();
                if (await renewBtn.count() === 0 || !(await renewBtn.isVisible())) {
                    console.log('当前页面未发现可点击的 Renew 按钮。');
                    continue;
                }

                foundRenew = true;
                await renewBtn.click();
                console.log('已成功激活续期模态弹窗，等待渲染...');
                await page.waitForTimeout(3000);

                const modal = page.locator('#renew-modal, .modal, [class*="modal"]').first();
                if (await modal.count() === 0) {
                    console.log('模态弹窗未正常渲染，尝试刷新。');
                    continue;
                }

                console.log('触发影子节点扫描：尝试穿透破解 ALTCHA 验证码...');
                await solveAnyCaptcha(page, "弹窗 ALTCHA 验证码");

                const tsShotPath = path.join(photoDir, `${safeUsername}_Turnstile_${attempt}.png`);
                await page.screenshot({ path: tsShotPath, fullPage: true });
                await page.waitForTimeout(7000); 

                console.log('   >> 点击弹窗内的最终 Renew 确认按钮...');
                await modal.locator('button:has-text("Renew"), button[type="submit"]').first().click();
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

                console.log('   >> ✅ 服务器续期成功！');
                const successShot = path.join(photoDir, `${safeUsername}_success.png`);
                await page.screenshot({ path: successShot, fullPage: true });
                await sendTelegramMessage(`✅ *服务器续期成功*\n账号: ${user.username}`, successShot);
                break;
            }

            if (!foundRenew) {
                console.log('❌ 经过多轮尝试，依然没有在此页面上发现 Renew 按钮。请检查生成的 screenshots 里的 landing_page.png 快照。');
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
