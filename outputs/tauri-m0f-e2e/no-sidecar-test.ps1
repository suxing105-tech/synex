# Sidecar-absent E2E: launch Tauri without sidecar → splash should show immediately, red card after 30s
$exe = "C:\Users\Administrator\Documents\ChatGPT\苏醒图库\outputs\tauri-m0f-e2e\run-nosidecar\suxing-gallery.exe"
$outDir = "C:\Users\Administrator\Documents\ChatGPT\苏醒图库\outputs\tauri-m0f-e2e"
Get-ChildItem "$outDir\nosidecar-*.png" -ErrorAction SilentlyContinue | Remove-Item

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Cap([System.Drawing.Rectangle]$R, [string]$P) {
  $b = New-Object System.Drawing.Bitmap($R.Width, $R.Height)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($R.Location, [System.Drawing.Point]::Empty, $R.Size)
  $b.Save($P, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $b.Dispose
}

$vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
$tw = 1280; $th = 800
$tx = $vb.X + [int](($vb.Width - $tw) / 2)
$ty = $vb.Y + [int](($vb.Height - $th) / 2)
$region = New-Object System.Drawing.Rectangle($tx, $ty, $tw, $th)
$wd = Split-Path $exe -Parent

$proc = Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru
Write-Host ("launched pid {0} WITHOUT sidecar; capturing for 35s" -f $proc.Id)

$start = Get-Date
$capturePoints = @(0, 1, 2, 3, 5, 8, 12, 16, 20, 25, 30, 32, 35)
$idx = 0
while ($idx -lt $capturePoints.Count) {
  $elapsed = ((Get-Date) - $start).TotalSeconds
  $target = $capturePoints[$idx]
  if ($elapsed -ge $target) {
    $path = Join-Path $outDir ("nosidecar-t{0:D2}s.png" -f $target)
    Cap $region $path
    Write-Host ("captured {0}" -f $path)
    $idx++
  } else {
    Start-Sleep -Milliseconds 200
  }
}

Get-Process -Name "suxing-gallery" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$count = (Get-ChildItem "$outDir\nosidecar-*.png" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host ("captured {0} frames" -f $count)