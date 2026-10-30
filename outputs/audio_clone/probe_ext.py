import io, re, glob
pat = re.compile(r"flac|AUDIO_EXT|audio_ext|is_audio_path|kind = .audio.")
for f in ["app/indexer.py", "app/media.py", "app/repository.py"]:
    try:
        src = io.open(f, encoding="utf-8").read().splitlines()
    except OSError:
        continue
    for i, l in enumerate(src):
        if pat.search(l):
            print(f, i+1, l.strip()[:150])
