#requires -Version 5.1
# 一键同款 / ComfyUI 连接诊断 —— 只读，不改任何文件、不改设置
# 用法：在出问题的那台机器上执行
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\diag-comfyui.ps1
# 把屏幕输出（或同目录 diag-result.txt）整段发回来即可定位。
[CmdletBinding()]
param(
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
if (-not $OutFile) { $OutFile = Join-Path $PSScriptRoot 'diag-result.txt' }
$report = New-Object System.Collections.Generic.List[string]

function Say([string]$text = '') { $report.Add($text); Write-Output $text }
function Section([string]$title) { Say ''; Say ('## ' + $title + ' ' + ('=' * [Math]::Max(0, 56 - $title.Length))) }
function KV([string]$k, $v) {
    $val = if ($null -eq $v) { '(无)' } else { [string]$v }
    $pad = [Math]::Max(2, 30 - ($k.Length * 2 - $k.Length))
    Say ('  ' + $k + (' ' * $pad) + $val)
}

$verdicts = New-Object System.Collections.Generic.List[string]
$foundUrl = ''
$foundEnabled = $true
$watchDirs = @()
$listenerRows = @()
$procMap = @{}

Say '闪寻空间 · ComfyUI 连接诊断'
Say ('时间: {0}   机器: {1}   用户: {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $env:COMPUTERNAME, $env:USERNAME)

# ---------- 1 监听端口（先拿这个，后面都要用） ----------
Section '1 本机环回端口上有什么在监听'
try {
    $listenerRows = Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
        Select-Object -Unique LocalAddress, LocalPort, OwningProcess
} catch { Say ('  Get-NetTCPConnection 失败: ' + $_.Exception.Message) }
try {
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction Stop)) { $procMap[[int]$p.ProcessId] = $p }
} catch { Say ('  读进程列表失败: ' + $_.Exception.Message) }

function Listener-On([int]$Port) {
    $hit = $listenerRows | Where-Object { [int]$_.LocalPort -eq $Port } | Select-Object -First 1
    if (-not $hit) { return $null }
    $proc = $procMap[[int]$hit.OwningProcess]
    return [pscustomobject]@{
        Port = $Port; Addr = [string]$hit.LocalAddress; Pid = [int]$hit.OwningProcess
        Name = if ($proc) { [string]$proc.Name } else { '?' }
        Exe  = if ($proc) { [string]$proc.ExecutablePath } else { '?' }
    }
}

$comfyProcs = @()
foreach ($p in $procMap.Values) {
    $cl = [string]$p.CommandLine
    if (-not $cl) { continue }
    if ($cl -match 'diag-comfyui') { continue }
    if ($cl -match 'ComfyUI') { $comfyProcs += $p }
}
if ($comfyProcs.Count) {
    Say '  跟 ComfyUI 有关的进程:'
    foreach ($p in $comfyProcs) {
        $cl = [string]$p.CommandLine
        if ($cl.Length -gt 220) { $cl = $cl.Substring(0, 217) + '...' }
        Say ('    PID {0}  {1}' -f $p.ProcessId, $p.Name)
        Say ('      exe : {0}' -f $p.ExecutablePath)
        Say ('      cmd : {0}' -f $cl)
    }
} else {
    Say '  没找到命令行里带 ComfyUI 的进程 —— ComfyUI 大概率没在这台机器上跑着'
}

# ---------- 2 配置里的服务地址 ----------
Section '2 图库保存的服务地址'
$dataDirs = @()
foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $null -ne $_.Free })) {
    $cand = Join-Path $d.Root.TrimEnd('\') 'SeekX-Data'
    if (Test-Path -LiteralPath $cand) { $dataDirs += $cand }
}
if ($env:APPDATA) { $dataDirs += (Join-Path $env:APPDATA 'com.suxing.gallery\data') }
$anyCfg = $false
$cfgList = @()
foreach ($dd in $dataDirs) {
    $cfgPath = Join-Path $dd 'config.json'
    if (-not (Test-Path -LiteralPath $cfgPath)) { continue }
    $anyCfg = $true
    Say ('  配置文件: ' + $cfgPath)
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        KV 'comfyui_url' $cfg.comfyui_url
        KV 'comfyui_enabled' $cfg.comfyui_enabled
        KV 'watch_dirs' (@($cfg.watch_dirs) -join '  |  ')
        $dbp = Join-Path $dd 'db.sqlite'
        $dbmt = if (Test-Path -LiteralPath $dbp) { (Get-Item -LiteralPath $dbp).LastWriteTime } else { $null }
        Say ('    库文件: ' + $dbp + '   最后写入 ' + $(if ($dbmt) { $dbmt.ToString('yyyy-MM-dd HH:mm') } else { '(无)' }))
        $cfgList += [pscustomobject]@{ Dir = $dd; Url = [string]$cfg.comfyui_url; Db = $dbmt }
        if ($cfg.comfyui_url) { $foundUrl = [string]$cfg.comfyui_url }
        if ($null -ne $cfg.comfyui_enabled) { $foundEnabled = [bool]$cfg.comfyui_enabled }
        $watchDirs = @($cfg.watch_dirs)
    } catch { Say ('    读取失败: ' + $_.Exception.Message) }
}
if ($cfgList.Count -gt 1) {
  $newest = $cfgList | Where-Object { $null -ne $_.Db } | Sort-Object Db -Descending | Select-Object -First 1
  if ($newest) {
    Say ('  最可能在用的是: ' + $newest.Dir)
    Say '  （到底用哪个取决于软件装在哪个盘：装在 D 盘就用 D:\SeekX-Data。其余的是历史残留，别被它们误导。）'
    if ($newest.Url) { $foundUrl = $newest.Url }
  }
}
if (-not $anyCfg) {
    Say '  一个 config.json 都没找到 → 这台机器用的是出厂默认地址 http://127.0.0.1:8188'
    Say ('  已检查: ' + ($dataDirs -join '  ,  '))
    $foundUrl = 'http://127.0.0.1:8188'
}
if (-not $foundUrl) { $foundUrl = 'http://127.0.0.1:8188' }
Say ('  实际生效的地址(取最后一个存在的配置文件): ' + $foundUrl)
if (-not $foundEnabled) { $verdicts.Add('集成开关 comfyui_enabled 是关的：设置 → ComfyUI 里把「工作流集成」打开。') }

# ---------- 3 图库后端自己的判断 ----------
Section '3 正在运行的图库后端怎么判断'
$backendUrl = ''
$backendRunning = $null
try {
    $st = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/integrations/comfyui/status' -TimeoutSec 5 -UseBasicParsing
    $backendRunning = [bool]$st.running
    $backendUrl = [string]$st.url
    KV 'running' $st.running
    KV 'url' $st.url
    KV 'enabled' $st.enabled
} catch {
    KV '请求 127.0.0.1:8765' ('失败: ' + $_.Exception.Message)
    Say '  图库主程序没开着（或 sidecar 端口不是 8765）。这一步失败不影响后面的探测。'
}

# ---------- 4 代理 ----------
Section '4 代理（浏览器会自动跳过本机地址，Python 不一定）'
$proxyVars = @(Get-ChildItem env: | Where-Object { $_.Name -match '(?i)proxy' })
if ($proxyVars.Count) { foreach ($pv in $proxyVars) { KV $pv.Name $pv.Value } } else { Say '  环境变量里没有代理' }
try {
    $ie = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    KV '系统代理 ProxyEnable' $ie.ProxyEnable
    KV '系统代理 ProxyServer' $ie.ProxyServer
    KV '绕过列表' $ie.ProxyOverride
} catch { KV '读注册表代理' $_.Exception.Message }

# ---------- 5 真探测 ----------
Section '5 直接访问 /system_stats（curl 强制不走代理）'
$hasCurl = [bool](Get-Command curl.exe -ErrorAction SilentlyContinue)
function Probe-Comfy([string]$BaseUrl) {
    if (-not $hasCurl) { return '(没找到 curl.exe)' }
    $u = $BaseUrl.TrimEnd('/') + '/system_stats'
    $out = (& curl.exe -s -S --noproxy '*' --max-time 3 $u 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { return ('连不上 (curl exit ' + $LASTEXITCODE + ')') }
    try {
        $j = $out | ConvertFrom-Json
        $dev = @($j.devices | ForEach-Object { [string]$_.type + ' ' + [Math]::Round([double]$_.vram_total / 1GB, 1) + 'GB' }) -join ', '
        return ('是 ComfyUI ' + $j.system.comfyui_version + '   ' + $dev)
    } catch { return '有响应，但不是 ComfyUI 的 JSON（端口被别的服务占了）' }
}

$cfgHost = ''
$cfgPort = 8188
try {
    $u = New-Object System.Uri($foundUrl)
    $cfgHost = $u.Host
    $cfgPort = $u.Port
} catch { Say ('  配置地址解析失败: ' + $foundUrl) }

$cfgListener = Listener-On $cfgPort
Say ('  配置地址 ' + $foundUrl)
if ($cfgListener) {
    Say ('    端口有人: ' + $cfgListener.Addr + '  PID ' + $cfgListener.Pid + '  ' + $cfgListener.Name + '  ' + $cfgListener.Exe)
    $cfgProbe = Probe-Comfy $foundUrl
    Say ('    探测结果: ' + $cfgProbe)
} else {
    Say ('    端口 ' + $cfgPort + ' 上没有任何东西在监听 —— 配置里的地址这台机器上根本没人应答')
    $cfgProbe = '端口空着'
}

Say ''
Say '  其它常见 ComfyUI 端口:'
$discovered = ''
foreach ($pt in @(8188, 8189, 8187, 8000, 8080, 8888, 8188)) {
    if ($pt -eq $cfgPort) { continue }
    $li = Listener-On $pt
    if (-not $li) { Say ('    http://127.0.0.1:' + $pt + '   端口空着'); continue }
    $r = Probe-Comfy ('http://127.0.0.1:' + $pt)
    Say ('    http://127.0.0.1:' + $pt + '   ' + $li.Name + ' → ' + $r)
    if ($r -like '是 ComfyUI*' -and -not $discovered) { $discovered = 'http://' + $li.Addr.Replace('0.0.0.0', '127.0.0.1') + ':' + $pt }
}
if ($cfgProbe -like '是 ComfyUI*') { $discovered = $foundUrl }
# IPv6 兜底：只在 127.0.0.1 没成时试一次
if ($cfgProbe -notlike '是 ComfyUI*') {
    $v6 = Probe-Comfy ('http://[::1]:' + $cfgPort)
    if ($v6 -like '是 ComfyUI*') {
        Say ('    http://[::1]:' + $cfgPort + '  → ' + $v6 + '   ← ComfyUI 只绑了 IPv6')
        $verdicts.Add('ComfyUI 只监听 IPv6(::1)，图库按 127.0.0.1 连必然失败。把服务地址改成 http://[::1]:' + $cfgPort + '，或让 ComfyUI 用 --listen 127.0.0.1 启动。')
    }
}

# ---------- 6 成图回收 ----------
Section '6 成图回收（跑完能不能收进图库）'
Say '  一键同款跑完后是到 watch_dirs 里按文件名找成图的，路径不对就会出现'
Say '  「图已经在 ComfyUI 输出目录，没在图库监听目录里」。'
if ($watchDirs.Count) {
    foreach ($wd in $watchDirs) {
        $ok = Test-Path -LiteralPath ([string]$wd)
        Say ('    ' + $(if ($ok) { '[在]  ' } else { '[打不开]' }) + ' ' + $wd)
    }
} else { Say '  当前没有监听目录' }

# ---------- 7 结论 ----------
Section '7 自动结论'
if (-not $cfgListener) {
    $verdicts.Add(('配置里的地址 http://' + $cfgHost + ':' + $cfgPort + ' 上没有服务在监听。' + $(if ($discovered) { "这台机器真正的 ComfyUI 在 $discovered —— 设置 → ComfyUI 里把服务地址改成它并保存。" } else { '这台机器上没探测到任何 ComfyUI，先把整合包跑起来（run_nvidia_gpu.bat / 桌面版），再来跑一次本脚本。' })))
} elseif ($cfgProbe -like '是 ComfyUI*') {
    Say ('  地址对、ComfyUI 也在跑（' + $cfgProbe + '）—— 问题不在地址，看下面代理与超时。')
    if ($backendRunning -eq $true) { $verdicts.Add('图库后端现在也认为已连接：说明刚才那次「连不上」是时序问题（探测赶在 ComfyUI 启动完成之前），重开一次一键同款弹窗会自动重测。') }
    if ($backendRunning -eq $false) { $verdicts.Add('直接访问同一地址是通的，但图库后端自己报没连上 → 是 Python 侧被代理拦掉或 1.5 秒超时太短。请让苏醒改代码：ComfyUI 请求强制不走代理 + 放宽超时。') }
} else {
    $verdicts.Add(('端口 ' + $cfgPort + ' 上跑的是 ' + $cfgListener.Name + '（PID ' + $cfgListener.Pid + '），不是 ComfyUI。' + $(if ($discovered) { "真正的 ComfyUI 在 $discovered。" } else { '没找到在跑的 ComfyUI。' })))
}

$envProxy = @($proxyVars | Where-Object { $_.Name -match '(?i)^(HTTP|HTTPS|ALL)_PROXY$' })
if ($envProxy.Count) {
    $noProxy = (Get-ChildItem env: | Where-Object { $_.Name -match '(?i)^no_proxy$' } | Select-Object -First 1).Value
    if (-not $noProxy -or ($noProxy -notmatch '127\.0\.0\.1' -and $noProxy -notmatch 'localhost' -and $noProxy -notmatch '\*')) {
        $verdicts.Add(('检测到 ' + (($envProxy | ForEach-Object { $_.Name }) -join ', ') + ' 且 NO_PROXY 不含 127.0.0.1/localhost：图库的 Python 请求会被丢给代理，浏览器却会跳过本机地址 —— 这正是「ComfyUI 自己能开、图库说连不上」。临时解法：在系统环境变量里加 NO_PROXY=127.0.0.1;localhost;::1 后重启图库；根治要改代码。'))
    }
}
if ($foundEnabled -and -not $cfgListener -and -not $anyCfg) {
    $verdicts.Add('这台机器根本没有 config.json，地址用的是出厂默认 8188：老机器上改过的地址不会跟过来，需要重设一次。')
}

if ($verdicts.Count -eq 0) { $verdicts.Add('没发现明显问题：地址、端口、ComfyUI 都正常。请把第 3、4 节内容发回来进一步判断。') }
$i = 0
foreach ($v in $verdicts) {
    $i++
    Say ('  【' + $i + '】' + $v)
}

Say ''
Say '===== 把上面整段发回来即可定位 ====='
try { $report | Set-Content -LiteralPath $OutFile -Encoding UTF8; Write-Output ('已写入: ' + $OutFile) } catch { Write-Output ('写文件失败: ' + $_.Exception.Message) }
