"""Verify the exact public feed URL used by installed clients, without credentials."""
from pathlib import Path
import hashlib
import json
import httpx

root = Path(__file__).resolve().parent
feed_url = 'https://github.com/suxing105-tech/synex/releases/latest/download/latest.json'
with httpx.Client(follow_redirects=True, timeout=180) as client:
    response = client.get(feed_url)
    response.raise_for_status()
    feed = response.json()
    assert feed['version'] == '0.2.3', 'Public latest feed has not updated'
    platform = feed['platforms']['windows-x86_64']
    expected_url = 'https://github.com/suxing105-tech/synex/releases/download/v0.2.3/suxing-gallery_0.2.3_x64-setup.exe'
    assert platform['url'] == expected_url
    destination = root / 'download-verification'
    destination.mkdir(exist_ok=True)
    target = destination / 'suxing-gallery_0.2.3_x64-setup.exe'
    digest = hashlib.sha256()
    with client.stream('GET', platform['url']) as download:
        download.raise_for_status()
        assert download.url.scheme == 'https'
        with target.open('wb') as stream:
            for chunk in download.iter_bytes():
                digest.update(chunk)
                stream.write(chunk)
    signature = client.get(platform['url'] + '.sig')
    signature.raise_for_status()
    assert signature.text.strip() == platform['signature'].strip()
    Path(str(target) + '.sig').write_text(signature.text, encoding='utf-8')
    expected = json.loads((root / 'artifact.json').read_text(encoding='utf-8-sig'))
    assert digest.hexdigest().upper() == expected['sha256']
    report = {'feed': feed_url, 'version': feed['version'], 'installer_url': platform['url'],
        'bytes': target.stat().st_size, 'sha256': digest.hexdigest(), 'signature_matches_feed': True,
        'download_without_authentication': True}
    (root / 'public-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
