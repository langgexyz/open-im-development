# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库结构

这是一个**多项目开发元仓库**，包含以下子项目（各自独立 Git 仓库）：

| 目录 | Module | 说明 |
|------|--------|------|
| `open-im-hub-proto/` | `github.com/langgexyz/open-im-hub-proto` | HubService gRPC proto 定义及生成代码 |
| `open-im-hub-server/` | `github.com/langgexyz/open-im-hub-server` | Hub Server（App Server）：中枢服务 |
| `open-im-node-server/` | `github.com/langgexyz/open-im-node-server` | Node Bridge：节点桥接服务 |
| `open-im-server/` | `github.com/openimsdk/open-im-server` | OpenIM 上游服务器（零改动使用） |
| `openim-sdk-core/` | `github.com/openimsdk/openim-sdk-core` | OpenIM SDK Core |
| `docs/superpowers/specs/` | — | 设计规范文档 |
| `docs/superpowers/plans/` | — | 实施计划（含任务清单） |

每个子目录是独立 Go module，需分别进入目录操作。

## 平台架构

这是一个**去中心化公众号平台**，基于 OpenIM 构建。核心设计文档：`docs/superpowers/specs/2026-03-20-decentralized-public-account-platform-design.md`

### 三个角色

- **Hub Server**（`open-im-hub-server`）：平台中枢，管理节点注册/准入、签发 session_sig、转发 APNs/FCM 推送
- **Node Bridge**（`open-im-node-server`）：节点运营者自托管，处理用户认证、账号管理，旁路一个原生 OpenIM 实例
- **App Client**（闭源）：持有硬编码的 Hub Server 公钥（信任根）

### 通信关系

```
App ──HTTP──→ Node Bridge ──gRPC──→ Hub Server
App ──WS────→ Node OpenIM
Node Bridge ──webhook←── Node OpenIM
Node Bridge ──Admin API──→ Node OpenIM
```

### 身份与信任链

- 所有密钥均为 EVM（secp256k1）密钥对
- Hub Server 用私钥签发 `session_sig` 和 `user_credential`
- 节点用 `node_private_key` 对所有发往 Hub Server 的 gRPC 请求签名（metadata: `x-node-public-key`、`x-node-timestamp`、`x-node-sig`）
- `user_token` 由节点签发，内含 `session_sig`，App 侧验证整条信任链

## 构建与测试命令

### open-im-hub-proto

```bash
cd open-im-hub-proto

# 重新生成 Go 代码（需安装 protoc）
protoc \
  --proto_path=. \
  --go_out=. --go_opt=paths=source_relative \
  --go-grpc_out=. --go-grpc_opt=paths=source_relative \
  hub/v1/hub.proto

go build ./...
go vet ./...
```

安装生成工具：
```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
# macOS: brew install protobuf
```

### open-im-hub-server

```bash
cd open-im-hub-server

go build ./...
go test ./...
go vet ./...

# 运行（必须环境变量）
HUB_PRIVATE_KEY=<hex> MYSQL_DSN=<dsn> go run ./cmd/server/main.go

# 生成新的 EVM 密钥对
go run ./tools/genkey/main.go
```

**必需环境变量：**
- `HUB_PRIVATE_KEY` — Hub Server EVM 私钥（hex，无 0x 前缀）
- `MYSQL_DSN` — MySQL 数据源

**可选环境变量：**
- `HUB_HTTP_ADDR`（默认 `:8080`）、`HUB_GRPC_ADDR`（默认 `:50051`）
- `APNS_KEY_FILE`、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_BUNDLE_ID`、`APNS_SANDBOX`
- `FCM_SERVER_KEY`

### open-im-node-server

```bash
cd open-im-node-server

go build ./...
go test ./...
go vet ./...

# 首次激活（生成密钥、注册节点、初始化数据库）
go run ./cmd/openim-node/main.go --activate <activation_code>

# 正常启动
go run ./cmd/openim-node/main.go

# 配置文件默认路径
# /data/config.json（可通过 --config 覆盖）
```

**config.json 关键字段：**
- `node_private_key` / `node_public_key` — 本地生成，私钥永不上传
- `hub_public_key` — 激活时由 Hub Server 返回，自动写入
- `hub_grpc_addr` — Hub Server gRPC 地址（如 `hub.example.com:50051`）
- `openim_admin_token` / `openim_api_addr` — 本节点 OpenIM 实例连接信息

### open-im-server（OpenIM 上游）

```bash
cd open-im-server

# 使用 Mage 构建系统
mage build          # 构建所有二进制（输出到 _output/）
mage start          # 启动所有服务
mage stop           # 停止所有服务
mage check          # 检查服务状态

go test ./...
go test ./pkg/common/storage/cache/redis/ -run TestBatch  # 单测
go test ./test/e2e/...  # E2E 测试
go vet ./...
```

## open-im-hub-server 代码结构

```
internal/
  config/     # 配置加载（环境变量）
  crypto/     # EVM 密钥操作（Sign、Ecrecover、PrivKeyFromHex）
  grpc/       # HubService gRPC 实现 + 节点签名拦截器
  handler/    # HTTP handler（credential 签发、device token、节点目录）
  push/       # APNs / FCM 推送实现
  server/     # HTTP 和 gRPC 服务启动
  store/      # MySQL 数据访问（nodes、codes、tokens 表）
tools/genkey/ # 生成 EVM 密钥对的 CLI 工具
```

gRPC 节点签名验证在 `internal/grpc/server.go` 的 unary interceptor 中统一处理，通过 `context.WithValue(ctx, nodeKey{}, node)` 将已验证的节点对象注入后续 handler。

## open-im-node-server 代码结构

```
internal/
  config/     # config.json 的加载与持久化
  crypto/     # EVM 密钥操作（与 hub-server 同构）
  handler/    # HTTP handler（activate、auth/token、auth/exchange、webhook）
  hub/        # HubService gRPC client，自动附加节点签名 metadata
  openim/     # OpenIM Admin API 客户端（注册用户、换取 token）
  server/     # Gin 路由注册 + 依赖注入
  store/      # MySQL accounts 表（GetOrCreate app_uid → node_uid）
  token/      # user_credential 验证 + user_token 签发/验证
```

## 关键数据流

### 用户订阅节点（首次）

1. App → `POST /auth/token`（携带 `user_credential`）
2. Bridge 从 credential 中提取 `app_uid`（由 Hub Server 签名保证真实性）
3. `accounts.GetOrCreate(app_uid)` → `node_uid`（MySQL auto-increment ID）
4. Bridge → Hub gRPC `SignSession`（携带节点签名 + user_credential）
5. Hub 签发 `session_sig`，Bridge 签发 `user_token`（内含 session_sig）
6. App 验证 user_token 和 session_sig 后连接节点 OpenIM

### 离线推送

1. OpenIM webhook `afterSendGroupMsg` → `POST /internal/after-group-msg`
2. Bridge 查在线状态，得到离线 node_uid 列表
3. 反查 accounts 表得到 app_uid 列表
4. Bridge → Hub gRPC `PushNotify` → Hub 转发 APNs/FCM

## 实施计划文件

`docs/superpowers/plans/` 下的计划文件使用 `- [ ]` 任务清单跟踪进度：
- `2026-03-20-hub-proto.md` — HubService proto 实现计划
- `2026-03-20-hub-server.md` — Hub Server 实现计划
- `2026-03-20-node-bridge-service.md` — Node Bridge 实现计划

执行计划时使用 `superpowers:executing-plans` 或 `superpowers:subagent-driven-development` skill。

## OpenIM Server 架构（供参考）

open-im-server 以**零改动**方式作为节点 OpenIM 实例运行。其架构：

- **部署模式**：微服务模式（各 binary 独立）或 standalone 模式（单进程）
- **核心服务**：openim-api（HTTP 网关）、openim-msggateway（WebSocket）、openim-msgtransfer（Kafka 消费）、openim-push（推送）
- **存储**：MongoDB（主存储）、Redis（缓存/序列号）、Kafka（消息队列）、etcd（服务发现）、MinIO（对象存储）
- **proto 定义**：在独立 repo `github.com/openimsdk/protocol`
- **配置**：`config/` 目录下 YAML 文件；`share.yml` 含共享密钥，各 `openim-*.yml` 为服务专属配置
