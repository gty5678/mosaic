# 浏览器扩展开发指南

本指南面向维护 `extensions/chrome_capture/` 和 `extensions/firefox_capture/` 的开发者。扩展是 Mosaic Bridge 的浏览器执行端：它接收 Worker 的 SSE 命令，在真实浏览器中打开或解析页面，再通过 HTTP 回调报告结果。

## 两个扩展的差异

| 目录 | 浏览器 | 清单版本 | 后台形式 |
|---|---|---:|---|
| `extensions/chrome_capture/` | Chrome、Chromium 系浏览器 | Manifest V3 | Service Worker；SSE 在 offscreen 文档中维持。 |
| `extensions/firefox_capture/` | Firefox | Manifest V2 | 常驻 background 页面。 |

两套目录并不共享构建步骤。修复采集逻辑时，如适用于两个浏览器，应同步修改；若必须不同实现，请在代码注释中说明浏览器 API 或生命周期差异。

## 本地加载与验证

1. 启动 Bridge：`uv run mosaic-bridge`。
2. Chrome 打开 `chrome://extensions`，启用「开发者模式」，选择「加载已解压的扩展程序」，选取 `extensions/chrome_capture/`。
3. Firefox 打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，选取 `extensions/firefox_capture/manifest.json`。
4. 打开 `http://127.0.0.1:56790/api/v1/health`，确认服务存活；随后检查扩展的 background/offscreen 控制台中是否建立 `/events` 连接。

扩展访问的是本机服务，默认地址为 `http://localhost:56790` 或 `http://127.0.0.1:56790`。修改端口时，必须同时更新扩展常量、Bridge 启动配置与文档。

## 通信协议与生命周期

扩展向 `GET /events` 建立 SSE 长连接。Bridge 推送的每一条消息均为 JSON；命令类型和字段见 [API 文档的 SSE 章节](API.md)。

处理采集命令时遵循以下规则：

1. 读取 `type`，只处理已知命令。
2. 保存并传递 `request_id`；它是一次任务的唯一关联键。
3. 在浏览器中完成导航、读取或下载。
4. `POST` 到该命令对应的回调地址，并带回完全相同的 `request_id` 与 `ok`。
5. 失败时发送 `ok: false` 和可诊断的 `error`；不要静默丢弃任务。

命令的等待上限由 Bridge 控制：影片合并、女优和榜单为 120 秒，图片为 30 秒。任务超时后回调会收到 `{"status":"ignored"}`，这是正常的幂等结果；扩展应停止该任务的后续状态更新，并自行清理临时标签页或计时器。

## 新增或修改站点解析器

站点脚本位于 `content/sites/`，并由 `manifest.json` 的 `content_scripts` 按 URL 匹配注入。

1. 先确认该站点需要的命令类型与回调数据：影片合并使用 `work_merge_fetch`，人物使用 `minnano_actress_fetch`。
2. 新建或修改对应站点脚本，避免在页面全局写入易冲突的变量。
3. 在两个 manifest 中添加准确、尽量窄的 `matches` 规则及脚本加载顺序。
4. 在 background 的任务调度中注册站点、结果写入和失败收尾逻辑。
5. 以真实页面、空结果页、加载超时页和验证页分别验证，不要只测试理想页面。

`merged`、`per_site` 和人物 `data` 是扩展定义的自由 JSON。新增字段应保持向后兼容；不要未经协调删除桌面端已依赖的字段。对站点特有字段，优先放入 `per_site.<site>`，而不是污染合并后的通用对象。

## 标签页、窗口与重试

Chrome 的 MV3 Service Worker 会在空闲时终止，内存状态不能视为持久状态。当前爬虫窗口 ID 使用 `chrome.storage.session` 保存；访问前仍需确认窗口存在。不要仅依赖全局变量避免重复开窗。

对导航错误的自动刷新必须有限次，并排除证书、HSTS、用户取消等不可恢复错误。任何重试或超时分支都应清除任务表、监听器、计时器以及临时标签页，避免僵尸任务和不断累积的页面。

## 调试清单

- Chrome：在 `chrome://extensions` 的扩展详情页打开 Service Worker 或 offscreen 文档的「检查视图」。
- Firefox：在 `about:debugging` 的临时扩展条目点击「检查」。
- Bridge：查看启动终端中的 `server2.worker` 日志；先确认扩展已连接 SSE，再发起采集请求。
- 用 `request_id` 串联日志：从 SSE 命令、标签页操作到 HTTP 回调应能追踪同一个 ID。
- 遇到 Cloudflare 或页面长期加载时，记录站点、URL、浏览器、页面状态和控制台错误；不要把验证页面当作正常页面解析。

## 隐私与权限

扩展仅与本机回环地址通信，不应上传页面内容、Cookie 或采集结果到远程服务。新增权限、`host_permissions` 或跨域请求前，需要说明其必要性，并确保权限范围最小化。
