import io, os
P = r"backend\tests\test_clone_audio.py"
s = io.open(P, encoding="utf-8").read()
old = '''    node = fake_audio.prompts[-1]["45"]["inputs"]'''
new = '''    node = fake_audio.prompts[-1]["prompt"]["45"]["inputs"]'''
assert s.count(old) == 1
s = s.replace(old, new)
old2 = '''    sent = json.dumps(fake_audio.prompts[-1], ensure_ascii=False)'''
assert s.count(old2) == 1
tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
