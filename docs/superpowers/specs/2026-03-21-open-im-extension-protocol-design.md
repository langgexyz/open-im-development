# open-im-extension 协议设计

## 一、背景

open-im 平台的 Admin send_msg API 仅支持有限的内置消息类型（Text、Picture、Custom 等）。公众号平台需要语义明确的业务消息类型（文章、投票、活动等），直接在 OpenIM 层扩展会产生 fork 维护成本。

**解决方案**：以 OpenIM `Custom(contentType=110)` 作为透传通道，在其 `data` 字段内定义一套跨语言的 envelope 协议。所有语言库（Go/Swift/Kotlin/JS）实现相同的协议规范，类型系统由 `open-im-*-extension` 系列库统一维护，与 OpenIM 版本无关。

## 二、Envelope 协议（跨语言契约）

### 2.1 OpenIM 传输层

所有业务消息固定使用：

- `contentType`: `110`（OpenIM `constant.Custom`）
- `content`: `{"data": "<envelope JSON string>"}`

### 2.2 Envelope 结构

`data` 字段承载如下 JSON：

```json
{
  "version": 1,
  "type":    1,
  "data":    { ... }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | int | Envelope 结构版本，当前固定为 `1`。仅当 envelope 自身有破坏性变更时递增，业务类型增加不影响此值。 |
| `type` | int | 业务消息类型枚举，见第三节。 |
| `data` | object | 类型专属 payload，结构由 `type` 决定。 |

### 2.3 兼容性规则

- **新增 `data` 字段**：向前兼容，旧版 SDK 忽略未知字段，不报错。
- **新增 `type` 枚举值**：旧版 SDK 收到未知 type 返回 `ErrUnknownType`，不 panic，由调用方决定如何处理。
- **`version` 递增**：仅当 envelope 结构有破坏性变更时发生；当前 v1 不预期发生此情况。

## 三、消息类型枚举

| 值 | 名称 | 说明 |
|----|------|------|
| `1` | Article | 公众号文章推送 |

> 未来扩展（不在 v1 实现）：Poll(2)、Event(3) 等，均沿用此表追加。

## 四、各类型 Payload 定义

### 4.1 Article（type=1）

```json
{
  "title":       "文章标题",
  "cover_url":   "https://oss.example.com/covers/xxx.jpg",
  "summary":     "摘要，不超过 200 字",
  "content_url": "https://oss.example.com/articles/xxx.html"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 是 | 文章标题 |
| `cover_url` | string | 是 | 封面图 URL |
| `summary` | string | 否 | 摘要，建议不超过 200 字 |
| `content_url` | string | 是 | 正文 HTML 文件 URL |

## 五、Go 库设计（open-im-go-extension）

**Module**：`github.com/langgexyz/open-im-go-extension`

### 5.1 目录结构

```
open-im-go-extension/
  extension.go    # Envelope 结构、MsgType 常量、Marshal/Unmarshal
  article.go      # ArticlePayload struct + NewArticle 构造函数
```

v1 两个文件，不过度分包。未来新增类型时按相同模式扩展（新增 `poll.go` 等）。

### 5.2 公开 API

**编码（服务端）：**

```go
// 构造 Article 并序列化为 envelope JSON bytes
payload, err := extension.NewArticle(title, coverURL, summary, contentURL).Marshal()
// payload 作为 OpenIM send_msg content.data 字段传入
```

**解码（客户端 SDK）：**

```go
env, err := extension.Unmarshal(dataBytes)
if err != nil { /* handle */ }

switch env.Type {
case extension.TypeArticle:
    article := env.Article() // *ArticlePayload
    // render article card
default:
    // ErrUnknownType，忽略或上报
}
```

### 5.3 错误处理

| 错误 | 场景 |
|------|------|
| `ErrUnknownType` | 收到未注册的 type 值 |
| `ErrInvalidEnvelope` | JSON 解析失败或缺少必填字段 |

## 六、多语言扩展约定

各语言库命名：`open-im-go-extension`、`open-im-swift-extension`、`open-im-kotlin-extension`、`open-im-js-extension`。

所有库以本文档第二、三、四节为唯一权威。协议变更须先修改本 spec，再同步各语言实现。
