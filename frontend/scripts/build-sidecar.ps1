# build-sidecar.ps1 - PyInstaller pack backend to python-backend.exe
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Resolve-Path "$PSScriptRoot\..\.."
$FrontendRoot = "$RepoRoot\frontend"
$BackendRoot = "$RepoRoot\backend"
$BackendVenv = "$RepoRoot\backend\.venv"
$SpecDir = "$FrontendRoot\pyinstaller"
$SpecFile = "$SpecDir\python-backend.spec"
$DistDir = "$SpecDir\dist"
$BuildDir = "$SpecDir\build"
$BinDir = "$FrontendRoot\src-tauri\binaries"
$Triple = "x86_64-pc-windows-msvc"
$ExeName = "python-backend-$Triple.exe"
$EntryPy = "$BackendRoot\run_server.py"

Write-Host "=== build-sidecar ===" -ForegroundColor Cyan
Write-Host "RepoRoot  = $RepoRoot"
Write-Host "Backend   = $BackendRoot"
Write-Host "Spec      = $SpecFile"
Write-Host "Bin output= $BinDir\$ExeName"

if (-not (Test-Path "$BackendVenv\Scripts\python.exe")) {
    throw "backend venv python missing"
}
if (-not (Test-Path $EntryPy)) {
    throw "backend entry missing: $EntryPy"
}

& "$BackendVenv\Scripts\python.exe" -m pip show pyinstaller 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "==> install pyinstaller" -ForegroundColor Yellow
    & "$BackendVenv\Scripts\python.exe" -m pip install "pyinstaller>=6.10" 2>&1 | Select-Object -Last 5
}

if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "==> run PyInstaller from $BackendRoot" -ForegroundColor Yellow
Push-Location $BackendRoot
try {
    & "$BackendVenv\Scripts\pyinstaller.exe" --clean --noconfirm --distpath "$SpecDir\dist" --workpath "$SpecDir\build" "$SpecFile" 2>&1 | Select-Object -Last 25
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed exit=$LASTEXITCODE" }
} finally {
    Pop-Location
}

$BuiltExe = "$DistDir\python-backend.exe"
if (-not (Test-Path $BuiltExe)) { throw "artifact missing: $BuiltExe" }
Copy-Item -Force $BuiltExe "$BinDir\$ExeName"
Write-Host "==> copied to $BinDir\$ExeName" -ForegroundColor Green

$size = (Get-Item "$BinDir\$ExeName").Length
Write-Host ("==> size {0:N1} MB" -f ($size / 1MB)) -ForegroundColor Cyan

Write-Host "==> smoke test" -ForegroundColor Yellow
$stdoutFile = Join-Path $BinDir "smoke.stdout"
$stderrFile = Join-Path $BinDir "smoke.stderr"
$env:SUXING_PORT = "8765"
$env:SUXING_DATA_DIR = "$RepoRoot\backend\data"
$proc = Start-Process -FilePath "$BinDir\$ExeName" -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru -WindowStyle Hidden
$env:SUXING_PORT = $null
$env:SUXING_DATA_DIR = $null

try {
    $deadline = (Get-Date).AddSeconds(20)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $stdoutFile) {
            $c = Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue
            if ($c -match "READY\s+\{") { $ready = $true; break }
        }
        Start-Sleep -Milliseconds 500
    }

    if ($ready) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 5
            Write-Host "==> /api/health = $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
        } catch {
            Write-Host "==> health request failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "==> READY not received in 20s" -ForegroundColor Red
        if (Test-Path $stdoutFile) { Get-Content $stdoutFile -Tail 20 }
        if (Test-Path $stderrFile) { Get-Content $stderrFile -Tail 20 }
    }
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Remove-Item $stdoutFile, $stderrFile -ErrorAction SilentlyContinue
}

Write-Host "=== build-sidecar done ===" -ForegroundColor Cyan
