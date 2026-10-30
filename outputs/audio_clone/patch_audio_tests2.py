# -*- coding: utf-8 -*-
import io, os
P = r"backend\tests\test_clone_audio.py"
s = io.open(P, encoding="utf-8").read()

def rep(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)

rep('''def audio_template(name="闪寻音频克隆") -> dict:
    entry = [e for e in clone_bundled.entries() if e["key"] == "qwen3-tts-voice-clone"][0]
    return ct.create_template(name, qwen3_nodes(), ct.detect_slots(qwen3_nodes())["slots"])''',
    '''def audio_template(name="闪寻音频克隆") -> dict:
    """直接用随包那条：槽位是真机检测出来的（含语言下拉），离线检测拿不到 combo 选项。"""
    entry = [e for e in clone_bundled.entries() if e["key"] == "qwen3-tts-voice-clone"][0]
    return ct.create_template(name, entry["workflow"], entry["slots"])''')

rep('''async def test_audio_slot_rejects_an_image(fake_audio, tmp_path, init_db):
    """往音频格子塞图片要说清错在哪一格，而不是让 LoadAudio 去报红。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    state = await clone_jobs.start(template_id=tpl["id"], prompt="x",
                                   references=[{"slot": cell["key"],
                                                "image_id": ref_media(tmp_path, "照片.png", "image")}],
                                   controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "error"
    assert "照片.png" in state["error"] and "音频" in state["error"]''',
    '''async def test_audio_slot_rejects_an_image(fake_audio, tmp_path, init_db):
    """往音频格子塞图片要在提交当场说清是哪一格，不该丢给 ComfyUI 去报红。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    with pytest.raises(ValueError) as exc:
        await clone_jobs.start(template_id=tpl["id"], prompt="x",
                               references=[{"slot": cell["key"],
                                            "image_id": ref_media(tmp_path, "照片.png", "image")}],
                               controls=None, source_image_id=None)
    assert "音频1" in str(exc.value) and "图片" in str(exc.value)
    assert clone_jobs.public_state()["active"] is False''')

rep('''    media = ref_media(tmp_path, "音色.opus", "audio")
    state = await clone_jobs.start(template_id=tpl["id"], prompt="x",
                                   references=[{"slot": cell["key"], "image_id": media}],
                                   controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "error"
    assert ".opus" in state["error"] and "MP3" in state["error"]''',
    '''    media = ref_media(tmp_path, "音色.opus", "audio")
    await clone_jobs.start(template_id=tpl["id"], prompt="x",
                           references=[{"slot": cell["key"], "image_id": media}],
                           controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "error"
    assert ".opus" in state["error"] and "MP3" in state["error"]''')

tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("ok")
