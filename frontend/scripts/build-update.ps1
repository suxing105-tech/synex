param(
    [string]$SigningKeyPath,
    [string]$ReleaseNotes
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
$OutputDir = Join-Path $RepoRoot "outputs/auto-update-v1"
$Python = Join-Path $RepoRoot "backend/.venv/Scripts/python.exe"
if (!$SigningKeyPath) { $SigningKeyPath = Join-Path $OutputDir "private/updater.key" }
if (!$ReleaseNotes) { $ReleaseNotes = Join-Path $OutputDir "release-notes.md" }
if (!(Test-Path -LiteralPath $SigningKeyPath)) { throw "缺少更新签名私钥，不能构建发布包。" }
if (!(Test-Path -LiteralPath $ReleaseNotes)) { throw "缺少版本说明。" }
$Config = Get-Content "$RepoRoot/frontend/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $Config.version
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
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
    $Installer = "苏醒图库_${Version}_x64-setup.exe"
    foreach ($Name in @($Installer, "$Installer.sig")) {
        Copy-Item -LiteralPath "$RepoRoot/frontend/src-tauri/target/release/bundle/nsis/$Name" -Destination "$OutputDir/$Name" -Force
    }
    & $Python "$PSScriptRoot/make-update-manifest.py" --version $Version --installer "$OutputDir/$Installer" --notes $ReleaseNotes --output "$OutputDir/latest.json"
    if ($LASTEXITCODE) { throw "更新清单生成失败" }
    Write-Output "已生成签名安装包和 latest.json：$OutputDir"
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $PreviousKey
    $env:SUXING_REPO_ROOT = $PreviousRoot
}
