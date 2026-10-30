# -*- coding: utf-8 -*-
import io, os
P = r"backend\tests\test_clone_audio.py"
s = io.open(P, encoding="utf-8").read()

def rep(old, new):
    global s
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new)

rep('''    payload = Indexer()._process_path_sync(path)
    assert payload and payload["kind"] == kind, payload
    return int(payload["id"])''',
    '''    payload = Indexer()._process_path_sync(path)
    assert payload, "indexer 没认这个文件"
    row = get_pool().main().execute("SELECT kind FROM images WHERE id=?", (int(payload["id"]),)).fetchone()
    assert row and str(row["kind"]) == kind, row
    return int(payload["id"])''')

rep('''    media = ref_media(tmp_path, "音色.aiff", "audio")''',
    '''    # .opus 是图库认的音频、却不在 ComfyUI 吃得下的容器里：正好测「放行表」这一层
    media = ref_media(tmp_path, "音色.opus", "audio")''')

rep('''    assert ".aiff" in state["error"] and "MP3" in state["error"]''',
    '''    assert ".opus" in state["error"] and "MP3" in state["error"]''')

tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
