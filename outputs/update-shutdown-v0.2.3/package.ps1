$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$projectRoot = Split-Path (Split-Path $packageRoot -Parent) -Parent
$installerPath = Join-Path $packageRoot 'suxing-gallery_0.2.3_x64-setup.exe'
Copy-Item -LiteralPath (Join-Path $projectRoot 'frontend/src-tauri/target/release/bundle/nsis/苏醒图库_0.2.3_x64-setup.exe') -Destination $installerPath -Force
New-Item -ItemType Directory -Force (Join-Path $packageRoot 'app') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'frontend/src-tauri/target/release/suxing-gallery.exe') -Destination (Join-Path $packageRoot 'app/suxing-gallery.exe') -Force
Copy-Item -LiteralPath (Join-Path $packageRoot 'sidecar/python-backend.exe') -Destination (Join-Path $packageRoot 'app/python-backend.exe') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'outputs/import-window-v10/launch-preview.ps1') -Destination $packageRoot -Force
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $packageRoot '快捷启动新版.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $packageRoot 'launch-preview.ps1') + '"'
$shortcut.WorkingDirectory = $packageRoot
$shortcut.IconLocation = Join-Path $packageRoot 'app/suxing-gallery.exe'
$shortcut.WindowStyle = 7
$shortcut.Save()
$file = Get-Item -LiteralPath $installerPath
$sourceCommit = git -C (Join-Path $projectRoot 'outputs/release-v0.2.2/repository') rev-parse HEAD
[PSCustomObject]@{version='0.2.3';file=$file.Name;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash;sourceCommit=$sourceCommit} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'artifact.json') -Encoding utf8
