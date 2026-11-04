<#
  苏醒图库 / 闪寻空间 —— 项目减负清理脚本
  默认只预演（不删任何东西），加 -Apply 才真删。
    预演: powershell -NoProfile -ExecutionPolicy Bypass -File outputs\cleanup-20261104\cleanup.ps1
    真删: powershell -NoProfile -ExecutionPolicy Bypass -File outputs\cleanup-20261104\cleanup.ps1 -Tiers AB -Apply
  Tier  A = .git 内部垃圾（tmp_obj 残留 + 不可达对象 gc）
  Tier  B = Rust debug 编译缓存 target/debug
  Tier  C = Rust release 编译缓存 target/release（下次打包要冷编译）
  Tier  D = 已发布安装包的构建产物（GitHub Release 上已有）
  Tier  E = 库快照副本 + 验证 scratch 目录（GitHub 上没有，删了不可恢复）
  Tier  F = outputs 根目录未跟踪散落脚本/日志/截图
  Tier  G = 可再生依赖（vendor/media-tools、backend/.venv、frontend/node_modules 等）
  不想传参数就直接改下面 $DefaultTiers 这一行。
#>
param(
  [string]$Tiers = '',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$DefaultTiers = 'BDEF'
$Valid        = 'ABCDEFG'
$raw          = $(if($Tiers){ $Tiers } else { $DefaultTiers })
$Pick        = New-Object 'System.Collections.Generic.List[string]'
if($raw -match 'A'){ [void]$Pick.Add('A') }
if($raw -match 'B'){ [void]$Pick.Add('B') }
if($raw -match 'C'){ [void]$Pick.Add('C') }
if($raw -match 'D'){ [void]$Pick.Add('D') }
if($raw -match 'E'){ [void]$Pick.Add('E') }
if($raw -match 'F'){ [void]$Pick.Add('F') }
if($raw -match 'G'){ [void]$Pick.Add('G') }
if(-not $Pick.Count){ throw '没有有效的 Tier' }

$root   = 'C:\Users\Administrator\Documents\ChatGPT\苏醒图库'
$ov     = Join-Path $root 'outputs'
$logDir = Join-Path $ov 'cleanup-20261104'
$log    = Join-Path $logDir ('deleted-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.csv')

# 绝不触碰：更新签名私钥（只此一份、不可再生）与生产数据目录
$Never = @((Join-Path $ov 'auto-update-v1\private'), 'C:\SeekX-Data')

function Assert-Safe([string]$p){
  $full = [System.IO.Path]::GetFullPath($p)
  if(-not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)){
    throw ('拒绝：' + $full + ' 不在项目根之内')
  }
  foreach($n in $Never){
    $nf = [System.IO.Path]::GetFullPath($n)
    if($full -eq $nf -or $full.StartsWith($nf + '\', [System.StringComparison]::OrdinalIgnoreCase)){
      throw ('拒绝：' + $full + ' 命中保护清单 ' + $n)
    }
  }
  return $full
}
function Get-Bytes([string]$p){
  if(Test-Path -LiteralPath $p -PathType Container){
    $s = Get-ChildItem -LiteralPath $p -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum
    if($s.Sum){ return [int64]$s.Sum }
    return [int64]0
  }
  if(Test-Path -LiteralPath $p -PathType Leaf){ return (Get-Item -LiteralPath $p).Length }
  return [int64]0
}
$script:Grand = [int64]0
$script:Tier  = @{}
$script:Rows  = New-Object 'System.Collections.Generic.List[object]'
function Remove-Target([string]$p, [string]$t){
  $full = Assert-Safe $p
  if(-not (Test-Path -LiteralPath $full)){ return }
  $b = Get-Bytes $full
  if(-not $script:Tier.ContainsKey($t)){ $script:Tier[$t] = [int64]0 }
  $script:Tier[$t] += $b; $script:Grand += $b
  $script:Rows.Add([pscustomobject]@{ tier=$t; mb=[math]::Round($b/1MB,1); path=$full })
  if($Apply){ Remove-Item -LiteralPath $full -Recurse -Force }
}

Write-Host ('Tier = ' + ($Pick -join '') + '   模式 = ' + $(if($Apply){'真删(-Apply)'}else{'预演'}))

if($Pick -contains 'A'){
  $tmp = @(Get-ChildItem (Join-Path $root '.git\objects') -Recurse -File -Force -EA SilentlyContinue | Where-Object { $_.Name -like 'tmp_obj_*' })
  Write-Host ('[A] .git tmp_obj 残留: ' + [math]::Round((($tmp | Measure-Object Length -Sum).Sum)/1MB,1) + ' MB / ' + $tmp.Count + ' 个')
  foreach($x in $tmp){ Remove-Target $x.FullName 'A' }
  Write-Host '[A] 随后执行 git reflog expire --expire=now --all 与 git gc --prune=now（约回收 2.0 GB 不可达对象，需要几分钟，中途别取消）'
  if($Apply){
    Push-Location $root
    git reflog expire --expire=now --all
    git gc --prune=now
    Pop-Location
  }
}

if($Pick -contains 'B'){ Remove-Target (Join-Path $root 'frontend\src-tauri\target\debug') 'B' }
if($Pick -contains 'C'){ Remove-Target (Join-Path $root 'frontend\src-tauri\target\release') 'C' }

if($Pick -contains 'D'){
  Get-ChildItem $ov -Directory -Filter 'release-0.2.*' | ForEach-Object {
    $one = $_.FullName
    Get-ChildItem -LiteralPath $one -Recurse -File -Force -EA SilentlyContinue | Where-Object {
      $_.Name -match '\.(exe|sig)$' -or $_.FullName -match '\\(app|app-final|sidecar|build|download-verification|smoke-data|test-data|pyinstaller-build)\\'
    } | ForEach-Object { Remove-Target $_.FullName 'D' }
  }
}

if($Pick -contains 'E'){
  $Dbs = @('audio-modes-v1\seekx_copy','_healcheck','r38-dup\db-before-r38.sqlite',
           'hidden-builtin-restore-v1\scratch','_probe_copy.sqlite','_clone_r10_data')
  foreach($d in $Dbs){ Remove-Target (Join-Path $ov $d) 'E' }
  $Scratch = @('splash-desktop','splash-err','splash-fade','splash-frames','splash-raw','splash-raw2',
               'splash-scan','splash-slider','splash-v3-entrance','splash-v3-error','splash-v3-leave',
               'splash-v3-reduced','splash-zoom','splash-zoom2','rh-verify','rh-verify3','rh-verify4',
               'rh-verify5','rh-verify6','settings-shot','_chunks','_clone_r5_tmp','_dev',
               '_clone_health_data','comfyui-diag','verify-models-split4','r37-orphan','r37-native-load',
               'video-thumb-sharp-v1','avatar-voices-v1','audio-modes-v1','hidden-builtin-restore-v1',
               'r38-dup','bundled','avatar-personas-v2')
  foreach($d in $Scratch){ Remove-Target (Join-Path $ov $d) 'E' }
  Write-Host '[E] 提醒: _clone_r10_data\backup\pre-0.2.33 是 0.2.33 迁移前的真实库备份，动手前想清楚要不要留'
}

if($Pick -contains 'F'){
  Push-Location $root
  $tracked = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach($x in (git ls-files outputs)){ [void]$tracked.Add(($x -replace '\\','/')) }
  Pop-Location
  Get-ChildItem $ov -File -Force -EA SilentlyContinue | ForEach-Object {
    $rel = 'outputs/' + $_.Name
    if(-not $tracked.Contains($rel)){ Remove-Target $_.FullName 'F' }
  }
}

if($Pick -contains 'G'){
  Remove-Target (Join-Path $root 'vendor\media-tools')      'G'
  Remove-Target (Join-Path $root 'backend\.venv')           'G'
  Remove-Target (Join-Path $root 'frontend\node_modules')   'G'
  Remove-Target (Join-Path $root 'frontend\.vite')          'G'
  Remove-Target (Join-Path $root '.vite')                   'G'
  Remove-Target (Join-Path $root '.pytest_cache')           'G'
  Remove-Target (Join-Path $root 'backend\.pytest_cache')   'G'
}

Write-Host ''
foreach($k in ($script:Tier.Keys | Sort-Object)){
  Write-Host ('  Tier ' + $k + ': ' + [math]::Round($script:Tier[$k]/1MB,1) + ' MB')
}
Write-Host ('  合计: ' + [math]::Round($script:Grand/1MB,1) + ' MB (' + [math]::Round($script:Grand/1GB,2) + ' GB)')
if($script:Rows.Count){ $script:Rows | Export-Csv -LiteralPath $log -NoTypeInformation -Encoding UTF8; Write-Host ('  明细清单: ' + $log) }
