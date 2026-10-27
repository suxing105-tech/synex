"""归档（archive）：在图库里收起来，磁盘一律不动。

归档要解决的正是「删除文件夹」太狠这件事：来源目录是外部程序正在写的目录，
右键里不该出现「把真实目录送进回收站」这种选项。四条契约：
1. 归档后侧栏没有这个节点（连子树一起），统一流与总数也不再包含它的素材；
2. 磁盘上的目录和文件一个都不动；
3. 只归档子目录时只藏那一支，父级计数同步变小；
4. 恢复不需要重新扫描磁盘 —— 素材从来没被删掉，标签也还在。
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import folder_storage, repository, texts
from app.db import get_pool, init_pool
from app.indexer import Indexer
from app.main import app

from .conftest import make_png


def _key(path) -> str:
    return repository._folder_key(str(path))


def _flat(tree):
    out = {}

    def walk(nodes, parent):
        for node in nodes:
            key = _key(node["path"] or "")
            out[key] = (parent, node["name"], node["total"])
            walk(node["children"], key)

    walk(tree, None)
    return out


def _folder_id(path) -> int:
    row = get_pool().main().execute(
        "SELECT id FROM folders WHERE lower(replace(path, char(92), '/')) = lower(?)",
        (_key(path),),
    ).fetchone()
    assert row is not None, f"没有该目录节点：{path}"
    return row["id"]


def _image_id(filename: str) -> int:
    row = get_pool().main().execute(
        "SELECT id FROM images WHERE filename = ?", (filename,)
    ).fetchone()
    assert row is not None, f"没索引到该图片：{filename}"
    return row["id"]


def _scan(tmp_data_dir, name: str = "output"):
    """建一个 output/krea2 两层来源目录并扫描，返回根路径。"""
    init_pool()
    root = tmp_data_dir / name
    (root / "krea2").mkdir(parents=True)
    make_png(root / "cover.png")
    make_png(root / "krea2" / "a.png")
    indexer = Indexer()
    indexer.update_config(watch_dirs=[str(root)])
    indexer.scan(root)
    indexer.shutdown()
    return root


def test_archive_hides_folder_and_items_but_leaves_the_disk_alone(init_db, tmp_data_dir):
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    assert client.get("/api/items").json()["counts"]["image"] == 2

    body = client.post(f"/api/folders/{_folder_id(root)}/archive").json()
    assert body["archived"] is True and body["hidden_media"] == 2

    # 磁盘：目录与文件都还在原地
    assert (root / "cover.png").is_file() and (root / "krea2" / "a.png").is_file()
    # 侧栏：整棵子树消失
    assert _flat(repository.folder_tree()) == {}
    # 统一流与总数：不再包含它
    assert client.get("/api/items").json()["counts"]["image"] == 0
    stats = client.get("/api/stats").json()
    assert stats["total_images"] == 0 and stats["folders"] == 0
    # 归档清单里有它，并说清藏了多少
    entries = client.get("/api/folders", params={"archived": True}).json()
    assert [e["name"] for e in entries] == ["output"] and entries[0]["media"] == 2

    # 恢复：不用重新扫描，素材直接回来
    assert client.post(f"/api/folders/{_folder_id(root)}/restore").json()["archived"] is False
    assert client.get("/api/items").json()["counts"]["image"] == 2
    assert len(_flat(repository.folder_tree())) == 2
    assert client.get("/api/folders", params={"archived": True}).json() == []


def test_archiving_a_subfolder_only_hides_that_branch(init_db, tmp_data_dir):
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    client.post(f"/api/folders/{_folder_id(root / 'krea2')}/archive")

    nodes = _flat(repository.folder_tree())
    assert list(nodes) == [_key(root)]
    assert nodes[_key(root)][1] == "output"
    assert nodes[_key(root)][2] == 1          # 计数只剩根上那张
    assert client.get("/api/items").json()["counts"]["image"] == 1
    # 直接点名要归档目录里的素材，也是空的
    assert client.get("/api/items", params={"folder_id": _folder_id(root / "krea2")}).json()["total"] == 0


def test_item_also_inside_a_live_folder_stays_visible(init_db, tmp_data_dir):
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    saved_into = folder_storage.create_folder("我的收藏", None)
    keep = _image_id("a.png")
    get_pool().main().execute(
        "INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?, ?)",
        (keep, saved_into["id"]),
    )

    client.post(f"/api/folders/{_folder_id(root)}/archive")

    items = client.get("/api/items").json()
    assert items["counts"]["image"] == 1
    assert [it["filename"] for it in items["items"]] == ["a.png"]
    names = [n["name"] for n in repository.folder_tree()]
    assert "我的收藏" in names and "output" not in names


def test_archived_user_folder_is_not_resurrected_by_the_disk_sync(init_db, tmp_data_dir):
    """「我的文件夹」住在 data/folders，读侧栏会照物理目录重建 —— 归档不能被它复活。"""
    client = TestClient(app)
    init_pool()
    created = folder_storage.create_folder("旧项目", None)
    assert any(n["name"] == "旧项目" for n in repository.folder_tree())

    client.post(f"/api/folders/{created['id']}/archive")
    assert client.get("/api/folders").json() == []
    assert Path(created["path"]).is_dir()      # 磁盘上原样留着

    client.post(f"/api/folders/{created['id']}/restore")
    assert any(n["name"] == "旧项目" for n in repository.folder_tree())


def test_text_inside_an_archived_directory_disappears_too(init_db, tmp_data_dir):
    """文本按磁盘路径归属，所以归档要按前缀把它一起藏起来。"""
    client = TestClient(app)
    init_pool()
    docs = tmp_data_dir / "notes" / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# 归档测试\n正文在这里", encoding="utf-8")
    texts.associate([str(docs)])
    assert client.get("/api/items", params={"kinds": "text"}).json()["counts"]["text"] == 1

    root_id = _folder_id(docs)   # texts.associate 给关联的那个目录本身建节点
    client.post(f"/api/folders/{root_id}/archive")
    assert client.get("/api/items", params={"kinds": "text"}).json()["counts"]["text"] == 0
    assert client.get("/api/stats").json()["total_texts"] == 0
    assert (docs / "a.md").is_file()
    assert [e["texts"] for e in client.get("/api/folders", params={"archived": True}).json()] == [1]

    client.post(f"/api/folders/{root_id}/restore")
    assert client.get("/api/items", params={"kinds": "text"}).json()["counts"]["text"] == 1


def test_archive_does_not_touch_watch_dirs_or_the_index_rows(init_db, tmp_data_dir):
    """归档只翻 folders.archived：监听照旧，索引行也还在（标签因此不会丢）。"""
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    before = get_pool().main().execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
    config_before = Path(tmp_data_dir / "config.json").read_text(encoding="utf-8")

    client.post(f"/api/folders/{_folder_id(root)}/archive")

    assert get_pool().main().execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"] == before
    assert Path(tmp_data_dir / "config.json").read_text(encoding="utf-8") == config_before


def test_files_written_after_archiving_stay_hidden(init_db, tmp_data_dir):
    """来源目录是外部程序正在写的目录：归档以后新写进来的文件不得把它复活。

    这里同时验两个洞：根上的新文件（挂在已归档节点上）和新子目录里的文件
    （子目录是刚刚才建的，归档位必须从父级继承，否则素材会自己冒回统一流）。
    """
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    client.post(f"/api/folders/{_folder_id(root)}/archive")

    (root / "newrun").mkdir()
    make_png(root / "newrun" / "b.png")
    make_png(root / "cover2.png")
    indexer = Indexer()
    indexer.update_config(watch_dirs=[str(root)])
    indexer.scan(root)
    indexer.shutdown()

    items = client.get("/api/items").json()
    assert items["counts"]["image"] == 0, items["counts"]
    assert items["items"] == []
    assert repository.folder_tree() == []
    st = client.get("/api/stats").json()
    assert st["total_images"] == 0, st


def test_archived_items_stop_counting_in_tags(init_db, tmp_data_dir):
    """标签数只数还看得见的素材：否则归档后会出现「点了以后一片空白」的标签。"""
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    repository.set_tags(_image_id("a.png"), ["krea2"])
    assert {t["name"]: t["count"] for t in repository.tag_list()}["krea2"] == 1

    sub = _folder_id(root / "krea2")
    client.post(f"/api/folders/{sub}/archive")
    assert "krea2" not in {t["name"] for t in repository.tag_list()}
    assert client.get("/api/tags").json() == [] or "krea2" not in {
        t["name"] for t in client.get("/api/tags").json()
    }

    client.post(f"/api/folders/{sub}/restore")
    assert {t["name"]: t["count"] for t in repository.tag_list()}["krea2"] == 1


def test_importing_an_archived_directory_again_brings_it_back(init_db, tmp_data_dir):
    """归档过的目录再点一次「+ 添加来源目录」必须回来，否则用户会以为按钮坏了。"""
    client = TestClient(app)
    root = _scan(tmp_data_dir)
    client.post(f"/api/folders/{_folder_id(root)}/archive")
    assert client.get("/api/folders").json() == []

    assert client.post("/api/directories/import", json={"path": str(root)}).status_code == 200
    nodes = _flat(repository.folder_tree())
    assert _key(root) in nodes
    assert client.get("/api/items").json()["counts"]["image"] == 2
