"""Publish only the three explicitly named release artifacts; never log credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import httpx

ROOT = Path(__file__).resolve().parent
REPO = 'suxing105-tech/synex'
COMMIT = 'd3e9e021871a71d3cc9daaae714ad324c1c1e8e9'
TAG = 'v0.2.3'
FILES = ['suxing-gallery_0.2.3_x64-setup.exe', 'suxing-gallery_0.2.3_x64-setup.exe.sig', 'latest.json']

def main(mode):
    # Reuse the Git credential helper already configured for this repository.
    result = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
        text=True, capture_output=True, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, cwd=ROOT)
    if result.returncode:
        raise RuntimeError('Existing GitHub credentials are unavailable; no files uploaded.')
    credential = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    secret = credential.get('password')
    if not secret: raise RuntimeError('Existing GitHub credentials are unavailable.')
    with httpx.Client(headers={'Authorization': 'Bearer ' + secret, 'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'}, timeout=180) as client:
        def request(method, path, **kwargs):
            response = client.request(method, 'https://api.github.com/repos/' + REPO + path, **kwargs)
            if response.status_code >= 400:
                raise RuntimeError(f'GitHub request failed ({response.status_code}) for {method} {path}')
            return response.json()
        releases = request('GET', '/releases')
        matching = [r for r in releases if r['tag_name'] == TAG]
        if len(matching) > 1: raise RuntimeError('Ambiguous release state')
        release = matching[0] if matching else None
        if mode == 'prepare':
            metadata = json.loads((ROOT / 'artifact.json').read_text(encoding='utf-8-sig'))
            actual = hashlib.sha256((ROOT / FILES[0]).read_bytes()).hexdigest().upper()
            if actual != metadata['sha256']: raise RuntimeError('Installer checksum changed')
            if not release:
                release = request('POST', '/releases', json={'tag_name': TAG, 'target_commitish': COMMIT,
                    'name': '苏醒图库 0.2.3', 'body': (ROOT / 'release-notes.md').read_text(encoding='utf-8'),
                    'draft': True, 'prerelease': False})
            if not release['draft']: raise RuntimeError('Release already public; refusing to alter assets')
            for name in FILES:
                path = ROOT / name
                existing = [a for a in release['assets'] if a['name'] == name]
                if existing:
                    digest = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
                    if existing[0].get('digest') == digest: continue
                    raise RuntimeError('Existing asset differs; refusing to overwrite')
                with path.open('rb') as stream:
                    response = client.post(release['upload_url'].split('{')[0], params={'name': name},
                        headers={'Content-Type': 'application/octet-stream', 'Content-Length': str(path.stat().st_size)}, content=stream)
                if response.status_code != 201: raise RuntimeError(f'Asset upload failed ({response.status_code}) for {name}')
            release = request('GET', f"/releases/{release['id']}")
        elif mode == 'publish':
            if not release: raise RuntimeError('Draft not found')
            assets = {a['name']: a for a in release['assets']}
            for name in FILES:
                if name not in assets: raise RuntimeError('Incomplete release assets')
                expected = 'sha256:' + hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                if assets[name].get('digest') != expected: raise RuntimeError('Remote asset checksum mismatch')
            release = request('PATCH', f"/releases/{release['id']}", json={'draft': False, 'make_latest': 'true'})
        summary = {'id': release['id'], 'tag': release['tag_name'], 'draft': release['draft'],
            'url': release['html_url'], 'assets': [{'name':a['name'],'size':a['size'],'digest':a.get('digest'),
                'url':a['browser_download_url']} for a in release['assets']]}
        (ROOT / 'release-status.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare','publish'])
    main(parser.parse_args().mode)
