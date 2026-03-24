# open-im 去中心化节点协议设计文档

**日期**：2026-03-20
**状态**：草稿 v7（与前端设计文档同步更新）

---

## 一、概述

open-im 是一套**去中心化节点协议**，基于 OpenIM 构建。任何人可以自托管一个节点，节点接入协议网络后即可为其用户提供实时通信服务。协议本身不感知业务内容，公众号、招聘、社群、店铺等均可作为应用层构建于其上。

**两层架构**：

```
应用层  ──  公众号 / 招聘 / 店铺 / 社群 / ...（节点运营者自定义）
协议层  ──  Hub Server + Node Server + OpenIM（本文描述范围）
```

**协议核心职责**：
- **Hub Server**：协议的信任锚，负责节点准入、身份背书、推送基建；不感知业务内容
- **Node Server**：节点的协议网关，处理用户身份验证、账号体系、推送中转；业务逻辑由上层应用扩展
- **OpenIM**：节点内的实时通信引擎，零改动直接使用

**信任模型**：节点用 EVM 私钥向 Hub Server 证明身份，Hub Server 签发绑定 UID+AppId+exp 的 `credential`；Node Server 持有 `hub_public_key` 本地验证 credential；App/Web 客户端持有 Hub Server 公钥作为信任根，离线验证所有签名。

**架构取舍**：
- 实时在线推送通过节点 OpenIM WebSocket 送达（去中心化，Hub 不经手消息内容）
- 离线推送经由 Hub Server 转发 APNs/FCM（iOS/Android 平台限制，不可避免）

---

## 二、角色定义

### 2.1 Hub Server

协议的信任锚，职责严格限定于协议层：
- 节点注册与准入控制（双向打通激活流程）
- 节点心跳与在线状态管理
- 节点目录维护（供用户搜索发现）
- 用户凭证签发：用 `hub_private_key` 签发 `credential`，绑定 UID+AppId+exp
- 节点激活时生成 `app_private_key` / `app_public_key` 并加密下发给节点
- 推送基建（持有 APNs/FCM 证书，代理离线推送）
- 用户账号管理（注册、登录、UID 分配）

持有：`hub_private_key`（EVM 私钥），其对应公钥 `hub_public_key` 在节点激活时自动下发写入 `config.json`，App 客户端内硬编码此公钥作为信任根。

**对外暴露两个端口**：
- gRPC `:50051`：节点专用，所有 Node↔Hub 通信走此端口
- HTTP `:8080`：Web 客户端及 App 客户端专用（用户注册/登录、credential 签发、设备 token 注册、节点目录查询、节点激活管理）

**数据库**：MySQL

### 2.2 节点（Node）

由任意开发者/运营者自托管，由两个组件构成：
- **Node Server**（`open-im-node-server`）：协议网关，处理身份验证、账号管理、推送中转；通过 gRPC 与 Hub Server 通信
- **OpenIM 实例**：原生 OpenIM，零改动，提供实时 WebSocket 通信

节点是协议网络中的一个**自主服务单元**，完全控制自己的内容数据和用户账号。一个节点可以承载任意业务形态：
- 内容订阅（公众号/Newsletter）
- 招聘（职位发布 + 候选人管理）
- 社群（兴趣小组）
- 店铺（商品 + 客服）
- 其他任意 IM 场景

持有：
- `app_private_key`：EVM 私钥，由 Hub Server 在激活时生成并加密下发，写入 `config.json`，永不上传
- `app_public_key`：以太坊地址，由 Hub Server 生成，激活时同步写入 Hub Server nodes 表，用于验证节点 gRPC 请求签名

所有发往 Hub Server 的 gRPC 调用均通过 `NewNodeSignInterceptor` 自动附加签名 metadata（含 `app_public_key`），Hub Server 拦截器统一验证节点身份和授权状态。

**数据库**：MySQL（accounts 表，节点本地账号体系）

### 2.3 App / Hub Web（客户端）

接入协议网络的客户端，是整个信任链的执行者。内硬编码 `hub_public_key`（以太坊地址），用于离线验证 Hub Server 签名的 `credential` 和节点签发的 `app_token`。

原生移动 App 可以是通用协议客户端（支持接入任意节点），也可以是专用客户端（只接入特定业务类型的节点）。

**Hub Web** 是 Hub Server 的 Web 门户，承担用户注册/登录、节点广场浏览、订阅流程发起（获取 `credential` 并调用节点 `/auth/token`）以及节点激活管理等职责，是当前主要的客户端形态。

---

## 三、数据库设计

### 3.1 Hub Server MySQL 表

```sql
-- 节点注册信息
CREATE TABLE nodes (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id           VARCHAR(64) NOT NULL UNIQUE,
    app_public_key   VARCHAR(42) NOT NULL UNIQUE,   -- 节点以太坊地址
    name             VARCHAR(128) NOT NULL,
    avatar           VARCHAR(512),
    description      TEXT,
    node_server_addr VARCHAR(512),
    node_web_addr    VARCHAR(512),
    admin_uid        VARCHAR(64),
    status           TINYINT DEFAULT 1,              -- 1=正常, 0=禁用
    expires_at       TIMESTAMP NOT NULL,
    last_heartbeat   TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 一次性激活码
CREATE TABLE activation_codes (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code       VARCHAR(64) NOT NULL UNIQUE,
    used       BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户设备 token（APNs/FCM）
CREATE TABLE device_tokens (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uid        VARCHAR(64) NOT NULL,
    platform   TINYINT NOT NULL,                   -- 1=iOS, 2=Android
    token      VARCHAR(256) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_uid_platform (uid, platform)
);
```

### 3.2 Node Server MySQL 表（节点账号体系）

```sql
-- 节点账号表：每个接入用户在本节点的账号
-- id 即 app_uid，同时作为 OpenIM userID（存为字符串如 "10001"）
-- admin_app_uid 存储在 config.json，不以特殊账号行表示
CREATE TABLE accounts (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uid        VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 四、身份模型

### 4.1 三级 ID 体系

| ID | 类型 | 生成方 | 用途 |
|----|------|--------|------|
| `UID` | String | Hub Server | 用户在整个协议网络的全局唯一身份 |
| `AppId` | String | Hub Server（UUID）| 节点在协议网络的全局唯一标识，激活时生成并下发 |
| `app_uid` | uint64 | accounts 表 auto-increment | 用户在该节点的本地 ID，同时作为 OpenIM userID |

### 4.2 节点管理员账号

管理员完成流程三（账号在节点上初始化）后，Node Server 将返回的 `app_uid` 作为 `admin_app_uid` 写入 `config.json`。此后管理员专属接口直接比较 `app_uid == config.admin_app_uid`，无需在 accounts 表中维护特殊标记。

订阅群 ID 在流程四（公众号业务初始化）完成后由 OpenIM 创建群时返回，写入 `config.json`（字段 `subscription_group_id`），不使用固定值。

---

## 五、密钥与信任链

### 5.1 EVM 密钥体系

| 密钥 | 持有方 | 用途 |
|------|--------|------|
| `hub_private_key` | Hub Server | 签发 `credential`（绑定 UID+AppId+exp） |
| `hub_public_key` | App（硬编码）、节点 config.json（激活时写入）| Node Server / App 验证 credential |
| `app_private_key` | 节点 config.json | 由 Hub Server 在激活时生成并加密下发；签发 `app_token` |
| `app_public_key` | Hub Server nodes 表 | Hub Server 验证节点 gRPC 请求签名；节点身份标识 |

### 5.2 节点请求签名（Node → Hub Server，gRPC metadata）

所有节点发往 Hub Server 的 gRPC 调用均通过 `NewNodeSignInterceptor`（`internal/hub/client.go`）自动附加以下 metadata：

```
x-app-public-key   节点以太坊地址（app_public_key）
x-node-timestamp   Unix 秒级时间戳（字符串）
x-node-body-hash   hex(keccak256(proto.Marshal(req)))
x-app-sig          hex(Sign(keccak256(full_method || 0x00 || body_hash || 0x00 || timestamp), app_private_key))
```

其中 `full_method` 是 gRPC 完整方法名，如 `/hub.v1.HubService/Heartbeat`。

Hub Server 拦截器验证逻辑：
1. `ecrecover(keccak256(sigMsg), x-app-sig) == x-app-public-key` → 请求未被篡改
2. 查 nodes 表：`app_public_key` 存在且 `status=1` 且未过期 → 节点已授权
3. `|now - x-node-timestamp| ≤ 60s` → 防重放

### 5.3 Hub Server 用户凭证（credential）

```
credential = base64url({ "UID": "...", "AppId": "...", "exp": ... }) + "." + hex(sig)
sig = Sign(keccak256(base64url(payload)), hub_private_key)
```

Node Server 收到 credential 后，使用本地持有的 `hub_public_key` 自行验证签名，提取 `UID` 和 `AppId`，无需通过 gRPC 请求 Hub Server 验证。`AppId` 须与本节点的 `config.app_id` 匹配，防止跨节点重放。

### 5.4 节点 Token（app_token，节点签发）

```
app_token = base64url(payload) + "." + hex(sig)

payload = {
  "UID":      "...",
  "AppId":    "...",
  "app_uid": 10001,        // uint64，accounts.id
  "exp":      1234567890
}

sig = Sign(keccak256(base64url(payload)), app_private_key)
```

### 5.5 验证职责分工

**App / Hub Web 侧（信任根）**：
1. `ecrecover(app_token.sig) == app_public_key` → Token 是该节点签发的
2. Token 未过期

**Node Server 侧**：
1. `ecrecover(app_token.sig) == app_public_key`（本节点）→ Token 未被篡改
2. Token 未过期

| 攻击场景 | 防御方 | 机制 |
|---------|--------|------|
| 未授权节点接入 | Hub Server | 节点 `app_public_key` 未在 nodes 表注册则 gRPC 请求被拒绝 |
| 节点被撤销后继续服务 | Hub Server | gRPC 拦截器验证 `status=1`，禁用节点请求被拒绝 |
| 伪造 app_token | Node Server | ecrecover 必须等于本节点 `app_public_key` |
| 跨节点 Token 重放 | Node Server / App | credential 绑定了 `AppId`，Node 校验匹配；app_token 含 AppId |
| 用户冒充他人 UID | Node Server | UID 从 Hub Server 签名的 credential 中提取，本地验签保证真实性 |
| 节点请求被重放 | Hub Server | `x-node-timestamp` 校验 ±60s |

---

## 六、核心流程

### 6.1 节点注册（一次性）

```
1. 节点运营者启动 Node Server：
   → Node Server 生成随机 64 字符 hex code（32 字节随机值，存内存，一次性）
   → 仅暴露 POST /node/activate?code= 端点，等待激活
   → 管理员从启动日志获取 code

2. 管理员在 Hub Web /admin/activate 填写：
   node_server_addr、node_web_addr、code
   → Hub Server 探活：GET node_server_addr/health → 200 OK
   → Hub Server 生成：AppId、app_private_key、app_public_key
   → Hub Server 写入 nodes 表：{ AppId, app_public_key, node_server_addr, node_web_addr, admin_uid（来自 hub_token） }

3. Hub Server → Node Server：
   POST node_server_addr/node/activate?code=xxxx
   Body：AES-256-GCM(key=SHA-256(hex_decode(code))) 加密 {
       AppId, app_private_key, app_public_key,
       hub_server_addr, hub_public_key, hub_web_origin
   }
   → Node Server 解密，写入 config.json，code 立即失效

✅ 双向打通：Hub 存有 node_server_addr + node_web_addr，Node 存有 hub_server_addr + hub_web_origin

4. 管理员完成流程三（账号初始化）和流程四（业务初始化）via Hub Web
```

### 6.2 节点心跳（Node Server 启动后持续）

```
Node Server 启动 → 立即发送，之后每 30s 一次：

gRPC Heartbeat（x-app-* metadata 自动附加）
  Request: { app_public_key, node_server_addr }

Hub Server 验证签名 + 授权状态 → 更新 last_heartbeat
若节点被禁用 → gRPC 返回错误，Node Server 记录告警日志
```

### 6.3 用户接入节点（开户 + credential 验证）

```
1. Hub Web → Hub Server：POST /user/credential { uid, target_app_id }
   Authorization: Bearer <hub_token>
   → Hub Server 用 hub_private_key 签发 credential（绑定 UID + AppId + exp）
   → 返回 { credential }

2. Hub Web → Node Server：POST /auth/token { credential }

3. Node Server 用本地 hub_public_key 验签 credential，校验 AppId 匹配本节点
   → 提取 UID

4. Node Server 在 accounts 表 GetOrCreate(UID) → app_uid

5. Node Server 在 OpenIM 注册 app_uid（幂等），加入订阅群（config.subscription_group_id）

6. Node Server 用 app_private_key 签发 app_token

7. 返回 { app_token, app_uid } 给 Hub Web
```

### 6.4 连接节点 OpenIM

```
1. Node Web / App → Node Server：POST /auth/exchange { app_token }
2. Node Server 验证 app_token（ecrecover == app_public_key，未过期）
3. Node Server 调 OpenIM Admin API → 换取 OpenIM 原生 token
4. 返回 { openim_token, openim_api_addr, group_id }
5. 客户端用 openim_token 连接节点 msggateway WebSocket 或调用 OpenIM API
```

### 6.5 消息推送

```
节点运营者（或业务逻辑）发布群组消息
    ↓
OpenIM 实时送达在线用户（Hub 不经手消息内容）
    ↓
Node Server webhook（afterSendGroupMsg）触发
    ↓
Node Server 查群成员 + 在线状态 → 得到离线 app_uid 列表
    ↓
SELECT uid FROM accounts WHERE id IN (...)
    ↓
gRPC PushNotify（x-app-* metadata 自动附加，分批 1000 条）
  Request: { uids: [...], title, body, data_json }
    ↓
Hub Server 验证节点签名 + 授权状态 → APNs / FCM
```

---

## 七、应用层示例

协议层不感知业务内容。以下为典型应用场景，均由节点运营者在 Node Server 之上扩展实现：

| 应用场景 | OpenIM 群组用途 | 节点运营者角色 |
|---------|----------------|--------------|
| **公众号**（如 X信）| 内容频道（订阅者禁言）| 博主/内容创作者 |
| **招聘**| 职位频道 + 候选人私聊 | 招聘方/HR |
| **社群** | 双向讨论群 | 社群管理员 |
| **店铺** | 商品通知 + 客服单聊 | 商家 |

协议层提供的能力（`/auth/token`、`/auth/exchange`、推送中转）对所有应用场景通用，无需修改。

---

## 八、节点发现

| 方式 | 说明 |
|------|------|
| Hub Server 官方目录 | `GET /nodes`（HTTP :8080），节点注册元数据可搜索，AppId 由 Hub Server 保证唯一 |
| 手动输入节点 URL | `GET /node/info` 返回 `app_public_key` + `AppId`，App 首次连接后锁定节点身份 |

---

## 九、接口总览

### 9.1 Node Server HTTP 接口

| 接口 | 调用方 | 用途 |
|------|--------|------|
| `GET  /node/info` | App / Hub Web | 节点元数据、app_public_key |
| `POST /node/activate?code=` | Hub Server | 接收激活数据，解密写入 config.json |
| `POST /auth/token` | Hub Web | credential → app_token + app_uid |
| `POST /auth/exchange` | Node Web / App | app_token → `{ openim_token, openim_api_addr, group_id }` |
| `POST /internal/after-group-msg` | OpenIM（内网）| webhook 触发推送 |

### 9.2 Hub Server gRPC 接口（Node 调用，`:50051`）

所有方法均需 `x-app-*` 签名 metadata，Hub Server 拦截器统一验证。

| gRPC 方法 | metadata 鉴权 | 用途 |
|-----------|--------------|------|
| `Heartbeat` | x-app-sig | 节点保活 |
| `PushNotify` | x-app-sig | 离线推送转发 |

### 9.3 Hub Server HTTP 接口（`:8080`）

| 接口 | 调用方 | 用途 |
|------|--------|------|
| `POST /user/register` | Hub Web | 邮箱注册，返回 `{ UID, hub_token }` |
| `POST /user/login` | Hub Web | 邮箱登录，返回 `{ UID, hub_token }` |
| `POST /user/credential` | Hub Web | 签发 credential（UID+AppId+exp） |
| `POST /node/activate` | Hub Web（管理员）| 触发节点激活流程 |
| `POST /node/profile` | Hub Web（管理员）| 设置节点公众号资料 |
| `GET  /nodes` | Hub Web / App | 节点目录 |
| `POST /user/device-token` | App | 注册 APNs/FCM 设备 token |

---

## 十、部署结构

```yaml
# 工程仓库
# open-im-node-server: https://github.com/langgexyz/open-im-node-server
# open-im-hub-server:  https://github.com/langgexyz/open-im-hub-server
# open-im-hub-proto:   https://github.com/langgexyz/open-im-hub-proto

# Node 部署示例（节点运营者自托管）
services:
  node-server:
    image: ghcr.io/langgexyz/open-im-node-server:latest
    volumes:
      - ./data:/data          # config.json 持久化
    ports:
      - "8080:8080"
    environment:
      - MYSQL_DSN=${MYSQL_DSN}
      - OPENIM_ADMIN_TOKEN=${OPENIM_ADMIN_TOKEN}
      - OPENIM_API_ADDR=http://openim:10002

  mysql:
    image: mysql:8.0
    volumes:
      - ./mysql-data:/var/lib/mysql

  openim:
    image: openim/openim-server:latest
```

---

## 十一、范围外（待后续设计）

- App 客户端 UI/UX
- Hub Server 计费与节点授权管理
- 节点授权过期续费流程
- 推送批量队列化
- 跨节点消息联合（Federation）
- 应用层扩展 SDK（方便节点运营者快速构建业务逻辑）
