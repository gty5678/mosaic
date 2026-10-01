import asyncio
import base64
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("server2.worker")

# 主程序的地址与端口
DEFAULT_MAIN_BASE_URL = "http://127.0.0.1:56789"
MAIN_BASE_URL = os.getenv("DARKEYE_MAIN_BASE_URL", DEFAULT_MAIN_BASE_URL).rstrip("/")
WORK_MERGE_TIMEOUT_SEC = 120.0
IMAGE_FETCH_TIMEOUT_SEC = 30.0

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
}
FORWARD_TIMEOUT = httpx.Timeout(connect=5.0, read=140.0, write=20.0, pool=20.0)


@asynccontextmanager
async def _lifespan(_: FastAPI):
    logger.info(
        "worker startup main_base_url=%s work_merge_timeout=%.0fs image_fetch_timeout=%.0fs",
        MAIN_BASE_URL,
        WORK_MERGE_TIMEOUT_SEC,
        IMAGE_FETCH_TIMEOUT_SEC,
    )
    yield
    logger.info("worker shutdown")


app = FastAPI(
    title="Mosaic Bridge",
    version="0.1.0",
    description=(
        "DarkEye 浏览器扩展本地 Worker。REST 调用通过 SSE 指挥已连接的浏览器扩展；"
        "部分 `/api/v1/*` 路径原样代理至桌面主程序。\n\n"
        "调用采集接口前，扩展必须已连接 `GET /events`。请求与扩展回调通过 `request_id` 配对。"
    ),
    openapi_tags=[
        {"name": "服务", "description": "Worker 存活探测。"},
        {"name": "扩展命令", "description": "向浏览器扩展下发命令或等待采集结果。"},
        {"name": "扩展回调", "description": "仅供浏览器扩展回传 SSE 命令的处理结果。"},
        {"name": "事件流", "description": "浏览器扩展建立的 SSE 长连接。"},
        {"name": "主程序代理", "description": "请求和响应体均由桌面主程序定义，Worker 不解析或改写业务 JSON。"},
    ],
    lifespan=_lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

sse_clients: List[asyncio.Queue] = []
_work_merge_lock = asyncio.Lock()
_work_merge_futures: Dict[str, asyncio.Future] = {}
_actress_fetch_lock = asyncio.Lock()
_actress_fetch_futures: Dict[str, asyncio.Future] = {}
_actress_fetch_names: Dict[str, str] = {}
_top_actresses_lock = asyncio.Lock()
_top_actresses_futures: Dict[str, asyncio.Future] = {}
_image_fetch_lock = asyncio.Lock()
_image_fetch_futures: Dict[str, asyncio.Future] = {}


class WorkMergeResultBody(BaseModel):
    request_id: str = Field(description="Worker 下发 `work_merge_fetch` 时生成的 UUID。")
    ok: bool = Field(description="扩展采集是否成功。")
    merged: Optional[Dict[str, Any]] = Field(default=None, description="合并后的影片数据；字段由扩展的站点解析器决定。")
    per_site: Optional[Dict[str, Any]] = Field(default=None, description="按站点分组的原始/中间采集结果。")
    error: Optional[str] = Field(default=None, description="失败原因；`ok=false` 时建议提供。")
    serial_number: Optional[str] = Field(default=None, description="采集的番号；未传时响应中为空字符串。")


class ActressFetchResultBody(BaseModel):
    request_id: str = Field(description="Worker 下发 `minnano_actress_fetch` 时生成的 UUID。")
    ok: bool = Field(description="扩展采集是否成功。")
    data: Optional[Dict[str, Any]] = Field(default=None, description="女优资料；字段由 Minnano 页面解析器决定。")
    error: Optional[str] = Field(default=None, description="失败原因；`ok=false` 时建议提供。")
    actress_jp_name: Optional[str] = Field(default=None, description="女优日文名；省略时 Worker 使用原请求中的路径参数。")


class TopActressesResultBody(BaseModel):
    request_id: str = Field(description="Worker 下发 `javtxt_top_actresses_fetch` 时生成的 UUID。")
    ok: bool = Field(description="扩展采集是否成功。")
    names: Optional[List[str]] = Field(default=None, description="热门女优名称列表。")
    error: Optional[str] = Field(default=None, description="失败原因；`ok=false` 时建议提供。")


class ImageByUrlBody(BaseModel):
    url: str = Field(description="待由浏览器下载的完整 HTTP 或 HTTPS 图片 URL。")


class CoverImageFetchResult(BaseModel):
    request_id: str = Field(description="Worker 下发 `fetch_cover_image` 时生成的 UUID。")
    ok: bool = Field(description="下载是否成功。")
    error: Optional[str] = Field(default=None, description="下载或编码失败原因。")
    content_base64: Optional[str] = Field(default=None, description="图片原始字节的标准 Base64；仅 `ok=true` 时传入。")


class NavigateCommand(BaseModel):
    url: str = Field(description="扩展应打开的完整 URL。")
    target: str = Field(default="new_tab", description="`new_tab` 新建标签页；`current_tab` 在当前标签页打开。")
    context: Optional[Dict[str, Any]] = Field(default=None, description="原样传给扩展的可选业务上下文。")


class StatusResponse(BaseModel):
    status: str = Field(description="处理状态，如 `success` 或 `ignored`。")


class ErrorResponse(BaseModel):
    detail: str = Field(description="错误的机器可读说明。")


class HealthResponse(BaseModel):
    status: str
    service: str


class ExistResponse(BaseModel):
    ok: bool


class NavigateResponse(BaseModel):
    status: str
    count: int = Field(description="命令已广播到的当前 SSE 客户端数量。")


class WorkMergeResponse(BaseModel):
    ok: bool
    serial_number: str
    data: Optional[Dict[str, Any]] = Field(description="扩展回传的 `merged` 对象。")
    per_site: Dict[str, Any] = Field(description="扩展回传的 `per_site` 对象；无值时为空对象。")
    error: Optional[str] = None


class ActressFetchResponse(BaseModel):
    ok: bool
    actress_jp_name: str
    data: Optional[Dict[str, Any]] = Field(description="扩展回传的女优资料。")
    error: Optional[str] = None


class TopActressesResponse(BaseModel):
    ok: bool
    names: List[str]
    error: Optional[str] = None


class ImageResponse(BaseModel):
    success: bool
    image: Optional[str] = Field(description="图片原始字节的 Base64；失败时为 null。")
    message: Optional[str] = Field(default=None, description="失败或超时的中文说明。")


def _target_url(path: str, query: str) -> str:
    q = f"?{query}" if query else ""
    return f"{MAIN_BASE_URL}/{path}{q}"


def _filtered_request_headers(request: Request) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in HOP_BY_HOP_HEADERS:
            continue
        out[k] = v
    return out


def _filtered_response_headers(headers: httpx.Headers) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in headers.items():
        if k.lower() in HOP_BY_HOP_HEADERS:
            continue
        out[k] = v
    return out


def _allowed_any_http_cover_url(url: str) -> bool:
    try:
        p = urlparse(url.strip())
        return p.scheme in ("http", "https") and bool(p.netloc)
    except Exception:
        return False


async def _forward(request: Request, target_path: str) -> Response:
    target = _target_url(target_path, request.url.query)
    method = request.method.upper()
    headers = _filtered_request_headers(request)
    body = await request.body()
    logger.info(
        "proxy -> main method=%s path=%s target=%s body_len=%s",
        method,
        target_path,
        target,
        len(body) if body else 0,
    )
    try:
        async with httpx.AsyncClient(timeout=FORWARD_TIMEOUT) as client:
            upstream = await client.request(
                method, target, headers=headers, content=body if body else None
            )
    except httpx.HTTPError as e:
        logger.error(
            "Proxy request failed: method=%s target=%s err=%s", method, target, e
        )
        raise HTTPException(status_code=502, detail="worker proxy upstream unavailable")
    logger.info(
        "proxy <- main method=%s path=%s status=%s bytes=%s",
        method,
        target_path,
        upstream.status_code,
        len(upstream.content) if upstream.content else 0,
    )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_filtered_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )


async def _broadcast_sse(message: Dict[str, Any]) -> None:
    mtype = message.get("type", "?")
    logger.info(
        "sse broadcast type=%s clients=%s payload_keys=%s",
        mtype,
        len(sse_clients),
        list(message.keys()),
    )
    event_data = f"data: {json.dumps(message)}\n\n"
    dead_clients: List[asyncio.Queue] = []
    for client in sse_clients:
        try:
            await client.put(event_data)
        except Exception:
            dead_clients.append(client)
    for dead in dead_clients:
        if dead in sse_clients:
            sse_clients.remove(dead)


@app.get(
    "/api/v1/health",
    tags=["服务"],
    summary="健康检查",
    response_model=HealthResponse,
)
async def health() -> dict[str, str]:
    logger.debug("health check sse_clients=%s", len(sse_clients))
    return {"status": "ok", "service": "Mosaic Bridge"}


@app.get(
    "/api/v1/exist",
    tags=["服务"],
    summary="轻量存活探测",
    response_model=ExistResponse,
)
async def exist() -> dict[str, bool]:
    """供外部软件探测本服务是否在线（轻量、无副逻辑）。"""
    return {"ok": True}


@app.post(
    "/api/v1/navigate",
    tags=["扩展命令"],
    summary="向已连接扩展广播打开页面命令",
    responses={200: {"model": NavigateResponse}},
)
async def send_navigate(command: NavigateCommand) -> dict[str, Any]:
    """向本机已连接 SSE 的扩展广播导航（扩展在 56790 /events 连接，不由主服务 56789 推送）。"""
    logger.info("Broadcasting navigate command: %s", command)
    message: Dict[str, Any] = {
        "type": "navigate",
        "url": command.url,
        "target": command.target,
    }
    if command.context is not None:
        message["context"] = command.context
    await _broadcast_sse(message)
    logger.info("navigate done clients=%s", len(sse_clients))
    return {"status": "success", "count": len(sse_clients)}


@app.get(
    "/api/v1/work/{serial_number}",
    tags=["扩展命令"],
    summary="抓取并合并指定番号的多站数据",
    description="下发 `work_merge_fetch` SSE 事件并等待扩展回调，最长 120 秒。",
    responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}, 504: {"model": ErrorResponse}, 200: {"model": WorkMergeResponse}},
)
async def get_work_merge(serial_number: str):
    sn = serial_number.strip()
    if not sn:
        raise HTTPException(status_code=400, detail="serial_number required")
    if len(sse_clients) == 0:
        raise HTTPException(
            status_code=503, detail="no browser extension connected (SSE)"
        )
    request_id = str(uuid.uuid4())
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    async with _work_merge_lock:
        _work_merge_futures[request_id] = fut
    logger.info(
        "work_merge wait request_id=%s serial_number=%s sse_clients=%s",
        request_id,
        sn,
        len(sse_clients),
    )
    try:
        await _broadcast_sse(
            {"type": "work_merge_fetch", "request_id": request_id, "serial_number": sn}
        )
        out = await asyncio.wait_for(fut, timeout=WORK_MERGE_TIMEOUT_SEC)
        if isinstance(out, dict):
            logger.info(
                "work_merge ok request_id=%s serial_number=%s result=%s",
                request_id,
                sn,
                json.dumps(out, ensure_ascii=False, default=str),
            )
        else:
            logger.info(
                "work_merge ok request_id=%s serial_number=%s unexpected_type=%r",
                request_id,
                sn,
                out,
            )
        return out
    except asyncio.TimeoutError:
        logger.warning(
            "work_merge timeout request_id=%s serial_number=%s after=%.0fs",
            request_id,
            sn,
            WORK_MERGE_TIMEOUT_SEC,
        )
        raise HTTPException(
            status_code=504,
            detail="work merge timed out waiting for browser extension",
        )
    finally:
        async with _work_merge_lock:
            _work_merge_futures.pop(request_id, None)


@app.post(
    "/api/v1/work-merge-result",
    tags=["扩展回调"],
    summary="回传多站合并抓取结果",
    description="仅接受与等待中的 `request_id` 匹配的结果；未知或已完成的 ID 返回 `ignored`。",
    response_model=StatusResponse,
    responses={400: {"model": ErrorResponse}},
)
async def receive_work_merge_result(body: WorkMergeResultBody):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _work_merge_lock:
        fut = _work_merge_futures.get(rid)
    if fut is None or fut.done():
        logger.info("work_merge_result ignored request_id=%s", rid)
        return {"status": "ignored"}
    out: Dict[str, Any] = {
        "ok": body.ok,
        "serial_number": (body.serial_number or "").strip(),
        "data": body.merged,
        "per_site": body.per_site or {},
    }
    if body.error:
        out["error"] = body.error
    fut.set_result(out)
    logger.info(
        "work_merge_result request_id=%s ok=%s serial_number=%s error=%s",
        rid,
        body.ok,
        (body.serial_number or "").strip(),
        body.error,
    )
    return {"status": "success"}


@app.get(
    "/api/v1/actress/{actress_jp_name}",
    tags=["扩展命令"],
    summary="抓取 Minnano 女优资料",
    description="下发 `minnano_actress_fetch` SSE 事件并等待扩展回调，最长 120 秒。",
    responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}, 504: {"model": ErrorResponse}, 200: {"model": ActressFetchResponse}},
)
async def get_actress_minnano(
    actress_jp_name: str,
    minnano_url: Optional[str] = Query(
        None,
        description="缓存的 minnano 详情 id（数字片段），非空则直达 actress{id}.html",
    ),
):
    jp = actress_jp_name.strip()
    if not jp:
        raise HTTPException(status_code=400, detail="actress_jp_name required")
    if len(sse_clients) == 0:
        raise HTTPException(
            status_code=503, detail="no browser extension connected (SSE)"
        )
    request_id = str(uuid.uuid4())
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    async with _actress_fetch_lock:
        _actress_fetch_futures[request_id] = fut
        _actress_fetch_names[request_id] = jp
    message: Dict[str, Any] = {
        "type": "minnano_actress_fetch",
        "request_id": request_id,
        "actress_jp_name": jp,
    }
    mid = (minnano_url or "").strip()
    if mid:
        message["minnano_url"] = mid
    logger.info(
        "actress_fetch wait request_id=%s name=%s minnano_url=%s",
        request_id,
        jp,
        mid or "",
    )
    try:
        await _broadcast_sse(message)
        out = await asyncio.wait_for(fut, timeout=WORK_MERGE_TIMEOUT_SEC)
        logger.info(
            "actress_fetch ok request_id=%s name=%s result_ok=%s",
            request_id,
            jp,
            out.get("ok") if isinstance(out, dict) else None,
        )
        return out
    except asyncio.TimeoutError:
        logger.warning(
            "actress_fetch timeout request_id=%s name=%s after=%.0fs",
            request_id,
            jp,
            WORK_MERGE_TIMEOUT_SEC,
        )
        raise HTTPException(
            status_code=504,
            detail="actress fetch timed out waiting for browser extension",
        )
    finally:
        async with _actress_fetch_lock:
            _actress_fetch_futures.pop(request_id, None)
            _actress_fetch_names.pop(request_id, None)


@app.post(
    "/api/v1/actress-fetch-result",
    tags=["扩展回调"],
    summary="回传 Minnano 女优抓取结果",
    description="仅接受与等待中的 `request_id` 匹配的结果；未知或已完成的 ID 返回 `ignored`。",
    response_model=StatusResponse,
    responses={400: {"model": ErrorResponse}},
)
async def receive_actress_fetch_result(body: ActressFetchResultBody):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _actress_fetch_lock:
        fut = _actress_fetch_futures.get(rid)
        fallback = _actress_fetch_names.get(rid, "")
    if fut is None or fut.done():
        logger.info("actress_fetch_result ignored request_id=%s", rid)
        return {"status": "ignored"}
    out: Dict[str, Any] = {
        "ok": body.ok,
        "actress_jp_name": (body.actress_jp_name or "").strip() or fallback,
        "data": body.data,
    }
    if body.error:
        out["error"] = body.error
    fut.set_result(out)
    logger.info(
        "actress_fetch_result request_id=%s ok=%s name=%s error=%s",
        rid,
        body.ok,
        out["actress_jp_name"],
        body.error,
    )
    return {"status": "success"}


@app.get(
    "/api/v1/top-actresses",
    tags=["扩展命令"],
    summary="抓取 Javtxt 热门女优列表",
    description="下发 `javtxt_top_actresses_fetch` SSE 事件并等待扩展回调，最长 120 秒。",
    responses={503: {"model": ErrorResponse}, 504: {"model": ErrorResponse}, 200: {"model": TopActressesResponse}},
)
async def get_top_actresses():
    if len(sse_clients) == 0:
        raise HTTPException(
            status_code=503, detail="no browser extension connected (SSE)"
        )
    request_id = str(uuid.uuid4())
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    async with _top_actresses_lock:
        _top_actresses_futures[request_id] = fut
    logger.info("top_actresses wait request_id=%s", request_id)
    try:
        await _broadcast_sse(
            {"type": "javtxt_top_actresses_fetch", "request_id": request_id}
        )
        out = await asyncio.wait_for(fut, timeout=WORK_MERGE_TIMEOUT_SEC)
        n = len(out.get("names") or []) if isinstance(out, dict) else 0
        logger.info(
            "top_actresses ok request_id=%s result_ok=%s name_count=%s",
            request_id,
            out.get("ok") if isinstance(out, dict) else None,
            n,
        )
        return out
    except asyncio.TimeoutError:
        logger.warning(
            "top_actresses timeout request_id=%s after=%.0fs",
            request_id,
            WORK_MERGE_TIMEOUT_SEC,
        )
        raise HTTPException(
            status_code=504,
            detail="top actresses fetch timed out waiting for browser extension",
        )
    finally:
        async with _top_actresses_lock:
            _top_actresses_futures.pop(request_id, None)


@app.post(
    "/api/v1/top-actresses-result",
    tags=["扩展回调"],
    summary="回传热门女优列表",
    description="仅接受与等待中的 `request_id` 匹配的结果；未知或已完成的 ID 返回 `ignored`。",
    response_model=StatusResponse,
    responses={400: {"model": ErrorResponse}},
)
async def receive_top_actresses_result(body: TopActressesResultBody):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _top_actresses_lock:
        fut = _top_actresses_futures.get(rid)
    if fut is None or fut.done():
        logger.info("top_actresses_result ignored request_id=%s", rid)
        return {"status": "ignored"}
    names = [str(x) for x in (body.names or []) if x is not None]
    out: Dict[str, Any] = {"ok": body.ok, "names": names}
    if body.error:
        out["error"] = body.error
    fut.set_result(out)
    logger.info(
        "top_actresses_result request_id=%s ok=%s name_count=%s error=%s",
        rid,
        body.ok,
        len(names),
        body.error,
    )
    return {"status": "success"}


@app.post(
    "/api/v1/image",
    tags=["扩展命令"],
    summary="通过浏览器下载封面图",
    description="下发 `fetch_cover_image` SSE 事件。无扩展连接或在 30 秒内超时均返回 HTTP 200 与 `success=false`。",
    responses={400: {"model": ErrorResponse}, 200: {"model": ImageResponse}},
)
async def image_by_url(body: ImageByUrlBody):
    image_url = (body.url or "").strip()
    if not _allowed_any_http_cover_url(image_url):
        raise HTTPException(status_code=400, detail="invalid url")
    if len(sse_clients) == 0:
        return {"success": False, "image": None, "message": "未检测到接口连接"}
    rid = uuid.uuid4().hex
    fut = asyncio.get_running_loop().create_future()
    async with _image_fetch_lock:
        _image_fetch_futures[rid] = fut
    logger.info("cover_image fetch wait request_id=%s url=%s", rid, image_url)
    try:
        await _broadcast_sse(
            {"type": "fetch_cover_image", "url": image_url, "request_id": rid}
        )
        out = await asyncio.wait_for(fut, timeout=IMAGE_FETCH_TIMEOUT_SEC)
        ok = bool(out.get("success")) if isinstance(out, dict) else False
        logger.info(
            "cover_image fetch done request_id=%s success=%s msg=%s",
            rid,
            ok,
            (out.get("message") if isinstance(out, dict) else None) or "",
        )
        return out
    except asyncio.TimeoutError:
        logger.warning(
            "cover_image fetch timeout request_id=%s after=%.0fs",
            rid,
            IMAGE_FETCH_TIMEOUT_SEC,
        )
        return {"success": False, "image": None, "message": "未在时限内返回图片"}
    finally:
        async with _image_fetch_lock:
            _image_fetch_futures.pop(rid, None)


@app.post(
    "/api/v1/cover-image-fetch-result",
    tags=["扩展回调"],
    summary="回传封面图 Base64 数据",
    description="Base64 解码后的图片必须介于 5 KiB 与 30 MiB 之间。",
    response_model=StatusResponse,
    responses={400: {"model": ErrorResponse}},
)
async def receive_cover_image_fetch_result(body: CoverImageFetchResult):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _image_fetch_lock:
        fut = _image_fetch_futures.get(rid)
    if not body.ok:
        if fut is not None and not fut.done():
            fut.set_result(
                {"success": False, "image": None, "message": body.error or "失败"}
            )
        logger.info(
            "cover_image_result request_id=%s ok=False err=%s fut_matched=%s",
            rid,
            body.error,
            fut is not None,
        )
    else:
        b64 = (body.content_base64 or "").strip()
        if not b64:
            if fut is not None and not fut.done():
                fut.set_result(
                    {"success": False, "image": None, "message": "无图片数据"}
                )
            logger.info(
                "cover_image_result request_id=%s ok=True empty_b64 fut_matched=%s",
                rid,
                fut is not None,
            )
        else:
            try:
                raw = base64.b64decode(b64, validate=True)
                if len(raw) < 5 * 1024:
                    raise ValueError("图片过小（小于 5KB）")
                if len(raw) > 30 * 1024 * 1024:
                    raise ValueError("图片过大")
                if fut is not None and not fut.done():
                    fut.set_result({"success": True, "image": b64})
                logger.info(
                    "cover_image_result request_id=%s ok=True bytes=%s fut_matched=%s",
                    rid,
                    len(raw),
                    fut is not None,
                )
            except Exception as e:
                if fut is not None and not fut.done():
                    fut.set_result(
                        {"success": False, "image": None, "message": f"解码失败: {e}"}
                    )
                logger.warning(
                    "cover_image_result request_id=%s decode_fail err=%s fut_matched=%s",
                    rid,
                    e,
                    fut is not None,
                )
    return {"status": "success"}


@app.post(
    "/api/v1/check_existence",
    tags=["主程序代理"],
    summary="代理主程序的批量查重接口",
    description="请求体、响应体与状态码原样转发至桌面主程序；请以主程序接口文档为准。上游不可用时返回 502。",
    responses={502: {"model": ErrorResponse}},
)
async def proxy_check_existence(request: Request) -> Response:
    # 插件批量查重依赖主程序数据库，转发到软件本体。
    return await _forward(request, "api/v1/check_existence")


@app.post(
    "/api/v1/minnano-actress-capture",
    tags=["主程序代理"],
    summary="代理 Minnano 采集提示",
    description="请求体、响应体与状态码由桌面主程序定义并原样透传；上游不可用时返回 502。",
    responses={502: {"model": ErrorResponse}},
)
async def proxy_minnano_actress_capture(request: Request) -> Response:
    # 插件采集提示需回到主程序，触发 UI/编辑流。
    return await _forward(request, "api/v1/minnano-actress-capture")


@app.post(
    "/api/v1/capture/one",
    tags=["主程序代理"],
    summary="代理一键采集提示",
    description="请求体、响应体与状态码由桌面主程序定义并原样透传；上游不可用时返回 502。",
    responses={502: {"model": ErrorResponse}},
)
async def proxy_capture_one(request: Request) -> Response:
    # 插件一键采集提示，交由主程序桥接。
    return await _forward(request, "api/v1/capture/one")


@app.post(
    "/api/v1/crawler-backlog-warning",
    tags=["主程序代理"],
    summary="代理采集拥塞提示",
    description="请求体、响应体与状态码由桌面主程序定义并原样透传；上游不可用时返回 502。",
    responses={502: {"model": ErrorResponse}},
)
async def proxy_crawler_backlog_warning(request: Request) -> Response:
    # 插件拥塞提示，转发给主程序弹窗。
    return await _forward(request, "api/v1/crawler-backlog-warning")


@app.post(
    "/api/v1/cloudflare-challenge-notify",
    tags=["主程序代理"],
    summary="代理 Cloudflare 挑战提示",
    description="请求体、响应体与状态码由桌面主程序定义并原样透传；上游不可用时返回 502。",
    responses={502: {"model": ErrorResponse}},
)
async def proxy_cloudflare_challenge_notify(request: Request) -> Response:
    # 插件反爬挑战提示，转发给主程序弹窗。
    return await _forward(request, "api/v1/cloudflare-challenge-notify")


@app.get(
    "/events",
    tags=["事件流"],
    summary="建立浏览器扩展 SSE 长连接",
    description="响应为 `text/event-stream`。Worker 下发 `navigate`、`work_merge_fetch`、`minnano_actress_fetch`、`javtxt_top_actresses_fetch` 或 `fetch_cover_image` JSON 事件。",
    responses={200: {"description": "持续输出 SSE `data: <JSON>\\n\\n` 帧。", "content": {"text/event-stream": {}}}},
)
async def sse_endpoint(request: Request):
    async def event_generator():
        client_queue = asyncio.Queue()
        sse_clients.append(client_queue)
        logger.info(
            "sse client connected total=%s client=%s",
            len(sse_clients),
            request.client.host if request.client else "?",
        )
        try:
            while True:
                if await request.is_disconnected():
                    break
                data = await client_queue.get()
                yield data
        except asyncio.CancelledError:
            pass
        finally:
            if client_queue in sse_clients:
                sse_clients.remove(client_queue)
            logger.info("sse client disconnected total=%s", len(sse_clients))

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.api_route(
    "/api/v1/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    tags=["主程序代理"],
    summary="代理未显式实现的主程序 API",
    description="除 Worker 自有的显式路由外，`/api/v1/*` 请求会原样转发至桌面主程序。请求体、响应体、状态码和所需参数以主程序接口契约为准；上游不可用时返回 502。",
    responses={502: {"model": ErrorResponse}},
    include_in_schema=False,
)
async def proxy_browser_plugin_api(request: Request, path: str) -> Response:
    # 其余插件/联调请求走主程序；核心四个 API 由本服务显式覆盖执行。
    logger.info("proxy catch-all api/v1/%s method=%s", path, request.method)
    return await _forward(request, f"api/v1/{path}")
