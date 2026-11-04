# 一键启动「闪寻空间」当前项目的 dev 栈：uvicorn 后端 + vite 前端（跑的是仓库当前代码，带热更新）。
# 用法（在仓库根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\launch-dev.ps1
#   同一条命令加 -CheckOnly   只看两个端口谁在监听，不启动
#   同一条命令加 -Stop        只停这条 dev 栈（只碰本机这两个端口上的进程）
#   同一条命令加 -Restart     先停再起
#   同一条命令加 -BackendPort 8897 -FrontendPort 5199 换端口
#
# 端口为什么不跟 README 的默认值一样：已安装正式版的 sidecar 独占它自己的端口，
# dev 栈必须错开，否则必然端口冲突。前端靠 VITE_BACKEND_PORT 指到这里的后端。
param(
    [int]$BackendPort = 8897,
    [int]$FrontendPort = 5199,
    [switch]$CheckOnly,
    [switch]$Stop,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RepoPattern = $Repo + '\*'
$Python = Join-Path $Repo 'backend\.venv\Scripts\python.exe'
$Vite = Join-Path $Repo 'frontend\node_modules\.bin\vite.cmd'
$LogDir = Join-Path $Repo 'outputs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-ListenerPid([int]$Port) {
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
}

# 只有命令行里带本仓库路径的进程才算这条 dev 栈的，别的一律不碰：
# 这样误伤不到已安装正式版，也伤不到机器上其他 node。
function Test-DevOwned([int]$ProcId) {
    if (-not $ProcId) { return $false }
    $row = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
    if (-not $row) { return $false }
    return [bool]($row.CommandLine -like $RepoPattern)
}

function Stop-DevPort([string]$Name, [int]$Port) {
    $owner = Get-ListenerPid -Port $Port
    if (-not $owner) { Write-Output ("[停] {0} :{1} 本来没在监听" -f $Name, $Port); return }
    if (-not (Test-DevOwned -ProcId $owner)) {
        Write-Output ("[停] {0} :{1} 上跑的进程不是本仓库起的（pid={2}），不动它" -f $Name, $Port, $owner)
        return
    }
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    Write-Output ("[停] {0} :{1} 已停止（pid={2}）" -f $Name, $Port, $owner)
}

function Wait-Port([int]$Port, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $owner = Get-ListenerPid -Port $Port
        if ($owner) { return $owner }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Probe-Http([string]$Url) {
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        return [int]$resp.StatusCode
    } catch { return 0 }
}

if ($Stop -or $Restart) {
    Stop-DevPort -Name '前端 vite' -Port $FrontendPort
    Stop-DevPort -Name '后端 uvicorn' -Port $BackendPort
    if ($Stop) { return }
    Start-Sleep -Seconds 1
    $beOwner = $null
    $feOwner = $null
} else {
    $beOwner = Get-ListenerPid -Port $BackendPort
    $feOwner = Get-ListenerPid -Port $FrontendPort
}

if ($CheckOnly) {
    $beState = '没起'
    if ($beOwner) { $beState = '在跑 pid=' + $beOwner }
    $feState = '没起'
    if ($feOwner) { $feState = '在跑 pid=' + $feOwner }
    Write-Output ('后端 uvicorn :{0}  ->  {1}' -f $BackendPort, $beState)
    Write-Output ('前端 vite    :{0}  ->  {1}' -f $FrontendPort, $feState)
    return
}

if (-not $beOwner) {
    if (-not (Test-Path -LiteralPath $Python)) {
        Write-Output ('[缺] Python 虚拟环境不在：{0}   先在 backend 建 .venv 再跑本脚本' -f $Python)
        throw 'backend venv missing'
    }
    $beArgs = @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', [string]$BackendPort)
    $beOut = Join-Path $LogDir ('_dev_backend_{0}.log' -f $BackendPort)
    $beErr = Join-Path $LogDir ('_dev_backend_{0}.err.log' -f $BackendPort)
    Start-Process -FilePath $Python -ArgumentList $beArgs -WorkingDirectory (Join-Path $Repo 'backend') -WindowStyle Hidden -RedirectStandardOutput $beOut -RedirectStandardError $beErr | Out-Null
    $beOwner = Wait-Port -Port $BackendPort -TimeoutSec 90
}
if (-not $beOwner) {
    Write-Output ('[失败] 后端 :{0} 90 秒内没起来，看 outputs\_dev_backend_{0}.err.log' -f $BackendPort)
    throw 'backend did not start'
}

if (-not $feOwner) {
    if (-not (Test-Path -LiteralPath $Vite)) {
        Write-Output ('[缺] 前端依赖不在：{0}   先在 frontend 跑 npm install' -f $Vite)
        throw 'frontend node_modules missing'
    }
    $env:VITE_BACKEND_PORT = [string]$BackendPort
    $feArgs = @('--port', [string]$FrontendPort, '--strictPort')
    $feOut = Join-Path $LogDir ('_dev_vite_{0}.log' -f $FrontendPort)
    $feErr = Join-Path $LogDir ('_dev_vite_{0}.err.log' -f $FrontendPort)
    Start-Process -FilePath $Vite -ArgumentList $feArgs -WorkingDirectory (Join-Path $Repo 'frontend') -WindowStyle Hidden -RedirectStandardOutput $feOut -RedirectStandardError $feErr | Out-Null
    $feOwner = Wait-Port -Port $FrontendPort -TimeoutSec 60
}
if (-not $feOwner) {
    Write-Output ('[失败] 前端 :{0} 60 秒内没起来，看 outputs\_dev_vite_{0}.err.log' -f $FrontendPort)
    throw 'frontend did not start'
}

$api = Probe-Http ('http://127.0.0.1:{0}/api/health' -f $BackendPort)
$page = Probe-Http ('http://127.0.0.1:{0}/' -f $FrontendPort)

Write-Output ''
Write-Output '闪寻空间 dev 栈就绪（当前仓库代码）'
Write-Output ('  页面    http://127.0.0.1:{0}/              (HTTP {1})' -f $FrontendPort, $page)
Write-Output ('  后端    http://127.0.0.1:{0}/api/health    (HTTP {1})' -f $BackendPort, $api)
Write-Output ('  进程    前端 pid={0} / 后端 pid={1}' -f $feOwner, $beOwner)
Write-Output ('  日志    {0}' -f $LogDir)
Write-Output '  停止    powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\launch-dev.ps1 -Stop'
if ($api -ne 200 -or $page -ne 200) { Write-Warning '端口在监听但 HTTP 不是 200，先看上面两个日志。' }
