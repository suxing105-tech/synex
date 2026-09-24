"""Copy external directory trees into user-folder storage, keeping the source intact."""
import os
import shutil
from pathlib import Path

from . import repository
from .config import data_dir
from .db import get_pool, transaction
from .indexer import get_indexer
from .parser import SUPPORTED_EXTS


def copy_directories(paths: list[str]) -> dict:
    indexer = get_indexer()
    result = {"copied": [], "failed": [], "warnings": []}
    sources = list(dict.fromkeys(Path(p).absolute() for p in paths))
    # A selected parent already includes its selected children.
    sources = [p for p in sources if not any(p != q and p.is_relative_to(q) for q in sources)]
    with indexer._live_lock:
        for source in sources:
            try:
                copied = _copy_one(source, indexer, result["warnings"])
                result["copied"].append(copied)
            except Exception as error:
                result["failed"].append({"path": str(source), "reason": str(error)})
    return result


def _copy_one(source: Path, indexer, warnings: list) -> dict:
    storage = (data_dir() / "folders").resolve()
    if source.is_symlink() or source.is_junction():
        raise ValueError("请选择真实文件夹，不支持链接或目录联接")
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise ValueError("左侧栏只接收文件夹；图片请拖到中间区域")
    if source == Path(source.anchor) or source.is_relative_to(data_dir().resolve()) or data_dir().resolve().is_relative_to(source):
        raise ValueError("不能复制图库数据目录、其父目录或磁盘根目录")
    if any(source.is_relative_to(root) or root.is_relative_to(source) for root in map(Path, indexer._watch_roots)):
        raise ValueError("此目录正在被监听，请先取消监听再复制")
    directories = [source]
    files = []
    def fail(error):
        raise error
    for current, children, names in os.walk(source, onerror=fail, followlinks=False):
        for name in children + names:
            entry = Path(current) / name
            if entry.is_symlink() or entry.is_junction():
                raise ValueError("文件夹包含链接或目录联接，未复制任何内容")
        directories.extend(Path(current) / name for name in children)
        files.extend(Path(current) / name for name in names)
    storage.mkdir(parents=True, exist_ok=True)
    destination = storage / source.name
    suffix = 1
    conn = get_pool().main()
    while destination.exists() or conn.execute("SELECT id FROM folders WHERE parent_id IS NULL AND name=?", (destination.name,)).fetchone():
        destination = storage / f"{source.name}_{suffix}"
        suffix += 1
    # Copy the tree; the original directory is always preserved.
    try:
        shutil.copytree(str(source), str(destination))
    except Exception as error:
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        raise OSError(f"复制未完成：{error}。请检查原目录 {source} 和目标 {destination}") from error
    mapping = {}
    try:
        with transaction() as c:
            for directory in directories:
                target = destination / directory.relative_to(source)
                target_text = repository._normalize_path(target)
                parent_id = mapping.get(directory.parent)
                folder_id = c.execute("INSERT INTO folders(name,parent_id,path,is_system) VALUES(?,?,?,0)",
                                      (target.name, parent_id, target_text)).lastrowid
                mapping[directory] = folder_id
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    indexed = 0
    for file in files:
        if file.suffix.lower() not in SUPPORTED_EXTS:
            continue
        target = destination / file.relative_to(source)
        try:
            event = indexer._process_path_sync(target)
            if event:
                conn.execute("INSERT OR IGNORE INTO image_folders(image_id,folder_id) VALUES(?,?)", (event["id"], mapping[file.parent]))
                indexer.emit_event_sync(event)
                indexed += 1
        except Exception as error:
            warnings.append({"path": str(target), "reason": f"文件已复制，图片索引失败：{error}"})
    return {"id": mapping[source], "path": str(destination), "name": destination.name, "images": indexed}
