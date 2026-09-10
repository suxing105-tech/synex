"""Validate upload exclusions and scan reachable Git blobs without printing secrets."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def git(*args, data=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, input=data)


def main():
    excluded = ['.env', '.env.local', 'backend/data/db.sqlite',
                'outputs/auto-update-v1/private/updater.key',
                'outputs/startup-fix/app/demo.exe',
                'outputs/desktop-network-fix/pyinstaller-build/cache.bin',
                'outputs/auto-update-v1/smoke-data/image.png',
                'outputs/folder-picker-v1/desktop.stderr']
    for path in excluded:
        assert git('check-ignore', '--no-index', path).strip(), path
    for path in ['backend/app/main.py', 'frontend/src/App.svelte',
                 'frontend/package-lock.json', '.env.example']:
        result = subprocess.run(['git', 'check-ignore', '--no-index', path], cwd=ROOT,
                                capture_output=True)
        assert result.returncode == 1, f'Source unexpectedly ignored: {path}'
    objects = git('rev-list', '--objects', 'HEAD').splitlines()
    metadata = git('cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)',
                   data=b'\n'.join(objects) + b'\n')
    patterns = [rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                rb'gh[pousr]_[A-Za-z0-9]{36,}', rb'github_pat_[A-Za-z0-9_]{40,}',
                rb'AKIA[A-Z0-9]{16}']
    blobs = []
    for line in metadata.splitlines():
        parts = line.split(b' ', 3)
        if parts[0] != b'blob':
            continue
        _, sha, size, path = parts
        assert int(size) < 100 * 1024 * 1024, f'Oversized blob: {path!r}'
        blobs.append((sha, path))
    proc = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=ROOT,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for sha, path in blobs:
            proc.stdin.write(sha + b'\n')
            proc.stdin.flush()
            header = proc.stdout.readline().split()
            content = proc.stdout.read(int(header[2]))
            proc.stdout.read(1)
            for pattern in patterns:
                assert not re.search(pattern, content), f'Potential credential in {path!r}'
    finally:
        proc.stdin.close()
        proc.stdout.close()
        proc.wait()
    print(f'PASS: exclusion rules, source inclusion, {len(blobs)} historical blobs (size/credential patterns)')


if __name__ == '__main__':
    main()
