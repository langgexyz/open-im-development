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
| `app_uid` | uint64 | Node Server accounts 表 auto-increment | 节点内 | 用户在该节点的本地 ID，同时作为 OpenIM userID；同一用户在不同节点的 app_uid 不同 |

### 2.2 密钥体系

| 密钥 | 生成方 | 持有方 | 用途 |
|------|--------|--------|------|
| `hub_private_key` | Hub Server | Hub Server | 签发 `credential` |
| `hub_public_key` | Hub Server | 节点 config.json（激活时写入）| Node Server 验证 credential |
| `app_private_key` | Hub Server（激活时生成）| 节点 config.json | 签发 `app_token` |
| `app_public_key` | Hub Server（激活时生成）| Hub Server nodes 表 | Hub 验证节点请求签名 |

### 2.3 Token 体系

| Token | 签发方 | 格式 | 用途 |
|-------|--------|------|------|
| `hub_token` | Hub Server | JWT | 用户登录 Hub Web 的会话凭证 |
| `credential` | Hub Server | `base64url({UID, AppId, exp}) + "." + sig` | Hub 向特定节点证明用户身份，`hub_private_key` 签发 |
| `app_token` | Node Server | `base64url({UID, AppId, app_uid, exp}) + "." + sig` | 用户访问节点资源的令牌，`app_private_key` 签发 |
| `openim_token` | OpenIM | 原生 token | 调用 OpenIM API 读取消息 |

---

## 三、完整交互流程

### 流程一：用户注册

```
用户 → Hub Web：邮箱 + 密码注册（密码最小 6 位，无邮箱验证）
Hub Web → Hub Server：POST /user/register { email, password }
Hub Server → Hub Web：{ uid, hub_token }   （uid = users.id 字符串化，如 "10001"）
Hub Web：存入 sessionStorage，跳转 /nodes
```

> **TODO**：hub_token 过期后暂无 refresh token，到期重新登录；后续用户中心迭代时补充。

### 流程二：节点部署 & 激活（幂等）

```
1. 管理员启动 Node Server
   → Node 生成 code（32 字节随机，64 hex 字符）—— code 即 AppId，全局唯一
   → 存入内存，打印到启动日志，等待激活
   → 仅暴露 POST /node/activate?code= 端点

2. 管理员在 Hub Web 填写：code、node_server_addr、node_web_addr（origin）
   → Hub Server：
     a. 验证 hub_token，提取 admin_uid
     b. 探活：GET node_server_addr/node/info → 200 且 activated: false
     c. 检查 nodes 表 app_id = code：
        - 无记录 → 生成 app_private_key、app_public_key；INSERT nodes 表（status=0）
        - 有记录 → 复用已有密钥（幂等重试）
     d. POST node_server_addr/node/activate?code=xxxx
        Body：AES-256-GCM(key=SHA-256(hex_decode(code))) 加密 {
          app_id, app_private_key, app_public_key,
          hub_grpc_addr, hub_public_key, hub_web_origin
        }
     e. Node 返回 200 → Hub Server 更新 nodes 表 status=1（active）

3. Node Server 解密，写入 config.json，code 在内存中失效

✅ Hub 存有 node_server_addr + node_web_addr（admin_uid 记录激活者）
✅ Node 存有 app_id、app_private_key、hub_grpc_addr、hub_public_key、hub_web_origin
```

### 流程三：管理员账号在节点上初始化

```
管理员（Hub UID 用户）接入自己的节点，与普通用户订阅流程完全相同：

1. Hub Web → Hub Server：POST /user/credential { target_app_id }
   Authorization: Bearer <hub_token>
   → Hub 用 hub_private_key 签发 credential（绑定 uid + app_id + exp）
   → 返回 { credential }

2. Hub Web 跳转至 Node Web：node_web_addr/?credential=<credential>

3. Node Web → Node Server：POST /auth/token { credential }
   → 验签，GetOrCreate accounts(uid) → admin_app_uid
   → OpenIM 注册 admin_app_uid
   → 将此 app_uid 写入 config.json（admin_app_uid）
   → 返回 { app_token, app_uid }

4. Node Web → Node Server：POST /auth/exchange { app_token }
   → 返回 { openim_token, openim_api_addr, group_id }

✅ config.admin_app_uid 就绪，流程四依赖此值，须在流程四之前完成
```

### 权限模型：无需 role 字段

Node 不需要在 `accounts` 表中维护 `role` 字段。权限判断通过以下两层实现：

- **OpenIM 层**：订阅群（`config.subscription_group_id`）的 owner 为 `admin_app_uid`，OpenIM 原生保障只有群主可发消息
- **Node Server 层**：管理员专属接口（`/node/init`）直接比较 `app_uid == config.admin_app_uid`

所有 accounts 表中的 app_uid 均为平等的"订阅者"，区分管理员与普通用户的唯一依据是 `config.json` 中的 `admin_app_uid`。

### 流程四：公众号业务初始化

```
管理员在 Node Web（已通过流程三登录，app_uid == config.admin_app_uid）：

1. 填写名称、头像、简介
   Node Web → Node Server：POST /node/init { name, avatar, description }
   Authorization: Bearer <app_token>（Node Server 校验 app_uid == config.admin_app_uid）

   Node Server 内部执行（原子）：
   a. 存入 config.json（name、avatar、description）
   b. → OpenIM Admin API 创建订阅群（owner = admin_app_uid）
      → 写入 config.json（subscription_group_id）
   c. → Hub Server gRPC：UpdateNodeProfile { app_id, name, avatar, description }
      → Hub Server 更新 nodes 表（供节点广场展示）

✅ 公众号上线，节点广场可被用户发现
```

> Hub Web 的 `/admin/nodes/:app_id` 页面不再包含资料编辑表单，仅作为跳转入口（携带 credential 跳转至 Node Web 管理页面）。Hub Server 的 `POST /node/profile` 接口已移除。

### 流程五：普通用户订阅节点

```
1. 用户在 Hub Web 节点广场点击「订阅公众号」
   Hub Web → Hub Server：POST /user/credential { uid, target_app_id }
   Authorization: Bearer <hub_token>
   → 返回 { credential }

2. Hub Web 跳转至 Node Web（浏览器导航，不是 API 调用）：
   window.location.assign(node_web_addr + "/?credential=" + credential)
   （Hub Web 不直接调用 Node Server）

3. Node Web → Node Server：POST /auth/token { credential }
   → Node 验签 → GetOrCreate accounts(uid) → app_uid
   → OpenIM 注册 app_uid，加入订阅群（config.subscription_group_id）
   → 返回 { app_token, app_uid }

4. Node Web → Node Server：POST /auth/exchange { app_token }
   → 返回 { openim_token, openim_api_addr, group_id }

5. Node Web 存入 sessionStorage，跳转 /articles
```

### 流程六：读取文章

```
Node Web 入口（AuthGateway）：
1. 检查 sessionStorage 是否有有效 openim_token → 有则直接跳 /articles
2. 读取 URL ?credential 参数
   → 无 credential → 跳转 /error
3. POST /auth/token { credential } → { app_token }
4. POST /auth/exchange { app_token } → { openim_token, openim_api_addr, group_id }
5. 存入 sessionStorage，replaceState 清 URL，跳转 /articles

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
| `/admin/activate` | 节点激活 | 管理员填写 node_server_addr、node_web_addr、code（流程二）|
| `/admin/nodes/:app_id` | 节点管理 | 管理员设置公众号资料（流程四）；仅节点 admin_uid 可见 |

未登录时访问任何路由 → 重定向至 `/login`。`/admin/*` 路由额外校验当前用户是否为该节点的 admin_uid。

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
  1. `POST /user/credential { uid, target_app_id }` → `{ credential }`（仅调 Hub Server）
  2. 浏览器跳转：`window.location.assign(node.node_web_addr + "/?credential=" + credential)`
  （Hub Web 不调 Node Server，credential 由 Node Web 自行向 Node Server 兑换）

---

## 五、Node Web 设计

### 5.1 页面结构

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 认证网关（AuthGateway）| app_token → openim_token，无 UI |
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
2. 读取 URL ?credential → 无则跳 /error
3. POST /auth/token { credential } → { app_token }
   → 失败则跳 /error（credential 过期或 app_id 不匹配）
4. POST /auth/exchange { app_token } → { openim_token, openim_api_addr, group_id }
5. 存入 sessionStorage：openim_token、openim_api_addr、group_id
6. replaceState 清除 URL ?credential 参数
7. 跳转 /articles
```

### 5.4 文章列表（`/articles`）

每个节点 OpenIM 实例有且仅有一个订阅群。`group_id` 存储在 Node Server 的 `config.json`（字段 `subscription_group_id`），通过 `/auth/exchange` 响应返回给 Node Web，`conversation_id = "group_" + group_id`。

OpenIM API 基础 URL：`<node_openim_api_addr>`（由 Node Server 在 `/auth/exchange` 响应中一并返回，Node Web 存入 sessionStorage）。OpenIM `openim-api` 服务对用户 token 开放 `/msg/*` 接口。

`/auth/exchange` 响应格式：
```json
{ "openim_token": "...", "openim_api_addr": "https://...", "group_id": "<subscription_group_id>" }
```

拉取文章（均需 `Authorization: Bearer <openim_token>`）：

1. `POST /msg/get_conversations_has_read_and_max_seq`
   ```json
   { "conversation_ids": ["group_<group_id>"] }
   ```
   → 获得 `max_seq`

2. `POST /msg/pull_msg_by_seq`
   ```json
   { "conversation_id": "group_<group_id>",
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

### 6.3 节点注册 & 激活（幂等）

```
POST /node/activate
Authorization: Bearer <hub_token>（管理员）
{ "node_server_addr": "http://...", "node_web_addr": "http://...", "code": "..." }
```

- `code` 即 `AppId`（32 字节随机，64 hex），由 Node Server 启动时生成
- Hub Server 以 `app_id = code` 做 UPSERT，支持幂等重试
- `admin_uid` 从 hub_token 提取并写入 nodes 表
- 激活包：AES-256-GCM，key = SHA-256(hex_decode(code))

### 6.4 节点 API（扩展字段）

`GET /nodes` 返回节点列表；`GET /nodes/:app_id` 返回单个节点，结构相同。每个节点包含：

```json
{
  "app_id": "...",
  "name": "科技快讯",
  "avatar": "...",
  "description": "...",
  "node_server_addr": "https://node.example.com:8080",
  "node_web_addr": "https://node.example.com",
  "admin_uid": "uid-abc123"
}
```

`admin_uid` 为激活该节点时的 Hub UID，Hub Web 用于判断当前登录用户是否为节点管理员（仅展示管理入口、允许访问 `/admin/nodes/:app_id`）。

---

## 七、Node Server 新增 API

| 接口 | 调用方 | 说明 |
|------|--------|------|
| `POST /node/activate?code=` | Hub Server | 接收激活数据，解密写入 config.json |
| `POST /node/init` | Node Web（管理员）| 设置公众号资料、创建 OpenIM 订阅群、通知 Hub Server 更新目录；需 app_uid == config.admin_app_uid |
| `POST /auth/token` | Node Web | `{ credential }` → `{ app_token, app_uid }` |
| `POST /auth/exchange` | Node Web | `{ app_token }` → `{ openim_token, openim_api_addr, group_id }` |

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
      admin/
        ActivatePage.tsx    # 节点激活（流程二）
        NodeAdminPage.tsx   # 节点资料管理（流程四）
    api/
      hub.ts          # Hub Server API（register、login、credential、nodes、activate、profile）
                      # Hub Web 不调用 Node Server，无 node.ts
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
      AuthGateway.tsx       # app_token → openim_token（无 UI）
      ArticleListPage.tsx
      ArticleDetailPage.tsx
      ErrorPage.tsx
    api/
      node.ts               # Node Server API：/auth/token（credential→app_token）+ /auth/exchange（app_token→openim_token）
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
| app_token 泄露（URL 分享）| AuthGateway 完成后立即 `replaceState` 清除 URL 参数 |
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
