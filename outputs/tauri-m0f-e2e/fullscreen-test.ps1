# Take only a single fullscreen capture to find Tauri window position
$exe = "C:\Users\Administrator\Documents\ChatGPT\苏醒图库\outputs\tauri-m0f-e2e\run-nosidecar\suxing-gallery.exe"
$outDir = "C:\Users\Administrator\Documents\ChatGPT\苏醒图库\outputs\tauri-m0f-e2e"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$vb = [System.Windows.Forms.SystemInformation]::VirtualScreen

function Cap([System.Drawing.Rectangle]$R, [string]$P) {
  $b = New-Object System.Drawing.Bitmap($R.Width, $R.Height)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($R.Location, [System.Drawing.Point]::Empty, $R.Size)
  $b.Save($P, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $b.Dispose
}

Get-Process -Name "suxing-gallery","python-backend" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$wd = Split-Path $exe -Parent
$proc = Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru
Write-Host ("launched, capturing fullscreen at t=5, t=15, t=35")
Start-Sleep -Seconds 5
Cap $vb (Join-Path $outDir "fullscreen-t05s.png")
Start-Sleep -Seconds 10
Cap $vb (Join-Path $outDir "fullscreen-t15s.png")
Start-Sleep -Seconds 20
Cap $vb (Join-Path $outDir "fullscreen-t35s.png")

Get-Process -Name "suxing-gallery" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# Also dump Tauri window bounding rect via .NET
$tauri = Get-Process -Name "suxing-gallery" -ErrorAction SilentlyContinue
if ($tauri) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
  $hwnd = [Win32]::FindWindow($null, "苏醒图库")
  if ($hwnd -ne [IntPtr]::Zero) {
    $rect = New-Object Win32+RECT
    [void][Win32]::GetWindowRect($hwnd, [ref]$rect)
    Write-Host ("tauri window: x={0} y={1} w={2} h={3}" -f $rect.Left, $rect.Top, ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
  }
}