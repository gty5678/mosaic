import logging


def main() -> None:
    # 直接运行本文件时无包上下文，不能用相对导入；见 sys.path 上已有项目根。
    from app import app
    import uvicorn

    logging.getLogger("server2.worker").info(
        "Running extension worker gateway on http://127.0.0.1:56790"
    )
    uvicorn.run(app, host="127.0.0.1", port=56790, log_config=None)


if __name__ == "__main__":
    main()

