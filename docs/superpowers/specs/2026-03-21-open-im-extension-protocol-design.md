# open-im-extension 协议设计

## 一、背景

open-im 平台的 Admin send_msg API 仅支持有限的内置消息类型（Text、Picture、Custom 等）。公众号平台需要语义明确的业务消息类型（文章、投票、活动等），直接在 OpenIM 层扩展会产生 fork 维护成本。

**解决方案**：以 OpenIM 各 contentType 作为通道，在其 `data` 字段内定义一套跨语言的 envelope 协议。不同 contentType 对应独立子包，`msgext/` 子包（Message Extension）使用 `contentType=110` 承载扩展业务消息。所有语言库（Go/Swift/Kotlin/JS）实现相同的协议规范，类型系统由 `open-im-*-extension` 系列库统一维护，与 OpenIM 版本无关。

## 二、库结构与通道划分

不同 OpenIM contentType 对应独立子包，互不耦合：

```
open-im-go-extension/
  msgext/           # Message Extension，contentType=110，当前使用
    envelope.go     # Envelope 结构、MsgType 常量、Marshal/Unmarshal
    article.go      # ArticlePayload struct + 构造函数
  # 未来扩展示例（v1 不实现）：
  # notification/   # contentType=1400（OANotification 通道）
```

v1 只有 `msgext/` 子包。

## 三、msgext 通道协议（contentType=110）

### 3.1 OpenIM 传输层

```
contentType = 110
content     = {"data": "<envelope JSON 字符串>"}
```

**注意**：`data` 的值是 envelope JSON **序列化后的字符串**（即字符串内容是 JSON，而非嵌套对象）。

完整 wire format 示例：

```json
{
  "sendID":      "imAdmin",
  "groupID":     "0",
  "contentType": 110,
  "sessionType": 3,
  "content": {
    "data": "{\"version\":1,\"type\":1,\"data\":{\"title\":\"文章标题\",\"cover_url\":\"https://oss.example.com/covers/xxx.jpg\",\"summary\":\"摘要\",\"content_url\":\"https://oss.example.com/articles/xxx.html\"}}"
  }
}
```

### 3.2 Envelope 结构

`data` 字符串解析后的 JSON 结构：

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
| `type` | int | 业务消息类型枚举，见第四节。 |
| `data` | object | 类型专属 payload，结构由 `type` 决定。JSON key 使用 snake_case，为跨语言规范字段名。各语言实现可在本地类型上使用语言惯例命名（如 Kotlin `coverUrl`），但序列化必须输出 snake_case。 |

### 3.3 兼容性规则

- **新增 `data` 字段（可选字段）**：向前兼容，旧版 SDK 忽略未知字段，不报错。
- **新增 `type` 枚举值**：旧版 SDK 收到未知 type 返回 `ErrUnknownType`，不 panic，由调用方决定如何处理。
- **payload 破坏性变更**（如重命名必填字段）：不修改已有 type 值，而是新增一个 type（如 Article v2 = type 5），保持旧 type 继续工作。
- **`version` 递增**：仅当 envelope 结构自身有破坏性变更时发生；当前 v1 不预期发生。

## 四、消息类型枚举（msgext 通道）

| 值 | 名称 | 说明 |
|----|------|------|
| `1` | Article | 公众号文章推送 |

> 未来扩展（不在 v1 实现）：Poll(2)、Event(3) 等，均沿用此表追加。

## 五、各类型 Payload 定义

### 5.1 Article（type=1）

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
| `cover_url` | string | 否 | 封面图 URL；为空字符串时接收方展示占位图 |
| `summary` | string | 否 | 摘要，建议不超过 200 字 |
| `content_url` | string | 是 | 正文 HTML 文件 URL |

> `cover_url` 标记为可选：发布方在封面上传完成前可先发送空值，接收方显示默认占位图。

## 六、Go 库 API（msgext 子包）

**Module**：`github.com/langgexyz/open-im-go-extension`
**Import**：`github.com/langgexyz/open-im-go-extension/msgext`

### 6.1 编码（服务端）

```go
// 构造 Article envelope 并序列化为字符串，作为 OpenIM content.data 传入
data, err := msgext.NewArticle(title, coverURL, summary, contentURL).Marshal()
```

### 6.2 解码（客户端 SDK）

```go
env, err := msgext.Unmarshal(dataBytes)
if err != nil { /* handle */ }

switch env.Type {
case msgext.TypeArticle:
    article := env.Article() // 返回 *ArticlePayload，类型匹配时保证非 nil
default:
    // ErrUnknownType，忽略或上报
}
```

**`env.Article()` 契约**：
- 当 `env.Type == msgext.TypeArticle` 时返回 `*ArticlePayload`，保证非 nil。
- 当 `env.Type != msgext.TypeArticle` 时返回 `nil`，不 panic。
- 调用方应先通过 switch/if 确认类型后再调用，lint 工具可对未检查类型的调用发出警告。

### 6.3 错误类型

| 错误 | 场景 |
|------|------|
| `ErrMalformedJSON` | JSON 解析失败，消息不可读 |
| `ErrMissingRequiredField` | 结构合法但缺少必填字段（如 `title`、`content_url`），可用于部分渲染降级 |
| `ErrUnknownType` | 收到未注册的 type 值，由调用方决定是否忽略 |

### 6.4 发送方身份

envelope 自身不携带发送方身份。接收方应从 OpenIM 消息 wrapper 的 `sendID`/`groupID` 字段获取来源信息。若需在 envelope 外的存储或推送场景中保留上下文，由上层系统负责附加，不纳入 extension 协议。

## 七、多语言扩展约定

各语言库命名：`open-im-go-extension`、`open-im-swift-extension`、`open-im-kotlin-extension`、`open-im-js-extension`。

- 所有库以本文档第三、四、五节为唯一权威协议契约。
- JSON wire format 使用 snake_case 字段名；各语言本地类型可使用语言惯例命名，但序列化必须输出 snake_case。
- 协议变更须先修改本 spec，再同步各语言实现。
