$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$required = @(
    'outputs/demo.html', 'frontend/src/App.svelte', 'frontend/src/lib/api.ts',
    'frontend/src/lib/backend-url.ts', 'backend/app/repository.py',
    'frontend/pyinstaller/python-backend.spec', 'backend/run_server.py',
    'outputs/folder-picker-v1/苏醒图库_0.2.1_x64-setup.exe',
    'outputs/folder-picker-v1/苏醒图库_0.2.1_x64-setup.exe.sig',
    'outputs/project-review-2026-09-09/项目现状与修改建议.md',
    'materials/41-project-review-2026-09-09.md'
)
foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $item))) { throw "Missing: $item" }
}
$config = Get-Content -Raw -LiteralPath (Join-Path $repo 'frontend/src-tauri/tauri.conf.json') | ConvertFrom-Json
$package = Get-Content -Raw -LiteralPath (Join-Path $repo 'frontend/package.json') | ConvertFrom-Json
if ($config.version -ne '0.2.1' -or $package.version -ne '0.2.1') { throw 'Version evidence changed' }
if ($config.build.frontendDist -ne '../dist' -or $config.build.beforeBuildCommand -ne 'pnpm build') { throw 'Shared frontend build evidence changed' }
$spec = Get-Content -Raw -LiteralPath (Join-Path $repo 'frontend/pyinstaller/python-backend.spec')
if (-not $spec.Contains('ENTRY = BACKEND_DIR / "run_server.py"')) { throw 'Shared backend evidence changed' }
'PASS: report paths, version, shared frontend build and backend entry verified.'
