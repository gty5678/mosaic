
#这个作为排包探测器用，正式不用这个打包

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

# 运行 pyinstaller 打包
Write-Host "Building with PyInstaller..."
pyinstaller --clean --noconfirm --distpath $distDir .\main.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

Write-Host "Zipping browser extensions to $distDir..."
$ff = Join-Path $PWD "extensions\firefox_capture"
$ch = Join-Path $PWD "extensions\chrome_capture"
if (-not (Test-Path $ff)) { throw "Missing: $ff" }
if (-not (Test-Path $ch)) { throw "Missing: $ch" }
Compress-Archive -Path $ff -DestinationPath (Join-Path $distDir "firefox_capture.zip") -Force
Compress-Archive -Path $ch -DestinationPath (Join-Path $distDir "chrome_capture.zip") -Force

Write-Host "Build complete."
# 3. 记录结束时间
$endTime = Get-Date

# 4. 计算耗时
$timeElapsed = $endTime - $startTime

# 5. 输出结果
Write-Host "spend time: $($timeElapsed.TotalSeconds) seconds"
