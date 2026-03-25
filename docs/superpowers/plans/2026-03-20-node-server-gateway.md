# Node Server Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Node Server 新增三项能力：① Web 激活端点 `POST /node/activate`（接收 Hub Server 下发的加密节点凭证）；② etcd 服务发现（监听业务微服务注册）；③ `/biz/*` 反向代理网关（验证 user_token、注入身份头、转发请求）。

**Architecture:** 在现有 Gin HTTP server 上追加功能。未激活状态下只暴露 `/node/activate`；激活完成后启动完整路由（含 `/biz/*` 网关）。etcd 客户端启动时订阅 `/open-im/biz/` 前缀，维护内存路由表供网关使用。

**Tech Stack:** Go 1.21+, `github.com/gin-gonic/gin`, `go.etcd.io/etcd/client/v3`, `github.com/ethereum/go-ethereum/crypto`, Go 标准库 `net/http/httputil`

**Spec:** `docs/superpowers/specs/2026-03-20-official-account-service-design.md`（第三节、第六节、第七节）

> **独立工程**：`github.com/langgexyz/open-im-node-server`，以下路径均基于该仓库根目录。

---

## 文件结构

```
internal/
  activate/
    handler.go               # 新增：POST /node/activate
    handler_test.go
  registry/
    etcd.go                  # 新增：etcd 服务发现，维护内存路由表
    etcd_test.go
  gateway/
    middleware.go            # 新增：user_token 验证 + 注入 X-App-UID/X-Node-UID
    middleware_test.go
    proxy.go                 # 新增：按路由表 httputil.ReverseProxy 转发
    proxy_test.go
  config/
    config.go                # 修改：新增 ETCDAddr 字段，Activated() 方法
  server/
    server.go                # 修改：激活前/后两种路由模式
```

---

## Task 1: 激活端点 POST /node/activate

**Files:**
- Create: `internal/activate/handler.go`
- Create: `internal/activate/handler_test.go`

- [ ] **Step 1: 写失败测试**

```go
// internal/activate/handler_test.go
package activate_test

import (
    "bytes"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/activate"
    "github.com/langgexyz/open-im-node-server/internal/config"
)

func TestActivateWrongCode(t *testing.T) {
    gin.SetMode(gin.TestMode)
    cfg := &config.Config{}
    h := activate.NewHandler(cfg, t.TempDir()+"/config.json", nil)

    r := gin.New()
    r.POST("/node/activate", h.Activate)

    // 存储一个 code
    h.SetCode("correctcode12345678901234567890")

    // 用错误 code 请求
    w := httptest.NewRecorder()
    req, _ := http.NewRequest("POST", "/node/activate?code=wrongcode", bytes.NewReader([]byte("garbage")))
    r.ServeHTTP(w, req)

    if w.Code != http.StatusBadRequest {
        t.Fatalf("expected 400, got %d", w.Code)
    }
}

func TestActivateAlreadyActivated(t *testing.T) {
    gin.SetMode(gin.TestMode)
    cfg := &config.Config{NodePrivateKey: "already_set"} // 已激活
    h := activate.NewHandler(cfg, t.TempDir()+"/config.json", nil)

    r := gin.New()
    r.POST("/node/activate", h.Activate)
    h.SetCode("code1234567890123456789012345678")

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("POST", "/node/activate?code=code1234567890123456789012345678", bytes.NewReader([]byte{}))
    r.ServeHTTP(w, req)

    if w.Code != http.StatusConflict {
        t.Fatalf("expected 409, got %d", w.Code)
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd open-im-node-server && go test ./internal/activate/... -v
```
预期：`activate.NewHandler undefined`

- [ ] **Step 3: 实现激活 handler**

```go
// internal/activate/handler.go
package activate

import (
    "crypto/aes"
    "crypto/cipher"
    "encoding/json"
    "errors"
    "io"
    "net/http"
    "sync"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/config"
)

type activatePayload struct {
    NodeID         string `json:"node_id"`
    NodePrivateKey string `json:"node_private_key"`
    NodePublicKey  string `json:"node_public_key"`
    HubPublicKey   string `json:"hub_public_key"`
}

type Handler struct {
    cfg        *config.Config
    configPath string
    mu         sync.Mutex
    code       string // 内存中一次性 code
}

// OnActivatedFunc 激活完成后的回调：初始化 MySQL 运营者账号 + 创建订阅群（group_id="0"）
type OnActivatedFunc func(nodeID string) error

type Handler struct {
    cfg         *config.Config
    configPath  string
    mu          sync.Mutex
    code        string
    onActivated OnActivatedFunc
}

func NewHandler(cfg *config.Config, configPath string, onActivated OnActivatedFunc) *Handler {
    return &Handler{cfg: cfg, configPath: configPath, onActivated: onActivated}
}

func (h *Handler) SetCode(code string) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.code = code
}

func (h *Handler) Activate(c *gin.Context) {
    h.mu.Lock()
    defer h.mu.Unlock()

    if h.cfg.NodePrivateKey != "" {
        c.JSON(http.StatusConflict, gin.H{"error": "already activated"})
        return
    }

    code := c.Query("code")
    if code != h.code || code == "" {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid code"})
        return
    }

    body, err := io.ReadAll(c.Request.Body)
    if err != nil || len(body) == 0 {
        c.JSON(http.StatusBadRequest, gin.H{"error": "empty body"})
        return
    }

    // AES-256-GCM 解密
    aesKey := makeAESKey(code)
    plaintext, err := aesDecrypt(aesKey, body)
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "decryption failed"})
        return
    }

    var payload activatePayload
    if err := json.Unmarshal(plaintext, &payload); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
        return
    }

    // 写入 config 并持久化
    h.cfg.NodeID = payload.NodeID
    h.cfg.NodePrivateKey = payload.NodePrivateKey
    h.cfg.NodePublicKey = payload.NodePublicKey
    h.cfg.HubPublicKey = payload.HubPublicKey
    if err := config.Save(h.cfg, h.configPath); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save config"})
        return
    }

    // code 一次性消费
    h.code = ""

    // 激活后置操作：初始化 MySQL 运营者账号 + 创建订阅群
    // 注意：这两步在 handler 外通过回调执行，避免 handler 依赖过多
    if h.onActivated != nil {
        if err := h.onActivated(payload.NodeID); err != nil {
            // 后置操作失败仅告警，配置已持久化，重启可重试
            log.Printf("warn: post-activation init failed: %v", err)
        }
    }

    c.JSON(http.StatusOK, gin.H{"message": "activated"})
}

func makeAESKey(code string) []byte {
    key := make([]byte, 32)
    copy(key, []byte(code))
    return key
}

func aesDecrypt(key, ciphertext []byte) ([]byte, error) {
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
    return gcm.Open(nil, ciphertext[:nonceSize], ciphertext[nonceSize:], nil)
}
```

- [ ] **Step 4: 在 config 中新增字段**

```go
// internal/config/config.go（追加字段）
NodeID    string `json:"node_id"`
HubPublicKey string `json:"hub_public_key"`

// 追加方法
func (c *Config) Activated() bool {
    return c.NodePrivateKey != ""
}
```

确认 `config.Save(cfg, path)` 函数已存在：
```bash
grep -n "func Save" internal/config/config.go
```
若不存在，补充：
```go
func Save(cfg *Config, path string) error {
    data, err := json.MarshalIndent(cfg, "", "  ")
    if err != nil {
        return err
    }
    return os.WriteFile(path, data, 0600)
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
go test ./internal/activate/... -v
```
预期：`PASS`

- [ ] **Step 6: Commit**

```bash
git add internal/activate/ internal/config/config.go
git commit -m "feat: add /node/activate endpoint for web-based node activation"
```

---

## Task 2: etcd 服务发现

**Files:**
- Create: `internal/registry/etcd.go`
- Create: `internal/registry/etcd_test.go`

- [ ] **Step 1: 添加 etcd 依赖**

```bash
go get go.etcd.io/etcd/client/v3
```

- [ ] **Step 2: 写失败测试**

```go
// internal/registry/etcd_test.go
package registry_test

import (
    "testing"
    "github.com/langgexyz/open-im-node-server/internal/registry"
)

func TestRegistryGetRoute(t *testing.T) {
    r := registry.New()
    r.Set("articles", "http://127.0.0.1:8081")

    got, ok := r.Get("articles")
    if !ok {
        t.Fatal("expected route to exist")
    }
    if got != "http://127.0.0.1:8081" {
        t.Fatalf("got %q", got)
    }
}

func TestRegistryGetMissing(t *testing.T) {
    r := registry.New()
    _, ok := r.Get("nonexistent")
    if ok {
        t.Fatal("expected no route")
    }
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
go test ./internal/registry/... -v
```

- [ ] **Step 4: 实现内存路由表 + etcd 监听**

```go
// internal/registry/etcd.go
package registry

import (
    "context"
    "strings"
    "sync"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

const etcdPrefix = "/open-im/biz/"

// Registry 维护 service_name → backend_addr 的内存路由表
type Registry struct {
    mu     sync.RWMutex
    routes map[string]string
}

func New() *Registry {
    return &Registry{routes: make(map[string]string)}
}

func (r *Registry) Set(name, addr string) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.routes[name] = addr
}

func (r *Registry) Delete(name string) {
    r.mu.Lock()
    defer r.mu.Unlock()
    delete(r.routes, name)
}

// Get 返回服务名对应的后端地址
func (r *Registry) Get(name string) (string, bool) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    addr, ok := r.routes[name]
    return addr, ok
}

// Watch 订阅 etcd /open-im/biz/ 前缀，同步到内存路由表（阻塞，建议在 goroutine 中运行）
func (r *Registry) Watch(ctx context.Context, client *clientv3.Client) {
    // 初始加载
    resp, err := client.Get(ctx, etcdPrefix, clientv3.WithPrefix())
    if err == nil {
        for _, kv := range resp.Kvs {
            name := strings.TrimPrefix(string(kv.Key), etcdPrefix)
            r.Set(name, string(kv.Value))
        }
    }

    // 持续监听变更
    ch := client.Watch(ctx, etcdPrefix, clientv3.WithPrefix())
    for wresp := range ch {
        for _, ev := range wresp.Events {
            name := strings.TrimPrefix(string(ev.Kv.Key), etcdPrefix)
            switch ev.Type {
            case clientv3.EventTypePut:
                r.Set(name, string(ev.Kv.Value))
            case clientv3.EventTypeDelete:
                r.Delete(name)
            }
        }
    }
}

// NewEtcdClient 创建 etcd 客户端，addr 示例："127.0.0.1:2379"
func NewEtcdClient(addr string) (*clientv3.Client, error) {
    return clientv3.New(clientv3.Config{
        Endpoints: []string{addr},
        Logger:    zap.NewNop(),
    })
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
go test ./internal/registry/... -v
```
预期：`PASS`

- [ ] **Step 6: Commit**

```bash
git add internal/registry/ go.mod go.sum
git commit -m "feat: add etcd-backed service registry for biz routing"
```

---

## Task 3: /biz/* 网关 middleware 与 proxy

**Files:**
- Create: `internal/gateway/middleware.go`
- Create: `internal/gateway/middleware_test.go`
- Create: `internal/gateway/proxy.go`
- Create: `internal/gateway/proxy_test.go`

- [ ] **Step 1: 写 middleware 失败测试**

```go
// internal/gateway/middleware_test.go
package gateway_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/gateway"
    "github.com/langgexyz/open-im-node-server/internal/token"
)

func TestAuthMiddlewareMissingToken(t *testing.T) {
    gin.SetMode(gin.TestMode)
    r := gin.New()
    verifier := token.NewVerifier("nodepubkeyplaceholder")
    r.GET("/biz/test", gateway.AuthMiddleware(verifier), func(c *gin.Context) {
        c.Status(http.StatusOK)
    })

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("GET", "/biz/test", nil)
    r.ServeHTTP(w, req)

    if w.Code != http.StatusUnauthorized {
        t.Fatalf("expected 401, got %d", w.Code)
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/gateway/... -run TestAuth -v
```

- [ ] **Step 3: 实现 AuthMiddleware**

```go
// internal/gateway/middleware.go
package gateway

import (
    "fmt"
    "net/http"
    "strings"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/token"
)

// AuthMiddleware 验证 user_token，验证通过后注入 X-App-UID 和 X-Node-UID
func AuthMiddleware(verifier *token.Verifier) gin.HandlerFunc {
    return func(c *gin.Context) {
        authHeader := c.GetHeader("Authorization")
        if !strings.HasPrefix(authHeader, "Bearer ") {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
            return
        }
        tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

        claims, err := verifier.Verify(tokenStr)
        if err != nil {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
            return
        }

        c.Request.Header.Set("X-App-UID", claims.AppUID)
        c.Request.Header.Set("X-Node-UID", fmt.Sprintf("%d", claims.NodeUID))
        c.Next()
    }
}
```

- [ ] **Step 4: 写 proxy 失败测试**

```go
// internal/gateway/proxy_test.go
package gateway_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/gateway"
    "github.com/langgexyz/open-im-node-server/internal/registry"
)

func TestProxyNoRoute(t *testing.T) {
    gin.SetMode(gin.TestMode)
    reg := registry.New() // 空路由表
    r := gin.New()
    r.Any("/biz/*path", gateway.ProxyHandler(reg))

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("GET", "/biz/articles/publish", nil)
    r.ServeHTTP(w, req)

    if w.Code != http.StatusNotFound {
        t.Fatalf("expected 404, got %d", w.Code)
    }
}

func TestProxyForwards(t *testing.T) {
    // 启动一个临时后端
    backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    }))
    defer backend.Close()

    gin.SetMode(gin.TestMode)
    reg := registry.New()
    reg.Set("articles", backend.URL)

    r := gin.New()
    r.Any("/biz/*path", gateway.ProxyHandler(reg))

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("GET", "/biz/articles/publish", nil)
    r.ServeHTTP(w, req)

    if w.Code != http.StatusOK {
        t.Fatalf("expected 200, got %d", w.Code)
    }
}
```

- [ ] **Step 5: 实现 ProxyHandler**

```go
// internal/gateway/proxy.go
package gateway

import (
    "fmt"
    "net/http"
    "net/http/httputil"
    "net/url"
    "strings"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-node-server/internal/registry"
)

// ProxyHandler 按路由表转发 /biz/<service>/* 请求
func ProxyHandler(reg *registry.Registry) gin.HandlerFunc {
    return func(c *gin.Context) {
        // /biz/articles/publish → service = "articles"
        path := c.Param("path") // 含前导 /，如 /articles/publish
        parts := strings.SplitN(strings.TrimPrefix(path, "/"), "/", 2)
        serviceName := parts[0]

        backend, ok := reg.Get(serviceName)
        if !ok {
            c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("service %q not registered", serviceName)})
            return
        }

        target, err := url.Parse(backend)
        if err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid backend address"})
            return
        }

        proxy := httputil.NewSingleHostReverseProxy(target)
        proxy.ServeHTTP(c.Writer, c.Request)
    }
}
```

- [ ] **Step 6: 运行所有 gateway 测试**

```bash
go test ./internal/gateway/... -v
```
预期：`PASS`

- [ ] **Step 7: Commit**

```bash
git add internal/gateway/
git commit -m "feat: add biz gateway middleware and reverse proxy"
```

---

## Task 4: 串联路由 & 启动逻辑

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/config/config.go`

- [ ] **Step 1: 更新 server 路由注册**

在 `server.go` 的路由初始化处：

```go
// 激活端点（始终暴露）
activateHandler := activate.NewHandler(cfg, configPath)
activateHandler.SetCode(generateCode()) // 启动时生成随机 code，打印到日志
r.POST("/node/activate", activateHandler.Activate)

if cfg.Activated() {
    // 启动 etcd 客户端和服务发现
    etcdClient, err := registry.NewEtcdClient(cfg.ETCDAddr)
    if err == nil {
        reg := registry.New()
        go reg.Watch(context.Background(), etcdClient)

        // biz 网关
        verifier := token.NewVerifier(cfg.NodePublicKey)
        r.Any("/biz/*path",
            gateway.AuthMiddleware(verifier),
            gateway.ProxyHandler(reg),
        )
    } else {
        // etcd 不可用：注册 /biz/* 路由但返回 503，而非不注册（避免返回 404）
        log.Printf("warn: etcd unavailable, /biz/* will return 503: %v", err)
        r.Any("/biz/*path", func(c *gin.Context) {
            c.JSON(http.StatusServiceUnavailable, gin.H{"error": "service discovery unavailable"})
        })
    }
}
```

- [ ] **Step 2: 新增配置字段**

```go
// internal/config/config.go
ETCDAddr string `json:"etcd_addr"`
```

环境变量绑定（若使用 os.Getenv 模式）：
```go
ETCDAddr: getEnv("ETCD_ADDR", "127.0.0.1:2379"),
```

- [ ] **Step 3: 实现 generateCode（启动时打印到日志，供运营者复制）**

```go
// internal/server/server.go 或 internal/activate/handler.go
func generateCode() string {
    b := make([]byte, 32)
    rand.Read(b)
    return fmt.Sprintf("%x", b) // 64 字符 hex
}
```

- [ ] **Step 4: 构建验证**

```bash
go build ./...
go vet ./...
```

- [ ] **Step 5: Commit**

```bash
git add internal/server/server.go internal/config/config.go
git commit -m "feat: wire activation and biz gateway into node server startup"
```

---

## Task 5: 端到端验证

- [ ] **Step 1: 启动 Node Server（未激活状态）**

```bash
MYSQL_DSN=<dsn> OPENIM_API_ADDR=http://localhost:10002 go run ./cmd/openim-node/main.go
```
预期日志：`activation code: <64-char-hex>`，形成 URL：`http://localhost:8080/node/activate?code=<code>`

- [ ] **Step 2: 模拟 Hub Server 下发激活数据**

从日志中复制激活 code，然后用以下 Go 脚本生成加密 payload 并发送（保存为 `/tmp/activate.go`）：

```go
package main

import (
    "bytes"; "crypto/aes"; "crypto/cipher"; "crypto/rand"
    "encoding/json"; "fmt"; "io"; "net/http"; "os"
)
func main() {
    code := os.Args[1] // 从日志复制的 code
    key := make([]byte, 32)
    copy(key, []byte(code))
    payload, _ := json.Marshal(map[string]string{
        "node_id": "test-node-id", "node_private_key": "aabbcc",
        "node_public_key": "0xTEST", "hub_public_key": "0xHUB",
    })
    block, _ := aes.NewCipher(key)
    gcm, _ := cipher.NewGCM(block)
    nonce := make([]byte, gcm.NonceSize())
    io.ReadFull(rand.Reader, nonce)
    ct := gcm.Seal(nonce, nonce, payload, nil)
    resp, err := http.Post(
        fmt.Sprintf("http://localhost:8080/node/activate?code=%s", code),
        "application/octet-stream", bytes.NewReader(ct),
    )
    fmt.Println(resp.Status, err)
}
```

```bash
go run /tmp/activate.go <从日志复制的code>
```
预期：`200 OK`

- [ ] **Step 3: 确认激活后 /biz/* 路由启用**

```bash
curl -H "Authorization: Bearer <valid_token>" http://localhost:8080/biz/articles/test
```
预期：404（无对应服务）或转发到后端

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: complete node server gateway implementation"
```
