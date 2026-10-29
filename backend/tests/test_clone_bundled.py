"""内置「一键同款」工作流：随包那两条（图片 / 视频）能不能正确长进库里。

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

def test_ships_one_image_and_one_video_workflow():
    """包里就是两条：Qwen 多图编辑（图片）与 H3 参考视频（视频）。"""
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    assert set(by_key) == {IMAGE_KEY, VIDEO_KEY}
    assert by_key[IMAGE_KEY]["media_kind"] == "image"
    assert by_key[IMAGE_KEY]["label"] == "闪寻图片编辑"
    assert by_key[VIDEO_KEY]["media_kind"] == "video"
    assert by_key[VIDEO_KEY]["label"] == "闪寻参考生视频"


def test_builtins_know_their_old_names():
    """老库里躺着的是导入时的文件名，历史名字要带在包里，否则更新时装成两条一样的。"""
    by_key = {e["key"]: e for e in clone_bundled.entries()}
    assert "Qwen 多图编辑" in by_key[IMAGE_KEY]["legacy_labels"]
    assert "H3参考视频" in by_key[VIDEO_KEY]["legacy_labels"]


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

def test_fresh_install_seeds_both_families(seeded):
    rows = clone_templates.list_templates()
    assert {r["name"] for r in rows} == {"闪寻图片编辑", "闪寻参考生视频"}
    assert all(r["is_builtin"] for r in rows)
    by_kind = {r["media_kind"]: r for r in rows}
    assert set(by_kind) == {"image", "video"}
    assert all(r["is_active"] for r in by_kind.values()), "图片卡与视频卡各有各的当前"


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
    assert sorted(again["skipped"]) == [VIDEO_KEY, IMAGE_KEY]
    assert len(clone_templates.list_templates()) == 2


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
    assert len(rows) == 2, "认领一条 + 装上图片那条"
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
    assert [r["bundled_key"] for r in clone_templates.list_templates()] == [VIDEO_KEY]
    again = clone_bundled.seed(conn)
    assert IMAGE_KEY in again["dismissed"]
    assert IMAGE_KEY in clone_bundled.dismissed(conn)
    assert [r["bundled_key"] for r in clone_templates.list_templates()] == [VIDEO_KEY]


def test_deleting_the_active_one_promotes_a_sibling(seeded):
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == VIDEO_KEY][0]
    clone_templates.delete_template(target["id"])
    rows = clone_templates.list_templates()
    assert [r["media_kind"] for r in rows] == ["image"]
    assert rows[0]["is_active"] is True


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
    assert {i["name"] for i in items} == {"闪寻图片编辑", "闪寻参考生视频"}
    assert all(i["is_builtin"] for i in items)
    assert {i["media_kind"] for i in items} == {"image", "video"}


def test_templates_imported_by_the_user_are_not_builtin(seeded):
    created = clone_templates.create_template("我自己导的", _fake_entry()["workflow"])
    assert created["is_builtin"] is False
