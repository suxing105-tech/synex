"""内置「一键同款」工作流：随包这五条（图片一条、视频一条、声音三种出声方式）能不能正确长进库里。

只碰本地 SQLite 与随包资源，绝不连真机 ComfyUI——槽位固化在 JSON 里，
首启不需要 object_info，这条本身就是要守住的性质。
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import clone_bundled, clone_templates
from app.clone_templates import detect_slots
from app.main import app

IMAGE_KEY = "qwen-multi-image-edit"
VIDEO_KEY = "h3-reference-video"
AUDIO_KEY = "qwen3-tts-voice-clone"
DESIGN_KEY = "qwen3-tts-voice-design"
CUSTOM_KEY = "qwen3-tts-custom-voice"
ALL_KEYS = [IMAGE_KEY, VIDEO_KEY, AUDIO_KEY, DESIGN_KEY, CUSTOM_KEY]
AUDIO_LABELS = {"闪寻参考音色", "闪寻音色描述", "闪寻指定音色"}


@pytest.fixture
def seeded(tmp_path: Path, monkeypatch):
    """开内置开关 + 空库：走的就是「新装用户第一次打开」那条路。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "1")
    pool = db.init_pool()
    pool.initialize()
    return pool


def _fake_entry(key="fake-workflow", label="假工作流", prompt="换我试试", media_kind="image"):
    workflow = {
        "10": {"class_type": "CR Prompt Text", "inputs": {"prompt": prompt}},
        "11": {"class_type": "LoadImage", "inputs": {"image": "旧素材.png"}, "_meta": {"title": "加载图像"}},
        "12": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": ["10", 0], "negative_prompt": "糊"}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0]}},
    }
    return {
        "key": key, "label": label, "media_kind": media_kind,
        "slots": detect_slots(workflow)["slots"], "workflow": workflow, "_file": key + ".json",
    }


def _row_of_key(pool, key):
    return pool.main().execute(
        "SELECT * FROM clone_templates WHERE bundled_key=?", (key,)
    ).fetchone()


# ---------- 随包资源本身 ----------

def test_ships_one_workflow_per_family():
    """图片与视频各一条，声音三条——出声音有三种方式，各是一个模型，没法合成一条工作流。

    ComfyUI 会执行图里所有输出节点：三条分支并排塞进一份 JSON，点一次同款就出三段音频、
    等三倍时间。所以这里按「出声方式」拆成三条，音频族的「当前」仍然只有一条。
    """
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    assert set(by_key) == set(ALL_KEYS)
    assert by_key[IMAGE_KEY]["media_kind"] == "image"
    assert by_key[IMAGE_KEY]["label"] == "闪寻图片编辑"
    assert by_key[VIDEO_KEY]["media_kind"] == "video"
    assert by_key[VIDEO_KEY]["label"] == "闪寻参考生视频"
    assert {by_key[k]["media_kind"] for k in (AUDIO_KEY, DESIGN_KEY, CUSTOM_KEY)} == {"audio"}
    assert {by_key[k]["label"] for k in (AUDIO_KEY, DESIGN_KEY, CUSTOM_KEY)} == AUDIO_LABELS


def test_shipped_audio_workflow_is_the_trimmed_voice_clone_branch():
    """原文件三条输出分支并存（点一次跑三次生成），包里只能留音色克隆那一条出口。"""
    entry = [e for e in clone_bundled.entries() if e["key"] == AUDIO_KEY][0]
    classes = {n["class_type"] for n in entry["workflow"].values()}
    assert "Qwen3VoiceClone" in classes and "SaveAudioAdvanced" in classes
    assert not classes & {"Qwen3VoiceDesign", "Qwen3CustomVoice", "PreviewAudio"}, \
        "多余的分支会让一次生成跑三遍"
    outs = [c for c in classes if c.lower().startswith(("save", "preview"))]
    assert outs == ["SaveAudioAdvanced"]
    # 音色克隆必须同时有参考音频与它的文本，少一个节点会当场报错
    slots = {(s["kind"], s["node"], s["input"]) for s in entry["slots"]}
    assert ("audio", "44", "audio") in slots
    assert ("prompt", "45", "ref_text") in slots and ("prompt", "45", "text") in slots


def test_the_two_no_reference_modes_are_trimmed_branches():
    """音色描述 / 指定音色：各自只留自己那条分支、各自存成一条音轨，且都不吃参考音频。"""
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    for key, gen_class, loader_repo, prefix in (
        (DESIGN_KEY, "Qwen3VoiceDesign", "VoiceDesign", "audio/闪寻音色描述"),
        (CUSTOM_KEY, "Qwen3CustomVoice", "CustomVoice", "audio/闪寻指定音色"),
    ):
        entry = by_key[key]
        classes = {n["class_type"] for n in entry["workflow"].values()}
        assert gen_class in classes and "SaveAudioAdvanced" in classes, key
        # 另两条分支留在图里 = 点一次出三段
        assert not classes & {"Qwen3VoiceClone", "PreviewAudio", "LoadAudio"}, key
        assert [c for c in entry["workflow"].values() if c["class_type"] == "SaveAudioAdvanced"][0][
            "inputs"]["filename_prefix"] == prefix, key
        slots = {(s["kind"], s["input"]) for s in entry["slots"]}
        assert ("prompt", "text") in slots, key                       # 台词单独一格
        assert not [s for s in entry["slots"]
                    if s["kind"] in ("image", "audio", "video")], key
        assert loader_repo in " ".join(str(n.get("inputs", {}).get("repo_id"))
                                       for n in entry["workflow"].values()), key
    # 描述音色那条：instruct 必填，单独一格，不与台词混写
    design = {(s["input"], s["label"]) for s in by_key[DESIGN_KEY]["slots"]}
    assert ("instruct", "音色描述") in design
    # 指定音色那条：音色是一台下拉，另留一格可选语气
    custom = {(s["input"], s["label"], s["kind"]) for s in by_key[CUSTOM_KEY]["slots"]}
    assert ("speaker", "音色", "select") in custom
    assert ("instruct", "语气与风格", "prompt") in custom


def test_builtins_know_their_old_names():
    """老库里躺着的是导入时的文件名，历史名字要带在包里，否则更新时装成两条一样的。"""
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    assert "Qwen 多图编辑" in by_key[IMAGE_KEY]["legacy_labels"]
    assert "H3参考视频" in by_key[VIDEO_KEY]["legacy_labels"]
    assert "闪寻音频" in by_key[AUDIO_KEY]["legacy_labels"]
    # 改名不改主键：老库里那条「闪寻音频克隆」下次启动顺势改成「闪寻参考音色」
    assert "闪寻音频克隆" in by_key[AUDIO_KEY]["legacy_labels"]


def test_shipped_workflows_carry_the_two_real_machine_fixes():
    """真机验证过的两处修正必须固化在包里，别哪天重新导资源又退回坏的那版。"""
    text = json.dumps(
        [e for e in clone_bundled.entries() if e["key"] == VIDEO_KEY][0]["workflow"],
        ensure_ascii=False)
    assert '"force_rate": 24' in text          # 参考视频按 24fps 吃帧
    assert "<Picture 1>" in text and "<Picture 2>" in text
    assert "@图片" not in text                          # 不是 @图片 那种 H3 不认的写法


def test_shipped_slots_point_at_real_nodes():
    """内置 JSON 是生成出来的，槽位指到不存在的节点要在这里被拦住。"""
    for entry in clone_bundled.entries():
        nodes, slots = clone_bundled._prepare(entry)
        assert [s for s in slots if s.get("kind") == "prompt"], entry["key"]
        for slot in slots:
            assert str(slot.get("node")) in nodes, (entry["key"], slot)


# ---------- 装进库 ----------

def test_fresh_install_seeds_every_family(seeded):
    rows = clone_templates.list_templates()
    assert {r["name"] for r in rows} == {"闪寻图片编辑", "闪寻参考生视频"} | AUDIO_LABELS
    assert all(r["is_builtin"] for r in rows)
    assert {r["media_kind"] for r in rows} == {"image", "video", "audio"}
    # 每族各自一个「当前」：声音三条也只能有一条是当前，弹窗开出来才有唯一默认
    for kind in ("image", "video", "audio"):
        family = [r for r in rows if r["media_kind"] == kind]
        assert sum(1 for r in family if r["is_active"]) == 1, kind
    assert sum(1 for r in rows if r["media_kind"] == "audio") == 3


def test_the_two_extra_audio_modes_have_no_reference_cells(seeded):
    """弹窗按参考位摆格子：这两种模式没有参考音频位，一格都不该摆出来。"""
    rows = {r["name"]: r for r in clone_templates.list_templates()}
    assert [c["kind"] for c in rows["闪寻参考音色"]["reference_cells"]] == ["audio"]
    for name in ("闪寻音色描述", "闪寻指定音色"):
        assert rows[name]["reference_cells"] == [], name
        assert rows[name]["modes"] == ["text"], name
    assert {s.get("label") for s in rows["闪寻指定音色"]["slots"]
            if s.get("kind") == "select"} == {"音色", "语言"}
    assert [s for s in rows["闪寻音色描述"]["slots"] if s.get("kind") == "prompt"][1][
        "label"] == "音色描述"


def test_seeded_video_template_keeps_every_cell_and_control(seeded):
    """9 图 / 3 音频 / 3 视频 + 时长、比例、分辨率，一样都不能少。"""
    video = [r for r in clone_templates.list_templates() if r["media_kind"] == "video"][0]
    kinds = [c["kind"] for c in video["reference_cells"]]
    assert [kinds.count(k) for k in ("image", "audio", "video")] == [9, 3, 3]
    assert video["reference_cells"][0]["label"] == "图片1"
    controls = {s.get("label") for s in video["slots"] if s.get("kind") in ("select", "number")}
    assert {"时长", "比例", "分辨率"} <= controls


def test_seeding_twice_does_not_duplicate(seeded):
    again = clone_bundled.seed(seeded.main())
    assert again["inserted"] == []
    assert sorted(again["skipped"]) == sorted(ALL_KEYS)
    assert len(clone_templates.list_templates()) == len(ALL_KEYS)


def test_user_edited_builtin_is_not_overwritten(seeded, monkeypatch):
    """用户动过正文 → 指纹对不上，包里的新版只能跳过。"""
    conn = seeded.main()
    replacement = _fake_entry()["workflow"]
    conn.execute("UPDATE clone_templates SET workflow=? WHERE bundled_key=?",
                 (json.dumps(replacement, ensure_ascii=False), IMAGE_KEY))
    monkeypatch.setattr(clone_bundled, "entries", lambda *a, **k: [
        _fake_entry(key=IMAGE_KEY, label="Qwen 多图编辑", prompt="包里更新的那版")])
    result = clone_bundled.seed(conn)
    assert result["updated"] == [] and IMAGE_KEY in result["skipped"]
    assert "包里更新的那版" not in clone_templates.workflow_json(
        _row_of_key(seeded, IMAGE_KEY)["id"])


def test_untouched_builtin_follows_the_shipped_update(seeded, monkeypatch):
    """用户没动过 → 包里的新版直接刷进去，槽位与提示词一起跟上。"""
    conn = seeded.main()
    entry = [e for e in clone_bundled.entries() if e["key"] == IMAGE_KEY][0]
    nodes = json.loads(json.dumps(entry["workflow"]))
    prompt_slot = [s for s in entry["slots"] if s.get("kind") == "prompt"][0]
    nodes[str(prompt_slot["node"])]["inputs"][prompt_slot["input"]] = "内置模板更新了 vX"
    patched = {**entry, "workflow": nodes, "slots": detect_slots(nodes)["slots"]}
    monkeypatch.setattr(clone_bundled, "entries", lambda *a, **k: [patched])
    assert clone_bundled.seed(conn)["updated"] == [IMAGE_KEY]
    row = _row_of_key(seeded, IMAGE_KEY)
    assert "vX" in clone_templates.workflow_json(row["id"])
    assert clone_bundled.workflow_sha(json.loads(row["workflow"])) == row["bundled_sha"]


def test_a_same_named_template_is_adopted_not_duplicated(tmp_path: Path, monkeypatch):
    """用户早自己导入过同一份工作流：认下那一条、改成现在的名字，不再造一条重名的。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "0")
    pool = db.init_pool()
    pool.initialize()
    created = clone_templates.create_template("H3参考视频", _fake_entry()["workflow"])

    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "1")
    result = clone_bundled.seed(pool.main())
    assert result["adopted"] == [VIDEO_KEY]
    assert result["renamed"] == [VIDEO_KEY], "老名字顺势改成现在这个名字"
    rows = clone_templates.list_templates()
    assert len(rows) == len(ALL_KEYS), "认领一条 + 装上另外四条"
    adopted = [r for r in rows if r["bundled_key"] == VIDEO_KEY][0]
    assert adopted["id"] == created["id"] and adopted["is_builtin"] is True
    assert adopted["name"] == "闪寻参考生视频"
    row = _row_of_key(pool, VIDEO_KEY)
    assert clone_bundled.workflow_sha(json.loads(row["workflow"])) != row["bundled_sha"], \
        "他那份与包里的不同 → 记成改过，以后不覆盖"


def test_a_renamed_builtin_keeps_the_users_name(seeded):
    """用户自己改过名 → 名字是他的，版本更新只动正文不动命名。"""
    conn = seeded.main()
    row = _row_of_key(seeded, VIDEO_KEY)
    clone_templates.update_template(row["id"], {"name": "我的出片工作流"})
    result = clone_bundled.seed(conn)
    assert result["renamed"] == []
    assert [r["name"] for r in clone_templates.list_templates()].count("我的出片工作流") == 1


def test_an_older_install_gets_renamed(seeded):
    """老安装里还叫历史名字的内置模板：下次启动改成现在的名字，id 与素材都不动。"""
    conn = seeded.main()
    row = _row_of_key(seeded, VIDEO_KEY)
    conn.execute("UPDATE clone_templates SET name=? WHERE id=?", ("H3参考视频", int(row["id"])))
    result = clone_bundled.seed(conn)
    assert result["renamed"] == [VIDEO_KEY]
    again = _row_of_key(seeded, VIDEO_KEY)
    assert again["name"] == "闪寻参考生视频" and int(again["id"]) == int(row["id"])


def test_deleted_builtin_does_not_come_back(seeded):
    """删掉的内置模板记进 dismissed 名单，下次启动不该又长回来。"""
    conn = seeded.main()
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY][0]
    clone_templates.delete_template(target["id"])
    assert {r["bundled_key"] for r in clone_templates.list_templates()} == set(ALL_KEYS) - {IMAGE_KEY}
    again = clone_bundled.seed(conn)
    assert IMAGE_KEY in again["dismissed"]
    assert IMAGE_KEY in clone_bundled.dismissed(conn)
    assert {r["bundled_key"] for r in clone_templates.list_templates()} == set(ALL_KEYS) - {IMAGE_KEY}


def test_deleting_the_active_one_promotes_a_sibling(seeded):
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == VIDEO_KEY][0]
    clone_templates.delete_template(target["id"])
    rows = clone_templates.list_templates()
    assert {r["media_kind"] for r in rows} == {"image", "audio"}
    assert all(r["is_active"] for r in rows if r["media_kind"] == "image"), "图片族的当前不受影响"
    audio = [r for r in rows if r["media_kind"] == "audio"]
    assert sum(1 for r in audio if r["is_active"]) == 1, "声音三条里仍只有一条是当前"
    assert len(audio) == 3, "删掉视频不会牵连声音那三条"


# ---------- 开关 ----------

def test_seeding_is_on_by_default(monkeypatch):
    monkeypatch.delenv("SUXING_SEED_BUNDLED_TEMPLATES", raising=False)
    assert clone_bundled.seed_enabled() is True
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "0")
    assert clone_bundled.seed_enabled() is False


def test_switch_off_keeps_a_fresh_db_empty(tmp_path: Path, monkeypatch):
    """关掉开关时空库还是空的——老用例的前提靠这条守住。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "0")
    pool = db.init_pool()
    pool.initialize()
    assert clone_templates.list_templates() == []


def test_api_reports_builtin_templates(seeded):
    with TestClient(app) as client:
        items = client.get("/api/clone/templates").json()["items"]
    assert {i["name"] for i in items} == {"闪寻图片编辑", "闪寻参考生视频"} | AUDIO_LABELS
    assert all(i["is_builtin"] for i in items)
    assert {i["media_kind"] for i in items} == {"image", "video", "audio"}


def test_templates_imported_by_the_user_are_not_builtin(seeded):
    created = clone_templates.create_template("我自己导的", _fake_entry()["workflow"])
    assert created["is_builtin"] is False


def _pretend_pre_split_install(pool) -> None:
    """把库演成「从旧版本升级上来的」：放行旗标还没落库。

    新库在 db.ConnectionPool.initialize() 里已经 seed 过一次，旗标当时就写上了；
    老库跑的旧版本根本没这段逻辑，升级后第一次启动才轮到放行。
    """
    pool.main().execute("DELETE FROM meta WHERE key=?", (clone_bundled.SPLIT_RESCUE_FLAG,))


def test_a_fresh_install_marks_the_flag_once(seeded):
    """新装库第一次装载就该落旗标，此后删参考音色是永久删。"""
    conn = seeded.main()
    assert conn.execute("SELECT 1 FROM meta WHERE key=?",
                        (clone_bundled.SPLIT_RESCUE_FLAG,)).fetchone() is not None
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(target["id"])
    assert clone_bundled.seed(conn)["rescued"] == []
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_a_pre_split_deletion_does_not_swallow_a_mode(seeded):
    """拆成三条之前删过老「闪寻音频」的库，升级后必须把「参考音色」还回来。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(target["id"])
    assert AUDIO_KEY in clone_bundled.dismissed(conn)
    again = clone_bundled.seed(conn)
    assert again["rescued"] == [AUDIO_KEY]
    assert {r["bundled_key"] for r in clone_templates.list_templates()} == set(ALL_KEYS), "三种模式齐了"
    assert AUDIO_KEY not in clone_bundled.dismissed(conn), "放行要真把名字从名单里抹掉"


def test_the_rescue_happens_only_once(seeded):
    """放行之后再删就是用户自己的决定，不许每次启动都复活一次。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    first = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(first["id"])
    assert clone_bundled.seed(conn)["rescued"] == [AUDIO_KEY]
    back = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(back["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == []
    assert AUDIO_KEY in again["dismissed"]
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_a_mode_that_was_never_split_is_never_rescued(seeded):
    """图片那条没被拆过：删了就删了，不能被同一段逻辑捞回来。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY][0]
    clone_templates.delete_template(target["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == []
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY] == []


def test_rescuing_leaves_the_other_dismissals_alone(seeded):
    """放行只动被拆过的那个 key，别的拉黑记录一个字都不许变。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    for key in (AUDIO_KEY, DESIGN_KEY):
        row = [r for r in clone_templates.list_templates() if r["bundled_key"] == key][0]
        clone_templates.delete_template(row["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == [AUDIO_KEY]
    assert clone_bundled.dismissed(conn) == {DESIGN_KEY}
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == DESIGN_KEY] == []
