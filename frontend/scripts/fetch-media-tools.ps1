# fetch-media-tools.ps1 - stage ffmpeg/ffprobe so the installer works on machines without ffmpeg.
#
# Why this exists: video posters, audio waveforms, video metadata and the ComfyUI
# workflow stored inside video containers all need ffmpeg/ffprobe. They used to be
# called by bare name, i.e. "assume the user has ffmpeg on PATH". That is true on a
# dev box and false everywhere else, and the failure was silent: thumbs blank and no
# prompts, while video playback kept working (playback never touches ffmpeg).
#
# Layout produced:
#   frontend\src-tauri\binaries\ffmpeg-<triple>.exe    -> installed as ffmpeg.exe
#   frontend\src-tauri\binaries\ffprobe-<triple>.exe   -> installed as ffprobe.exe
#   frontend\src-tauri\resources\ffmpeg-LICENSE.txt    -> shipped next to the binaries
#   vendor\media-tools\*.exe                           -> local cache (gitignored)
#
# Search order for a source binary: -SourceDir, vendor\media-tools, PATH (winget etc.).
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
param(
    [string]$SourceDir = '',
    [switch]$SkipVersionCheck
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Vendor = Join-Path $Repo 'vendor\media-tools'
$Binaries = Join-Path $Repo 'frontend\src-tauri\binaries'
$Resources = Join-Path $Repo 'frontend\src-tauri\resources'
$Triple = 'x86_64-pc-windows-msvc'
$LicenseName = 'ffmpeg-LICENSE.txt'

Write-Host '=== fetch-media-tools ===' -ForegroundColor Cyan

function Resolve-Tool([string]$name) {
    if ($SourceDir) {
        $p = Join-Path $SourceDir ($name + '.exe')
        if (Test-Path -LiteralPath $p -PathType Leaf) { return (Resolve-Path -LiteralPath $p).Path }
        throw ('-SourceDir has no ' + $name + '.exe: ' + $SourceDir)
    }
    $cached = Join-Path $Vendor ($name + '.exe')
    if (Test-Path -LiteralPath $cached -PathType Leaf) { return (Resolve-Path -LiteralPath $cached).Path }
    $onPath = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

function Test-Tool([string]$path) {
    if ((Get-Item -LiteralPath $path).Length -lt 1MB) {
        throw ('suspiciously small binary (' + $path + '); a symlink or a stub will not work')
    }
    if ($SkipVersionCheck) { return 'skipped' }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Never pipe through Select-Object -First 1 here: breaking the pipe early
        # leaves $LASTEXITCODE unset, and a perfectly good binary reads as broken.
        $out = @(& $path -version 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    $line = if ($out.Count -gt 0) { [string]$out[0] } else { '' }
    if ($code -ne 0 -or $line -notmatch 'version') { throw ('binary is not runnable: ' + $path) }
    return ([string]$line).Trim()
}

function Sync-File([string]$source, [string]$dest) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $srcItem = Get-Item -LiteralPath $source
    if ((Test-Path -LiteralPath $dest -PathType Leaf) -and (Get-Item -LiteralPath $dest).Length -eq $srcItem.Length) {
        Write-Host ('    up to date  ' + $dest) -ForegroundColor DarkGray
        return
    }
    Copy-Item -LiteralPath $source -Destination $dest -Force
    Write-Host ('    copied      ' + $dest) -ForegroundColor Green
}

foreach ($tool in @('ffmpeg', 'ffprobe')) {
    $source = Resolve-Tool $tool
    if (-not $source) {
        throw ($tool + '.exe not found. Install ffmpeg (winget install Gyan.FFmpeg.Essentials) or drop ' `
               + $tool + '.exe into vendor\media-tools, then re-run this script.')
    }
    Write-Host ('==> ' + $tool + ' source: ' + $source) -ForegroundColor Yellow
    Sync-File $source (Join-Path $Vendor ($tool + '.exe'))
    $staged = Join-Path $Binaries ($tool + '-' + $Triple + '.exe')
    Sync-File (Join-Path $Vendor ($tool + '.exe')) $staged
    Write-Host ('    ' + (Test-Tool $staged)) -ForegroundColor Cyan
}

# License text travels with the binaries: the gyan.dev builds are GPL-3.0.
# Where the license text may live: our cache, the layout of an unpacked ffmpeg build
# (LICENSE sits two levels above bin\ffmpeg.exe), or a winget package.
$licenseCandidates = New-Object System.Collections.Generic.List[string]
$licenseCandidates.Add((Join-Path $Vendor $LicenseName))
foreach ($tool in @('ffmpeg', 'ffprobe')) {
    $resolvedSource = Resolve-Tool $tool
    if (-not $resolvedSource) { continue }
    $buildRoot = Split-Path -Parent (Split-Path -Parent $resolvedSource)
    foreach ($name in @('LICENSE', 'LICENSE.txt', 'GPLv3.txt')) {
        $candidate = Join-Path $buildRoot $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $licenseCandidates.Add($candidate); break }
    }
}
$wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
if (Test-Path -LiteralPath $wingetRoot -PathType Container) {
    $found = Get-ChildItem -LiteralPath $wingetRoot -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter 'LICENSE' -Recurse -File -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if ($found) { $licenseCandidates.Add($found.FullName) }
}
foreach ($candidate in $licenseCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        Sync-File $candidate (Join-Path $Resources $LicenseName)
        break
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $Resources $LicenseName) -PathType Leaf)) {
    Write-Warning ('ffmpeg license text not found; bundle will ship without ' + $LicenseName)
}
Write-Host '=== fetch-media-tools done ===' -ForegroundColor Cyan
