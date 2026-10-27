# Omni Upscale 运行时下载脚本
#
# 仓库里不含 ffmpeg 与 Real-ESRGAN 的二进制（合计约 112 MB），
# 首次 clone 后跑一次这个脚本即可。已经存在则跳过。
#
# 优先从本项目 Release 下载打包好的 runtime.zip（国内比 gyan.dev 稳），
# 失败再回退到官方源分项下载。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1 -Proxy http://127.0.0.1:65533
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-runtime.ps1 -UseOfficial -Force

param(
    [string]$Proxy = "",
    [switch]$Force,
    [switch]$UseOfficial
)

$ErrorActionPreference = "Stop"
# 关掉 Invoke-WebRequest 的逐块进度输出，日志才看得清
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$resources = Join-Path $root "resources"
$temp = Join-Path $env:TEMP ("omni-runtime-" + [guid]::NewGuid().ToString("N").Substring(0, 8))

New-Item -ItemType Directory -Path $temp -Force | Out-Null
New-Item -ItemType Directory -Path $resources -Force | Out-Null

$webArgs = @{ UseBasicParsing = $true }
if ($Proxy -ne "") {
    $webArgs["Proxy"] = $Proxy
    Write-Host "使用代理: $Proxy" -ForegroundColor DarkGray
}

function Get-File([string]$Url, [string]$OutFile) {
    Write-Host "下载 $Url" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $Url -OutFile $OutFile @webArgs
    $size = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
    Write-Host "  完成，$size MB" -ForegroundColor DarkGray
}

$ffmpegDir = Join-Path $resources "ffmpeg"
$ffmpegExe = Join-Path $ffmpegDir "ffmpeg.exe"
$esrganDir = Join-Path $resources "realesrgan"
$esrganExe = Join-Path $esrganDir "realesrgan-ncnn-vulkan.exe"

$hasFfmpeg = (Test-Path $ffmpegExe) -and -not $Force
$hasEsrgan = (Test-Path $esrganExe) -and -not $Force

if ($hasFfmpeg -and $hasEsrgan) {
    Write-Host "运行时已齐全，无需下载（要重装加 -Force）" -ForegroundColor DarkGray
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

# ── 优先：从本项目 Release 拉整套运行时 ──────────────────
if (-not $UseOfficial) {
    $mirror = "https://github.com/Stringadmin/omni-upscale/releases/latest/download/omni-upscale-runtime.zip"
    try {
        $zip = Join-Path $temp "runtime.zip"
        Get-File $mirror $zip
        Write-Host "解压到 resources/…" -ForegroundColor Cyan
        Expand-Archive -Path $zip -DestinationPath $root -Force
        $hasFfmpeg = Test-Path $ffmpegExe
        $hasEsrgan = Test-Path $esrganExe
        if ($hasFfmpeg -and $hasEsrgan) {
            Write-Host "  镜像下载完成" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  镜像不可用（$($_.Exception.Message)），改用官方源" -ForegroundColor Yellow
    }
}

# ── 回退：官方源分项下载 ────────────────────────────────
if (-not $hasFfmpeg) {
    $zip = Join-Path $temp "ffmpeg.zip"
    Get-File "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $zip

    Write-Host "解压 FFmpeg…" -ForegroundColor Cyan
    Expand-Archive -Path $zip -DestinationPath (Join-Path $temp "ffmpeg") -Force

    $found = Get-ChildItem -Path (Join-Path $temp "ffmpeg") -Filter "ffmpeg.exe" -Recurse |
        Select-Object -First 1
    if (-not $found) { throw "压缩包里没找到 ffmpeg.exe" }

    New-Item -ItemType Directory -Path $ffmpegDir -Force | Out-Null
    Copy-Item $found.FullName $ffmpegExe -Force
    Write-Host "  -> resources/ffmpeg/ffmpeg.exe" -ForegroundColor DarkGray
}

if (-not $hasEsrgan) {
    $zip = Join-Path $temp "realesrgan.zip"
    Get-File "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip" $zip

    Write-Host "解压 Real-ESRGAN…" -ForegroundColor Cyan
    Expand-Archive -Path $zip -DestinationPath (Join-Path $temp "esrgan") -Force

    $found = Get-ChildItem -Path (Join-Path $temp "esrgan") -Filter "realesrgan-ncnn-vulkan.exe" -Recurse |
        Select-Object -First 1
    if (-not $found) { throw "压缩包里没找到 realesrgan-ncnn-vulkan.exe" }

    $srcDir = Split-Path -Parent $found.FullName
    New-Item -ItemType Directory -Path $esrganDir -Force | Out-Null
    Copy-Item (Join-Path $srcDir "*") $esrganDir -Recurse -Force
    Write-Host "  -> resources/realesrgan/" -ForegroundColor DarkGray
}

Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "运行时准备完成。" -ForegroundColor Green
Write-Host "  npm install" -ForegroundColor DarkGray
Write-Host "  npm start" -ForegroundColor DarkGray
