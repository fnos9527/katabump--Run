#!/usr/bin/env python3
"""KataBump 自动续期:登录(优先 cookie) -> 记录到期日 -> Renew -> 弹窗 Renew -> 等验证 -> 对比 -> TG 通知"""
import json, os, re, sys, time
from datetime import datetime
import requests
from seleniumbase import SB

BASE = "https://dashboard.katabump.com"
LOGIN_URL = f"{BASE}/auth/login"
SERVER_ID = os.getenv("SERVER_ID", "250571")
SERVER_URL = f"{BASE}/servers/edit?id={SERVER_ID}"

EMAIL = os.getenv("KB_EMAIL", "")
PASSWORD = os.getenv("KB_PASSWORD", "")
TG_TOKEN = os.getenv("TG_BOT_TOKEN", "")
TG_CHAT = os.getenv("TG_CHAT_ID", "")
COOKIE_FILE = os.getenv("COOKIE_FILE", "cookies/katabump.json")
IS_PROXY = os.getenv("IS_PROXY", "false").lower() == "true"
PROXY = "socks5://127.0.0.1:1080" if IS_PROXY else None

os.makedirs("shots", exist_ok=True)
os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)


def js(sb, body: str):
    """兼容 WebDriver 模式(需要 return)和 CDP 模式(只能是表达式)。"""
    try:
        return sb.execute_script("return (function(){" + body + "})()")
    except Exception:
        return sb.execute_script("(function(){" + body + "})()")


def tg(text: str):
    print("[TG]", text)
    if not (TG_TOKEN and TG_CHAT):
        return
    try:
        requests.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                      data={"chat_id": TG_CHAT, "text": text}, timeout=20)
    except Exception as e:
        print("TG 发送失败:", e)


def shot(sb, name):
    try:
        sb.save_screenshot(f"{name}.png", folder="shots")
    except Exception:
        pass


def body_text(sb) -> str:
    return js(sb, "return document.body ? document.body.innerText : '';") or ""


def get_expiry(sb) -> str | None:
    m = re.search(r"Expiry\s*[:\s]\s*(\d{4}-\d{2}-\d{2})", body_text(sb))
    return m.group(1) if m else None


def get_alert(sb) -> str:
    """读取页面顶部提示:优先 .alert,其次 URL 里的 renew-error 参数。"""
    txt = js(sb, """
        const a=[...document.querySelectorAll('.alert, [role=alert]')]
          .map(e=>e.innerText.trim()).filter(Boolean);
        return a.join('\\n');""") or ""
    if not txt:
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(sb.get_current_url()).query)
        txt = (q.get("renew-error") or q.get("error") or [""])[0]
    return txt.strip()


def save_cookies(sb):
    try:
        try:
            sb.driver.connect()  # uc 模式下 driver 可能处于断开状态
        except Exception:
            pass
        with open(COOKIE_FILE, "w") as f:
            json.dump(sb.driver.get_cookies(), f)
        print("cookie 已保存")
    except Exception as e:
        print("保存 cookie 失败:", e)


def load_cookies(sb) -> bool:
    if not os.path.exists(COOKIE_FILE):
        return False
    try:
        cookies = json.load(open(COOKIE_FILE))
        sb.open(BASE)
        for c in cookies:
            c.pop("sameSite", None)
            try:
                sb.driver.add_cookie(c)
            except Exception:
                pass
        return True
    except Exception as e:
        print("加载 cookie 失败:", e)
        return False


def turnstile_token(sb) -> str:
    return js(sb, "const e=document.querySelector('[name=cf-turnstile-response]');"
                  "return e?e.value:'';") or ""


def pass_cf(sb, timeout=60):
    """点 CF 复选框并等待 token 生成。"""
    end = time.time() + timeout
    tried = 0
    while time.time() < end:
        if turnstile_token(sb):
            return True
        if tried < 4:
            try:
                sb.uc_gui_click_captcha()
            except Exception as e:
                print("点击验证码:", e)
            tried += 1
        sb.sleep(3)
    return bool(turnstile_token(sb))


def is_login_page(sb) -> bool:
    return "/auth/login" in sb.get_current_url()


def login(sb):
    print("账号密码登录...")
    sb.uc_open_with_reconnect(LOGIN_URL, 4)
    sb.wait_for_element('input[type="password"]', timeout=30)
    sb.type('input[name="email"], input[type="email"]', EMAIL)
    sb.type('input[type="password"]', PASSWORD)
    if not pass_cf(sb, 60):
        shot(sb, "login_cf_fail")
        raise RuntimeError("登录页 CF 验证未通过")
    shot(sb, "login_cf_ok")
    sb.click('button:contains("Login")')
    sb.sleep(5)
    if is_login_page(sb):
        shot(sb, "login_fail")
        raise RuntimeError("登录失败,请检查账号密码或页面提示: " + get_alert(sb))
    save_cookies(sb)


def main():
    if not (EMAIL and PASSWORD) and not os.path.exists(COOKIE_FILE):
        sys.exit("缺少 KB_EMAIL / KB_PASSWORD")

    with SB(uc=True, xvfb=True, headless=False, locale_code="en",
            proxy=PROXY, page_load_strategy="eager") as sb:
        print("使用代理" if IS_PROXY else "直连")

        # 1) cookie 登录,失效则密码登录
        if load_cookies(sb):
            sb.uc_open_with_reconnect(SERVER_URL, 4)
            sb.sleep(3)
        if not load_cookies_ok(sb):
            login(sb)
            sb.uc_open_with_reconnect(SERVER_URL, 4)
            sb.sleep(3)
        else:
            save_cookies(sb)  # 刷新 cookie 有效期

        # 2) 记录到期日
        sb.wait_for_text("Service information", timeout=30)
        old = get_expiry(sb)
        print("续期前到期日:", old)
        shot(sb, "before")
        if not old:
            raise RuntimeError("读取不到到期日")

        # 3) 点页面 Renew -> 弹窗 Renew
        sb.click('button:contains("Renew")')
        sb.wait_for_element_visible(".modal.show", timeout=15)
        sb.sleep(1)
        shot(sb, "modal")
        sb.click('.modal.show button:contains("Renew")')

        # 4) 等自动验证(进度到 100%)并且弹窗关闭 / 页面刷新
        end = time.time() + 150
        while time.time() < end:
            sb.sleep(3)
            try:
                url = sb.get_current_url()
                if "renew-error" in url or "renew-success" in url:
                    break
                if not sb.is_element_visible(".modal.show"):
                    break
            except Exception:
                break  # 页面正在刷新
        sb.sleep(5)
        try:
            sb.wait_for_text("Service information", timeout=30)
        except Exception:
            pass
        shot(sb, "after")

        alert = get_alert(sb)
        # 重新打开一次详情页,确保拿到最新到期日
        sb.uc_open_with_reconnect(SERVER_URL, 3)
        sb.sleep(3)
        new = get_expiry(sb)
        print("续期后到期日:", new, "| 提示:", alert)
        save_cookies(sb)

        def d(s):
            return datetime.strptime(s, "%Y-%m-%d")

        if new and d(new) > d(old):
            tg(f"✅ KataBump 续期成功\n续期前: {old}\n续期后: {new}")
        else:
            msg = alert or "未检测到到期时间增加,也没有页面提示,请手动检查"
            tg(f"⚠️ KataBump 未续期\n到期时间: {new or old}\n页面提示: {msg}")


def load_cookies_ok(sb) -> bool:
    """当前是否处于已登录状态(没被踢回登录页)。"""
    return not is_login_page(sb) and "Service information" in body_text(sb)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        tg(f"❌ KataBump 续期脚本出错\n{type(e).__name__}: {e}")
        raise
