import asyncio
import base64
import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

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

app = FastAPI(title="DarkEye Extension Worker")
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
    request_id: str
    ok: bool
    merged: Optional[Dict[str, Any]] = None
    per_site: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    serial_number: Optional[str] = None


class ActressFetchResultBody(BaseModel):
    request_id: str
    ok: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    actress_jp_name: Optional[str] = None


class TopActressesResultBody(BaseModel):
    request_id: str
    ok: bool
    names: Optional[List[str]] = None
    error: Optional[str] = None


class ImageByUrlBody(BaseModel):
    url: str


class CoverImageFetchResult(BaseModel):
    request_id: str
    ok: bool
    error: Optional[str] = None
    content_base64: Optional[str] = None


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
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_filtered_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )


async def _broadcast_sse(message: Dict[str, Any]) -> None:
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


@app.get("/api/v1/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "DarkEye Extension Worker"}


class NavigateCommand(BaseModel):
    url: str
    target: str = "new_tab"  # new_tab 或 current_tab
    context: Optional[Dict[str, Any]] = None


@app.post("/api/v1/navigate")
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
    return {"status": "success", "count": len(sse_clients)}


@app.get("/api/v1/work/{serial_number}")
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
    try:
        await _broadcast_sse(
            {"type": "work_merge_fetch", "request_id": request_id, "serial_number": sn}
        )
        return await asyncio.wait_for(fut, timeout=WORK_MERGE_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="work merge timed out waiting for browser extension",
        )
    finally:
        async with _work_merge_lock:
            _work_merge_futures.pop(request_id, None)


@app.post("/api/v1/work-merge-result")
async def receive_work_merge_result(body: WorkMergeResultBody):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _work_merge_lock:
        fut = _work_merge_futures.get(rid)
    if fut is None or fut.done():
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
    return {"status": "success"}


@app.get("/api/v1/actress/{actress_jp_name}")
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
    try:
        await _broadcast_sse(message)
        return await asyncio.wait_for(fut, timeout=WORK_MERGE_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="actress fetch timed out waiting for browser extension",
        )
    finally:
        async with _actress_fetch_lock:
            _actress_fetch_futures.pop(request_id, None)
            _actress_fetch_names.pop(request_id, None)


@app.post("/api/v1/actress-fetch-result")
async def receive_actress_fetch_result(body: ActressFetchResultBody):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _actress_fetch_lock:
        fut = _actress_fetch_futures.get(rid)
        fallback = _actress_fetch_names.get(rid, "")
    if fut is None or fut.done():
        return {"status": "ignored"}
    out: Dict[str, Any] = {
        "ok": body.ok,
        "actress_jp_name": (body.actress_jp_name or "").strip() or fallback,
        "data": body.data,
    }
    if body.error:
        out["error"] = body.error
    fut.set_result(out)
    return {"status": "success"}


@app.get("/api/v1/top-actresses")
async def get_top_actresses():
    if len(sse_clients) == 0:
        raise HTTPException(
            status_code=503, detail="no browser extension connected (SSE)"
        )
    request_id = str(uuid.uuid4())
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    async with _top_actresses_lock:
        _top_actresses_futures[request_id] = fut
    try:
        await _broadcast_sse(
            {"type": "javtxt_top_actresses_fetch", "request_id": request_id}
        )
        return await asyncio.wait_for(fut, timeout=WORK_MERGE_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="top actresses fetch timed out waiting for browser extension",
        )
    finally:
        async with _top_actresses_lock:
            _top_actresses_futures.pop(request_id, None)


@app.post("/api/v1/top-actresses-result")
async def receive_top_actresses_result(body: TopActressesResultBody):
    rid = (body.request_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="request_id required")
    async with _top_actresses_lock:
        fut = _top_actresses_futures.get(rid)
    if fut is None or fut.done():
        return {"status": "ignored"}
    names = [str(x) for x in (body.names or []) if x is not None]
    out: Dict[str, Any] = {"ok": body.ok, "names": names}
    if body.error:
        out["error"] = body.error
    fut.set_result(out)
    return {"status": "success"}


@app.post("/api/v1/image")
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
    try:
        await _broadcast_sse(
            {"type": "fetch_cover_image", "url": image_url, "request_id": rid}
        )
        return await asyncio.wait_for(fut, timeout=IMAGE_FETCH_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        return {"success": False, "image": None, "message": "未在时限内返回图片"}
    finally:
        async with _image_fetch_lock:
            _image_fetch_futures.pop(rid, None)


@app.post("/api/v1/cover-image-fetch-result")
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
    else:
        b64 = (body.content_base64 or "").strip()
        if not b64:
            if fut is not None and not fut.done():
                fut.set_result(
                    {"success": False, "image": None, "message": "无图片数据"}
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
            except Exception as e:
                if fut is not None and not fut.done():
                    fut.set_result(
                        {"success": False, "image": None, "message": f"解码失败: {e}"}
                    )
    return {"status": "success"}


@app.post("/api/v1/check_existence")
async def proxy_check_existence(request: Request) -> Response:
    # 插件批量查重依赖主程序数据库，转发到软件本体。
    return await _forward(request, "api/v1/check_existence")


@app.post("/api/v1/minnano-actress-capture")
async def proxy_minnano_actress_capture(request: Request) -> Response:
    # 插件采集提示需回到主程序，触发 UI/编辑流。
    return await _forward(request, "api/v1/minnano-actress-capture")


@app.post("/api/v1/capture/one")
async def proxy_capture_one(request: Request) -> Response:
    # 插件一键采集提示，交由主程序桥接。
    return await _forward(request, "api/v1/capture/one")


@app.post("/api/v1/crawler-backlog-warning")
async def proxy_crawler_backlog_warning(request: Request) -> Response:
    # 插件拥塞提示，转发给主程序弹窗。
    return await _forward(request, "api/v1/crawler-backlog-warning")


@app.post("/api/v1/cloudflare-challenge-notify")
async def proxy_cloudflare_challenge_notify(request: Request) -> Response:
    # 插件反爬挑战提示，转发给主程序弹窗。
    return await _forward(request, "api/v1/cloudflare-challenge-notify")


@app.get("/events")
async def sse_endpoint(request: Request):
    async def event_generator():
        client_queue = asyncio.Queue()
        sse_clients.append(client_queue)
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

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.api_route(
    "/api/v1/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_browser_plugin_api(request: Request, path: str) -> Response:
    # 其余插件/联调请求走主程序；核心四个 API 由本服务显式覆盖执行。
    return await _forward(request, f"api/v1/{path}")
