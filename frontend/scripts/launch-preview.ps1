param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$appDir = Join-Path $PSScriptRoot 'app'
$previewExe = Join-Path $appDir 'suxing-gallery.exe'
$previewBackend = Join-Path $appDir 'python-backend.exe'
if (!(Test-Path -LiteralPath $previewExe -PathType Leaf) -or !(Test-Path -LiteralPath $previewBackend -PathType Leaf)) {
    throw '找不到预览程序，请保留快捷启动文件旁的 app 文件夹（整个文件夹一起拷贝）。'
}
if ($CheckOnly) { Write-Output 'Preview launcher paths verified.' ; exit 0 }

# Preview and installed builds share sidecar port 8765, so politely close a running gallery window first.
# MainWindowHandle is sometimes 0, so fall back to enumerating top-level windows per pid and posting WM_CLOSE.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SeekXWindow {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static int CloseForPid(uint targetPid) {
    int n = 0;
    EnumWindows((h, l) => {
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid && IsWindowVisible(h)) { PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
      return true; }, IntPtr.Zero);
    return n;
  }
}
'@

try {
    $running = @(Get-Process -Name 'suxing-gallery' -ErrorAction SilentlyContinue)
    foreach ($p in $running) {
        if ($p.HasExited) { continue }
        if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() }
        [void][SeekXWindow]::CloseForPid([uint32]$p.Id)
    }
    foreach ($p in $running) {
        if (!$p.HasExited -and !$p.WaitForExit(20000)) {
            # The main window closed but the process still waits for its child; the backend is down by now, so cleanup is safe.
            $backend = @(Get-Process -Name 'python-backend' -ErrorAction SilentlyContinue |
                         Where-Object { $_.Path -like "$appDir*" })
            if ($backend.Count -eq 0) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    Start-Sleep -Seconds 2
    Start-Process -FilePath $previewExe -WorkingDirectory $appDir
} catch {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($_.Exception.Message, '闪寻空间 · 预览版')
    exit 1
}
