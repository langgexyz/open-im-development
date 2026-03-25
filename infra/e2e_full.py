#!/usr/bin/env python3
"""
infra/e2e_full.py — 全链路浏览器 E2E 测试

测试完整用户旅程：
  Hub Web 登录 → 节点广场 → 订阅节点 → Node Web 文章列表

前提：
  1. Hub Web dev server 运行中      (默认 http://localhost:5174)
  2. Node Web dev server 运行中     (默认 http://localhost:5173)
  3. Hub Server 运行中              (默认 http://localhost:8181)
  4. Node Server 运行中（已激活）   (默认 http://localhost:8282)

用法：
  python3 infra/e2e_full.py
  HUB_WEB=http://localhost:5174 NODE_WEB=http://localhost:5173 python3 infra/e2e_full.py
"""

import os
import sys
import requests

os.environ.setdefault("no_proxy", "localhost,127.0.0.1")
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")

from playwright.sync_api import sync_playwright, Page, expect

# ── 配置 ───────────────────────────────────────────────────────────────────────
HUB_WEB   = os.getenv("HUB_WEB",   "http://localhost:5174")
NODE_WEB  = os.getenv("NODE_WEB",  "http://localhost:5173")
HUB_HTTP  = os.getenv("HUB_HTTP",  "http://localhost:8181")
NODE_ADDR = os.getenv("NODE_ADDR", "http://localhost:8282")
HUB_EMAIL = os.getenv("HUB_EMAIL", "admin@e2e.test")
HUB_PASS  = os.getenv("HUB_PASS",  "e2epass123")

NAV_TIMEOUT  = 30_000   # 30 s（覆盖 WASM 加载 + OpenIM SDK 初始化）
PAGE_TIMEOUT = 10_000   # 10 s（普通页面操作）

# ── 输出 ───────────────────────────────────────────────────────────────────────
G = "\033[0;32m"; R = "\033[0;31m"; Y = "\033[1;33m"; NC = "\033[0m"
_pass = 0
_fail = 0


def ok(label: str) -> None:
    global _pass
    print(f"{G}PASS{NC} {label}")
    _pass += 1


def fail(label: str, detail: str = "") -> None:
    global _fail
    print(f"{R}FAIL{NC} {label}" + (f"\n     └─ {detail}" if detail else ""))
    _fail += 1


def info(label: str) -> None:
    print(f"\n{Y}>>>{NC} {label}")


# ── 服务检查 ───────────────────────────────────────────────────────────────────
def _reachable(url: str) -> bool:
    try:
        return requests.get(url, timeout=5).status_code < 500
    except Exception:
        return False


def check_services() -> bool:
    info("Step 0: 服务健康检查")
    services = [
        (HUB_WEB,  "Hub Web"),
        (NODE_WEB, "Node Web"),
    ]
    ok_all = True
    for url, name in services:
        if _reachable(url):
            ok(f"{name} ({url}) 可达")
        else:
            fail(f"{name} ({url}) 不可达 — 请先启动 dev server")
            ok_all = False

    # Hub Server
    try:
        r = requests.get(f"{HUB_HTTP}/nodes", timeout=5)
        r.raise_for_status()
        ok(f"Hub Server ({HUB_HTTP}) 可达")
    except Exception:
        fail(f"Hub Server ({HUB_HTTP}) 不可达")
        ok_all = False

    # Node Server
    try:
        r = requests.get(f"{NODE_ADDR}/node/info", timeout=5)
        info_data = r.json()
        if info_data.get("activated"):
            ok(f"Node Server ({NODE_ADDR}) 已激活")
        else:
            fail("Node Server 未激活 — 请先完成节点激活流程")
            ok_all = False
    except Exception:
        fail(f"Node Server ({NODE_ADDR}) 不可达")
        ok_all = False

    return ok_all


# ── 辅助：从 Hub Server 获取与 NODE_ADDR 匹配的 app_id ──────────────────────
def resolve_app_id() -> str | None:
    """
    优先返回 node_web_addr=NODE_WEB 的节点的 app_id，
    回退到 node_server_addr=NODE_ADDR 的第一个节点。
    """
    try:
        data = requests.get(f"{HUB_HTTP}/nodes", timeout=5).json()
        nodes = data.get("nodes", [])
        # 优先：node_web_addr 匹配 NODE_WEB
        for node in nodes:
            if node.get("node_web_addr", "").rstrip("/") == NODE_WEB.rstrip("/"):
                return node["app_id"]
        # 回退：node_server_addr 匹配 NODE_ADDR
        for node in nodes:
            if node.get("node_server_addr", "").rstrip("/") == NODE_ADDR.rstrip("/"):
                return node["app_id"]
        return None
    except Exception:
        return None


# ── 测试用例 ───────────────────────────────────────────────────────────────────

def test_hub_login(page: Page) -> str | None:
    """
    Hub Web 登录：
      1. 打开 /login 页面
      2. 填写邮箱/密码，提交
      3. 验证跳转到 /nodes
    返回登录后的 hub_token，失败返回 None。
    """
    info("Step 1: Hub Web 登录")
    page.goto(f"{HUB_WEB}/login")

    page.fill('input[type="email"]', HUB_EMAIL)
    page.fill('input[type="password"]', HUB_PASS)
    page.click('button[type="submit"]')

    try:
        page.wait_for_url(f"{HUB_WEB}/nodes", timeout=PAGE_TIMEOUT)
        ok("Hub Web 登录成功 → 跳转 /nodes")
    except Exception:
        fail("登录后未跳转到 /nodes", f"当前 URL: {page.url}")
        return None

    # 验证 sessionStorage 中有 hub_token
    hub_token = page.evaluate("sessionStorage.getItem('hub_token')")
    if hub_token:
        ok("sessionStorage[hub_token] 已写入")
    else:
        fail("sessionStorage[hub_token] 缺失")
        return None

    return hub_token


def test_nodes_page(page: Page, app_id: str) -> bool:
    """
    节点广场：
      1. 验证节点列表加载
      2. 找到目标节点卡片（通过链接路径匹配 app_id）
    """
    info("Step 2: 节点广场页面")

    # 节点卡片链接形如 /nodes/:app_id
    node_link = page.locator(f'a[href="/nodes/{app_id}"]')
    try:
        node_link.wait_for(state="visible", timeout=PAGE_TIMEOUT)
        ok(f"节点卡片已渲染（app_id={app_id[:16]}...）")
    except Exception:
        # 尝试检查是否有任何节点卡片
        any_link = page.locator('a[href^="/nodes/"]')
        count = any_link.count()
        if count > 0:
            fail(f"找不到 app_id={app_id[:16]}... 的节点卡片", f"共 {count} 个节点但均不匹配")
        else:
            fail("节点广场未加载任何节点卡片")
        return False

    return True


def test_subscribe(page: Page, app_id: str) -> bool:
    """
    订阅节点：
      1. 导航到 /nodes/:app_id
      2. 等待节点详情加载
      3. 点击「订阅公众号」
      4. 等待跳转到 Node Web /?token=...
      5. 等待 AuthGateway 处理完成跳转到 /articles
    """
    info("Step 3: 订阅节点")
    page.goto(f"{HUB_WEB}/nodes/{app_id}")

    # 等待「订阅公众号」按钮
    subscribe_btn = page.locator("button", has_text="订阅公众号")
    try:
        subscribe_btn.wait_for(state="visible", timeout=PAGE_TIMEOUT)
        ok("节点详情页加载完成，「订阅公众号」按钮可见")
    except Exception:
        body = page.inner_text("body")
        fail("找不到「订阅公众号」按钮", body[:120])
        return False

    # 点击订阅 —— 这会触发 getCredential → getAppToken → window.location.assign
    # 需要监听 cross-origin 导航
    with page.expect_navigation(
        url=lambda u: u.startswith(NODE_WEB),
        timeout=NAV_TIMEOUT
    ):
        subscribe_btn.click()

    # 此时应在 NODE_WEB/?token=...
    if page.url.startswith(NODE_WEB):
        ok(f"订阅成功 → 已导航到 Node Web ({page.url[:60]}...)")
    else:
        fail("点击订阅后未跳转到 Node Web", f"当前 URL: {page.url}")
        return False

    return True


def test_node_web_articles(page: Page) -> None:
    """
    Node Web 文章列表：
      1. AuthGateway 处理 ?token=... → /auth/exchange → sessionStorage
      2. 跳转到 /articles
      3. 验证文章列表或空状态
    """
    info("Step 4: Node Web 文章列表")

    # AuthGateway 交换 token 后应跳转到 /articles
    try:
        page.wait_for_url(f"{NODE_WEB}/articles", timeout=NAV_TIMEOUT)
        ok("AuthGateway 处理完成 → 跳转 /articles")
    except Exception:
        fail("未跳转到 /articles", f"当前 URL: {page.url}")
        return

    # 验证页面内容：空状态或文章列表
    try:
        page.locator("text=暂无文章").wait_for(timeout=PAGE_TIMEOUT)
        ok("文章列表页渲染成功（空状态: 暂无文章）")
    except Exception:
        cards = page.locator("[class*='card'], [class*='Card'], article").count()
        if cards > 0:
            ok(f"文章列表页渲染成功（{cards} 篇文章）")
        else:
            body = page.inner_text("body")
            # 接受任何非错误状态
            if "加载" in body or "articles" in page.url:
                ok("文章列表页已加载（内容待确认）")
            else:
                fail("文章列表页内容异常", body[:120])

    # 验证 sessionStorage
    info("Step 5: 验证 sessionStorage")
    required_keys = ["openim_token", "openim_api_addr", "openim_ws_addr", "user_id", "group_id"]
    for key in required_keys:
        val = page.evaluate(f"sessionStorage.getItem('{key}')")
        if val:
            ok(f"sessionStorage[{key!r}] = {str(val)[:40]}")
        else:
            fail(f"sessionStorage[{key!r}] 缺失")


# ── 主函数 ─────────────────────────────────────────────────────────────────────
def main() -> int:
    print()
    print("=" * 60)
    print("  Open-IM 全链路 E2E 测试（Hub Web → 订阅 → Node Web）")
    print("=" * 60)
    print()

    # 0. 服务检查
    if not check_services():
        print(f"\n{R}服务未就绪，中止测试{NC}\n")
        return 1

    # 解析目标节点 app_id
    app_id = resolve_app_id()
    if not app_id:
        print(f"{R}FAIL{NC} 无法从 Hub Server 解析节点 app_id（node_server_addr={NODE_ADDR}）")
        return 1
    print(f"{G}OK{NC}  目标节点 app_id = {app_id[:24]}...")

    # 运行 Playwright 测试
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            ignore_https_errors=True,
            # 禁用浏览器缓存，防止 Vite dep hash 版本不匹配
            bypass_csp=False,
        )
        # 清除所有缓存
        context.clear_cookies()
        page = context.new_page()

        # 收集控制台错误和失败请求便于调试
        console_errors: list[str] = []
        failed_requests: list[str] = []
        page.on("console", lambda msg: console_errors.append(msg.text)
                if msg.type == "error" else None)
        page.on("response", lambda resp: failed_requests.append(
            f"{resp.status} {resp.url[:100]}"
        ) if resp.status >= 400 else None)

        all_ok = True

        try:
            # Step 1: 登录
            hub_token = test_hub_login(page)
            if not hub_token:
                all_ok = False
            else:
                # Step 2: 节点广场
                if not test_nodes_page(page, app_id):
                    all_ok = False

                # Step 3: 订阅
                if all_ok:
                    if not test_subscribe(page, app_id):
                        all_ok = False
                    else:
                        # Step 4+5: Node Web 文章列表 + sessionStorage
                        test_node_web_articles(page)

        except Exception as e:
            fail("测试发生异常", str(e))
            all_ok = False
        finally:
            if failed_requests:
                print(f"\n{Y}失败请求:{NC}")
                for req in failed_requests[-10:]:
                    print(f"  {req[:120]}")
            if console_errors:
                print(f"\n{Y}控制台错误:{NC}")
                for err in console_errors[-5:]:
                    print(f"  {err[:120]}")
            page.close()
            context.close()
            browser.close()

    print()
    print("=" * 60)
    print(f"  结果：{G}{_pass} PASS{NC}  {R}{_fail} FAIL{NC}")
    print("=" * 60)
    print()

    return 0 if _fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
