# Mosaic Bridge API

服务默认地址：`http://127.0.0.1:56790`。交互式 OpenAPI 文档在 `/docs`，ReDoc 在 `/redoc`，机器可读规范在 `/openapi.json`。

## 调用约定

- 除 `/events` 外，接口使用 JSON；未设置鉴权，服务仅应绑定到本机回环地址。
- 采集类接口需至少一个浏览器扩展已连接 `/events`。没有连接时，影片、女优和榜单接口返回 `503`；图片接口返回 HTTP `200` 及 `success: false`。
- Worker 为每次采集生成 `request_id`，扩展必须将其原样放在对应回调中。未知、超时或已经完成的 `request_id` 会得到 `{"status":"ignored"}`，不会影响其他任务。
- `merged`、`per_site` 与女优 `data` 由扩展的站点解析器产生，字段随网站而变；Worker 只传递对象，不重塑内部字段。

## 服务接口

### `GET /api/v1/health`

响应 `200`：

```json
{"status":"ok","service":"Mosaic Bridge"}
```

### `GET /api/v1/exist`

用于轻量探测。响应 `200`：

```json
{"ok":true}
```

## 向扩展发起的命令

### `POST /api/v1/navigate`

请求体：

```json
{
  "url": "https://example.com/page",
  "target": "new_tab",
  "context": {"source": "desktop"}
}
```

| 字段 | 必填 | 说明 |
|---|---:|---|
| `url` | 是 | 要打开的完整 URL。 |
| `target` | 否 | `new_tab`（默认）或 `current_tab`。 |
| `context` | 否 | 原样下发给扩展的业务对象。 |

响应 `200`：`{"status":"success","count":1}`。`count` 是广播时连接的 SSE 客户端数量；即使为零，命令仍返回成功但不会被任何扩展执行。

### `GET /api/v1/work/{serial_number}`

触发多站影片信息合并，最长等待 **120 秒**。`serial_number` 是必填的路径参数，不能为空。

成功响应 `200`：

```json
{
  "ok": true,
  "serial_number": "ABP-123",
  "data": {"title": "由扩展解析的合并数据"},
  "per_site": {"javdb": {"...": "..."}}
}
```

可能错误：`400`（番号为空）、`503`（无扩展连接）、`504`（扩展 120 秒内未回调）。错误体统一为 `{"detail":"..."}`。

### `GET /api/v1/actress/{actress_jp_name}`

触发 Minnano 女优资料采集，最长等待 **120 秒**。

| 参数 | 位置 | 必填 | 说明 |
|---|---|---:|---|
| `actress_jp_name` | path | 是 | 女优日文名，不能为空。 |
| `minnano_url` | query | 否 | 已知 Minnano 详情页的数字 ID 片段；提供后扩展直接进入详情页。 |

成功响应 `200`：

```json
{"ok":true,"actress_jp_name":"三上悠亜","data":{"...":"由解析器定义"}}
```

可能错误：`400`、`503`、`504`，错误体同上。

### `GET /api/v1/top-actresses`

触发 Javtxt 热门女优抓取，最长等待 **120 秒**。成功响应 `200`：

```json
{"ok":true,"names":["女优 A","女优 B"]}
```

可能错误：`503`（无扩展连接）、`504`（超时）。

### `POST /api/v1/image`

通过浏览器下载图片，最长等待 **30 秒**。

请求体：`{"url":"https://example.com/cover.jpg"}`。`url` 必须是带主机名的 HTTP 或 HTTPS URL，否则返回 `400` 和 `{"detail":"invalid url"}`。

响应始终使用 `200` 表示请求已被处理；成功与否通过 `success` 判断：

```json
{"success":true,"image":"iVBORw0KGgo..."}
```

`image` 是原始图片字节的 Base64。无扩展连接、扩展失败、超时、图片小于 5 KiB 或大于 30 MiB 时返回：

```json
{"success":false,"image":null,"message":"失败原因"}
```

## 扩展回调

以下接口仅由连接 `/events` 的扩展调用。所有回调都要求 `request_id`；为空时返回 `400` 和 `{"detail":"request_id required"}`。匹配成功返回 `{"status":"success"}`，不存在或已结束的任务返回 `{"status":"ignored"}`。

### `POST /api/v1/work-merge-result`

```json
{
  "request_id": "UUID",
  "ok": true,
  "serial_number": "ABP-123",
  "merged": {"title": "合并数据"},
  "per_site": {"javdb": {"...": "..."}},
  "error": null
}
```

`request_id`、`ok` 必填；其余字段可省略。`merged` 和 `per_site` 为自由 JSON 对象。

### `POST /api/v1/actress-fetch-result`

```json
{
  "request_id": "UUID",
  "ok": true,
  "actress_jp_name": "三上悠亜",
  "data": {"...": "女优资料"},
  "error": null
}
```

`request_id`、`ok` 必填。`actress_jp_name` 省略时，Worker 使用原始 GET 路径参数；`data` 为自由 JSON 对象。

### `POST /api/v1/top-actresses-result`

```json
{"request_id":"UUID","ok":true,"names":["女优 A","女优 B"],"error":null}
```

`request_id`、`ok` 必填；`names` 是字符串数组。

### `POST /api/v1/cover-image-fetch-result`

```json
{
  "request_id": "UUID",
  "ok": true,
  "content_base64": "iVBORw0KGgo...",
  "error": null
}
```

`request_id`、`ok` 必填。成功时传 `content_base64`；失败时传 `error`。Worker 对 Base64 解码结果执行 5 KiB 至 30 MiB 的尺寸校验。

## SSE：`GET /events`

扩展以 `Accept: text/event-stream` 建立长期 GET 连接。每条消息的格式为 `data: <JSON>\n\n`。Worker 会发送以下事件：

| `type` | 字段 | 对应扩展回调 |
|---|---|---|
| `navigate` | `url`, `target`, 可选 `context` | 无 |
| `work_merge_fetch` | `request_id`, `serial_number` | `/api/v1/work-merge-result` |
| `minnano_actress_fetch` | `request_id`, `actress_jp_name`, 可选 `minnano_url` | `/api/v1/actress-fetch-result` |
| `javtxt_top_actresses_fetch` | `request_id` | `/api/v1/top-actresses-result` |
| `fetch_cover_image` | `request_id`, `url` | `/api/v1/cover-image-fetch-result` |

## 桌面主程序代理

以下路径由 Worker 原样转发到 `DARKEYE_MAIN_BASE_URL`（默认 `http://127.0.0.1:56789`）：

- `POST /api/v1/check_existence`
- `POST /api/v1/minnano-actress-capture`
- `POST /api/v1/capture/one`
- `POST /api/v1/crawler-backlog-warning`
- `POST /api/v1/cloudflare-challenge-notify`
- 其余 `GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD /api/v1/{path}`

这些接口的请求体、响应体及业务状态码完全由桌面主程序定义，Worker 不解析也不改写；应以主程序的 OpenAPI/接口文档作为字段契约。若主程序无法连接，Worker 返回 `502`：`{"detail":"worker proxy upstream unavailable"}`。
