# macOS-only portable executable; keep the Windows main.spec independent.
import os
import sys

from PyInstaller.utils.hooks import collect_data_files

if sys.platform != "darwin":
    raise SystemExit("Build this spec on macOS.")

a = Analysis(
    [os.path.join(SPECPATH, "main.py")],
    pathex=[SPECPATH],
    datas=collect_data_files("certifi"),
    hiddenimports=["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.h11_impl",
                   "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on"],
    excludes=["watchfiles", "httptools", "websockets", "yaml", "tkinter"],
    optimize=2,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="mosaic-bridge",
    console=True,
    strip=False,
    upx=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
