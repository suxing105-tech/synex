"""内置「再次创作」工作流：随包这五条（图片一条、视频一条、声音三种出声方式）能不能正确长进库里。

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
MASK_KEY = "qwen-single-mask-edit"
MASK_LABEL = "闪寻局部编辑"
VIDEO_KEY = "h3-reference-video"
AUDIO_KEY = "qwen3-tts-voice-clone"
DESIGN_KEY = "qwen3-tts-voice-design"
CUSTOM_KEY = "qwen3-tts-custom-voice"
ALL_KEYS = [IMAGE_KEY, MASK_KEY, VIDEO_KEY, AUDIO_KEY, DESIGN_KEY, CUSTOM_KEY]
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
    assert by_key[IMAGE_KEY]["label"] == "闪寻图片"
    # 图片族第二条：带遮罩的局部重绘／移除。它不是新的「当前」，见
    # test_the_mask_template_is_seeded_but_not_the_default
    assert by_key[MASK_KEY]["media_kind"] == "image"
    assert by_key[MASK_KEY]["label"] == MASK_LABEL
    assert by_key[VIDEO_KEY]["media_kind"] == "video"
    assert by_key[VIDEO_KEY]["label"] == "闪寻视频"
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
    # 0.2.34 之后叫「闪寻局部编辑」：旧名留在包里，老库那条下次启动顺势改口，记录不换
    assert "闪寻遮罩编辑" in by_key[MASK_KEY]["legacy_labels"]


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


def test_shipped_slots_can_report_the_real_output_size():
    """带比例/百万像素旋钮的内置模板必须说得出对齐步长：弹窗靠它报「这一趟会出多大」。

    缺这个键前端就退回 8（ComfyUI 那台节点自己的默认值），而包里视频那条正文写的是 32，
    报出来差几十像素。顺带钉住「两条内置模板的步长本来就不一样」：所以那个兜底值不许
    照着其中一条改成 32，那样只是把报错挪到另一条上。
    """
    declared = {}
    for entry in clone_bundled.entries():
        nodes, slots = clone_bundled._prepare(entry)
        for slot in slots:
            if slot.get("input") != "megapixels":
                continue
            want = clone_templates.node_pixel_multiple(nodes[str(slot["node"])])
            assert want is not None, (entry["key"], "正文里没写对齐步长")
            assert slot.get("multiple") == want, (entry["key"], slot)
            declared[entry["key"]] = want
    assert declared[VIDEO_KEY] == 32 and declared[IMAGE_KEY] == 8


# ---------- 装进库 ----------

def test_fresh_install_seeds_every_family(seeded):
    rows = clone_templates.list_templates()
    assert {r["name"] for r in rows} == {"闪寻图片", MASK_LABEL, "闪寻视频"} | AUDIO_LABELS
    assert all(r["is_builtin"] for r in rows)
    assert {r["media_kind"] for r in rows} == {"image", "video", "audio"}
    # 每族各自一个「当前」：声音三条也只能有一条是当前，弹窗开出来才有唯一默认
    for kind in ("image", "video", "audio"):
        family = [r for r in rows if r["media_kind"] == kind]
        assert sum(1 for r in family if r["is_active"]) == 1, kind
    assert sum(1 for r in rows if r["media_kind"] == "audio") == 3


def test_the_mask_template_is_seeded_but_not_the_default(seeded):
    """多一条图片工作流可以，但默认那条不能换：老用户点开「再次创作」认的是闪寻图片。"""
    rows = {r["name"]: r for r in clone_templates.list_templates()}
    image = [r for r in rows.values() if r["media_kind"] == "image"]
    assert len(image) == 2
    assert [r["name"] for r in image if r["is_active"]] == ["闪寻图片"]
    mask = rows[MASK_LABEL]
    assert [c["key"] for c in mask["reference_cells"]] == ["193.image"]
    assert [c["kind"] for c in mask["reference_cells"]] == ["image"]


def test_the_mask_template_ships_the_slot_contracts(seeded):
    """随包那条局部编辑模板的槽位约定：能画遮罩、空提示词算一个模式、旋钮管两条分支。

    这几条都是「少一条就出错片」的：遮罩标记没了就没有笔刷；allow_empty 没了
    空提示词会被后端按「必须填提示词」顶回来；307 的标签不是「完整提示词」
    就进不了主框；sync_to 没了，走移除分支时扩张／羽化退回工作流自带的 4／5。

    「移除指令」不再是一条槽位：它写死在工作流节点里。摆在弹窗里就是一格没人会去动、
    动错一个字移除当场失灵的输入框（苏醒 2026-11-12：那块展示很多余）。
    """
    entry = [e for e in clone_bundled.entries() if e["key"] == MASK_KEY][0]
    nodes, slots = clone_bundled._prepare(entry)
    by_key = {clone_templates.slot_key(s): s for s in slots}
    assert by_key["307.value"]["label"] == clone_templates.PRIMARY_PROMPT_LABEL
    assert by_key["307.value"]["allow_empty"] is True
    # 「留空＝移除」这句由前端固定说（两个模式共用一条文案），槽位上不再带 empty_hint
    assert "empty_hint" not in by_key["307.value"]
    assert [s for s in slots if s.get("kind") == "prompt"] == [by_key["307.value"]], \
        "弹窗里只该有主框那一条提示词，移除指令不在界面上露脸"
    assert by_key["193.image"]["mask"] == "alpha"
    for key in ("212.遮罩扩展百分比", "212.遮罩羽化百分比"):
        assert by_key[key]["sync_to"] == [["252", key.split(".", 1)[1]]], key
    # 纯预览的两台不在图里：ComfyUI 会执行所有输出节点，比对图那次白等
    assert "281" not in nodes and "289" not in nodes
    assert nodes["38"]["inputs"]["filename_prefix"] == "SeekX_MaskEdit"
    # 到 SaveImage 之外没有第二个输出节点
    outs = [nid for nid, node in nodes.items()
            if str(node.get("class_type", "")).lower().startswith(("save", "preview"))]
    assert outs == ["38"]


def test_the_removal_line_names_the_color_it_actually_paints():
    """移除那句文字说的颜色，必须就是盖给模型看的那层的颜色。

    移除分支没有 MASK 直接进模型：204 把 205 那张纯色图按 40% 盖在遮罩区域上，
    再叫模型「移除图像中的X色区域」。两处对不上，模型就找不到该移除的地方；
    万物移除那颗 LoRA 也是照这个配色训的。所以哪天要换颜色，205 的颜色与 118 的
    那句话得一起改——编辑器里画给人看的那层是红的，跟这条染色是两回事，别去动它。
    """
    entry = [e for e in clone_bundled.entries() if e["key"] == MASK_KEY][0]
    workflow = entry["workflow"]
    assert workflow["205"]["class_type"] == "LayerUtility: ColorImage"
    tint = str(workflow["205"]["inputs"]["color"]).lower()
    line = str(workflow["118"]["inputs"]["prompt"])
    assert tint == "#00ff00"
    assert "绿色" in line and "红色" not in line, "染色与指令必须同色"
    assert workflow["204"]["inputs"]["覆盖图"] == ["205", 0], "那层染色确实盖在遮罩区域上"
    assert 0 < float(workflow["204"]["inputs"]["透明度"]) < 1, "半透明才既看得见原图又认得出范围"


def test_a_slot_only_update_still_reaches_an_untouched_builtin(seeded):
    """只改槽位、正文一字没动的那一版更新也必须刷进去。

    bundled_sha 只按 workflow 算，所以「撤掉一条多余槽位」这种改动光比 sha 会被当成
    没变：老库里那条会永远留着「移除指令」那格，界面上撤不掉。正文没被用户改过时
    再比一次槽位；用户自己改过正文的照旧不覆盖（见 test_user_edited_builtin_is_not_overwritten）。
    """
    conn = seeded.main()
    row = _row_of_key(seeded, MASK_KEY)
    stale = [*json.loads(row["slots"]),
             {"kind": "prompt", "node": "118", "input": "prompt",
              "label": "移除指令", "value": "移除图像中的绿色区域"}]
    conn.execute("UPDATE clone_templates SET slots=? WHERE id=?",
                 (json.dumps(stale, ensure_ascii=False), int(row["id"])))
    assert clone_bundled.seed(conn)["updated"] == [MASK_KEY]
    after = json.loads(_row_of_key(seeded, MASK_KEY)["slots"])
    assert [s for s in after if s.get("kind") == "prompt"] == [
        s for s in after if clone_templates.slot_key(s) == "307.value"]
    assert clone_bundled.seed(conn)["updated"] == [], "刷完就稳了，别每次启动都重写一遍"


def test_the_mask_template_is_the_only_one_with_a_brush(seeded):
    """别的工作流不该被顺手加上遮罩入口：目前随包的只有这一条认遮罩。"""
    for row in clone_templates.list_templates():
        tagged = [s for s in row["slots"] if s.get("mask") == "alpha"]
        assert [s.get("label") for s in tagged] == (
            ["图片1"] if row["name"] == MASK_LABEL else []), row["name"]


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
    assert adopted["name"] == "闪寻视频"
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
    assert again["name"] == "闪寻视频" and int(again["id"]) == int(row["id"])


def test_the_names_shipped_last_version_get_renamed(seeded):
    """上一版安装包叫「闪寻图片编辑」「闪寻参考生视频」：升级后跟着改口。

    改名只动 label，旧名留在 legacy_labels 里，seed 才认得出这条就是它自己；
    记录不换、素材不重导、哪条是「当前」也不跟着抖。
    """
    conn = seeded.main()
    before = {key: _row_of_key(seeded, key) for key in (IMAGE_KEY, VIDEO_KEY)}
    conn.execute("UPDATE clone_templates SET name=? WHERE id=?",
                 ("闪寻图片编辑", int(before[IMAGE_KEY]["id"])))
    conn.execute("UPDATE clone_templates SET name=? WHERE id=?",
                 ("闪寻参考生视频", int(before[VIDEO_KEY]["id"])))
    result = clone_bundled.seed(conn)
    assert sorted(result["renamed"]) == sorted([IMAGE_KEY, VIDEO_KEY])
    for key, label in ((IMAGE_KEY, "闪寻图片"), (VIDEO_KEY, "闪寻视频")):
        after = _row_of_key(seeded, key)
        assert after["name"] == label
        assert int(after["id"]) == int(before[key]["id"]), "改名不该换一条记录"
        assert int(after["is_active"]) == int(before[key]["is_active"]), "改名不该动「当前」"


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
    # 图片族有两条（闪寻图片 + 闪寻局部编辑），删掉的正好是「当前」那条：顶上来的只能有一条
    image = [r for r in rows if r["media_kind"] == "image"]
    assert [r["name"] for r in image if r["is_active"]] == ["闪寻图片"], "图片族的当前不能跟着删视频那条一起变动"
    audio = [r for r in rows if r["media_kind"] == "audio"]
    assert sum(1 for r in audio if r["is_active"]) == 1, "声音三条里仍只有一条是当前"
    assert len(audio) == 3, "删掉视频不会牵连声音那三条"


# ---------- 老库里存着的槽位缺「对齐步长」 ----------


def _strip_multiples(pool, row_id: int, slots: list[dict]) -> None:
    """把库里的槽位退回「这个键还没加」时存的那版。"""
    stale = [{k: v for k, v in s.items() if k != "multiple"} for s in slots]
    pool.main().execute("UPDATE clone_templates SET slots=? WHERE id=?",
                        (json.dumps(stale, ensure_ascii=False), row_id))
    return stale


def _megapixels_slots(pool, key: str) -> list[dict]:
    return [s for s in json.loads(_row_of_key(pool, key)["slots"]) if s.get("input") == "megapixels"]


def test_a_stale_slot_gets_its_multiple_back_even_when_seed_skips_it(seeded):
    """老库里的槽位没有对齐步长 → 弹窗退回 8：视频那条实际出 1440×800，报出来是 1432×808。

    偏偏它就是用户动过正文的那条内置模板——seed 认成「用户改过」整条跳过，随版本刷新
    到不了它，所以启动时那趟 migrate_slot_multiples 得自己把它照正文补回来。
    """
    conn = seeded.main()
    row = _row_of_key(seeded, VIDEO_KEY)
    stale = _strip_multiples(seeded, int(row["id"]), json.loads(row["slots"]))
    assert _megapixels_slots(seeded, VIDEO_KEY)[0].get("multiple") is None
    conn.execute("UPDATE clone_templates SET bundled_sha='他改过正文' WHERE id=?", (int(row["id"]),))
    assert VIDEO_KEY not in clone_bundled.seed(conn)["updated"], "seed 本来就不该碰它"

    assert clone_templates.migrate_slot_multiples(conn) == 1
    assert [s.get("multiple") for s in _megapixels_slots(seeded, VIDEO_KEY)] == [32]
    assert clone_templates.migrate_slot_multiples(conn) == 0, "补完就稳，别每次启动都重写一遍"
    # 只许动这一个键：其余槽位（连同一格的其他字段）都得原样
    after = [{k: v for k, v in s.items() if k != "multiple"}
             for s in json.loads(_row_of_key(seeded, VIDEO_KEY)["slots"])]
    assert after == stale


def test_a_workflow_without_the_input_gets_no_invented_multiple(seeded):
    """正文里没有对齐步长就不补：猜一个只会把尺寸报错，宁缺毋滥（前端退回 8）。"""
    row = _row_of_key(seeded, IMAGE_KEY)
    nodes = json.loads(row["workflow"])
    nodes[str(_megapixels_slots(seeded, IMAGE_KEY)[0]["node"])]["inputs"].pop("multiple", None)
    stale = _strip_multiples(seeded, int(row["id"]), json.loads(row["slots"]))
    seeded.main().execute("UPDATE clone_templates SET workflow=? WHERE id=?",
                          (json.dumps(nodes, ensure_ascii=False), int(row["id"])))
    assert clone_templates.migrate_slot_multiples(seeded.main()) == 0
    assert "multiple" not in _megapixels_slots(seeded, IMAGE_KEY)[0]
    assert [{k: v for k, v in s.items() if k != "multiple"}
            for s in json.loads(_row_of_key(seeded, IMAGE_KEY)["slots"])] == stale


def test_migrating_leaves_templates_without_a_resolution_knob_alone(seeded):
    """音色那几条压根没有比例/分辨率旋钮，一趟下来不该被写一个字。"""
    before = {str(r["id"]): str(r["slots"]) for r in seeded.main()
              .execute("SELECT id, slots FROM clone_templates").fetchall()}
    assert clone_templates.migrate_slot_multiples(seeded.main()) == 0
    after = {str(r["id"]): str(r["slots"]) for r in seeded.main()
             .execute("SELECT id, slots FROM clone_templates").fetchall()}
    assert after == before


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
    assert {i["name"] for i in items} == {"闪寻图片", MASK_LABEL, "闪寻视频"} | AUDIO_LABELS
    assert all(i["is_builtin"] for i in items)
    assert {i["media_kind"] for i in items} == {"image", "video", "audio"}


def test_a_builtin_refuses_redetect(seeded, monkeypatch):
    """随包那几条不给「重新检测槽位」：它们的槽位是调好才进包的，冲掉就退化成不能用。

    遮罩那条最典型——空提示词是「移除」这个模式、哪一格能画遮罩、扩张羽化一颗旋钮管
    两条分支，这些检测都认不出来，一次点击就能把它变成一条普通的局部重绘。
    """
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        rows = client.get("/api/clone/templates").json()["items"]
        mask = [r for r in rows if r["name"] == MASK_LABEL][0]
        res = client.post(f"/api/clone/templates/{mask['id']}/redetect")
        assert res.status_code == 409
        assert "导入一份属于自己" in res.json()["detail"]
        # 没动库：槽位还是随包那一套（五个槽位、图片1 能画遮罩）
        after = client.get("/api/clone/templates").json()["items"]
        row = [r for r in after if r["name"] == MASK_LABEL][0]
        assert len(row["slots"]) == 5
        assert row["control_count"] == 3
        assert [s.get("mask") for s in row["slots"] if s.get("kind") == "image"] == ["alpha"]



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


# ---------- 已隐藏的内置工作流：看得见，也能反悔 ----------

def test_a_deleted_builtin_shows_up_as_hidden(seeded):
    """删掉的内置工作流必须出现在隐藏列表里。以前它只躺在 meta 里，谁都不知道。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    with TestClient(app) as client:
        items = client.get("/api/clone/templates/hidden").json()["items"]
    assert [i["key"] for i in items] == [AUDIO_KEY]
    assert items[0]["name"] == "闪寻参考音色" and items[0]["media_kind"] == "audio"


def test_the_hidden_list_is_empty_when_nothing_was_deleted(seeded):
    with TestClient(app) as client:
        assert client.get("/api/clone/templates/hidden").json()["items"] == []


def test_restore_brings_the_builtin_back_through_the_api(seeded):
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 200, res.text
        assert res.json()["name"] == "闪寻参考音色"
        items = client.get("/api/clone/templates").json()["items"]
        assert client.get("/api/clone/templates/hidden").json()["items"] == []
    assert {i["bundled_key"] for i in items} == set(ALL_KEYS)
    assert clone_bundled.dismissed(seeded.main()) == set(), "恢复要把名字从名单里摘干净"


def test_a_restored_mode_does_not_steal_the_current_one(seeded):
    """恢复回来的那条不许抢「当前」：同族已经有正在用的了，不然用户的默认被换掉。"""
    rows = {r["bundled_key"]: r for r in clone_templates.list_templates()}
    clone_templates.delete_template(rows[AUDIO_KEY]["id"])
    before = [r for r in clone_templates.list_templates()
              if r["media_kind"] == "audio" and r["is_active"]][0]["bundled_key"]
    clone_bundled.restore(AUDIO_KEY)
    audio = [r for r in clone_templates.list_templates() if r["media_kind"] == "audio"]
    assert len(audio) == 3
    assert [r["bundled_key"] for r in audio if r["is_active"]] == [before]


def test_restoring_something_never_hidden_is_404(seeded):
    with TestClient(app) as client:
        assert client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore").status_code == 404


def test_restore_is_409_when_another_template_holds_the_name(seeded):
    """名字被**别一条**工作流占着（模板名有唯一索引）时装不进来：回 409 并说清下一步。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    other = [r for r in clone_templates.list_templates() if r["bundled_key"] == VIDEO_KEY][0]
    clone_templates.update_template(other["id"], {"name": "闪寻参考音色"})
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 409, res.text
        assert "改个名" in res.json()["detail"]
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_restore_adopts_a_same_name_template_the_user_imported(seeded):
    """用户自己导过一份同名的 → 恢复走装载那条老路：认领这一条，不造重名的。

    内容是用户那份，bundled_sha 记的是随包指纹，两者不等就等于「他改过」，
    以后版本更新不会覆盖他。这条不是新规矩，和首次装载同一套。
    """
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    mine = clone_templates.create_template("闪寻参考音色", _fake_entry(label="闪寻参考音色")["workflow"])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 200, res.text
    after = [r for r in clone_templates.list_templates() if int(r["id"]) == int(mine["id"])][0]
    assert after["bundled_key"] == AUDIO_KEY and after["is_builtin"] is True
    raw = clone_templates.get_template(int(mine["id"]))
    assert clone_bundled.workflow_sha(raw["workflow"]) != raw["bundled_sha"], "内容仍是用户那份"
    assert clone_bundled.dismissed(seeded.main()) == set()


def test_restore_clears_a_key_the_package_no_longer_ships(seeded, monkeypatch):
    """新版本不再随包这条：409 说清楚，同时把死名字从名单里清掉，别让它永远占着。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    monkeypatch.setattr(clone_bundled, "entries", lambda *a, **k: [])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 409, res.text
    assert clone_bundled.dismissed(seeded.main()) == set()
