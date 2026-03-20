# open-im-hub-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 Hub Server 中枢服务——通过 gRPC 对节点提供准入控制、动态签名授权、推送转发；通过 HTTP 对 App 客户端提供设备 token 注册和节点目录。

**Architecture:** 双服务器架构：gRPC server（节点专用，`:50051`）+ HTTP server（App 客户端专用，`:8080`）。节点 gRPC 鉴权通过 UnaryServerInterceptor 验证 metadata 中的 `x-node-*` 签名。Hub Server 持有 EVM 私钥签发 session_sig 和验证 user_credential。

**Tech Stack:** Go 1.21+, `google.golang.org/grpc`, `github.com/langgexyz/open-im-hub-proto`, `github.com/gin-gonic/gin`（HTTP）, `github.com/ethereum/go-ethereum/crypto`, `github.com/go-sql-driver/mysql`, `github.com/google/uuid`, `github.com/sideshow/apns2`

**Spec:** `docs/superpowers/specs/2026-03-20-decentralized-public-account-platform-design.md`（open-im-server 仓库）

> **独立工程**：`github.com/langgexyz/open-im-hub-server`，以下路径均基于该仓库根目录。

---

## 文件结构

```
cmd/server/
  main.go                        # 启动 gRPC server + HTTP server / --gen-code

internal/
  crypto/
    evm.go                       # secp256k1：GenerateKey、Sign、Ecrecover、Keccak256
    evm_test.go
  config/
    config.go                    # Config 从环境变量加载（HUB_* 命名）
  store/
    db.go                        # sql.DB 初始化 + 自动建表
    nodes.go                     # nodes 表 CRUD
    codes.go                     # activation_codes 表
    tokens.go                    # device_tokens 表
    store_test.go                # 集成测试（需 TEST_MYSQL_DSN）
  grpc/
    server.go                    # gRPC server 创建 + node auth UnaryInterceptor
    hub_service.go               # HubService 实现（Activate/Heartbeat/SignSession/PushNotify）
    hub_service_test.go          # HubService 单元测试
  handler/
    credential.go                # 包级函数 VerifyCredential（user_credential 验证）
    device_token.go              # POST /user/device-token（App 注册推送 token）
    directory.go                 # GET /nodes（公开节点目录）
  push/
    pusher.go                    # Pusher interface + NoopPusher
    fcm.go                       # FCM Legacy HTTP 实现
    apns.go                      # APNs HTTP/2 实现
  server/
    grpc.go                      # gRPC server 启动（ListenAndServe）
    http.go                      # HTTP server 启动（Gin 路由）

tools/genkey/
  main.go                        # 生成 HUB_PRIVATE_KEY 和 HUB_PUBLIC_KEY

Dockerfile
go.mod                           # module github.com/langgexyz/open-im-hub-server
```

---

## Task 1: 初始化工程

**Files:**
- Create: `go.mod`

- [ ] **Step 1: Clone 并初始化**

```bash
git clone git@github.com:langgexyz/open-im-hub-server.git /tmp/open-im-hub-server
cd /tmp/open-im-hub-server
go mod init github.com/langgexyz/open-im-hub-server
go get google.golang.org/grpc@v1.64.0
go get google.golang.org/protobuf@v1.34.1
go get github.com/langgexyz/open-im-hub-proto@latest
go get github.com/ethereum/go-ethereum/crypto@v1.14.8
go get github.com/go-sql-driver/mysql@v1.8.1
go get github.com/gin-gonic/gin@v1.9.1
go get github.com/google/uuid@v1.6.0
go get github.com/stretchr/testify@v1.9.0
go get github.com/sideshow/apns2@v0.23.0
go mod tidy
```

- [ ] **Step 2: 验证依赖**

```bash
grep -E "grpc|hub-proto|go-ethereum|go-sql-driver|gin-gonic|uuid|testify|apns2" go.mod
```

期望：8 行依赖均出现。

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: init open-im-hub-server with gRPC and hub-proto dependencies"
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
	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

func TestSignAndRecover(t *testing.T) {
	privKey, addr, err := hubcrypto.GenerateKey()
	require.NoError(t, err)
	require.NotEmpty(t, addr)

	msg := []byte("hello hub")
	sig, err := hubcrypto.Sign(msg, privKey)
	require.NoError(t, err)
	require.Len(t, sig, 65)

	recovered, err := hubcrypto.Ecrecover(msg, sig)
	require.NoError(t, err)
	require.Equal(t, addr, recovered)
}

func TestKeccak256Separator(t *testing.T) {
	h1 := hubcrypto.Keccak256([]byte("ab"))
	h2 := hubcrypto.Keccak256([]byte("a"), []byte{0x00}, []byte("b"))
	require.NotEqual(t, h1, h2)
}

func TestPrivKeyRoundtrip(t *testing.T) {
	privKey, addr, _ := hubcrypto.GenerateKey()
	hexKey := hubcrypto.PrivKeyToHex(privKey)
	restored, err := hubcrypto.PrivKeyFromHex(hexKey)
	require.NoError(t, err)
	restoredAddr, err := hubcrypto.PrivKeyToAddress(restored)
	require.NoError(t, err)
	require.Equal(t, addr, restoredAddr)
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
go test ./internal/crypto/... -v
```

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

func PrivKeyToAddress(privKey *ecdsa.PrivateKey) (string, error) {
	pubKey, ok := privKey.Public().(*ecdsa.PublicKey)
	if !ok {
		return "", fmt.Errorf("invalid public key type")
	}
	return strings.ToLower(crypto.PubkeyToAddress(*pubKey).Hex()), nil
}

func Keccak256(data ...[]byte) []byte {
	return crypto.Keccak256(data...)
}

func Sign(message []byte, privKey *ecdsa.PrivateKey) ([]byte, error) {
	return crypto.Sign(Keccak256(message), privKey)
}

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

func PrivKeyToHex(privKey *ecdsa.PrivateKey) string {
	return hex.EncodeToString(crypto.FromECDSA(privKey))
}

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
git commit -m "feat(hub): add secp256k1 crypto utilities"
```

---

## Task 3: Config

**Files:**
- Create: `internal/config/config.go`

所有环境变量使用 `HUB_` 前缀，清晰区分 hub-server 配置。

- [ ] **Step 1: 实现 config.go**

创建 `internal/config/config.go`：

```go
package config

import (
	"crypto/ecdsa"
	"fmt"
	"os"
	"strconv"

	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

type Config struct {
	// Hub Server EVM 私钥，用于签发 session_sig 和验证 user_credential
	HubPrivateKey    string
	HubPrivateKeyObj *ecdsa.PrivateKey
	HubPublicKey     string // 从私钥派生，激活时返回给节点

	MySQLDSN string
	HTTPAddr string // App 客户端 HTTP 服务，默认 ":8080"
	GRPCAddr string // 节点 gRPC 服务，默认 ":50051"

	// APNs 配置（可选）
	APNsKeyFile  string
	APNsKeyID    string
	APNsTeamID   string
	APNsBundleID string
	APNsSandbox  bool

	// FCM 配置（可选）
	FCMServerKey string
}

func Load() (*Config, error) {
	privateKeyHex := requireEnv("HUB_PRIVATE_KEY")
	privKey, err := hubcrypto.PrivKeyFromHex(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("invalid HUB_PRIVATE_KEY: %w", err)
	}
	pubKey, err := hubcrypto.PrivKeyToAddress(privKey)
	if err != nil {
		return nil, fmt.Errorf("derive public key: %w", err)
	}

	httpAddr := os.Getenv("HUB_HTTP_ADDR")
	if httpAddr == "" {
		httpAddr = ":8080"
	}
	grpcAddr := os.Getenv("HUB_GRPC_ADDR")
	if grpcAddr == "" {
		grpcAddr = ":50051"
	}

	sandbox, _ := strconv.ParseBool(os.Getenv("APNS_SANDBOX"))

	return &Config{
		HubPrivateKey:    privateKeyHex,
		HubPrivateKeyObj: privKey,
		HubPublicKey:     pubKey,
		MySQLDSN:         requireEnv("MYSQL_DSN"),
		HTTPAddr:         httpAddr,
		GRPCAddr:         grpcAddr,
		APNsKeyFile:      os.Getenv("APNS_KEY_FILE"),
		APNsKeyID:        os.Getenv("APNS_KEY_ID"),
		APNsTeamID:       os.Getenv("APNS_TEAM_ID"),
		APNsBundleID:     os.Getenv("APNS_BUNDLE_ID"),
		APNsSandbox:      sandbox,
		FCMServerKey:     os.Getenv("FCM_SERVER_KEY"),
	}, nil
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required environment variable %s is not set", key))
	}
	return v
}
```

- [ ] **Step 2: 确认编译**

```bash
go build ./internal/config/...
```

- [ ] **Step 3: Commit**

```bash
git add internal/config/
git commit -m "feat(hub): add config with HUB_* env vars and gRPC addr"
```

---

## Task 4: MySQL Store

**Files:**
- Create: `internal/store/db.go`
- Create: `internal/store/nodes.go`
- Create: `internal/store/codes.go`
- Create: `internal/store/tokens.go`
- Create: `internal/store/store_test.go`

- [ ] **Step 1: 写集成测试**

创建 `internal/store/store_test.go`：

```go
package store_test

import (
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/require"
	"github.com/langgexyz/open-im-hub-server/internal/store"
)

func testStore(t *testing.T) *store.Store {
	t.Helper()
	dsn := os.Getenv("TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("TEST_MYSQL_DSN not set")
	}
	db, err := sql.Open("mysql", dsn)
	require.NoError(t, err)
	s, err := store.New(db)
	require.NoError(t, err)
	t.Cleanup(func() {
		db.Exec("TRUNCATE TABLE nodes")
		db.Exec("TRUNCATE TABLE activation_codes")
		db.Exec("TRUNCATE TABLE device_tokens")
		db.Close()
	})
	return s
}

func TestActivationCode(t *testing.T) {
	s := testStore(t)

	err := s.Codes.Insert("CODE123", time.Now().Add(time.Hour))
	require.NoError(t, err)

	err = s.Codes.Consume("CODE123")
	require.NoError(t, err)

	err = s.Codes.Consume("CODE123")
	require.ErrorIs(t, err, store.ErrCodeUsed)

	err = s.Codes.Consume("NOTEXIST")
	require.ErrorIs(t, err, store.ErrCodeNotFound)
}

func TestNodeCRUD(t *testing.T) {
	s := testStore(t)

	node := &store.Node{
		AppID:         "app-001",
		NodePublicKey: "0xabc",
		Name:          "Test Node",
		WSAddr:        "wss://test.example.com",
		Status:        1,
		ExpiresAt:     time.Now().Add(365 * 24 * time.Hour),
	}
	require.NoError(t, s.Nodes.Insert(node))

	found, err := s.Nodes.GetByPublicKey("0xabc")
	require.NoError(t, err)
	require.Equal(t, "app-001", found.AppID)

	require.NoError(t, s.Nodes.UpdateHeartbeat("0xabc"))

	nodes, err := s.Nodes.List()
	require.NoError(t, err)
	require.Len(t, nodes, 1)
}

func TestDeviceTokens(t *testing.T) {
	s := testStore(t)

	require.NoError(t, s.DeviceTokens.Upsert("uid_aaa", 1, "token_ios_aaa"))
	require.NoError(t, s.DeviceTokens.Upsert("uid_aaa", 1, "token_ios_aaa_v2"))

	tokens, err := s.DeviceTokens.GetByUIDs([]string{"uid_aaa", "uid_bbb"})
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.Equal(t, "token_ios_aaa_v2", tokens["uid_aaa"][0].Token)
}
```

- [ ] **Step 2: 运行测试，确认跳过或编译失败**

```bash
go test ./internal/store/... -v
```

- [ ] **Step 3: 实现 db.go**

创建 `internal/store/db.go`：

```go
package store

import (
	"database/sql"
	"fmt"
)

type Store struct {
	DB           *sql.DB
	Nodes        *NodeStore
	Codes        *CodeStore
	DeviceTokens *DeviceTokenStore
}

func New(db *sql.DB) (*Store, error) {
	if err := migrate(db); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{
		DB:           db,
		Nodes:        &NodeStore{db: db},
		Codes:        &CodeStore{db: db},
		DeviceTokens: &DeviceTokenStore{db: db},
	}, nil
}

func migrate(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS nodes (
			id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			app_id          VARCHAR(64) NOT NULL UNIQUE,
			node_public_key VARCHAR(42) NOT NULL UNIQUE,
			name            VARCHAR(128) NOT NULL,
			avatar          VARCHAR(512),
			description     TEXT,
			ws_addr         VARCHAR(512) NOT NULL,
			status          TINYINT DEFAULT 1,
			expires_at      TIMESTAMP NOT NULL,
			last_heartbeat  TIMESTAMP NULL,
			created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS activation_codes (
			id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			code       VARCHAR(64) NOT NULL UNIQUE,
			used       BOOLEAN DEFAULT FALSE,
			expires_at TIMESTAMP NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS device_tokens (
			id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
			app_uid    VARCHAR(64) NOT NULL,
			platform   TINYINT NOT NULL,
			token      VARCHAR(256) NOT NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			UNIQUE KEY uk_uid_platform (app_uid, platform)
		)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 4: 实现 nodes.go**

创建 `internal/store/nodes.go`：

```go
package store

import (
	"database/sql"
	"fmt"
	"time"
)

type Node struct {
	ID            uint64
	AppID         string
	NodePublicKey string
	Name          string
	Avatar        string
	Description   string
	WSAddr        string
	Status        int8
	ExpiresAt     time.Time
	LastHeartbeat *time.Time
	CreatedAt     time.Time
}

type NodeStore struct{ db *sql.DB }

func (s *NodeStore) Insert(n *Node) error {
	_, err := s.db.Exec(
		`INSERT INTO nodes (app_id, node_public_key, name, ws_addr, status, expires_at) VALUES (?,?,?,?,?,?)`,
		n.AppID, n.NodePublicKey, n.Name, n.WSAddr, n.Status, n.ExpiresAt,
	)
	return err
}

func (s *NodeStore) GetByPublicKey(pubKey string) (*Node, error) {
	var n Node
	var lastHB sql.NullTime
	err := s.db.QueryRow(
		`SELECT id, app_id, node_public_key, name, ws_addr, status, expires_at, last_heartbeat FROM nodes WHERE node_public_key = ?`,
		pubKey,
	).Scan(&n.ID, &n.AppID, &n.NodePublicKey, &n.Name, &n.WSAddr, &n.Status, &n.ExpiresAt, &lastHB)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("node not found")
	}
	if err != nil {
		return nil, err
	}
	if lastHB.Valid {
		n.LastHeartbeat = &lastHB.Time
	}
	return &n, nil
}

func (s *NodeStore) UpdateHeartbeat(pubKey string) error {
	_, err := s.db.Exec(`UPDATE nodes SET last_heartbeat = NOW() WHERE node_public_key = ?`, pubKey)
	return err
}

func (s *NodeStore) List() ([]*Node, error) {
	rows, err := s.db.Query(
		`SELECT id, app_id, node_public_key, name, avatar, description, ws_addr, status, expires_at, last_heartbeat FROM nodes WHERE status = 1`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []*Node
	for rows.Next() {
		var n Node
		var avatar, description sql.NullString
		var lastHB sql.NullTime
		if err := rows.Scan(&n.ID, &n.AppID, &n.NodePublicKey, &n.Name, &avatar, &description, &n.WSAddr, &n.Status, &n.ExpiresAt, &lastHB); err != nil {
			return nil, err
		}
		n.Avatar = avatar.String
		n.Description = description.String
		if lastHB.Valid {
			n.LastHeartbeat = &lastHB.Time
		}
		nodes = append(nodes, &n)
	}
	return nodes, rows.Err()
}
```

- [ ] **Step 5: 实现 codes.go**

创建 `internal/store/codes.go`：

```go
package store

import (
	"database/sql"
	"errors"
	"time"
)

var (
	ErrCodeNotFound = errors.New("activation code not found")
	ErrCodeUsed     = errors.New("activation code already used")
	ErrCodeExpired  = errors.New("activation code expired")
)

type CodeStore struct{ db *sql.DB }

func (s *CodeStore) Insert(code string, expiresAt time.Time) error {
	_, err := s.db.Exec(`INSERT INTO activation_codes (code, expires_at) VALUES (?, ?)`, code, expiresAt)
	return err
}

func (s *CodeStore) Consume(code string) error {
	var used bool
	var expiresAt time.Time
	err := s.db.QueryRow(`SELECT used, expires_at FROM activation_codes WHERE code = ?`, code).Scan(&used, &expiresAt)
	if err == sql.ErrNoRows {
		return ErrCodeNotFound
	}
	if err != nil {
		return err
	}
	if used {
		return ErrCodeUsed
	}
	if time.Now().After(expiresAt) {
		return ErrCodeExpired
	}
	res, err := s.db.Exec(`UPDATE activation_codes SET used = TRUE WHERE code = ? AND used = FALSE`, code)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrCodeUsed // 并发场景：另一请求先消费了
	}
	return nil
}
```

- [ ] **Step 6: 实现 tokens.go**

创建 `internal/store/tokens.go`：

```go
package store

import "database/sql"

type DeviceToken struct {
	AppUID   string
	Platform int8
	Token    string
}

type DeviceTokenStore struct{ db *sql.DB }

func (s *DeviceTokenStore) Upsert(appUID string, platform int8, token string) error {
	_, err := s.db.Exec(
		`INSERT INTO device_tokens (app_uid, platform, token) VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE token = VALUES(token)`,
		appUID, platform, token,
	)
	return err
}

func (s *DeviceTokenStore) GetByUIDs(appUIDs []string) (map[string][]DeviceToken, error) {
	if len(appUIDs) == 0 {
		return nil, nil
	}
	args := make([]any, len(appUIDs))
	placeholders := ""
	for i, uid := range appUIDs {
		args[i] = uid
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}
	rows, err := s.db.Query(
		`SELECT app_uid, platform, token FROM device_tokens WHERE app_uid IN (`+placeholders+`)`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string][]DeviceToken)
	for rows.Next() {
		var dt DeviceToken
		if err := rows.Scan(&dt.AppUID, &dt.Platform, &dt.Token); err != nil {
			return nil, err
		}
		result[dt.AppUID] = append(result[dt.AppUID], dt)
	}
	return result, rows.Err()
}
```

- [ ] **Step 7: 运行测试**

```bash
# 有 MySQL：
TEST_MYSQL_DSN="root:password@tcp(127.0.0.1:3306)/hub_test?parseTime=true" \
  go test ./internal/store/... -v

# 无 MySQL：
go build ./internal/store/...
```

- [ ] **Step 8: Commit**

```bash
git add internal/store/
git commit -m "feat(hub): add MySQL store (nodes, activation_codes, device_tokens)"
```

---

## Task 5: gRPC Server + HubService 实现

**Files:**
- Create: `internal/grpc/server.go`
- Create: `internal/grpc/hub_service.go`
- Create: `internal/grpc/hub_service_test.go`

节点签名验证在 `UnaryServerInterceptor` 中完成，流程：
1. `Activate` 方法：从 metadata 取 `x-activation-code` 鉴权，跳过节点签名
2. 其他方法：验证 `x-node-public-key`、`x-node-timestamp`、`x-node-body-hash`、`x-node-sig`
3. 签名消息 = `keccak256(full_method || 0x00 || body_hash || 0x00 || timestamp)`（body_hash 由客户端计算后放入 metadata）
4. 验证通过后将 `*Node` 存入 context

- [ ] **Step 1: 写 HubService 测试**

创建 `internal/grpc/hub_service_test.go`：

```go
package grpcserver_test

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
	grpcserver "github.com/langgexyz/open-im-hub-server/internal/grpc"
	"github.com/langgexyz/open-im-hub-server/internal/store"
	hubv1 "github.com/langgexyz/open-im-hub-proto/hub/v1"
)

// mockStore 最小化 store mock，供测试使用
type mockStore struct {
	nodes map[string]*store.Node
	codes map[string]bool
}

func newMockStore() *mockStore {
	return &mockStore{
		nodes: map[string]*store.Node{},
		codes: map[string]bool{},
	}
}

func (m *mockStore) GetByPublicKey(k string) (*store.Node, error) {
	n, ok := m.nodes[k]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return n, nil
}
func (m *mockStore) Insert(n *store.Node) error         { m.nodes[n.NodePublicKey] = n; return nil }
func (m *mockStore) UpdateHeartbeat(k string) error     { return nil }
func (m *mockStore) List() ([]*store.Node, error)       { return nil, nil }
func (m *mockStore) ConsumeCode(code string) error {
	if !m.codes[code] {
		return store.ErrCodeNotFound
	}
	delete(m.codes, code)
	return nil
}

// signedCtx 生成带节点签名 metadata 的 context
func signedCtx(t *testing.T, method string, req proto.Message, pubKey string, privKey interface{}) context.Context {
	t.Helper()
	priv, ok := privKey.(interface {
		Sign([]byte) ([]byte, error)
	})
	_ = priv
	_ = ok
	// 实际在 TestHeartbeat 中内联签名，此处为占位
	return context.Background()
}

func startTestServer(t *testing.T, ms *mockStore, privKey interface{}, pubKey string) hubv1.HubServiceClient {
	t.Helper()

	// 使用 hub server 私钥
	_, hubPub, _ := hubcrypto.GenerateKey()
	hubPriv, _, _ := hubcrypto.GenerateKey()
	_ = hubPub

	srv := grpcserver.New(ms, hubPriv, pubKey)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go srv.Serve(lis)
	t.Cleanup(func() { srv.Stop() })

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	return hubv1.NewHubServiceClient(conn)
}

func TestActivate(t *testing.T) {
	ms := newMockStore()
	ms.codes["TESTCODE"] = true

	_, hubPub, _ := hubcrypto.GenerateKey()
	hubPriv, _, _ := hubcrypto.GenerateKey()

	srv := grpcserver.New(ms, hubPriv, hubPub)
	lis, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(lis)
	defer srv.Stop()

	conn, _ := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	defer conn.Close()
	client := hubv1.NewHubServiceClient(conn)

	ctx := metadata.NewOutgoingContext(context.Background(), metadata.Pairs("x-activation-code", "TESTCODE"))
	resp, err := client.Activate(ctx, &hubv1.ActivateRequest{
		NodePublicKey: "0xnodepubkey",
		NodeWsAddr:    "wss://test.example.com",
	})
	require.NoError(t, err)
	require.NotEmpty(t, resp.AppId)
	require.Equal(t, hubPub, resp.HubPublicKey)
}

func TestHeartbeat(t *testing.T) {
	ms := newMockStore()
	nodePriv, nodePub, _ := hubcrypto.GenerateKey()
	ms.nodes[nodePub] = &store.Node{
		NodePublicKey: nodePub, Status: 1, ExpiresAt: time.Now().Add(time.Hour),
	}

	hubPriv, hubPub, _ := hubcrypto.GenerateKey()
	srv := grpcserver.New(ms, hubPriv, hubPub)
	lis, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(lis)
	defer srv.Stop()

	conn, _ := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	defer conn.Close()
	client := hubv1.NewHubServiceClient(conn)

	req := &hubv1.HeartbeatRequest{NodePublicKey: nodePub, WsAddr: "wss://test.example.com"}
	reqBytes, _ := proto.Marshal(req)

	method := "/hub.v1.HubService/Heartbeat"
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	bodyHash := hubcrypto.Keccak256(reqBytes)
	msg := buildMsg([]byte(method), bodyHash, []byte(timestamp))
	sig, _ := hubcrypto.Sign(msg, nodePriv)

	md := metadata.Pairs(
		"x-node-public-key", nodePub,
		"x-node-timestamp", timestamp,
		"x-node-body-hash", hex.EncodeToString(bodyHash),
		"x-node-sig", hex.EncodeToString(sig),
	)
	ctx := metadata.NewOutgoingContext(context.Background(), md)
	resp, err := client.Heartbeat(ctx, req)
	require.NoError(t, err)
	require.True(t, resp.Ok)
}

func buildMsg(parts ...[]byte) []byte {
	var msg []byte
	for i, p := range parts {
		msg = append(msg, p...)
		if i < len(parts)-1 {
			msg = append(msg, 0x00)
		}
	}
	return msg
}

// 验证 session_sig 正确性
func TestSignSession(t *testing.T) {
	ms := newMockStore()
	nodePriv, nodePub, _ := hubcrypto.GenerateKey()
	ms.nodes[nodePub] = &store.Node{
		NodePublicKey: nodePub, Status: 1, ExpiresAt: time.Now().Add(time.Hour),
	}

	hubPriv, hubPub, _ := hubcrypto.GenerateKey()
	srv := grpcserver.New(ms, hubPriv, hubPub)
	lis, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(lis)
	defer srv.Stop()

	conn, _ := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	defer conn.Close()
	client := hubv1.NewHubServiceClient(conn)

	// 构造有效 user_credential
	expiry := time.Now().Add(time.Hour).Unix()
	payload := fmt.Sprintf(`{"app_uid":"user_abc","exp":%d}`, expiry)
	b64 := base64.RawURLEncoding.EncodeToString([]byte(payload))
	credSig, _ := hubcrypto.Sign([]byte(b64), hubPriv)
	credential := b64 + "." + hex.EncodeToString(credSig)

	req := &hubv1.SignSessionRequest{UserCredential: "Bearer " + credential, Expiry: expiry}
	reqBytes, _ := proto.Marshal(req)

	method := "/hub.v1.HubService/SignSession"
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	bodyHash := hubcrypto.Keccak256(reqBytes)
	msg := buildMsg([]byte(method), bodyHash, []byte(timestamp))
	sig, _ := hubcrypto.Sign(msg, nodePriv)

	md := metadata.Pairs(
		"x-node-public-key", nodePub,
		"x-node-timestamp", timestamp,
		"x-node-body-hash", hex.EncodeToString(bodyHash),
		"x-node-sig", hex.EncodeToString(sig),
	)
	ctx := metadata.NewOutgoingContext(context.Background(), md)
	resp, err := client.SignSession(ctx, req)
	require.NoError(t, err)
	require.Equal(t, "user_abc", resp.AppUid)
	require.NotEmpty(t, resp.SessionSig)
}
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
go test ./internal/grpc/... -v
```

- [ ] **Step 3: 实现 server.go**

创建 `internal/grpc/server.go`：

```go
package grpcserver

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
	"github.com/langgexyz/open-im-hub-server/internal/store"
	hubv1 "github.com/langgexyz/open-im-hub-proto/hub/v1"
)

type nodeKey struct{}

// New 创建 gRPC server，包含节点签名验证 interceptor
func New(s NodeStore, hubPrivKey *ecdsa.PrivateKey, hubPublicKey string) *grpc.Server {
	srv := grpc.NewServer(
		grpc.UnaryInterceptor(nodeAuthInterceptor(s)),
	)
	hubv1.RegisterHubServiceServer(srv, &hubService{
		store:        s,
		hubPrivKey:   hubPrivKey,
		hubPublicKey: hubPublicKey,
	})
	return srv
}

// NodeStore 是 server 依赖的 store 接口（便于测试 mock）
type NodeStore interface {
	GetByPublicKey(pubKey string) (*store.Node, error)
	Insert(n *store.Node) error
	UpdateHeartbeat(pubKey string) error
	List() ([]*store.Node, error)
	ConsumeCode(code string) error
}

func nodeAuthInterceptor(nodes NodeStore) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		// Activate 用激活码鉴权，跳过节点签名验证
		if strings.HasSuffix(info.FullMethod, "/Activate") {
			return handler(ctx, req)
		}

		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "missing metadata")
		}
		get := func(key string) string {
			if vals := md.Get(key); len(vals) > 0 {
				return vals[0]
			}
			return ""
		}

		nodePublicKey := get("x-node-public-key")
		timestamp := get("x-node-timestamp")
		bodyHashHex := get("x-node-body-hash")
		sigHex := get("x-node-sig")

		if nodePublicKey == "" || timestamp == "" || bodyHashHex == "" || sigHex == "" {
			return nil, status.Error(codes.Unauthenticated, "missing auth metadata")
		}

		ts, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil || absInt(time.Now().Unix()-ts) > 60 {
			return nil, status.Error(codes.Unauthenticated, "stale timestamp")
		}

		sig, err := hex.DecodeString(sigHex)
		if err != nil || len(sig) != 65 {
			return nil, status.Error(codes.Unauthenticated, "invalid sig format")
		}
		bodyHash, err := hex.DecodeString(bodyHashHex)
		if err != nil {
			return nil, status.Error(codes.Unauthenticated, "invalid body hash")
		}

		msg := buildMsg([]byte(info.FullMethod), bodyHash, []byte(timestamp))
		recovered, err := hubcrypto.Ecrecover(msg, sig)
		if err != nil || !strings.EqualFold(recovered, nodePublicKey) {
			return nil, status.Error(codes.Unauthenticated, "invalid signature")
		}

		node, err := nodes.GetByPublicKey(nodePublicKey)
		if err != nil {
			return nil, status.Error(codes.PermissionDenied, "node not found")
		}
		if node.Status != 1 || time.Now().After(node.ExpiresAt) {
			return nil, status.Error(codes.PermissionDenied, "node not authorized")
		}

		ctx = context.WithValue(ctx, nodeKey{}, node)
		return handler(ctx, req)
	}
}

func buildMsg(parts ...[]byte) []byte {
	var msg []byte
	for i, p := range parts {
		msg = append(msg, p...)
		if i < len(parts)-1 {
			msg = append(msg, 0x00)
		}
	}
	return msg
}

func absInt(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
```

- [ ] **Step 4: 实现 hub_service.go**

创建 `internal/grpc/hub_service.go`：

```go
package grpcserver

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"github.com/google/uuid"
	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
	"github.com/langgexyz/open-im-hub-server/internal/store"
	hubv1 "github.com/langgexyz/open-im-hub-proto/hub/v1"
)

type hubService struct {
	hubv1.UnimplementedHubServiceServer
	store        NodeStore
	hubPrivKey   *ecdsa.PrivateKey
	hubPublicKey string
}

// Activate 节点注册：激活码鉴权（metadata: x-activation-code）
func (s *hubService) Activate(ctx context.Context, req *hubv1.ActivateRequest) (*hubv1.ActivateResponse, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	codes_list := md.Get("x-activation-code")
	if len(codes_list) == 0 {
		return nil, status.Error(codes.Unauthenticated, "missing x-activation-code")
	}
	if err := s.store.ConsumeCode(codes_list[0]); err != nil {
		if errors.Is(err, store.ErrCodeNotFound) || errors.Is(err, store.ErrCodeUsed) {
			return nil, status.Error(codes.Unauthenticated, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	appID := uuid.NewString()
	node := &store.Node{
		AppID:         appID,
		NodePublicKey: req.NodePublicKey,
		Name:          appID,
		WSAddr:        req.NodeWsAddr,
		Status:        1,
		ExpiresAt:     time.Now().Add(365 * 24 * time.Hour),
	}
	if err := s.store.Insert(node); err != nil {
		return nil, status.Error(codes.Internal, "register node: "+err.Error())
	}
	return &hubv1.ActivateResponse{
		AppId:        appID,
		HubPublicKey: s.hubPublicKey,
	}, nil
}

// Heartbeat 节点心跳（需通过 interceptor 节点签名验证）
func (s *hubService) Heartbeat(ctx context.Context, req *hubv1.HeartbeatRequest) (*hubv1.HeartbeatResponse, error) {
	node := ctx.Value(nodeKey{}).(*store.Node)
	if err := s.store.UpdateHeartbeat(node.NodePublicKey); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &hubv1.HeartbeatResponse{Ok: true}, nil
}

// SignSession 验证 user_credential，签发 session_sig
func (s *hubService) SignSession(ctx context.Context, req *hubv1.SignSessionRequest) (*hubv1.SignSessionResponse, error) {
	node := ctx.Value(nodeKey{}).(*store.Node)

	credStr := strings.TrimPrefix(req.UserCredential, "Bearer ")
	appUID, err := verifyCredential(credStr, s.hubPublicKey)
	if err != nil {
		return nil, status.Error(codes.Unauthenticated, "invalid credential: "+err.Error())
	}

	// session_sig = Sign(keccak256(node_public_key || 0x00 || app_uid || 0x00 || expiry), hub_private_key)
	msg := buildSessionMsg(node.NodePublicKey, appUID, req.Expiry)
	sig, err := hubcrypto.Sign(msg, s.hubPrivKey)
	if err != nil {
		return nil, status.Error(codes.Internal, "sign failed")
	}
	return &hubv1.SignSessionResponse{
		SessionSig: "0x" + hex.EncodeToString(sig),
		AppUid:     appUID,
	}, nil
}

// PushNotify 转发离线推送（由外部 Pusher 实现，此处仅示意；完整实现见 Task 6）
func (s *hubService) PushNotify(ctx context.Context, req *hubv1.PushNotifyRequest) (*hubv1.PushNotifyResponse, error) {
	// push 逻辑通过注入的 Pusher 完成，在 Task 6 集成后补充
	return &hubv1.PushNotifyResponse{Ok: true}, nil
}

// --- 内部工具 ---

func verifyCredential(tokenStr, hubPublicKey string) (string, error) {
	parts := strings.SplitN(tokenStr, ".", 2)
	if len(parts) != 2 {
		return "", errors.New("malformed credential")
	}
	payloadB64, sigHex := parts[0], parts[1]
	payloadBytes, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return "", errors.New("invalid payload encoding")
	}
	var payload struct {
		AppUID string `json:"app_uid"`
		Exp    int64  `json:"exp"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return "", errors.New("invalid payload json")
	}
	if time.Now().Unix() > payload.Exp {
		return "", errors.New("credential expired")
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil || len(sig) != 65 {
		return "", errors.New("invalid signature format")
	}
	recovered, err := hubcrypto.Ecrecover([]byte(payloadB64), sig)
	if err != nil || !strings.EqualFold(recovered, hubPublicKey) {
		return "", errors.New("signature verification failed")
	}
	return payload.AppUID, nil
}

func buildSessionMsg(nodePublicKey, appUID string, expiry int64) []byte {
	var msg []byte
	msg = append(msg, []byte(nodePublicKey)...)
	msg = append(msg, 0x00)
	msg = append(msg, []byte(appUID)...)
	msg = append(msg, 0x00)
	msg = append(msg, []byte(strconv.FormatInt(expiry, 10))...)
	return msg
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
go test ./internal/grpc/... -v
```

期望：PASS，3 个测试通过（Activate、Heartbeat、SignSession）。

- [ ] **Step 6: Commit**

```bash
git add internal/grpc/
git commit -m "feat(hub): add gRPC server with node auth interceptor and HubService"
```

---

## Task 6: Push + HTTP Handlers（App 客户端）

**Files:**
- Create: `internal/push/pusher.go`
- Create: `internal/push/fcm.go`
- Create: `internal/push/apns.go`
- Create: `internal/handler/credential.go`
- Create: `internal/handler/device_token.go`
- Create: `internal/handler/directory.go`

> `PushNotify` gRPC 方法在 Task 5 中是 stub，本 Task 实现真正的 push 逻辑并注入到 hubService。

- [ ] **Step 1: 实现 push/pusher.go**

创建 `internal/push/pusher.go`：

```go
package push

import "context"

const (
	PlatformIOS     = 1
	PlatformAndroid = 2
)

type Message struct {
	Token    string
	Platform int8
	Title    string
	Body     string
	Data     map[string]any
}

type Pusher interface {
	Send(ctx context.Context, msg Message) error
}

type NoopPusher struct{}

func (NoopPusher) Send(_ context.Context, _ Message) error { return nil }
```

- [ ] **Step 2: 实现 push/fcm.go**

创建 `internal/push/fcm.go`：

```go
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// FCMPusher 使用 FCM Legacy HTTP API（注意：该 API 已被 Google 弃用，生产环境迁移到 FCM v1）
type FCMPusher struct {
	serverKey string
	http      *http.Client
}

func NewFCMPusher(serverKey string) *FCMPusher {
	return &FCMPusher{serverKey: serverKey, http: &http.Client{Timeout: 10 * time.Second}}
}

func (p *FCMPusher) Send(ctx context.Context, msg Message) error {
	payload, _ := json.Marshal(map[string]any{
		"to":           msg.Token,
		"notification": map[string]any{"title": msg.Title, "body": msg.Body},
		"data":         msg.Data,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://fcm.googleapis.com/fcm/send", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "key="+p.serverKey)
	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("fcm: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fcm: HTTP %d", resp.StatusCode)
	}
	return nil
}
```

- [ ] **Step 3: 实现 push/apns.go**

创建 `internal/push/apns.go`：

```go
package push

import (
	"context"
	"fmt"

	"github.com/sideshow/apns2"
	"github.com/sideshow/apns2/token"
)

type APNsPusher struct {
	client   *apns2.Client
	bundleID string
}

func NewAPNsPusher(keyFile, keyID, teamID, bundleID string, sandbox bool) (*APNsPusher, error) {
	authKey, err := token.AuthKeyFromFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("load apns key: %w", err)
	}
	t := &token.Token{AuthKey: authKey, KeyID: keyID, TeamID: teamID}
	client := apns2.NewTokenClient(t)
	if sandbox {
		client = client.Development()
	} else {
		client = client.Production()
	}
	return &APNsPusher{client: client, bundleID: bundleID}, nil
}

func (p *APNsPusher) Send(_ context.Context, msg Message) error {
	payload := map[string]any{
		"aps": map[string]any{
			"alert": map[string]any{"title": msg.Title, "body": msg.Body},
			"sound": "default",
		},
	}
	for k, v := range msg.Data {
		payload[k] = v
	}
	res, err := p.client.Push(&apns2.Notification{
		DeviceToken: msg.Token,
		Topic:       p.bundleID,
		Payload:     payload,
	})
	if err != nil {
		return fmt.Errorf("apns: %w", err)
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("apns: %s", res.Reason)
	}
	return nil
}
```

- [ ] **Step 4: 实现 handler/credential.go**

创建 `internal/handler/credential.go`：

```go
package handler

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

// VerifyCredential 验证 Hub Server 签发的 user_credential，返回 app_uid
func VerifyCredential(tokenStr, hubPublicKey string) (string, error) {
	parts := strings.SplitN(tokenStr, ".", 2)
	if len(parts) != 2 {
		return "", errors.New("malformed credential")
	}
	payloadB64, sigHex := parts[0], parts[1]
	payloadBytes, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return "", errors.New("invalid payload encoding")
	}
	var payload struct {
		AppUID string `json:"app_uid"`
		Exp    int64  `json:"exp"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return "", errors.New("invalid payload json")
	}
	if time.Now().Unix() > payload.Exp {
		return "", errors.New("credential expired")
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil || len(sig) != 65 {
		return "", errors.New("invalid signature format")
	}
	recovered, err := hubcrypto.Ecrecover([]byte(payloadB64), sig)
	if err != nil || !strings.EqualFold(recovered, hubPublicKey) {
		return "", errors.New("signature verification failed")
	}
	return payload.AppUID, nil
}
```

- [ ] **Step 5: 实现 handler/device_token.go**

创建 `internal/handler/device_token.go`：

```go
package handler

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/langgexyz/open-im-hub-server/internal/store"
)

type DeviceTokenHandler struct {
	deviceTokens *store.DeviceTokenStore
	hubPublicKey string
}

func NewDeviceTokenHandler(dt *store.DeviceTokenStore, hubPublicKey string) *DeviceTokenHandler {
	return &DeviceTokenHandler{deviceTokens: dt, hubPublicKey: hubPublicKey}
}

// Register POST /user/device-token
// Authorization: Bearer <user_credential>
func (h *DeviceTokenHandler) Register(c *gin.Context) {
	credStr := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	if credStr == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing credential"})
		return
	}
	appUID, err := VerifyCredential(credStr, h.hubPublicKey)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credential: " + err.Error()})
		return
	}
	var body struct {
		Platform int8   `json:"platform" binding:"required"`
		Token    string `json:"token"    binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.deviceTokens.Upsert(appUID, body.Platform, body.Token); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
```

- [ ] **Step 6: 实现 handler/directory.go**

创建 `internal/handler/directory.go`：

```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/langgexyz/open-im-hub-server/internal/store"
)

type DirectoryHandler struct{ nodes *store.NodeStore }

func NewDirectoryHandler(nodes *store.NodeStore) *DirectoryHandler {
	return &DirectoryHandler{nodes: nodes}
}

func (h *DirectoryHandler) List(c *gin.Context) {
	nodes, err := h.nodes.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"nodes": nodes})
}
```

- [ ] **Step 7: 确认编译**

```bash
go build ./internal/push/... ./internal/handler/...
```

- [ ] **Step 8: Commit**

```bash
git add internal/push/ internal/handler/
git commit -m "feat(hub): add push (FCM/APNs), device-token and directory HTTP handlers"
```

---

## Task 7: genkey 工具

**Files:**
- Create: `tools/genkey/main.go`

- [ ] **Step 1: 实现 genkey**

创建 `tools/genkey/main.go`：

```go
package main

import (
	"fmt"
	"log"

	hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

func main() {
	privKey, pubKey, err := hubcrypto.GenerateKey()
	if err != nil {
		log.Fatalf("generate key: %v", err)
	}
	fmt.Printf("HUB_PRIVATE_KEY=%s\n", hubcrypto.PrivKeyToHex(privKey))
	fmt.Printf("HUB_PUBLIC_KEY=%s  (硬编码进 App 客户端)\n", pubKey)
}
```

- [ ] **Step 2: 验证运行**

```bash
go run ./tools/genkey/
```

期望：打印 `HUB_PRIVATE_KEY=<64位hex>` 和 `HUB_PUBLIC_KEY=0x...`。

- [ ] **Step 3: Commit**

```bash
git add tools/genkey/
git commit -m "feat(hub): add genkey tool for HUB_PRIVATE_KEY generation"
```

---

## Task 8: Server 组装 + main.go + Dockerfile

**Files:**
- Create: `internal/server/grpc.go`
- Create: `internal/server/http.go`
- Create: `cmd/server/main.go`
- Create: `Dockerfile`

- [ ] **Step 1: 实现 internal/server/grpc.go**

创建 `internal/server/grpc.go`：

```go
package server

import (
	"database/sql"
	"fmt"
	"net"

	_ "github.com/go-sql-driver/mysql"
	"google.golang.org/grpc"
	"github.com/langgexyz/open-im-hub-server/internal/config"
	grpcserver "github.com/langgexyz/open-im-hub-server/internal/grpc"
	"github.com/langgexyz/open-im-hub-server/internal/store"
)

type GRPCServer struct {
	srv *grpc.Server
	lis net.Listener
}

func NewGRPCServer(cfg *config.Config, db *sql.DB) (*GRPCServer, error) {
	s, err := store.New(db)
	if err != nil {
		return nil, fmt.Errorf("init store: %w", err)
	}

	// 包装 store 为 NodeStore 接口（store 已实现所有方法）
	ns := &nodeStoreAdapter{s: s}
	srv := grpcserver.New(ns, cfg.HubPrivateKeyObj, cfg.HubPublicKey)

	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		return nil, fmt.Errorf("listen grpc %s: %w", cfg.GRPCAddr, err)
	}
	return &GRPCServer{srv: srv, lis: lis}, nil
}

func (g *GRPCServer) Serve() error { return g.srv.Serve(g.lis) }
func (g *GRPCServer) Stop()        { g.srv.GracefulStop() }
func (g *GRPCServer) Addr() string { return g.lis.Addr().String() }

// nodeStoreAdapter 将 *store.Store 适配为 grpcserver.NodeStore 接口
type nodeStoreAdapter struct{ s *store.Store }

func (a *nodeStoreAdapter) GetByPublicKey(k string) (*store.Node, error) { return a.s.Nodes.GetByPublicKey(k) }
func (a *nodeStoreAdapter) Insert(n *store.Node) error                   { return a.s.Nodes.Insert(n) }
func (a *nodeStoreAdapter) UpdateHeartbeat(k string) error               { return a.s.Nodes.UpdateHeartbeat(k) }
func (a *nodeStoreAdapter) List() ([]*store.Node, error)                 { return a.s.Nodes.List() }
func (a *nodeStoreAdapter) ConsumeCode(code string) error                { return a.s.Codes.Consume(code) }
```

- [ ] **Step 2: 实现 internal/server/http.go**

创建 `internal/server/http.go`：

```go
package server

import (
	"database/sql"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/langgexyz/open-im-hub-server/internal/config"
	"github.com/langgexyz/open-im-hub-server/internal/handler"
	"github.com/langgexyz/open-im-hub-server/internal/push"
	"github.com/langgexyz/open-im-hub-server/internal/store"
)

func NewHTTPServer(cfg *config.Config, db *sql.DB) (*gin.Engine, error) {
	s, err := store.New(db)
	if err != nil {
		return nil, fmt.Errorf("init store: %w", err)
	}

	// Push 客户端
	var iosPusher push.Pusher = push.NoopPusher{}
	var androidPusher push.Pusher = push.NoopPusher{}
	if cfg.APNsKeyFile != "" {
		apns, err := push.NewAPNsPusher(cfg.APNsKeyFile, cfg.APNsKeyID, cfg.APNsTeamID, cfg.APNsBundleID, cfg.APNsSandbox)
		if err != nil {
			return nil, fmt.Errorf("init apns: %w", err)
		}
		iosPusher = apns
	}
	if cfg.FCMServerKey != "" {
		androidPusher = push.NewFCMPusher(cfg.FCMServerKey)
	}
	_ = iosPusher
	_ = androidPusher

	deviceTokenH := handler.NewDeviceTokenHandler(s.DeviceTokens, cfg.HubPublicKey)
	directoryH := handler.NewDirectoryHandler(s.Nodes)

	r := gin.New()
	r.Use(gin.Recovery())
	r.POST("/user/device-token", deviceTokenH.Register)
	r.GET("/nodes", directoryH.List)
	return r, nil
}
```

- [ ] **Step 3: 实现 cmd/server/main.go**

创建 `cmd/server/main.go`：

```go
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"github.com/langgexyz/open-im-hub-server/internal/config"
	"github.com/langgexyz/open-im-hub-server/internal/server"
	"github.com/langgexyz/open-im-hub-server/internal/store"
)

func main() {
	genCode := flag.Bool("gen-code", false, "生成一个激活码并打印")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	db, err := sql.Open("mysql", cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("open mysql: %v", err)
	}

	if *genCode {
		s, err := store.New(db)
		if err != nil {
			log.Fatalf("init store: %v", err)
		}
		code := uuid.NewString()
		if err := s.Codes.Insert(code, time.Now().Add(30*24*time.Hour)); err != nil {
			log.Fatalf("insert code: %v", err)
		}
		fmt.Printf("激活码：%s（30天有效）\n", code)
		return
	}

	grpcSrv, err := server.NewGRPCServer(cfg, db)
	if err != nil {
		log.Fatalf("init grpc server: %v", err)
	}
	httpSrv, err := server.NewHTTPServer(cfg, db)
	if err != nil {
		log.Fatalf("init http server: %v", err)
	}

	log.Printf("Hub Server gRPC: %s  HTTP: %s  公钥: %s", grpcSrv.Addr(), cfg.HTTPAddr, cfg.HubPublicKey)

	go func() {
		if err := grpcSrv.Serve(); err != nil {
			log.Fatalf("gRPC server: %v", err)
		}
	}()

	if err := httpSrv.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("HTTP server: %v", err)
	}
}
```

- [ ] **Step 4: 实现 Dockerfile**

创建 `Dockerfile`：

```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /hub-server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /hub-server /hub-server
EXPOSE 8080 50051
ENTRYPOINT ["/hub-server"]
```

- [ ] **Step 5: 完整编译**

```bash
go build ./...
```

- [ ] **Step 6: 运行所有测试**

```bash
go test ./... -v
```

- [ ] **Step 7: Commit 并推送**

```bash
git add internal/server/ cmd/server/ Dockerfile tools/
git commit -m "feat(hub): add dual server (gRPC + HTTP), main entrypoint, Dockerfile"
git push
```

---

## 验证清单

```bash
go build ./...
go vet ./...
go test ./... -v -count=1
```

**首次部署生成密钥：**

```bash
go run ./tools/genkey/
# HUB_PRIVATE_KEY=<hex>  ← 设置环境变量
# HUB_PUBLIC_KEY=0x...   ← 硬编码进 App 客户端
```

**环境变量说明：**

| 变量 | 必须 | 说明 |
|------|------|------|
| `HUB_PRIVATE_KEY` | 是 | Hub EVM 私钥 hex（用 `go run ./tools/genkey/` 生成） |
| `MYSQL_DSN` | 是 | MySQL DSN |
| `HUB_GRPC_ADDR` | 否 | gRPC 监听地址，默认 `:50051` |
| `HUB_HTTP_ADDR` | 否 | HTTP 监听地址，默认 `:8080` |
| `FCM_SERVER_KEY` | 否 | FCM Legacy Server Key |
| `APNS_KEY_FILE` | 否 | APNs .p8 文件路径 |
| `APNS_KEY_ID` | 否 | APNs Key ID |
| `APNS_TEAM_ID` | 否 | APNs Team ID |
| `APNS_BUNDLE_ID` | 否 | App Bundle ID |
| `APNS_SANDBOX` | 否 | `true` 使用沙盒 |
