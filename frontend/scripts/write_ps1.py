import os, sys; path = sys.argv[1]; body = sys.stdin.read(); os.makedirs(os.path.dirname(path), exist_ok=True); open(path, "w", encoding="utf-8", newline="").write(body); print("WROTE", len(body))
