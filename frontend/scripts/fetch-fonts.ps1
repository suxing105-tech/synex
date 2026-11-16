# fetch-fonts.ps1 - stage the bundled UI typeface: ChillDINGothic subsetted to "SeekX Sans".
#
# Why this exists: the app used to inherit whatever Tailwind's preflight put on <html>, i.e. the
# system stack (Segoe UI / Microsoft YaHei). That is a different typeface on every machine, so the
# UI had no visual identity and CJK metrics drifted between installs. The upstream release archive
# is a 75 MB full family, far too heavy to ship, so we vendor it here, subset it to the glyphs the
# app can actually draw, and commit only the three woff2 faces.
#
# The pins below are what makes this reproducible and reviewable: the archive hash and the license
# template hash are checked before anything is used. Nothing is fetched at build time -- run this
# script once, and the committed woff2 files are what ships.
#
# Layout produced:
#   vendor\fonts\ChillDINGothic.v1.300.zip        upstream archive      (gitignored)
#   vendor\fonts\OFL-1.1.txt                     official OFL template (gitignored)
#   vendor\fonts\extracted\*.otf                 the three weights      (gitignored)
#   frontend\src\assets\fonts\seekx-sans-*.woff2 committed; Vite hashes the filename
#   frontend\src\assets\fonts\fonts-manifest.json committed; upstream + rename provenance
#   frontend\src-tauri\resources\OFL-SeekX-Sans.txt committed; ships inside the installer
#
# Renaming is not cosmetic: the font's own copyright block declares "with Reserved Font Name
# 'ChillDINGothic'", so OFL 1.1 forbids shipping a subset under that name. subset_fonts.py does the
# rename and rebuilds the license file from the official text plus the font's own copyright strings.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
param(
    [switch]$Force,
    [string]$Python = ''
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Vendor = Join-Path $Repo 'vendor\fonts'
$Extracted = Join-Path $Vendor 'extracted'
$Assets = Join-Path $Repo 'frontend\src\assets\fonts'
$Manifest = Join-Path $Assets 'fonts-manifest.json'

$Version = 'v1.300'
$ArchiveName = 'ChillDINGothic.' + $Version + '.zip'
$ArchiveUrl = 'https://github.com/Warren2060/ChillDIN-ChillDINGothic/releases/download/ChillDINGothic_' + $Version + '/' + $ArchiveName
$ArchiveSha = '2bea24f6eb4bb3ccce516d1704f2225a504bb5fffad6cee28269cc9964ba0b84'
$OflUrl = 'https://openfontlicense.org/documents/OFL.txt'
$OflSha = '1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e'
# The three static weights the app maps onto CSS font-weight 400 / 500 / 600. Upstream ships a
# variable font too; the statics are used because their OS/2.usWeightClass already is 400/500/600.
$SourceFiles = @('ChillDINGothic_Regular.otf', 'ChillDINGothic_Medium.otf', 'ChillDINGothic_SemiBold.otf')
$Faces = @('Regular=ChillDINGothic_Regular.otf:400', 'Medium=ChillDINGothic_Medium.otf:500', 'SemiBold=ChillDINGothic_SemiBold.otf:600')

Write-Host '=== fetch-fonts ===' -ForegroundColor Cyan

if (-not $Python) {
    $candidate = Join-Path $Repo 'backend\.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'backend\.venv not found; create it per AGENTS.md 4.1 before fetching fonts (fonttools + brotli live there).'
    }
    $Python = $candidate
}
foreach ($mod in @('fontTools.subset', 'brotli')) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Python -c ('import ' + $mod) 2>&1 | Out-Null
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    if ($code -ne 0) {
        throw ($mod + ' is missing from ' + $Python + '; run: ' + $Python + ' -m pip install -e "' + (Join-Path $Repo 'backend') + '[dev]"')
    }
}

function Get-PinnedFile([string]$url, [string]$dest, [string]$sha, [string]$label) {
    if ((Test-Path -LiteralPath $dest -PathType Leaf) -and (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -eq $sha) {
        Write-Host ('    cached      ' + $label) -ForegroundColor DarkGray
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Write-Host ('    downloading ' + $label) -ForegroundColor Yellow
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & curl.exe -sSL --fail --retry 3 --retry-delay 2 -o $dest $url 2>&1 | Out-Host
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    if ($code -ne 0) { throw ('download failed (' + $code + '): ' + $url) }
    $actual = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $sha) {
        throw ($label + ' sha256 mismatch.' + [Environment]::NewLine +
               '    expected ' + $sha + [Environment]::NewLine +
               '    actual   ' + $actual + [Environment]::NewLine +
               '    Upstream content changed. Verify the release page before updating the pin; do not just paste the new hash.')
    }
}

$archive = Join-Path $Vendor $ArchiveName
$ofl = Join-Path $Vendor 'OFL-1.1.txt'
Write-Host '==> verify upstream archive and license template' -ForegroundColor Yellow
Get-PinnedFile $ArchiveUrl $archive $ArchiveSha $ArchiveName
Get-PinnedFile $OflUrl $ofl $OflSha 'OFL-1.1.txt'

$needExtract = $Force -or -not (Test-Path -LiteralPath $Manifest -PathType Leaf)
foreach ($f in $SourceFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $Extracted $f) -PathType Leaf)) { $needExtract = $true }
}
if ($needExtract) {
    Write-Host '==> extract the three weights' -ForegroundColor Yellow
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($f in $SourceFiles) {
            $entry = $zip.Entries | Where-Object { $_.Name -eq $f } | Select-Object -First 1
            if (-not $entry) { throw ('archive has no ' + $f) }
            $dest = Join-Path $Extracted $f
            New-Item -ItemType Directory -Force -Path $Extracted | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
            Write-Host ('    extracted   ' + $f) -ForegroundColor Green
        }
    } finally { $zip.Dispose() }
} else {
    Write-Host '    extracted faces already staged' -ForegroundColor DarkGray
}

Write-Host '==> subset + rename -> frontend\src\assets\fonts' -ForegroundColor Yellow
$pyArgs = @(
    (Join-Path $Repo 'frontend\scripts\subset_fonts.py'),
    '--src', $Extracted,
    '--out', $Assets,
    '--family', 'SeekX Sans',
    '--upstream', 'ChillDINGothic',
    '--version', $Version,
    '--url', ('https://github.com/Warren2060/ChillDIN-ChillDINGothic/releases/tag/ChillDINGothic_' + $Version),
    '--archive-sha256', $ArchiveSha,
    '--license', $ofl
)
foreach ($face in $Faces) { $pyArgs += @('--face', $face) }
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $Python @pyArgs
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
if ($code -ne 0) { throw ('subset_fonts.py exited with ' + $code) }

Write-Host '=== fetch-fonts done ===' -ForegroundColor Cyan