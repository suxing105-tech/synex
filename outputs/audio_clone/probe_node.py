import io, re
src = io.open("nodes.py", encoding="utf-8").read().splitlines()
start = None
for i, l in enumerate(src):
    if "class Qwen3VoiceClone" in l:
        start = i
        break
print("class at", start)
for i in range(start, min(start + 120, len(src))):
    print(i + 1, src[i][:160])
