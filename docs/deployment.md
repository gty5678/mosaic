# 部署与排障

## 运行前提

- Windows、macOS 或可运行 Python 3.10+ 的环境；使用打包产物时无需安装 Python 或 uv。
- [uv](https://docs.astral.sh/uv/)；依赖由 `uv.lock` 锁定。
- 若需要浏览器采集，已加载 Chrome 或 Firefox 扩展，且浏览器可访问目标站点。
- 若需要使用代理到桌面端的接口，DarkEye 主程序已启动。

## 本地运行

在仓库根目录执行：

```powershell
uv sync
uv run mosaic-bridge
```

服务仅绑定 `127.0.0.1:56790`，可通过以下地址验证：

- `http://127.0.0.1:56790/api/v1/health`：健康检查。
- `http://127.0.0.1:56790/docs`：Swagger UI。
- `http://127.0.0.1:56790/redoc`：ReDoc。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DARKEYE_MAIN_BASE_URL` | `http://127.0.0.1:56789` | 主程序 HTTP 根地址；不要附加末尾 `/`。 |
| `DARKEYE_UVICORN_USE_HTTPTOOLS` | 未设置 | 仅冻结程序时设为 `1`、`true` 或 `yes`，使用 Uvicorn 默认 HTTP 实现；默认冻结程序使用 h11 以提升兼容性。 |

例如主程序监听在其他端口：

```powershell
$env:DARKEYE_MAIN_BASE_URL = "http://127.0.0.1:56800"
uv run mosaic-bridge
```

配置在进程启动时读取；更改后需要重启 Bridge。

## Windows 构建

构建脚本使用 PyInstaller，生成一个 Worker 可执行文件和扩展目录：

```powershell
uv sync --group dev
.\build-installer.ps1
```

产物位于 `output/`，仅包含 `mosaic-bridge.exe` 和 `extensions/` 目录，其中收集 `chrome_capture/` 与 `firefox_capture/` 两种扩展。脚本会删除并重建 `build/`、`dist/` 与 `output/`；不要把未备份的手工文件放在这些目录中。

发布前至少验证：可执行文件能启动、健康检查可用、一个 Chrome/Firefox 扩展能连接 SSE，以及桌面主程序代理能返回预期结果。

## macOS 免安装构建

在 Mac 的项目根目录执行（需要 uv）：

```bash
./build-macos.sh
```

脚本使用锁定依赖，生成包含 Python 运行时的单文件程序 `mosaic-bridge`，并将 Chrome 和 Firefox 扩展收集到同级 `extensions/chrome_capture/` 与 `extensions/firefox_capture/` 目录。缺少任一种扩展的 `manifest.json` 时会报错终止。不生成启动脚本或 ZIP，产物目录为：

- Apple Silicon：`output/macos/arm64/mosaic-bridge-macos-arm64/`
- Intel：`output/macos/x86_64/mosaic-bridge-macos-x86_64/`

在产物目录的终端执行 `./mosaic-bridge` 启动。接收者无需安装 Python、uv 或将程序放入 Applications。终端按 Ctrl+C 停止服务。端口固定为 `56790`，请勿同时运行多个实例。Chrome 可通过开发者模式加载 `extensions/chrome_capture/`，Firefox 可临时加载 `extensions/firefox_capture/manifest.json`。

构建使用独立的 `main-macos.spec`，中间文件位于 `build/macos/<架构>/`，不会清理 Windows 构建文件。按构建 Mac 的原生架构输出，需分别在 Apple Silicon 与 Intel Mac 上构建对应版本。Windows 脚本仍会清理整个 `output/`，需要同时保留两端产物时请先另行保存。

默认产物由 PyInstaller 做临时签名，未进行 Developer ID 签名或 Apple 公证。下载的产物若被 macOS 拦截，确认来源可信后，在“系统设置 → 隐私与安全性”中选择“仍要打开”。分发前应在目标 Mac 上验证启动与健康检查；macOS 兼容范围取决于构建所用的 Python 和系统版本。

## 故障速查

| 现象 | 可能原因 | 检查与处理 |
|---|---|---|
| 健康检查连接失败 | Worker 未启动或端口被占用 | 在启动终端检查异常；确认 `127.0.0.1:56790` 未被其他程序占用。 |
| 采集返回 `503` | 没有扩展连接 `/events` | 确认扩展已加载，检查浏览器扩展控制台中的 SSE 连接错误。 |
| 采集返回 `504` | 页面未加载、验证页阻塞、回调遗漏或 ID 不匹配 | 以 `request_id` 对照 Bridge 与扩展日志；检查页面和网络请求。 |
| 代理返回 `502` | DarkEye 主程序不可达 | 确认主程序运行且 `DARKEYE_MAIN_BASE_URL` 指向正确地址。 |
| `/api/v1/image` 返回 `success: false` | URL 无效、扩展无法下载、超时或图片大小不在允许范围 | 仅使用 HTTP(S) URL；检查扩展权限；图片需在 5 KiB–30 MiB。 |
| Chrome 反复新开爬虫窗口 | MV3 Worker 休眠后状态未恢复，或旧窗口已关闭 | 检查 `chrome.storage.session` 读写和窗口存在性；不要只依赖内存 ID。 |
| 页面卡住或内容为空 | 站点加载异常、挑战页或动态内容延迟 | 检查实际标签页；有限次刷新并保证超时后清理。 |

## 日志与安全

日志名为 `server2.worker`，默认输出到启动 Bridge 的终端。冻结版若启动时发生未捕获异常，会在系统临时目录写入 `mosaic-bridge-fatal.log`。

Bridge 没有鉴权，因此必须保持绑定回环地址。不要把 `56790` 暴露到局域网或公网；扩展和 Worker 都不应把业务数据转发到非本机服务。
