import io, re, glob
pat = re.compile(r"detect_media_kind|media_kind|OUTPUT_HISTORY|\"audio\"|'audio'")
for f in sorted(glob.glob(r"tests\test_clone_*.py")):
    hits = [(i+1, l.rstrip()[:130]) for i, l in enumerate(io.open(f, encoding="utf-8").read().splitlines()) if pat.search(l)]
    print("==", f, len(hits))
    for n, l in hits[:14]:
        print("   ", n, l)
