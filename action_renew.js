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
 * 智能影子节点验证码穿透
 */
async function solveAnyCaptcha(page, typeName = "验证码") {
    const allFrames = page.frames();
    for (const frame of allFrames) {
        try {
            const hasCheckbox = await frame.evaluate(() => {
                function findCheckboxInShadow(root) {
                    if (!root) return null;
                    const el = root.querySelector('input[type="checkbox"], #cf-stage input, .cf-turnstile input');
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
                const iframeElement = await frame.frameElement().catch(() => null);
                if (iframeElement) {
                    const box = await iframeElement.boundingBox();
                    if (box) {
                        const finalX = box.x + hasCheckbox.x;
                        const finalY = box.y + hasCheckbox.y;
                        console.log(`   >> 🎯 [瞄准目标] 正在向 ${typeName} 发射微动物理点击: (${Math.round(finalX)}, ${Math.round(finalY)})`);
                        // 增加更像人类的滑行轨迹微动
                        await page.mouse.move(finalX - 10, finalY - 5);
                        await page.waitForTimeout(100);
                        await page.mouse.move(finalX, finalY, { steps: 6 });
                        await page.mouse.down();
                        await page.waitForTimeout(180);
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
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            
            // 核心改变：进入页面先不管输入框，全力以赴解决 Cloudflare 人机阻断
            console.log('【核心攻坚】正在循环探测并瓦解 Cloudflare 拦截盾...');
            let cfPassed = false;
            for (let clickLoop = 1; clickLoop <= 5; clickLoop++) {
                console.log(`   -> [探测第 ${clickLoop}/5 轮] 正在扫描影子节点...`);
                const clicked = await solveAnyCaptcha(page, "Cloudflare 登录验证码");
                if (clicked) {
                    console.log('   >> 👋 已成功下发物理点击，等待 5 秒观察响应...');
                    await page.waitForTimeout(5000);
                } else {
                    console.log('   >> 💡 未发现验证码或可能已被自动通过，继续监测表单。');
                }

                // 检查真正属于输入框的独立表单是否露出来了
                const isFormReady = await page.evaluate(() => {
                    const mailInput = document.querySelector('input[type="email"], input[name="email"]');
                    if (!mailInput) return false;
                    const rect = mailInput.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });

                if (isFormReady) {
                    console.log('   >> 🎉 成功穿透 Cloudflare 拦截盾！登录表单已完全显现。');
                    cfPassed = true;
                    break;
                }
                await page.waitForTimeout(2000);
            }

            // 存个照，看看到底过没过
            await page.screenshot({ path: path.join(photoDir, `${safeUsername}_盾后状态.png`), fullPage: true });

            console.log('正在定位表单输入框...');
            const emailInput = page.locator('input[type="email"], input[name="email"]').first();
            const passwordInput = page.locator('input[type="password"]').first();

            // 使用真人敲击键盘的延迟模式输入
            console.log('正在安全录入凭据...');
            await emailInput.focus();
            await emailInput.fill(user.username, { delay: 50 });
            await page.waitForTimeout(500);
            await passwordInput.focus();
            await passwordInput.fill(user.password, { delay: 50 });
            await page.waitForTimeout(1000);

            console.log('点击登录按钮...');
            await page.locator('button:has-text("Login"), button[type="submit"]').first().click();
            
            console.log('正在同步安全鉴权与 Cookie 写入 (等待 10 秒)...');
            await page.waitForTimeout(10000); 

            // 路由直达控制台
            if (SERVER_URL) {
                console.log(`[路由直达] 正在全速空降至目标续期页面: ${SERVER_URL}`);
                await page.goto(SERVER_URL, { waitUntil: 'commit' });
                await page.waitForTimeout(6000);
            } else {
                console.log('[路由自动] 正在寻找控制台入口...');
                const seeLink = page.locator('a:has-text("See"), :text("See")').first();
                await seeLink.click();
                await page.waitForTimeout(6000);
            }

            // 续期模块（应要求：精简重试次数，最多 3 次）
            let foundRenew = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`\n[尝试 ${attempt}/3] 正在检查 Renew 状态...`);
                if (attempt > 1) {
                    await page.reload({ waitUntil: 'commit' });
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

                console.log('触发影子节点扫描：尝试穿透破解弹窗 ALTCHA 验证码...');
                await solveAnyCaptcha(page, "弹窗 ALTCHA 验证码");

                await page.screenshot({ path: path.join(photoDir, `${safeUsername}_Renew_Modal_${attempt}.png`), fullPage: true });
                await page.waitForTimeout(6000); 

                console.log('   >> 点击确认续期按钮...');
                await modal.locator('button:has-text("Renew"), button[type="submit"]').first().click();
                await page.waitForTimeout(5000);

                const postHtml = await page.content();
                if (postHtml.includes("can't renew your server yet") || postHtml.includes("You can't renew")) {
                    const match = postHtml.match(/as of\s+(.*?)\s+\(/);
                    const dateStr = match ? match[1] : '尚未到期';
                    console.log(`   >> ⏳ 续期条件未满足。下次可用时间: ${dateStr}`);
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
                console.log('❌ 3次尝试后依然未能进入包含 Renew 按钮的控制台页面，请排查盾后状态。');
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
