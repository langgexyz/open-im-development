# Official Account Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `open-im-official-account-service`——一个轻量 Go 微服务，提供单一接口 `POST /biz/articles/publish`，将封面图和正文上传到 OpenIM OSS，并向订阅群（`group_id="0"`）发送 article Custom Message。

**Architecture:** Gin HTTP server，监听 `127.0.0.1:8081`，仅接受来自 Node Server 网关的内网请求（无独立鉴权）。启动时向 etcd 注册服务地址。通过 OpenIM Admin API 完成文件上传和消息发送，无独立数据库。

**Tech Stack:** Go 1.21+, `github.com/gin-gonic/gin`, `go.etcd.io/etcd/client/v3`, OpenIM HTTP API（multipart 文件上传 + 发消息）

**Spec:** `docs/superpowers/specs/2026-03-20-official-account-service-design.md`

> **新工程**：`github.com/langgexyz/open-im-official-account-service`，以下路径均基于该仓库根目录。

---

## 文件结构

```
cmd/server/
  main.go                    # 启动入口：加载配置，向 etcd 注册，启动 Gin

internal/
  config/
    config.go                # 从环境变量加载配置
  openim/
    client.go                # OpenIM Admin API 客户端：上传文件、发群消息
    client_test.go
  handler/
    publish.go               # POST /biz/articles/publish
    publish_test.go
  registry/
    etcd.go                  # etcd 服务注册（启动时写入，退出时删除）
  server/
    server.go                # Gin 路由初始化

go.mod                       # module github.com/langgexyz/open-im-official-account-service
```

---

## Task 1: 初始化工程

**Files:**
- Create: `go.mod`
- Create: `cmd/server/main.go`（骨架）

- [ ] **Step 1: 创建目录和 go.mod**

```bash
mkdir -p open-im-official-account-service
cd open-im-official-account-service
go mod init github.com/langgexyz/open-im-official-account-service
go get github.com/gin-gonic/gin
go get go.etcd.io/etcd/client/v3
```

- [ ] **Step 2: 创建 main.go 骨架**

```go
// cmd/server/main.go
package main

import (
    "log"
    "github.com/langgexyz/open-im-official-account-service/internal/config"
    "github.com/langgexyz/open-im-official-account-service/internal/server"
)

func main() {
    cfg := config.Load()
    s := server.New(cfg)
    log.Printf("starting official account service on %s", cfg.ListenAddr)
    if err := s.Run(); err != nil {
        log.Fatal(err)
    }
}
```

- [ ] **Step 3: 实现 config.Load**

```go
// internal/config/config.go
package config

import "os"

type Config struct {
    OpenIMAPIAddr    string // OPENIM_API_ADDR
    OpenIMAdminToken string // OPENIM_ADMIN_TOKEN
    ETCDAddr         string // ETCD_ADDR
    NodeID           string // APP_ID（本节点 node_id，用于标识）
    ListenAddr       string // LISTEN_ADDR，默认 127.0.0.1:8081
}

func Load() *Config {
    return &Config{
        OpenIMAPIAddr:    mustEnv("OPENIM_API_ADDR"),
        OpenIMAdminToken: mustEnv("OPENIM_ADMIN_TOKEN"),
        ETCDAddr:         mustEnv("ETCD_ADDR"),
        NodeID:           mustEnv("APP_ID"),
        ListenAddr:       getEnv("LISTEN_ADDR", "127.0.0.1:8081"),
    }
}

func mustEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        panic("missing required env: " + key)
    }
    return v
}

func getEnv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
```

- [ ] **Step 4: 构建验证（骨架可编译）**

```bash
go build ./...
```
预期：无错误（server 包还未实现，先用空占位）

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: init open-im-official-account-service project"
```

---

## Task 2: OpenIM API 客户端

**Files:**
- Create: `internal/openim/client.go`
- Create: `internal/openim/client_test.go`

- [ ] **Step 1: 写失败测试**

```go
// internal/openim/client_test.go
package openim_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/langgexyz/open-im-official-account-service/internal/openim"
)

func TestSendGroupMsg(t *testing.T) {
    // 模拟 OpenIM API
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"errCode":0,"errMsg":"","data":{"serverMsgID":"msg123"}}`))
    }))
    defer server.Close()

    client := openim.NewClient(server.URL, "admin-token")
    msgID, err := client.SendGroupMessage(t, "0", map[string]any{
        "content_type": "article",
        "title":        "test",
    })
    if err != nil {
        t.Fatal(err)
    }
    if msgID == "" {
        t.Fatal("expected msg_id")
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/openim/... -v
```

- [ ] **Step 3: 实现 OpenIM 客户端**

```go
// internal/openim/client.go
package openim

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "mime/multipart"
    "net/http"
)

type Client struct {
    baseURL    string
    adminToken string
    http       *http.Client
}

func NewClient(baseURL, adminToken string) *Client {
    return &Client{baseURL: baseURL, adminToken: adminToken, http: &http.Client{}}
}

// UploadFile 上传文件到 OpenIM OSS，返回可访问的 URL
func (c *Client) UploadFile(ctx context.Context, filename string, data []byte, contentType string) (string, error) {
    var buf bytes.Buffer
    w := multipart.NewWriter(&buf)
    fw, err := w.CreateFormFile("file", filename)
    if err != nil {
        return "", err
    }
    if _, err = fw.Write(data); err != nil {
        return "", err
    }
    w.Close()

    req, _ := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/object/put_object", &buf)
    req.Header.Set("Content-Type", w.FormDataContentType())
    req.Header.Set("token", c.adminToken)

    resp, err := c.http.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    var result struct {
        ErrCode int    `json:"errCode"`
        ErrMsg  string `json:"errMsg"`
        Data    struct {
            URL string `json:"url"`
        } `json:"data"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return "", err
    }
    if result.ErrCode != 0 {
        return "", fmt.Errorf("openim upload error %d: %s", result.ErrCode, result.ErrMsg)
    }
    return result.Data.URL, nil
}

// SendGroupMessage 向群组发送 Custom Message，返回 serverMsgID
func (c *Client) SendGroupMessage(ctx context.Context, groupID string, content map[string]any) (string, error) {
    contentBytes, _ := json.Marshal(content)

    body := map[string]any{
        "sendID":           "admin",
        "groupID":          groupID,
        "senderName":       "",
        "recvID":           "",
        "content":          map[string]any{"data": string(contentBytes)},
        "contentType":      1501, // Custom message type
        "sessionType":      3,    // 群组
        "isOnlineOnly":     false,
        "notOfflinePush":   false,
    }
    bodyBytes, _ := json.Marshal(body)

    req, _ := http.NewRequestWithContext(ctx, "POST",
        c.baseURL+"/msg/send_msg", bytes.NewReader(bodyBytes))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("token", c.adminToken)

    resp, err := c.http.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    var result struct {
        ErrCode int    `json:"errCode"`
        ErrMsg  string `json:"errMsg"`
        Data    struct {
            ServerMsgID string `json:"serverMsgID"`
        } `json:"data"`
    }
    body2, _ := io.ReadAll(resp.Body)
    if err := json.Unmarshal(body2, &result); err != nil {
        return "", err
    }
    if result.ErrCode != 0 {
        return "", fmt.Errorf("openim send error %d: %s", result.ErrCode, result.ErrMsg)
    }
    return result.Data.ServerMsgID, nil
}
```

- [ ] **Step 4: 修正测试（移除 testing.T 参数）**

```go
msgID, err := client.SendGroupMessage(context.Background(), "0", map[string]any{...})
```

- [ ] **Step 5: 运行测试确认通过**

```bash
go test ./internal/openim/... -v
```
预期：`PASS`

- [ ] **Step 6: Commit**

```bash
git add internal/openim/
git commit -m "feat: add OpenIM API client for file upload and group message"
```

---

## Task 3: 发布文章 handler

**Files:**
- Create: `internal/handler/publish.go`
- Create: `internal/handler/publish_test.go`

- [ ] **Step 1: 写失败测试**

```go
// internal/handler/publish_test.go
package handler_test

import (
    "bytes"
    "context"
    "mime/multipart"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-official-account-service/internal/handler"
)

type mockOpenIM struct{ called bool }

func (m *mockOpenIM) UploadFile(ctx context.Context, _ string, _ []byte, _ string) (string, error) {
    m.called = true
    return "https://oss.example.com/file.jpg", nil
}
func (m *mockOpenIM) SendGroupMessage(ctx context.Context, _ string, _ map[string]any) (string, error) {
    return "msg-id-123", nil
}

func TestPublishMissingTitle(t *testing.T) {
    gin.SetMode(gin.TestMode)
    r := gin.New()
    mock := &mockOpenIM{}
    h := handler.NewPublishHandler(mock)
    r.POST("/biz/articles/publish", h.Publish)

    var buf bytes.Buffer
    w := multipart.NewWriter(&buf)
    w.WriteField("summary", "some summary")
    // title 故意缺失
    w.Close()

    rec := httptest.NewRecorder()
    req, _ := http.NewRequest("POST", "/biz/articles/publish", &buf)
    req.Header.Set("Content-Type", w.FormDataContentType())
    r.ServeHTTP(rec, req)

    if rec.Code != http.StatusBadRequest {
        t.Fatalf("expected 400, got %d", rec.Code)
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test ./internal/handler/... -v
```

- [ ] **Step 3: 实现 Publish handler**

```go
// internal/handler/publish.go
package handler

import (
    "context"
    "io"
    "net/http"

    "github.com/gin-gonic/gin"
)

type OpenIMClient interface {
    UploadFile(ctx context.Context, filename string, data []byte, contentType string) (string, error)
    SendGroupMessage(ctx context.Context, groupID string, content map[string]any) (string, error)
}

type PublishHandler struct {
    openim OpenIMClient
}

func NewPublishHandler(client OpenIMClient) *PublishHandler {
    return &PublishHandler{openim: client}
}

func (h *PublishHandler) Publish(c *gin.Context) {
    title := c.PostForm("title")
    summary := c.PostForm("summary")
    if title == "" {
        c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
        return
    }

    // 上传封面图
    coverFile, err := c.FormFile("cover")
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "cover file is required"})
        return
    }
    coverData, _ := readFormFile(coverFile)
    coverURL, err := h.openim.UploadFile(c.Request.Context(), coverFile.Filename, coverData, coverFile.Header.Get("Content-Type"))
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload cover"})
        return
    }

    // 上传正文
    contentFile, err := c.FormFile("content")
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "content file is required"})
        return
    }
    contentData, _ := readFormFile(contentFile)
    contentURL, err := h.openim.UploadFile(c.Request.Context(), contentFile.Filename, contentData, "text/html")
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload content"})
        return
    }

    // 发送 Custom Message
    msgID, err := h.openim.SendGroupMessage(c.Request.Context(), "0", map[string]any{
        "content_type": "article",
        "title":        title,
        "cover_url":    coverURL,
        "summary":      summary,
        "content_url":  contentURL,
    })
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to send message"})
        return
    }

    c.JSON(http.StatusOK, gin.H{"msg_id": msgID})
}

func readFormFile(fh *multipart.FileHeader) ([]byte, error) {
    f, err := fh.Open()
    if err != nil {
        return nil, err
    }
    defer f.Close()
    return io.ReadAll(f)
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
go test ./internal/handler/... -v
```
预期：`PASS`

- [ ] **Step 5: Commit**

```bash
git add internal/handler/
git commit -m "feat: add /biz/articles/publish handler"
```

---

## Task 4: etcd 服务注册

**Files:**
- Create: `internal/registry/etcd.go`

- [ ] **Step 1: 实现服务注册（带 lease 自动续约）**

```go
// internal/registry/etcd.go
package registry

import (
    "context"
    "log"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

const (
    etcdKey = "/open-im/biz/articles"
    leaseTTL = 30 // 秒
)

// Register 向 etcd 注册服务地址，保持租约续约直到 ctx 取消
func Register(ctx context.Context, etcdAddr, serviceAddr string) error {
    client, err := clientv3.New(clientv3.Config{
        Endpoints: []string{etcdAddr},
        Logger:    zap.NewNop(),
    })
    if err != nil {
        return err
    }
    defer client.Close()

    // 申请租约
    lease, err := client.Grant(ctx, leaseTTL)
    if err != nil {
        return err
    }

    // 写入 key
    if _, err = client.Put(ctx, etcdKey, serviceAddr, clientv3.WithLease(lease.ID)); err != nil {
        return err
    }
    log.Printf("registered service at etcd key %s → %s", etcdKey, serviceAddr)

    // 续约（阻塞，直到 ctx 取消）
    ch, err := client.KeepAlive(ctx, lease.ID)
    if err != nil {
        return err
    }
    for range ch {
        // 消费续约响应，避免 channel 阻塞
    }
    return nil
}
```

- [ ] **Step 2: 构建验证**

```bash
go build ./...
```

- [ ] **Step 3: Commit**

```bash
git add internal/registry/
git commit -m "feat: add etcd service registration with lease keepalive"
```

---

## Task 5: 串联启动

**Files:**
- Create: `internal/server/server.go`
- Modify: `cmd/server/main.go`

- [ ] **Step 1: 实现 server.go**

```go
// internal/server/server.go
package server

import (
    "github.com/gin-gonic/gin"
    "github.com/langgexyz/open-im-official-account-service/internal/config"
    "github.com/langgexyz/open-im-official-account-service/internal/handler"
    "github.com/langgexyz/open-im-official-account-service/internal/openim"
)

type Server struct {
    cfg    *config.Config
    engine *gin.Engine
}

func New(cfg *config.Config) *Server {
    gin.SetMode(gin.ReleaseMode)
    r := gin.Default()

    openimClient := openim.NewClient(cfg.OpenIMAPIAddr, cfg.OpenIMAdminToken)
    publishHandler := handler.NewPublishHandler(openimClient)

    r.POST("/biz/articles/publish", publishHandler.Publish)

    return &Server{cfg: cfg, engine: r}
}

func (s *Server) Run() error {
    return s.engine.Run(s.cfg.ListenAddr)
}
```

- [ ] **Step 2: 更新 main.go（加入 etcd 注册）**

```go
// cmd/server/main.go
package main

import (
    "context"
    "log"

    "github.com/langgexyz/open-im-official-account-service/internal/config"
    "github.com/langgexyz/open-im-official-account-service/internal/registry"
    "github.com/langgexyz/open-im-official-account-service/internal/server"
)

func main() {
    cfg := config.Load()

    // 向 etcd 注册（后台运行）
    go func() {
        if err := registry.Register(context.Background(), cfg.ETCDAddr, cfg.ListenAddr); err != nil {
            log.Printf("warn: etcd registration failed: %v", err)
        }
    }()

    s := server.New(cfg)
    log.Printf("official account service listening on %s", cfg.ListenAddr)
    if err := s.Run(); err != nil {
        log.Fatal(err)
    }
}
```

- [ ] **Step 3: 构建最终验证**

```bash
go build ./...
go vet ./...
go test ./...
```
预期：全部通过

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "feat: wire up server, complete official account service"
```

---

## Task 6: 本地集成验证

- [ ] **Step 1: 设置环境变量并启动**

```bash
export OPENIM_API_ADDR=http://localhost:10002
export OPENIM_ADMIN_TOKEN=<token>
export ETCD_ADDR=127.0.0.1:2379
export APP_ID=<node_id>
export LISTEN_ADDR=127.0.0.1:8081
go run ./cmd/server/main.go
```

- [ ] **Step 2: 发布一篇文章**

```bash
curl -X POST http://127.0.0.1:8081/biz/articles/publish \
  -F "title=Hello World" \
  -F "summary=第一篇文章" \
  -F "cover=@/tmp/cover.jpg" \
  -F "content=@/tmp/article.html"
```
预期：`{"msg_id":"..."}`

- [ ] **Step 3: 通过 Node Server 网关发布（完整链路，需先完成 node-server-gateway 计划）**

> **依赖**：此步骤需要 Node Server 已实现 `/biz/*` 网关（见 `2026-03-20-node-server-gateway.md`）。

```bash
curl -X POST http://localhost:8080/biz/articles/publish \
  -H "Authorization: Bearer <user_token>" \
  -F "title=Hello World" \
  -F "summary=第一篇文章" \
  -F "cover=@/tmp/cover.jpg" \
  -F "content=@/tmp/article.html"
```
预期：同上，网关验证 token 后转发

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "docs: add integration test instructions"
```
