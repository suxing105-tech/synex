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
# 门禁里的 Python 脚本（工作区闸、README 计数闸）打印的是中文。PowerShell 5.1 按 [Console]
# 的代码页解码子进程输出，中文会直接变成 U+FFFD——日志里剩下的是「改 README 第几行」那句话的
# 尸体，而那句话正是红了之后唯一需要读的东西。所以让 Python 按 UTF-8 写、控制台按 UTF-8 解。
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Python = Join-Path $Repo 'backend\.venv\Scripts\python.exe'
$fail = @()

# 后端那批用例要 ffmpeg / ffprobe 在 PATH 上，否则海报帧、波形、音视频元数据那批会集体
# FileNotFoundError——看着像一百多个用例坏了，其实只是 subprocess 找不到 ffmpeg。
# 仓库自带 vendor\media-tools，命中就把它挂到 PATH 最前面。
$MediaTools = Join-Path $Repo 'vendor\media-tools'
if (Test-Path -LiteralPath $MediaTools) { $env:PATH = $MediaTools + ';' + $env:PATH }

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

# Gate 0: the AGENTS.md rule says "commit every round, immediately". It was still
# skipped for five rounds before v0.2.31, so it is enforced in code, not prose.
$Gate = Join-Path $PSScriptRoot 'check-worktree-committed.py'
$GateLog = Join-Path $Out 'worktree-committed.log'
$GateCode = RunNative { & $Python $Gate } $GateLog
Write-Output ('{0,-18} exit={1}  {2}' -f 'worktree committed', $GateCode, (Tail $GateLog))
if ($GateCode) { $fail = $fail + 'worktree committed' }

Suite 'backend pytest' (Join-Path $Repo 'backend') { & $Python -m pytest -q } 'backend-tests.log'
Suite 'frontend vitest' (Join-Path $Repo 'frontend') { pnpm test } 'frontend-tests.log'
Suite 'svelte-check' (Join-Path $Repo 'frontend') { pnpm exec svelte-check --threshold error } 'svelte-check.log'
Suite 'cargo test' (Join-Path $Repo 'frontend\src-tauri') { cargo test --offline } 'rust-tests.log'

# Gate 5: README 的三行用例数是给人看的，它滞后过两轮（每次都靠人收尾时想起来重锚）。
# 数字取的就是上面四套刚写出来的日志，所以这一步必须排在它们后面。
$ReadmeGate = Join-Path $PSScriptRoot 'check-readme-counts.py'
$ReadmeLog = Join-Path $Out 'readme-counts.log'
$ReadmeCode = RunNative { & $Python $ReadmeGate --logs $Out } $ReadmeLog
Write-Output ('{0,-18} exit={1}  {2}' -f 'readme counts', $ReadmeCode, (Tail $ReadmeLog))
if ($ReadmeCode) { $fail = $fail + 'readme counts' }
if ($fail.Count) {
  Set-Content -LiteralPath (Join-Path $Out 'VERIFY.txt') -Value ('FAILURE: ' + ($fail -join '; ')) -Encoding utf8
  throw ('FAILED: ' + ($fail -join '; '))
}
Set-Content -LiteralPath (Join-Path $Out 'VERIFY.txt') -Value 'SUCCESS all suites' -Encoding utf8
Write-Output 'ALL SUITES PASSED'
