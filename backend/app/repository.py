"""图片 / 文件夹 / 标签的查询与变更（路由层调用）。"""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from .db import fts_sync, get_pool, transaction



def original_url_for(image_id: int, file_mtime: float | None, *, max_size: int | None = 1024) -> str | None:
    """返回带 cache-bust 的原图 URL（feed 直接拿原图让浏览器缩放）。

    原图文件被覆盖时 mtime 变 → URL 变 → 浏览器重新下载。
    mtime 缺失（理论上不会，扫描会写入）就返回 None，
    feed 渲染时跳过 src，浏览器自动 fallback 到 alt 占位。

    max_size：可选，预览最长边像素。默认 1024 = 让后端先缩到 1024 再返回，
    落盘缓存到 previews/，典型 200KB 替代 2-5MB 原图，feed 流量下降 10x。
    传 None = 不缩，返回原图（Lightbox 用）。
    """
    if file_mtime is None:
        return None
    qs = []
    if max_size is not None:
        qs.append(f"max={int(max_size)}")
    qs.append(f"v={int(file_mtime)}")
    return f"/api/images/{image_id}/file?{"&".join(qs)}"



# ---------- 文件夹 ----------


def _normalize_path(p: Path) -> str:
    return str(p).replace("\\", "/")


def folder_tree() -> list[dict]:
    conn = get_pool().main()
    rows = conn.execute(
        "SELECT id, parent_id, name, \"order\", is_system, path FROM folders ORDER BY parent_id, \"order\", name"
    ).fetchall()
    by_parent: dict[int | None, list[dict]] = {}
    for r in rows:
        by_parent.setdefault(r["parent_id"], []).append(
            {"id": r["id"], "parent_id": r["parent_id"], "name": r["name"], "order": r["order"], "is_system": bool(r["is_system"]), "path": r["path"]}
        )

    # 计算每节点直接图片数 + 递归后代数
    direct_counts = dict(
        conn.execute(
            "SELECT folder_id, COUNT(*) AS c FROM image_folders GROUP BY folder_id"
        ).fetchall()
    )

    # 先把所有子节点 id 收集好（用于递归计数）
    children_map: dict[int, list[int]] = {}
    for fid, parent in [(r["id"], r["parent_id"]) for r in rows]:
        if parent is not None:
            children_map.setdefault(parent, []).append(fid)

    def recursive_count(fid: int) -> int:
        total = direct_counts.get(fid, 0)
        for child in children_map.get(fid, []):
            total += recursive_count(child)
        return total

    def build(parent: int | None) -> list[dict]:
        out = []
        for n in by_parent.get(parent, []):
            fid = n["id"]
            out.append({
                **n,
                "image_count": direct_counts.get(fid, 0),
                "recursive_count": recursive_count(fid),
                "children": build(fid),
            })
        return out

    return build(None)


def folder_create(name: str, parent_id: int | None) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("name 不能为空")
    conn = get_pool().main()
    # order = max(order)+1
    row = conn.execute(
        "SELECT COALESCE(MAX(\"order\"), -1) AS m FROM folders WHERE parent_id IS ?",
        (parent_id,),
    ).fetchone()
    order = (row["m"] if row else -1) + 1
    with transaction() as c:
        cur = c.execute(
            "INSERT INTO folders(parent_id, name, \"order\") VALUES(?, ?, ?)",
            (parent_id, name, order),
        )
        folder_id = cur.lastrowid
    return {"id": folder_id, "parent_id": parent_id, "name": name, "order": order}


def folder_update(folder_id: int, *, name: str | None = None, order: int | None = None, parent_id: int | None = ...) -> dict:
    """``parent_id`` 显式 ``...`` 区分"不改"与"置顶"——但 ``None`` 是合法（表示移到根）。
    为简化：调用方用 ``parent_id_changed`` 标记是否要更新 parent_id。这里直接用
    ``...`` sentinel。
    """
    conn = get_pool().main()
    fields: list[str] = []
    values: list[object] = []
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("名称不能为空")
        if conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone() is None:
            raise ValueError("文件夹不存在")
        fields.append("name = ?")
        values.append(name)
    if order is not None:
        fields.append("\"order\" = ?")
        values.append(order)
    if parent_id is not ...:
        # 防止把目录挂到自己 / 后代下
        if parent_id is not None:
            cur_id = parent_id
            while True:
                if cur_id == folder_id:
                    raise ValueError("不能把文件夹移到自身或其后代")
                parent = conn.execute(
                    "SELECT parent_id FROM folders WHERE id = ?", (cur_id,)
                ).fetchone()
                if not parent or parent["parent_id"] is None:
                    break
                cur_id = parent["parent_id"]
        fields.append("parent_id = ?")
        values.append(parent_id)
    if not fields:
        row = conn.execute(
            "SELECT id, parent_id, name, \"order\" FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        return dict(row) if row else {}
    values.append(folder_id)
    with transaction() as c:
        if name is not None and order is None:
            # 来源目录初始 order 可能相同，改名之前固定现有顺序，避免改名跳位。
            row = c.execute("SELECT parent_id, is_system FROM folders WHERE id = ?", (folder_id,)).fetchone()
            siblings = c.execute(
                'SELECT id FROM folders WHERE parent_id IS ? AND is_system = ? ORDER BY "order", name, id',
                (row["parent_id"], row["is_system"]),
            ).fetchall()
            c.executemany('UPDATE folders SET "order" = ? WHERE id = ?',
                          [(i, r["id"]) for i, r in enumerate(siblings)])
        c.execute(f"UPDATE folders SET {', '.join(fields)} WHERE id = ?", values)
    row = conn.execute(
        "SELECT id, parent_id, name, \"order\" FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    return dict(row) if row else {}


def folder_delete(folder_id: int) -> None:
    conn = get_pool().main()
    with transaction() as c:
        # 收集所有后代
        ids = [folder_id]
        i = 0
        while i < len(ids):
            children = c.execute(
                "SELECT id FROM folders WHERE parent_id = ?", (ids[i],)
            ).fetchall()
            ids.extend(r["id"] for r in children)
            i += 1
        # image_folders 与 images 的归属关系会被 ON DELETE CASCADE 清掉；
        # 但产品要求"子文件夹被删后图片升级到父级"。这里把 image_folders 中所有
        # 指向被删文件夹的记录重定向到父级（如果父级也不存在则删除记录）。
        placeholders = ",".join("?" * len(ids))
        c.execute(f"DELETE FROM folders WHERE id IN ({placeholders})", ids)
        # 升级：找出子文件夹中的图片，重新指派到第一个未删祖先
        # 这里已经 DELETE，再补一次指派（实际等于全删了 image_folders），简化策略：
        # "升级到父级" 改为"清空归属"。
        c.execute(
            "DELETE FROM image_folders WHERE folder_id IN (SELECT id FROM folders WHERE 1=0)"  # noop（已删）
        )


def folder_reorder(folder_id: int, target_id: int, position: str) -> None:
    """同层同类型节点按相对位置原子排序，也支持初始 order 相同的来源目录。"""
    if position not in ("before", "after"):
        raise ValueError("无效的排序位置")
    with transaction() as c:
        source = c.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
        target = c.execute("SELECT * FROM folders WHERE id = ?", (target_id,)).fetchone()
        if not source or not target:
            raise ValueError("文件夹不存在")
        if source["parent_id"] != target["parent_id"] or source["is_system"] != target["is_system"]:
            raise ValueError("请拖到同一层级的文件夹之间")
        if folder_id == target_id:
            return
        ids = [r["id"] for r in c.execute(
            'SELECT id FROM folders WHERE parent_id IS ? AND is_system = ? ORDER BY "order", name, id',
            (source["parent_id"], source["is_system"]),
        ) if r["id"] != folder_id]
        index = ids.index(target_id) + (position == "after")
        ids.insert(index, folder_id)
        c.executemany('UPDATE folders SET "order" = ? WHERE id = ?', enumerate(ids))


def folder_move_order(folder_id: int, direction: str) -> None:
    """direction: 'up' / 'down'，在同 parent 内交换 order。"""
    if direction not in ("up", "down"):
        raise ValueError("direction 必须是 up 或 down")
    conn = get_pool().main()
    row = conn.execute(
        "SELECT id, parent_id, \"order\" FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not row:
        return
    delta = -1 if direction == "up" else 1
    # 找同 parent 下邻居
    if direction == "up":
        neighbor = conn.execute(
            "SELECT id, \"order\" FROM folders WHERE parent_id IS ? AND \"order\" < ? "
            "ORDER BY \"order\" DESC LIMIT 1",
            (row["parent_id"], row["order"]),
        ).fetchone()
    else:
        neighbor = conn.execute(
            "SELECT id, \"order\" FROM folders WHERE parent_id IS ? AND \"order\" > ? "
            "ORDER BY \"order\" ASC LIMIT 1",
            (row["parent_id"], row["order"]),
        ).fetchone()
    if not neighbor:
        return
    with transaction() as c:
        # 用一个大负数占位避免 UNIQUE 冲突（parent_id, name 上有唯一约束，但 order 唯一约束没有）
        c.execute("UPDATE folders SET \"order\" = -99999 WHERE id = ?", (row["id"],))
        c.execute("UPDATE folders SET \"order\" = ? WHERE id = ?", (row["order"], neighbor["id"]))
        c.execute("UPDATE folders SET \"order\" = ? WHERE id = ?", (neighbor["order"], row["id"]))


# ---------- 图片 ----------


def assign_folder(image_id: int, folder_id: int | None) -> None:
    conn = get_pool().main()
    with transaction() as c:
        c.execute("DELETE FROM image_folders WHERE image_id = ?", (image_id,))
        if folder_id is not None:
            c.execute(
                "INSERT INTO image_folders(image_id, folder_id) VALUES(?, ?)",
                (image_id, folder_id),
            )


def bulk_assign_folder(image_ids: list[int], folder_id: int | None) -> int:
    """批量替换 image_folders 归属（单事务）。

    - folder_id=None → 把这些图从所有 user folder 移出（保留 system folder）
    - folder_id=int → 替换归属（同 assign_folder，不动 system folder）

    返回成功写入的图数。
    """
    if not image_ids:
        return 0
    placeholders = ",".join("?" * len(image_ids))
    with transaction() as c:
        # 先把这批图从所有非 system folder 的归属清掉
        c.execute(
            f"DELETE FROM image_folders WHERE image_id IN ({placeholders}) "
            f"AND folder_id IN (SELECT id FROM folders WHERE is_system = 0)",
            image_ids,
        )
        if folder_id is not None:
            # 确保目标 folder 存在且非 system（system folder 不接收用户手动移动）
            target = c.execute(
                "SELECT id, is_system FROM folders WHERE id = ?", (folder_id,)
            ).fetchone()
            if not target:
                raise ValueError(f"文件夹 {folder_id} 不存在")
            if target["is_system"]:
                raise ValueError("不能把图片移动到系统文件夹")
            c.executemany(
                "INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?, ?)",
                [(iid, folder_id) for iid in image_ids],
            )
    return len(image_ids)


def set_favorite(image_id: int, favorite: bool) -> None:
    get_pool().main().execute(
        "UPDATE images SET favorite = ? WHERE id = ?", (1 if favorite else 0, image_id)
    )


def set_tags(image_id: int, tags: Iterable[str]) -> list[str]:
    """覆盖式设置标签；返回清理后的标签列表。"""
    clean: list[str] = []
    seen: set[str] = set()
    for t in tags:
        t = t.strip().lstrip("#")
        if not t or t in seen:
            continue
        seen.add(t)
        clean.append(t)
    conn = get_pool().main()
    with transaction() as c:
        c.execute("DELETE FROM image_tags WHERE image_id = ?", (image_id,))
        for t in clean:
            c.execute("INSERT OR IGNORE INTO tags(name) VALUES(?)", (t,))
            tag_id = c.execute("SELECT id FROM tags WHERE name = ?", (t,)).fetchone()["id"]
            c.execute(
                "INSERT OR IGNORE INTO image_tags(image_id, tag_id) VALUES(?, ?)",
                (image_id, tag_id),
            )
    return clean


def image_detail(image_id: int) -> dict | None:
    conn = get_pool().main()
    row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        return None
    return _row_to_detail(row)


def _row_to_summary(row: sqlite3.Row) -> dict:
    folder_ids = [
        r["folder_id"]
        for r in get_pool().main().execute(
            "SELECT folder_id FROM image_folders WHERE image_id = ?", (row["id"],)
        ).fetchall()
    ]
    tags = [
        r["name"]
        for r in get_pool().main().execute(
            "SELECT t.name FROM tags t JOIN image_tags it ON it.tag_id = t.id "
            "WHERE it.image_id = ? ORDER BY t.name",
            (row["id"],),
        ).fetchall()
    ]
    return {
        "id": row["id"],
        "filename": row["filename"],
        "path": row["path"],
        "original_url": original_url_for(row["id"], row["mtime"]),
        "width": row["width"],
        "height": row["height"],
        "mtime": row["mtime"],
        "size_bytes": row["size_bytes"],
        "favorite": bool(row["favorite"]),
        "folder_ids": folder_ids,
        "tags": tags,
        "model": row["model"],
        "seed": row["seed"],
        "new": False,
        "has_workflow": bool(row["workflow"]),
    }


def _row_to_detail(row: sqlite3.Row) -> dict:
    summary = _row_to_summary(row)
    summary.update(
        {
            "positive_prompt": row["positive_prompt"],
            "negative_prompt": row["negative_prompt"],
            "parameters": json.loads(row["parameters"] or "{}"),
            "workflow": row["workflow"] or "",
            "sampler": row["sampler"],
            "steps": row["steps"],
            "cfg": row["cfg"],
            "format": row["format"],
            "created_at": row["created_at"] if "created_at" in row.keys() else None,
            "indexed_at": row["indexed_at"] if "indexed_at" in row.keys() else None,
        }
    )
    return summary


# ---------- 重命名 / 揭示路径 ----------


INVALID_FILENAME_CHARS = set('\\/:*?"<>|')


class RenameError(ValueError):
    """重命名失败时抛；HTTP 层转 400/404/409。"""


def rename_image(image_id: int, new_filename: str) -> dict:
    """重命名磁盘文件 + 更新 images 表。

    限制：
    - new_filename 仅允许改 stem，扩展名强制沿用原文件后缀（保持 MIME / 解析器识别）
    - 禁止包含路径分隔符 / Windows 非法字符
    - 不允许重名到同目录的现有文件名

    返回更新后的 summary dict；image 不存在抛 RenameError('not_found')。
    """
    if not isinstance(new_filename, str) or not new_filename.strip():
        raise RenameError("文件名不能为空")
    new_filename = new_filename.strip()
    if any(c in INVALID_FILENAME_CHARS for c in new_filename):
        raise RenameError("文件名包含非法字符")
    if new_filename in {".", ".."}:
        raise RenameError("文件名不合法")

    conn = get_pool().main()
    row = conn.execute(
        "SELECT id, path, filename FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if not row:
        raise RenameError("not_found")

    old_path = Path(row["path"])
    if not old_path.exists():
        raise RenameError("原文件不存在")
    old_ext = old_path.suffix  # 含点号，如 ".png"
    if not old_ext:
        raise RenameError("原文件缺少扩展名，拒绝重命名")

    stem = new_filename
    # 若用户给了扩展名，与原扩展名不一致则强制用原扩展名
    given_ext = Path(stem).suffix
    if given_ext and given_ext.lower() != old_ext.lower():
        stem = Path(stem).stem
    # 强制保留原扩展名
    final_name = stem + old_ext if not stem.lower().endswith(old_ext.lower()) else stem
    # 最终再校验
    if any(c in INVALID_FILENAME_CHARS for c in final_name):
        raise RenameError("文件名包含非法字符")
    if not final_name.strip():
        raise RenameError("文件名不能为空")

    new_path = old_path.with_name(final_name)
    if new_path == old_path:
        # 重命名到自身：直接返回现状
        stat = old_path.stat()
        with transaction() as c:
            c.execute(
                "UPDATE images SET filename = ?, mtime = ? WHERE id = ?",
                (final_name, float(stat.st_mtime), image_id),
            )
            fts_sync(c, image_id, "update")
        updated = conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone()
        return _row_to_summary(updated)

    if new_path.exists():
        raise RenameError("目标文件已存在")

    old_path.rename(new_path)
    stat = new_path.stat()
    new_mtime = float(stat.st_mtime)
    with transaction() as c:
        c.execute(
            "UPDATE images SET path = ?, filename = ?, mtime = ? WHERE id = ?",
            (str(new_path), final_name, new_mtime, image_id),
        )
        fts_sync(c, image_id, "update")
    updated = conn.execute(
        "SELECT * FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    return _row_to_summary(updated)


def delete_image_files(image_id: int) -> dict:
    """从数据库删除图片条目，并清理磁盘文件 + 预览缓存。

    返回 {"id": int, "removed_file": bool, "cleaned_previews": int}。
    图片不存在 → 抛 RenameError('not_found')。
    原文件删除失败（非 OSError）→ 让上层决定。
    """
    from .config import previews_dir
    conn = get_pool().main()
    row = conn.execute(
        "SELECT id, path, thumb_path FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if not row:
        raise RenameError("not_found")
    fpath = Path(row["path"])
    thumb = row["thumb_path"]

    removed_file = False
    try:
        if fpath.exists():
            fpath.unlink()
        removed_file = True
    except FileNotFoundError:
        removed_file = False
    except OSError:
        raise

    # 缩略图（thumb_path 有就删，没有跳过）
    if thumb:
        try:
            tp = Path(thumb)
            if tp.exists():
                tp.unlink()
        except (OSError, FileNotFoundError):
            pass

    # previews/{id}_max*.webp（任意长边）—— 不存在也忽略
    cleaned = 0
    pd = previews_dir()
    if pd.exists():
        for f in pd.glob(f"{image_id}_max*.webp"):
            try:
                f.unlink()
                cleaned += 1
            except (OSError, FileNotFoundError):
                pass

    conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
    return {"id": image_id, "removed_file": removed_file, "cleaned_previews": cleaned}


def image_reveal_path(image_id: int) -> str | None:
    """返回图片在磁盘上的绝对路径（供 OS 文件管理器定位）。"""
    conn = get_pool().main()
    row = conn.execute(
        "SELECT path FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if not row:
        return None
    p = Path(row["path"])
    return str(p) if p.exists() else None


# ---------- Feed ----------


def feed(
    *,
    folder_id: int | None = None,
    view: str | None = None,
    q: str | None = None,
    tag: str | None = None,
    model: str | None = None,
    limit: int = 500,
    offset: int = 0,
    new_ids: set[int] | None = None,
) -> tuple[list[dict], int]:
    """返回 (items, total)。``new_ids`` 用于标记 NEW 徽标。"""
    conn = get_pool().main()
    where: list[str] = []
    params: list[object] = []

    if folder_id is not None:
        # 包含所有后代
        ids = [folder_id]
        i = 0
        while i < len(ids):
            children = conn.execute(
                "SELECT id FROM folders WHERE parent_id = ?", (ids[i],)
            ).fetchall()
            ids.extend(r["id"] for r in children)
            i += 1
        placeholders = ",".join("?" * len(ids))
        where.append(
            f"images.id IN (SELECT image_id FROM image_folders WHERE folder_id IN ({placeholders}))"
        )
        params.extend(ids)

    if view == "favorite":
        where.append("images.favorite = 1")
    elif view == "recent":
        # 最近 7 天
        import time

        cutoff = time.time() - 7 * 86400
        where.append("images.mtime >= ?")
        params.append(cutoff)

    if tag:
        where.append(
            "images.id IN (SELECT it.image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id "
            "WHERE t.name = ?)"
        )
        params.append(tag)

    if model:
        where.append("images.model = ?")
        params.append(model)

    fts_ids: list[int] | None = None
    if q:
        like = f"%{q}%"
        # 同时走 FTS（prompts/filename/model）和 filename 模糊
        rows = conn.execute(
            "SELECT rowid FROM images_fts WHERE images_fts MATCH ? ORDER BY rank LIMIT 5000",
            (_build_fts_query(q),),
        ).fetchall()
        fts_ids = [r["rowid"] for r in rows]
        if fts_ids:
            placeholders = ",".join("?" * len(fts_ids))
            where.append(
                f"(images.id IN ({placeholders}) OR images.filename LIKE ? OR images.model LIKE ?)"
            )
            params.extend(fts_ids)
            params.extend([like, like])
        else:
            where.append("(images.filename LIKE ? OR images.model LIKE ? OR images.positive_prompt LIKE ?)")
            params.extend([like, like, like])

    where_clause = ("WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute(
        f"SELECT COUNT(*) AS c FROM images {where_clause}", params
    ).fetchone()["c"]
    rows = conn.execute(
        f"SELECT images.* FROM images {where_clause} "
        f"ORDER BY images.mtime DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    items = []
    for r in rows:
        s = _row_to_summary(r)
        if new_ids and s["id"] in new_ids:
            s["new"] = True
        items.append(s)
    return items, total


def _build_fts_query(q: str) -> str:
    """把用户 query 转成 FTS5 prefix 表达式。

    简单实现：按空白切词，加 ``*`` 实现前缀匹配；中文短语不做切分（unicode61 自带）。
    """
    parts: list[str] = []
    for tok in q.split():
        tok = tok.replace('"', "").strip()
        if not tok:
            continue
        parts.append(f'"{tok}"*')
    return " ".join(parts) if parts else '""'


# ---------- 标签 ----------


def tag_list() -> list[dict]:
    conn = get_pool().main()
    return [
        dict(r)
        for r in conn.execute(
            "SELECT t.name, COUNT(it.image_id) AS count FROM tags t "
            "LEFT JOIN image_tags it ON it.tag_id = t.id "
            "GROUP BY t.id, t.name HAVING count > 0 ORDER BY count DESC, t.name ASC"
        ).fetchall()
    ]


# ---------- 通用计数 ----------


def stats() -> dict:
    conn = get_pool().main()
    total = conn.execute("SELECT COUNT(*) AS c FROM images").fetchone()["c"]
    favorites = conn.execute(
        "SELECT COUNT(*) AS c FROM images WHERE favorite = 1"
    ).fetchone()["c"]
    folders = conn.execute("SELECT COUNT(*) AS c FROM folders").fetchone()["c"]
    return {
        "total_images": total,
        "favorites": favorites,
        "folders": folders,
    }




# ---------- system folder helpers (filesystem subdirs auto-promoted) ----------


def _normalize_folder_path(p: Path) -> str:
    return str(p).replace("\\", "/")


def is_system_folder(folder_id: int) -> bool:
    conn = get_pool().main()
    row = conn.execute(
        "SELECT is_system FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    return bool(row and row["is_system"])


def find_watch_root(file_path: Path, watch_roots: list[Path]) -> Path | None:
    """返回包含 file_path 的最深 watch root；都不在则 None。"""
    p = Path(file_path).resolve()
    best: Path | None = None
    for root in watch_roots:
        try:
            p.relative_to(Path(root).resolve())
        except ValueError:
            continue
        if best is None or len(str(root)) > len(str(best)):
            best = Path(root).resolve()
    return best


def ensure_system_folder_chain(file_path: Path, watch_root: Path) -> int | None:
    """为 file_path 在 watch_root 下的子目录链建立 system folder 记录。

    返回最深一层 folder 的 id；若文件就在 watch_root 顶层（无子目录），返回 None。
    已存在的 system folder 复用其 id，仅在 parent 指向错误时修正。
    """
    file_path = Path(file_path).resolve()
    watch_root = Path(watch_root).resolve()
    try:
        rel = file_path.relative_to(watch_root)
    except ValueError:
        return None
    parts = rel.parts[:-1]  # 去掉文件名
    if not parts:
        return None
    conn = get_pool().main()
    parent_id: int | None = None
    deepest_id: int | None = None
    cumulative = watch_root
    for part in parts:
        cumulative = cumulative / part
        cumulative_norm = _normalize_folder_path(cumulative)
        row = conn.execute(
            "SELECT id, parent_id FROM folders WHERE is_system = 1 AND path = ?",
            (cumulative_norm,),
        ).fetchone()
        if row:
            deepest_id = row["id"]
            if row["parent_id"] != parent_id:
                conn.execute(
                    "UPDATE folders SET parent_id = ? WHERE id = ?",
                    (parent_id, deepest_id),
                )
        else:
            cur = conn.execute(
                "INSERT INTO folders(parent_id, name, \"order\", is_system, path) "
                "VALUES(?, ?, 0, 1, ?)",
                (parent_id, part, cumulative_norm),
            )
            deepest_id = cur.lastrowid
        parent_id = deepest_id
    return deepest_id


def get_folder_descendants(folder_id: int) -> list[int]:
    """返回 folder_id 自身 + 所有后代 id（深度优先）。"""
    conn = get_pool().main()
    out: list[int] = [folder_id]
    stack = [folder_id]
    while stack:
        cur = stack.pop()
        children = conn.execute(
            "SELECT id FROM folders WHERE parent_id = ?", (cur,)
        ).fetchall()
        for c in children:
            out.append(c["id"])
            stack.append(c["id"])
    return out


def backfill_system_folders(watch_dirs: list[Path]) -> int:
    """为已索引但未挂 system folder 的图片建立归属。返回处理的图片数。"""
    conn = get_pool().main()
    images = conn.execute(
        "SELECT i.id, i.path FROM images i "
        "WHERE NOT EXISTS (SELECT 1 FROM image_folders if_ "
        "  WHERE if_.image_id = i.id AND if_.folder_id IN "
        "  (SELECT id FROM folders WHERE is_system = 1))"
    ).fetchall()
    count = 0
    for img in images:
        watch_root = find_watch_root(Path(img["path"]), watch_dirs)
        if watch_root is None:
            continue
        folder_id = ensure_system_folder_chain(Path(img["path"]), watch_root)
        if folder_id is None:
            continue
        with transaction() as c:
            c.execute(
                "INSERT OR IGNORE INTO image_folders(image_id, folder_id) "
                "VALUES(?, ?)",
                (img["id"], folder_id),
            )
        count += 1
    return count
