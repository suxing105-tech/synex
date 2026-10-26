"""「移动到…」必须真实移动磁盘文件（不只是改 DB 关系）。"""
from __future__ import annotations

import types
from pathlib import Path

from fastapi.testclient import TestClient

from app import folder_storage, repository
from app.config import inbox_dir
from app.db import get_pool, init_pool
from app.indexer import Indexer

from .conftest import make_png


def _index(path: Path) -> int:
    payload = Indexer()._process_path_sync(path)
    assert payload is not None
    return payload["id"]


def _db_path(image_id: int) -> str:
    return _row_path(image_id).replace("\\", "/")


def _row_path(image_id: int) -> str:
    return get_pool().main().execute(
        "SELECT path FROM images WHERE id=?", (image_id,)
    ).fetchone()["path"]


def _folders_of(image_id: int) -> set[tuple[str, bool]]:
    rows = get_pool().main().execute(
        "SELECT f.name, f.is_system FROM image_folders if_ "
        "JOIN folders f ON f.id = if_.folder_id WHERE if_.image_id = ?",
        (image_id,),
    ).fetchall()
    return {(r["name"], bool(r["is_system"])) for r in rows}


# ---------- 真实移动 ----------


def test_move_image_relocates_file_on_disk(tmp_data_dir):
    init_pool()
    source = make_png(tmp_data_dir / "art.png")
    image_id = _index(source)
    folder = folder_storage.create_folder("HOF", None)

    result = folder_storage.move_images([image_id], folder["id"])

    assert [item["id"] for item in result["moved"]] == [image_id]
    assert not source.exists()
    landed = Path(folder["path"]) / "art.png"
    assert landed.is_file()
    assert Path(_db_path(image_id)) == landed.resolve()
    assert _folders_of(image_id) == {("HOF", False)}


def test_move_preserves_id_and_tags(tmp_data_dir):
    init_pool()
    source = make_png(tmp_data_dir / "keep.png")
    image_id = _index(source)
    repository.set_tags(image_id, ["定妆", "冷色"])
    folder = folder_storage.create_folder("耕升", None)

    folder_storage.move_images([image_id], folder["id"])

    row = get_pool().main().execute("SELECT id FROM images WHERE id=?", (image_id,)).fetchone()
    assert row is not None
    assert sorted(repository.image_detail(image_id)["tags"]) == ["冷色", "定妆"]


def test_move_renames_instead_of_overwriting(tmp_data_dir):
    init_pool()
    dir_a = tmp_data_dir / "a"
    dir_b = tmp_data_dir / "b"
    dir_a.mkdir()
    dir_b.mkdir()
    id_a = _index(make_png(dir_a / "shot.png"))
    id_b = _index(make_png(dir_b / "shot.png"))
    folder = folder_storage.create_folder("影驰", None)

    result = folder_storage.move_images([id_a, id_b], folder["id"])

    assert sorted(p.name for p in Path(folder["path"]).iterdir()) == ["shot.png", "shot_1.png"]
    assert [item["renamed"] for item in result["moved"]] == [False, True]
    assert Path(_db_path(id_b)).name == "shot_1.png"
    assert not (dir_b / "shot.png").exists()


def test_move_between_user_folders(tmp_data_dir):
    init_pool()
    image_id = _index(make_png(tmp_data_dir / "walk.png"))
    a = folder_storage.create_folder("HOF_1", None)
    b = folder_storage.create_folder("影驰", None)

    folder_storage.move_images([image_id], a["id"])
    folder_storage.move_images([image_id], b["id"])

    assert (Path(b["path"]) / "walk.png").is_file()
    assert not (Path(a["path"]) / "walk.png").exists()
    assert _folders_of(image_id) == {("影驰", False)}


def test_moving_out_of_app_folder_returns_file_to_inbox(tmp_data_dir):
    init_pool()
    image_id = _index(make_png(tmp_data_dir / "draft.png"))
    folder = folder_storage.create_folder("草稿", None)
    folder_storage.move_images([image_id], folder["id"])

    result = folder_storage.move_images([image_id], None)

    assert [item["id"] for item in result["moved"]] == [image_id]
    assert (inbox_dir().resolve() / "draft.png").is_file()
    assert not (Path(folder["path"]) / "draft.png").exists()
    assert _folders_of(image_id) == set()


def test_moving_out_keeps_external_file_in_place(tmp_data_dir):
    """文件在用户自己的目录里：移出文件夹只解归类，不把文件从用户目录里拽走。"""
    init_pool()
    watch = tmp_data_dir / "watch" / "krea2"
    watch.mkdir(parents=True)
    source = make_png(watch / "mine.png")
    image_id = _index(source)
    folder = folder_storage.create_folder("灵感", None)
    folder_storage.move_images([image_id], folder["id"], move_files=False)

    result = folder_storage.move_images([image_id], None)

    assert result["moved"] == []
    assert result["kept"] == [image_id]
    assert source.is_file()
    assert _folders_of(image_id) == set()


def test_leaving_watch_dir_clears_system_folder(tmp_data_dir):
    """搬出监听目录后不该继续挂在「来源目录」树上。"""
    init_pool()
    watch = tmp_data_dir / "watch"
    (watch / "krea2").mkdir(parents=True)
    source = make_png(watch / "krea2" / "x.png")
    indexer = Indexer()
    indexer._watch_roots = [watch]
    image_id = indexer._process_path_sync(source)["id"]
    assert any(system for _, system in _folders_of(image_id))
    folder = folder_storage.create_folder("HOF", None)

    folder_storage.move_images([image_id], folder["id"])

    assert _folders_of(image_id) == {("HOF", False)}
    assert (Path(folder["path"]) / "x.png").is_file()


def test_moving_into_watch_dir_assigns_system_folder(tmp_data_dir, monkeypatch):
    """文件落进监听目录时补挂对应 system folder（这里让收件箱位于监听根下）。"""
    init_pool()
    data = tmp_data_dir
    image_id = _index(make_png(data / "go.png"))
    folder = folder_storage.create_folder("灵感", None)
    folder_storage.move_images([image_id], folder["id"])
    fake = types.SimpleNamespace(config=types.SimpleNamespace(watch_dirs=[str(data)]))
    monkeypatch.setattr("app.indexer.get_indexer", lambda: fake)

    result = folder_storage.move_images([image_id], None)

    assert [item["id"] for item in result["moved"]] == [image_id]
    assert (inbox_dir().resolve() / "go.png").is_file()
    assert ("灵感", False) not in _folders_of(image_id)
    assert ("inbox", True) in _folders_of(image_id)


def test_move_rejects_system_folder_target(tmp_data_dir):
    init_pool()
    conn = get_pool().main()
    cur = conn.execute(
        "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
        "VALUES(NULL, 'krea2', 0, 1, ?)", (str(tmp_data_dir),)
    )
    image_id = _index(make_png(tmp_data_dir / "x.png"))

    try:
        folder_storage.move_images([image_id], cur.lastrowid)
    except ValueError as error:
        assert "系统" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_missing_file_is_reported_and_membership_untouched(tmp_data_dir):
    init_pool()
    source = make_png(tmp_data_dir / "gone.png")
    image_id = _index(source)
    folder = folder_storage.create_folder("灵感", None)
    folder_storage.move_images([image_id], folder["id"], move_files=False)
    source.unlink()

    result = folder_storage.move_images([image_id], folder["id"])

    assert result["moved"] == [] and result["ids"] == []
    assert "原文件不存在" in result["failed"][0]["error"]
    assert _folders_of(image_id) == {("灵感", False)}


def test_single_failure_does_not_block_batch(tmp_data_dir):
    init_pool()
    good = _index(make_png(tmp_data_dir / "good.png"))
    bad = tmp_data_dir / "bad.png"
    make_png(bad)
    bad_id = _index(bad)
    bad.unlink()
    folder = folder_storage.create_folder("批量", None)

    result = folder_storage.move_images([bad_id, good], folder["id"])

    assert [item["id"] for item in result["moved"]] == [good]
    assert [item["id"] for item in result["failed"]] == [bad_id]
    assert (Path(folder["path"]) / "good.png").is_file()


def test_cross_volume_move_falls_back_to_copy(tmp_data_dir, monkeypatch):
    """跨磁盘（例如 F: 监听目录 → C: 图库目录）：复制后删源，不留 .moving 残留。"""
    init_pool()
    source = make_png(tmp_data_dir / "far.png")
    image_id = _index(source)
    folder = folder_storage.create_folder("HOF", None)
    real_rename = Path.rename
    state = {"first": True}

    def fake_rename(self, target):
        if state["first"]:
            state["first"] = False
            error = OSError("cross-device link")
            error.winerror = 17
            raise error
        return real_rename(self, target)

    monkeypatch.setattr(Path, "rename", fake_rename)

    result = folder_storage.move_images([image_id], folder["id"])

    assert [item["id"] for item in result["moved"]] == [image_id]
    assert (Path(folder["path"]) / "far.png").is_file()
    assert not source.exists()
    assert [p.name for p in Path(folder["path"]).iterdir()] == ["far.png"]


def test_locked_file_fails_only_itself(tmp_data_dir, monkeypatch):
    """文件被占用：中文原因，且不改索引、不搬文件。"""
    init_pool()
    source = make_png(tmp_data_dir / "busy.png")
    image_id = _index(source)
    folder = folder_storage.create_folder("HOF", None)

    def deny(self, target):
        raise PermissionError(13, "denied")

    monkeypatch.setattr(Path, "rename", deny)

    result = folder_storage.move_images([image_id], folder["id"])

    assert result["moved"] == []
    assert "占用" in result["failed"][0]["error"]
    assert source.is_file()
    assert _db_path(image_id) == folder_storage.repository._normalize_path(source.resolve())
    assert _folders_of(image_id) == set()


def test_rename_to_taken_name_then_move_into_same_folder(tmp_data_dir):
    init_pool()
    first = make_png(tmp_data_dir / "clash-a.png")
    second = make_png(tmp_data_dir / "clash-b.png")
    id_first = _index(first)
    id_second = _index(second)
    folder = folder_storage.create_folder("验收A", None)

    moved_first = folder_storage.move_images([id_first], folder["id"])
    assert moved_first["moved"][0]["renamed"] is False

    repository.rename_image(id_second, "clash-a.png")
    result = folder_storage.move_images([id_second], folder["id"])

    assert result["failed"] == [], result["failed"]
    assert result["moved"][0]["renamed"] is True
    assert sorted(p.name for p in Path(folder["path"]).iterdir()) == ["clash-a.png", "clash-a_1.png"]
    conn = get_pool().main()
    rows = conn.execute("SELECT id, path FROM images WHERE id IN (?, ?)", (id_first, id_second)).fetchall()
    assert len(rows) == 2, rows
    assert sorted(Path(r["path"]).name for r in rows) == ["clash-a.png", "clash-a_1.png"]
    assert (tmp_data_dir / "clash-b.png").exists() is False
    assert not (tmp_data_dir / "clash-a.png").exists()


# ---------- 文件监听抑制 ----------


def test_suppress_events_skips_only_listed_paths(tmp_data_dir):
    init_pool()
    indexer = Indexer()
    target = tmp_data_dir / "moved.png"
    other = tmp_data_dir / "other.png"

    indexer.suppress_events([target], seconds=5)
    indexer.enqueue("create", target)
    indexer.enqueue("delete", other)

    assert indexer._normalize(target) not in indexer._pending
    assert indexer._normalize(other) in indexer._pending


def test_suppression_expires(tmp_data_dir):
    init_pool()
    indexer = Indexer()
    path = tmp_data_dir / "later.png"
    indexer.suppress_events([path], seconds=0)

    indexer.enqueue("create", path)

    assert indexer._normalize(path) in indexer._pending


# ---------- API ----------


def test_api_bulk_move_actually_moves_files(tmp_data_dir):
    init_pool()
    from app.main import app

    ids = [_index(make_png(tmp_data_dir / f"img_{i}.png")) for i in range(2)]
    folder = folder_storage.create_folder("HOF", None)
    client = TestClient(app)

    response = client.post("/api/images/bulk-assign-folder",
                           json={"image_ids": ids, "folder_id": folder["id"]})

    assert response.status_code == 200
    body = response.json()
    assert sorted(body["ids"]) == sorted(ids)
    assert len(body["moved"]) == 2 and body["failed"] == []
    assert {p.name for p in Path(folder["path"]).iterdir()} == {"img_0.png", "img_1.png"}


def test_api_single_move_reports_moved_flag(tmp_data_dir):
    init_pool()
    from app.main import app

    image_id = _index(make_png(tmp_data_dir / "one.png"))
    folder = folder_storage.create_folder("HOF", None)
    client = TestClient(app)

    first = client.post(f"/api/images/{image_id}/folder", json={"folder_id": folder["id"]})
    again = client.post(f"/api/images/{image_id}/folder", json={"folder_id": folder["id"]})

    assert first.status_code == 200 and first.json()["moved"] is True
    assert first.json()["path"].endswith("one.png")
    assert again.status_code == 200 and again.json()["moved"] is False
    assert again.json()["kept"] is True


def test_api_single_move_missing_file_returns_400(tmp_data_dir):
    init_pool()
    from app.main import app

    source = make_png(tmp_data_dir / "ghost.png")
    image_id = _index(source)
    source.unlink()
    folder = folder_storage.create_folder("HOF", None)
    client = TestClient(app)

    response = client.post(f"/api/images/{image_id}/folder", json={"folder_id": folder["id"]})

    assert response.status_code == 400
    assert "原文件不存在" in response.json()["detail"]


def test_api_move_video_file(tmp_data_dir):
    init_pool()
    clip = tmp_data_dir / "clip.mp4"
    clip.write_bytes(b"ftypmp42placeholder")
    image_id = _index(clip)
    kind = get_pool().main().execute(
        "SELECT kind FROM images WHERE id=?", (image_id,)
    ).fetchone()["kind"]
    assert kind == "video"
    folder = folder_storage.create_folder("片段", None)

    folder_storage.move_images([image_id], folder["id"])

    assert (Path(folder["path"]) / "clip.mp4").is_file()
    assert not clip.exists()

