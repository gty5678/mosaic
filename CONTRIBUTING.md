# 贡献指南

感谢参与 Mosaic Bridge。提交前请先阅读 [README.md](README.md)、[API 文档](docs/API.md) 和与改动相关的 [扩展开发指南](docs/extension-development.md)。

## 开发环境

要求 Python 3.10+ 与 uv。在仓库根目录执行：

```powershell
uv sync --group dev
uv run python main.py
```

常用调试配置在 `.vscode/launch.json`：`Worker: main.py` 适合单进程断点调试，`Worker: uvicorn app:app` 适合自动重载。

## 变更边界

- `app.py` 是 Bridge 的 REST、SSE 和主程序代理实现；更改接口时必须同步更新 `docs/API.md`。
- `extensions/chrome_capture/` 与 `extensions/firefox_capture/` 是独立扩展；跨浏览器行为变更通常应同步实现和验证。
- 代理路径的请求体与响应体属于 DarkEye 主程序契约。Bridge 不应擅自改写它们。
- 不提交 `.venv/`、构建目录、输出目录、浏览器个人资料或包含真实页面数据的调试产物。

## 推荐工作流

1. 从小而聚焦的改动开始，保留现有 API 与回调字段的兼容性。
2. 本地启动 Bridge，先访问 `/api/v1/health`。
3. 对涉及扩展的改动，在对应浏览器重新加载扩展并验证 SSE 连接。
4. 对采集流程，至少覆盖成功、无扩展、超时/失败回调和重复回调四类场景。
5. 对站点解析器，额外检查空页面、延迟加载、导航失败和验证页的清理行为。
6. 更新受影响的文档与版本说明。

## 提交前检查

```powershell
uv run python -m compileall app.py main.py
uv run python -c "from app import app; print(app.title, app.version)"
```

若修改了 HTTP 接口，还应在服务启动后调用健康检查，并在 Swagger UI 中确认 OpenAPI 描述正确。若修改扩展，请在 Chrome 和 Firefox 的扩展调试页面检查控制台，不应留下未处理 Promise、持续重连风暴或未清理的临时标签页。

## 提交说明

提交信息应说明用户可见影响，例如：`fix: clean up crawler tab after merge timeout`。PR/变更说明应包括：问题背景、修改范围、验证方式、已知限制，以及是否改变了 API、权限或站点支持范围。

## 安全和隐私

不要提交访问令牌、Cookie、个人页面数据或可识别用户的信息。新增浏览器权限、放宽站点匹配或改变网络目的地时，请在变更说明中解释必要性和影响；Bridge 设计为仅在本机通信。
