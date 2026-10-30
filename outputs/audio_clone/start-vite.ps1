# dev server on 5199 -> backend 8897, for eyeballing the audio one-click-clone changes
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$env:VITE_BACKEND_PORT = '8897'
$fe = Join-Path $root 'frontend'
$log = Join-Path $PSScriptRoot 'vite.out'
$errf = Join-Path $PSScriptRoot 'vite.err'
$vargs = @('/c', 'npx vite --port 5199 --strictPort --host 127.0.0.1')
$p = Start-Process -FilePath 'cmd' -ArgumentList $vargs -WorkingDirectory $fe -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError $errf
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5199/' -UseBasicParsing -TimeoutSec 3
        Write-Output ('vite up ' + $r.StatusCode + ' after ' + ($i+1) + 's pid ' + $p.Id)
        exit 0
    } catch { }
}
Write-Output 'vite did NOT come up'
Get-Content $errf -Tail 20
exit 1
