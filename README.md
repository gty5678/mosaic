# jav-crawler-server

面向 **DarkEye** 桌面套件的本机 **扩展 Worker 网关**：用 **FastAPI** 跑在 `127.0.0.1:56790`，与浏览器扩展通过 **SSE（`/events`）** 建立长连接，把「必须在真实浏览器里完成」的请求（合并抓取、女优页、封面图等）交给扩展执行；其余与数据库、UI 相关的接口则 **反向代理** 到桌面主程序（默认 `127.0.0.1:56789`）。

仓库内同时包含 **Chrome / Firefox** 两套扩展源码（`extensions/`），用于在本地页面中采集并回传数据。**不向远端服务器上传业务数据**（扩展说明见各扩展目录下的 `README.txt`）。

---

## 架构概览

```text
桌面主程序 (56789)  ←── HTTP 转发 ──  Worker (56790, 本仓库 app.py)
                              ↑
                              │ SSE + REST（同端口）
                              │
                       浏览器扩展（Chrome / Firefox）
```

- **Worker（本服务）**：扩展只连 **56790**；需要浏览器出马的任务由 Worker 经 SSE 下发，`request_id` 与 Future 对齐后等待扩展 POST 结果。
- **主程序**：`check_existence`、一键采集、Minnano 采集提示、拥塞/Cloudflare 提示等走 **HTTP 转发** 到 `DARKEYE_MAIN_BASE_URL`。
- **兜底代理**：未在本文件中显式实现的 `/api/v1/{path}` 会 **原样转发** 到主程序（见 `app.py` 末尾 `proxy_browser_plugin_api`）。

---

## 环境要求

- Python **3.10+**
- 与扩展、主程序同一台机器上运行（默认全程 `localhost`）

---

## 安装与运行

### 方式一：虚拟环境 + pip（推荐与 `pyproject.toml` 一致）

```bash
cd jav-crawler-server
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux / macOS
# source .venv/bin/activate

pip install -e .
```

启动 Worker：

```bash
darkeye-extension-worker
```

或直接：

```bash
python main.py
```

默认监听：**http://127.0.0.1:56790**

### 方式二：仅安装依赖、不安装包

```bash
pip install fastapi "uvicorn[standard]" httpx
python main.py
```

### 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `DARKEYE_MAIN_BASE_URL` | 桌面主程序 HTTP 根地址（勿尾斜杠） | `http://127.0.0.1:56789` |

---

## 本地调试

1. **Cursor / VS Code**  
   - 安装官方 **Python** 扩展（内置/附带 **Debugpy**）。  
   - 用项目自带的 **`Run and Debug`** 配置（`.vscode/launch.json`）：  
     - **Worker: main.py** — 适合在 `app.py` 里下断点、单步执行（单进程，无热重载）。  
     - **Worker: uvicorn app:app** — 改代码自动重启；`--reload` 会起子进程，断点行为因环境而异，复杂问题优先用 `main.py` 配置。  
   - 在 **运行和调试** 里选好 Python 解释器（建议指向 `.venv`）。

2. **命令行快速验证**  
   - 起服务后浏览器打开：**http://127.0.0.1:56790/docs**（Swagger）或 **GET** `http://127.0.0.1:56790/api/v1/health`。  
   - 依赖扩展与 SSE 的接口需先加载扩展并连上 **`/events`**，否则会返回 503 等。

3. **日志**  
   - Logger 名为 **`server2.worker`**。需要更细输出可在代码里把该 logger 设为 `DEBUG`，或暂时在 `main.py` 里 `logging.basicConfig(level=logging.DEBUG)`（按需添加，勿提交敏感环境日志）。

4. **与主程序联调**  
   - 若调试转发类接口，请先启动桌面主程序（默认 **56789**），或设置 `DARKEYE_MAIN_BASE_URL` 指向实际地址。

---

## HTTP API 摘要

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/v1/health` | 健康检查 |
| GET | `/events` | **SSE**，扩展连接；接收 `navigate`、`work_merge_fetch` 等推送 |
| POST | `/api/v1/navigate` | 向已连接扩展广播打开 URL（`new_tab` / `current_tab`） |
| GET | `/api/v1/work/{serial_number}` | 按番号触发合并抓取；**需扩展已连 SSE**，否则 503 |
| POST | `/api/v1/work-merge-result` | 扩展回传合并结果（与 `request_id` 对应） |
| GET | `/api/v1/actress/{actress_jp_name}` | Minnano 女优抓取；可选 Query `minnano_url` |
| POST | `/api/v1/actress-fetch-result` | 扩展回传女优抓取结果 |
| GET | `/api/v1/top-actresses` | Javtxt 榜单女优名列表（经扩展） |
| POST | `/api/v1/top-actresses-result` | 扩展回传榜单结果 |
| POST | `/api/v1/image` | 按 URL 取封面图（经扩展拉取并 Base64 回传） |
| POST | `/api/v1/cover-image-fetch-result` | 扩展回传封面图 Base64 |
| POST | `/api/v1/check_existence` 等 | 转发主程序（见下表） |
| `*` | `/api/v1/{path}` | 其余插件路径 **代理到主程序** |

**转发主程序的显式路由（节选）**

- `POST /api/v1/check_existence` — 批量查重（数据库在主程序）
- `POST /api/v1/minnano-actress-capture` — 采集流程回主程序 UI
- `POST /api/v1/capture/one` — 一键采集
- `POST /api/v1/crawler-backlog-warning` — 拥塞提示
- `POST /api/v1/cloudflare-challenge-notify` — 反爬/挑战提示

**超时（代码常量）**

- 合并/女优/榜单等：`WORK_MERGE_TIMEOUT_SEC = 120`
- 封面图：`IMAGE_FETCH_TIMEOUT_SEC = 30`

封面图 URL 校验：仅允许 `http` / `https` 且带 host（见 `_allowed_any_http_cover_url`）。

---

## 仓库目录

| 路径 | 说明 |
|------|------|
| `app.py` | FastAPI 应用：SSE、任务编排、HTTP 转发 |
| `main.py` | `uvicorn` 入口，默认 `127.0.0.1:56790` |
| `config.py` | 预留配置（当前可为空） |
| `pyproject.toml` | 项目元数据与依赖声明（见下文） |
| `extensions/chrome_capture/` | Chrome（Manifest V3）扩展 |
| `extensions/firefox_capture/` | Firefox（Manifest V2）扩展 |
| `extensions/new.md` | 扩展相关笔记 |
| `extensions/javjhs.txt` | 历史/参考脚本（体积较大） |

加载扩展：在浏览器开发者模式中选择对应 `manifest.json` 所在目录；确保 Worker 已启动且扩展配置的本地地址指向 **56790**（若你改过端口需与 `main.py` 一致）。

---

## `pyproject.toml` 说明

本文件使用 [**PEP 621**](https://peps.python.org/pep-0621/) 的 `[project]` 描述包元数据，并用 **setuptools** 作为构建后端，便于 `pip install -e .` 在本地可编辑安装。

| 段 | 作用 |
|----|------|
| `[build-system]` | 声明构建工具：`setuptools` + `wheel`，供 pip 构建 wheel/sdist。 |
| `[project]` | **name / version / description**：PyPI 风格元数据；**readme**：指向本 `README.md`；**requires-python**：与代码中类型注解等一致，当前为 `>=3.10`；**dependencies**：运行时依赖 **FastAPI**、**Uvicorn**（含 standard 额外依赖）、**HTTPX**。 |
| `[project.scripts]` | 安装后生成控制台命令 **`darkeye-extension-worker`**，等价于调用 `main:main`（即 `main.py` 里的 `main()`）。 |
| `[tool.setuptools]` **`py-modules`** | 显式列出根目录单文件模块 `app`、`main`、`config`，无 `src/` 包结构时这样 setuptools 才能把模块打进包或 editable 安装。 |

若你不需要「安装成命令」，仍可只用 `pip install -e .` 拉齐依赖，或直接 `pip install -r` 手写 requirements；但单一 `pyproject.toml` 更利于版本与依赖集中管理。

---

## 日志

应用使用 logger 名称 **`server2.worker`**。可在运行前配置 `logging` 或依赖 Uvicorn 默认输出。

---

## 许可

`pyproject.toml` 中 `license` 字段暂标为 **Proprietary**；若你开源请自行改为 SPDX 标识并在仓库中加入许可证全文。
