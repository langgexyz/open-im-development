#!/usr/bin/env python3
"""
infra/e2e_api.py — API-level end-to-end test for Open-IM platform.

Tests the full authentication chain:
  Hub login -> credential -> /auth/token -> /auth/exchange -> OpenIM verification

Usage:
  python3 infra/e2e_api.py
  HUB_HTTP=http://hub:8181 NODE_ADDR=http://node:8282 python3 infra/e2e_api.py

Also importable by e2e_ui.py via get_full_session().
"""

import os
import sys
import requests
os.environ.setdefault("no_proxy", "localhost,127.0.0.1")
os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")

# ── Configuration ─────────────────────────────────────────────────────────────
HUB_HTTP  = os.getenv("HUB_HTTP",   "http://localhost:8181")
NODE_ADDR = os.getenv("NODE_ADDR",  "http://localhost:8282")
OPENIM    = os.getenv("OPENIM_API", "http://localhost:10002")
HUB_EMAIL = os.getenv("HUB_EMAIL",  "admin@e2e.test")
HUB_PASS  = os.getenv("HUB_PASS",   "e2epass123")
TIMEOUT   = 10  # seconds

# ── Output helpers ─────────────────────────────────────────────────────────────
G = "\033[0;32m"; R = "\033[0;31m"; Y = "\033[1;33m"; NC = "\033[0m"
_pass_count = 0
_fail_count = 0

def ok(label: str) -> None:
    global _pass_count
    print(f"{G}PASS{NC} {label}")
    _pass_count += 1

def fail(label: str, detail: str = "") -> None:
    global _fail_count
    print(f"{R}FAIL{NC} {label}" + (f" — {detail}" if detail else ""))
    _fail_count += 1

def info(label: str) -> None:
    print(f"\n{Y}>>>{NC} {label}")

# ── Low-level HTTP helpers ─────────────────────────────────────────────────────
def _get(url: str, **kw) -> dict | None:
    try:
        r = requests.get(url, timeout=TIMEOUT, **kw)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None

def _post(url: str, **kw) -> dict | None:
    try:
        r = requests.post(url, timeout=TIMEOUT, **kw)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None

# ── Test steps ─────────────────────────────────────────────────────────────────
def check_services() -> bool:
    info("Step 0: 服务健康检查")

    if _get(f"{HUB_HTTP}/nodes") is not None:
        ok(f"Hub Server ({HUB_HTTP}) 可达")
    else:
        fail(f"Hub Server ({HUB_HTTP}) 不可达")
        return False

    node_info = _get(f"{NODE_ADDR}/node/info")
    if node_info and node_info.get("activated"):
        ok(f"Node Server ({NODE_ADDR}) 已激活")
    elif node_info:
        fail("Node Server 未激活 — 请先完成节点激活流程")
        return False
    else:
        fail(f"Node Server ({NODE_ADDR}) 不可达")
        return False

    oim = _post(f"{OPENIM}/auth/get_admin_token",
                json={"secret": "openIM123", "userID": "imAdmin"},
                headers={"operationID": "healthcheck"})
    if oim and oim.get("errCode") == 0:
        ok(f"OpenIM API ({OPENIM}) 可达")
    else:
        fail(f"OpenIM API ({OPENIM}) 不可达")
        return False

    return True


def hub_login() -> str | None:
    info("Step 1: Hub 用户登录")
    data = _post(f"{HUB_HTTP}/user/login",
                 json={"email": HUB_EMAIL, "password": HUB_PASS})
    token = (data or {}).get("hub_token")
    if token:
        ok("登录成功 — hub_token 已获取")
        return token
    fail("登录失败", str(data))
    return None


def get_app_id() -> str | None:
    info("Step 2: 获取节点 app_id")
    data = _get(f"{NODE_ADDR}/node/info")
    app_id = (data or {}).get("app_id")
    if app_id:
        ok(f"app_id = {app_id[:24]}...")
        return app_id
    # fallback: first node from hub directory
    nodes_data = _get(f"{HUB_HTTP}/nodes")
    nodes = (nodes_data or {}).get("nodes", [])
    app_id = nodes[0].get("app_id") if nodes else None
    if app_id:
        ok(f"app_id (from hub) = {app_id[:24]}...")
        return app_id
    fail("无法获取节点 app_id")
    return None


def get_credential(hub_token: str, app_id: str) -> str | None:
    info("Step 3: 签发 user_credential")
    data = _post(f"{HUB_HTTP}/user/credential",
                 json={"target_app_id": app_id},
                 headers={"Authorization": f"Bearer {hub_token}"})
    cred = (data or {}).get("credential")
    if cred:
        ok(f"credential 签发成功（{len(cred)} chars）")
        return cred
    fail("credential 签发失败", str(data))
    return None


def auth_token(credential: str) -> tuple[str, str] | tuple[None, None]:
    info("Step 4: POST /auth/token（credential -> app_token）")
    data = _post(f"{NODE_ADDR}/auth/token", json={"credential": credential})
    app_token = (data or {}).get("app_token")
    app_uid   = (data or {}).get("app_uid")
    if app_token and app_uid is not None:
        ok(f"/auth/token — app_uid={app_uid}, app_token 已获取")
        return app_token, str(app_uid)
    fail("/auth/token 失败", str(data))
    return None, None


def auth_exchange(app_token: str) -> dict | None:
    info("Step 5: POST /auth/exchange（app_token -> OpenIM SDK 参数）")
    data = _post(f"{NODE_ADDR}/auth/exchange", json={"app_token": app_token})
    if not data:
        fail("/auth/exchange 失败（无响应）")
        return None

    all_ok = True
    for field in ("openim_token", "openim_ws_addr", "user_id", "group_id"):
        v = data.get(field)
        if v:
            ok(f"/auth/exchange — {field} = {str(v)[:40]}")
        else:
            fail(f"/auth/exchange — 缺少字段 {field!r}")
            all_ok = False

    return data if all_ok else None


def verify_openim_token(session: dict) -> None:
    info("Step 6: 验证 OpenIM token 有效性")
    r = _post(f"{OPENIM}/user/get_users_info",
              json={"userIDs": [session["user_id"]]},
              headers={"token": session["openim_token"], "operationID": "e2e-verify"})
    if r and r.get("errCode") == 0:
        ok("OpenIM token 有效 (errCode=0)")
    else:
        fail("OpenIM token 验证失败", f"errCode={r.get('errCode') if r else 'N/A'}")


def verify_group(session: dict) -> None:
    info("Step 7: 验证订阅群存在")
    admin_resp = _post(f"{OPENIM}/auth/get_admin_token",
                       json={"secret": "openIM123", "userID": "imAdmin"},
                       headers={"operationID": "e2e-admin"})
    admin_token = None
    if admin_resp and admin_resp.get("errCode") == 0:
        admin_token = admin_resp.get("data", {}).get("token")
    if not admin_token:
        fail("无法获取 OpenIM admin token")
        return

    group_id = session["group_id"]
    r = _post(f"{OPENIM}/group/get_groups",
              json={"groupIDs": [group_id],
                    "pagination": {"pageNumber": 1, "showNumber": 10}},
              headers={"token": admin_token, "operationID": "e2e-group"})

    if not r or r.get("errCode") != 0:
        fail("get_groups 请求失败", f"errCode={r.get('errCode') if r else 'N/A'}")
        return

    groups = r.get("data", {}).get("groups", [])
    found = [g.get("groupInfo", {}).get("groupID") for g in groups]
    if group_id in found:
        ok(f"订阅群存在（groupID={group_id}）")
    else:
        fail(f"订阅群不存在", f"groupID={group_id}")


# ── Public API for UI tests ────────────────────────────────────────────────────
def get_full_session() -> dict:
    """
    Run full API chain without printing, return session dict:
      {app_token, openim_token, openim_api_addr, openim_ws_addr, user_id, group_id}

    Raises RuntimeError on any failure.
    """
    login = _post(f"{HUB_HTTP}/user/login",
                  json={"email": HUB_EMAIL, "password": HUB_PASS})
    hub_token = (login or {}).get("hub_token")
    if not hub_token:
        raise RuntimeError(f"Hub login failed: {login}")

    node_info = _get(f"{NODE_ADDR}/node/info")
    app_id = (node_info or {}).get("app_id")
    if not app_id:
        raise RuntimeError("Cannot get app_id from /node/info")

    cred_resp = _post(f"{HUB_HTTP}/user/credential",
                      json={"target_app_id": app_id},
                      headers={"Authorization": f"Bearer {hub_token}"})
    credential = (cred_resp or {}).get("credential")
    if not credential:
        raise RuntimeError(f"Credential issue failed: {cred_resp}")

    tok_resp = _post(f"{NODE_ADDR}/auth/token", json={"credential": credential})
    app_token = (tok_resp or {}).get("app_token")
    if not app_token:
        raise RuntimeError(f"/auth/token failed: {tok_resp}")

    exchange = _post(f"{NODE_ADDR}/auth/exchange", json={"app_token": app_token})
    if not exchange or not exchange.get("openim_token"):
        raise RuntimeError(f"/auth/exchange failed: {exchange}")

    return {"app_token": app_token, **exchange}


# ── Main ───────────────────────────────────────────────────────────────────────
def main() -> int:
    print()
    print("=" * 50)
    print("  Open-IM API E2E 拉通测试")
    print("=" * 50)

    if not check_services():
        print(f"\n{R}服务未就绪，中止测试{NC}\n")
        return 1

    hub_token = hub_login()
    if not hub_token:
        return 1

    app_id = get_app_id()
    if not app_id:
        return 1

    cred = get_credential(hub_token, app_id)
    if not cred:
        return 1

    app_token, _ = auth_token(cred)
    if not app_token:
        return 1

    session = auth_exchange(app_token)
    if not session:
        return 1

    verify_openim_token(session)
    verify_group(session)

    print()
    print("=" * 50)
    print(f"  结果：{G}{_pass_count} PASS{NC}  {R}{_fail_count} FAIL{NC}")
    print("=" * 50)
    print()

    return 0 if _fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
