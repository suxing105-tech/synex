param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$previewExe = Join-Path $PSScriptRoot 'app\suxing-gallery.exe'
$previewBackend = Join-Path $PSScriptRoot 'app\python-backend.exe'
if (!(Test-Path -LiteralPath $previewExe -PathType Leaf) -or !(Test-Path -LiteralPath $previewBackend -PathType Leaf)) {
    throw '找不到新版程序，请保留启动入口旁的 app 文件夹。'
}
if ($CheckOnly) { Write-Output 'Preview launcher paths verified.'; exit 0 }
try {
    $runningGallery = @(Get-Process -Name 'suxing-gallery' -ErrorAction SilentlyContinue)
    foreach ($galleryProcess in $runningGallery) {
        if (!$galleryProcess.HasExited -and $galleryProcess.MainWindowHandle -ne 0) {
            [void]$galleryProcess.CloseMainWindow()
        }
    }
    foreach ($galleryProcess in $runningGallery) {
        if (!$galleryProcess.HasExited -and !$galleryProcess.WaitForExit(10000)) {
            throw '旧图库窗口尚未退出，请关闭后再次点击快捷启动。'
        }
    }
    Start-Process -FilePath $previewExe -WorkingDirectory (Split-Path -Parent $previewExe)
} catch {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($_.Exception.Message, '苏醒图库 · 新版预览')
    exit 1
}
