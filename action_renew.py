import os
import json
import re
import time
from pathlib import Path
import requests

# 导入 Scrapling 的隐形动态提取器
from scrapling import Fetcher

# 读取环境变量
TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN")
TG_CHAT_ID = os.getenv("TG_CHAT_ID")
HTTP_PROXY = os.getenv("HTTP_PROXY")
USERS_JSON = os.getenv("USERS_JSON", "[]")

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
    """解析用户凭据 JSON"""
    try:
        parsed = json.loads(USERS_JSON)
        if isinstance(parsed, list):
            return parsed
        elif isinstance(parsed, dict):
            return parsed.get("users", [])
    except Exception as e:
        print(f"解析 USERS_JSON 错误: {e}")
    return []


def main():
    users = get_users()
    if not users:
        print("未在环境变量中找到任何合法的用户配置")
        return

    # 配置隐形浏览器环境
    # 使用 Scrapling 的高级功能，使其在 xvfb 下以带有完整系统特征的有头模式运行以欺骗风控
    fetcher_kwargs = {
        "headless": False,  # xvfb 环境下必须设为 False（即有头）以激活高成功率的图形渲染
        "auto_match": True  # 启用智能自适应定位
    }

    # 如果有配置代理，转换给内置浏览器使用
    if HTTP_PROXY:
        print(f"[代理] 检测到配置: {HTTP_PROXY}")
        fetcher_kwargs["proxy"] = HTTP_PROXY

    print("正在初始化 Scrapling 隐形浏览器...")
    # 建立持久化会话（类似 context），复用指纹防风控识别
    with Fetcher.start_session(**fetcher_kwargs) as session:
        
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
                time.sleep(2)

                print("正在输入凭据...")
                # 使用 Scrapling 优雅的元素过滤填写表单
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
                    time.sleep(4)
                
                # 检查密码错误提示
                if "Incorrect password" in page.text:
                    print(f"   >> ❌ 登录失败: 用户 {username} 账号或密码错误")
                    fail_shot = SCREENSHOT_DIR / f"{safe_username}_login_fail.png"
                    page.screenshot(path=str(fail_shot))
                    send_telegram_message(f"❌ *登录失败*\n用户: {username}\n原因: 账号或密码错误", str(fail_shot))
                    continue

                print('正在寻找 "See" 链接...')
                # 寻找第一个带 "See" 文本的元素或按钮
                see_link = page.get_selector('a:has-text("See")') or page.get_selector(':text("See")')
                if see_link:
                    see_link.click()
                    time.sleep(2)
                else:
                    print("未找到 \"See\" 按钮，跳过该用户。")
                    continue

                # --- 进入大循环尝试 Renew 流程 ---
                renew_success = False
                
                for attempt in range(1, 21):
                    print(f"\n[尝试 {attempt}/20] 正在寻找 Renew 按钮...")
                    
                    # 重新刷新页面确保状态最新
                    if attempt > 1:
                        page = session.refresh()
                        time.sleep(3)

                    renew_btn = page.get_selector('button:has-text("Renew")')
                    if not renew_btn:
                        print("未找到 Renew 按钮 (服务器可能已续期或页面未正确渲染)。")
                        break

                    renew_btn.click()
                    print("Renew 按钮已点击。等待模态框...")
                    time.sleep(2)

                    # 检查网页上是否出现了弹窗 (通常包含 renew-modal 关键词)
                    modal_visible = "renew-modal" in page.html or "Extend" in page.text or "Captcha" in page.text
                    if not modal_visible:
                        print("模态框未出现？重试中...")
                        continue

                    # 📸 核心突破口：保存验证码快照并硬顶等待
                    # Altcha 会在网页原生的 Web Component 中静默执行 Hash 计算（工作量证明）
                    # 脚本在此期间无需像之前那样注入大量的 JS ShadowRoot 钩子，Scrapling 会在后台伪装真实的人类底层环境。
                    print("正在等待新版 Altcha 验证码后台自动算力求解...")
                    
                    # 保存点击前的截图记录
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
                        time.sleep(3)
                    else:
                        print("   >> 未能准确定位到模态框内的确认按钮，尝试通过通用规则点击")
                        # 兜底：如果找不到，寻找有 "Renew" 字样的可点击项
                        page.click('button:has-text("Renew")')
                        time.sleep(3)

                    # 校验结果
                    # A. 检查是否还没到续期时间
                    if "can't renew your server yet" in page.text or "You can't renew" in page.text:
                        # 尝试提取可用日期
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

                    # C. 验证成功判定：模态框在网页中完全消失，或包含成功字样
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
            
            # 单个用户处理结束前的最后整页快照留档
            try:
                final_shot = SCREENSHOT_DIR / f"{safe_username}.png"
                session.page.screenshot(path=str(final_shot))
                print(f"用户处理完成，最终状态已截图保存。\n")
            except Exception:
                pass

    print("所有用户执行流程结束。")


if __name__ == "__main__":
    main()
