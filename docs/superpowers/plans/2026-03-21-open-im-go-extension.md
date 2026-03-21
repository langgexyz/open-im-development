# open-im-go-extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 `open-im-go-extension` 库，实现跨语言 envelope 协议的 Go 实现，并将 `open-im-official-account-service` 迁移至使用该库。

**Architecture:** `msgext/` 子包承载 contentType=110 的扩展消息协议。Envelope 包裹业务 payload，以 JSON 字符串形式存入 OpenIM Custom 消息的 `data` 字段。资源路径（cover_path/content_path）存储对象存储相对路径，不含 host，客户端运行时拼接完整 URL。

**Tech Stack:** Go 1.21+, encoding/json（标准库），无第三方依赖。

---

## 文件结构

### 新建：open-im-go-extension/

```
open-im-go-extension/
  go.mod                   # module github.com/langgexyz/open-im-go-extension
  msgext/
    envelope.go            # Envelope struct, MsgType 常量, Unmarshal, 错误类型
    envelope_test.go       # Marshal/Unmarshal 单元测试（外部 _test 包）
    article.go             # ArticlePayload struct, NewArticle 构造函数, Marshal
    article_internal_test.go  # Article 内部测试（含 wrong-type 场景）
    article_test.go        # Article 外部编解码测试
```

### 修改：open-im-official-account-service/

```
go.mod                                        # 添加 open-im-go-extension 本地依赖
internal/openim/const.go                      # 删除 ContentTypeArticle；保留其他常量
internal/openim/client.go                     # UploadFile 返回 path；SendGroupMessage 接受 string
internal/openim/client_test.go                # 更新 SendGroupMessage 调用签名
internal/openim/client_integration_test.go   # 更新为 msgext 编码
internal/handler/publish.go                  # 生成结构化路径；用 msgext 编码消息
internal/handler/publish_test.go             # 更新 mock 签名及断言
internal/handler/publish_integration_test.go # 验证响应并检查 msgext envelope 可解析
```

---

## Task 1: 初始化模块 + Envelope 核心

**Files:**
- Create: `open-im-go-extension/go.mod`
- Create: `open-im-go-extension/msgext/envelope.go`
- Create: `open-im-go-extension/msgext/envelope_test.go`

- [ ] **Step 1: 初始化 Go module**

仓库已 clone 至 `/Users/zero/Documents/GitHub/open-im-development/open-im-go-extension`（空仓库）。

```bash
cd /Users/zero/Documents/GitHub/open-im-development/open-im-go-extension
go mod init github.com/langgexyz/open-im-go-extension
```

- [ ] **Step 2: 写 envelope_test.go（先写测试）**

创建 `msgext/envelope_test.go`：

```go
package msgext_test

import (
	"testing"

	"github.com/langgexyz/open-im-go-extension/msgext"
)

func TestUnmarshal_MalformedJSON(t *testing.T) {
	_, err := msgext.Unmarshal([]byte(`not-json`))
	if err != msgext.ErrMalformedJSON {
		t.Fatalf("expected ErrMalformedJSON, got %v", err)
	}
}

func TestUnmarshal_UnknownType(t *testing.T) {
	data := []byte(`{"version":1,"type":999,"data":{}}`)
	_, err := msgext.Unmarshal(data)
	if err != msgext.ErrUnknownType {
		t.Fatalf("expected ErrUnknownType, got %v", err)
	}
}

func TestUnmarshal_ZeroType(t *testing.T) {
	// type=0 是零值，未注册
	data := []byte(`{"version":1,"type":0,"data":{}}`)
	_, err := msgext.Unmarshal(data)
	if err != msgext.ErrUnknownType {
		t.Fatalf("expected ErrUnknownType, got %v", err)
	}
}
```

- [ ] **Step 3: 运行测试，确认失败（包不存在）**

```bash
cd /Users/zero/Documents/GitHub/open-im-development/open-im-go-extension
go test ./msgext/ -v 2>&1 | head -5
```

预期：编译错误，`msgext` 包不存在。

- [ ] **Step 4: 实现 envelope.go**

创建 `msgext/envelope.go`：

```go
package msgext

import (
	"encoding/json"
	"errors"
)

// 错误类型
var (
	ErrMalformedJSON        = errors.New("msgext: malformed JSON")
	ErrMissingRequiredField = errors.New("msgext: missing required field")
	ErrUnknownType          = errors.New("msgext: unknown message type")
)

// MsgType 业务消息类型枚举。
// 值永久稳定；破坏性变更须新增枚举值而非修改已有值。
type MsgType int32

const (
	TypeArticle MsgType = 1
)

// Envelope 是 msgext 通道的顶层结构。
// 序列化后作为 OpenIM Custom 消息（contentType=110）content.data 字段的值。
type Envelope struct {
	Version int
	Type    MsgType
	raw     json.RawMessage // 延迟解析的 payload 字节
}

// envelopeWire 用于 JSON 序列化/反序列化。
type envelopeWire struct {
	Version int             `json:"version"`
	Type    MsgType         `json:"type"`
	Data    json.RawMessage `json:"data"`
}

// Unmarshal 解析 envelope JSON 字节。
// 返回 ErrMalformedJSON（JSON 解析失败）或 ErrUnknownType（未注册的 type 值）。
func Unmarshal(data []byte) (*Envelope, error) {
	var w envelopeWire
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, ErrMalformedJSON
	}
	if !isKnownType(w.Type) {
		return nil, ErrUnknownType
	}
	return &Envelope{Version: w.Version, Type: w.Type, raw: w.Data}, nil
}

func isKnownType(t MsgType) bool {
	switch t {
	case TypeArticle:
		return true
	}
	return false
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
go test ./msgext/ -v -run TestUnmarshal
```

预期：3 个测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: init open-im-go-extension with msgext envelope core"
```

---

## Task 2: Article 消息类型

**Files:**
- Create: `open-im-go-extension/msgext/article.go`
- Create: `open-im-go-extension/msgext/article_internal_test.go`
- Create: `open-im-go-extension/msgext/article_test.go`

- [ ] **Step 1: 写 article_test.go（外部测试：编解码往返）**

```go
package msgext_test

import (
	"testing"

	"github.com/langgexyz/open-im-go-extension/msgext"
)

func TestArticle_RoundTrip(t *testing.T) {
	original := msgext.NewArticle("标题", "covers/xxx.jpg", "摘要", "articles/xxx.html")

	encoded, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	env, err := msgext.Unmarshal(encoded)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if env.Type != msgext.TypeArticle {
		t.Fatalf("unexpected type: %v", env.Type)
	}

	article := env.Article()
	if article == nil {
		t.Fatal("Article() returned nil for TypeArticle")
	}
	if article.Title != "标题" {
		t.Errorf("title: got %q, want %q", article.Title, "标题")
	}
	if article.CoverPath != "covers/xxx.jpg" {
		t.Errorf("cover_path: got %q", article.CoverPath)
	}
	if article.ContentPath != "articles/xxx.html" {
		t.Errorf("content_path: got %q", article.ContentPath)
	}
}

func TestArticle_MissingContentPath(t *testing.T) {
	// content_path 是必填字段；title 非空以单独验证 content_path
	a := msgext.NewArticle("有标题", "", "", "")
	if err := a.Validate(); err != msgext.ErrMissingRequiredField {
		t.Fatalf("expected ErrMissingRequiredField for empty content_path, got %v", err)
	}
}

func TestArticle_MissingTitle(t *testing.T) {
	a := msgext.NewArticle("", "", "", "articles/x.html")
	if err := a.Validate(); err != msgext.ErrMissingRequiredField {
		t.Fatalf("expected ErrMissingRequiredField for empty title, got %v", err)
	}
}

func TestArticle_CoverPath_Optional(t *testing.T) {
	// cover_path 可为空，Validate 不报错
	a := msgext.NewArticle("标题", "", "摘要", "articles/x.html")
	if err := a.Validate(); err != nil {
		t.Fatalf("expected no error for empty cover_path, got %v", err)
	}
}
```

- [ ] **Step 2: 写 article_internal_test.go（包内测试：wrong-type 场景）**

```go
package msgext

import "testing"

func TestArticle_WrongType_ReturnsNil(t *testing.T) {
	// 直接构造非 TypeArticle 的 Envelope（包内访问）
	env := &Envelope{Version: 1, Type: MsgType(999)}
	if got := env.Article(); got != nil {
		t.Fatalf("Article() should return nil for non-TypeArticle, got %+v", got)
	}
}
```

- [ ] **Step 3: 运行测试，确认失败（Article 未定义）**

```bash
go test ./msgext/ -v 2>&1 | head -10
```

预期：编译错误。

- [ ] **Step 4: 实现 article.go**

```go
package msgext

import "encoding/json"

// ArticlePayload 公众号文章推送 payload（type=1）。
//
// cover_path 和 content_path 存储对象存储相对路径（相对于节点 OSS base URL），
// 不含 host。完整 URL 由客户端在运行时拼接：
//
//	full_url = node_oss_base_url + "/" + path
type ArticlePayload struct {
	Title       string `json:"title"`
	CoverPath   string `json:"cover_path"`   // 封面图相对路径，可为空
	Summary     string `json:"summary"`      // 摘要，可为空
	ContentPath string `json:"content_path"` // 正文 HTML 相对路径，必填
}

// Validate 校验必填字段。
func (a *ArticlePayload) Validate() error {
	if a.Title == "" || a.ContentPath == "" {
		return ErrMissingRequiredField
	}
	return nil
}

// NewArticle 构造 ArticlePayload。coverPath 和 summary 可为空字符串。
func NewArticle(title, coverPath, summary, contentPath string) *ArticlePayload {
	return &ArticlePayload{
		Title:       title,
		CoverPath:   coverPath,
		Summary:     summary,
		ContentPath: contentPath,
	}
}

// Marshal 将 ArticlePayload 序列化为 envelope JSON 字节，可直接用作 OpenIM content.data。
func (a *ArticlePayload) Marshal() ([]byte, error) {
	dataBytes, err := json.Marshal(a)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelopeWire{
		Version: 1,
		Type:    TypeArticle,
		Data:    json.RawMessage(dataBytes),
	})
}

// Article 从 Envelope 中提取 ArticlePayload。
// 当 env.Type == TypeArticle 时，保证返回非 nil（即使内部字段为零值）。
// 当 env.Type != TypeArticle 时返回 nil，不 panic。
func (e *Envelope) Article() *ArticlePayload {
	if e.Type != TypeArticle {
		return nil
	}
	var p ArticlePayload
	// 若 raw 解析失败（异常情况），返回零值而非 nil，保持非 nil 保证
	_ = json.Unmarshal(e.raw, &p)
	return &p
}
```

- [ ] **Step 5: 运行全部测试**

```bash
go test ./msgext/ -v
```

预期：所有测试 PASS。

- [ ] **Step 6: 确认无 lint 问题**

```bash
go vet ./...
```

预期：无输出。

- [ ] **Step 7: Commit**

```bash
git add .
git commit -m "feat: add Article message type to msgext package"
```

---

## Task 3: 迁移 open-im-official-account-service

**Files:**
- Modify: `open-im-official-account-service/go.mod`
- Modify: `open-im-official-account-service/internal/openim/const.go`
- Modify: `open-im-official-account-service/internal/openim/client.go`
- Modify: `open-im-official-account-service/internal/openim/client_test.go`
- Modify: `open-im-official-account-service/internal/openim/client_integration_test.go`
- Modify: `open-im-official-account-service/internal/handler/publish.go`
- Modify: `open-im-official-account-service/internal/handler/publish_test.go`
- Modify: `open-im-official-account-service/internal/handler/publish_integration_test.go`

- [ ] **Step 1: 添加本地依赖**

```bash
cd /Users/zero/Documents/GitHub/open-im-development/open-im-official-account-service
go mod edit -replace github.com/langgexyz/open-im-go-extension=../open-im-go-extension
go mod tidy
```

预期：`go.mod` 出现 replace 指令，`go.sum` 更新。

- [ ] **Step 2: 更新 const.go**

`ContentTypeArticle` 移入 `msgext`，`SessionTypeSingleChat` 当前未被任何业务代码引用，一并移除。
`internal/openim/const.go` 最终内容：

```go
package openim

// ContentTypeCustom OpenIM Custom 消息通道（contentType=110）。
// msgext 扩展消息均走此通道。
// 值与 github.com/openimsdk/protocol/constant.Custom 一致。
const ContentTypeCustom int32 = 110

// SessionTypeGroup OpenIM 群组会话类型。
const SessionTypeGroup int32 = 3
```

- [ ] **Step 3: 更新 client.go**

3a. `UploadFile` 返回对象路径（调用方传入的 filename）而非完整 URL：

```go
// UploadFile 通过 OpenIM form_data 上传接口上传文件，返回对象路径（即传入的 filename 参数）。
// 路径相对于节点 OSS base URL，客户端拼接 base URL 得到完整访问地址。
// 流程：initiate_form_data → POST 文件到 MinIO → complete_form_data
func (c *Client) UploadFile(ctx context.Context, filename string, data []byte, contentType string) (string, error) {
    // ... 保持原有上传逻辑不变 ...
    // Step 3: complete
    completeBody, _ := json.Marshal(map[string]any{"id": initData.ID})
    completeResp, err := c.post(ctx, "/object/complete_form_data", completeBody)
    if err != nil {
        return "", fmt.Errorf("complete_form_data: %w", err)
    }
    if completeResp.ErrCode != 0 {
        return "", fmt.Errorf("complete_form_data error %d: %s", completeResp.ErrCode, completeResp.ErrMsg)
    }
    return filename, nil  // 返回路径，不返回完整 URL
}
```

3b. `SendGroupMessage` 接受预编码的 envelope 字符串：

```go
// SendGroupMessage 向群组发送 msgext Custom Message。
// data 为 msgext.Envelope 序列化后的 JSON 字符串（即 ArticlePayload.Marshal() 的输出）。
func (c *Client) SendGroupMessage(ctx context.Context, groupID string, data string) (string, error) {
	bodyBytes, err := json.Marshal(map[string]any{
		"sendID":         "imAdmin",
		"groupID":        groupID,
		"senderName":     "",
		"recvID":         "",
		"content":        map[string]any{"data": data},
		"contentType":    ContentTypeCustom,
		"sessionType":    SessionTypeGroup,
		"isOnlineOnly":   false,
		"notOfflinePush": false,
	})
	if err != nil {
		return "", err
	}

	resp, err := c.post(ctx, "/msg/send_msg", bodyBytes)
	if err != nil {
		return "", fmt.Errorf("send_msg: %w", err)
	}
	if resp.ErrCode != 0 {
		return "", fmt.Errorf("openim send error %d: %s", resp.ErrCode, resp.ErrMsg)
	}

	var respData struct {
		ServerMsgID string `json:"serverMsgID"`
	}
	if err := json.Unmarshal(resp.Data, &respData); err != nil {
		return "", fmt.Errorf("decode send response: %w", err)
	}
	return respData.ServerMsgID, nil
}
```

- [ ] **Step 4: 更新 client_test.go**

```go
package openim_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/langgexyz/open-im-official-account-service/internal/openim"
)

func TestSendGroupMsg(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"errCode":0,"errMsg":"","data":{"serverMsgID":"msg123"}}`))
	}))
	defer srv.Close()

	client := openim.NewClient(srv.URL, "admin-token")
	// SendGroupMessage 现在接受预编码的 envelope 字符串
	msgID, err := client.SendGroupMessage(context.Background(), "0", `{"version":1,"type":1,"data":{"title":"test","cover_path":"","summary":"","content_path":"articles/x.html"}}`)
	if err != nil {
		t.Fatal(err)
	}
	if msgID == "" {
		t.Fatal("expected non-empty msgID")
	}
}
```

- [ ] **Step 5: 更新 publish.go**

```go
package handler

import (
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/langgexyz/open-im-go-extension/msgext"
)

type OpenIMClient interface {
	UploadFile(ctx context.Context, filename string, data []byte, contentType string) (string, error)
	SendGroupMessage(ctx context.Context, groupID string, data string) (string, error)
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

	ts := time.Now().UnixNano()

	// 上传封面图（可选）
	var coverPath string
	if coverFile, err := c.FormFile("cover"); err == nil {
		coverData, err := readFormFile(coverFile)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read cover"})
			return
		}
		objectPath := fmt.Sprintf("covers/%d-%s", ts, coverFile.Filename)
		coverPath, err = h.openim.UploadFile(c.Request.Context(), objectPath, coverData, coverFile.Header.Get("Content-Type"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload cover"})
			return
		}
	}

	// 上传正文（必填）
	contentFile, err := c.FormFile("content")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content file is required"})
		return
	}
	contentData, err := readFormFile(contentFile)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read content"})
		return
	}
	contentPath, err := h.openim.UploadFile(
		c.Request.Context(),
		fmt.Sprintf("articles/%d-%s", ts, contentFile.Filename),
		contentData,
		"text/html",
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload content"})
		return
	}

	// 用 msgext 编码 Article envelope
	envelope, err := msgext.NewArticle(title, coverPath, summary, contentPath).Marshal()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to encode message"})
		return
	}

	// 发送到订阅群 group_id="0"
	msgID, err := h.openim.SendGroupMessage(c.Request.Context(), "0", string(envelope))
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

- [ ] **Step 6: 更新 publish_test.go**

```go
package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/langgexyz/open-im-go-extension/msgext"
	"github.com/langgexyz/open-im-official-account-service/internal/handler"
)

type mockOpenIM struct {
	uploadPaths []string
	sentData    string
}

func (m *mockOpenIM) UploadFile(_ context.Context, filename string, _ []byte, _ string) (string, error) {
	m.uploadPaths = append(m.uploadPaths, filename)
	return filename, nil // 返回路径
}

func (m *mockOpenIM) SendGroupMessage(_ context.Context, _ string, data string) (string, error) {
	m.sentData = data
	return "mock-msg-id", nil
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
	w.Close()

	rec := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/biz/articles/publish", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestPublish_EncodesArticleEnvelope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	mock := &mockOpenIM{}
	h := handler.NewPublishHandler(mock)
	r.POST("/biz/articles/publish", h.Publish)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("title", "测试文章")
	w.WriteField("summary", "摘要")
	fw, _ := w.CreateFormFile("content", "article.html")
	fw.Write([]byte("<html>content</html>"))
	w.Close()

	rec := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/biz/articles/publish", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}

	// 验证响应包含 msg_id
	var resp map[string]string
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp["msg_id"] == "" {
		t.Fatal("expected non-empty msg_id in response")
	}

	// 验证发出的 data 是合法的 msgext envelope
	env, err := msgext.Unmarshal([]byte(mock.sentData))
	if err != nil {
		t.Fatalf("envelope unmarshal: %v", err)
	}
	if env.Type != msgext.TypeArticle {
		t.Fatalf("unexpected type: %v", env.Type)
	}
	article := env.Article()
	if article.Title != "测试文章" {
		t.Errorf("title: got %q", article.Title)
	}
	if article.ContentPath == "" {
		t.Error("content_path should not be empty")
	}
	// cover_path 无封面时应为空
	if article.CoverPath != "" {
		t.Errorf("cover_path should be empty when no cover uploaded, got %q", article.CoverPath)
	}
}
```

- [ ] **Step 7: 更新 client_integration_test.go**

将 `TestIntegrationSendGroupMessage` 改为使用 msgext 编码：

```go
func TestIntegrationSendGroupMessage(t *testing.T) {
	cli := integrationClient(t)
	envelope, err := msgext.NewArticle("集成测试文章", "", "摘要", "articles/test.html").Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	msgID, err := cli.SendGroupMessage(context.Background(), "0", string(envelope))
	if err != nil {
		t.Fatalf("SendGroupMessage: %v", err)
	}
	t.Logf("sent message ID: %s", msgID)
}
```

在文件顶部 import 中添加 `"github.com/langgexyz/open-im-go-extension/msgext"`。

- [ ] **Step 8: 更新 publish_integration_test.go**

在现有测试末尾添加对 msgext 解析的验证：

```go
// 验证 msg_id 非空，并在响应中打印
if rec.Code != http.StatusOK {
    t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
}
var resp map[string]string
json.NewDecoder(rec.Body).Decode(&resp)
if resp["msg_id"] == "" {
    t.Fatal("expected non-empty msg_id")
}
t.Logf("publish response msg_id: %s", resp["msg_id"])
```

导入 `"encoding/json"`。

- [ ] **Step 9: 编译验证**

```bash
cd /Users/zero/Documents/GitHub/open-im-development/open-im-official-account-service
go build ./...
go vet ./...
```

预期：无错误。

- [ ] **Step 10: 运行单元测试**

```bash
go test ./...
```

预期：全部 PASS。

- [ ] **Step 11: 运行集成测试**

```bash
OPENIM_API_ADDR=http://localhost:10002 \
OPENIM_ADMIN_TOKEN=$(curl -s -X POST http://localhost:10002/auth/get_admin_token \
  -H 'Content-Type: application/json' -H 'operationID: t001' \
  -d '{"secret":"openIM123","userID":"imAdmin"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])") \
MINIO_INTERNAL_ADDR=localhost:10005 \
go test ./... -run TestIntegration -v -timeout 60s
```

预期：`TestIntegrationUploadFile`、`TestIntegrationSendGroupMessage`、`TestIntegrationPublish` 均 PASS。

- [ ] **Step 12: Commit**

```bash
git add .
git commit -m "$(cat <<'EOF'
feat: migrate to open-im-go-extension msgext protocol

- UploadFile returns object path instead of full URL
- SendGroupMessage accepts pre-encoded msgext envelope string
- publish handler uses msgext.NewArticle for encoding; cover is now optional
- resources stored as paths (cover_path/content_path) not full URLs
- remove ContentTypeArticle (moved to msgext.TypeArticle)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## 验收标准

- [ ] `open-im-go-extension` 所有单元测试通过（`go test ./...`）
- [ ] `open-im-official-account-service` 所有单元测试通过
- [ ] 集成测试 `TestIntegrationPublish` 通过，且 `msg_id` 非空
- [ ] `go vet ./...` 两个仓库均无报错
- [ ] 发出的 OpenIM 消息可被 `msgext.Unmarshal` 解析，`env.Type == TypeArticle`
