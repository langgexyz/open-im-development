# 前端 Web 设计文档：Hub Web + Node Web

**日期**：2026-03-24
**状态**：草稿 v2
**关联文档**：
- `2026-03-20-open-im-decentralized-node-protocol-design.md`
- `2026-03-20-official-account-service-design.md`

---

## 一、概述

本文档描述 open-im 去中心化公众号平台的两个前端 Web 项目：

| 项目 | 说明 | 默认端口 |
|------|------|---------|
| **Hub Web**（`open-im-hub-web`）| Hub Server 的 Web 门户，用户注册/登录、节点广场、跳转入口 | `3000` |
| **Node Web**（`open-im-node-web`）| 每个节点独立部署的公众号阅读站 | `3001`（开发）|

**技术栈**：React + Vite，独立静态部署（不使用 go:embed）。

---

## 二、身份模型

### 2.1 ID 体系

| ID | 类型 | 生成方 | 作用域 | 说明 |
|----|------|--------|--------|------|
| `UID` | String | Hub Server（注册时）| 全局 | 用户在整个协议网络的唯一标识，跨节点不变 |
| `AppId` | String | Hub Server（节点激活时）| 全局 | 节点在协议网络的唯一标识 |
| `node_uid` | uint64 | Node Server accounts 表 auto-increment | 节点内 | 用户在该节点的本地 ID，同时作为 OpenIM userID；同一用户在不同节点的 node_uid 不同 |

### 2.2 密钥体系

| 密钥 | 生成方 | 持有方 | 用途 |
|------|--------|--------|------|
| `hub_private_key` | Hub Server | Hub Server | 签发 `credential` |
| `hub_public_key` | Hub Server | 节点 config.json（激活时写入）| Node Server 验证 credential |
| `app_private_key` | Hub Server（激活时生成）| 节点 config.json | 签发 `node_token` |
| `app_public_key` | Hub Server（激活时生成）| Hub Server nodes 表 | Hub 验证节点请求签名 |

### 2.3 Token 体系

| Token | 签发方 | 格式 | 用途 |
|-------|--------|------|------|
| `hub_token` | Hub Server | JWT | 用户登录 Hub Web 的会话凭证 |
| `credential` | Hub Server | `base64url({UID, AppId, exp}) + "." + sig` | Hub 向特定节点证明用户身份，`hub_private_key` 签发 |
| `node_token` | Node Server | `base64url({UID, AppId, node_uid, exp}) + "." + sig` | 用户访问节点资源的令牌，`app_private_key` 签发 |
| `openim_token` | OpenIM | 原生 token | 调用 OpenIM API 读取消息 |

---

## 三、完整交互流程

### 流程一：用户注册

```
用户 → Hub Web：邮箱 + 密码注册
Hub Web → Hub Server：POST /user/register { email, password }
Hub Server → Hub Web：{ UID, hub_token }
Hub Web：存入 sessionStorage，跳转 /nodes
```

### 流程二：节点部署 & 激活（双向地址打通）

```
1. 管理员启动 Node Server
   → Node 生成随机 code（存内存，一次性）
   → 仅暴露 POST /node/activate?code= 端点

2. 管理员在 Hub Web 填写：node_server_addr、code
   → Hub Server 探活：GET node_server_addr/health → 200 OK
   → Hub 生成：AppId、app_private_key、app_public_key
   → Hub 写入 nodes 表：{ AppId, app_public_key, node_server_addr }

3. 管理员在 Hub Web 填写：node_server_addr、node_web_addr、code
   → Hub 写入 nodes 表：{ AppId, app_public_key, node_server_addr, node_web_addr, admin_uid }

4. Hub → Node：POST node_server_addr/node/activate?code=xxxx
   Body：AES-256-GCM(key=SHA-256(code)) 加密 { AppId, app_private_key, app_public_key,
                          hub_server_addr, hub_public_key, hub_web_origin }
   → Node 解密写入 config.json，code 立即失效

✅ 双向打通：Hub 存有 node_server_addr + node_web_addr，Node 存有 hub_server_addr + hub_web_origin
```

### 流程三：管理员账号在节点上初始化

```
管理员（Hub UID 用户）接入自己的节点，与普通用户订阅流程完全相同：

1. Hub Web → Hub Server：POST /user/credential { uid: admin_uid, target_app_id }
   → Hub 用 hub_private_key 签发 credential（绑定 uid + app_id + exp）
   → 返回 { credential }

2. Hub Web → Node Server：POST /auth/token { credential }
   → Node 用 hub_public_key 验签，校验 app_id 匹配本节点
   → GetOrCreate accounts(admin_uid) → admin_node_uid
   → OpenIM 注册 admin_node_uid
   → 用 app_private_key 签发 node_token
   → 返回 { node_token, node_uid: admin_node_uid }

✅ admin_node_uid 写入 config.json，后续业务操作以此身份执行
```

### 权限模型：无需 role 字段

Node 不需要在 `accounts` 表中维护 `role` 字段。权限判断通过以下两层实现：

- **OpenIM 层**：订阅群 `group_id="0"` 的 owner 为 `admin_node_uid`，OpenIM 原生保障只有群主可发消息
- **Node Server 层**：管理员专属接口（如 `/node/init`）直接比较 `node_uid == config.admin_node_uid`

所有 accounts 表中的 node_uid 均为平等的"订阅者"，区分管理员与普通用户的唯一依据是 `config.json` 中的 `admin_node_uid`。

### 流程四：公众号业务初始化

```
1. 管理员在 Hub Web 设置公众号资料：名称、头像、简介
   → Hub Server：POST /node/profile { AppId, name, avatar, description }
   → Hub → Node：POST node_server_addr/node/init { name, avatar, description }
   → Node 存入 config.json（供 Node Web 展示）
   → Hub 写入 nodes 表：name、avatar、description

2. Node Server → OpenIM Admin API：创建订阅群
   group_id = "0"，owner = admin_node_uid

✅ 公众号上线，节点广场可被用户发现
```

### 流程五：普通用户订阅节点

```
1. 用户在 Hub Web 节点广场点击「订阅公众号」
   → Hub Server：POST /user/credential { uid, target_app_id }
   → 返回 { credential }

2. Hub Web → Node Server：POST /auth/token { credential }
   → Node 验签 → GetOrCreate accounts(uid) → node_uid
   → OpenIM 注册 node_uid，加入订阅群 group_id="0"
   → 返回 { node_token, node_uid }

3. Hub Web 跳转：node_web_addr/?token=<node_token>
```

### 流程六：读取文章

```
Node Web 入口（AuthGateway）：
1. 检查 sessionStorage 是否有有效 openim_token → 有则直接跳 /articles
2. 读取 URL ?token 参数（即 node_token）
   → 无 token → 跳转 /error
3. POST /auth/exchange { node_token } → openim_token
4. 存入 sessionStorage，replaceState 清 URL，跳转 /articles

/articles：
→ POST /msg/pull_msg_by_seq（Bearer openim_token，conversation_id: "group_0"）
→ 过滤 content_type=article，渲染文章列表

/articles/:msg_id：
→ 取 content_url → fetch 正文 → 渲染 HTML/Markdown
```

---

## 四、Hub Web 设计

### 4.1 页面结构

| 路由 | 页面 | 说明 |
|------|------|------|
| `/login` | 登录页 | 邮箱 + 密码登录 |
| `/register` | 注册页 | 邮箱注册，获取 UID |
| `/nodes` | 节点广场 | 所有已注册节点列表 |
| `/nodes/:app_id` | 节点详情 | 节点信息 + 订阅入口 |

未登录时访问 `/nodes` 或 `/nodes/:app_id` → 重定向至 `/login`。

### 4.2 视觉风格

现代简洁风：
- 浅色背景（`#f8f9fa`），卡片式布局，白色圆角卡片，轻阴影
- 顶部 Header：Logo + 用户邮箱缩略显示

### 4.3 登录/注册页

**注册**：邮箱 + 密码 → `POST /user/register` → `{ UID, hub_token }` → 存 sessionStorage

**登录**：邮箱 + 密码 → `POST /user/login` → `{ UID, hub_token }` → 存 sessionStorage

### 4.4 节点广场（`/nodes`）

- `GET /nodes` 获取节点列表
- 卡片展示：节点头像、名称、描述（截断 50 字）
- 点击卡片 → `/nodes/:app_id`

### 4.5 节点详情（`/nodes/:app_id`）

- 展示节点完整信息：名称、头像、描述、AppId
- 「订阅公众号」按钮触发：
  1. `POST /user/credential { uid, target_app_id }` → `credential`
  2. `POST <node.node_server_addr>/auth/token { credential }` → `node_token`
  3. 跳转：`node.node_web_addr/?token=<node_token>`

---

## 五、Node Web 设计

### 5.1 页面结构

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 认证网关（AuthGateway）| node_token → openim_token，无 UI |
| `/articles` | 文章列表 | 公众号文章列表（微信公众号风格）|
| `/articles/:msg_id` | 文章阅读 | 文章正文渲染 |
| `/error` | 错误页 | 无 token 或认证失败时展示 |

### 5.2 视觉风格

微信公众号风格：
- 纯白背景，最大宽度 `680px` 居中
- 顶部：节点头像 + 名称（从 config 或 Node Server 获取）
- 文章列表：标题（2 行截断）+ 右侧封面图缩略图（56×42px）+ 日期，行间分割线

### 5.3 认证网关（AuthGateway）

```
1. sessionStorage 有 openim_token → 直接跳 /articles
   （/articles 若收到 401，清除 sessionStorage 并跳回 / 重走认证流程）
2. 读取 URL ?token（node_token）→ 无则跳 /error
3. POST /auth/exchange { node_token } → { openim_token }
4. 存入 sessionStorage：openim_token
5. replaceState 清除 URL ?token 参数
6. 跳转 /articles
```

### 5.4 文章列表（`/articles`）

每个节点 OpenIM 实例有且仅有一个订阅群，`group_id` 固定为 `"0"`，conversation_id 为 `"group_0"`。

OpenIM API 基础 URL：`<node_openim_api_addr>`（由 Node Server 在 `/auth/exchange` 响应中一并返回，Node Web 存入 sessionStorage）。OpenIM `openim-api` 服务对用户 token 开放 `/msg/*` 接口。

拉取文章（均需 `Authorization: Bearer <openim_token>`）：

1. `POST /msg/get_conversations_has_read_and_max_seq`
   ```json
   { "conversation_ids": ["group_0"] }
   ```
   → 获得 `max_seq`

2. `POST /msg/pull_msg_by_seq`
   ```json
   { "conversation_id": "group_0",
     "seq_ranges": [{ "begin": max(1, max_seq - 19), "end": max_seq }] }
   ```
   → 过滤 `content_type = "article"` 的 Custom Message

分页：滚动加载，每次 20 条，seq 向前滑动窗口。

### 5.5 文章阅读（`/articles/:msg_id`）

- 取消息体中 `content_url` → `fetch(content_url)`
  - 响应含 `<!DOCTYPE` / `<html`：DOMPurify 消毒后 `dangerouslySetInnerHTML`
  - 其他：`react-markdown` 渲染
  - 非 200：展示"内容加载失败"占位，不崩溃
- 顶部：标题 + 封面图（全宽）+ 发布日期
- 返回按钮 → `/articles`

---

## 六、Hub Server 新增 API

### 6.1 用户注册 / 登录

```
POST /user/register  { email, password }  → { UID, hub_token }
POST /user/login     { email, password }  → { UID, hub_token }
```

### 6.2 签发 credential（用于接入节点）

```
POST /user/credential
Authorization: Bearer <hub_token>
{ "target_app_id": "..." }

响应：
{ "credential": "<base64url({UID, AppId, exp})>.<hub_sig>" }
```

credential 绑定了 UID + AppId，防止跨节点重放。

### 6.3 节点注册 & 激活

```
POST /node/activate
Authorization: Bearer <hub_token>（管理员）
{ "node_server_addr": "http://...", "node_web_addr": "http://...", "code": "..." }

Hub Server 将激活请求中的 hub_token UID 记录为该节点的 admin_uid（存入 nodes 表），后续 `/node/profile` 等管理接口校验 `hub_token.UID == nodes.admin_uid`。

激活包使用 AES-256-GCM，key = SHA-256(code)（code 为 32 字节随机值，hex 编码，管理员从 Node Server 启动日志获取）。
```

### 6.4 设置公众号资料

```
POST /node/profile
Authorization: Bearer <hub_token>（管理员）
{ "app_id": "...", "name": "...", "avatar": "...", "description": "..." }
```

### 6.5 节点列表（扩展字段）

`GET /nodes` 响应每个节点包含：

```json
{
  "app_id": "...",
  "name": "科技快讯",
  "avatar": "...",
  "description": "...",
  "node_server_addr": "https://node.example.com:8080",
  "node_web_addr": "https://node.example.com"
}
```

---

## 七、Node Server 新增 API

| 接口 | 调用方 | 说明 |
|------|--------|------|
| `POST /node/activate?code=` | Hub Server | 接收激活数据，解密写入 config.json |
| `POST /node/init` | Hub Server | 接收公众号资料，创建 OpenIM 订阅群；Hub Server 用 `hub_private_key` 对请求签名（header: `X-Hub-Sig`），Node 用 `hub_public_key` 验签 |
| `POST /auth/token` | Hub Web | credential → node_token + node_uid |
| `POST /auth/exchange` | Node Web | node_token → `{ openim_token, openim_api_addr }` |

---

## 八、项目结构

### open-im-hub-web

```
open-im-hub-web/
  src/
    pages/
      LoginPage.tsx
      RegisterPage.tsx
      NodesPage.tsx
      NodeDetailPage.tsx
      ErrorPage.tsx
    api/
      hub.ts          # Hub Server API（register、login、credential、nodes）
      node.ts         # Node Server /auth/token（订阅时调用）
    hooks/
      useAuth.ts      # UID + hub_token 管理
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
      AuthGateway.tsx       # node_token → openim_token（无 UI）
      ArticleListPage.tsx
      ArticleDetailPage.tsx
      ErrorPage.tsx
    api/
      node.ts               # /auth/exchange
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

## 九、安全注意事项

| 风险 | 缓解措施 |
|------|---------|
| node_token 泄露（URL 分享）| AuthGateway 完成后立即 `replaceState` 清除 URL 参数 |
| XSS（文章 HTML 内容）| `DOMPurify.sanitize()` 消毒后再注入 DOM |
| credential 跨节点重放 | credential 绑定 AppId，Node 校验 app_id 是否匹配本节点 |
| sessionStorage 劫持 | HTTPS 部署，token 不写入 localStorage |
| CORS | Hub Server 对 Hub Web 域名开放（`/user/*`、`/nodes`）；Node Server 从 config.json 读取 `hub_web_origin`（激活时下发）和 `node_web_addr`（同 `node_web_origin`）作为允许的 CORS origin；OpenIM API 对 Node Web 域名开放 |
| 非法节点资料修改 | `/node/profile` 校验 `hub_token.UID == nodes.admin_uid`，防止非节点所有者覆盖资料 |

---

## 十、范围外（待后续设计）

- 运营者发布文章的 Web 界面（富文本编辑器）
- 文章搜索与分类
- 节点头像上传（对象存储）
- Hub Web 密码找回流程
- 多语言支持
- PWA / 移动端优化
