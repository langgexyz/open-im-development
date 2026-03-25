#!/usr/bin/env bash
# e2e-test.sh — 端到端拉通测试
# 前提：
#   1. Docker 已运行，infra/docker-compose.yml 容器已启动
#   2. OpenIM Server 已启动（mage start）
#   3. Hub Server 已启动（见下方 HUB_HTTP / HUB_GRPC 变量）
#   4. Node Server 已激活并重启（见下方 NODE_ADDR 变量）
#
# 用法：
#   bash infra/e2e-test.sh
#
# 若需指定服务地址：
#   HUB_HTTP=http://localhost:8181 NODE_ADDR=http://localhost:8282 bash infra/e2e-test.sh

set -euo pipefail

HUB_HTTP="${HUB_HTTP:-http://localhost:8181}"
NODE_ADDR="${NODE_ADDR:-http://localhost:8282}"
OPENIM_API="${OPENIM_API:-http://localhost:10002}"
HUB_EMAIL="${HUB_EMAIL:-admin@e2e.test}"
HUB_PASS="${HUB_PASS:-e2epass123}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

ok()   { echo -e "${GREEN}✅ PASS${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}❌ FAIL${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${YELLOW}>>>${NC} $1"; }

assert_field() {
  local label="$1" json="$2" field="$3"
  local val
  val=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field',''))" 2>/dev/null)
  if [[ -n "$val" && "$val" != "None" ]]; then
    ok "$label → $field = ${val:0:30}..."
    echo "$val"
  else
    fail "$label → missing field '$field'"
    echo ""
  fi
}

echo ""
echo "====================================="
echo "  Open-IM E2E 拉通测试"
echo "====================================="
echo ""

# ── Step 0: 服务健康检查 ──────────────────────────────────────────────────────
info "Step 0: 服务健康检查"

probe_json() {
  # Returns the JSON body or empty string on failure
  curl -s --max-time 8 "$@" 2>/dev/null || true
}

HUB_PROBE=$(probe_json "$HUB_HTTP/nodes")
if echo "$HUB_PROBE" | python3 -c "import sys,json; json.load(sys.stdin)" > /dev/null 2>&1; then
  ok "Hub Server ($HUB_HTTP) 可达"
else
  fail "Hub Server ($HUB_HTTP) 不可达 — 请先启动 Hub Server"
  exit 1
fi

NODE_INFO=$(probe_json "$NODE_ADDR/node/info")
ACTIVATED=$(echo "$NODE_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('activated',False))" 2>/dev/null || echo "False")
if [[ "$ACTIVATED" == "True" ]]; then
  ok "Node Server ($NODE_ADDR) 已激活"
elif echo "$NODE_INFO" | python3 -c "import sys,json; json.load(sys.stdin)" > /dev/null 2>&1; then
  fail "Node Server 未激活 — 请先完成节点激活流程"
  exit 1
else
  fail "Node Server ($NODE_ADDR) 不可达 — 请先启动 Node Server"
  exit 1
fi

OIM_PROBE=$(probe_json -X POST "$OPENIM_API/auth/get_admin_token" \
  -H "Content-Type: application/json" -H "operationID: healthcheck" \
  -d '{"secret":"openIM123","userID":"imAdmin"}')
OIM_CODE=$(echo "$OIM_PROBE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('errCode','err'))" 2>/dev/null || echo "err")
if [[ "$OIM_CODE" == "0" ]]; then
  ok "OpenIM API ($OPENIM_API) 可达"
else
  fail "OpenIM API ($OPENIM_API) 不可达 — 请先启动 OpenIM Server"
  exit 1
fi

# ── Step 1: Hub 用户登录，获取 hub_token ──────────────────────────────────────
info "Step 1: Hub 用户登录"

LOGIN_RESP=$(curl -s --max-time 10 -X POST "$HUB_HTTP/user/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$HUB_EMAIL\",\"password\":\"$HUB_PASS\"}")

HUB_TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hub_token',''))" 2>/dev/null)
if [[ -n "$HUB_TOKEN" ]]; then
  ok "登录成功 → hub_token 获取"
else
  fail "登录失败: $LOGIN_RESP"
  exit 1
fi

# ── Step 2: 获取节点 app_id ───────────────────────────────────────────────────
info "Step 2: 从 Node Server 获取 app_id"

NODE_APP_ID=$(curl -s "$NODE_ADDR/node/info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('app_id',''))" 2>/dev/null)
if [[ -z "$NODE_APP_ID" ]]; then
  # 兼容: /node/info 可能不返回 app_id，从节点目录查
  NODE_APP_ID=$(curl -s "$HUB_HTTP/nodes" | python3 -c "
import sys,json
nodes = json.load(sys.stdin).get('nodes',[])
print(nodes[0]['app_id'] if nodes else '')" 2>/dev/null)
fi
if [[ -n "$NODE_APP_ID" ]]; then
  ok "app_id = ${NODE_APP_ID:0:20}..."
else
  fail "无法获取节点 app_id"
  exit 1
fi

# ── Step 3: 签发 user_credential ─────────────────────────────────────────────
info "Step 3: 签发 user_credential"

CRED_RESP=$(curl -s --max-time 10 -X POST "$HUB_HTTP/user/credential" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -d "{\"target_app_id\":\"$NODE_APP_ID\"}")

CREDENTIAL=$(echo "$CRED_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('credential',''))" 2>/dev/null)
if [[ -n "$CREDENTIAL" ]]; then
  ok "credential 签发成功（${#CREDENTIAL} chars）"
else
  fail "credential 签发失败: $CRED_RESP"
  exit 1
fi

# ── Step 4: Node Server /auth/token ──────────────────────────────────────────
info "Step 4: POST /auth/token（credential → app_token）"

TOKEN_RESP=$(curl -s --max-time 10 -X POST "$NODE_ADDR/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"credential\":\"$CREDENTIAL\"}")

APP_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('app_token',''))" 2>/dev/null)
APP_UID=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('app_uid',''))" 2>/dev/null)

if [[ -n "$APP_TOKEN" && -n "$APP_UID" ]]; then
  ok "/auth/token → app_uid=$APP_UID, app_token 获取"
else
  fail "/auth/token 失败: $TOKEN_RESP"
  exit 1
fi

# ── Step 5: Node Server /auth/exchange ───────────────────────────────────────
info "Step 5: POST /auth/exchange（app_token → OpenIM SDK 参数）"

EXCHANGE_RESP=$(curl -s --max-time 10 -X POST "$NODE_ADDR/auth/exchange" \
  -H "Content-Type: application/json" \
  -d "{\"app_token\":\"$APP_TOKEN\"}")

OPENIM_TOKEN=$(echo "$EXCHANGE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('openim_token',''))" 2>/dev/null)
OPENIM_WS=$(echo "$EXCHANGE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('openim_ws_addr',''))" 2>/dev/null)
USER_ID=$(echo "$EXCHANGE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_id',''))" 2>/dev/null)
GROUP_ID=$(echo "$EXCHANGE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('group_id',''))" 2>/dev/null)

[[ -n "$OPENIM_TOKEN" ]] && ok "/auth/exchange → openim_token 获取" || fail "缺少 openim_token"
[[ -n "$OPENIM_WS" ]]    && ok "/auth/exchange → openim_ws_addr=$OPENIM_WS" || fail "缺少 openim_ws_addr"
[[ -n "$USER_ID" ]]      && ok "/auth/exchange → user_id=$USER_ID" || fail "缺少 user_id"
[[ -n "$GROUP_ID" ]]     && ok "/auth/exchange → group_id=$GROUP_ID" || fail "缺少 group_id"

# ── Step 6: 验证 OpenIM token 有效（调用 OpenIM API）────────────────────────
info "Step 6: 验证 OpenIM token 有效性"

USER_RESP=$(probe_json -X POST "$OPENIM_API/user/get_users_info" \
  -H "Content-Type: application/json" \
  -H "operationID: e2e-verify" \
  -H "token: $OPENIM_TOKEN" \
  -d "{\"userIDs\":[\"$USER_ID\"]}")

OIM_ERR=$(echo "$USER_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('errCode',999))" 2>/dev/null || echo "999")
if [[ "$OIM_ERR" == "0" ]]; then
  ok "OpenIM token 有效 → /user/get_users_info errCode=0"
else
  fail "OpenIM token 验证失败: errCode=$OIM_ERR"
fi

# ── Step 7: 验证订阅群存在 ────────────────────────────────────────────────────
info "Step 7: 验证订阅群 group_id=$GROUP_ID 存在"

OPENIM_ADMIN_TOKEN=$(probe_json -X POST "$OPENIM_API/auth/get_admin_token" \
  -H "Content-Type: application/json" -H "operationID: e2e-admin" \
  -d '{"secret":"openIM123","userID":"imAdmin"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])" 2>/dev/null || echo "")

GROUP_RESP=$(probe_json -X POST "$OPENIM_API/group/get_groups" \
  -H "Content-Type: application/json" \
  -H "operationID: e2e-group" \
  -H "token: $OPENIM_ADMIN_TOKEN" \
  -d "{\"groupIDs\":[\"$GROUP_ID\"],\"pagination\":{\"pageNumber\":1,\"showNumber\":10}}")

GROUP_ERR=$(echo "$GROUP_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('errCode',999))" 2>/dev/null || echo "999")
GROUP_FOUND=$(echo "$GROUP_RESP" | python3 -c "
import sys,json
d = json.load(sys.stdin)
groups = d.get('data',{}).get('groups',[])
ids = [g.get('groupInfo',{}).get('groupID','') for g in groups]
print('1' if '$GROUP_ID' in ids else '0')
" 2>/dev/null || echo "0")

if [[ "$GROUP_ERR" == "0" && "$GROUP_FOUND" == "1" ]]; then
  ok "订阅群存在（groupID=$GROUP_ID，owner=0）"
else
  fail "订阅群不存在: errCode=$GROUP_ERR found=$GROUP_FOUND"
fi

# ── 汇总 ───────────────────────────────────────────────────────────────────────
echo ""
echo "====================================="
echo -e "  结果：${GREEN}$PASS PASS${NC}  ${RED}$FAIL FAIL${NC}"
echo "====================================="
echo ""

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
