# -*- coding: utf-8 -*-
"""更新 test_clone_bundled.py：内置模板从两条变三条（图片/视频/音频）。"""
import io, os
P = r"backend\tests\test_clone_bundled.py"
s = io.open(P, encoding="utf-8").read()
orig = s

def rep(old, new, n=1):
    global s
    assert s.count(old) == n, (s.count(old), old[:70])
    s = s.replace(old, new)

rep('"""内置「一键同款」工作流：随包那两条（图片 / 视频）能不能正确长进库里。',
    '"""内置「一键同款」工作流：随包那三条（图片 / 视频 / 音频）能不能正确长进库里。')

rep('IMAGE_KEY = "qwen-multi-image-edit"\nVIDEO_KEY = "h3-reference-video"\n',
    'IMAGE_KEY = "qwen-multi-image-edit"\nVIDEO_KEY = "h3-reference-video"\nAUDIO_KEY = "qwen3-tts-voice-clone"\n')

rep('''def test_ships_one_image_and_one_video_workflow():
    """包里就是两条：Qwen 多图编辑（图片）与 H3 参考视频（视频）。"""
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    assert set(by_key) == {IMAGE_KEY, VIDEO_KEY}
    assert by_key[IMAGE_KEY]["media_kind"] == "image"
    assert by_key[IMAGE_KEY]["label"] == "闪寻图片编辑"
    assert by_key[VIDEO_KEY]["media_kind"] == "video"
    assert by_key[VIDEO_KEY]["label"] == "闪寻参考生视频"
''',
    '''def test_ships_one_workflow_per_family():
    """包里就是三条，一族一条：Qwen 多图编辑、H3 参考视频、Qwen3 音色克隆。"""
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    assert set(by_key) == {IMAGE_KEY, VIDEO_KEY, AUDIO_KEY}
    assert by_key[IMAGE_KEY]["media_kind"] == "image"
    assert by_key[IMAGE_KEY]["label"] == "闪寻图片编辑"
    assert by_key[VIDEO_KEY]["media_kind"] == "video"
    assert by_key[VIDEO_KEY]["label"] == "闪寻参考生视频"
    assert by_key[AUDIO_KEY]["media_kind"] == "audio"
    assert by_key[AUDIO_KEY]["label"] == "闪寻音频克隆"


def test_shipped_audio_workflow_is_the_trimmed_voice_clone_branch():
    """原文件三条输出分支并存（点一次跑三次生成），包里只能留音色克隆那一条出口。"""
    entry = [e for e in clone_bundled.entries() if e["key"] == AUDIO_KEY][0]
    classes = {n["class_type"] for n in entry["workflow"].values()}
    assert "Qwen3VoiceClone" in classes and "SaveAudioAdvanced" in classes
    assert not classes & {"Qwen3VoiceDesign", "Qwen3CustomVoice", "PreviewAudio"}, \\
        "多余的分支会让一次生成跑三遍"
    outs = [c for c in classes if c.lower().startswith(("save", "preview"))]
    assert outs == ["SaveAudioAdvanced"]
    # 音色克隆必须同时有参考音频与它的文本，少一个节点会当场报错
    slots = {(s["kind"], s["node"], s["input"]) for s in entry["slots"]}
    assert ("audio", "44", "audio") in slots
    assert ("prompt", "45", "ref_text") in slots and ("prompt", "45", "text") in slots
''')

rep('''    assert "Qwen 多图编辑" in by_key[IMAGE_KEY]["legacy_labels"]
    assert "H3参考视频" in by_key[VIDEO_KEY]["legacy_labels"]
''',
    '''    assert "Qwen 多图编辑" in by_key[IMAGE_KEY]["legacy_labels"]
    assert "H3参考视频" in by_key[VIDEO_KEY]["legacy_labels"]
    assert "闪寻音频" in by_key[AUDIO_KEY]["legacy_labels"]
''')

rep('''def test_fresh_install_seeds_both_families(seeded):
    rows = clone_templates.list_templates()
    assert {r["name"] for r in rows} == {"闪寻图片编辑", "闪寻参考生视频"}
    assert all(r["is_builtin"] for r in rows)
    by_kind = {r["media_kind"]: r for r in rows}
    assert set(by_kind) == {"image", "video"}
    assert all(r["is_active"] for r in by_kind.values()), "图片卡与视频卡各有各的当前"
''',
    '''def test_fresh_install_seeds_every_family(seeded):
    rows = clone_templates.list_templates()
    assert {r["name"] for r in rows} == {"闪寻图片编辑", "闪寻参考生视频", "闪寻音频克隆"}
    assert all(r["is_builtin"] for r in rows)
    by_kind = {r["media_kind"]: r for r in rows}
    assert set(by_kind) == {"image", "video", "audio"}
    assert all(r["is_active"] for r in by_kind.values()), "三类卡各有各的当前"
''')

rep('''    assert again["inserted"] == []
    assert sorted(again["skipped"]) == [VIDEO_KEY, IMAGE_KEY]
    assert len(clone_templates.list_templates()) == 2
''',
    '''    assert again["inserted"] == []
    assert sorted(again["skipped"]) == sorted([IMAGE_KEY, VIDEO_KEY, AUDIO_KEY])
    assert len(clone_templates.list_templates()) == 3
''')

rep('''    assert len(rows) == 2, "认领一条 + 装上图片那条"''',
    '''    assert len(rows) == 3, "认领一条 + 装上另外两条"''')

rep('''    assert [r["bundled_key"] for r in clone_templates.list_templates()] == [VIDEO_KEY]
    again = clone_bundled.seed(conn)''',
    '''    assert {r["bundled_key"] for r in clone_templates.list_templates()} == {VIDEO_KEY, AUDIO_KEY}
    again = clone_bundled.seed(conn)''')

rep('''    assert [r["bundled_key"] for r in clone_templates.list_templates()] == [VIDEO_KEY]


def test_deleting_the_active_one_promotes_a_sibling(seeded):
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == VIDEO_KEY][0]
    clone_templates.delete_template(target["id"])
    rows = clone_templates.list_templates()
    assert [r["media_kind"] for r in rows] == ["image"]
    assert rows[0]["is_active"] is True
''',
    '''    assert {r["bundled_key"] for r in clone_templates.list_templates()} == {VIDEO_KEY, AUDIO_KEY}


def test_deleting_the_active_one_promotes_a_sibling(seeded):
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == VIDEO_KEY][0]
    clone_templates.delete_template(target["id"])
    rows = clone_templates.list_templates()
    assert {r["media_kind"] for r in rows} == {"image", "audio"}
    assert all(r["is_active"] for r in rows), "另外两族各自的当前不受影响"
''')

rep('''    items = client.get("/api/clone/templates").json()["items"]
    assert {i["name"] for i in items} == {"闪寻图片编辑", "闪寻参考生视频"}
    assert all(i["is_builtin"] for i in items)
    assert {i["media_kind"] for i in items} == {"image", "video"}
''',
    '''    items = client.get("/api/clone/templates").json()["items"]
    assert {i["name"] for i in items} == {"闪寻图片编辑", "闪寻参考生视频", "闪寻音频克隆"}
    assert all(i["is_builtin"] for i in items)
    assert {i["media_kind"] for i in items} == {"image", "video", "audio"}
''')

assert s != orig
tmp = P + ".tmp"
io.open(tmp, "w", encoding="utf-8", newline="\n").write(s)
os.replace(tmp, P)
print("patched", P)
