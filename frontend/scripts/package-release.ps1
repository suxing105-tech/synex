# package-release.ps1 - 一键打包：重建 sidecar + tauri build + 组装安装包与快捷启动
# 用法：
#   .\package-release.ps1                 # 先重建 sidecar 再 tauri build，最后组装输出
#   .\package-release.ps1 -SkipBuild      # 跳过编译，仅用现有 target/release 产物组装
#   .\package-release.ps1 -Tag video      # 输出目录名后缀
param(
    [string]$Tag = "preview",
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$FrontendRoot = Join-Path $RepoRoot "frontend"
$TauriDir = Join-Path $FrontendRoot "src-tauri"
$ReleaseDir = Join-Path $TauriDir "target\release"
$OutRoot = Join-Path $RepoRoot "outputs"
$BinariesDir = Join-Path $TauriDir "binaries"
$SidecarBin = Join-Path $BinariesDir "python-backend-x86_64-pc-windows-msvc.exe"

if (-not $SkipBuild) {
    Write-Host "==> [1/3] rebuild sidecar" -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "build-sidecar.ps1")
    if ($LASTEXITCODE -ne 0) { throw "build-sidecar.ps1 failed" }
    Write-Host "==> [2/3] cargo tauri build" -ForegroundColor Cyan
    Push-Location $FrontendRoot
    try { cargo tauri build | Out-Host } finally { Pop-Location }
} else {
    Write-Host "==> SkipBuild: 使用现有 target/release 产物" -ForegroundColor Yellow
}

# 读版本号与最新 NSIS 安装包
$conf = Get-Content (Join-Path $TauriDir "tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
$installer = Get-ChildItem (Join-Path $ReleaseDir "bundle\nsis") -Filter "*_x64-setup.exe" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "NSIS 安装包未找到" }
if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDir "suxing-gallery.exe"))) { throw "release exe 未找到" }
if (-not (Test-Path -LiteralPath $SidecarBin)) { throw "sidecar 未找到: $SidecarBin" }

$pkg = Join-Path $OutRoot ("release-v{0}-{1}" -f $version, $Tag)
# 安全守卫：确认目标位于 outputs 目录内再递归删除
$resolvedOut = (Resolve-Path $OutRoot).Path.TrimEnd('\')
if ($pkg.StartsWith($resolvedOut, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $pkg) { Remove-Item -LiteralPath $pkg -Recurse -Force }
} else { throw "包目录越界，拒绝删除: $pkg" }
New-Item -ItemType Directory -Force -Path (Join-Path $pkg "app") | Out-Null

Copy-Item -LiteralPath (Join-Path $ReleaseDir "suxing-gallery.exe") -Destination (Join-Path $pkg "app\suxing-gallery.exe") -Force
Copy-Item -LiteralPath $SidecarBin -Destination (Join-Path $pkg "app\python-backend.exe") -Force
Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $pkg $installer.Name) -Force

# 启动脚本
$launch = @'
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$previewExe = Join-Path $PSScriptRoot 'app\suxing-gallery.exe'
$previewBackend = Join-Path $PSScriptRoot 'app\python-backend.exe'
if (!(Test-Path -LiteralPath $previewExe -PathType Leaf) -or !(Test-Path -LiteralPath $previewBackend -PathType Leaf)) {
    throw '找不到新版程序，请保留启动入口旁的 app 文件夹。'
}
if ($CheckOnly) { Write-Output 'Preview launcher paths verified.'; exit 0 }
try {
    $runningGallery = @(Get-Process -Name 'suxing-gallery' -ErrorAction SilentlyContinue)
    foreach ($galleryProcess in $runningGallery) {
        if (!$galleryProcess.HasExited -and $galleryProcess.MainWindowHandle -ne 0) {
            [void]$galleryProcess.CloseMainWindow()
        }
    }
    foreach ($galleryProcess in $runningGallery) {
        if (!$galleryProcess.HasExited -and !$galleryProcess.WaitForExit(10000)) {
            throw '旧图库窗口尚未退出，请关闭后再次点击快捷启动。'
        }
    }
    Start-Process -FilePath $previewExe -WorkingDirectory (Split-Path -Parent $previewExe)
} catch {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($_.Exception.Message, '苏醒图库 · 新版预览')
    exit 1
}
'@
Set-Content -LiteralPath (Join-Path $pkg "launch-preview.ps1") -Value $launch -Encoding utf8

# 快捷启动
$shell = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $pkg "快捷启动新版.lnk"
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $pkg "launch-preview.ps1") + '"'
$sc.WorkingDirectory = $pkg
$sc.IconLocation = Join-Path $pkg "app\suxing-gallery.exe"
$sc.WindowStyle = 7
$sc.Save()

# 校验清单
$artifacts = @("app\suxing-gallery.exe", "app\python-backend.exe", $installer.Name) | ForEach-Object {
    $a = Get-Item -LiteralPath (Join-Path $pkg $_)
    [PSCustomObject]@{ file = $_.Replace('\','/'); bytes = $a.Length; sha256 = (Get-FileHash -LiteralPath $a.FullName -Algorithm SHA256).Hash }
}
$artifacts | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pkg "artifacts.json") -Encoding utf8

Write-Host "==> 打包完成: $pkg" -ForegroundColor Green
Write-Host "    安装包: $(Join-Path $pkg $installer.Name)"
Write-Host "    快捷启动: $lnkPath"
