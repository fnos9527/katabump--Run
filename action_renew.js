const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// --- [配置项] ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.SERVER_URL ? process.env.SERVER_URL.trim() : '';
const HTTP_PROXY = process.env.HTTP_PROXY;

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// 延迟小工具
const delay = ms => new Promise(res => setTimeout(res, ms));

// 截图小工具
async function snap(page, label) {
    try {
        const file = path.join(SCREENSHOT_DIR, `${Date.now()}_${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`📸 已保存截图: ${label}`);
    } catch (e) {
        console.error(`⚠️ 截图失败 (${label}):`, e.message);
    }
}

// 提取用户配置
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

// 发送 Telegram 消息
async function sendTGMessage(msg) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log("⚠️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过发送 TG 通知。");
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: msg,
                parse_mode: 'HTML'
            })
        });
        if (res.ok) {
            console.log("📨 TG 通知发送成功！");
        } else {
            console.error("❌ TG 通知发送失败:", await res.text());
        }
    } catch (e) {
        console.error("❌ 发送 TG 通知出错:", e.message);
    }
}

// 提取页面上的 Expiry (到期时间)
async function getExpiryDate(page) {
    return await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        for (let el of allElements) {
            if (el.children.length === 0 && el.textContent.trim() === 'Expiry') {
                let sibling = el.nextElementSibling;
                while (sibling) {
                    const txt = sibling.textContent.trim();
                    if (/\d{4}-\d{2}-\d{2}/.test(txt)) {
                        return txt.match(/\d{4}-\d{2}-\d{2}/)[0];
                    }
                    sibling = sibling.nextElementSibling;
                }
                const parent = el.parentElement;
                if (parent) {
                    for (let sib of parent.children) {
                        const txt = sib.textContent.trim();
                        if (/\d{4}-\d{2}-\d{2}/.test(txt)) {
                            return txt.match(/\d{4}-\d{2}-\d{2}/)[0];
                        }
                    }
                }
            }
        }
        const bodyText = document.body.innerText;
        const match = bodyText.match(/Expiry\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/i) || bodyText.match(/Expiry\s*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
        if (match) return match[1];
        return null;
    });
}

// 提取页面上的红字警告提示
async function getWarningMessage(page) {
    return await page.evaluate(() => {
        const errorSelectors = [
            '[class*="danger"]', '[class*="error"]', '[class*="alert"]', 
            '[class*="red"]', '.bg-red-100', '.text-red-500', '.bg-red-500'
        ];
        for (let selector of errorSelectors) {
            const elements = Array.from(document.querySelectorAll(selector));
            for (let el of elements) {
                const txt = el.textContent.trim();
                if (txt && txt.length > 5 && (txt.includes("can't") || txt.includes("cannot") || txt.includes("yet") || txt.includes("renew") || txt.includes("able to"))) {
                    return txt;
                }
            }
        }
        const divs = Array.from(document.querySelectorAll('div, p, span'));
        for (let d of divs) {
            const txt = d.textContent.trim();
            if (txt && (txt.includes("You can't renew") || txt.includes("You will be able to"))) {
                return txt;
            }
        }
        return null;
    });
}

// 辅助函数：根据按钮文本检查是否可见
async function isBtnVisibleByText(page, text) {
    return await page.evaluate((txt) => {
        const elements = Array.from(document.querySelectorAll('button, a'));
        const btn = elements.find(el => {
            if (!el.textContent.trim().includes(txt)) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
        });
        return !!btn;
    }, text).catch(() => false);
}

// 辅助函数：点击主页面按钮
async function clickBtnByText(page, text) {
    return await page.evaluate((txt) => {
        const elements = Array.from(document.querySelectorAll('button, a'));
        const btn = elements.find(el => el.textContent.trim().includes(txt));
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }, text).catch(() => false);
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.error("❌ 未检测到合法的 USERS_JSON 配置");
        process.exit(1);
    }

    const connectOptions = { 
        headless: false, 
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', 
            '--window-size=1280,720'
        ],
        customConfig: {},
        turnstile: true, 
        connectOption: {
            defaultViewport: { width: 1280, height: 720 }
        },
        disableXvfb: true, 
        ignoreAllFlags: false
    };

    if (HTTP_PROXY) {
        try {
            const proxyUrl = new URL(HTTP_PROXY);
            connectOptions.proxy = {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port)
            };
            connectOptions.args.push(`--proxy-server=socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
            console.log(`📡 代理已配置为: socks5://${proxyUrl.hostname}:${proxyUrl.port}`);
        } catch (e) {
            console.error("⚠️ 代理解析失败，继续使用直连模式:", e.message);
        }
    }

    let browser, firstPage;
    try {
        console.log(">> 正在初始化真实指纹浏览器...");
        const response = await connect(connectOptions);
        browser = response.browser;
        firstPage = response.page;
        console.log("✅ 浏览器创建成功");
    } catch (err) {
        console.error("❌ 浏览器启动失败，异常中断:", err.message);
        process.exit(1);
    }

    let isFirstUser = true;
    for (let user of users) {
        let page;
        try {
            if (isFirstUser) {
                page = firstPage;
                isFirstUser = false;
            } else {
                page = await browser.newPage();
            }

            await page.setViewport({ width: 1280, height: 720 }).catch(() => {});

            // 全程监听浏览器控制台报错和页面级 JS 异常，帮助诊断"验证码算完但
            // 卡住不继续"是不是网站前端脚本自己抛错/被反自动化逻辑拦下了
            page.on('pageerror', (err) => {
                console.log(`🧯 页面 JS 异常: ${err.message}`);
            });
            page.on('console', (msg) => {
                const type = msg.type();
                if (type === 'error' || type === 'warning') {
                    console.log(`🖥️ 浏览器控制台[${type}]: ${msg.text()}`);
                }
            });

            // 自检：探测当前浏览器暴露出的自动化痕迹指纹（供诊断反自动化用）
            try {
                const autoFlags = await page.evaluate(() => ({
                    webdriver: navigator.webdriver,
                    hasCDC: Object.keys(window).some(k => k.startsWith('cdc_') || k.startsWith('$cdc_')),
                    languages: navigator.languages,
                    plugins: navigator.plugins ? navigator.plugins.length : null,
                    userAgent: navigator.userAgent
                }));
                console.log(`🕵️ 自动化痕迹自检: navigator.webdriver=${autoFlags.webdriver}, 存在CDC标记=${autoFlags.hasCDC}, languages=${JSON.stringify(autoFlags.languages)}, plugins数=${autoFlags.plugins}`);
                console.log(`🕵️ UserAgent: ${autoFlags.userAgent}`);
            } catch (e) {
                console.log(`⚠️ 自动化痕迹自检失败: ${e.message}`);
            }

            // 1. 登录流程
            console.log(`=== 处理用户: ${user.username} ===`);
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await snap(page, `${user.username}_01_login_page`);

            await page.waitForSelector('input[type="email"]', { timeout: 15000 });
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });

            await page.focus('input[type="email"]');
            await page.evaluate(() => document.querySelector('input[type="email"]').value = '');
            await page.type('input[type="email"]', user.username, { delay: 100 });

            await page.focus('input[type="password"]');
            await page.evaluate(() => document.querySelector('input[type="password"]').value = '');
            await page.type('input[type="password"]', user.password, { delay: 100 });

            const checkedEmail = await page.$eval('input[type="email"]', el => el.value);
            const checkedPassword = await page.$eval('input[type="password"]', el => el.value);

            if (checkedEmail !== user.username || checkedPassword !== user.password) {
                console.log("⚠️ 检测到模拟输入丢失字符，正在进行强制修正...");
                await page.evaluate((u, p) => {
                    const emailEl = document.querySelector('input[type="email"]');
                    const passEl = document.querySelector('input[type="password"]');
                    emailEl.value = u;
                    emailEl.dispatchEvent(new Event('input', { bubbles: true }));
                    emailEl.dispatchEvent(new Event('change', { bubbles: true }));
                    passEl.value = p;
                    passEl.dispatchEvent(new Event('input', { bubbles: true }));
                    passEl.dispatchEvent(new Event('change', { bubbles: true }));
                }, user.username, user.password);
            }

            await snap(page, `${user.username}_02_filled_form`);

            console.log(">> 等待 Cloudflare 自动检测 & Token 就绪...");
            let isVerified = false;
            for (let i = 0; i < 15; i++) {
                const hasToken = await page.evaluate(() => {
                    const el = document.querySelector('[name="cf-turnstile-response"]');
                    return el && el.value && el.value.length > 20;
                }).catch(() => false);

                if (hasToken) {
                    console.log("✅ Cloudflare 验证通过");
                    isVerified = true;
                    break;
                }
                await delay(2000);
            }

            await snap(page, `${user.username}_03_after_token_wait`);

            await page.click('button[type="submit"]');
            await delay(8000); 
            await snap(page, `${user.username}_04_after_submit`);

            // 2. 获取续期前参数
            if (SERVER_URL) {
                await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded' });
                await delay(3000); 
                await snap(page, `${user.username}_05_server_page`);
            }

            const expiryBefore = await getExpiryDate(page);
            console.log(`>> 续期前到期时间为: ${expiryBefore || "未能读取到日期"}`);

            let warningMsg = null;
            let expiryAfter = null;

            // 辅助函数：定位弹窗里"操作按钮"（不用文字匹配，因为文字会从
            // "Renew" 变成 "Verifying... X%"，用文字找会在验证过程中彻底找不到按钮）
            // 策略：在包含 altcha-widget 的弹窗容器里，取文字不是 "Close" 的那个按钮
            async function getModalActionBtnState(page) {
                return await page.evaluate(() => {
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, div'));
                    for (let dialog of dialogs) {
                        if (dialog.querySelector('altcha-widget')) {
                            const buttons = Array.from(dialog.querySelectorAll('button'));
                            const btn = buttons.find(b => !/^close$/i.test(b.textContent.trim()) && b.textContent.trim().length > 0);
                            if (btn) {
                                return {
                                    text: btn.textContent.trim(),
                                    disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true'
                                };
                            }
                        }
                    }
                    return null;
                });
            }
            async function clickModalActionBtn(page) {
                return await page.evaluate(() => {
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, div'));
                    for (let dialog of dialogs) {
                        if (dialog.querySelector('altcha-widget')) {
                            const buttons = Array.from(dialog.querySelectorAll('button'));
                            const btn = buttons.find(b => !/^close$/i.test(b.textContent.trim()) && b.textContent.trim().length > 0);
                            if (btn) {
                                if (btn.disabled) return "found_but_disabled";
                                btn.click();
                                return "clicked";
                            }
                        }
                    }
                    return "not_found";
                });
            }
            async function closeModalIfOpen(page) {
                await page.evaluate(() => {
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, div'));
                    for (let dialog of dialogs) {
                        if (dialog.querySelector('altcha-widget')) {
                            const buttons = Array.from(dialog.querySelectorAll('button'));
                            const closeBtn = buttons.find(b => /close/i.test(b.textContent.trim()) || b.textContent.trim() === '×');
                            if (closeBtn) closeBtn.click();
                        }
                    }
                }).catch(() => {});
            }

            // 3. 执行续期弹窗与 ALTCHA 验证（最多重试 2 次整轮：打开弹窗 -> 点验证码 -> 等待 -> 提交）
            if (await isBtnVisibleByText(page, "Renew")) {
                const MAX_ATTEMPTS = 2;
                let renewSubmitted = false;

                for (let attempt = 1; attempt <= MAX_ATTEMPTS && !renewSubmitted; attempt++) {
                    console.log(`\n----- 第 ${attempt}/${MAX_ATTEMPTS} 次续期尝试 -----`);

                    // 网络诊断：这次不再只抓"看起来像验证相关"的 URL，而是把这段时间内
                    // 所有的 xhr/fetch 请求全部记下来——因为我们需要知道的关键问题是：
                    // "提交验证答案"这个请求到底有没有发出去过，如果连它的 URL 长什么样都
                    // 不知道，之前用关键词过滤反而可能把它漏掉了。
                    const netLogs = [];
                    const onRequestFailed = (req) => {
                        const failure = req.failure();
                        netLogs.push(`❌ 请求失败: [${req.resourceType()}] ${req.url()} 原因: ${failure ? failure.errorText : '未知'}`);
                    };
                    const onResponse = (res) => {
                        const type = res.request().resourceType();
                        if (type === 'xhr' || type === 'fetch') {
                            netLogs.push(`📶 响应: ${res.status()} [${type}] ${res.url()}`);
                        }
                    };
                    page.on('requestfailed', onRequestFailed);
                    page.on('response', onResponse);

                    console.log(">> 找到主页面 Renew 按钮，开始点击打开弹窗...");
                    await clickBtnByText(page, "Renew");
                    await delay(1000); // 预留短暂动画时间
                    await snap(page, `${user.username}_06_modal_opened_attempt${attempt}`);

                    console.log(">> 检测到该 ALTCHA 为 auto=onsubmit 无感模式：不存在需要手动勾选的复选框，");
                    console.log("   验证流程由点击'Renew'提交按钮本身触发（点击会被 ALTCHA 拦截，自动完成验证后再继续原本的提交）。");
                    console.log(">> 直接点击弹窗内的 Renew 提交按钮...");
                    const firstClick = await clickModalActionBtn(page);
                    console.log(`>> 首次点击提交按钮结果: ${firstClick}`);
                    await snap(page, `${user.username}_07_submit_clicked_attempt${attempt}`);

                    // 轮询等待：
                    // 1) 弹窗自动消失 —— 说明 ALTCHA 验证完成后自动续跑了表单提交，续期已经在处理了；
                    // 2) 按钮重新变回可点击的 "Renew" —— 说明这一轮验证失败/被取消了，需要再点一次重新触发；
                    // 3) 一直停在禁用的 "Verifying..." —— 卡住了，需要走后面的诊断+重试。
                    console.log(">> 等待 ALTCHA 自动验证 + 自动续跑提交完成...");
                    let altchaPassed = false;
                    let lastBtnState = null;
                    for (let i = 0; i < 35; i++) {
                        const dialogExists = await page.evaluate(() => {
                            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, div'));
                            return dialogs.some(d => d.querySelector('altcha-widget'));
                        }).catch(() => false);

                        if (!dialogExists) {
                            console.log("✅ 弹窗已自动关闭，说明验证通过且提交已自动继续！");
                            altchaPassed = true;
                            break;
                        }

                        const state = await getModalActionBtnState(page);
                        if (state) {
                            lastBtnState = state;
                            if (!state.disabled && /renew/i.test(state.text)) {
                                console.log(`   [${i}s] 按钮恢复为可点击 "${state.text}"（说明上一轮验证失败/被取消），重新点击触发...`);
                                await clickModalActionBtn(page);
                            }
                        }
                        if (i % 5 === 0) {
                            console.log(`   [${i}s] 当前按钮状态: ${state ? `"${state.text}" disabled=${state.disabled}` : "未找到按钮(可能弹窗已关闭)"}`);
                        }
                        await delay(1000);
                    }

                    // 打印这段时间抓到的网络诊断日志
                    if (netLogs.length > 0) {
                        console.log(">> 验证期间捕获到的 xhr/fetch 网络活动:");
                        netLogs.forEach(l => console.log("   " + l));
                    } else {
                        console.log(">> 验证期间未捕获到任何 xhr/fetch 请求（说明验证卡在了纯客户端计算阶段，从未尝试联网）。");
                    }
                    page.off('requestfailed', onRequestFailed);
                    page.off('response', onResponse);

                    if (!altchaPassed) {
                        console.log(`⚠️ 验证在 35 秒内未通过（最后状态: ${lastBtnState ? `"${lastBtnState.text}" disabled=${lastBtnState.disabled}` : "未知"}）。`);

                        // 深挖 altcha-widget 内部真实状态：它的 value/state 属性，
                        // 以及 shadow DOM 里有没有藏着的错误提示文字
                        try {
                            const widgetDump = await page.evaluate(() => {
                                const widget = document.querySelector('altcha-widget');
                                if (!widget) return null;
                                const hiddenInput = widget.shadowRoot
                                    ? widget.shadowRoot.querySelector('input[type="hidden"], input[name="altcha"]')
                                    : null;
                                return {
                                    stateAttr: widget.getAttribute('state') || widget.getAttribute('data-state'),
                                    hasValue: hiddenInput ? !!hiddenInput.value : null,
                                    valueLength: hiddenInput && hiddenInput.value ? hiddenInput.value.length : 0,
                                    shadowText: widget.shadowRoot ? widget.shadowRoot.textContent.trim().slice(0, 200) : null,
                                    outerAttrs: Array.from(widget.attributes).map(a => `${a.name}=${a.value}`).join(' | ')
                                };
                            });
                            if (widgetDump) {
                                console.log(`🔬 altcha-widget 内部状态: state属性=${widgetDump.stateAttr}, 已生成答案值=${widgetDump.hasValue}(长度${widgetDump.valueLength}), 组件文字="${widgetDump.shadowText}"`);
                                console.log(`🔬 altcha-widget 所有属性: ${widgetDump.outerAttrs}`);
                            } else {
                                console.log("🔬 未在页面上找到 altcha-widget 元素（可能弹窗已变化）。");
                            }
                        } catch (e) {
                            console.log(`⚠️ 读取 altcha-widget 内部状态失败: ${e.message}`);
                        }

                        // 额外自检：这个页面上下文里 Web Crypto / Worker 是否可用——
                        // ALTCHA 的 PoW 计算通常依赖 crypto.subtle 或 Web Worker，
                        // 如果这里返回异常，说明是浏览器环境本身缺东西，而不是网站问题。
                        try {
                            const envCheck = await page.evaluate(async () => {
                                const hasSubtle = !!(window.crypto && window.crypto.subtle);
                                const hasWorker = typeof Worker !== 'undefined';
                                let subtleWorks = null;
                                try {
                                    if (hasSubtle) {
                                        const buf = new TextEncoder().encode('test');
                                        const digest = await window.crypto.subtle.digest('SHA-256', buf);
                                        subtleWorks = digest && digest.byteLength === 32;
                                    }
                                } catch (e) {
                                    subtleWorks = `error: ${e.message}`;
                                }
                                return { hasSubtle, hasWorker, subtleWorks, isSecureContext: window.isSecureContext };
                            });
                            console.log(`🧪 环境自检: crypto.subtle存在=${envCheck.hasSubtle}, Worker存在=${envCheck.hasWorker}, subtle实测=${envCheck.subtleWorks}, isSecureContext=${envCheck.isSecureContext}`);
                        } catch (e) {
                            console.log(`⚠️ 环境自检失败: ${e.message}`);
                        }

                        if (attempt < MAX_ATTEMPTS) {
                            console.log(">> 关闭弹窗，准备重新打开一轮进行重试...");
                            await closeModalIfOpen(page);
                            await delay(2000);
                            continue; // 进入下一次 attempt，重新打开弹窗、重新点提交
                        } else {
                            console.log(">> 已达最大重试次数，放弃本轮提交。");
                        }
                    } else {
                        renewSubmitted = true;
                    }

                    // 等待页面处理并重新载入
                    await delay(5000);
                    await snap(page, `${user.username}_08_after_renew_submit_attempt${attempt}`);
                }

                // 4. 获取续期后数据与警告信息
                warningMsg = await getWarningMessage(page);
                if (warningMsg) {
                    console.log(`🔴 检测到警告提示: ${warningMsg}`);
                }

                expiryAfter = await getExpiryDate(page);
                console.log(`>> 续期后到期时间为: ${expiryAfter || "未获取到日期"}`);

            } else {
                console.log("⚠️ 页面未发现 Renew 按钮，可能已被抢先占满或账号状态异常");
            }

            // 5. 结果逻辑比对
            const expiryBeforeDate = expiryBefore ? new Date(expiryBefore) : null;
            const expiryAfterDate = expiryAfter ? new Date(expiryAfter) : null;

            let isRenewed = false;
            let diffDays = 0;
            if (expiryBeforeDate && expiryAfterDate) {
                const diffTime = expiryAfterDate - expiryBeforeDate;
                diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays > 0) {
                    isRenewed = true;
                }
            }

            // 6. 构造 TG 消息格式
            let tgMsg = "";
            if (isRenewed) {
                tgMsg = `🎉 <b>Katabump 续期成功！</b>\n` +
                        `👤 用户: <code>${user.username}</code>\n` +
                        `📅 续期前到期日: <code>${expiryBefore || "未知"}</code>\n` +
                        `📅 续期后到期日: <code>${expiryAfter}</code>\n` +
                        `⏳ 延长天数: <b>${diffDays}</b> 天`;
            } else if (warningMsg) {
                tgMsg = `⚠️ <b>Katabump 未到续期</b>\n` +
                        `👤 用户: <code>${user.username}</code>\n` +
                        `📅 当前到期日: <code>${expiryBefore || "未知"}</code>\n` +
                        `🔴 页面提示: <i>${warningMsg}</i>`;
            } else {
                tgMsg = `⚠️ <b>Katabump 续期状态异常</b>\n` +
                        `👤 用户: <code>${user.username}</code>\n` +
                        `📅 到期时间未改变: <code>${expiryBefore || "未知"}</code>\n` +
                        `📝 请检查工作流截图确认是否卡在其他元素遮挡处。`;
            }

            console.log(">> 正在发送 Telegram 消息通知...");
            await sendTGMessage(tgMsg);

        } catch (err) {
            console.error(`❌ 处理用户 ${user.username} 时发生内部错误:`, err.message);
            if (page && !page.isClosed()) {
                await snap(page, `${user.username}_ERROR`);
            }
        } finally {
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
        }
    }

    console.log(">> 所有用户任务执行完毕，正在释放浏览器会话。");
    await browser.close();
})();
