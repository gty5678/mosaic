import logging
import os
import sys

_FROZEN = bool(getattr(sys, "frozen", False))


def _env_if_frozen() -> None:
    # PyInstaller onefile: 确保证书路径，否则 httpx 访问 https 主程序/站点可能失败
    if not _FROZEN or not hasattr(sys, "_MEIPASS"):
        return
    import certifi

    c = certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", c)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", c)


def main() -> None:
    _env_if_frozen()

    # log_config=None 时 Uvicorn 不会配置 logging，根 logger 默认 WARNING，app 里 info 全被吞掉。
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
        force=True,
    )

    # 直接运行本文件时无包上下文，不能用相对导入；见 sys.path 上已有项目根。
    from app import app
    import uvicorn

    # onefile 下 httptools 的 native 部分偶发无法加载，冻结时用纯 Python 的 h11
    if _FROZEN and os.environ.get("DARKEYE_UVICORN_USE_HTTPTOOLS", "").lower() in ("1", "true", "yes"):
        http_impl = "auto"
    else:
        http_impl = "h11" if _FROZEN else "auto"

    logging.getLogger("server2.worker").info(
        "Running extension worker gateway on http://127.0.0.1:56790 (frozen=%s http=%s)",
        _FROZEN,
        http_impl,
    )
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=56790,
        log_config=None,
        http=http_impl,
    )


if __name__ == "__main__":
    # Windows 打包后若子进程/部分依赖触发 multiprocessing，需 freeze_support
    if sys.platform == "win32":
        import multiprocessing

        multiprocessing.freeze_support()

    try:
        main()
    except Exception:
        if _FROZEN:
            import traceback

            _log = os.path.join(
                os.environ.get("TEMP", os.path.expanduser("~")),
                "darkeye-extension-worker-fatal.log",
            )
            with open(_log, "w", encoding="utf-8", errors="replace") as f:
                f.write("Fatal error. See Python traceback below.\n\n")
                traceback.print_exc(file=f)
        raise

