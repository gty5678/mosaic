
# Produce one executable and unpacked browser extensions.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

foreach ($extension in @("chrome_capture", "firefox_capture")) {
    $manifest = Join-Path $PSScriptRoot "extensions\$extension\manifest.json"
    if (-not (Test-Path $manifest -PathType Leaf)) { throw "Missing: $manifest" }
}

# 清理旧的构建目录
Write-Host "Cleaning old build and dist folders..."

if (Test-Path build) {Remove-Item build -Recurse -Force}

$distDir = ".\output"
if (Test-Path $distDir) {Remove-Item $distDir -Recurse -Force}


if (Test-Path ".\dist") {Remove-Item ".\dist" -Recurse -Force}

# 如果存在 __pycache__，也清掉
if (Test-Path __pycache__) {
    Remove-Item __pycache__ -Recurse -Force
}

# 1. 记录开始时间
$startTime = Get-Date

# 通过 uv 在项目锁定的开发环境中运行 PyInstaller
Write-Host "Building with PyInstaller..."
uv run --group dev pyinstaller --clean --noconfirm --distpath $distDir .\main.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

Write-Host "Collecting browser extensions to $distDir..."
$extensionsDir = Join-Path $distDir "extensions"
New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
foreach ($extension in @("chrome_capture", "firefox_capture")) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "extensions\$extension") -Destination $extensionsDir -Recurse -Force
}

Write-Host "Build complete."
# 3. 记录结束时间
$endTime = Get-Date

# 4. 计算耗时
$timeElapsed = $endTime - $startTime

# 5. 输出结果
Write-Host "spend time: $($timeElapsed.TotalSeconds) seconds"
