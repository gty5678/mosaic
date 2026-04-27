# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 6.x + FastAPI / Uvicorn / httpx
# 单文件: dist\darkeye-extension-worker.exe
# 使用：在仓库根目录  pyinstaller darkeye-extension-worker.spec  或  .\build-installer.ps1

import os

from PyInstaller.utils.hooks import collect_data_files

# PyInstaller 6：SPECPATH 为放 .spec 的目录的绝对路径（不要再 dirname）
_p = os.path.abspath(SPECPATH)
SPEC_DIR = _p if os.path.isdir(_p) else os.path.dirname(_p)

# 依赖图从 main.py 分析即可；仅 certifi 的 PEM 是数据文件，单独带上以免 HTTPS 在 onefile 下缺证书
datas = list(collect_data_files("certifi"))
binaries = []
hiddenimports = []

# 本机 Anaconda 等环境下常被误跟进的科学/ML/GUI/云/测试栈，与 HTTP Worker 无关，排除以缩小体积并避免坏依赖
EXCLUDES = (
    "PIL",
    "Pillow",
    "IPython",
    "PyQt5",
    "PyQt6",
    "PySide2",
    "PySide6",
    "aiohttp",
    "altair",
    "bokeh",
    "boto3",
    "botocore",
    "catboost",
    "cv2",
    "dask",
    "distributed",
    "folium",
    "gradio",
    "h5py",
    "imageio",
    "jupyter",
    "jupyterlab",
    "kivy",
    "lightgbm",
    "llvmlite",
    "lxml",
    "matplotlib",
    "mypy",
    "networkx",
    "notebook",
    "numba",
    "numpy",
    "openpyxl",
    "pandas",
    "patsy",
    "plotly",
    "pyarrow",
    "pygame",
    "pytest",
    "scipy",
    "seaborn",
    "shiboken2",
    "shiboken6",
    "skimage",
    "sklearn",
    "sphinx",
    "sqlalchemy",
    "statsmodels",
    "streamlit",
    "sympy",
    "tables",
    "tensorboard",
    "tensorflow",
    "tkinter",
    "torch",
    "torchaudio",
    "torchvision",
    "tornado",
    "wandb",
    "xarray",
    "xgboost",
    "xlrd",
    "wx",
    "zmq",
    'sqlite3.test',                                       #一些python自带的
    'tkinter',
    'pytest',
    'test',
    'pydoc',
    'tabnanny',
    'pydoc_data',
    'pkg_resources',
    'setuptools',
    'pip',
    'wheel',
    'virtualenv',
    #老旧/很少用的网络与协议模块
    'cgi',
    'cgitb',
    'smtpd',
    'nntplib',
    'poplib',
    'imaplib',
    'smtplib',
    'telnetlib',
    'xmlrpc.client',
    'xmlrpc.server',
    #音频、多媒体、教学/演示相关
    'aifc',
    'sunau',
    'wave',
    'audioop',
    'turtle',
    'idlelib',
    'ossaudiodev',
    #过时的构建/迁移工具
    'distutils',
    'lib2to3',
    '2to3',
    # 调试和测试模块
    'doctest',
    # 'unittest',  # 不能排除：pyparsing（matplotlib 依赖）的 testing 子模块会 import unittest
    'pdb',
    'trace',
    # 构建和部署模块
    'setuptools',
    'venv',

    # 不常用的数据格式和工具
    'uu',
    'lzma',
    #'bz2',
    'wsgiref',
    'xml.etree.cElementTree',
    # 特定环境的模块
    #'msvcrt',
    '_osx_support',
    'binhex',
    'xdrlib',
    'filecmp',
    'chunk',
    'imghdr',
)

a = Analysis(
    [os.path.join(SPEC_DIR, "main.py")],
    pathex=[SPEC_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=list(EXCLUDES),
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure, a.zipped_data)


exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="info-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
