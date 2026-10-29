"""一键同款的来源记录：生成完之后，弹窗要能说出「这张图当初喂了哪几张参考图」。

这里只测来源本身（登记、认出参考图、认不出来时怎么办）；跑完整生成链路顺手登记
那一条在 test_clone_generate.py，因为那条需要一个假 ComfyUI。
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clone_sources
from app.db import get_pool, init_pool
from app.indexer import Indexer
from app.main import app

from .conftest import make_png


def index(tmp_path: Path, name: str) -> int:
    """把一张图收进图库，返回它的 id。"""
    payload = Indexer()._process_path_sync(make_png(tmp_path / name, width=6, height=6))
    assert payload
    return int(payload["id"])


def row_id(image_id: int) -> int:
    return int(image_id)


def test_lookup_without_history_is_empty(init_db, tmp_path: Path):
    """没生成过的图：空 references，前端据此退回老行为，不能报错。"""
    image_id = index(tmp_path, "a.png")
    assert clone_sources.lookup(image_id) == {
        "template_id": None, "source_image_id": None, "references": [], "dropped": 0, "origin": ""}


def test_record_then_lookup_keeps_order(init_db, tmp_path: Path):
    """两张参考图按参考位顺序读回来，弹窗才能把「图片1/图片2」摆回原位。"""
    first, second = index(tmp_path, "第一张.png"), index(tmp_path, "第二张.png")
    produced = index(tmp_path, "成图.png")
    written = clone_sources.record(
        image_ids=[produced], template_id=7, source_image_id=first,
        references=[{"slot": "543.image", "image_id": second},
                    {"slot": "564.image", "image_id": first}],
    )
    assert written == 1
    out = clone_sources.lookup(produced)
    assert [r["id"] for r in out["references"]] == [second, first]
    assert [r["filename"] for r in out["references"]] == ["第二张.png", "第一张.png"]
    assert out["dropped"] == 0 and out["template_id"] == 7 and out["source_image_id"] == first
    # 参考位键一起存着：以后要按槽位精确接线就不用再猜
    assert [r["slot"] for r in out["references"]] == ["543.image", "564.image"]
    # 口径和 feed 一致，前端拿到就能直接画缩略图
    assert out["references"][0]["thumbnail_url"] and out["references"][0]["kind"] == "image"


def test_every_output_of_one_batch_gets_the_same_references(init_db, tmp_path: Path):
    """一次出三张：每张都要能单独认出自己的来源，读的时候不必回溯是哪次任务。"""
    ref = index(tmp_path, "参考.png")
    batch = [index(tmp_path, f"成图{i}.png") for i in range(3)]
    assert clone_sources.record(
        image_ids=batch, template_id=1, source_image_id=None,
        references=[{"slot": "543.image", "image_id": ref}]) == 3
    for produced in batch:
        assert [r["id"] for r in clone_sources.lookup(produced)["references"]] == [ref]


def test_recording_the_same_output_again_overwrites(init_db, tmp_path: Path):
    """同一张成图被重新登记（重复认领）：留最后一次，别堆成两条。"""
    first, second = index(tmp_path, "甲.png"), index(tmp_path, "乙.png")
    produced = index(tmp_path, "成图.png")
    clone_sources.record(image_ids=[produced], template_id=1, source_image_id=None,
                         references=[{"slot": "543.image", "image_id": first}])
    clone_sources.record(image_ids=[produced], template_id=2, source_image_id=None,
                         references=[{"slot": "543.image", "image_id": second}])
    out = clone_sources.lookup(produced)
    assert [r["id"] for r in out["references"]] == [second]
    assert out["template_id"] == 2
    count = get_pool().main().execute(
        "SELECT COUNT(*) c FROM clone_sources WHERE image_id=?", (produced,)).fetchone()["c"]
    assert count == 1


def test_reference_that_vanished_is_counted_not_hidden(init_db, tmp_path: Path):
    """参考图被删出图库：如实报 dropped，让弹窗说「有一张已经不在了」，不能默默少一张。"""
    ref = index(tmp_path, "会被删的.png")
    keep = index(tmp_path, "还在的.png")
    produced = index(tmp_path, "成图.png")
    clone_sources.record(image_ids=[produced], template_id=1, source_image_id=None,
                         references=[{"slot": "543.image", "image_id": ref},
                                     {"slot": "564.image", "image_id": keep}])
    get_pool().main().execute("DELETE FROM images WHERE id=?", (ref,)).connection.commit()
    out = clone_sources.lookup(produced)
    assert [r["id"] for r in out["references"]] == [keep]
    assert out["dropped"] == 1


def test_references_survive_a_rescan_that_renumbers_ids(init_db, tmp_path: Path):
    """整库重扫后 id 全变：靠 path 仍然认出同一批文件，且顺序不变。"""
    first, second = index(tmp_path, "甲.png"), index(tmp_path, "乙.png")
    produced = index(tmp_path, "成图.png")
    clone_sources.record(image_ids=[produced], template_id=1, source_image_id=None,
                         references=[{"slot": "543.image", "image_id": first},
                                     {"slot": "564.image", "image_id": second}])
    conn = get_pool().main()
    # 模拟换数据目录重扫：文件没变，但整个库重排了 id
    conn.execute("UPDATE images SET id = id + 1000")
    conn.commit()
    out = clone_sources.lookup(produced)
    assert out["dropped"] == 0
    assert [r["filename"] for r in out["references"]] == ["甲.png", "乙.png"]
    assert all(r["id"] > 1000 for r in out["references"])


def test_stale_id_pointing_at_another_file_is_refused(init_db, tmp_path: Path):
    """文件被移走、而 id 恰好指向另一张图：宁可不显示，也不能把别的图说成当初的参考图。"""
    ref = index(tmp_path, "原参考.png")
    produced = index(tmp_path, "成图.png")
    clone_sources.record(image_ids=[produced], template_id=1, source_image_id=None,
                         references=[{"slot": "543.image", "image_id": ref}])
    # 原文件改名（path 认不出）+ 那个 id 现在指向另一张文件名不同的图
    conn = get_pool().main()
    conn.execute("UPDATE images SET filename='完全另一张.png', path=? WHERE id=?",
                 (str(tmp_path / "完全另一张.png"), ref))
    conn.commit()
    out = clone_sources.lookup(produced)
    assert out["references"] == [] and out["dropped"] == 1


def test_reference_row_already_gone_is_not_recorded(init_db, tmp_path: Path):
    """登记时参考图就不在库里（并发删图）：跳过它；一条有效参考都没有就不写记录。"""
    produced = index(tmp_path, "成图.png")
    assert clone_sources.record(
        image_ids=[produced], template_id=1, source_image_id=None,
        references=[{"slot": "543.image", "image_id": 99999}]) == 0
    assert clone_sources.lookup(produced)["references"] == []


def test_endpoint_reports_the_references(tmp_path: Path, monkeypatch):
    """GET /api/clone/sources/{id}：弹窗开一次就靠它摆参考位。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()
    ref = index(tmp_path, "接口参考.png")
    produced = index(tmp_path, "接口成图.png")
    clone_sources.record(image_ids=[produced], template_id=3, source_image_id=ref,
                         references=[{"slot": "543.image", "image_id": ref}])
    with TestClient(app) as client:
        hit = client.get(f"/api/clone/sources/{produced}")
        miss = client.get("/api/clone/sources/4242")
    assert hit.status_code == 200
    body = hit.json()
    assert [r["filename"] for r in body["references"]] == ["接口参考.png"]
    assert body["dropped"] == 0 and body["template_id"] == 3 and body["origin"] == "db"
    assert miss.status_code == 200 and miss.json()["references"] == []

# ---------- 成图自己报出参考图：库里没记上时的第二条路 ----------


def ref_name(image_id: int) -> str:
    """按上传规则给这张图起个 ComfyUI 里的名字：seekx_ref_<id>_<内容sha1前8位>。"""
    path = get_pool().main().execute("SELECT path FROM images WHERE id=?", (image_id,)).fetchone()["path"]
    digest = hashlib.sha1(Path(path).read_bytes()).hexdigest()[:8]
    return f"seekx_ref_{image_id}_{digest}.png"


def encode_prompt(*, base: str, extra: dict[int, str] | None = None) -> dict:
    """照真机的形状拼一个 API 格式 prompt：LoadImage 543 接进 582.images.image_1，
    多喂的参考图各占一个临时 LoadImage 节点，接到 images.image_2、image_3…。"""
    nodes: dict[str, Any] = {
        "543": {"class_type": "LoadImage", "inputs": {"image": base}},
        "582": {"class_type": "TextEncodeQwenImage21",
                "inputs": {"prompt": "@图片1 的猫戴上@图片2 的帽子", "images.image_1": ["543", 0]}},
    }
    for offset, name in (extra or {}).items():
        node = str(600 + offset)  # 别撞上 582 那个文本节点
        nodes[node] = {"class_type": "LoadImage", "inputs": {"image": name}}
        nodes["582"]["inputs"][f"images.image_{offset + 1}"] = [node, 0]
    return nodes


def test_references_are_recovered_from_the_finished_image(init_db, tmp_path: Path):
    """库里没记来源，但成图带着 workflow：两张参考图照样认得回来，顺序＝参考位顺序。

    这条是「我明明喂了两张，重开却只有一张」的根治。写库那条路只在本机这次生成成功才有，
    旧图、旧包跑的、换机器导入的都没有；成图里的上传名才是跟着图走的证据。
    """
    first, second = index(tmp_path, "猫.png"), index(tmp_path, "帽子.png")
    produced = int(Indexer()._process_path_sync(make_png(
        tmp_path / "成图.png", width=9, height=9,
        prompt=encode_prompt(base=ref_name(first), extra={1: ref_name(second)})))["id"])
    out = clone_sources.lookup(produced)
    assert [r["filename"] for r in out["references"]] == ["猫.png", "帽子.png"]
    assert out["dropped"] == 0 and out["origin"] == "file"
    assert out["references"][0]["thumbnail_url"]  # 口径和 feed 一致，前端拿来就能画


def test_recovered_references_are_ordered_by_wiring_not_node_id(init_db, tmp_path: Path):
    """三张参考图：按「接到第几个输入」排，不按节点号，也不按 JSON 里谁先出现。

    长出来的 LoadImage 节点号是每次生成现取的，谁大谁小没有意义；`images.image_2`
    才是「它当初站在图片2」的证据。
    """
    a, b, c = (index(tmp_path, f"参考{i}.png") for i in ("A", "B", "C"))
    nodes = encode_prompt(base=ref_name(a), extra={1: ref_name(b), 2: ref_name(c)})
    shuffled = {"582": nodes["582"], "602": nodes["602"], "601": nodes["601"], "543": nodes["543"]}
    produced = int(Indexer()._process_path_sync(
        make_png(tmp_path / "三图成图.png", width=10, height=10, prompt=shuffled))["id"])
    out = clone_sources.lookup(produced)
    assert [r["filename"] for r in out["references"]] == ["参考A.png", "参考B.png", "参考C.png"]
    # 反推的槽位键不往前端塞：多图工作流里它可能猜错，顺序够用
    assert all("slot" not in ref for ref in out["references"])


def test_a_changed_reference_file_is_not_claimed_as_one(init_db, tmp_path: Path):
    """id 还在、文件内容却变了（重扫后 id 指到别的图）：hash 对不上就不认，宁可少一张。

    没有这道校验，「当初的参考图」会变成随机一张，比不显示更糟——用户看不出那是假的。
    """
    ref = index(tmp_path, "原参考.png")
    name = ref_name(ref)
    produced = int(Indexer()._process_path_sync(make_png(
        tmp_path / "成图.png", width=11, height=11, prompt=encode_prompt(base=name)))["id"])
    assert [r["id"] for r in clone_sources.lookup(produced)["references"]] == [ref]
    Path(get_pool().main().execute("SELECT path p FROM images WHERE id=?", (ref,)).fetchone()["p"]).write_bytes(b"totally different bytes now")
    out = clone_sources.lookup(produced)
    assert out["references"] == [] and out["dropped"] == 1 and out["origin"] == "unrecorded"


def test_the_workflows_own_picture_is_not_a_reference(init_db, tmp_path: Path):
    """工作流里原本就有的图（底图、示例图）不算参考图：只认 seekx_ref_ 这个上传名。"""
    produced = int(Indexer()._process_path_sync(make_png(
        tmp_path / "成图.png", width=12, height=12,
        prompt=encode_prompt(base="用户的底图.png")))["id"])
    out = clone_sources.lookup(produced)
    assert out["references"] == [] and out["dropped"] == 0 and out["origin"] == "unrecorded"


def test_an_imported_photo_stays_silent(init_db, tmp_path: Path):
    """没带 workflow 的普通图片：origin 空字符串，弹窗不该冒出一句「当初没记下参考图」。"""
    photo = index(tmp_path, "导入的照片.png")
    out = clone_sources.lookup(photo)
    assert out == {"template_id": None, "source_image_id": None,
                   "references": [], "dropped": 0, "origin": ""}


def test_the_recorded_row_wins_over_the_workflow(init_db, tmp_path: Path):
    """生成当时记下的那份优先：它还知道用的哪条工作流、当初点的是哪张图。"""
    recorded, stale = index(tmp_path, "记下的.png"), index(tmp_path, "旧名里的.png")
    produced = int(Indexer()._process_path_sync(make_png(
        tmp_path / "成图.png", width=13, height=13,
        prompt=encode_prompt(base=ref_name(stale))))["id"])
    clone_sources.record(image_ids=[produced], template_id=5, source_image_id=stale,
                         references=[{"slot": "543.image", "image_id": recorded}])
    out = clone_sources.lookup(produced)
    assert [r["filename"] for r in out["references"]] == ["记下的.png"]
    assert out["origin"] == "db" and out["template_id"] == 5


def test_a_row_that_resolves_to_nothing_is_not_the_end(init_db, tmp_path: Path):
    """库里有行却一张都对不上（path 断了、id 又指错）：再给成图一次机会，别直接空着。"""
    gone = index(tmp_path, "会被移走的.png")
    ok = index(tmp_path, "成图里的参考.png")
    produced = int(Indexer()._process_path_sync(make_png(
        tmp_path / "成图.png", width=14, height=14,
        prompt=encode_prompt(base=ref_name(ok))))["id"])
    clone_sources.record(image_ids=[produced], template_id=1, source_image_id=None,
                         references=[{"slot": "543.image", "image_id": gone}])
    conn = get_pool().main()
    conn.execute("UPDATE images SET path=?, filename=? WHERE id=?",
                 (str(tmp_path / "换位置了.png"), "换位置了.png", gone))
    conn.commit()
    out = clone_sources.lookup(produced)
    assert [r["filename"] for r in out["references"]] == ["成图里的参考.png"]
    assert out["origin"] == "file"
