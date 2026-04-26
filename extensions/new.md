# 这个油猴脚本在 JavDB「过 FC2PPV 限制」的方式

## 结论（先说核心）
它不是直接破解 JavDB 前端页面，而是：
1. 拦截 FC2 入口和点击行为；
2. 用脚本自己拼一个 FC2 详情页弹窗/中转页；
3. 直接调用 `jdforrepam.com` 的 JavDB App 风格 API 拉取数据；
4. 再用 `123av / fc2ppvdb / adult.contents.fc2.com` 补齐信息。

本质是“绕过网页端限制 + 改走可访问的数据源”。

## 具体怎么做的

### 1) 重写 FC2 入口
- `Fc2Plugin.handle()` 把导航里的 FC2 链接改成：
  - `/advanced_search?type=3&score_min=0&d=1`
- 在 `advanced_search?type=3` 页面会改标题并清理部分默认区块，转为脚本接管展示/交互。

### 2) 拦截 FC2 点击，改走脚本详情
- 列表点击和历史记录点击时，只要车牌号包含 `FC2-`，就不走默认详情页。
- 改为调用：
  - `Fc2Plugin.openFc2Dialog(movieId, carNum, href)`（弹窗）
  - 或 `openFc2Page(...)` 打开 `/users/collection_codes?...` 中转页，再由脚本渲染。
- `movieId` 通过 `parseMovieId()` 从原链接 `/v/{id}` 提取。

### 3) 用 JavDB App API 拉核心数据（关键）
- 脚本内有 `javDbApi`，请求域名是：`https://jdforrepam.com/api`
- 重点接口：
  - `/v4/movies/{movieId}`：详情（标题、演员、发布日期、预览图）
  - `/v1/movies/{movieId}/magnets`：磁链
  - `/v1/movies/{movieId}/reviews`：评论
  - `/v1/lists/related?movie_id=...`：相关清单
- 请求会带 `jdSignature`，由 `buildSignature()` 用时间戳 + 固定盐值 + `md5` 生成。

这一步是核心：即使网页端 FC2 页面受限，脚本仍可通过这套接口拿到内容再自行渲染。

### 4) 123Av 分支作为补充来源
- `Fc2By123AvPlugin` 另外加了一个 `123Av-Fc2` 入口（`type=100`）。
- 逻辑是抓 `123av` 的 FC2 列表（`/ja/tags/fc2`），再补抓：
  - `https://fc2ppvdb.com/articles/{番号}`
  - `https://adult.contents.fc2.com/article/{番号}/`
- 用这些站补演员、卖家、样品图、外链等信息。

### 5) 为什么能跨站抓数据
- 元信息里开了：
  - `@grant GM_xmlhttpRequest`
  - 多个 `@connect`（含 `adult.contents.fc2.com`、`fc2ppvdb.com`、`123av.com`，甚至 `*`）
- 所以请求不受普通页面同源策略限制，脚本可直接跨域抓取。

## 边界与风险
- 这类“过限制”依赖外部 API 和站点结构：
  - `jdforrepam` 签名算法变更、接口鉴权收紧；
  - 123av / fc2ppvdb / FC2 页面结构改版；
  - 域名失效或被拦截；
  都会导致功能失效。
- 因此它更像“利用当前可用链路绕过网页端限制”，不是稳定、永久的服务端破解。
