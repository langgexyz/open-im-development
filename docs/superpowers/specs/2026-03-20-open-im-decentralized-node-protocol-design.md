# open-im 去中心化节点协议设计文档

**日期**：2026-03-20
**状态**：草稿 v6（概念重定位：协议层 + 应用层分离）

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

**信任模型**：节点用 EVM 私钥向 Hub Server 证明身份，Hub Server 动态签名授权用户接入节点；App 客户端持有 Hub Server 公钥作为信任根，离线验证所有签名。

**架构取舍**：
- 实时在线推送通过节点 OpenIM WebSocket 送达（去中心化，Hub 不经手消息内容）
- 离线推送经由 Hub Server 转发 APNs/FCM（iOS/Android 平台限制，不可避免）

---

## 二、角色定义

### 2.1 Hub Server

协议的信任锚，职责严格限定于协议层：
- 节点注册与准入控制（发放激活码、可随时撤销）
- 节点心跳与在线状态管理
- 节点目录维护（供 App 搜索发现）
- 动态签名授权（用户接入节点时签发 session_sig）
- 推送基建（持有 APNs/FCM 证书，代理离线推送）
- 用户凭证签发（hub_private_key 签名，与具体应用无关）

持有：`hub_private_key`（EVM 私钥），其对应公钥 `hub_public_key` 在节点激活时自动下发写入 `config.json`，App 客户端内硬编码此公钥作为信任根。

**对外暴露两个端口**：
- gRPC `:50051`：节点专用，所有 Node↔Hub 通信走此端口
- HTTP `:8080`：App 客户端专用（设备 token 注册、节点目录查询）

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
- `node_private_key`：EVM 私钥，本地生成，永不上传
- `node_public_key`：以太坊地址，注册时通过 gRPC Activate 提交给 Hub Server

所有发往 Hub Server 的 gRPC 调用均通过 `NewNodeSignInterceptor` 自动附加签名 metadata，Hub Server 拦截器统一验证节点身份和授权状态。

**数据库**：MySQL（accounts 表，节点本地账号体系）

### 2.3 App（客户端）

接入协议网络的客户端，是整个信任链的执行者。内硬编码 `hub_public_key`（以太坊地址），用于离线验证 Hub Server 的动态签名。

App 可以是通用协议客户端（支持接入任意节点），也可以是专用客户端（只接入特定业务类型的节点）。

---

## 三、数据库设计

### 3.1 Hub Server MySQL 表

```sql
-- 节点注册信息
CREATE TABLE nodes (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_id          VARCHAR(64) NOT NULL UNIQUE,
    node_public_key VARCHAR(42) NOT NULL UNIQUE,   -- 节点以太坊地址
    name            VARCHAR(128) NOT NULL,
    avatar          VARCHAR(512),
    description     TEXT,
    ws_addr         VARCHAR(512) NOT NULL,
    status          TINYINT DEFAULT 1,              -- 1=正常, 0=禁用
    expires_at      TIMESTAMP NOT NULL,
    last_heartbeat  TIMESTAMP,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    app_uid    VARCHAR(64) NOT NULL,
    platform   TINYINT NOT NULL,                   -- 1=iOS, 2=Android
    token      VARCHAR(256) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_uid_platform (app_uid, platform)
);
```

### 3.2 Node Server MySQL 表（节点账号体系）

```sql
-- 节点账号表：每个接入用户在本节点的账号
-- id 即 node_uid，同时作为 OpenIM userID（存为字符串如 "10001"）
-- app_uid = '__node_owner__' 保留给节点运营者
CREATE TABLE accounts (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    app_uid    VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 四、身份模型

### 4.1 三级 ID 体系

| ID | 类型 | 生成方 | 用途 |
|----|------|--------|------|
| `app_uid` | String | Hub Server | 用户在整个协议网络的全局唯一身份 |
| `app_id` | String | Hub Server（UUID）| 节点在协议网络的全局唯一标识，激活时下发 |
| `node_uid` | uint64 | accounts 表 auto-increment | 用户在该节点的本地 ID，同时作为 OpenIM userID |

### 4.2 节点运营者账号

激活时预插入 accounts 表：

```sql
INSERT INTO accounts (app_uid) VALUES ('__node_owner__');
-- 返回 id 即 owner_node_uid
```

`owner_node_uid` 不存入 config.json，运行时按需查询：

```sql
SELECT id FROM accounts WHERE app_uid = '__node_owner__'
```

应用层默认群组 ID 固定使用 `app_id`，无需额外存储。

---

## 五、密钥与信任链

### 5.1 EVM 密钥体系

| 密钥 | 持有方 | 用途 |
|------|--------|------|
| `hub_private_key` | Hub Server | 签发 session_sig（动态授权）、签发 user_credential |
| `hub_public_key` | App（硬编码）、节点 config.json（激活时自动写入）| App 验证 session_sig；节点验证 user_credential |
| `node_private_key` | 节点 config.json | 签名发往 Hub Server 的所有 gRPC 请求；签发 user_token |
| `node_public_key` | Hub Server nodes 表 | Hub Server 验证节点请求签名；节点身份标识 |

### 5.2 节点请求签名（Node → Hub Server，gRPC metadata）

所有节点发往 Hub Server 的 gRPC 调用均通过 `NewNodeSignInterceptor`（`internal/hub/client.go`）自动附加以下 metadata：

```
x-node-public-key  节点以太坊地址
x-node-timestamp   Unix 秒级时间戳（字符串）
x-node-body-hash   hex(keccak256(proto.Marshal(req)))
x-node-sig         hex(Sign(keccak256(full_method || 0x00 || body_hash || 0x00 || timestamp), node_private_key))
```

其中 `full_method` 是 gRPC 完整方法名，如 `/hub.v1.HubService/Heartbeat`。

Hub Server 拦截器验证逻辑：
1. `ecrecover(keccak256(sigMsg), x-node-sig) == x-node-public-key` → 请求未被篡改
2. 查 nodes 表：`node_public_key` 存在且 `status=1` 且未过期 → 节点已授权
3. `|now - x-node-timestamp| ≤ 60s` → 防重放

**例外**：`Activate` 方法跳过上述签名验证，改为验证 `x-activation-code` metadata（激活码一次性消费）。

### 5.3 动态 session_sig（Hub Server → 用户）

用户接入节点时，Hub Server 动态签发：

```
session_sig = Sign(
    keccak256(node_public_key || 0x00 || app_uid || 0x00 || expiry),
    hub_private_key
)
```

App 客户端验证：
```
ecrecover(session_sig) == hub_public_key  → 此用户被 Hub Server 授权接入此节点
```

### 5.4 Hub Server 用户凭证

```
user_credential = base64url({ "app_uid": "...", "exp": ... }) + "." + hex(sig)
sig = Sign(keccak256(base64url(payload)), hub_private_key)
```

Node Server 将 user_credential 通过 gRPC SignSession 转交给 Hub Server 验证，Hub Server 提取 `app_uid` 并签发 session_sig，Node Server 无需自行解析凭证。

### 5.5 用户 Token（节点签发）

```
user_token = base64url(payload) + "." + hex(sig)

payload = {
  "app_uid":     "...",
  "app_id":      "...",
  "node_uid":    10001,        // uint64，accounts.id
  "session_sig": "0x...",      // Hub Server 动态签发（绑定 node_public_key + app_uid）
  "exp":         1234567890
}

sig = Sign(keccak256(base64url(payload)), node_private_key)
```

### 5.6 验证职责分工

**App 侧（闭源，信任根）**：
1. `ecrecover(user_token.sig) == node_public_key` → Token 是该节点签发的
2. `ecrecover(session_sig) == hub_public_key` → Hub Server 授权了该用户接入该节点
3. `session_sig` 绑定了 `node_public_key + app_uid`，防跨节点重放
4. Token 未过期

**Node Server 侧**：
1. `ecrecover(user_token.sig) == node_public_key`（本节点）→ Token 未被篡改
2. Token 未过期

| 攻击场景 | 防御方 | 机制 |
|---------|--------|------|
| 未授权节点接入 | App（闭源）| session_sig 需要 Hub Server 签名，未授权节点无法获得 |
| 节点被撤销后继续服务 | Hub Server | 拒绝为被禁用节点签发 session_sig（gRPC 拦截器验证 status）|
| 伪造 user_token | Node Server | ecrecover 必须等于本节点公钥 |
| 跨节点 Token 重放 | App | session_sig 绑定了 node_public_key |
| 用户冒充他人 app_uid | Node Server | app_uid 从 Hub Server 签名凭证中提取（gRPC SignSession）|
| 节点请求被重放 | Hub Server | x-node-timestamp 校验 ±60s |

---

## 六、核心流程

### 6.1 节点注册（一次性）

```
1. 节点运营者从 Hub Server 获得激活码
2. Node Server 首次启动（--activate <code> 模式）：
   a. 本地生成 EVM keypair（node_private_key / node_public_key）
   b. 连接 Hub Server gRPC（HUB_GRPC_ADDR）
   c. 调用 gRPC Activate（x-activation-code metadata 携带激活码，跳过 node-sig 验证）
      Request: { node_public_key, node_ws_addr }
   d. Hub Server 验证激活码（原子消费），写入 nodes 表，分配 UUID app_id
   e. 返回 { app_id, hub_public_key }
   f. Node Server 初始化 MySQL，预插入运营者账号（app_uid='__node_owner__'）
   g. 在 OpenIM 创建默认群组（group_id = app_id）
   h. 持久化 config.json（含 hub_public_key，自动写入，无需手动配置）
```

### 6.2 节点心跳（Node Server 启动后持续）

```
Node Server 启动 → 立即发送，之后每 30s 一次：

gRPC Heartbeat（x-node-* metadata 自动附加）
  Request: { node_public_key, ws_addr }

Hub Server 验证签名 + 授权状态 → 更新 last_heartbeat
若节点被禁用 → gRPC 返回错误，Node Server 记录告警日志
```

### 6.3 用户接入节点（开户 + 动态签名）

```
1. App 持有 user_credential（由 Hub Server 签发）
2. App → Node Server：POST /auth/token
       Authorization: Bearer <user_credential>
3. Node Server 调用 gRPC SignSession（x-node-* metadata 自动附加）
       Request: { user_credential, expiry }
4. Hub Server 验证 node 签名 + 节点授权状态 → 验证 user_credential → 签发 session_sig
   返回 { session_sig, app_uid }
5. Node Server 在 accounts 表 GetOrCreate(app_uid) → node_uid
6. Node Server 在 OpenIM 注册 node_uid（幂等）
7. Node Server 签发 user_token（含 session_sig）
8. 返回 { user_token, node_public_key } 给 App
9. App 验证 user_token 和 session_sig（见 5.6）
```

### 6.4 连接节点 OpenIM

```
1. App → Node Server：POST /auth/exchange { user_token }
2. Node Server 验证 user_token
3. Node Server 调 OpenIM Admin API → 换取 OpenIM 原生 token
4. 返回 { openim_token, node_uid }
5. App 用 openim_token 连接节点 msggateway WebSocket
```

### 6.5 消息推送

```
节点运营者（或业务逻辑）发布群组消息
    ↓
OpenIM 实时送达在线用户（Hub 不经手消息内容）
    ↓
Node Server webhook（afterSendGroupMsg）触发
    ↓
Node Server 查群成员 + 在线状态 → 得到离线 node_uid 列表
    ↓
SELECT app_uid FROM accounts WHERE id IN (...)
    ↓
gRPC PushNotify（x-node-* metadata 自动附加，分批 1000 条）
  Request: { app_uids: [...], title, body, data_json }
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
| Hub Server 官方目录 | `GET /nodes`（HTTP :8080），节点注册元数据可搜索，app_id 由 Hub Server 保证唯一 |
| 手动输入节点 URL | `GET /node/info` 返回 node_public_key + app_id，App 首次连接后锁定节点身份 |

---

## 九、接口总览

### 9.1 Node Server HTTP 接口（App 调用）

| 接口 | 用途 |
|------|------|
| `GET  /node/info` | 节点元数据、node_public_key |
| `POST /auth/token` | 验证凭证、开户、请求 session_sig、签发 user_token |
| `POST /auth/exchange` | user_token → OpenIM 原生 token |
| `POST /internal/after-group-msg` | OpenIM webhook 触发推送（仅内网）|

### 9.2 Hub Server gRPC 接口（Node 调用，`:50051`）

所有方法（除 Activate）均需 x-node-* 签名 metadata，Hub Server 拦截器统一验证。

| gRPC 方法 | metadata 鉴权 | 用途 |
|-----------|--------------|------|
| `Activate` | x-activation-code | 节点注册（一次性）|
| `Heartbeat` | x-node-sig | 节点保活 |
| `SignSession` | x-node-sig | 验证 user_credential + 签发 session_sig |
| `PushNotify` | x-node-sig | 离线推送转发 |

### 9.3 Hub Server HTTP 接口（App 调用，`:8080`）

| 接口 | 用途 |
|------|------|
| `GET  /nodes` | 节点目录 |
| `POST /user/device-token` | 注册 APNs/FCM 设备 token |

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
