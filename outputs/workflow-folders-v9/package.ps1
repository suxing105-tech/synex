$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$projectRoot = Split-Path (Split-Path $packageRoot -Parent) -Parent
Copy-Item -LiteralPath (Join-Path $projectRoot 'frontend/src-tauri/target/release/suxing-gallery.exe') -Destination (Join-Path $packageRoot 'app/suxing-gallery.exe') -Force
Copy-Item -LiteralPath (Join-Path $packageRoot 'sidecar/python-backend.exe') -Destination (Join-Path $packageRoot 'app/python-backend.exe') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'frontend/src-tauri/target/release/bundle/nsis/苏醒图库_0.2.1_x64-setup.exe') -Destination $packageRoot -Force
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut((Join-Path $packageRoot '快捷启动新版.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $packageRoot 'launch-preview.ps1') + '"'
$shortcut.WorkingDirectory = $packageRoot
$shortcut.IconLocation = Join-Path $packageRoot 'app/suxing-gallery.exe'
$shortcut.WindowStyle = 7
$shortcut.Save()
$artifacts = @('app/suxing-gallery.exe', 'app/python-backend.exe', '苏醒图库_0.2.1_x64-setup.exe') | ForEach-Object {
    $artifact = Get-Item -LiteralPath (Join-Path $packageRoot $_)
    [PSCustomObject]@{ file = $_; bytes = $artifact.Length; sha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash }
}
$artifacts | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'artifacts.json') -Encoding utf8
