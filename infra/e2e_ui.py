#!/usr/bin/env python3
"""
infra/e2e_ui.py — Playwright-based frontend e2e test for Node Web.

Tests the browser user flow end-to-end:
  URL ?token=<app_token> -> AuthGateway -> /auth/exchange -> /articles page

Prerequisites:
  1. Backend services running (pass python3 infra/e2e_api.py first)
  2. Node Web dev server: cd open-im-node-web && npm run dev
  3. Playwright installed:
       pip install playwright && playwright install chromium

Usage:
  python3 infra/e2e_ui.py
  NODE_WEB=http://localhost:5173 python3 infra/e2e_ui.py
"""

import os
import sys
import requests
os.environ.setdefault("no_proxy", "localhost,127.0.0.1")
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")
from playwright.sync_api import sync_playwright, Page

# Import API chain helper
sys.path.insert(0, os.path.dirname(__file__))
from e2e_api import get_full_session

NODE_WEB    = os.getenv("NODE_WEB", "http://localhost:5173")
NAV_TIMEOUT = 30_000   # 30 s — covers WASM loading + OpenIM SDK init
PAGE_TIMEOUT = 10_000  # 10 s — for simpler element checks

G = "\033[0;32m"; R = "\033[0;31m"; Y = "\033[1;33m"; NC = "\033[0m"
_pass = 0
_fail = 0


def ok(label: str) -> None:
    global _pass
    print(f"{G}PASS{NC} {label}")
    _pass += 1


def fail(label: str, detail: str = "") -> None:
    global _fail
    print(f"{R}FAIL{NC} {label}" + (f" — {detail}" if detail else ""))
    _fail += 1


# ── Helpers ────────────────────────────────────────────────────────────────────
def node_web_running() -> bool:
    try:
        r = requests.get(NODE_WEB, timeout=5)
        return r.status_code < 500
    except Exception:
        return False


# ── Test cases ─────────────────────────────────────────────────────────────────
def test_valid_token_flow(page: Page, app_token: str) -> None:
    """
    Valid app_token in URL:
      1. AuthGateway exchanges it via /auth/exchange (proxied to Node Server)
      2. Saves session to sessionStorage
      3. Redirects to /articles
      4. ArticleListPage renders (empty state or articles)
    """
    page.goto(f"{NODE_WEB}/?token={app_token}")

    # Wait for redirect to /articles
    try:
        page.wait_for_url(f"{NODE_WEB}/articles", timeout=NAV_TIMEOUT)
        ok("有效 token -> 成功跳转 /articles")
    except Exception:
        fail("有效 token 未跳转到 /articles", f"当前 URL: {page.url}")
        return

    # Verify article list or empty state is rendered
    try:
        page.locator("text=暂无文章").wait_for(timeout=NAV_TIMEOUT)
        ok("文章列表页渲染成功（空状态 '暂无文章'）")
    except Exception:
        # Maybe there are actual articles — check for ArticleCard
        cards = page.locator("[class*='card'], [class*='Card']").count()
        if cards > 0:
            ok(f"文章列表页渲染成功（{cards} 篇文章）")
        else:
            # Still on /articles but content unclear — check body
            body = page.inner_text("body")
            if "暂无文章" in body or "加载" in body:
                ok("文章列表页有内容")
            else:
                fail("文章列表页无预期内容", body[:120])


def test_session_persisted(page: Page) -> None:
    """
    After successful auth, sessionStorage should contain all required keys.
    (Assumes test_valid_token_flow ran on the same page first.)
    """
    required = ["openim_token", "openim_api_addr", "openim_ws_addr", "user_id", "group_id"]
    for key in required:
        val = page.evaluate(f"sessionStorage.getItem('{key}')")
        if val:
            ok(f"sessionStorage[{key!r}] 已写入")
        else:
            fail(f"sessionStorage[{key!r}] 缺失")


def test_no_token_redirect_error(page: Page) -> None:
    """
    No token in URL -> AuthGateway redirects to /error.
    """
    page.goto(f"{NODE_WEB}/")

    try:
        page.wait_for_url(f"{NODE_WEB}/error", timeout=PAGE_TIMEOUT)
        ok("无 token -> 成功跳转 /error")
    except Exception:
        fail("无 token 未跳转到 /error", f"当前 URL: {page.url}")
        return

    body = page.inner_text("body")
    if "访问出错" in body or "缺少有效凭证" in body:
        ok("/error 页面显示正确错误信息")
    else:
        fail("/error 页面内容异常", body[:120])


def test_invalid_token_redirect_error(page: Page) -> None:
    """
    Bad app_token -> /auth/exchange returns 4xx -> redirect to /error.
    """
    page.goto(f"{NODE_WEB}/?token=invalid-token-xyz")

    try:
        page.wait_for_url(f"{NODE_WEB}/error", timeout=PAGE_TIMEOUT)
        ok("无效 token -> 成功跳转 /error")
    except Exception:
        fail("无效 token 未跳转到 /error", f"当前 URL: {page.url}")


# ── Main ───────────────────────────────────────────────────────────────────────
def main() -> int:
    print()
    print("=" * 50)
    print("  Open-IM 前端 E2E 测试（Playwright）")
    print("=" * 50)
    print()

    # Check Node Web
    if not node_web_running():
        print(f"{R}Node Web ({NODE_WEB}) 不可达。请先运行:{NC}")
        print(f"  cd open-im-node-web && npm run dev")
        return 1
    print(f"{G}OK{NC}  Node Web ({NODE_WEB}) 可达")

    # Get app_token via API chain
    print(f"\n{Y}>>>{NC} 通过 API 链获取 app_token...")
    try:
        session = get_full_session()
        app_token = session["app_token"]
        print(f"{G}OK{NC}  app_token 获取成功")
    except Exception as e:
        print(f"{R}FAIL{NC} 无法获取 app_token: {e}")
        print(f"  请先确认后端服务均已启动（运行 python3 infra/e2e_api.py 检查）")
        return 1

    # Run Playwright tests
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # Test 1 + 2: valid token flow + session check (share same page)
        print(f"\n{Y}>>> 测试 1/2: 有效 token 认证流程 + session 持久化{NC}")
        page = browser.new_page()
        try:
            test_valid_token_flow(page, app_token)
            test_session_persisted(page)
        except Exception as e:
            fail("测试异常", str(e))
        finally:
            page.close()

        # Test 3: no token
        print(f"\n{Y}>>> 测试 3: 无 token -> /error{NC}")
        page = browser.new_page()
        try:
            test_no_token_redirect_error(page)
        except Exception as e:
            fail("测试异常", str(e))
        finally:
            page.close()

        # Test 4: invalid token
        print(f"\n{Y}>>> 测试 4: 无效 token -> /error{NC}")
        page = browser.new_page()
        try:
            test_invalid_token_redirect_error(page)
        except Exception as e:
            fail("测试异常", str(e))
        finally:
            page.close()

        browser.close()

    print()
    print("=" * 50)
    print(f"  结果：{G}{_pass} PASS{NC}  {R}{_fail} FAIL{NC}")
    print("=" * 50)
    print()

    return 0 if _fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
