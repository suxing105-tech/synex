# install-git-hooks.ps1 —— 装本仓库的 pre-commit 守卫钩子。
#
# 为什么要它：字号、行高、字距、间距、圆角、字重、图标入口这套尺度（AGENTS.md §3.1）
# 全靠 vitest 里那几份对 src 全量扫描的测试兜着，而它们原本只在 verify-all.ps1 里跑。
# 没有钩子的时候，绕过门禁是零阻力：写歪的值直接进历史。钩子把 8 份尺度守卫（86 条用例，
# 约 3 秒）加一条字体缺字 pytest 提到提交之前，代价是一次提交多等几秒。
#
# 钩子源在 frontend\scripts\git-hooks\pre-commit，跟着仓库走，能评审能回滚；
# .git\hooks 不入库，换台机器要重装一次。本脚本只做一件事：按字节把源拷过去。
# 已经存在且内容不同的钩子（比如别人的 husky）不覆盖，除非 -Force。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\install-git-hooks.ps1 -Check
#   powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\install-git-hooks.ps1
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Source = Join-Path $Repo 'frontend\scripts\git-hooks\pre-commit'
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw ('找不到钩子源：' + $Source) }

$srcBytes = [IO.File]::ReadAllBytes($Source)
# 钩子是 Git for Windows 用它自带的 sh 执行的：BOM 或 CRLF 会让它变成一句
# "bad interpreter"，而且不装就等于没守卫，所以在这里先卡住。
if ($srcBytes.Length -lt 3 -or ($srcBytes[0] -eq 0xEF -and $srcBytes[1] -eq 0xBB -and $srcBytes[2] -eq 0xBF)) {
    throw '钩子源带 BOM，sh 认不了。存成 UTF-8 无 BOM 再来。'
}
if ($srcBytes -contains 13) {
    throw '钩子源里有 CRLF，sh 会报错。存成 LF 再来。'
}

$gitPath = (& git -C $Repo rev-parse --git-path hooks).Trim()
if ([string]::IsNullOrWhiteSpace($gitPath)) { throw 'git rev-parse --git-path hooks 没给出路径' }
if ([IO.Path]::IsPathRooted($gitPath)) { $Hooks = $gitPath } else { $Hooks = Join-Path $Repo $gitPath }
$Target = Join-Path $Hooks 'pre-commit'

$state = 'missing'
if (Test-Path -LiteralPath $Target -PathType Leaf) {
    # 比 sha256，不用 -join 拼字节数组：长数组既慢又要在 -eq 的优先级上赌一把
    $srcHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
    if ($dstHash -eq $srcHash) { $state = 'current' } else { $state = 'differs' }
}

if ($Check) {
    Write-Output ('hook    : ' + $Target)
    Write-Output ('state   : ' + $state)
    if ($state -eq 'current') {
        Write-Output 'result  : 已安装且与仓库里的源一致'
        exit 0
    }
    Write-Output 'result  : 需要装（同一个脚本不带 -Check）'
    exit 2
}

if ($state -eq 'current') {
    Write-Output ('pre-commit 钩子已是最新：' + $Target)
    exit 0
}
if ($state -eq 'differs' -and -not $Force) {
    throw ('已有一份内容不同的 pre-commit 钩子：' + $Target + '。确认能覆盖再加 -Force。')
}
New-Item -ItemType Directory -Force -Path $Hooks | Out-Null
[IO.File]::WriteAllBytes($Target, $srcBytes)
Write-Output ('已装 pre-commit 钩子：' + $Target)
Write-Output '它会跑：8 份尺度守卫（vitest）+ 字体缺字（pytest）。要跳过一次：git commit --no-verify'

