# Hub Server Web Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Hub Server 新增 Web 激活注册端点 `GET /register`，运营者通过浏览器访问该端点完成节点注册，Hub Server 生成节点密钥对、AES 加密后 POST 到节点 `/node/activate`。

**Architecture:** 在现有 Hub Server HTTP server（Gin）上新增一条路由。复用现有 `internal/crypto`（EVM 密钥生成）和 `internal/store`（nodes 表写入）。新增 AES 加密工具函数和 node 激活回调逻辑。

**Tech Stack:** Go 1.21+, `github.com/gin-gonic/gin`, `github.com/ethereum/go-ethereum/crypto`, Go 标准库 `crypto/aes`/`crypto/cipher`, `github.com/google/uuid`

**Spec:** `docs/superpowers/specs/2026-03-20-official-account-service-design.md`（第三节 节点激活流程）

> **独立工程**：`github.com/langgexyz/open-im-hub-server`，以下路径均基于该仓库根目录。

---

## 文件结构

```
internal/
  crypto/
    aes.go                   # 新增：AESEncrypt / AESDecrypt（AES-256-GCM）
    aes_test.go
  handler/
    register.go              # 新增：GET /register 处理器
    register_test.go
  server/
    server.go                # 修改：注册 /register 路由（已存在，追加一行）
```

---

## Task 1: AES 加密工具

**Files:**
- Create: `internal/crypto/aes.go`
- Create: `internal/crypto/aes_test.go`

- [ ] **Step 1: 写失败测试**

```go
// internal/crypto/aes_test.go
package crypto_test

import (
    "testing"
    "github.com/langgexyz/open-im-hub-server/internal/crypto"
)

func TestAESRoundTrip(t *testing.T) {
    key := "12345678901234567890123456789012" // 32 bytes
    plaintext := []byte(`{"node_id":"abc","node_private_key":"0xdeadbeef"}`)

    ciphertext, err := crypto.AESEncrypt([]byte(key), plaintext)
    if err != nil {
        t.Fatal(err)
    }
    got, err := crypto.AESDecrypt([]byte(key), ciphertext)
    if err != nil {
        t.Fatal(err)
    }
    if string(got) != string(plaintext) {
        t.Fatalf("got %q, want %q", got, plaintext)
    }
}

func TestAESDecryptWrongKey(t *testing.T) {
    key := "12345678901234567890123456789012"
    plaintext := []byte("hello")
    ciphertext, _ := crypto.AESEncrypt([]byte(key), plaintext)

    wrongKey := "00000000000000000000000000000000"
    _, err := crypto.AESDecrypt([]byte(wrongKey), ciphertext)
    if err == nil {
        t.Fatal("expected error with wrong key")
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd open-im-hub-server && go test ./internal/crypto/... -run TestAES -v
```
预期：`crypto.AESEncrypt undefined`

- [ ] **Step 3: 实现 AES-256-GCM**

```go
// internal/crypto/aes.go
package crypto

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "errors"
    "io"
)

// AESEncrypt 用 key（32 字节）AES-256-GCM 加密 plaintext，返回 nonce+ciphertext
func AESEncrypt(key, plaintext []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, err
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }
    nonce := make([]byte, gcm.NonceSize())
    if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }
    return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// AESDecrypt 解密 AESEncrypt 生成的数据
func AESDecrypt(key, ciphertext []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, err
    }
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }
    nonceSize := gcm.NonceSize()
    if len(ciphertext) < nonceSize {
        return nil, errors.New("ciphertext too short")
    }
    nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
    return gcm.Open(nil, nonce, ciphertext, nil)
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
go test ./internal/crypto/... -run TestAES -v
```
预期：`PASS`

- [ ] **Step 5: Commit**

```bash
git add internal/crypto/aes.go internal/crypto/aes_test.go
git commit -m "feat: add AES-256-GCM encrypt/decrypt for node activation"
```

---

## Task 2: /register 处理器

**Files:**
- Create: `internal/handler/register.go`
- Create: `internal/handler/register_test.go`

- [ ] **Step 1: 写失败测试**

```go
// internal/handler/register_test.go
package handler_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "net/url"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-hub-server/internal/handler"
)

func TestRegisterMissingNodeParam(t *testing.T) {
    gin.SetMode(gin.TestMode)
    r := gin.New()
    h := handler.NewRegisterHandler(nil, nil) // store=nil, crypto=nil 先测参数校验
    r.GET("/register", h.Register)

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("GET", "/register", nil)
    r.ServeHTTP(w, req)

    if w.Code != http.StatusBadRequest {
        t.Fatalf("expected 400, got %d", w.Code)
    }
}

func TestRegisterInvalidNodeURL(t *testing.T) {
    gin.SetMode(gin.TestMode)
    r := gin.New()
    h := handler.NewRegisterHandler(nil, nil)
    r.GET("/register", h.Register)

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("GET", "/register?node=not-a-url", nil)
    r.ServeHTTP(w, req)

    if w.Code != http.StatusBadRequest {
        t.Fatalf("expected 400, got %d", w.Code)
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/handler/... -run TestRegister -v
```
预期：`handler.NewRegisterHandler undefined`

- [ ] **Step 3: 实现 register handler（参数校验部分）**

```go
// internal/handler/register.go
package handler

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "net/url"

    "github.com/gin-gonic/gin"
    "github.com/google/uuid"
    "github.com/langgexyz/open-im-hub-server/internal/crypto"
    "github.com/langgexyz/open-im-hub-server/internal/store"
)

type RegisterHandler struct {
    store      store.Store
    hubPrivKey string // hex，无 0x 前缀
}

func NewRegisterHandler(s store.Store, hubPrivKeyHex string) *RegisterHandler {
    return &RegisterHandler{store: s, hubPrivKey: hubPrivKeyHex}
}

// nodeActivatePayload 是下发给节点的激活数据（AES 加密前的明文）
type nodeActivatePayload struct {
    NodeID         string `json:"node_id"`
    NodePrivateKey string `json:"node_private_key"`
    NodePublicKey  string `json:"node_public_key"`
    HubPublicKey   string `json:"hub_public_key"`
}

// Register 处理 GET /register?node=<encoded_activate_url>
func (h *RegisterHandler) Register(c *gin.Context) {
    nodeParam := c.Query("node")
    if nodeParam == "" {
        c.JSON(http.StatusBadRequest, gin.H{"error": "missing node parameter"})
        return
    }

    // 解码节点 URL
    nodeURL, err := url.QueryUnescape(nodeParam)
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid node parameter encoding"})
        return
    }
    parsed, err := url.ParseRequestURI(nodeURL)
    if err != nil || parsed.Scheme == "" || parsed.Host == "" {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid node URL"})
        return
    }

    // 从 URL query 取 code
    code := parsed.Query().Get("code")
    if len(code) < 16 {
        c.JSON(http.StatusBadRequest, gin.H{"error": "missing or too short code in node URL"})
        return
    }

    // 探活：验证节点可达（GET 节点根路径，而非激活 URL，避免触发 POST-only 路由）
    probeURL := fmt.Sprintf("%s://%s/node/info", parsed.Scheme, parsed.Host)
    resp, err := http.Get(probeURL)
    if err != nil || resp.StatusCode >= 500 {
        c.JSON(http.StatusBadGateway, gin.H{"error": "node unreachable"})
        return
    }
    resp.Body.Close()

    // 生成节点密钥对
    privKey, pubKey, err := crypto.GenerateKey()
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "key generation failed"})
        return
    }

    // 分配 node_id
    nodeID := uuid.New().String()

    // Hub Server 公钥（由 hub_private_key 推导）
    hubPubKey, err := crypto.PubKeyFromPrivHex(h.hubPrivKey)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "hub key error"})
        return
    }

    // 写入 nodes 表
    if err := h.store.CreateNode(c.Request.Context(), store.Node{
        NodeID:       nodeID,
        NodePublicKey: pubKey,
    }); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
        return
    }

    // 构造加密 payload
    payload := nodeActivatePayload{
        NodeID:         nodeID,
        NodePrivateKey: privKey,
        NodePublicKey:  pubKey,
        HubPublicKey:   hubPubKey,
    }
    plaintext, _ := json.Marshal(payload)

    // AES key：取 code 的前 32 字节（不足则右填充 0）
    aesKey := makeAESKey(code)
    ciphertext, err := crypto.AESEncrypt(aesKey, plaintext)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "encryption failed"})
        return
    }

    // POST 加密数据到节点激活端点
    activateURL := fmt.Sprintf("%s://%s/node/activate?code=%s", parsed.Scheme, parsed.Host, code)
    httpResp, err := http.Post(activateURL, "application/octet-stream", bytes.NewReader(ciphertext))
    if err != nil || httpResp.StatusCode != http.StatusOK {
        c.JSON(http.StatusBadGateway, gin.H{"error": "failed to deliver activation data to node"})
        return
    }
    httpResp.Body.Close()

    c.JSON(http.StatusOK, gin.H{"node_id": nodeID, "message": "node activated successfully"})
}

// makeAESKey 将 code 转换为 32 字节 AES key（截断或右填充 0）
func makeAESKey(code string) []byte {
    key := make([]byte, 32)
    copy(key, []byte(code))
    return key
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
go test ./internal/handler/... -run TestRegister -v
```
预期：`PASS`

- [ ] **Step 5: Commit**

```bash
git add internal/handler/register.go internal/handler/register_test.go
git commit -m "feat: add /register handler for web-based node activation"
```

---

## Task 3: 注册路由 & 完整集成测试

**Files:**
- Modify: `internal/server/server.go`（追加路由）
- Modify: `internal/store/db.go`（追加 CreateNode 方法，若不存在）

- [ ] **Step 1: 确认 store.Store 接口是否有 CreateNode**

```bash
grep -n "CreateNode\|Store interface" internal/store/db.go
```

- [ ] **Step 2: 若无 CreateNode，补充方法**

在 `store.Store` 接口和实现中新增：

```go
// store/db.go（interface 追加）
CreateNode(ctx context.Context, node Node) error

// store/db.go（实现追加）
func (s *store) CreateNode(ctx context.Context, node Node) error {
    _, err := s.db.ExecContext(ctx,
        `INSERT INTO nodes (node_id, node_public_key, status, expires_at)
         VALUES (?, ?, 1, DATE_ADD(NOW(), INTERVAL 1 YEAR))`,
        node.NodeID, node.NodePublicKey,
    )
    return err
}
```

- [ ] **Step 3: 确认 crypto.GenerateKey 返回 hex 私钥和以太坊地址公钥**

```bash
grep -n "func GenerateKey\|func PubKeyFromPrivHex" internal/crypto/evm.go
```

若 `PubKeyFromPrivHex` 不存在，补充：

```go
// internal/crypto/evm.go
func PubKeyFromPrivHex(privHex string) (string, error) {
    priv, err := PrivKeyFromHex(privHex)
    if err != nil {
        return "", err
    }
    return crypto.PubkeyToAddress(priv.PublicKey).Hex(), nil
}
```

- [ ] **Step 4: 注册路由**

```go
// internal/server/server.go（在 HTTP router 初始化处追加）
registerHandler := handler.NewRegisterHandler(store, cfg.HubPrivateKey)
r.GET("/register", registerHandler.Register)
```

- [ ] **Step 5: 构建验证**

```bash
go build ./...
go vet ./...
```
预期：无错误

- [ ] **Step 6: Commit**

```bash
git add internal/server/server.go internal/store/db.go internal/crypto/evm.go
git commit -m "feat: wire /register route to hub HTTP server"
```

---

## Task 4: 端到端手动验证

- [ ] **Step 1: 启动 Hub Server**

```bash
HUB_PRIVATE_KEY=<hex> MYSQL_DSN=<dsn> go run ./cmd/server/main.go
```

- [ ] **Step 2: 用 curl 模拟节点激活端点（临时监听）**

```bash
# 另一个终端，用 nc 监听 8090 模拟节点
nc -l 8090
```

- [ ] **Step 3: 访问注册端点**

```bash
curl "http://localhost:8080/register?node=$(python3 -c "import urllib.parse; print(urllib.parse.quote('http://localhost:8090/node/activate?code=12345678901234567890123456789012'))")"
```
预期：Hub Server 向 `localhost:8090` 发送探活 GET，再 POST 加密数据，返回 `{"node_id":"...","message":"node activated successfully"}`

- [ ] **Step 4: Commit 最终状态**

```bash
git add -A
git commit -m "feat: complete hub server web activation flow"
```
