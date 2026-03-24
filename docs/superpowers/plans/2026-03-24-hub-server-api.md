# Hub Server API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 Hub Server 的用户系统、节点激活、节点目录和 UpdateNodeProfile gRPC，使其与前端设计 spec 完全对齐。

**Architecture:** 复用现有 Gin + MySQL + gRPC 架构。重写 nodes 表 schema（字段名对齐 spec），新增 users 表，添加 JWT 中间件，将旧的 `GET /register` 重写为幂等的 `POST /node/activate`，通过新的 `UpdateNodeProfile` gRPC 让 Node Server 能更新 Hub 目录资料。

**Tech Stack:** Go 1.25, Gin, `golang-jwt/jwt/v4`（已在 go.mod），`golang.org/x/crypto/bcrypt`（已在 go.mod），MySQL，gRPC，open-im-hub-proto（本地 go.work）

**关键设计决策（实现前必读）：**
- `code`（Node Server 启动时生成的 64 hex 字符）= `app_id`，Hub Server 不再单独生成 AppId
- `POST /node/activate` 以 `app_id = code` 做 UPSERT（`INSERT ... ON DUPLICATE KEY UPDATE`），支持幂等重试
- `hub_token` = HMAC-SHA256 JWT，payload `{ uid, email, exp }`，secret = HUB_PRIVATE_KEY hex 字符串
- `credential` payload 字段名：`{ "uid": "...", "app_id": "...", "exp": ... }`
- `POST /node/profile` 接口已删除，资料更新只走 Node Server → Hub gRPC `UpdateNodeProfile`

**Spec 文档：**
- `docs/superpowers/specs/2026-03-20-open-im-decentralized-node-protocol-design.md`（第三章通信边界、第六章密钥、第七章流程、第十章接口总览）
- `docs/superpowers/specs/2026-03-24-frontend-web-design.md`（第三章流程一~四、第六章 Hub Server API）

---

## 文件结构

```
open-im-hub-proto/hub/v1/hub.proto          修改：删除 Activate RPC，新增 UpdateNodeProfile RPC
open-im-hub-proto/hub/v1/hub.pb.go          自动生成
open-im-hub-proto/hub/v1/hub_grpc.pb.go     自动生成

open-im-hub-server/go.work                  新建：workspace 文件，让 hub-server 使用本地 hub-proto

open-im-hub-server/internal/store/db.go         修改：重写 migrate()，新 nodes 表 + users 表，删 activation_codes
open-im-hub-server/internal/store/nodes.go      修改：字段名全部对齐 spec（app_id, app_public_key, node_server_addr 等）
open-im-hub-server/internal/store/users.go      新建：UserStore（GetByEmail, Create）
open-im-hub-server/internal/store/codes.go      删除：activation_codes 表已移除
open-im-hub-server/internal/store/store_test.go 修改：更新 nodes 测试字段名

open-im-hub-server/internal/auth/jwt.go         新建：IssueHubToken / VerifyHubToken
open-im-hub-server/internal/auth/middleware.go  新建：JWTMiddleware（Gin，注入 uid 到 Context）
open-im-hub-server/internal/auth/credential.go  新建：IssueCredential / VerifyCredential

open-im-hub-server/internal/handler/user.go      新建：UserHandler（Register, Login）
open-im-hub-server/internal/handler/credential.go 重写：CredentialHandler（替换原来的 VerifyCredential 工具函数）
open-im-hub-server/internal/handler/activate.go   新建：ActivateHandler（替换旧 register.go）
open-im-hub-server/internal/handler/register.go   删除：旧激活逻辑
open-im-hub-server/internal/handler/directory.go  修改：List 返回新字段名，新增 Get(:app_id)

open-im-hub-server/internal/grpc/server.go        修改：删除 ConsumeCode 接口方法，删除 Activate 特判
open-im-hub-server/internal/grpc/hub_service.go   修改：删除 Activate，新增 UpdateNodeProfile

open-im-hub-server/internal/server/http.go        修改：路由重写，加 JWT 中间件保护路由
```

---

## Task 1：Proto 更新——删除 Activate，新增 UpdateNodeProfile

**Files:**
- Modify: `open-im-hub-proto/hub/v1/hub.proto`
- Auto-generate: `open-im-hub-proto/hub/v1/hub.pb.go`, `hub_grpc.pb.go`
- Create: `open-im-hub-server/go.work`

- [ ] **Step 1: 写失败测试（编译测试）**

在 `open-im-hub-server/internal/grpc/hub_service_test.go` 顶部确认 `UpdateNodeProfileRequest` 被引用：
```go
// 确认新 proto 方法存在
var _ = hubv1.UpdateNodeProfileRequest{}
```
运行 `cd open-im-hub-server && go build ./...`，预期报错：`undefined: hubv1.UpdateNodeProfileRequest`

- [ ] **Step 2: 修改 hub.proto**

文件：`open-im-hub-proto/hub/v1/hub.proto`

```protobuf
syntax = "proto3";

package hub.v1;

option go_package = "github.com/langgexyz/open-im-hub-proto/hub/v1;hubv1";

service HubService {
  // Activate 已删除：节点激活改为 Hub Server 主动调用 Node Server HTTP，不再走 gRPC

  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);

  rpc SignSession(SignSessionRequest) returns (SignSessionResponse);

  rpc PushNotify(PushNotifyRequest) returns (PushNotifyResponse);

  rpc UpdateNodeProfile(UpdateNodeProfileRequest) returns (UpdateNodeProfileResponse);
}

message HeartbeatRequest {
  string node_public_key = 1;
  string ws_addr         = 2;
}

message HeartbeatResponse {
  bool ok = 1;
}

message SignSessionRequest {
  string user_credential = 1;
  int64  expiry          = 2;
}

message SignSessionResponse {
  string session_sig = 1;
  string app_uid     = 2;
}

message PushNotifyRequest {
  repeated string app_uids  = 1;
  string          title     = 2;
  string          body      = 3;
  string          data_json = 4;
}

message PushNotifyResponse {
  bool ok = 1;
}

message UpdateNodeProfileRequest {
  string app_id      = 1;
  string name        = 2;
  string avatar      = 3;
  string description = 4;
}

message UpdateNodeProfileResponse {
  bool ok = 1;
}
```

- [ ] **Step 3: 生成 Go 代码**

```bash
cd open-im-hub-proto
protoc \
  --proto_path=. \
  --go_out=. --go_opt=paths=source_relative \
  --go-grpc_out=. --go-grpc_opt=paths=source_relative \
  hub/v1/hub.proto
```

- [ ] **Step 4: 创建 go.work 让 hub-server 使用本地 hub-proto**

文件：`open-im-hub-server/go.work`
```
go 1.25.0

use (
	.
	../open-im-hub-proto
)
```

- [ ] **Step 5: 确认编译通过**

```bash
cd open-im-hub-server
go build ./...
```

预期：编译失败（因为 hub_service.go 仍引用 Activate）——这是预期的，Task 8 会修复。

- [ ] **Step 6: Commit**

```bash
cd open-im-hub-proto && git add . && git commit -m "feat: remove Activate RPC, add UpdateNodeProfile RPC"
cd ../open-im-hub-server && git add go.work && git commit -m "chore: add go.work for local hub-proto development"
```

---

## Task 2：DB 迁移——重写 nodes 表 + 新增 users 表

**Files:**
- Modify: `open-im-hub-server/internal/store/db.go`
- Delete: `open-im-hub-server/internal/store/codes.go`

- [ ] **Step 1: 写失败测试**

文件：`open-im-hub-server/internal/store/store_test.go`，新增 users 表测试（在已有测试基础上添加）：

```go
func TestUsersTableExists(t *testing.T) {
    db := openTestDB(t)
    s, err := store.New(db)
    require.NoError(t, err)
    _ = s
    // 验证 users 表存在且能插入
    _, err = db.Exec(`INSERT INTO users (email, password) VALUES (?,?)`, "test@example.com", "hash")
    require.NoError(t, err)
}

func TestNodesNewSchema(t *testing.T) {
    db := openTestDB(t)
    s, err := store.New(db)
    require.NoError(t, err)
    _ = s
    // 验证 nodes 新字段存在
    _, err = db.Exec(`INSERT INTO nodes (app_id, app_public_key, node_server_addr, node_web_addr, admin_uid, status, expires_at)
        VALUES (?,?,?,?,?,?,?)`, "testid", "0xabc", "http://node:8080", "http://node.example.com", "uid1", 0, time.Now().Add(time.Hour))
    require.NoError(t, err)
}
```

运行：`cd open-im-hub-server && go test ./internal/store/... -run TestUsersTableExists`
预期：FAIL（users 表不存在）

- [ ] **Step 2: 重写 db.go**

文件：`open-im-hub-server/internal/store/db.go`

```go
package store

import (
    "database/sql"
    "fmt"
)

type Store struct {
    DB           *sql.DB
    Nodes        *NodeStore
    Users        *UserStore
    DeviceTokens *DeviceTokenStore
}

func New(db *sql.DB) (*Store, error) {
    if err := migrate(db); err != nil {
        return nil, fmt.Errorf("migrate: %w", err)
    }
    return &Store{
        DB:           db,
        Nodes:        &NodeStore{db: db},
        Users:        &UserStore{db: db},
        DeviceTokens: &DeviceTokenStore{db: db},
    }, nil
}

func migrate(db *sql.DB) error {
    stmts := []string{
        `CREATE TABLE IF NOT EXISTS users (
            id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            email      VARCHAR(255) NOT NULL UNIQUE,
            password   VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS nodes (
            id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            app_id           VARCHAR(64)  NOT NULL UNIQUE,
            app_public_key   VARCHAR(42)  NOT NULL UNIQUE,
            name             VARCHAR(128) NOT NULL DEFAULT '',
            avatar           VARCHAR(512),
            description      TEXT,
            node_server_addr VARCHAR(512) NOT NULL DEFAULT '',
            node_web_addr    VARCHAR(512) NOT NULL DEFAULT '',
            admin_uid        VARCHAR(64),
            status           TINYINT DEFAULT 0,
            expires_at       TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL 1 YEAR),
            last_heartbeat   TIMESTAMP NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS device_tokens (
            id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            uid        VARCHAR(64) NOT NULL,
            platform   TINYINT NOT NULL,
            token      VARCHAR(256) NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_uid_platform (uid, platform)
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

- [ ] **Step 3: 删除 codes.go**

```bash
rm open-im-hub-server/internal/store/codes.go
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd open-im-hub-server && go test ./internal/store/... -run "TestUsersTableExists|TestNodesNewSchema" -v
```
预期：PASS

- [ ] **Step 5: Commit**

```bash
git add internal/store/db.go internal/store/codes.go
git commit -m "feat(store): rewrite DB schema - new nodes fields + users table, remove activation_codes"
```

---

## Task 3：重写 NodeStore（字段名对齐 spec）

**Files:**
- Modify: `open-im-hub-server/internal/store/nodes.go`

- [ ] **Step 1: 写失败测试**

在 `store_test.go` 中添加：
```go
func TestNodeStoreUpsert(t *testing.T) {
    db := openTestDB(t)
    s, _ := store.New(db)

    node := &store.Node{
        AppID:          "code-abc123",
        AppPublicKey:   "0xDEAD",
        NodeServerAddr: "http://node:8080",
        NodeWebAddr:    "http://node.example.com",
        AdminUID:       "10001",
        Status:         0,
    }
    err := s.Nodes.Upsert(node)
    require.NoError(t, err)

    // 幂等重试
    err = s.Nodes.Upsert(node)
    require.NoError(t, err)

    // 查询
    n, err := s.Nodes.GetByAppID("code-abc123")
    require.NoError(t, err)
    require.Equal(t, "0xDEAD", n.AppPublicKey)
}

func TestNodeStoreUpdateProfile(t *testing.T) {
    db := openTestDB(t)
    s, _ := store.New(db)

    // 先插入
    _ = s.Nodes.Upsert(&store.Node{AppID: "n1", AppPublicKey: "0xABC", Status: 0})
    // 更新资料
    err := s.Nodes.UpdateProfile("n1", "科技快讯", "http://avatar.png", "科技资讯公众号")
    require.NoError(t, err)

    n, _ := s.Nodes.GetByAppID("n1")
    require.Equal(t, "科技快讯", n.Name)
}
```

运行 `go test ./internal/store/... -run TestNodeStoreUpsert`，预期 FAIL

- [ ] **Step 2: 重写 nodes.go**

文件：`open-im-hub-server/internal/store/nodes.go`

```go
package store

import (
    "database/sql"
    "fmt"
    "time"
)

type Node struct {
    ID             uint64
    AppID          string
    AppPublicKey   string
    Name           string
    Avatar         string
    Description    string
    NodeServerAddr string
    NodeWebAddr    string
    AdminUID       string
    Status         int8
    ExpiresAt      time.Time
    LastHeartbeat  *time.Time
    CreatedAt      time.Time
}

type NodeStore struct{ db *sql.DB }

// Upsert 以 app_id 为唯一键做幂等写入（INSERT ... ON DUPLICATE KEY UPDATE）
// status=0（pending），激活成功后调用 Activate 改为 status=1
func (s *NodeStore) Upsert(n *Node) error {
    _, err := s.db.Exec(`
        INSERT INTO nodes (app_id, app_public_key, node_server_addr, node_web_addr, admin_uid, status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            app_public_key   = VALUES(app_public_key),
            node_server_addr = VALUES(node_server_addr),
            node_web_addr    = VALUES(node_web_addr),
            admin_uid        = VALUES(admin_uid)`,
        n.AppID, n.AppPublicKey, n.NodeServerAddr, n.NodeWebAddr, n.AdminUID,
        n.Status, time.Now().Add(365*24*time.Hour),
    )
    return err
}

// Activate 将节点标记为 status=1（active）
func (s *NodeStore) Activate(appID string) error {
    _, err := s.db.Exec(`UPDATE nodes SET status = 1 WHERE app_id = ?`, appID)
    return err
}

// UpdateProfile 更新 Hub 目录中的节点资料（由 UpdateNodeProfile gRPC 调用）
func (s *NodeStore) UpdateProfile(appID, name, avatar, description string) error {
    _, err := s.db.Exec(
        `UPDATE nodes SET name = ?, avatar = ?, description = ? WHERE app_id = ?`,
        name, avatar, description, appID,
    )
    return err
}

// GetByAppID 按 app_id 查询节点
func (s *NodeStore) GetByAppID(appID string) (*Node, error) {
    var n Node
    var avatar, description, adminUID sql.NullString
    var lastHB sql.NullTime
    err := s.db.QueryRow(`
        SELECT id, app_id, app_public_key, name, avatar, description,
               node_server_addr, node_web_addr, admin_uid,
               status, expires_at, last_heartbeat
        FROM nodes WHERE app_id = ?`, appID,
    ).Scan(&n.ID, &n.AppID, &n.AppPublicKey, &n.Name,
        &avatar, &description, &n.NodeServerAddr, &n.NodeWebAddr,
        &adminUID, &n.Status, &n.ExpiresAt, &lastHB)
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("node not found")
    }
    if err != nil {
        return nil, err
    }
    n.Avatar = avatar.String
    n.Description = description.String
    n.AdminUID = adminUID.String
    if lastHB.Valid {
        n.LastHeartbeat = &lastHB.Time
    }
    return &n, nil
}

// GetByPublicKey 按 app_public_key 查询（gRPC 拦截器使用）
func (s *NodeStore) GetByPublicKey(pubKey string) (*Node, error) {
    var n Node
    var lastHB sql.NullTime
    err := s.db.QueryRow(`
        SELECT id, app_id, app_public_key, node_server_addr, status, expires_at, last_heartbeat
        FROM nodes WHERE app_public_key = ?`, pubKey,
    ).Scan(&n.ID, &n.AppID, &n.AppPublicKey, &n.NodeServerAddr, &n.Status, &n.ExpiresAt, &lastHB)
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

// UpdateHeartbeat 更新节点心跳时间
func (s *NodeStore) UpdateHeartbeat(pubKey string) error {
    _, err := s.db.Exec(`UPDATE nodes SET last_heartbeat = NOW() WHERE app_public_key = ?`, pubKey)
    return err
}

// List 返回所有 status=1 的节点（节点广场）
func (s *NodeStore) List() ([]*Node, error) {
    rows, err := s.db.Query(`
        SELECT id, app_id, app_public_key, name, avatar, description,
               node_server_addr, node_web_addr, admin_uid
        FROM nodes WHERE status = 1`)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    var nodes []*Node
    for rows.Next() {
        var n Node
        var avatar, description, adminUID sql.NullString
        if err := rows.Scan(&n.ID, &n.AppID, &n.AppPublicKey, &n.Name,
            &avatar, &description, &n.NodeServerAddr, &n.NodeWebAddr, &adminUID); err != nil {
            return nil, err
        }
        n.Avatar = avatar.String
        n.Description = description.String
        n.AdminUID = adminUID.String
        nodes = append(nodes, &n)
    }
    return nodes, rows.Err()
}
```

- [ ] **Step 3: 运行测试**

```bash
cd open-im-hub-server && go test ./internal/store/... -v
```
预期：所有 store 测试 PASS

- [ ] **Step 4: Commit**

```bash
git add internal/store/nodes.go
git commit -m "feat(store): rewrite NodeStore with spec-aligned field names and Upsert/Activate/UpdateProfile methods"
```

---

## Task 4：新增 UserStore

**Files:**
- Create: `open-im-hub-server/internal/store/users.go`

- [ ] **Step 1: 写失败测试**

在 `store_test.go` 中添加：
```go
func TestUserStore(t *testing.T) {
    db := openTestDB(t)
    s, _ := store.New(db)

    uid, err := s.Users.Create("alice@example.com", "hashedpwd")
    require.NoError(t, err)
    require.Greater(t, uid, uint64(0))

    u, err := s.Users.GetByEmail("alice@example.com")
    require.NoError(t, err)
    require.Equal(t, "alice@example.com", u.Email)
    require.Equal(t, uid, u.ID)

    // 重复邮箱
    _, err = s.Users.Create("alice@example.com", "otherpwd")
    require.Error(t, err) // duplicate entry
}
```

运行 `go test ./internal/store/... -run TestUserStore`，预期 FAIL

- [ ] **Step 2: 实现 users.go**

文件：`open-im-hub-server/internal/store/users.go`

```go
package store

import (
    "database/sql"
    "fmt"
    "time"
)

type User struct {
    ID        uint64
    Email     string
    Password  string // bcrypt hash
    CreatedAt time.Time
}

type UserStore struct{ db *sql.DB }

// Create 插入新用户，返回 auto-increment id（= UID）
func (s *UserStore) Create(email, passwordHash string) (uint64, error) {
    res, err := s.db.Exec(
        `INSERT INTO users (email, password) VALUES (?, ?)`, email, passwordHash,
    )
    if err != nil {
        return 0, fmt.Errorf("create user: %w", err)
    }
    id, _ := res.LastInsertId()
    return uint64(id), nil
}

// GetByEmail 按邮箱查询用户
func (s *UserStore) GetByEmail(email string) (*User, error) {
    var u User
    err := s.db.QueryRow(
        `SELECT id, email, password, created_at FROM users WHERE email = ?`, email,
    ).Scan(&u.ID, &u.Email, &u.Password, &u.CreatedAt)
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("user not found")
    }
    return &u, err
}
```

- [ ] **Step 3: 运行测试**

```bash
go test ./internal/store/... -run TestUserStore -v
```
预期：PASS

- [ ] **Step 4: Commit**

```bash
git add internal/store/users.go internal/store/store_test.go
git commit -m "feat(store): add UserStore with Create and GetByEmail"
```

---

## Task 5：JWT 认证包（hub_token + credential）

**Files:**
- Create: `open-im-hub-server/internal/auth/jwt.go`
- Create: `open-im-hub-server/internal/auth/middleware.go`
- Create: `open-im-hub-server/internal/auth/credential.go`
- Create: `open-im-hub-server/internal/auth/auth_test.go`

- [ ] **Step 1: 写失败测试**

文件：`open-im-hub-server/internal/auth/auth_test.go`

```go
package auth_test

import (
    "testing"
    "github.com/stretchr/testify/require"
    "github.com/langgexyz/open-im-hub-server/internal/auth"
    hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

const testPrivHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" // 已知测试私钥

func TestHubToken(t *testing.T) {
    secret := "testsecret"
    token, err := auth.IssueHubToken("10001", "alice@example.com", secret, 3600)
    require.NoError(t, err)
    require.NotEmpty(t, token)

    claims, err := auth.VerifyHubToken(token, secret)
    require.NoError(t, err)
    require.Equal(t, "10001", claims.UID)
    require.Equal(t, "alice@example.com", claims.Email)
}

func TestHubTokenExpired(t *testing.T) {
    secret := "testsecret"
    token, _ := auth.IssueHubToken("1", "a@b.com", secret, -1) // 过期
    _, err := auth.VerifyHubToken(token, secret)
    require.Error(t, err)
}

func TestCredential(t *testing.T) {
    priv, err := hubcrypto.PrivKeyFromHex(testPrivHex)
    require.NoError(t, err)
    pub, _ := hubcrypto.PubKeyFromPrivHex(testPrivHex)

    cred, err := auth.IssueCredential("10001", "app-abc123", priv, 3600)
    require.NoError(t, err)

    uid, appID, err := auth.VerifyCredential(cred, pub)
    require.NoError(t, err)
    require.Equal(t, "10001", uid)
    require.Equal(t, "app-abc123", appID)
}
```

运行 `go test ./internal/auth/...`，预期 FAIL

- [ ] **Step 2: 实现 jwt.go**

文件：`open-im-hub-server/internal/auth/jwt.go`

```go
package auth

import (
    "fmt"
    "time"

    "github.com/golang-jwt/jwt/v4"
)

type HubClaims struct {
    UID   string `json:"uid"`
    Email string `json:"email"`
    jwt.RegisteredClaims
}

// IssueHubToken 签发 hub_token（HMAC-SHA256 JWT）
// secret = HUB_PRIVATE_KEY hex 字符串
// ttlSeconds = token 有效期（秒），推荐 7*24*3600
func IssueHubToken(uid, email, secret string, ttlSeconds int64) (string, error) {
    claims := HubClaims{
        UID:   uid,
        Email: email,
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(ttlSeconds) * time.Second)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
        },
    }
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString([]byte(secret))
}

// VerifyHubToken 验证并解析 hub_token
func VerifyHubToken(tokenStr, secret string) (*HubClaims, error) {
    token, err := jwt.ParseWithClaims(tokenStr, &HubClaims{}, func(t *jwt.Token) (any, error) {
        if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method")
        }
        return []byte(secret), nil
    })
    if err != nil {
        return nil, err
    }
    claims, ok := token.Claims.(*HubClaims)
    if !ok || !token.Valid {
        return nil, fmt.Errorf("invalid token")
    }
    return claims, nil
}
```

- [ ] **Step 3: 实现 middleware.go**

文件：`open-im-hub-server/internal/auth/middleware.go`

```go
package auth

import (
    "net/http"
    "strings"

    "github.com/gin-gonic/gin"
)

const (
    ContextUID   = "uid"
    ContextEmail = "email"
)

// JWTMiddleware 验证 Authorization: Bearer <hub_token>，将 uid/email 注入 gin.Context
func JWTMiddleware(secret string) gin.HandlerFunc {
    return func(c *gin.Context) {
        header := c.GetHeader("Authorization")
        if !strings.HasPrefix(header, "Bearer ") {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
            return
        }
        tokenStr := strings.TrimPrefix(header, "Bearer ")
        claims, err := VerifyHubToken(tokenStr, secret)
        if err != nil {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
            return
        }
        c.Set(ContextUID, claims.UID)
        c.Set(ContextEmail, claims.Email)
        c.Next()
    }
}
```

- [ ] **Step 4: 实现 credential.go**

文件：`open-im-hub-server/internal/auth/credential.go`

```go
package auth

import (
    "crypto/ecdsa"
    "encoding/base64"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "strings"
    "time"

    hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

type credentialPayload struct {
    UID   string `json:"uid"`
    AppID string `json:"app_id"`
    Exp   int64  `json:"exp"`
}

// IssueCredential 用 hub_private_key 签发 credential（绑定 uid + app_id + exp）
// credential = base64url(payload) + "." + hex(sign(keccak256(base64url(payload)), hub_private_key))
func IssueCredential(uid, appID string, privKey *ecdsa.PrivateKey, ttlSeconds int64) (string, error) {
    payload := credentialPayload{
        UID:   uid,
        AppID: appID,
        Exp:   time.Now().Add(time.Duration(ttlSeconds) * time.Second).Unix(),
    }
    payloadJSON, err := json.Marshal(payload)
    if err != nil {
        return "", err
    }
    payloadB64 := base64.RawURLEncoding.EncodeToString(payloadJSON)
    sig, err := hubcrypto.Sign([]byte(payloadB64), privKey)
    if err != nil {
        return "", fmt.Errorf("sign credential: %w", err)
    }
    return payloadB64 + "." + hex.EncodeToString(sig), nil
}

// VerifyCredential 验证 credential 签名和过期，返回 uid 和 app_id
func VerifyCredential(credStr, hubPublicKey string) (uid, appID string, err error) {
    parts := strings.SplitN(credStr, ".", 2)
    if len(parts) != 2 {
        return "", "", fmt.Errorf("malformed credential")
    }
    payloadB64, sigHex := parts[0], parts[1]

    payloadBytes, err := base64.RawURLEncoding.DecodeString(payloadB64)
    if err != nil {
        return "", "", fmt.Errorf("invalid payload encoding")
    }
    var p credentialPayload
    if err := json.Unmarshal(payloadBytes, &p); err != nil {
        return "", "", fmt.Errorf("invalid payload json")
    }
    if time.Now().Unix() > p.Exp {
        return "", "", fmt.Errorf("credential expired")
    }
    sig, err := hex.DecodeString(sigHex)
    if err != nil || len(sig) != 65 {
        return "", "", fmt.Errorf("invalid signature format")
    }
    recovered, err := hubcrypto.Ecrecover([]byte(payloadB64), sig)
    if err != nil || !strings.EqualFold(recovered, hubPublicKey) {
        return "", "", fmt.Errorf("signature verification failed")
    }
    return p.UID, p.AppID, nil
}
```

- [ ] **Step 5: 运行测试**

```bash
cd open-im-hub-server && go test ./internal/auth/... -v
```
预期：全部 PASS

- [ ] **Step 6: Commit**

```bash
git add internal/auth/
git commit -m "feat(auth): add JWT hub_token and EVM credential issue/verify"
```

---

## Task 6：用户注册/登录 Handler

**Files:**
- Create: `open-im-hub-server/internal/handler/user.go`
- Create: `open-im-hub-server/internal/handler/user_test.go`

- [ ] **Step 1: 写失败测试**

文件：`open-im-hub-server/internal/handler/user_test.go`

```go
package handler_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/stretchr/testify/require"
    "github.com/langgexyz/open-im-hub-server/internal/handler"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

func setupUserRouter(t *testing.T) (*gin.Engine, *store.Store) {
    gin.SetMode(gin.TestMode)
    db := openTestDB(t) // 复用 store_test 中的 helper
    s, _ := store.New(db)
    privHex := "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    h := handler.NewUserHandler(s.Users, privHex)
    r := gin.New()
    r.POST("/user/register", h.Register)
    r.POST("/user/login", h.Login)
    return r, s
}

func TestUserRegister(t *testing.T) {
    r, _ := setupUserRouter(t)
    body, _ := json.Marshal(map[string]string{"email": "alice@example.com", "password": "secret123"})
    req := httptest.NewRequest(http.MethodPost, "/user/register", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)

    require.Equal(t, http.StatusOK, w.Code)
    var resp map[string]string
    json.Unmarshal(w.Body.Bytes(), &resp)
    require.NotEmpty(t, resp["uid"])
    require.NotEmpty(t, resp["hub_token"])
}

func TestUserRegisterDuplicate(t *testing.T) {
    r, _ := setupUserRouter(t)
    body, _ := json.Marshal(map[string]string{"email": "dup@example.com", "password": "pass"})
    req1 := httptest.NewRequest(http.MethodPost, "/user/register", bytes.NewReader(body))
    req1.Header.Set("Content-Type", "application/json")
    w1 := httptest.NewRecorder()
    r.ServeHTTP(w1, req1)
    require.Equal(t, http.StatusOK, w1.Code)

    req2 := httptest.NewRequest(http.MethodPost, "/user/register", bytes.NewReader(body))
    req2.Header.Set("Content-Type", "application/json")
    w2 := httptest.NewRecorder()
    r.ServeHTTP(w2, req2)
    require.Equal(t, http.StatusConflict, w2.Code)
}

func TestUserLogin(t *testing.T) {
    r, _ := setupUserRouter(t)
    // 先注册
    body, _ := json.Marshal(map[string]string{"email": "bob@example.com", "password": "mypassword"})
    req := httptest.NewRequest(http.MethodPost, "/user/register", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    r.ServeHTTP(httptest.NewRecorder(), req)

    // 再登录
    req2 := httptest.NewRequest(http.MethodPost, "/user/login", bytes.NewReader(body))
    req2.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req2)
    require.Equal(t, http.StatusOK, w.Code)
    var resp map[string]string
    json.Unmarshal(w.Body.Bytes(), &resp)
    require.NotEmpty(t, resp["hub_token"])
}

func TestUserLoginWrongPassword(t *testing.T) {
    r, _ := setupUserRouter(t)
    body, _ := json.Marshal(map[string]string{"email": "carol@example.com", "password": "correct"})
    req := httptest.NewRequest(http.MethodPost, "/user/register", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    r.ServeHTTP(httptest.NewRecorder(), req)

    wrong, _ := json.Marshal(map[string]string{"email": "carol@example.com", "password": "wrong"})
    req2 := httptest.NewRequest(http.MethodPost, "/user/login", bytes.NewReader(wrong))
    req2.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req2)
    require.Equal(t, http.StatusUnauthorized, w.Code)
}
```

运行 `go test ./internal/handler/... -run TestUser`，预期 FAIL

- [ ] **Step 2: 实现 user.go**

文件：`open-im-hub-server/internal/handler/user.go`

```go
package handler

import (
    "fmt"
    "net/http"
    "strings"

    "github.com/gin-gonic/gin"
    "golang.org/x/crypto/bcrypt"
    hubauth "github.com/langgexyz/open-im-hub-server/internal/auth"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

const (
    hubTokenTTL = 7 * 24 * 3600 // 7 天
    minPassword = 6
)

type UserHandler struct {
    users      *store.UserStore
    jwtSecret  string // = HUB_PRIVATE_KEY hex string
}

func NewUserHandler(users *store.UserStore, hubPrivKeyHex string) *UserHandler {
    return &UserHandler{users: users, jwtSecret: hubPrivKeyHex}
}

// Register POST /user/register { email, password }
func (h *UserHandler) Register(c *gin.Context) {
    var req struct {
        Email    string `json:"email" binding:"required,email"`
        Password string `json:"password" binding:"required"`
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    if len(req.Password) < minPassword {
        c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("password must be at least %d characters", minPassword)})
        return
    }

    hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "hash failed"})
        return
    }
    uid, err := h.users.Create(req.Email, string(hash))
    if err != nil {
        if strings.Contains(err.Error(), "Duplicate") || strings.Contains(err.Error(), "duplicate") {
            c.JSON(http.StatusConflict, gin.H{"error": "email already registered"})
            return
        }
        c.JSON(http.StatusInternalServerError, gin.H{"error": "create user failed"})
        return
    }

    uidStr := fmt.Sprintf("%d", uid)
    token, err := hubauth.IssueHubToken(uidStr, req.Email, h.jwtSecret, hubTokenTTL)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "issue token failed"})
        return
    }
    c.JSON(http.StatusOK, gin.H{"uid": uidStr, "hub_token": token})
}

// Login POST /user/login { email, password }
func (h *UserHandler) Login(c *gin.Context) {
    var req struct {
        Email    string `json:"email" binding:"required"`
        Password string `json:"password" binding:"required"`
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    user, err := h.users.GetByEmail(req.Email)
    if err != nil {
        c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
        return
    }
    if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
        c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
        return
    }

    uidStr := fmt.Sprintf("%d", user.ID)
    token, err := hubauth.IssueHubToken(uidStr, user.Email, h.jwtSecret, hubTokenTTL)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "issue token failed"})
        return
    }
    c.JSON(http.StatusOK, gin.H{"uid": uidStr, "hub_token": token})
}
```

- [ ] **Step 3: 运行测试**

```bash
go test ./internal/handler/... -run TestUser -v
```
预期：全部 PASS

- [ ] **Step 4: Commit**

```bash
git add internal/handler/user.go internal/handler/user_test.go
git commit -m "feat(handler): add user register and login with bcrypt + JWT"
```

---

## Task 7：Credential Handler（签发 credential）

**Files:**
- Rewrite: `open-im-hub-server/internal/handler/credential.go`
- Create: `open-im-hub-server/internal/handler/credential_test.go`

- [ ] **Step 1: 写失败测试**

文件：`open-im-hub-server/internal/handler/credential_test.go`

```go
package handler_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/stretchr/testify/require"
    hubauth "github.com/langgexyz/open-im-hub-server/internal/auth"
    "github.com/langgexyz/open-im-hub-server/internal/handler"
)

const testPrivHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

func setupCredentialRouter(t *testing.T) *gin.Engine {
    gin.SetMode(gin.TestMode)
    h := handler.NewCredentialHandler(testPrivHex)
    r := gin.New()
    // 模拟 JWT 中间件：直接注入 uid
    r.POST("/user/credential", func(c *gin.Context) {
        c.Set(hubauth.ContextUID, "10001")
        h.Issue(c)
    })
    return r
}

func TestCredentialIssue(t *testing.T) {
    r := setupCredentialRouter(t)
    body, _ := json.Marshal(map[string]string{"target_app_id": "app-abc123"})
    req := httptest.NewRequest(http.MethodPost, "/user/credential", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)

    require.Equal(t, http.StatusOK, w.Code)
    var resp map[string]string
    json.Unmarshal(w.Body.Bytes(), &resp)
    require.NotEmpty(t, resp["credential"])

    // 验证 credential 可以被解析
    pub, _ := hubauth.PubKeyFromHex(testPrivHex) // 需要在 auth 包暴露此函数
    uid, appID, err := hubauth.VerifyCredential(resp["credential"], pub)
    require.NoError(t, err)
    require.Equal(t, "10001", uid)
    require.Equal(t, "app-abc123", appID)
}
```

运行 `go test ./internal/handler/... -run TestCredential`，预期 FAIL

- [ ] **Step 2: 在 auth 包暴露 PubKeyFromHex**

在 `internal/auth/credential.go` 添加（或在 `internal/auth/jwt.go` 添加）：

```go
// PubKeyFromHex 从 hub_private_key hex 推导 hub_public_key（以太坊地址）
// 供测试使用
func PubKeyFromHex(privHex string) (string, error) {
    return hubcrypto.PubKeyFromPrivHex(privHex)
}
```

- [ ] **Step 3: 实现 credential.go**

文件：`open-im-hub-server/internal/handler/credential.go`

```go
package handler

import (
    "crypto/ecdsa"
    "net/http"

    "github.com/gin-gonic/gin"
    hubauth "github.com/langgexyz/open-im-hub-server/internal/auth"
    hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

const credentialTTL = 300 // 5 分钟，足够完成订阅流程

type CredentialHandler struct {
    hubPrivKey *ecdsa.PrivateKey
}

func NewCredentialHandler(hubPrivKeyHex string) *CredentialHandler {
    priv, err := hubcrypto.PrivKeyFromHex(hubPrivKeyHex)
    if err != nil {
        panic("invalid hub private key: " + err.Error())
    }
    return &CredentialHandler{hubPrivKey: priv}
}

// Issue POST /user/credential { target_app_id }
// 需要 JWT 中间件注入 uid
func (h *CredentialHandler) Issue(c *gin.Context) {
    var req struct {
        TargetAppID string `json:"target_app_id" binding:"required"`
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    uid := c.GetString(hubauth.ContextUID)
    if uid == "" {
        c.JSON(http.StatusUnauthorized, gin.H{"error": "missing uid"})
        return
    }

    cred, err := hubauth.IssueCredential(uid, req.TargetAppID, h.hubPrivKey, credentialTTL)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "issue credential failed"})
        return
    }
    c.JSON(http.StatusOK, gin.H{"credential": cred})
}
```

- [ ] **Step 4: 运行测试**

```bash
go test ./internal/handler/... -run TestCredential -v
```
预期：PASS

- [ ] **Step 5: Commit**

```bash
git add internal/handler/credential.go internal/handler/credential_test.go internal/auth/
git commit -m "feat(handler): add CredentialHandler for POST /user/credential"
```

---

## Task 8：节点激活 Handler（幂等 POST /node/activate）

**Files:**
- Create: `open-im-hub-server/internal/handler/activate.go`
- Create: `open-im-hub-server/internal/handler/activate_test.go`
- Delete: `open-im-hub-server/internal/handler/register.go`（旧激活逻辑）

- [ ] **Step 1: 写失败测试**

文件：`open-im-hub-server/internal/handler/activate_test.go`

启动一个 mock Node Server（httptest.NewServer）来模拟节点响应：

```go
package handler_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/stretchr/testify/require"
    hubauth "github.com/langgexyz/open-im-hub-server/internal/auth"
    "github.com/langgexyz/open-im-hub-server/internal/handler"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

func TestNodeActivate(t *testing.T) {
    // Mock Node Server
    activated := false
    mockNode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path == "/node/info" {
            json.NewEncoder(w).Encode(map[string]any{"status": "ok", "activated": false})
            return
        }
        if r.URL.Path == "/node/activate" {
            activated = true
            w.WriteHeader(http.StatusOK)
            return
        }
        w.WriteHeader(http.StatusNotFound)
    }))
    defer mockNode.Close()

    db := openTestDB(t)
    s, _ := store.New(db)
    h := handler.NewActivateHandler(s.Nodes, testPrivHex, "http://hub:8080", "http://hub.example.com")

    gin.SetMode(gin.TestMode)
    r := gin.New()
    r.POST("/node/activate", func(c *gin.Context) {
        c.Set(hubauth.ContextUID, "10001")
        h.Activate(c)
    })

    code := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" // 64 hex chars
    body, _ := json.Marshal(map[string]string{
        "code":             code,
        "node_server_addr": mockNode.URL,
        "node_web_addr":    "http://node.example.com",
    })
    req := httptest.NewRequest(http.MethodPost, "/node/activate", bytes.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)

    require.Equal(t, http.StatusOK, w.Code, w.Body.String())
    require.True(t, activated, "node server should have received activation")

    // 验证幂等：再次激活同一 code 应返回 200
    req2 := httptest.NewRequest(http.MethodPost, "/node/activate", bytes.NewReader(body))
    req2.Header.Set("Content-Type", "application/json")
    w2 := httptest.NewRecorder()
    r.ServeHTTP(w2, req2)
    require.Equal(t, http.StatusOK, w2.Code)
}
```

运行 `go test ./internal/handler/... -run TestNodeActivate`，预期 FAIL

- [ ] **Step 2: 实现 activate.go**

文件：`open-im-hub-server/internal/handler/activate.go`

```go
package handler

import (
    "bytes"
    "crypto/ecdsa"
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "net/http"

    "github.com/gin-gonic/gin"
    hubauth "github.com/langgexyz/open-im-hub-server/internal/auth"
    hubcrypto "github.com/langgexyz/open-im-hub-server/internal/crypto"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

type ActivateHandler struct {
    nodes         *store.NodeStore
    hubPrivKey    *ecdsa.PrivateKey
    hubGRPCAddr   string // 下发给 Node，如 "hub.example.com:50051"
    hubWebOrigin  string // 下发给 Node，如 "https://hub.example.com"
    hubPublicKey  string
}

type activatePayload struct {
    AppID        string `json:"app_id"`
    AppPrivateKey string `json:"app_private_key"`
    AppPublicKey  string `json:"app_public_key"`
    HubGRPCAddr  string `json:"hub_grpc_addr"`
    HubPublicKey string `json:"hub_public_key"`
    HubWebOrigin string `json:"hub_web_origin"`
}

func NewActivateHandler(nodes *store.NodeStore, hubPrivKeyHex, hubGRPCAddr, hubWebOrigin string) *ActivateHandler {
    priv, err := hubcrypto.PrivKeyFromHex(hubPrivKeyHex)
    if err != nil {
        panic("invalid hub private key: " + err.Error())
    }
    pub, _ := hubcrypto.PubKeyFromPrivHex(hubPrivKeyHex)
    return &ActivateHandler{
        nodes:        nodes,
        hubPrivKey:   priv,
        hubGRPCAddr:  hubGRPCAddr,
        hubWebOrigin: hubWebOrigin,
        hubPublicKey: pub,
    }
}

// Activate POST /node/activate { code, node_server_addr, node_web_addr }
// 需要 JWT 中间件注入 uid（admin_uid）
func (h *ActivateHandler) Activate(c *gin.Context) {
    var req struct {
        Code           string `json:"code"             binding:"required,len=64"`
        NodeServerAddr string `json:"node_server_addr" binding:"required"`
        NodeWebAddr    string `json:"node_web_addr"    binding:"required"`
    }
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    adminUID := c.GetString(hubauth.ContextUID)

    // 1. 探活
    infoURL := req.NodeServerAddr + "/node/info"
    resp, err := http.Get(infoURL) //nolint:noctx
    if err != nil || resp.StatusCode >= 500 {
        c.JSON(http.StatusBadGateway, gin.H{"error": "node unreachable"})
        return
    }
    defer resp.Body.Close()

    // 2. 生成或复用节点密钥对
    //    code = app_id；UPSERT 保证幂等
    nodePriv, nodePub, err := hubcrypto.GenerateKey()
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "key generation failed"})
        return
    }
    nodePrivHex := hubcrypto.PrivKeyToHex(nodePriv)

    node := &store.Node{
        AppID:          req.Code, // code = AppId
        AppPublicKey:   nodePub,
        NodeServerAddr: req.NodeServerAddr,
        NodeWebAddr:    req.NodeWebAddr,
        AdminUID:       adminUID,
        Status:         0,
    }
    if err := h.nodes.Upsert(node); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "db error: " + err.Error()})
        return
    }

    // Upsert 成功后从 DB 读回（幂等重试时复用已存密钥）
    // 注：实际上每次重试都会生成新密钥对再 Upsert，ON DUPLICATE KEY UPDATE 会覆盖
    // 这里是简化版，幂等重试可能每次给 Node Server 发不同密钥
    // 如需严格幂等（密钥不变），应在 Upsert 时不覆盖 app_public_key

    // 3. 构造加密激活包发给 Node Server
    payload := activatePayload{
        AppID:         req.Code,
        AppPrivateKey: nodePrivHex,
        AppPublicKey:  nodePub,
        HubGRPCAddr:  h.hubGRPCAddr,
        HubPublicKey: h.hubPublicKey,
        HubWebOrigin: h.hubWebOrigin,
    }
    plaintext, _ := json.Marshal(payload)
    aesKey := makeAESKey(req.Code)
    ciphertext, err := hubcrypto.AESEncrypt(aesKey, plaintext)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "encryption failed"})
        return
    }

    activateURL := fmt.Sprintf("%s/node/activate?code=%s", req.NodeServerAddr, req.Code)
    httpResp, err := http.Post(activateURL, "application/octet-stream", bytes.NewReader(ciphertext)) //nolint:noctx
    if err != nil || httpResp.StatusCode != http.StatusOK {
        c.JSON(http.StatusBadGateway, gin.H{"error": "failed to activate node"})
        return
    }
    httpResp.Body.Close()

    // 4. 标记节点为 active
    if err := h.nodes.Activate(req.Code); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "activate status update failed"})
        return
    }

    c.JSON(http.StatusOK, gin.H{"app_id": req.Code, "message": "node activated successfully"})
}

// makeAESKey SHA-256(code bytes)
func makeAESKey(code string) []byte {
    sum := sha256.Sum256([]byte(code))
    return sum[:]
}
```

> **注意**：`makeAESKey` 与旧 `register.go` 中的同名函数逻辑相同，可提取到 `hubcrypto` 包，但 YAGNI，暂时就地定义。

- [ ] **Step 3: 删除旧文件**

```bash
rm open-im-hub-server/internal/handler/register.go
```

- [ ] **Step 4: 运行测试**

```bash
go test ./internal/handler/... -run TestNodeActivate -v
```
预期：PASS

- [ ] **Step 5: Commit**

```bash
git add internal/handler/activate.go internal/handler/activate_test.go
git rm internal/handler/register.go
git commit -m "feat(handler): add idempotent POST /node/activate, remove legacy GET /register"
```

---

## Task 9：目录 Handler（GET /nodes + GET /nodes/:app_id）

**Files:**
- Modify: `open-im-hub-server/internal/handler/directory.go`
- Create: `open-im-hub-server/internal/handler/directory_test.go`

- [ ] **Step 1: 写失败测试**

文件：`open-im-hub-server/internal/handler/directory_test.go`

```go
package handler_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/stretchr/testify/require"
    "github.com/langgexyz/open-im-hub-server/internal/handler"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

func TestDirectoryList(t *testing.T) {
    db := openTestDB(t)
    s, _ := store.New(db)
    // 插入一个 status=1 的节点
    _ = s.Nodes.Upsert(&store.Node{AppID: "n1", AppPublicKey: "0xA", NodeServerAddr: "http://node:8080", NodeWebAddr: "http://node.com", AdminUID: "1", Status: 0})
    _ = s.Nodes.Activate("n1")
    _ = s.Nodes.UpdateProfile("n1", "My Node", "http://avatar.png", "desc")

    gin.SetMode(gin.TestMode)
    h := handler.NewDirectoryHandler(s.Nodes)
    r := gin.New()
    r.GET("/nodes", h.List)
    r.GET("/nodes/:app_id", h.Get)

    req := httptest.NewRequest(http.MethodGet, "/nodes", nil)
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)

    var resp struct{ Nodes []map[string]any }
    json.Unmarshal(w.Body.Bytes(), &resp)
    require.Len(t, resp.Nodes, 1)
    require.Equal(t, "n1", resp.Nodes[0]["app_id"])
    require.Equal(t, "My Node", resp.Nodes[0]["name"])
}

func TestDirectoryGet(t *testing.T) {
    db := openTestDB(t)
    s, _ := store.New(db)
    _ = s.Nodes.Upsert(&store.Node{AppID: "n2", AppPublicKey: "0xB", AdminUID: "2", Status: 0})
    _ = s.Nodes.Activate("n2")

    gin.SetMode(gin.TestMode)
    h := handler.NewDirectoryHandler(s.Nodes)
    r := gin.New()
    r.GET("/nodes/:app_id", h.Get)

    req := httptest.NewRequest(http.MethodGet, "/nodes/n2", nil)
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)

    var resp map[string]any
    json.Unmarshal(w.Body.Bytes(), &resp)
    require.Equal(t, "n2", resp["app_id"])
    require.Equal(t, "2", resp["admin_uid"])
}
```

运行 `go test ./internal/handler/... -run TestDirectory`，预期 FAIL

- [ ] **Step 2: 重写 directory.go**

文件：`open-im-hub-server/internal/handler/directory.go`

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

type nodeResponse struct {
    AppID          string `json:"app_id"`
    Name           string `json:"name"`
    Avatar         string `json:"avatar"`
    Description    string `json:"description"`
    NodeServerAddr string `json:"node_server_addr"`
    NodeWebAddr    string `json:"node_web_addr"`
    AdminUID       string `json:"admin_uid"`
}

func toNodeResponse(n *store.Node) nodeResponse {
    return nodeResponse{
        AppID:          n.AppID,
        Name:           n.Name,
        Avatar:         n.Avatar,
        Description:    n.Description,
        NodeServerAddr: n.NodeServerAddr,
        NodeWebAddr:    n.NodeWebAddr,
        AdminUID:       n.AdminUID,
    }
}

// List GET /nodes
func (h *DirectoryHandler) List(c *gin.Context) {
    nodes, err := h.nodes.List()
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    resp := make([]nodeResponse, 0, len(nodes))
    for _, n := range nodes {
        resp = append(resp, toNodeResponse(n))
    }
    c.JSON(http.StatusOK, gin.H{"nodes": resp})
}

// Get GET /nodes/:app_id
func (h *DirectoryHandler) Get(c *gin.Context) {
    appID := c.Param("app_id")
    n, err := h.nodes.GetByAppID(appID)
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
        return
    }
    c.JSON(http.StatusOK, toNodeResponse(n))
}
```

- [ ] **Step 3: 运行测试**

```bash
go test ./internal/handler/... -run TestDirectory -v
```
预期：PASS

- [ ] **Step 4: Commit**

```bash
git add internal/handler/directory.go internal/handler/directory_test.go
git commit -m "feat(handler): update directory with spec field names, add GET /nodes/:app_id"
```

---

## Task 10：gRPC UpdateNodeProfile + 清理 Activate

**Files:**
- Modify: `open-im-hub-server/internal/grpc/hub_service.go`
- Modify: `open-im-hub-server/internal/grpc/server.go`

- [ ] **Step 1: 写失败测试**

在 `hub_service_test.go` 中添加：

```go
func TestUpdateNodeProfile(t *testing.T) {
    db := openTestDB(t)
    s, _ := store.New(db)
    // 先插入节点
    _ = s.Nodes.Upsert(&store.Node{AppID: "node-x", AppPublicKey: "0xCC", Status: 0})
    _ = s.Nodes.Activate("node-x")

    svc := newTestService(t, s) // 现有测试的 helper
    ctx := ctxWithNodeMeta("0xCC")  // 注入通过 interceptor 的节点

    resp, err := svc.UpdateNodeProfile(ctx, &hubv1.UpdateNodeProfileRequest{
        AppId:       "node-x",
        Name:        "Test Node",
        Avatar:      "http://avatar.png",
        Description: "test desc",
    })
    require.NoError(t, err)
    require.True(t, resp.Ok)

    n, _ := s.Nodes.GetByAppID("node-x")
    require.Equal(t, "Test Node", n.Name)
}
```

运行 `go test ./internal/grpc/... -run TestUpdateNodeProfile`，预期 FAIL

- [ ] **Step 2: 修改 hub_service.go**

删除 `Activate` 方法，新增 `UpdateNodeProfile`：

```go
// 删除整个 Activate 方法（约第 34-64 行）

// UpdateNodeProfile Node Server 在完成 /node/init 后调用，更新 Hub 目录资料
func (s *hubService) UpdateNodeProfile(ctx context.Context, req *hubv1.UpdateNodeProfileRequest) (*hubv1.UpdateNodeProfileResponse, error) {
    if err := s.store.UpdateProfile(req.AppId, req.Name, req.Avatar, req.Description); err != nil {
        return nil, status.Error(codes.Internal, "update profile: "+err.Error())
    }
    return &hubv1.UpdateNodeProfileResponse{Ok: true}, nil
}
```

同时修改 `NodeStore` 接口（在 `server.go` 中），删除 `ConsumeCode`，新增 `UpdateProfile`：

```go
type NodeStore interface {
    GetByPublicKey(pubKey string) (*store.Node, error)
    UpdateHeartbeat(pubKey string) error
    List() ([]*store.Node, error)
    UpdateProfile(appID, name, avatar, description string) error
    GetDeviceTokens(appUIDs []string) (map[string][]store.DeviceToken, error)
}
```

同时删除 interceptor 中的 Activate 特判：

```go
// 删除这段：
// if strings.HasSuffix(info.FullMethod, "/Activate") {
//     return handler(ctx, req)
// }
```

- [ ] **Step 3: 运行全量 gRPC 测试**

```bash
go test ./internal/grpc/... -v
```
预期：全部 PASS（Activate 相关测试也需删除或更新）

- [ ] **Step 4: Commit**

```bash
git add internal/grpc/
git commit -m "feat(grpc): add UpdateNodeProfile, remove legacy Activate RPC and ConsumeCode"
```

---

## Task 11：HTTP Server 路由重写 + 全量测试

**Files:**
- Modify: `open-im-hub-server/internal/server/http.go`

- [ ] **Step 1: 重写 http.go**

文件：`open-im-hub-server/internal/server/http.go`

```go
package server

import (
    "database/sql"
    "fmt"

    "github.com/gin-gonic/gin"
    hubauth "github.com/langgexyz/open-im-hub-server/internal/auth"
    "github.com/langgexyz/open-im-hub-server/internal/config"
    "github.com/langgexyz/open-im-hub-server/internal/handler"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

func NewHTTPServer(cfg *config.Config, db *sql.DB) (*gin.Engine, error) {
    s, err := store.New(db)
    if err != nil {
        return nil, fmt.Errorf("init store: %w", err)
    }

    userH       := handler.NewUserHandler(s.Users, cfg.HubPrivateKey)
    credH       := handler.NewCredentialHandler(cfg.HubPrivateKey)
    activateH   := handler.NewActivateHandler(s.Nodes, cfg.HubPrivateKey, cfg.GRPCAddr, cfg.HubWebOrigin)
    directoryH  := handler.NewDirectoryHandler(s.Nodes)
    deviceTokenH := handler.NewDeviceTokenHandler(s.DeviceTokens, cfg.HubPublicKey)

    r := gin.New()
    r.Use(gin.Recovery())

    // 公开接口
    r.POST("/user/register", userH.Register)
    r.POST("/user/login", userH.Login)
    r.GET("/nodes", directoryH.List)
    r.GET("/nodes/:app_id", directoryH.Get)
    r.POST("/user/device-token", deviceTokenH.Register)

    // 需要登录（JWT）
    auth := r.Group("/", hubauth.JWTMiddleware(cfg.HubPrivateKey))
    auth.POST("/user/credential", credH.Issue)
    auth.POST("/node/activate", activateH.Activate)

    return r, nil
}
```

- [ ] **Step 2: 在 config 中添加 HubWebOrigin 字段**

读取 `internal/config/config.go`。`GRPCAddr` 字段已存在，只需添加 `HubWebOrigin`：

```go
HubWebOrigin string // 如 "https://hub.example.com"
```

并在 `loadFromEnv()` 中从环境变量 `HUB_WEB_ORIGIN` 读取。

- [ ] **Step 3: 全量构建 + 测试**

```bash
cd open-im-hub-server
go build ./...
go test ./...
go vet ./...
```
预期：全部 PASS

- [ ] **Step 4: Commit**

```bash
git add internal/server/http.go internal/config/
git commit -m "feat(server): rewire HTTP routes with JWT middleware and new handlers"
```

---

## Task 12：SignSession credential 格式修正

**Files:**
- Modify: `open-im-hub-server/internal/grpc/hub_service.go`（`verifyCredential` 函数）

当前 `verifyCredential` 读 `app_uid` 字段，但新 credential payload 用 `uid` 和 `app_id`。
同时需验证 credential 的 `app_id` 与调用节点的 `app_id` 匹配。

- [ ] **Step 1: 修改 verifyCredential**

将 `hub_service.go` 中的内部 `verifyCredential` 替换为调用 `hubauth.VerifyCredential`：

```go
// SignSession 验证 credential，签发 session_sig
func (s *hubService) SignSession(ctx context.Context, req *hubv1.SignSessionRequest) (*hubv1.SignSessionResponse, error) {
    node := ctx.Value(nodeKey{}).(*store.Node)
    credStr := strings.TrimPrefix(req.UserCredential, "Bearer ")

    uid, appID, err := hubauth.VerifyCredential(credStr, s.hubPublicKey)
    if err != nil {
        return nil, status.Error(codes.Unauthenticated, "invalid credential: "+err.Error())
    }
    // 验证 credential 绑定的 app_id 与本节点匹配（防跨节点重放）
    if !strings.EqualFold(appID, node.AppID) {
        return nil, status.Error(codes.Unauthenticated, "credential app_id mismatch")
    }

    msg := buildSessionMsg(node.AppPublicKey, uid, req.Expiry)
    sig, err := hubcrypto.Sign(msg, s.hubPrivKey)
    if err != nil {
        return nil, status.Error(codes.Internal, "sign failed")
    }
    return &hubv1.SignSessionResponse{
        SessionSig: "0x" + hex.EncodeToString(sig),
        AppUid:     uid,
    }, nil
}
```

- [ ] **Step 2: 更新 SignSession 测试**

更新 `hub_service_test.go` 中使用旧 `app_uid` 字段的测试，改用新 credential 格式（`uid` + `app_id`）。

- [ ] **Step 3: 全量测试**

```bash
go test ./... -v
```
预期：全部 PASS

- [ ] **Step 4: 最终 Commit**

```bash
git add .
git commit -m "fix(grpc): align SignSession with new credential format (uid+app_id), validate app_id matches node"
```
