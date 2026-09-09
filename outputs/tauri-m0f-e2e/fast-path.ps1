# Fast-path E2E with sidecar present
$exe = "C:\Users\Administrator\Documents\ChatGPT\苏醒图库\outputs\tauri-m0f-e2e\run\suxing-gallery.exe"
$outDir = "C:\Users\Administrator\Documents\ChatGPT\苏醒图库\outputs\tauri-m0f-e2e"
Get-ChildItem "$outDir\fast-*.png" -ErrorAction SilentlyContinue | Remove-Item

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
Start-Sleep -Seconds 2

$wd = Split-Path $exe -Parent
$proc = Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru
Write-Host ("fast-path launch (with sidecar)")

$start = Get-Date
$capturePoints = @(0, 1, 2, 3, 4, 5, 7, 10)
$idx = 0
while ($idx -lt $capturePoints.Count) {
  $elapsed = ((Get-Date) - $start).TotalSeconds
  $target = $capturePoints[$idx]
  if ($elapsed -ge $target) {
    $path = Join-Path $outDir ("fast-t{0:D2}s.png" -f $target)
    Cap $vb $path
    Write-Host ("captured t={0}s" -f $target)
    $idx++
  } else {
    Start-Sleep -Milliseconds 100
  }
}

Get-Process -Name "suxing-gallery","python-backend" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
$count = (Get-ChildItem "$outDir\fast-*.png" | Measure-Object).Count
Write-Host ("done. {0} frames" -f $count)