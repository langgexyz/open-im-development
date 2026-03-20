# openim-node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Node Server（`open-im-node-server`）——一个轻量 Go 二进制，处理 EVM 签名验证、用户 Token 签发、节点账号管理（MySQL）、OpenIM Token 换取和推送中转。

**Architecture:** Node Server 是 OpenIM 前的身份代理层。节点账号体系存于 Node Server 的 MySQL `accounts` 表（auto-increment id 即 OpenIM userID）。App 先向 Node Server 获取 user_token，再换取 OpenIM 原生 token，最后直连 msggateway。推送时 Node Server 查 OpenIM 在线状态后，从 accounts 表反查 app_uid，再通过 gRPC PushNotify 批量转发给 Hub Server。

**Tech Stack:** Go 1.21+, `github.com/ethereum/go-ethereum/crypto`（secp256k1）, `github.com/go-sql-driver/mysql`（MySQL 驱动）, `github.com/gin-gonic/gin`（HTTP 框架）, `google.golang.org/grpc`（gRPC 客户端）, `github.com/langgexyz/open-im-hub-proto`（HubService proto）

**Spec:** `docs/superpowers/specs/2026-03-20-open-im-decentralized-node-protocol-design.md`

**注意：本计划只覆盖 Node Server。Hub Server 是独立计划（`2026-03-20-hub-server.md`）。**

> **独立工程**：openim-node 是节点运营者独立部署的服务，与 open-im-server 代码库无关，以下路径均基于新工程根目录。

---

## 文件结构

```
cmd/openim-node/
  main.go                          # 入口：--activate 激活模式 / 正常启动模式

internal/
  crypto/
    evm.go                         # secp256k1：GenerateKey、Sign、Ecrecover、Keccak256
    evm_test.go
  token/
    credential.go                  # 解析并验证 Hub Server 用户凭证
    credential_test.go
    usertoken.go                   # 签发并验证 user_token（含 session_sig，node_uid 为 uint64）
    usertoken_test.go
  store/
    accounts.go                    # MySQL accounts 表：开户、查户、批量反查 app_uid
    accounts_test.go
  config/
    config.go                      # NodeConfig：从 /data/config.json 加载/保存
  openim/
    admin.go                       # OpenIM Admin API：注册用户、获取 token、查成员、查在线状态、创建群组
  hub/
    client.go                      # Hub Server gRPC 客户端：UnaryClientInterceptor 签名、心跳、sign-session、推送
    client_test.go
  handler/
    activate.go                    # 激活流程：生成 keypair → gRPC Hub Server Activate → 初始化 MySQL → 持久化
    info.go                        # GET /node/info
    auth.go                        # POST /auth/token、POST /auth/exchange
    webhook.go                     # POST /internal/after-group-msg
  server/
    server.go                      # Gin 路由注册，返回 Server（含 HubCli 供心跳使用）

Dockerfile
go.mod                             # module github.com/langgexyz/open-im-node-server
```

---

## Task 1: 初始化独立工程

**Files:**
- Create: `go.mod`

> 以下命令在新建的独立工程目录中执行（不在 open-im-server 目录）。

- [ ] **Step 1: 初始化 module 并添加依赖**

```bash
git clone git@github.com:langgexyz/open-im-node-server.git
cd open-im-node-server
go mod init github.com/langgexyz/open-im-node-server
go get github.com/ethereum/go-ethereum/crypto@v1.14.8
go get github.com/go-sql-driver/mysql@v1.8.1
go get github.com/gin-gonic/gin@v1.9.1
go get github.com/stretchr/testify@v1.9.0
go get google.golang.org/grpc@v1.64.0
go get google.golang.org/protobuf@v1.34.1
go get github.com/langgexyz/open-im-hub-proto@latest
go mod tidy
```

- [ ] **Step 2: 验证依赖写入**

```bash
grep -E "go-ethereum|go-sql-driver|gin-gonic|testify|grpc|hub-proto" go.mod
```

期望：七行依赖均出现。

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: init openim-node module with dependencies"
```

---

## Task 2: EVM 加密工具

**Files:**
- Create: `internal/crypto/evm.go`
- Create: `internal/crypto/evm_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/crypto/evm_test.go`：

```go
package crypto_test

import (
    "testing"

    "github.com/stretchr/testify/require"
    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
)

func TestSignAndRecover(t *testing.T) {
    privKey, addr, err := bridgecrypto.GenerateKey()
    require.NoError(t, err)
    require.NotEmpty(t, addr)

    msg := []byte("hello bridge")
    sig, err := bridgecrypto.Sign(msg, privKey)
    require.NoError(t, err)
    require.Len(t, sig, 65)

    recovered, err := bridgecrypto.Ecrecover(msg, sig)
    require.NoError(t, err)
    require.Equal(t, addr, recovered)
}

func TestKeccak256Separator(t *testing.T) {
    // 验证分隔符防碰撞
    h1 := bridgecrypto.Keccak256([]byte("ab"))
    h2 := bridgecrypto.Keccak256([]byte("a"), []byte{0x00}, []byte("b"))
    require.NotEqual(t, h1, h2)
}

func TestPrivKeyHexRoundtrip(t *testing.T) {
    privKey, addr, _ := bridgecrypto.GenerateKey()
    hexKey := bridgecrypto.PrivKeyToHex(privKey)

    restored, err := bridgecrypto.PrivKeyFromHex(hexKey)
    require.NoError(t, err)

    restoredAddr, err := bridgecrypto.PrivKeyToAddress(restored)
    require.NoError(t, err)
    require.Equal(t, addr, restoredAddr)
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
go test ./internal/crypto/... -v
```

期望：编译错误。

- [ ] **Step 3: 实现 evm.go**

创建 `internal/crypto/evm.go`：

```go
package crypto

import (
    "crypto/ecdsa"
    "encoding/hex"
    "fmt"
    "strings"

    "github.com/ethereum/go-ethereum/crypto"
)

// GenerateKey 生成 secp256k1 密钥对，返回私钥和以太坊地址（小写，含 0x 前缀）
func GenerateKey() (*ecdsa.PrivateKey, string, error) {
    privKey, err := crypto.GenerateKey()
    if err != nil {
        return nil, "", err
    }
    addr, err := PrivKeyToAddress(privKey)
    if err != nil {
        return nil, "", err
    }
    return privKey, addr, nil
}

// PrivKeyToAddress 从私钥派生以太坊地址（小写，含 0x 前缀）
func PrivKeyToAddress(privKey *ecdsa.PrivateKey) (string, error) {
    pubKey, ok := privKey.Public().(*ecdsa.PublicKey)
    if !ok {
        return "", fmt.Errorf("invalid public key type")
    }
    return strings.ToLower(crypto.PubkeyToAddress(*pubKey).Hex()), nil
}

// Keccak256 计算多个字节片段拼接的 keccak256，使用 go-ethereum 内置实现
func Keccak256(data ...[]byte) []byte {
    return crypto.Keccak256(data...)
}

// Sign 对消息取 keccak256 后用私钥签名，返回 65 字节（r+s+v）
func Sign(message []byte, privKey *ecdsa.PrivateKey) ([]byte, error) {
    return crypto.Sign(Keccak256(message), privKey)
}

// Ecrecover 从消息和签名恢复签名者地址（小写，含 0x 前缀）
func Ecrecover(message, sig []byte) (string, error) {
    if len(sig) != 65 {
        return "", fmt.Errorf("invalid signature length: %d", len(sig))
    }
    pubKeyBytes, err := crypto.Ecrecover(Keccak256(message), sig)
    if err != nil {
        return "", err
    }
    pubKey, err := crypto.UnmarshalPubkey(pubKeyBytes)
    if err != nil {
        return "", err
    }
    return strings.ToLower(crypto.PubkeyToAddress(*pubKey).Hex()), nil
}

// PrivKeyToHex 私钥序列化为十六进制（无 0x）
func PrivKeyToHex(privKey *ecdsa.PrivateKey) string {
    return hex.EncodeToString(crypto.FromECDSA(privKey))
}

// PrivKeyFromHex 从十六进制字符串（可含 0x 前缀）解码私钥
func PrivKeyFromHex(hexKey string) (*ecdsa.PrivateKey, error) {
    return crypto.HexToECDSA(strings.TrimPrefix(hexKey, "0x"))
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
go test ./internal/crypto/... -v
```

期望：PASS，3 个测试通过。

- [ ] **Step 5: Commit**

```bash
git add internal/crypto/
git commit -m "feat(bridge): add secp256k1 crypto utilities"
```

---

## Task 3: Token 格式

**Files:**
- Create: `internal/token/credential.go`
- Create: `internal/token/credential_test.go`
- Create: `internal/token/usertoken.go`
- Create: `internal/token/usertoken_test.go`

Token 格式：`base64url(json_payload) + "." + hex(secp256k1_sig_65bytes)`

- [ ] **Step 1: 写凭证测试**

创建 `internal/token/credential_test.go`：

```go
package token_test

import (
    "crypto/ecdsa"
    "testing"
    "time"

    "github.com/stretchr/testify/require"
    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
    "github.com/langgexyz/open-im-node-server/internal/token"
)

func genKey(t *testing.T) (*ecdsa.PrivateKey, string) {
    t.Helper()
    priv, addr, err := bridgecrypto.GenerateKey()
    require.NoError(t, err)
    return priv, addr
}

func TestCredentialRoundtrip(t *testing.T) {
    priv, addr := genKey(t)
    cred, err := token.IssueCredential("user_abc", priv, time.Now().Add(time.Hour))
    require.NoError(t, err)

    payload, err := token.VerifyCredential(cred, addr)
    require.NoError(t, err)
    require.Equal(t, "user_abc", payload.AppUID)
}

func TestCredentialExpired(t *testing.T) {
    priv, addr := genKey(t)
    cred, _ := token.IssueCredential("user_abc", priv, time.Now().Add(-time.Hour))
    _, err := token.VerifyCredential(cred, addr)
    require.ErrorIs(t, err, token.ErrTokenExpired)
}

func TestCredentialWrongSigner(t *testing.T) {
    priv, _ := genKey(t)
    _, wrongAddr := genKey(t)
    cred, _ := token.IssueCredential("user_abc", priv, time.Now().Add(time.Hour))
    _, err := token.VerifyCredential(cred, wrongAddr)
    require.ErrorIs(t, err, token.ErrInvalidSigner)
}
```

- [ ] **Step 2: 写用户 Token 测试**

`user_token` payload 包含 `session_sig`（Hub Server 动态签发，绑定 node_public_key + app_uid）。

创建 `internal/token/usertoken_test.go`：

```go
package token_test

import (
    "testing"
    "time"

    "github.com/stretchr/testify/require"
    "github.com/langgexyz/open-im-node-server/internal/token"
)

func TestUserTokenRoundtrip(t *testing.T) {
    priv, addr := genKey(t)
    tok, err := token.IssueUserToken("uid_app", "app_id_123", 10001, "0xsession_sig_hex", priv, time.Now().Add(time.Hour))
    require.NoError(t, err)

    payload, err := token.VerifyUserToken(tok, addr)
    require.NoError(t, err)
    require.Equal(t, "uid_app", payload.AppUID)
    require.Equal(t, "app_id_123", payload.AppID)
    require.Equal(t, uint64(10001), payload.NodeUID)
    require.Equal(t, "0xsession_sig_hex", payload.SessionSig)
}

func TestUserTokenExpired(t *testing.T) {
    priv, addr := genKey(t)
    tok, _ := token.IssueUserToken("u", "a", 1, "0xsig", priv, time.Now().Add(-time.Minute))
    _, err := token.VerifyUserToken(tok, addr)
    require.ErrorIs(t, err, token.ErrTokenExpired)
}
```

- [ ] **Step 3: 运行测试，确认失败**

```bash
go test ./internal/token/... -v
```

- [ ] **Step 4: 实现 credential.go**

创建 `internal/token/credential.go`：

```go
package token

import (
    "crypto/ecdsa"
    "encoding/base64"
    "encoding/hex"
    "encoding/json"
    "errors"
    "fmt"
    "strings"
    "time"

    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
)

var (
    ErrTokenExpired  = errors.New("token expired")
    ErrInvalidSigner = errors.New("invalid token signer")
    ErrMalformed     = errors.New("malformed token")
)

type CredentialPayload struct {
    AppUID string `json:"app_uid"`
    Exp    int64  `json:"exp"`
}

func IssueCredential(appUID string, privKey *ecdsa.PrivateKey, expiry time.Time) (string, error) {
    return signPayload(CredentialPayload{AppUID: appUID, Exp: expiry.Unix()}, privKey)
}

func VerifyCredential(tokenStr, expectedSigner string) (*CredentialPayload, error) {
    payloadB64, _, err := splitToken(tokenStr)
    if err != nil {
        return nil, err
    }
    var payload CredentialPayload
    if err := decodePayload(payloadB64, &payload); err != nil {
        return nil, err
    }
    if time.Now().Unix() > payload.Exp {
        return nil, ErrTokenExpired
    }
    return &payload, verifySig(payloadB64, tokenStr, expectedSigner)
}

// --- 内部工具 ---

func signPayload(payload any, privKey *ecdsa.PrivateKey) (string, error) {
    jsonBytes, err := json.Marshal(payload)
    if err != nil {
        return "", err
    }
    b64 := base64.RawURLEncoding.EncodeToString(jsonBytes)
    sig, err := bridgecrypto.Sign([]byte(b64), privKey)
    if err != nil {
        return "", err
    }
    return b64 + "." + hex.EncodeToString(sig), nil
}

func splitToken(s string) (string, string, error) {
    parts := strings.SplitN(s, ".", 2)
    if len(parts) != 2 {
        return "", "", ErrMalformed
    }
    return parts[0], parts[1], nil
}

func decodePayload(b64 string, dst any) error {
    data, err := base64.RawURLEncoding.DecodeString(b64)
    if err != nil {
        return fmt.Errorf("%w: %v", ErrMalformed, err)
    }
    return json.Unmarshal(data, dst)
}

func verifySig(payloadB64, tokenStr, expectedSigner string) error {
    _, sigHex, _ := splitToken(tokenStr)
    sig, err := hex.DecodeString(sigHex)
    if err != nil {
        return fmt.Errorf("%w: invalid sig hex", ErrMalformed)
    }
    recovered, err := bridgecrypto.Ecrecover([]byte(payloadB64), sig)
    if err != nil {
        return fmt.Errorf("%w: %v", ErrInvalidSigner, err)
    }
    if !strings.EqualFold(recovered, expectedSigner) {
        return ErrInvalidSigner
    }
    return nil
}
```

- [ ] **Step 5: 实现 usertoken.go**

创建 `internal/token/usertoken.go`：

```go
package token

import (
    "crypto/ecdsa"
    "time"
)

// UserTokenPayload 节点签发的用户 Token
// node_uid 为 uint64（accounts 表自增 id，同时是 OpenIM userID）
// session_sig 由 Hub Server 动态签发，绑定 node_public_key + app_uid，App 端验证
type UserTokenPayload struct {
    AppUID     string `json:"app_uid"`
    AppID      string `json:"app_id"`
    NodeUID    uint64 `json:"node_uid"`
    SessionSig string `json:"session_sig"`
    Exp        int64  `json:"exp"`
}

func IssueUserToken(appUID, appID string, nodeUID uint64, sessionSig string, privKey *ecdsa.PrivateKey, expiry time.Time) (string, error) {
    return signPayload(UserTokenPayload{
        AppUID:     appUID,
        AppID:      appID,
        NodeUID:    nodeUID,
        SessionSig: sessionSig,
        Exp:        expiry.Unix(),
    }, privKey)
}

func VerifyUserToken(tokenStr, expectedSigner string) (*UserTokenPayload, error) {
    payloadB64, _, err := splitToken(tokenStr)
    if err != nil {
        return nil, err
    }
    var payload UserTokenPayload
    if err := decodePayload(payloadB64, &payload); err != nil {
        return nil, err
    }
    if time.Now().Unix() > payload.Exp {
        return nil, ErrTokenExpired
    }
    return &payload, verifySig(payloadB64, tokenStr, expectedSigner)
}
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
go test ./internal/token/... -v
```

期望：PASS，5 个测试通过。

- [ ] **Step 7: Commit**

```bash
git add internal/token/
git commit -m "feat(bridge): add token signing/verification (node_uid as uint64)"
```

---

## Task 4: MySQL accounts 表（节点账号体系）

**Files:**
- Create: `internal/store/accounts.go`
- Create: `internal/store/accounts_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/store/accounts_test.go`：

```go
package store_test

import (
    "database/sql"
    "testing"

    _ "github.com/go-sql-driver/mysql"
    "github.com/stretchr/testify/require"
    "github.com/langgexyz/open-im-node-server/internal/store"
)

// 测试需要本地 MySQL，DSN 通过环境变量 TEST_MYSQL_DSN 注入
// 若未设置则跳过
func testDB(t *testing.T) *store.Accounts {
    t.Helper()
    dsn := os.Getenv("TEST_MYSQL_DSN")
    if dsn == "" {
        t.Skip("TEST_MYSQL_DSN not set, skipping MySQL integration test")
    }
    db, err := sql.Open("mysql", dsn)
    require.NoError(t, err)
    accounts, err := store.NewAccounts(db)
    require.NoError(t, err)
    t.Cleanup(func() {
        db.Exec("TRUNCATE TABLE accounts")
        db.Close()
    })
    return accounts
}

func TestAccountsGetOrCreate(t *testing.T) {
    accounts := testDB(t)

    // 首次调用：创建账号
    id1, err := accounts.GetOrCreate("app_uid_123")
    require.NoError(t, err)
    require.Greater(t, id1, uint64(0))

    // 再次调用：返回相同 id（幂等）
    id2, err := accounts.GetOrCreate("app_uid_123")
    require.NoError(t, err)
    require.Equal(t, id1, id2)

    // 不同用户：不同 id
    id3, err := accounts.GetOrCreate("app_uid_456")
    require.NoError(t, err)
    require.NotEqual(t, id1, id3)
}

func TestAccountsGetAppUIDs(t *testing.T) {
    accounts := testDB(t)

    id1, _ := accounts.GetOrCreate("app_uid_aaa")
    id2, _ := accounts.GetOrCreate("app_uid_bbb")
    id3, _ := accounts.GetOrCreate("app_uid_ccc")

    result, err := accounts.GetAppUIDs([]uint64{id1, id3, 99999})
    require.NoError(t, err)
    require.Len(t, result, 2) // 99999 不存在
    require.Equal(t, "app_uid_aaa", result[id1])
    require.Equal(t, "app_uid_ccc", result[id3])
    _ = id2
}
```

> 注意：测试文件顶部加 `import "os"`。

- [ ] **Step 2: 运行测试，确认跳过（无 MySQL）或编译失败**

```bash
go test ./internal/store/... -v
```

期望：编译错误或 SKIP。

- [ ] **Step 3: 实现 accounts.go**

创建 `internal/store/accounts.go`：

```go
package store

import (
    "database/sql"
    "fmt"
    "strings"
)

// Accounts 是节点的账号体系，封装 MySQL accounts 表操作
type Accounts struct {
    db *sql.DB
}

// NewAccounts 初始化 Accounts，自动建表（幂等）
func NewAccounts(db *sql.DB) (*Accounts, error) {
    _, err := db.Exec(`CREATE TABLE IF NOT EXISTS accounts (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        app_uid    VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`)
    if err != nil {
        return nil, fmt.Errorf("create accounts table: %w", err)
    }
    return &Accounts{db: db}, nil
}

// GetOrCreate 查询或创建账号，返回 node_uid（accounts.id）
// 幂等：同一 app_uid 多次调用返回相同 id
func (a *Accounts) GetOrCreate(appUID string) (uint64, error) {
    // 先查
    var id uint64
    err := a.db.QueryRow(`SELECT id FROM accounts WHERE app_uid = ?`, appUID).Scan(&id)
    if err == nil {
        return id, nil
    }
    if err != sql.ErrNoRows {
        return 0, fmt.Errorf("query account: %w", err)
    }

    // 不存在则插入（INSERT IGNORE 处理并发冲突）
    res, err := a.db.Exec(`INSERT IGNORE INTO accounts (app_uid) VALUES (?)`, appUID)
    if err != nil {
        return 0, fmt.Errorf("insert account: %w", err)
    }

    lastID, err := res.LastInsertId()
    if err != nil || lastID == 0 {
        // INSERT IGNORE 时另一并发请求已插入，重新查询
        err = a.db.QueryRow(`SELECT id FROM accounts WHERE app_uid = ?`, appUID).Scan(&id)
        return id, err
    }
    return uint64(lastID), nil
}

// InsertOwner 插入运营者账号（激活时调用，幂等）
func (a *Accounts) InsertOwner() (uint64, error) {
    return a.GetOrCreate("__node_owner__")
}

// GetAppUIDs 批量根据 node_uid（id）查询 app_uid，不存在的跳过
func (a *Accounts) GetAppUIDs(nodeUIDs []uint64) (map[uint64]string, error) {
    if len(nodeUIDs) == 0 {
        return nil, nil
    }
    placeholders := strings.Repeat("?,", len(nodeUIDs))
    placeholders = placeholders[:len(placeholders)-1]
    args := make([]any, len(nodeUIDs))
    for i, id := range nodeUIDs {
        args[i] = id
    }
    rows, err := a.db.Query(
        `SELECT id, app_uid FROM accounts WHERE id IN (`+placeholders+`)`,
        args...,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    result := make(map[uint64]string, len(nodeUIDs))
    for rows.Next() {
        var id uint64
        var appUID string
        if err := rows.Scan(&id, &appUID); err != nil {
            return nil, err
        }
        result[id] = appUID
    }
    return result, rows.Err()
}
```

- [ ] **Step 4: 运行测试**

```bash
# 若有本地 MySQL：
TEST_MYSQL_DSN="root:password@tcp(127.0.0.1:3306)/bridge_test?parseTime=true" \
  go test ./internal/store/... -v

# 无 MySQL 环境直接编译检查：
go build ./internal/store/...
```

- [ ] **Step 5: Commit**

```bash
git add internal/store/
git commit -m "feat(bridge): add MySQL accounts store (node account system)"
```

---

## Task 5: NodeConfig

**Files:**
- Create: `internal/config/config.go`

NodeConfig 字段说明：
- `node_private_key`：节点 EVM 私钥（hex，无 0x 前缀）
- `hub_public_key`：激活时从 Hub Server 自动获取写入，用于本地验证 user_credential 签名
- `hub_grpc_addr`：Hub Server gRPC 地址（如 `hub.example.com:50051`）
- `owner_node_uid` / `channel_group_id` 不存 config：`owner_node_uid` 运行时查 DB（`SELECT id FROM accounts WHERE app_uid='__node_owner__'`），`channel_group_id` 固定等于 `app_id`

- [ ] **Step 1: 实现 config.go**

创建 `internal/config/config.go`：

```go
package config

import (
    "encoding/json"
    "os"
    "path/filepath"
)

const DefaultConfigPath = "/data/config.json"

type NodeConfig struct {
    AppID            string `json:"app_id"`
    NodePublicKey    string `json:"node_public_key"`
    NodePrivateKey   string `json:"node_private_key"`   // hex，无 0x 前缀
    HubPublicKey     string `json:"hub_public_key"`     // Hub Server 公钥，激活时自动写入，用于验证 user_credential
    OpenIMAdminToken string `json:"openim_admin_token"`
    OpenIMAPIAddr    string `json:"openim_api_addr"`
    HubGRPCAddr      string `json:"hub_grpc_addr"`      // Hub Server gRPC 地址，如 hub.example.com:50051
    NodeWSAddr       string `json:"node_ws_addr"`
    MySQLDSN         string `json:"mysql_dsn"`
    TokenExpirySecs  int64  `json:"token_expiry_secs"`  // 默认 86400
}

func Load(path string) (*NodeConfig, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, err
    }
    var cfg NodeConfig
    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, err
    }
    if cfg.TokenExpirySecs <= 0 {
        cfg.TokenExpirySecs = 86400
    }
    return &cfg, nil
}

func Save(cfg *NodeConfig, path string) error {
    if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
        return err
    }
    data, err := json.MarshalIndent(cfg, "", "  ")
    if err != nil {
        return err
    }
    return os.WriteFile(path, data, 0600)
}
```

- [ ] **Step 2: 确认编译**

```bash
go build ./internal/config/...
```

- [ ] **Step 3: Commit**

```bash
git add internal/config/
git commit -m "feat(bridge): add NodeConfig (node_private_key, hub_public_key auto-populated at activation)"
```

---

## Task 6: OpenIM Admin API 客户端

**Files:**
- Create: `internal/openim/admin.go`

- [ ] **Step 1: 实现 admin.go**

创建 `internal/openim/admin.go`：

```go
package openim

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "strconv"
    "time"
)

type Client struct {
    baseURL    string
    adminToken string
    http       *http.Client
}

func NewClient(baseURL, adminToken string) *Client {
    return &Client{baseURL: baseURL, adminToken: adminToken, http: &http.Client{Timeout: 10 * time.Second}}
}

type apiResp[T any] struct {
    ErrCode int    `json:"errCode"`
    ErrMsg  string `json:"errMsg"`
    Data    T      `json:"data"`
}

// RegisterUser 注册用户（幂等，errCode 10002 = 已存在，忽略）
func (c *Client) RegisterUser(ctx context.Context, nodeUID uint64, nickname string) error {
    body, _ := json.Marshal(map[string]any{
        "users": []map[string]any{
            {"userID": strconv.FormatUint(nodeUID, 10), "nickname": nickname},
        },
    })
    resp, err := c.post[json.RawMessage](ctx, "/user/user_register", body)
    if err != nil {
        return err
    }
    if resp.ErrCode != 0 && resp.ErrCode != 10002 {
        return fmt.Errorf("register user: %s (code %d)", resp.ErrMsg, resp.ErrCode)
    }
    return nil
}

type tokenData struct{ Token string `json:"token"` }

// GetUserToken 以 Admin 身份获取指定用户的 OpenIM token
func (c *Client) GetUserToken(ctx context.Context, nodeUID uint64) (string, error) {
    body, _ := json.Marshal(map[string]any{
        "userID":     strconv.FormatUint(nodeUID, 10),
        "platformID": 1,
    })
    resp, err := c.post[tokenData](ctx, "/auth/get_user_token", body)
    if err != nil {
        return "", err
    }
    if resp.ErrCode != 0 {
        return "", fmt.Errorf("get user token: %s (code %d)", resp.ErrMsg, resp.ErrCode)
    }
    return resp.Data.Token, nil
}

type memberData struct {
    Members []struct{ UserID string `json:"userID"` } `json:"members"`
}

// GetGroupMemberNodeUIDs 获取群组所有成员的 node_uid（uint64）
func (c *Client) GetGroupMemberNodeUIDs(ctx context.Context, groupID string) ([]uint64, error) {
    body, _ := json.Marshal(map[string]any{
        "groupID":    groupID,
        "pagination": map[string]any{"pageNumber": 1, "showNumber": 10000},
    })
    resp, err := c.post[memberData](ctx, "/group/get_group_member_list", body)
    if err != nil {
        return nil, err
    }
    if resp.ErrCode != 0 {
        return nil, fmt.Errorf("get group members: %s (code %d)", resp.ErrMsg, resp.ErrCode)
    }
    ids := make([]uint64, 0, len(resp.Data.Members))
    for _, m := range resp.Data.Members {
        id, err := strconv.ParseUint(m.UserID, 10, 64)
        if err != nil {
            continue // 跳过非数字 userID（如运营者账号若格式不同）
        }
        ids = append(ids, id)
    }
    return ids, nil
}

type onlineData struct {
    StatusList []struct {
        UserID      string `json:"userID"`
        OnlineState int32  `json:"onlineState"`
    } `json:"statusList"`
}

// GetOfflineNodeUIDs 在给定 nodeUID 列表中返回当前离线的 node_uid
func (c *Client) GetOfflineNodeUIDs(ctx context.Context, nodeUIDs []uint64) ([]uint64, error) {
    if len(nodeUIDs) == 0 {
        return nil, nil
    }
    userIDs := make([]string, len(nodeUIDs))
    for i, id := range nodeUIDs {
        userIDs[i] = strconv.FormatUint(id, 10)
    }
    body, _ := json.Marshal(map[string]any{"userIDs": userIDs})
    resp, err := c.post[onlineData](ctx, "/user/get_users_online_status", body)
    if err != nil {
        return nil, err
    }
    if resp.ErrCode != 0 {
        return nil, fmt.Errorf("get online status: %s (code %d)", resp.ErrMsg, resp.ErrCode)
    }
    var offline []uint64
    for _, s := range resp.Data.StatusList {
        if s.OnlineState == 0 {
            id, _ := strconv.ParseUint(s.UserID, 10, 64)
            offline = append(offline, id)
        }
    }
    return offline, nil
}

// CreateGroup 创建群组（激活时调用，group_id = app_id，owner = 运营者 node_uid）
func (c *Client) CreateGroup(ctx context.Context, groupID, ownerUserID string) error {
    body, _ := json.Marshal(map[string]any{
        "groupInfo": map[string]any{
            "groupID":   groupID,
            "groupName": groupID,
            "groupType": 2, // 大群
        },
        "memberUserIDs": []string{},
        "ownerUserID":   ownerUserID,
    })
    resp, err := c.post[json.RawMessage](ctx, "/group/create_group", body)
    if err != nil {
        return err
    }
    if resp.ErrCode != 0 && resp.ErrCode != 10006 { // 10006 = 已存在
        return fmt.Errorf("create group: %s (code %d)", resp.ErrMsg, resp.ErrCode)
    }
    return nil
}

func (c *Client) post[T any](ctx context.Context, path string, body []byte) (*apiResp[T], error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
    if err != nil {
        return nil, err
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("token", c.adminToken)
    resp, err := c.http.Do(req)
    if err != nil {
        return nil, fmt.Errorf("openim http: %w", err)
    }
    defer resp.Body.Close()
    var result apiResp[T]
    return &result, json.NewDecoder(resp.Body).Decode(&result)
}
```

- [ ] **Step 2: 确认编译**

```bash
go build ./internal/openim/...
```

- [ ] **Step 3: Commit**

```bash
git add internal/openim/
git commit -m "feat(bridge): add OpenIM Admin API client (uint64 node_uid)"
```

---

## Task 7: Hub Server gRPC 客户端（节点请求签名 + 激活 + 心跳 + sign-session + 推送）

所有发往 Hub Server 的 gRPC 调用都通过 `NewNodeSignInterceptor` 自动附加节点签名 metadata：
- `x-node-public-key`：节点以太坊地址
- `x-node-timestamp`：Unix 秒级时间戳（字符串）
- `x-node-body-hash`：`hex(keccak256(proto.Marshal(req)))`（客户端预计算并传递，服务端读取 metadata 直接使用）
- `x-node-sig`：`hex(Sign(keccak256(full_method || 0x00 || body_hash || 0x00 || timestamp), node_private_key))`

**签名有效期：±60s（分钟级别）**，Hub Server 校验 `|now - timestamp| ≤ 60s`。

Activate 调用额外附加 `x-activation-code` metadata；Hub Server 拦截器对 Activate 跳过签名验证，改为验证激活码。

**Files:**
- Create: `internal/hub/client.go`
- Create: `internal/hub/client_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/hub/client_test.go`：

```go
package hub_test

import (
    "context"
    "encoding/hex"
    "strconv"
    "testing"
    "time"

    "github.com/stretchr/testify/require"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    "google.golang.org/protobuf/proto"

    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
    "github.com/langgexyz/open-im-node-server/internal/hub"
    hubv1 "github.com/langgexyz/open-im-hub-proto/hub/v1"
)

func TestNodeSignInterceptorAttachesMetadata(t *testing.T) {
    priv, pub, err := bridgecrypto.GenerateKey()
    require.NoError(t, err)

    interceptor := hub.NewNodeSignInterceptor(pub, priv)
    req := &hubv1.HeartbeatRequest{NodePublicKey: pub, WsAddr: "wss://test"}

    var capturedCtx context.Context
    mockInvoker := func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, opts ...grpc.CallOption) error {
        capturedCtx = ctx
        return nil
    }

    err = interceptor(context.Background(), "/hub.v1.HubService/Heartbeat", req, nil, nil, mockInvoker)
    require.NoError(t, err)

    md, ok := metadata.FromOutgoingContext(capturedCtx)
    require.True(t, ok)
    require.Equal(t, pub, md.Get("x-node-public-key")[0])

    ts, err := strconv.ParseInt(md.Get("x-node-timestamp")[0], 10, 64)
    require.NoError(t, err)
    require.InDelta(t, time.Now().Unix(), ts, 5)

    bodyHashHex := md.Get("x-node-body-hash")[0]
    sigHex := md.Get("x-node-sig")[0]
    require.NotEmpty(t, bodyHashHex)

    // 验证 body_hash 等于 keccak256(proto.Marshal(req))
    bodyHashBytes, err := hex.DecodeString(bodyHashHex)
    require.NoError(t, err)
    sigBytes, err := hex.DecodeString(sigHex)
    require.NoError(t, err)
    require.Len(t, sigBytes, 65)

    rawBytes, _ := proto.Marshal(req)
    expectedBodyHash := bridgecrypto.Keccak256(rawBytes)
    require.Equal(t, expectedBodyHash, bodyHashBytes)

    // 验证签名：ecrecover 结果应等于 nodePublicKey
    timestampStr := md.Get("x-node-timestamp")[0]
    sigMsg := hub.BuildMsg(
        []byte("/hub.v1.HubService/Heartbeat"),
        bodyHashBytes,
        []byte(timestampStr),
    )
    recovered, err := bridgecrypto.Ecrecover(sigMsg, sigBytes)
    require.NoError(t, err)
    require.Equal(t, pub, recovered)
}

func TestNodeSignInterceptorTimestamp(t *testing.T) {
    priv, pub, err := bridgecrypto.GenerateKey()
    require.NoError(t, err)

    interceptor := hub.NewNodeSignInterceptor(pub, priv)
    req := &hubv1.HeartbeatRequest{}

    var ts int64
    mockInvoker := func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, opts ...grpc.CallOption) error {
        md, _ := metadata.FromOutgoingContext(ctx)
        ts, _ = strconv.ParseInt(md.Get("x-node-timestamp")[0], 10, 64)
        return nil
    }
    _ = interceptor(context.Background(), "/hub.v1.HubService/Heartbeat", req, nil, nil, mockInvoker)

    // timestamp 刚生成，应与 now 差 ≤ 1s（Hub Server 允许 ±60s）
    require.InDelta(t, time.Now().Unix(), ts, 1)
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
go test ./internal/hub/... -v
```

期望：编译错误。

- [ ] **Step 3: 实现 client.go**

创建 `internal/hub/client.go`：

```go
package hub

import (
    "context"
    "crypto/ecdsa"
    "encoding/hex"
    "fmt"
    "strconv"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/metadata"
    "google.golang.org/protobuf/proto"

    hubv1 "github.com/langgexyz/open-im-hub-proto/hub/v1"
    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
)

// Client 是 Node 向 Hub Server 发起 gRPC 调用的客户端。
// 每次调用自动附加节点签名 metadata（见 NewNodeSignInterceptor）。
// 签名有效期：Hub Server 校验 |now - timestamp| ≤ 60s（分钟级别）。
type Client struct {
    nodePublicKey string
    conn          *grpc.ClientConn
    svc           hubv1.HubServiceClient
}

// NewClient 建立到 Hub Server 的 gRPC 连接。
// hubGRPCAddr 格式：host:port（如 hub.example.com:50051）。
// 生产环境请将 insecure 替换为 TLS credentials。
func NewClient(hubGRPCAddr, nodePublicKey string, nodePrivKey *ecdsa.PrivateKey) (*Client, error) {
    conn, err := grpc.NewClient(hubGRPCAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithUnaryInterceptor(NewNodeSignInterceptor(nodePublicKey, nodePrivKey)),
    )
    if err != nil {
        return nil, fmt.Errorf("hub grpc dial: %w", err)
    }
    return &Client{
        nodePublicKey: nodePublicKey,
        conn:          conn,
        svc:           hubv1.NewHubServiceClient(conn),
    }, nil
}

// Close 关闭 gRPC 连接
func (c *Client) Close() error { return c.conn.Close() }

// Activate 节点注册（一次性）。
// activationCode 通过 gRPC metadata x-activation-code 传递，Hub Server 对此方法跳过 node-sig 验证。
func (c *Client) Activate(ctx context.Context, activationCode, nodeWSAddr string) (appID, hubPublicKey string, err error) {
    ctx = metadata.AppendToOutgoingContext(ctx, "x-activation-code", activationCode)
    resp, err := c.svc.Activate(ctx, &hubv1.ActivateRequest{
        NodePublicKey: c.nodePublicKey,
        NodeWsAddr:    nodeWSAddr,
    })
    if err != nil {
        return "", "", fmt.Errorf("activate: %w", err)
    }
    return resp.AppId, resp.HubPublicKey, nil
}

// Heartbeat 发送节点心跳
func (c *Client) Heartbeat(ctx context.Context, wsAddr string) error {
    _, err := c.svc.Heartbeat(ctx, &hubv1.HeartbeatRequest{
        NodePublicKey: c.nodePublicKey,
        WsAddr:        wsAddr,
    })
    return err
}

// SignSession 向 Hub Server 请求为用户签发 session_sig。
// userCredential 是 App 发来的凭证原始字符串（Bearer ...），Hub Server 验证并提取 app_uid。
// 返回 (session_sig, app_uid, error)
func (c *Client) SignSession(ctx context.Context, userCredential string, expiry int64) (string, string, error) {
    resp, err := c.svc.SignSession(ctx, &hubv1.SignSessionRequest{
        UserCredential: userCredential,
        Expiry:         expiry,
    })
    if err != nil {
        return "", "", fmt.Errorf("sign-session: %w", err)
    }
    return resp.SessionSig, resp.AppUid, nil
}

// PushNotify 分批向 Hub Server 转发离线推送
func (c *Client) PushNotify(ctx context.Context, appUIDs []string, title, body, dataJSON string) error {
    const batchSize = 1000
    for i := 0; i < len(appUIDs); i += batchSize {
        end := i + batchSize
        if end > len(appUIDs) {
            end = len(appUIDs)
        }
        _, err := c.svc.PushNotify(ctx, &hubv1.PushNotifyRequest{
            AppUids:  appUIDs[i:end],
            Title:    title,
            Body:     body,
            DataJson: dataJSON,
        })
        if err != nil {
            return fmt.Errorf("push notify: %w", err)
        }
    }
    return nil
}

// NewNodeSignInterceptor 返回一个 gRPC UnaryClientInterceptor，为所有出站调用附加节点签名 metadata。
// 签名消息：keccak256(full_method || 0x00 || body_hash || 0x00 || timestamp)
// 其中 body_hash = keccak256(proto.Marshal(req))
// 导出以便测试直接调用。
func NewNodeSignInterceptor(nodePublicKey string, nodePrivKey *ecdsa.PrivateKey) grpc.UnaryClientInterceptor {
    return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {

        protoMsg, ok := req.(proto.Message)
        if !ok {
            return fmt.Errorf("request is not proto.Message")
        }
        rawBytes, err := proto.Marshal(protoMsg)
        if err != nil {
            return fmt.Errorf("marshal request: %w", err)
        }
        bodyHash := bridgecrypto.Keccak256(rawBytes)
        timestamp := strconv.FormatInt(time.Now().Unix(), 10)

        // 签名消息：full_method || 0x00 || body_hash || 0x00 || timestamp
        sigMsg := BuildMsg([]byte(method), bodyHash, []byte(timestamp))
        sig, err := bridgecrypto.Sign(sigMsg, nodePrivKey)
        if err != nil {
            return fmt.Errorf("sign grpc request: %w", err)
        }

        md := metadata.Pairs(
            "x-node-public-key", nodePublicKey,
            "x-node-timestamp", timestamp,
            "x-node-body-hash", hex.EncodeToString(bodyHash),
            "x-node-sig", hex.EncodeToString(sig),
        )
        ctx = metadata.NewOutgoingContext(ctx, md)
        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// BuildMsg 拼接带 0x00 分隔符的消息，防哈希碰撞。导出以便测试验证签名内容。
func BuildMsg(parts ...[]byte) []byte {
    var msg []byte
    for i, p := range parts {
        msg = append(msg, p...)
        if i < len(parts)-1 {
            msg = append(msg, 0x00)
        }
    }
    return msg
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
go test ./internal/hub/... -v
```

期望：PASS，2 个测试通过。

- [ ] **Step 5: Commit**

```bash
git add internal/hub/
git commit -m "feat(bridge): add Hub Server gRPC client with node-signing interceptor (±60s timestamp)"
```

---

## Task 8: HTTP 处理器与服务器

**Files:**
- Create: `internal/handler/activate.go`
- Create: `internal/handler/info.go`
- Create: `internal/handler/auth.go`
- Create: `internal/handler/webhook.go`
- Create: `internal/server/server.go`

- [ ] **Step 1: 实现 auth.go**

创建 `internal/handler/auth.go`：

```go
package handler

import (
    "crypto/ecdsa"
    "net/http"
    "time"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/config"
    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
    "github.com/langgexyz/open-im-node-server/internal/hub"
    "github.com/langgexyz/open-im-node-server/internal/openim"
    "github.com/langgexyz/open-im-node-server/internal/store"
    "github.com/langgexyz/open-im-node-server/internal/token"
)

type AuthHandler struct {
    cfg       *config.NodeConfig
    accounts  *store.Accounts
    openimCli *openim.Client
    hubCli    *hub.Client
    nodePriv  *ecdsa.PrivateKey
}

func NewAuthHandler(cfg *config.NodeConfig, accounts *store.Accounts, openimCli *openim.Client, hubCli *hub.Client) (*AuthHandler, error) {
    priv, err := bridgecrypto.PrivKeyFromHex(cfg.NodePrivateKey)
    if err != nil {
        return nil, err
    }
    return &AuthHandler{cfg: cfg, accounts: accounts, openimCli: openimCli, hubCli: hubCli, nodePriv: priv}, nil
}

// PostToken POST /auth/token
// Authorization: Bearer <user_credential>
// 流程：
//  1. 将凭证通过 gRPC SignSession 交给 Hub Server 验证，Hub Server 提取 app_uid 并签发 session_sig
//  2. 本地开户（幂等），在 OpenIM 注册用户（幂等）
//  3. 签发 user_token（含 session_sig）
func (h *AuthHandler) PostToken(c *gin.Context) {
    credStr := c.GetHeader("Authorization")

    expiry := time.Now().Add(time.Duration(h.cfg.TokenExpirySecs) * time.Second)

    // 向 Hub Server 请求 session_sig，同时验证凭证并获取 app_uid
    sessionSig, appUID, err := h.hubCli.SignSession(c.Request.Context(), credStr, expiry.Unix())
    if err != nil {
        c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
        return
    }

    // 开户或查户（幂等）
    nodeUID, err := h.accounts.GetOrCreate(appUID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "account: " + err.Error()})
        return
    }

    // 在 OpenIM 注册该用户（幂等）
    if err := h.openimCli.RegisterUser(c.Request.Context(), nodeUID, "user"); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "register: " + err.Error()})
        return
    }

    userToken, err := token.IssueUserToken(appUID, h.cfg.AppID, nodeUID, sessionSig, h.nodePriv, expiry)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "issue token"})
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "user_token":      userToken,
        "node_public_key": h.cfg.NodePublicKey,
    })
}

// PostExchange POST /auth/exchange
func (h *AuthHandler) PostExchange(c *gin.Context) {
    var body struct {
        UserToken string `json:"user_token" binding:"required"`
    }
    if err := c.ShouldBindJSON(&body); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    payload, err := token.VerifyUserToken(body.UserToken, h.cfg.NodePublicKey) // 用本节点公钥验证
    if err != nil {
        c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
        return
    }

    openimToken, err := h.openimCli.GetUserToken(c.Request.Context(), payload.NodeUID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusOK, gin.H{"openim_token": openimToken, "node_uid": payload.NodeUID})
}
```

- [ ] **Step 2: 实现 webhook.go**

创建 `internal/handler/webhook.go`：

```go
package handler

import (
    "context"
    "log"
    "net/http"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/hub"
    "github.com/langgexyz/open-im-node-server/internal/openim"
    "github.com/langgexyz/open-im-node-server/internal/store"
)

type WebhookHandler struct {
    accounts  *store.Accounts
    hubCli    *hub.Client
    openimCli *openim.Client
    groupID   string // 频道群组 ID（= app_id）
}

func NewWebhookHandler(accounts *store.Accounts, hubCli *hub.Client, openimCli *openim.Client, groupID string) *WebhookHandler {
    return &WebhookHandler{accounts: accounts, hubCli: hubCli, openimCli: openimCli, groupID: groupID}
}

func (h *WebhookHandler) AfterGroupMsg(c *gin.Context) {
    var body struct {
        GroupID string `json:"groupID"`
        Content string `json:"content"`
    }
    if err := c.ShouldBindJSON(&body); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{})

    // 使用独立 context，不依赖已结束的 HTTP 请求 context
    go h.dispatchPush(context.Background(), body.GroupID, body.Content)
}

func (h *WebhookHandler) dispatchPush(ctx context.Context, groupID, content string) {
    allNodeUIDs, err := h.openimCli.GetGroupMemberNodeUIDs(ctx, groupID)
    if err != nil {
        log.Printf("webhook: get members error: %v", err)
        return
    }

    offlineNodeUIDs, err := h.openimCli.GetOfflineNodeUIDs(ctx, allNodeUIDs)
    if err != nil {
        log.Printf("webhook: get offline error: %v", err)
        return
    }
    if len(offlineNodeUIDs) == 0 {
        return
    }

    appUIDMap, err := h.accounts.GetAppUIDs(offlineNodeUIDs)
    if err != nil {
        log.Printf("webhook: accounts lookup error: %v", err)
        return
    }

    appUIDs := make([]string, 0, len(appUIDMap))
    for _, v := range appUIDMap {
        appUIDs = append(appUIDs, v)
    }
    if len(appUIDs) == 0 {
        return
    }

    if err := h.hubCli.PushNotify(ctx, appUIDs, "新内容", content, `{"group_id":"`+groupID+`"}`); err != nil {
        log.Printf("webhook: push error: %v", err)
    }
}
```

- [ ] **Step 3: 实现 info.go 和 activate.go**

创建 `internal/handler/info.go`：

```go
package handler

import (
    "net/http"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/config"
)

func NodeInfo(cfg *config.NodeConfig) gin.HandlerFunc {
    return func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{
            "app_id":          cfg.AppID,
            "node_public_key": cfg.NodePublicKey,
            "node_ws_addr":    cfg.NodeWSAddr,
        })
    }
}
```

创建 `internal/handler/activate.go`：

```go
package handler

import (
    "context"
    "database/sql"
    "fmt"
    "strconv"
    "time"

    _ "github.com/go-sql-driver/mysql"
    "github.com/langgexyz/open-im-node-server/internal/config"
    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
    "github.com/langgexyz/open-im-node-server/internal/hub"
    "github.com/langgexyz/open-im-node-server/internal/openim"
    "github.com/langgexyz/open-im-node-server/internal/store"
)

type ActivateParams struct {
    ActivationCode   string
    HubGRPCAddr      string // Hub Server gRPC 地址，如 hub.example.com:50051
    OpenIMAPIAddr    string
    OpenIMAdminToken string
    NodeWSAddr       string
    MySQLDSN         string
    ConfigPath       string
}

func Activate(p ActivateParams) (*config.NodeConfig, error) {
    privKey, pubKey, err := bridgecrypto.GenerateKey()
    if err != nil {
        return nil, fmt.Errorf("generate keypair: %w", err)
    }

    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()

    // 通过 gRPC 调用 Hub Server Activate（Hub Server 对此方法跳过 node-sig，验证激活码）
    hubCli, err := hub.NewClient(p.HubGRPCAddr, pubKey, privKey)
    if err != nil {
        return nil, fmt.Errorf("hub grpc connect: %w", err)
    }
    defer hubCli.Close()

    appID, hubPublicKey, err := hubCli.Activate(ctx, p.ActivationCode, p.NodeWSAddr)
    if err != nil {
        return nil, fmt.Errorf("activate: %w", err)
    }

    // 初始化 MySQL，预插入运营者账号
    db, err := sql.Open("mysql", p.MySQLDSN)
    if err != nil {
        return nil, fmt.Errorf("open mysql: %w", err)
    }
    defer db.Close()

    accounts, err := store.NewAccounts(db)
    if err != nil {
        return nil, fmt.Errorf("init accounts: %w", err)
    }
    ownerUID, err := accounts.InsertOwner()
    if err != nil {
        return nil, fmt.Errorf("insert owner: %w", err)
    }

    // 在 OpenIM 创建频道群组（group_id = app_id）并注册运营者账号
    openimCli := openim.NewClient(p.OpenIMAPIAddr, p.OpenIMAdminToken)
    if err := openimCli.RegisterUser(ctx, ownerUID, "node-owner"); err != nil {
        return nil, fmt.Errorf("register owner in openim: %w", err)
    }
    ownerIDStr := strconv.FormatUint(ownerUID, 10)
    if err := openimCli.CreateGroup(ctx, appID, ownerIDStr); err != nil {
        return nil, fmt.Errorf("create channel group: %w", err)
    }

    cfg := &config.NodeConfig{
        AppID:            appID,
        NodePublicKey:    pubKey,
        NodePrivateKey:   bridgecrypto.PrivKeyToHex(privKey),
        HubPublicKey:     hubPublicKey,
        OpenIMAdminToken: p.OpenIMAdminToken,
        OpenIMAPIAddr:    p.OpenIMAPIAddr,
        HubGRPCAddr:      p.HubGRPCAddr,
        NodeWSAddr:       p.NodeWSAddr,
        MySQLDSN:         p.MySQLDSN,
        TokenExpirySecs:  86400,
    }
    return cfg, config.Save(cfg, p.ConfigPath)
}
```

- [ ] **Step 4: 实现 server.go**

创建 `internal/server/server.go`：

```go
package server

import (
    "database/sql"
    "fmt"

    _ "github.com/go-sql-driver/mysql"
    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/config"
    bridgecrypto "github.com/langgexyz/open-im-node-server/internal/crypto"
    "github.com/langgexyz/open-im-node-server/internal/handler"
    "github.com/langgexyz/open-im-node-server/internal/hub"
    "github.com/langgexyz/open-im-node-server/internal/openim"
    "github.com/langgexyz/open-im-node-server/internal/store"
)

type Server struct {
    Engine *gin.Engine
    HubCli *hub.Client
    Cfg    *config.NodeConfig
}

func New(cfg *config.NodeConfig) (*Server, error) {
    privKey, err := bridgecrypto.PrivKeyFromHex(cfg.NodePrivateKey)
    if err != nil {
        return nil, fmt.Errorf("load node private key: %w", err)
    }

    db, err := sql.Open("mysql", cfg.MySQLDSN)
    if err != nil {
        return nil, fmt.Errorf("open mysql: %w", err)
    }
    accounts, err := store.NewAccounts(db)
    if err != nil {
        return nil, fmt.Errorf("init accounts: %w", err)
    }

    openimCli := openim.NewClient(cfg.OpenIMAPIAddr, cfg.OpenIMAdminToken)
    hubCli, err := hub.NewClient(cfg.HubGRPCAddr, cfg.NodePublicKey, privKey)
    if err != nil {
        return nil, fmt.Errorf("init hub grpc client: %w", err)
    }

    authH, err := handler.NewAuthHandler(cfg, accounts, openimCli, hubCli)
    if err != nil {
        return nil, fmt.Errorf("init auth handler: %w", err)
    }
    // channel_group_id 固定等于 app_id（激活时创建）
    webhookH := handler.NewWebhookHandler(accounts, hubCli, openimCli, cfg.AppID)

    r := gin.New()
    r.Use(gin.Recovery())
    r.GET("/node/info", handler.NodeInfo(cfg))
    r.POST("/auth/token", authH.PostToken)
    r.POST("/auth/exchange", authH.PostExchange)
    r.POST("/internal/after-group-msg", webhookH.AfterGroupMsg)

    return &Server{Engine: r, HubCli: hubCli, Cfg: cfg}, nil
}
```

- [ ] **Step 5: 确认编译**

```bash
go build ./internal/...
```

- [ ] **Step 6: Commit**

```bash
git add internal/handler/ internal/server/
git commit -m "feat(bridge): add HTTP handlers (auth, webhook, info) and server routing with gRPC hub client"
```

---

## Task 9: 入口与 Dockerfile

**Files:**
- Create: `cmd/openim-node/main.go`
- Create: `Dockerfile.bridge`

- [ ] **Step 1: 实现 main.go**

创建 `cmd/openim-node/main.go`：

```go
package main

import (
    "context"
    "flag"
    "fmt"
    "log"
    "os"
    "time"

    "github.com/langgexyz/open-im-node-server/internal/config"
    "github.com/langgexyz/open-im-node-server/internal/handler"
    "github.com/langgexyz/open-im-node-server/internal/server"
)

func main() {
    activateCode := flag.String("activate", "", "一次性激活码")
    configPath   := flag.String("config", config.DefaultConfigPath, "配置文件路径")
    addr         := flag.String("addr", ":8080", "HTTP 监听地址")
    flag.Parse()

    if *activateCode != "" {
        cfg, err := handler.Activate(handler.ActivateParams{
            ActivationCode:   *activateCode,
            HubGRPCAddr:      requireEnv("HUB_GRPC_ADDR"),
            OpenIMAPIAddr:    requireEnv("OPENIM_API_ADDR"),
            OpenIMAdminToken: requireEnv("OPENIM_ADMIN_TOKEN"),
            NodeWSAddr:       requireEnv("NODE_WS_ADDR"),
            MySQLDSN:         requireEnv("MYSQL_DSN"),
            ConfigPath:       *configPath,
        })
        if err != nil {
            log.Fatalf("激活失败: %v", err)
        }
        fmt.Printf("激活成功！AppID: %s\n", cfg.AppID)
        return
    }

    cfg, err := config.Load(*configPath)
    if err != nil {
        log.Fatalf("加载配置失败: %v", err)
    }

    srv, err := server.New(cfg)
    if err != nil {
        log.Fatalf("初始化失败: %v", err)
    }

    // 启动心跳：立即发送一次，之后每 30s 一次
    go runHeartbeat(srv)

    log.Printf("Bridge 启动 %s，AppID: %s", *addr, cfg.AppID)
    if err := srv.Engine.Run(*addr); err != nil {
        log.Fatalf("服务器错误: %v", err)
    }
}

func runHeartbeat(srv *server.Server) {
    for {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        if err := srv.HubCli.Heartbeat(ctx, srv.Cfg.NodeWSAddr); err != nil {
            log.Printf("heartbeat failed: %v", err)
        }
        cancel()
        time.Sleep(30 * time.Second)
    }
}

func requireEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        log.Fatalf("环境变量 %s 未设置", key)
    }
    return v
}
```

- [ ] **Step 2: 实现 Dockerfile**

创建 `Dockerfile`：

```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /openim-node ./cmd/openim-node

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /openim-node /openim-node
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/openim-node"]
```

- [ ] **Step 3: 确认完整编译**

```bash
go build ./cmd/openim-node/...
```

- [ ] **Step 4: 运行所有测试**

```bash
go test ./internal/... -v
```

- [ ] **Step 5: Commit**

```bash
git add cmd/openim-node/ Dockerfile
git commit -m "feat(bridge): add main entrypoint and Dockerfile"
```

---

## Task 10: OpenIM webhook 配置

**Files:**
- Modify: `config/webhooks.yml`

- [ ] **Step 1: 开启 afterSendGroupMsg**

```yaml
afterSendGroupMsg:
  enable: true
  url: "http://bridge:8080/internal/after-group-msg"
  timeout: 5
  failedContinue: true
```

- [ ] **Step 2: Commit**

```bash
git add config/webhooks.yml
git commit -m "config: enable afterSendGroupMsg webhook for bridge push relay"
```

---

## 验证清单

```bash
go test ./internal/... -v -count=1
go build ./...
go vet ./...
```
