"""来源目录（system folder）在侧栏里的形态。

三条契约，对应苏醒提出的三件事：
1. 来源目录 = 不移动文件 + 持续监视目录里的内容变化；
2. 导入 ComfyUI 的 output，侧栏应先出现 output 这一个节点，Audio / krea2 / MiniMaxH3
   这些是它的**子**节点，不是平铺在「来源目录」下面的一堆兄弟；
3. 给来源目录改名只是图库里的标签，磁盘上的真实目录一个字节都不动。
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import folder_storage, repository
from app.db import get_pool, init_pool
from app.indexer import Indexer, get_indexer
from app.main import app

from .conftest import make_png


def _flat(tree):
    """folder_tree() → {目录键: (父目录键, 名称, is_system)}。"""
    out = {}

    def walk(nodes, parent):
        for node in nodes:
            key = repository._folder_key(node["path"] or "")
            out[key] = (parent, node["name"], node["is_system"])
            walk(node["children"], key)

    walk(tree, None)
    return out


def _folder_id_by_path(path: Path) -> int:
    row = get_pool().main().execute(
        "SELECT id FROM folders WHERE lower(replace(path, char(92), '/')) = lower(?)",
        (repository._normalize_folder_path(path),),
    ).fetchone()
    return row["id"]


def _attached_folder_of(filename: str) -> int | None:
    row = get_pool().main().execute(
        "SELECT j.folder_id FROM images i JOIN image_folders j ON j.image_id = i.id "
        "JOIN folders f ON f.id = j.folder_id WHERE f.is_system = 1 AND i.filename = ?",
        (filename,),
    ).fetchone()
    return None if row is None else row["folder_id"]


def test_root_itself_is_the_node_and_children_nest_inside(tmp_data_dir):
    """导入 ComfyUI 的 output：一个根节点，子目录在里面，散在根上的文件也挂得上。"""
    init_pool()
    root = tmp_data_dir / "output"
    (root / "krea2" / "deep").mkdir(parents=True)
    make_png(root / "loose.png")
    make_png(root / "krea2" / "a.png")
    make_png(root / "krea2" / "deep" / "b.png")
    indexer = Indexer()
    indexer.update_config(watch_dirs=[str(root)])
    indexer.scan(root)
    indexer.shutdown()

    nodes = _flat(repository.folder_tree())
    root_key = repository._folder_key(root)
    krea = repository._folder_key(root / "krea2")
    deep = repository._folder_key(root / "krea2" / "deep")
    assert nodes[root_key] == (None, "output", True)     # 根在顶层，名字就是它自己
    assert nodes[krea][0] == root_key                    # krea2 在根里面
    assert nodes[deep][0] == krea                        # 逐级嵌套，没有摊平
    assert _attached_folder_of("loose.png") == _folder_id_by_path(root)
    assert _attached_folder_of("a.png") == _folder_id_by_path(root / "krea2")
    assert _attached_folder_of("deep/b.png".split("/")[-1]) == _folder_id_by_path(root / "krea2" / "deep")


def test_new_subfolder_added_later_nests_under_the_root(tmp_data_dir):
    """监视的是「目录里的内容变化」：扫完之后再新建子目录和文件，也要挂到根下面。"""
    init_pool()
    root = tmp_data_dir / "output"
    root.mkdir()
    indexer = Indexer()
    indexer.update_config(watch_dirs=[str(root)])
    indexer.scan(root)
    late = root / "GTV" / "第二批"
    late.mkdir(parents=True)
    indexer._ensure_system_folder_for_dir(late)          # watchdog 新建目录走这条路
    indexer._process_path_sync(make_png(late / "c.png"))
    indexer.shutdown()

    nodes = _flat(repository.folder_tree())
    root_key = repository._folder_key(root)
    assert nodes[repository._folder_key(late)][0] == repository._folder_key(root / "GTV")
    assert nodes[repository._folder_key(root / "GTV")][0] == root_key
    assert _attached_folder_of("c.png") == _folder_id_by_path(late)


def test_legacy_flattened_tree_heals_when_sidebar_loads(tmp_data_dir):
    """老库自愈：以前只有一级子目录、没有根节点，打开侧栏就该自动补好。"""
    init_pool()
    root = tmp_data_dir / "output"
    (root / "krea2").mkdir(parents=True)
    conn = get_pool().main()
    conn.execute(
        'INSERT INTO folders(parent_id, name, "order", is_system, path) VALUES(NULL, ?, 0, 1, ?)',
        ("krea2", repository._normalize_folder_path(root / "krea2")),
    )
    get_indexer().update_config(watch_dirs=[str(root)])

    tree = TestClient(app).get("/api/folders").json()
    nodes = _flat(tree)
    assert nodes[repository._folder_key(root)] == (None, "output", True)
    assert nodes[repository._folder_key(root / "krea2")][0] == repository._folder_key(root)
    # 幂等：再来一次不多建、不重复挂
    before = conn.execute("SELECT COUNT(*) c FROM folders").fetchone()["c"]
    TestClient(app).get("/api/folders")
    assert conn.execute("SELECT COUNT(*) c FROM folders").fetchone()["c"] == before


def test_nested_source_root_stays_its_own_top_level_node(tmp_data_dir):
    """A 套在 B 里面时两个根各自顶层：find_watch_root 取最深匹配，不能互相吞。"""
    init_pool()
    outer = tmp_data_dir / "素材盘"
    inner = outer / "ComfyUI" / "output"
    inner.mkdir(parents=True)
    get_indexer().update_config(watch_dirs=[str(outer), str(inner)])
    result = repository.ensure_source_root_folders([str(outer), str(inner)])
    assert result["created"] == 2
    nodes = _flat(repository.folder_tree())
    assert nodes[repository._folder_key(outer)][0] is None
    assert nodes[repository._folder_key(inner)][0] is None


def test_unavailable_directory_creates_no_node(tmp_data_dir):
    """盘没插、目录被删：不建空节点，也别把侧栏读接口弄挂。"""
    init_pool()
    gone = tmp_data_dir / "未挂载盘" / "output"
    assert repository.ensure_source_root_folder(gone) is None
    assert repository.ensure_source_root_folders([gone, tmp_data_dir / "也不存在"]) == {
        "created": 0, "reparented": 0}
    assert repository.folder_tree() == [] or all(
        n["path"] for n in repository.folder_tree())


def test_renaming_source_folder_only_changes_the_label(tmp_data_dir):
    """来源目录改名 = 只改图库里的显示名；磁盘目录与索引路径都不动。"""
    init_pool()
    root = tmp_data_dir / "output"
    nested = root / "krea2"
    nested.mkdir(parents=True)
    make_png(nested / "a.png")
    indexer = Indexer()
    indexer.update_config(watch_dirs=[str(root)])
    indexer.scan(root)
    indexer.shutdown()
    image_path = get_pool().main().execute("SELECT path FROM images").fetchone()["path"]

    response = TestClient(app).patch(f"/api/folders/{_folder_id_by_path(nested)}",
                                     json={"name": "Krea 出图"})
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Krea 出图"
    assert nested.is_dir() and (nested / "a.png").is_file()
    assert not (root / "Krea 出图").exists()
    assert get_pool().main().execute("SELECT path FROM images").fetchone()["path"] == image_path
    assert indexer.config.watch_dirs == [str(root)]
    # 重启后仍按路径认得这个节点，不会被自定义标签拆成两个
    repository.ensure_source_root_folder(root)
    repository.ensure_system_folder_chain(nested / "a.png", root)
    assert sum(1 for _, name, _ in _flat(repository.folder_tree()).values() if name == "Krea 出图") == 1
    assert _folder_id_by_path(nested) == response.json()["id"]


def test_import_creates_the_root_node_even_for_an_empty_directory(tmp_data_dir, monkeypatch):
    """新导入的空目录也要立刻在侧栏露出来，而不是等第一个文件被索引。"""
    init_pool()
    target = tmp_data_dir / "新来源"
    target.mkdir()
    indexer = Indexer()
    monkeypatch.setattr("app.routes.settings.get_indexer", lambda: indexer)

    async def fake_watch(self, path):
        return None

    monkeypatch.setattr(Indexer, "watch_added_directory", fake_watch)
    response = TestClient(app).post("/api/directories/import", json={"path": str(target)})
    assert response.status_code == 200, response.text
    assert indexer.config.watch_dirs == [str(target)]
    nodes = _flat(repository.folder_tree())
    assert nodes[repository._folder_key(target)][0] is None
    assert nodes[repository._folder_key(target)][1] == "新来源"
