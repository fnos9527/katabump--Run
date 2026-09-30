// waitTurnstile.js
// 用"轮询真实 Token"取代原来的固定等待。拿不到 Token 就明确失败,绝不带空 Token 提交。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读取 Token:优先读隐藏字段,其次读 turnstile.getResponse()
async function readToken(page) {
    try {
        return await page.evaluate(() => {
            const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
            for (const el of fields) {
                if (el.value && el.value.length > 20) return el.value;
            }
            try {
                if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                    const t = window.turnstile.getResponse();
                    if (t && t.length > 20) return t;
                }
            } catch (e) {}
            return null;
        });
    } catch (e) {
        return null; // 页面正在跳转等情况,下一轮再读
    }
}

// 获取 Turnstile iframe 的位置(用于兜底点击)
async function getWidgetBox(page) {
    try {
        return await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
            if (!iframe) return null;
            const r = iframe.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
    } catch (e) {
        return null;
    }
}

// 兜底:如果自动点击没生效,手动点一下复选框位置(复选框在 iframe 左侧约 30px 处)
async function fallbackClick(page, log) {
    const box = await getWidgetBox(page);
    if (!box) {
        log('  [Turnstile] 未找到验证框 iframe,无法兜底点击');
        return false;
    }
    const x = box.x + 30;
    const y = box.y + box.h / 2;
    log(`  [Turnstile] 兜底点击复选框: (${Math.round(x)}, ${Math.round(y)})`);
    await page.mouse.move(x - 40, y - 10, { steps: 8 });
    await sleep(300);
    await page.mouse.move(x, y, { steps: 6 });
    await sleep(200);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    return true;
}

// 重置验证框,重新发起一次验证
async function resetWidget(page) {
    try {
        await page.evaluate(() => {
            if (window.turnstile && typeof window.turnstile.reset === 'function') {
                window.turnstile.reset();
            }
        });
    } catch (e) {}
}

/**
 * 等待 Turnstile Token 就绪
 * @returns {Promise<string|null>} 成功返回 token,失败返回 null
 */
async function waitForTurnstileToken(page, opts = {}) {
    const {
        timeoutMs = 45000,       // 单次尝试最长等待
        attempts = 3,            // 最多尝试次数(不建议调太大,频繁重试会加重风控)
        pollMs = 1000,           // 轮询间隔
        screenshotPrefix = 'turnstile',
        log = console.log,
    } = opts;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        log(`>> [Turnstile] 第 ${attempt}/${attempts} 次等待 Token...`);
        const start = Date.now();
        let clicked = false;

        while (Date.now() - start < timeoutMs) {
            const token = await readToken(page);
            if (token) {
                log(`✅ [Turnstile] Token 就绪 (长度 ${token.length}, 用时 ${Math.round((Date.now() - start) / 1000)}s)`);
                return token;
            }

            const elapsed = Date.now() - start;

            // 等了一半时间还没 Token,说明内置自动点击没生效,手动兜底点一次
            if (!clicked && elapsed > timeoutMs / 2) {
                clicked = true;
                await fallbackClick(page, log);
            }

            if (Math.floor(elapsed / 1000) % 10 === 0 && elapsed > 0) {
                log(`  [Turnstile] 已等待 ${Math.round(elapsed / 1000)}s,仍无 Token`);
            }
            await sleep(pollMs);
        }

        log(`⚠️ [Turnstile] 第 ${attempt} 次超时,未拿到 Token`);
        try {
            await page.screenshot({ path: `${screenshotPrefix}_attempt${attempt}_fail.png` });
        } catch (e) {}

        if (attempt < attempts) {
            log('  [Turnstile] 重置验证框后重试...');
            await resetWidget(page);
            await sleep(3000);
        }
    }

    log('❌ [Turnstile] 所有尝试均失败,判定为验证未通过(常见原因:出口 IP 被风控)');
    return null;
}

// 提交后检查页面是否出现 "Please complete captcha" 之类的错误
async function hasCaptchaError(page) {
    try {
        return await page.evaluate(() => {
            const t = (document.body.innerText || '').toLowerCase();
            return t.includes('complete captcha') || t.includes('captcha');
        });
    } catch (e) {
        return false;
    }
}

module.exports = { waitForTurnstileToken, hasCaptchaError, readToken };

/* ================= 用法示例 =================

const { waitForTurnstileToken, hasCaptchaError } = require('./waitTurnstile');

// ……填完账号密码之后,把原来的 "await sleep(xxxx)" 固定等待整段替换为:

const token = await waitForTurnstileToken(page, {
    screenshotPrefix: `${email}_token`,
});

if (!token) {
    await sendTelegramNotification(`❌ [${email}] Turnstile 验证未通过,已跳过本次登录(未提交表单)。请检查代理出口 IP。`);
    // 这里 return / continue,不要再点 Login
    return;
}

// 拿到 Token 才点登录
await page.click('button[type="submit"]');  // 按你原脚本的登录按钮选择器
await sleep(4000);

if (await hasCaptchaError(page)) {
    await sendTelegramNotification(`❌ [${email}] 提交后仍提示 captcha 错误,Token 被服务端拒绝。`);
    return;
}

*/
