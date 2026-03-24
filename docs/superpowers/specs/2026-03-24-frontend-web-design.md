# 前端 Web 设计文档：Hub Web + Node Web

**日期**：2026-03-24
**状态**：草稿 v1
**关联文档**：
- `2026-03-20-open-im-decentralized-node-protocol-design.md`
- `2026-03-20-official-account-service-design.md`

---

## 一、概述

本文档描述 open-im 去中心化公众号平台的两个前端 Web 项目：

| 项目 | 说明 | 默认端口 |
|------|------|---------|
| **Hub Web**（`open-im-hub-web`）| Hub Server 的 Web 门户，提供用户登录与节点广场 | `3000` |
| **Node Web**（`open-im-node-web`）| 每个节点独立部署的公众号阅读站 | `3001`（开发）|

两者配合形成完整的交互闭环：用户在 Hub Web 登录，选择节点后跳转至 Node Web 阅读文章。

**技术栈**：React + Vite，独立静态部署（不使用 go:embed）。

---

## 二、整体交互流程

```
【Hub Web · hub.example.com】

① /login
   用户连接 MetaMask 钱包
   → GET  /user/challenge?address=0x...   (Hub Server)
   → POST /user/auth { address, signature } (Hub Server)
   ← { user_credential }
   存入 sessionStorage，跳转 /nodes

② /nodes
   → GET /nodes  (Hub Server，已有)
   展示节点卡片：名称、描述、头像

③ /nodes/:id
   展示节点详情
   点击「访问公众号」
   → POST node-server/auth/token { user_credential }  (Node Server，已有)
   ← { user_token }（Node 私钥签发，节点专属）
   → 跳转至 http://<node-web-url>/?token=<user_token>

────────────────────── 跳转 ──────────────────────

【Node Web · node.example.com】

④ 路由入口（AuthGateway）
   检测 URL 中 ?token=xxx
   → POST /auth/exchange { user_token }  (Node Server，已有) → openim_token
   存入 sessionStorage，跳转 /articles

⑤ /articles
   → OpenIM 群消息历史 API（openim_token 鉴权）
   过滤 content_type = "article"
   展示文章列表（微信公众号风格：标题 + 封面图 + 日期）

⑥ /articles/:msg_id
   从消息体取 content_url
   → GET content_url（直接加载 HTML/Markdown 正文）
   渲染文章内容
```

---

## 三、Hub Web 设计

### 3.1 页面结构

| 路由 | 页面 | 说明 |
|------|------|------|
| `/login` | 登录页 | EVM 钱包签名登录 |
| `/nodes` | 节点广场 | 所有已注册节点列表 |
| `/nodes/:id` | 节点详情 | 节点信息 + 跳转入口 |

未登录时访问 `/nodes` 或 `/nodes/:id` → 重定向至 `/login`。

### 3.2 视觉风格

现代简洁风（参考应用商店/Newsletter 平台）：
- 浅色背景（`#f8f9fa`）
- 卡片式布局，白色圆角卡片，轻阴影
- 顶部 Header：Logo + 钱包地址（截断显示）

### 3.3 登录页（`/login`）

1. 展示平台简介与「连接钱包」按钮
2. 调用 `window.ethereum.request({ method: 'eth_requestAccounts' })` 获取地址
3. `GET /user/challenge?address=<address>` → 拿到 challenge 字符串
4. `window.ethereum.request({ method: 'personal_sign', params: [challenge, address] })` 签名
5. `POST /user/auth { address, signature }` → 拿到 `user_credential`
6. 存入 `sessionStorage('user_credential')`，跳转 `/nodes`

### 3.4 节点广场（`/nodes`）

- `GET /nodes` 获取节点列表
- 卡片展示：节点头像（占位图回退）、名称、描述（截断 50 字）
- 点击卡片 → `/nodes/:id`

### 3.5 节点详情（`/nodes/:id`）

- 展示节点完整信息：名称、头像、描述、节点 ID
- 「访问公众号」按钮触发以下流程：
  1. `POST <node.api_addr>/auth/token { user_credential }` → `user_token`
  2. 跳转：`window.location.href = \`${node.web_addr}/?token=${user_token}\``

  其中 `node.api_addr` 为节点 Node Server API 地址，`node.web_addr` 为节点 Node Web 地址（均由 Hub Server `/nodes` 返回，见第五节）

---

## 四、Node Web 设计

### 4.1 页面结构

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 认证网关（AuthGateway）| 用 user_token 换取 openim_token，无 UI |
| `/articles` | 文章列表 | 公众号文章列表 |
| `/articles/:msg_id` | 文章阅读 | 文章正文渲染 |
| `/error` | 错误页 | 认证失败或无 token 时展示 |

### 4.2 视觉风格

微信公众号风格：
- 纯白背景，最大宽度 `680px` 居中
- 顶部：节点头像 + 名称
- 文章列表：标题 + 封面图（右侧缩略图）+ 日期，行间分割线

### 4.3 认证网关（`/`，`AuthGateway`）

应用启动时执行：

```
1. 检查 sessionStorage 中是否有有效 openim_token → 有则直接跳 /articles
2. 读取 URL ?token 参数（即 user_token，由 Hub Web 调用 Node Server 换取后携带过来）
   → 无 token → 跳转 /error（展示"请通过 Hub 访问"及 Hub 链接）
3. POST /auth/exchange { user_token } → openim_token, node_uid
4. 存入 sessionStorage：openim_token、node_uid
5. 清除 URL 中的 token 参数（replaceState，防止分享时泄露）
6. 跳转 /articles
```

### 4.4 文章列表（`/articles`）

每个节点的 OpenIM 实例有且仅有一个订阅群，`group_id` 固定为 `"0"`，OpenIM 内对应的 conversation_id 为 `"group_0"`。Node Web 直接查询该固定 conversation，不需要动态查找。

拉取文章列表的两步 OpenIM HTTP 接口（均需 `Authorization: Bearer <openim_token>` 请求头）：

1. `POST /msg/get_conversations_has_read_and_max_seq`
   ```json
   { "conversation_ids": ["group_0"] }
   ```
   → 获得 `max_seq`

2. `POST /msg/pull_msg_by_seq`
   ```json
   {
     "conversation_id": "group_0",
     "seq_ranges": [{ "begin": max_seq - 19, "end": max_seq }]
   }
   ```
   → 返回消息列表，过滤 `content_type = "article"` 的 Custom Message

- 列表项：
  - 左侧：标题（2 行截断）+ 日期
  - 右侧：封面图缩略图（`56×42px`，圆角）
- 分页：滚动加载，每次取 20 条（seq 向前滑动窗口）
- 点击 → `/articles/:msg_id`

### 4.5 文章阅读（`/articles/:msg_id`）

- 从列表缓存或重新查询获取消息体
- 取 `content_url` → `fetch(content_url)` → 获取正文
  - 响应 `Content-Type: text/html` 或内容含 `<!DOCTYPE` / `<html`：用 DOMPurify 消毒后 `dangerouslySetInnerHTML`
  - 其他情况均视为 Markdown：`react-markdown` 渲染
  - `content_url` 返回非 200：展示"内容加载失败"占位提示，不报错崩溃
- 顶部：文章标题 + 封面图（全宽）+ 发布日期
- 返回按钮 → `/articles`

---

## 五、Hub Server 新增 API

两个新端点，对外暴露在 HTTP `:8080`：

### 5.1 获取登录 Challenge

```
GET /user/challenge?address=<eth_address>

响应：
{
  "challenge": "open-im:login:<nonce>"
}
```

`nonce` 为随机字符串，存内存（TTL 5 分钟），防重放。Hub Server 重启后内存 nonce 全部失效，正在进行中的登录流程需重新发起 challenge；这是已知限制，可接受（登录流程耗时秒级，重启概率极低）。

### 5.2 验证签名并颁发 user_credential

```
POST /user/auth
Content-Type: application/json

{
  "address":   "0x...",
  "signature": "0x..."
}

响应：
{
  "user_credential": "<base64url_payload>.<hex_sig>"
}
```

验证逻辑：
1. `ecrecover(challenge, signature) == address` → 签名合法
2. nonce 未使用且未过期 → 消费 nonce
3. 以 `address` 作为 `app_uid`，用 `hub_private_key` 签发 `user_credential`（复用现有签发逻辑）

### 5.3 节点列表扩展字段

`GET /nodes` 响应中，每个节点新增两个字段：

```json
{
  "node_id": "...",
  "name": "科技快讯",
  "description": "...",
  "avatar": "...",
  "api_addr": "https://node.example.com:8080",
  "web_addr": "https://node.example.com"
}
```

- `api_addr`：节点 Node Server HTTP 地址，Hub Web 用于调用 `/auth/token`
- `web_addr`：节点 Node Web 地址，Hub Web 跳转目标

两字段均在节点注册/心跳时由节点运营者配置，存入 `nodes` 表新增列。

---

## 六、Node Server 改动

**零改动**。Hub Web 和 Node Web 直接复用已有接口：

| 调用方 | 接口 | 用途 |
|--------|------|------|
| Hub Web | `POST /auth/token` | 验证 user_credential，颁发 user_token（Node 签发）|
| Node Web | `POST /auth/exchange` | user_token → openim_token |

---

## 七、项目结构

### open-im-hub-web

```
open-im-hub-web/
  src/
    pages/
      LoginPage.tsx
      NodesPage.tsx
      NodeDetailPage.tsx
      ErrorPage.tsx
    api/
      hub.ts          # Hub Server API 封装（challenge、auth、nodes）
    hooks/
      useWallet.ts    # MetaMask 连接与签名
      useAuth.ts      # user_credential 管理
      useNodeToken.ts # 调用 Node Server /auth/token，换取 user_token
    components/
      NodeCard.tsx
      Header.tsx
    router.tsx
    main.tsx
  vite.config.ts
```

### open-im-node-web

```
open-im-node-web/
  src/
    pages/
      AuthGateway.tsx       # credential → token 交换（无 UI）
      ArticleListPage.tsx
      ArticleDetailPage.tsx
      ErrorPage.tsx
    api/
      node.ts               # Node Server API（auth/token、auth/exchange）
      openim.ts             # OpenIM 群消息历史 API
    hooks/
      useSession.ts         # openim_token 管理
    components/
      ArticleCard.tsx
      NodeHeader.tsx
    router.tsx
    main.tsx
  vite.config.ts
```

---

## 八、安全注意事项

| 风险 | 缓解措施 |
|------|---------|
| user_token 泄露（URL 分享）| AuthGateway 完成后立即 `replaceState` 清除 URL 参数；user_credential 不出现在 URL 中，仅在 Hub Web sessionStorage 中存储 |
| XSS（文章 HTML 内容）| `DOMPurify.sanitize()` 消毒后再注入 DOM |
| nonce 重放攻击 | Hub Server 内存 nonce，TTL 5 分钟，消费后立即失效 |
| sessionStorage 劫持 | HTTPS 部署，token 不写入 localStorage（跨 Tab 不共享）|
| CORS | Hub Server `:8080` 需对 Hub Web 域名开放 CORS（`/user/challenge`、`/user/auth`、`/nodes`）；Node Server 需对 Node Web 域名开放 CORS（`/auth/token`、`/auth/exchange`）；OpenIM API 需对 Node Web 域名开放 CORS |

---

## 九、范围外（待后续设计）

- 运营者发布文章的 Web 界面（富文本编辑器）
- 文章搜索与分类
- 节点头像上传（Hub Server 对象存储）
- Hub Web 注册流程（目前 app_uid = 钱包地址，无需注册）
- 多语言支持
- PWA / 移动端优化
