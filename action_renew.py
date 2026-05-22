import os
import json
import re
import time
from pathlib import Path
import requests

# 直接使用 Python 官方标准的 Playwright，不再依赖任何第三方封装框架，永不报错！
from playwright.sync_api import sync_playwright

# 读取环境变量
TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN")
TG_CHAT_ID = os.getenv("TG_CHAT_ID")
HTTP_PROXY = os.getenv("HTTP_PROXY")
USERS_JSON = os.getenv("USERS_JSON", "").strip()

# 初始化截图目录
SCREENSHOT_DIR = Path("screenshots")
SCREENSHOT_DIR.mkdir(exist_ok=True)


def send_telegram_message(message, image_path=None):
    """发送通知到 Telegram，支持带截图发送"""
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    
    # 1. 发送文字消息
    try:
        url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
        requests.post(url, json={
            "chat_id": TG_CHAT_ID,
            "text": message,
            "parse_mode": "Markdown"
        }, timeout=10)
        print("[Telegram] 消息发送成功。")
    except Exception as e:
        print(f"[Telegram] 发送消息失败: {e}")

    # 2. 发送图片
    if image_path and Path(image_path).exists():
        try:
            print("[Telegram] 正在发送快照...")
            url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendPhoto"
            with open(image_path, "rb") as photo:
                requests.post(url, data={"chat_id": TG_CHAT_ID}, files={"photo": photo}, timeout=15)
            print("[Telegram] 快照发送成功。")
        except Exception as e:
            print(f"[Telegram] 发送快照失败: {e}")


def get_users():
    """纯文本格式解析凭据【账号:密码】多行文本格式"""
    if not USERS_JSON:
        return []
        
    print(f"收到原始明文长度: {len(USERS_JSON)} 字符")
    
    # 首先尝试当做标准 JSON 解析
    if USERS_JSON.startswith("[") or USERS_JSON.startswith("{"):
        try:
            parsed = json.loads(USERS_JSON)
            if isinstance(parsed, list): return parsed
            if isinstance(parsed, dict): return parsed.get("users", [])
        except Exception:
            pass

    print("[提示] 正在使用多行纯文本格式解析凭据...")
    users_list = []
    lines = USERS_JSON.splitlines()
    for line in lines:
        line = line.strip()
        if not line or ":" not in line:
            continue
        
        parts = line.split(":", 1)
        if len(parts) == 2:
            username = parts[0].strip()
            password = parts[1].strip()
            if username and password:
                users_list.append({"username": username, "password": password})
                
    return users_list


def main():
    users = get_users()
    if not users:
        print("❌ 未能从环境变量中解析出任何合法的用户账号和密码，请检查格式是否为 账号:密码")
        return

    print(f"成功加载了 {len(users)} 个用户的凭据。")

    print("正在初始化官方 Playwright 隐形浏览器环境...")
    
    with sync_playwright() as p:
        # 配置内置隐形参数，绕过常规检测
        launch_kwargs = {
            "headless": False, # xvfb 必须为 False
            "args": [
                "--disable-blink-features=AutomationControlled", # 隐藏自动化特征
                "--no-sandbox",
                "--disable-setuid-sandbox"
            ]
        }
        
        # 如果有代理，传递给官方浏览器核心
        if HTTP_PROXY:
            print(f"[代理] 检测到配置: {HTTP_PROXY}")
            launch_kwargs["proxy"] = {"server": HTTP_PROXY}
            
        browser = p.chromium.launch(**launch_kwargs)
        
        # 注入标准防爬指纹伪装，替代三方框架
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720},
            locale="en-US"
        )
        
        page = context.new_page()
        
        for idx, user in enumerate(users):
            username = user.get("username")
            password = user.get("password")
            
            safe_username = re.sub(r"[^a-zA-Z0-9]", "_", username)
            print(f"\n=== 正在处理用户 {idx + 1}/{len(users)} ===")

            try:
                # 总是先前往退出页面清除状态，然后进登录页
                page.goto("https://dashboard.katabump.com/auth/logout")
                time.sleep(2)
                page.goto("https://dashboard.katabump.com/auth/login")
                time.sleep(3)

                print("正在输入凭据...")
                email_input = page.locator('input[type="email"], input[name="email"]')
                pwd_input = page.locator('input[type="password"]')
                
                if email_input.count() > 0 and pwd_input.count() > 0:
                    email_input.first.fill(username)
                    pwd_input.first.fill(password)
                    time.sleep(0.5)
                else:
                    print("❌ 未能正确定位输入框")
                    continue

                # 登录点击
                login_btn = page.locator('button:has-text("Login"), button[type="submit"]')
                if login_btn.count() > 0:
                    login_btn.first.click()
                    time.sleep(5)
                
                # 检查密码错误提示
                if "Incorrect password" in page.content():
                    print(f"   >> ❌ 登录失败: 用户 {username} 账号或密码错误")
                    fail_shot = SCREENSHOT_DIR / f"{safe_username}_login_fail.png"
                    page.screenshot(path=str(fail_shot))
                    send_telegram_message(f"❌ *登录失败*\n用户: {username}\n原因: 账号或密码错误", str(fail_shot))
                    continue

                print('正在寻找 "See" 链接...')
                see_link = page.locator('a:has-text("See"), :text("See")')
                if see_link.count() > 0:
                    see_link.first.click()
                    time.sleep(3)
                else:
                    print("未找到 \"See\" 按钮，跳过该用户。")
                    continue

                # --- 进入 Renew 循环重试机制 ---
                renew_success = False
                
                for attempt in range(1, 21):
                    print(f"\n[尝试 {attempt}/20] 正在寻找 Renew 按钮...")
                    
                    if attempt > 1:
                        page.reload()
                        time.sleep(4)

                    renew_btn = page.locator('button:has-text("Renew")')
                    if renew_btn.count() == 0:
                        print("未找到 Renew 按钮 (服务器可能已续期或页面未正确渲染)。")
                        break

                    renew_btn.first.click()
                    print("Renew 按钮已点击。等待模态框...")
                    time.sleep(2)

                    # 检查网页上是否出现了弹窗 
                    page_html = page.content()
                    modal_visible = "renew-modal" in page_html or "Extend" in page_html or "Captcha" in page_html
                    if not modal_visible:
                        print("模态框未出现？重试中...")
                        continue

                    print("正在等待新版 Altcha 验证码后台自动算力求解...")
                    
                    # 保存带有验证码的截图记录
                    ts_shot_name = SCREENSHOT_DIR / f"{safe_username}_Turnstile_{attempt}.png"
                    page.screenshot(path=str(ts_shot_name))
                    print(f"   >> 📸 快照已保存: {ts_shot_name.name}")
                    
                    # 给予 Altcha 算力计算时间
                    time.sleep(6)

                    print("   >> 点击 Renew 确认按钮 (自适应定位确认按钮)...")
                    confirm_btn = page.locator('#renew-modal button:has-text("Renew"), button.btn-primary:has-text("Renew")')
                    if confirm_btn.count() > 0:
                        confirm_btn.first.click()
                        time.sleep(4)
                    else:
                        print("   >> 未能准确定位到模态框内的确认按钮，尝试通过通用规则点击")
                        page.locator('button:has-text("Renew")').first.click()
                        time.sleep(4)

                    # 校验结果
                    current_text = page.content()
                    # A. 检查是否还没到续期时间
                    if "can't renew your server yet" in current_text or "You can't renew" in current_text:
                        date_match = re.search(r"as of\s+(.*?)\s+\(", current_text)
                        date_str = date_match.group(1) if date_match else "未知时间"
                        print(f"   >> ⏳ 暂无法续期。下次可用时间: {date_str}")
                        
                        skip_shot = SCREENSHOT_DIR / f"{safe_username}_skip.png"
                        page.screenshot(path=str(skip_shot))
                        
                        send_telegram_message(
                            f"⏳ *暂无法续期 (跳过)*\n用户: {username}\n原因: 还没到时间\n下次可用: {date_str}", 
                            str(skip_shot)
                        )
                        renew_success = True
                        break

                    # B. 检查是否提示验证码未完成
                    if "complete the captcha" in current_text or "captcha" in current_text.lower():
                        print('   >> ⚠️ 检测到验证码未完成错误: "Please complete the captcha". 准备重试...')
                        continue

                    # C. 验证成功判定：模态框已关闭或包含成功字样
                    if "renew-modal" not in page.content() or "success" in current_text.lower():
                        print("   >> ✅ 模态框已关闭，服务器续期成功！")
                        success_shot = SCREENSHOT_DIR / f"{safe_username}_success.png"
                        page.screenshot(path=str(success_shot))
                        
                        send_telegram_message(f"✅ *续期成功*\n用户: {username}\n状态: 服务器已成功续期！", str(success_shot))
                        renew_success = True
                        break
                    else:
                        print("   >> 模态框仍打开但无明显错误？触发安全重试...")
                        continue

            except Exception as e:
                print(f"处理用户时发生异常: {e}")
            
            # 单个用户处理结束前的留档快照
            try:
                final_shot = SCREENSHOT_DIR / f"{safe_username}.png"
                page.screenshot(path=str(final_shot))
                print(f"用户处理完成，最终状态已截图保存。\n")
            except Exception:
                pass
                
        # 流程完毕关闭环境
        context.close()
        browser.close()

    print("所有用户执行流程结束。")


if __name__ == "__main__":
    main()
