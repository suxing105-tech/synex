# Runs every gate this repo relies on and keeps the logs in one directory.
#   powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\verify-all.ps1 [-OutDir outputs\verify-latest]
param(
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($OutDir -eq '') { $Out = Join-Path $Repo 'outputs\verify-latest' }
elseif ([IO.Path]::IsPathRooted($OutDir)) { $Out = [IO.Path]::GetFullPath($OutDir) }
else { $Out = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $OutDir)) }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$env:CARGO_NET_OFFLINE = 'true'
$Python = Join-Path $Repo 'backend\.venv\Scripts\python.exe'
$fail = @()

# Native commands write INFO lines to stderr; with Stop mode PowerShell would treat them as
# terminating errors, so relax the preference and judge by $LASTEXITCODE instead.
function RunNative([scriptblock]$sb, [string]$log) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $sb *> $log } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}

function Tail([string]$log) {
  if (!(Test-Path -LiteralPath $log)) { return '' }
  # RunNative redirects with *> which produces UTF-16 logs.
  $lines = @(Get-Content -LiteralPath $log | Where-Object { $_.Trim() -ne '' -and $_.Length -lt 200 })
  if (!$lines.Count) { return '' }
  # cargo prints one 'test result' line per binary; the last one is usually empty.
  $results = @($lines | Where-Object { $_ -match 'test result: .* passed' })
  if ($results.Count) {
    $passed = 0; $failed = 0; $skipped = 0
    foreach ($line in $results) {
      if ($line -match '(\d+) passed') { $passed += [int]$Matches[1] }
      if ($line -match '(\d+) failed') { $failed += [int]$Matches[1] }
      if ($line -match '(\d+) ignored') { $skipped += [int]$Matches[1] }
    }
    return ('rust total: {0} passed, {1} ignored, {2} failed' -f $passed, $skipped, $failed)
  }
  # vitest prints stack lines that merely mention errors; skip them.
  $hits = @($lines | Where-Object { $_ -match 'passed|failed|error|found' -and $_.Trim() -notmatch '^at ' })
  if ($hits.Count) { return ((($hits | Select-Object -Last 3) | ForEach-Object { $_.Trim() }) -join ' | ') }
  return ($lines | Select-Object -Last 1).Trim()
}

function Suite([string]$name, [string]$dir, [scriptblock]$sb, [string]$logName) {
  $log = Join-Path $Out $logName
  Push-Location $dir
  try { $code = RunNative $sb $log } finally { Pop-Location }
  Write-Output ('{0,-18} exit={1}  {2}' -f $name, $code, (Tail $log))
  if ($code) { $script:fail = $script:fail + $name }
}

Suite 'backend pytest' (Join-Path $Repo 'backend') { & $Python -m pytest -q } 'backend-tests.log'
Suite 'frontend vitest' (Join-Path $Repo 'frontend') { pnpm test } 'frontend-tests.log'
Suite 'svelte-check' (Join-Path $Repo 'frontend') { pnpm exec svelte-check --threshold error } 'svelte-check.log'
Suite 'cargo test' (Join-Path $Repo 'frontend\src-tauri') { cargo test --offline } 'rust-tests.log'

if ($fail.Count) {
  Set-Content -LiteralPath (Join-Path $Out 'VERIFY.txt') -Value ('FAILURE: ' + ($fail -join '; ')) -Encoding utf8
  throw ('FAILED: ' + ($fail -join '; '))
}
Set-Content -LiteralPath (Join-Path $Out 'VERIFY.txt') -Value 'SUCCESS all suites' -Encoding utf8
Write-Output 'ALL SUITES PASSED'
