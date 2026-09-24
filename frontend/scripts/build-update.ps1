param(
    [string]$SigningKeyPath,
    [string]$ReleaseNotes,
    [string]$OutputDirectory
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
$OutputDir = if ($OutputDirectory) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $RepoRoot "outputs/auto-update-v1" }
$Python = Join-Path $RepoRoot "backend/.venv/Scripts/python.exe"
if (!$SigningKeyPath) { $SigningKeyPath = Join-Path $RepoRoot "outputs/auto-update-v1/private/updater.key" }
if (!$ReleaseNotes) { $ReleaseNotes = Join-Path $OutputDir "release-notes.md" }
if (!(Test-Path -LiteralPath $SigningKeyPath)) { throw "缺少更新签名私钥，不能构建发布包。" }
if (!(Test-Path -LiteralPath $ReleaseNotes)) { throw "缺少版本说明。" }
$Config = Get-Content "$RepoRoot/frontend/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $Config.version
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
# 发布前先锁版本号：0.2.7 曾漏改 backend/app/version.py，
# 打出的安装包一启动就变砖，只能重装。不一致就禁止发布。
$VersionCheck = 1
Push-Location (Join-Path $RepoRoot "backend")
try {
    $PreviousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $Python -m pytest tests/test_version_consistency.py -q *> "$OutputDir/version-check.log"
    $VersionCheck = $LASTEXITCODE
    $ErrorActionPreference = $PreviousEap
} finally { Pop-Location }
if ($VersionCheck) { throw "版本号不一致，已停止发布。查看 version-check.log" }
$PreviousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$PreviousRoot = $env:SUXING_REPO_ROOT
try {
    $env:SUXING_REPO_ROOT = $RepoRoot
    $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $SigningKeyPath).Path
    Push-Location $RepoRoot
    try {
        & $Python -m PyInstaller --noconfirm --distpath "$OutputDir/sidecar" --workpath "$OutputDir/build/pyinstaller" "$RepoRoot/frontend/pyinstaller/python-backend.spec" *> "$OutputDir/sidecar-build.log"
        if ($LASTEXITCODE) { throw "后台打包失败，查看 sidecar-build.log" }
        Copy-Item -LiteralPath "$OutputDir/sidecar/python-backend.exe" -Destination "$RepoRoot/frontend/src-tauri/binaries/python-backend-x86_64-pc-windows-msvc.exe" -Force
    } finally { Pop-Location }
    Push-Location "$RepoRoot/frontend"
    try {
        cargo tauri build --ci *> "$OutputDir/desktop-build.log"
        if ($LASTEXITCODE) { throw "桌面版打包失败，查看 desktop-build.log" }
    } finally { Pop-Location }
    $BuiltInstaller = "闪寻空间_${Version}_x64-setup.exe"
    $Installer = "suxing-gallery_${Version}_x64-setup.exe"
    foreach ($Suffix in @("", ".sig")) {
        Copy-Item -LiteralPath "$RepoRoot/frontend/src-tauri/target/release/bundle/nsis/$BuiltInstaller$Suffix" -Destination "$OutputDir/$Installer$Suffix" -Force
    }
    & $Python "$PSScriptRoot/make-update-manifest.py" --version $Version --installer "$OutputDir/$Installer" --notes $ReleaseNotes --output "$OutputDir/latest.json"
    if ($LASTEXITCODE) { throw "更新清单生成失败" }
    Write-Output "已生成签名安装包和 latest.json：$OutputDir"
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $PreviousKey
    $env:SUXING_REPO_ROOT = $PreviousRoot
}
