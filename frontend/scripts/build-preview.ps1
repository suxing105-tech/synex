param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$Suffix = '',
    [string]$SigningKeyPath = ''
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ([IO.Path]::IsPathRooted($OutDir)) { $Out = [IO.Path]::GetFullPath($OutDir) }
else { $Out = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutDir)) }
$Python = Join-Path $Repo 'backend\.venv\Scripts\python.exe'
# Tauri signs the updater artifact during bundling, so the private key is required even for preview builds.
if (!$SigningKeyPath) { $SigningKeyPath = Join-Path $Repo 'outputs\auto-update-v1\private\updater.key' }
if (!(Test-Path -LiteralPath $SigningKeyPath)) { throw 'missing updater signing key; pass -SigningKeyPath' }
$step = 'init'

# Native commands write INFO lines to stderr; with Stop mode PowerShell would treat them as
# terminating errors, so relax the preference and judge by $LASTEXITCODE instead.
function RunNative([scriptblock]$sb, [string]$log) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $sb *> $log } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}

# Get-FileHash has repeatedly come back as "not recognized" when this script is
# started through Start-Process, so fall back to certutil instead of losing the run.
function Get-Sha256([string]$path) {
  $cmd = Get-Command Get-FileHash -CommandType Cmdlet -ErrorAction SilentlyContinue
  if ($cmd) {
    try { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } catch { }
  }
  $out = @(& certutil -hashfile $path SHA256)
  foreach ($line in $out) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^[0-9A-Fa-f]{64}$') { return $trimmed.ToUpper() }
  }
  throw ('cannot hash ' + $path)
}

try {
  $step = 'prepare'
  foreach ($d in @($Out, (Join-Path $Out 'build'), (Join-Path $Out 'app'))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  # python-backend.spec resolves the repo through this variable.
  $env:SUXING_REPO_ROOT = $Repo
  $env:CARGO_NET_OFFLINE = 'true'
  $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $SigningKeyPath).Path

  $step = 'sidecar'
  $code = RunNative { & $Python -m PyInstaller --noconfirm --distpath (Join-Path $Out 'sidecar') --workpath (Join-Path $Out 'build\pyinstaller') (Join-Path $Repo 'frontend\pyinstaller\python-backend.spec') } (Join-Path $Out 'build\sidecar-build.log')
  if ($code) { throw ('sidecar build failed (' + $code + '), see build\sidecar-build.log') }
  $fresh = Join-Path $Out 'sidecar\python-backend.exe'
  Copy-Item -LiteralPath $fresh -Destination (Join-Path $Repo 'frontend\src-tauri\binaries\python-backend-x86_64-pc-windows-msvc.exe') -Force

  $step = 'desktop'
  Push-Location (Join-Path $Repo 'frontend')
  try { $code = RunNative { cargo tauri build --ci } (Join-Path $Out 'build\desktop-build.log') } finally { Pop-Location }
  if ($code) { throw ('cargo tauri build failed (' + $code + '), see build\desktop-build.log') }
  $env:TAURI_SIGNING_PRIVATE_KEY = $null

  $step = 'app'
  $Release = Join-Path $Repo 'frontend\src-tauri\target\release'
  Copy-Item -LiteralPath (Join-Path $Release 'suxing-gallery.exe') -Destination (Join-Path $Out 'app\suxing-gallery.exe') -Force
  Copy-Item -LiteralPath $fresh -Destination (Join-Path $Out 'app\python-backend.exe') -Force
  Copy-Item -LiteralPath $fresh -Destination (Join-Path $Out 'app\python-backend-x86_64-pc-windows-msvc.exe') -Force

  $step = 'installer'
  $version = (Get-Content -LiteralPath (Join-Path $Repo 'frontend\src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $setup = Get-ChildItem -LiteralPath (Join-Path $Release 'bundle\nsis') -Filter '*_x64-setup.exe' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$setup) { throw ('no NSIS installer for ' + $version + ' under bundle\nsis') }
  # Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
  $brand = [string]([char]0x95EA) + [char]0x5BFB + [char]0x7A7A + [char]0x95F4
  $destName = $brand + $Suffix + '_x64-setup.exe'
  Copy-Item -LiteralPath $setup.FullName -Destination (Join-Path $Out $destName) -Force

  $step = 'launcher'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch-preview.ps1') -Destination (Join-Path $Out 'launch-preview.ps1') -Force
  $lnk = $brand + '-' + ([string]([char]0x5FEB) + [char]0x6377 + [char]0x542F + [char]0x52A8) + '.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut((Join-Path $Out $lnk))
  $sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Out 'launch-preview.ps1') + '"'
  $sc.WorkingDirectory = $Out
  $sc.IconLocation = (Join-Path $Out 'app\suxing-gallery.exe') + ',0'
  $sc.Save()

  $step = 'artifacts'
  $items = @('app/suxing-gallery.exe', 'app/python-backend.exe', $lnk, $destName)
  $artifacts = $items | ForEach-Object {
    $p = Join-Path $Out ($_ -replace '/', '\')
    if (!(Test-Path -LiteralPath $p)) { throw ('missing artifact ' + $_) }
    [pscustomobject]@{
      file   = $_
      bytes  = (Get-Item -LiteralPath $p).Length
      sha256 = Get-Sha256 $p
    }
  }
  $artifacts | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Out 'artifacts.json') -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Out 'DONE.txt') -Value ('SUCCESS ' + (Get-Date -Format 's')) -Encoding utf8
  Write-Output 'BUILD ARTIFACTS READY'
} catch {
  if (Test-Path -LiteralPath $Out) {
    Set-Content -LiteralPath (Join-Path $Out 'DONE.txt') -Value ('FAILURE at [' + $step + ']: ' + $_.Exception.Message) -Encoding utf8
  }
  Write-Error ('preview build failed at [' + $step + ']: ' + $_.Exception.Message)
  exit 1
}
