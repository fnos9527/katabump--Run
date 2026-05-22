import os
import json
import re
import time
from pathlib import Path
import requests

# 导入 Scrapling 核心的 Fetcher
from scrapling import Fetcher

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

    # 配置隐形浏览器环境
    fetcher_kwargs = {
        "engine": "playwright",   # 直接指定使用动态 playwright 引擎
        "headless": False,        # xvfb 环境下必须设为 False（即有头模式）以激活指纹渲染
        "disable_resources": False # 允许加载图片和样式，以保证验证码和模态框能正确生成
    }

    # 如果有配置代理，转换给内置浏览器使用
    if HTTP_PROXY:
        print(f"[代理] 检测到配置: {HTTP_PROXY}")
        fetcher_kwargs["proxy"] = HTTP_PROXY

    print("正在初始化 Scrapling 隐形浏览器...")
    
    # 彻底修复：直接初始化 Fetcher 长连接会话，不依赖不稳定的新版类名
    session = Fetcher(**fetcher_kwargs)
    
    try:
        for idx, user in enumerate(users):
            username = user.get("username")
            password = user.get("password")
            
            safe_username = re.sub(r"[^a-zA-Z0-9]", "_", username)
            print(f"\n=== 正在处理用户 {idx + 1}/{len(users)} ===")

            try:
                # 总是先前往退出页面清除状态，然后进登录页
                session.go_to("https://dashboard.katabump.com/auth/logout")
                time.sleep(2)
                page = session.go_to("https://dashboard.katabump.com/auth/login")
                time.sleep(3)

                print("正在输入凭据...")
                # 智能识别输入框
                email_input = page.get_selector('input[type="email"]') or page.get_selector('input[name="email"]')
                pwd_input = page.get_selector('input[type="password"]')
                
                if email_input and pwd_input:
                    email_input.fill(username)
                    pwd_input.fill(password)
                    time.sleep(0.5)
                else:
                    print("❌ 未能正确定位输入框")
                    continue

                # 登录点击
                login_btn = page.get_selector('button:has-text("Login")') or page.get_selector('button[type="submit"]')
                if login_btn:
                    login_btn.click()
                    time.sleep(5)
                
                # 检查密码错误提示
                if "Incorrect password" in page.text:
                    print(f"   >> ❌ 登录失败: 用户 {username} 账号或密码错误")
                    fail_shot = SCREENSHOT_DIR / f"{safe_username}_login_fail.png"
                    page.screenshot(path=str(fail_shot))
                    send_telegram_message(f"❌ *登录失败*\n用户: {username}\n原因: 账号或密码错误", str(fail_shot))
                    continue

                print('正在寻找 "See" 链接...')
                see_link = page.get_selector('a:has-text("See")') or page.get_selector(':text("See")')
                if see_link:
                    see_link.click()
                    time.sleep(3)
                else:
                    print("未找到 \"See\" 按钮，跳过该用户。")
                    continue

                # --- 进入 Renew 循环重试机制 ---
                renew_success = False
                
                for attempt in range(1, 21):
                    print(f"\n[尝试 {attempt}/20] 正在寻找 Renew 按钮...")
                    
                    if attempt > 1:
                        page = session.refresh()
                        time.sleep(4)

                    renew_btn = page.get_selector('button:has-text("Renew")')
                    if not renew_btn:
                        print("未找到 Renew 按钮 (服务器可能已续期或页面未正确渲染)。")
                        break

                    renew_btn.click()
                    print("Renew 按钮已点击。等待模态框...")
                    time.sleep(2)

                    # 检查网页上是否出现了弹窗 
                    modal_visible = "renew-modal" in page.html or "Extend" in page.text or "Captcha" in page.text
                    if not modal_visible:
                        print("模态框未出现？重试中...")
                        continue

                    # 让 Scrapling 的高级反爬机制在后台静默支持 Altcha 验证码计算
                    print("正在等待新版 Altcha 验证码后台自动算力求解...")
                    
                    # 保存带有验证码的截图记录
                    ts_shot_name = SCREENSHOT_DIR / f"{safe_username}_Turnstile_{attempt}.png"
                    page.screenshot(path=str(ts_shot_name))
                    print(f"   >> 📸 快照已保存: {ts_shot_name.name}")
                    
                    # 给予 Altcha 在后台生成解密字符串的计算时间
                    time.sleep(6)

                    print("   >> 点击 Renew 确认按钮 (自适应定位确认按钮)...")
                    # 寻找模态框内部真正的确认 Renew 提交按钮
                    confirm_btn = page.get_selector('#renew-modal button:has-text("Renew")') or page.get_selector('button.btn-primary:has-text("Renew")')
                    if confirm_btn:
                        confirm_btn.click()
                        time.sleep(4)
                    else:
                        print("   >> 未能准确定位到模态框内的确认按钮，尝试通过通用规则点击")
                        page.click('button:has-text("Renew")')
                        time.sleep(4)

                    # 校验结果
                    # A. 检查是否还没到续期时间
                    if "can't renew your server yet" in page.text or "You can't renew" in page.text:
                        date_match = re.search(r"as of\s+(.*?)\s+\(", page.text)
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
                    if "complete the captcha" in page.text or "captcha" in page.text.lower():
                        print('   >> ⚠️ 检测到验证码未完成错误: "Please complete the captcha". 准备重试...')
                        continue

                    # C. 验证成功判定：模态框已关闭或包含成功字样
                    if "renew-modal" not in page.html or "success" in page.text.lower():
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
                session.page.screenshot(path=str(final_shot))
                print(f"用户处理完成，最终状态已截图保存。\n")
            except Exception:
                pass
                
    finally:
        # 关闭会话释放浏览器
        try:
            session.kill()
        except Exception:
            pass

    print("所有用户执行流程结束。")


if __name__ == "__main__":
    main()
