# 公众号服务设计文档

**日期**：2026-03-20
**状态**：草稿 v4（与前端设计文档同步更新）
**仓库**：`github.com/langgexyz/open-im-official-account-service`

---

## 一、概述

公众号服务是构建于 open-im 去中心化节点协议之上的第一个应用层微服务。节点运营者通过该服务向订阅者发布图文文章。文章封面、标题、摘要以 OpenIM Custom Message 形式发送到订阅群组，文章正文通过 OpenIM 文件上传 API 存储到 OSS。

**核心设计原则**：
- 消息即存储，无独立数据库
- 复用 OpenIM 现有能力（消息发送、文件存储）
- 通过 Node Server 网关统一鉴权，服务本身不处理身份验证
- **部署即授权**：能部署节点的人即运营者，无需代码层面的角色校验

---

## 二、架构

### 2.1 整体结构

```
外网
  ↓
Node Server :8080（API Gateway）
  ├── /auth/*、/node/info、/node/activate   → 自身处理
  └── /biz/*                               → 验证 node_token
                                              注入 X-UID、X-Node-UID
                                              etcd 查询后端地址
                                              httputil.ReverseProxy 转发

etcd（OpenIM 现有部署）
  └── /open-im/biz/articles → http://127.0.0.1:8081

内网（仅本机可达，不对外暴露）
  └── 公众号服务 :8081
        └── POST /biz/articles/publish

公众号服务对外调用
  ├── OpenIM 文件上传 API  → 上传正文内容，返回 content_url
  └── OpenIM Admin API    → 向订阅群（config.subscription_group_id）发送 Custom Message
```

### 2.2 角色关系

| 角色 | 说明 |
|------|------|
| Node Server | API Gateway，负责 token 验证与请求转发，不感知业务内容 |
| 公众号服务 | 业务微服务，处理文章发布逻辑，只接受来自网关的内网请求 |
| etcd | 服务注册与发现，复用 OpenIM 现有 etcd 实例 |
| OpenIM | 提供消息发送与文件存储能力，不修改 |

### 2.3 权限模型

**部署即授权**。`open-im-official-account-service` 与 `open-im-node-server` 由同一运营者部署，Node Server 网关只校验 node_token 合法性（确认是本节点的合法用户），不区分角色。发布权限由部署边界保证，无需代码层面的角色判断。

---

## 三、节点激活流程

激活流程为**基于 Hub Web 的 Web 激活流程**，运营者通过浏览器在 Hub Web 完成激活，无需手动操作命令行。

### 3.1 流程

```
1. 管理员启动 Node Server（未激活状态）
   → Node Server 生成随机 code（64 字符 hex，即 32 字节随机值，存内存，一次性，从启动日志获取）
   → 仅暴露 POST /node/activate?code= 端点

2. 管理员在 Hub Web /admin/activate 填写：node_server_addr、node_web_addr（仅 origin）、code
   → Hub Server 探活：GET node_server_addr/health → 200 OK
   → Hub 生成：AppId、app_private_key、app_public_key
   → Hub 写入 nodes 表：{ AppId, app_public_key, node_server_addr, node_web_addr, admin_uid }

3. Hub → Node：POST node_server_addr/node/activate?code=xxxx
   Body：AES-256-GCM(key=SHA-256(hex_decode(code))) 加密
         { AppId, app_private_key, app_public_key, hub_server_addr, hub_public_key, hub_web_origin }
   → Node 解密写入 config.json，code 立即失效

4. 管理员完成账号初始化（流程三）：
   Hub Web → Hub Server POST /user/credential → Node Server POST /auth/token
   → admin_node_uid 写入 config.json

5. 管理员设置公众号资料（流程四）：
   Hub Web → Hub Server POST /node/profile → Node Server POST /node/init
   → Node 创建订阅群（owner = admin_node_uid）
   → OpenIM 返回实际 group_id → 写入 config.json（subscription_group_id）
```

### 3.2 安全说明

| 机制 | 说明 |
|------|------|
| code 一次性 | 激活完成后立即失效，防止重放 |
| AES 加密传输 | AES-256-GCM，key = SHA-256(hex_decode(code))，code 为 64 字符 hex；app_private_key 在传输中加密，Hub Server 下发后不保留私钥 |
| 探活验证 | Hub Server 主动连接节点 URL，确认节点真实可达后才注册 |
| code 不落盘 | Node Server 启动时内存生成，激活前服务器重启需重新激活 |

---

## 四、订阅群生命周期

| 时机 | 操作 | 执行方 |
|------|------|--------|
| 节点激活完成（流程四） | 创建订阅群，group_id 由 OpenIM 分配，写入 config.json（`subscription_group_id`），运营者为群主 | Node Server |
| 用户首次 `POST /auth/token` | GetOrCreate 账号后，调 OpenIM Admin API 将用户加入订阅群（`config.subscription_group_id`） | Node Server |
| 发布文章时 | 向订阅群（`config.subscription_group_id`）发送 Custom Message，群内所有成员自动收到 | 公众号服务 |

用户入群通过 OpenIM 加群 API 实现，无需单独的订阅接口。

---

## 五、接口定义

### 5.1 节点激活（Node Server，Hub Server 调用）

```
POST /node/activate?code=xxxx

请求体（application/octet-stream）：
  AES-256-GCM(key=SHA-256(hex_decode(code))) 加密的 JSON：
  {
    "app_private_key":  "...",
    "app_public_key":   "...",
    "app_id":           "...",
    "hub_public_key":   "...",
    "hub_server_addr":  "...",
    "hub_web_origin":   "..."
  }

响应：
  200 OK    激活成功
  400       code 不匹配或解密失败
  409       节点已激活
```

### 5.2 发布文章（公众号服务，App 调用）

```
POST /biz/articles/publish
Authorization: Bearer <node_token>（由 Node Server 网关验证）

请求体（multipart/form-data）：
  title      string   文章标题
  summary    string   文章摘要
  cover      file     封面图文件
  content    file     正文内容文件（HTML 或 Markdown）

响应：
{
  "msg_id": "..."   // OpenIM 消息 ID
}
```

封面图与正文均由服务端上传到 OpenIM OSS，客户端不传 URL。

网关注入请求头（可用于日志/审计）：
- `X-UID`：用户在协议网络的全局 ID
- `X-Node-UID`：用户在本节点的本地 ID

### 5.3 文章列表与详情（无需服务端接口）

App 直接调用 OpenIM 消息 API：
- **列表**：查询订阅群（`subscription_group_id`，由 `/auth/exchange` 返回）消息历史，过滤 `content_type` 为 `article` 的 Custom Message
- **详情**：从消息体中取 `content_url`，直接加载正文内容

---

## 六、数据流

### 6.1 发布文章

```
1. App → POST /biz/articles/publish（携带 node_token + 文章文件）
2. Node Server 验证 node_token
   - 验证失败 → 返回 401
   - 验证通过 → 注入 X-UID、X-Node-UID → etcd 查地址 → 转发
3. 公众号服务：
   a. 调 OpenIM 文件上传 API 上传封面图 → 得到 cover_url
   b. 调 OpenIM 文件上传 API 上传正文文件 → 得到 content_url
   c. 调 OpenIM Admin API，向订阅群（config.subscription_group_id）发 Custom Message：
      {
        "content_type": "article",
        "title":        "...",
        "cover_url":    "...",
        "summary":      "...",
        "content_url":  "..."
      }
   d. 返回 { "msg_id": "..." } 给 App
```

### 6.2 读取文章（App 侧，无需经过公众号服务）

```
1. App 调 OpenIM 群消息历史 API → 获取 article 类型消息列表
2. App 选择某条消息 → 取 content_url → 直接 HTTP GET 加载正文
```

---

## 七、Node Server 改动（最小范围）

### 7.1 激活相关（新增）

- `POST /node/activate`：接收 Hub Server 下发的加密激活数据，解密后写入 config.json，完成初始化
- 启动时若 config.json 不含 `app_private_key`，进入未激活状态，仅暴露 `/node/activate` 端点

### 7.2 `internal/registry/`（新增）

etcd 服务发现客户端：
- 激活完成后启动，订阅 `/open-im/biz/` 前缀
- 维护内存路由表，key 为 path prefix，value 为后端地址

etcd key 格式与路由规则：

```
etcd key:   /open-im/biz/articles
etcd value: http://127.0.0.1:8081

路由匹配规则：
  请求路径 /biz/articles/publish
  → 取 /biz/ 后的第一段：articles
  → 查路由表：/open-im/biz/articles → http://127.0.0.1:8081
  → 转发到 http://127.0.0.1:8081/biz/articles/publish
```

### 7.3 `internal/gateway/`（新增）

`/biz/*` 路由处理：
1. 验证 node_token（复用现有 `internal/token` 逻辑）
2. 验证通过 → 注入 `X-UID`、`X-Node-UID` 请求头
3. 按路径第一段查路由表取后端地址 → `httputil.ReverseProxy` 转发
4. 路由表中无对应服务 → 返回 404

```go
router.Any("/biz/*path", gateway.AuthMiddleware(), gateway.ProxyHandler())
```

新增配置项：`ETCD_ADDR`（etcd 不可用时 `/biz/*` 返回 503，现有路由不受影响）

现有路由（`/auth/*`、`/node/info`、`/internal/*`）**不做任何改动**。

---

## 八、公众号服务结构

```
open-im-official-account-service/
  cmd/server/main.go        # 启动入口，向 etcd 注册服务
  internal/
    config/                 # 配置加载（环境变量）
    handler/                # POST /biz/articles/publish
    openim/                 # OpenIM API 客户端（文件上传、发消息）
    registry/               # etcd 服务注册
    server/                 # Gin 路由初始化
```

### 配置项（环境变量）

| 变量 | 说明 |
|------|------|
| `OPENIM_API_ADDR` | 节点 OpenIM HTTP 地址 |
| `OPENIM_ADMIN_TOKEN` | OpenIM Admin Token |
| `ETCD_ADDR` | etcd 地址 |
| `APP_ID` | 本节点 AppId，与 Node Server config.json 中 `AppId` 相同，节点激活后统一通过 `.env` 注入 |
| `LISTEN_ADDR` | 监听地址（默认 `127.0.0.1:8081`）|

### 服务注册（启动时）

```
etcd key:   /open-im/biz/articles
etcd value: http://127.0.0.1:8081
```

---

## 九、OpenIM Custom Message 格式

```json
{
  "content_type": "article",
  "title":        "文章标题",
  "cover_url":    "https://oss.example.com/covers/xxx.jpg",
  "summary":      "文章摘要，不超过 200 字",
  "content_url":  "https://oss.example.com/articles/xxx.html"
}
```

App 侧根据 `content_type == "article"` 识别并渲染文章卡片。

---

## 十、部署

节点激活后，`APP_ID` 从 Node Server config.json 中获取，与公众号服务共享同一份 `.env`：

```yaml
services:
  node-server:
    image: ghcr.io/langgexyz/open-im-node-server:latest
    network_mode: host
    volumes:
      - ./data:/data
    environment:
      - MYSQL_DSN=${MYSQL_DSN}
      - OPENIM_API_ADDR=http://127.0.0.1:10002
      - OPENIM_ADMIN_TOKEN=${OPENIM_ADMIN_TOKEN}
      - ETCD_ADDR=127.0.0.1:2379

  official-account:
    image: ghcr.io/langgexyz/open-im-official-account-service:latest
    network_mode: host
    environment:
      - OPENIM_API_ADDR=http://127.0.0.1:10002
      - OPENIM_ADMIN_TOKEN=${OPENIM_ADMIN_TOKEN}
      - ETCD_ADDR=127.0.0.1:2379
      - APP_ID=${APP_ID}       # 节点激活后填入
      - LISTEN_ADDR=127.0.0.1:8081
```

---

## 十一、范围外（待后续设计）

- 文章编辑与删除
- 草稿功能
- 阅读数统计
- 富文本编辑器（App 侧）
- 多媒体附件（视频、音频）
- 多作者/协作发布
- Hub Web /admin/activate 激活页面的具体实现（属于 hub-web 设计范围）
- Node Server `/auth/token` 流程中加入订阅群的具体实现（属于 node-server 设计范围）
