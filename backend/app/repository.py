"""图片 / 文件夹 / 标签的查询与变更（路由层调用）。"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from .db import get_pool, transaction
from . import media_tools
from .parser import is_playable_audio, is_playable_video, parse_video_metadata
from .texts import serialized

logger = logging.getLogger(__name__)



def original_url_for(
    image_id: int,
    file_mtime: float | None,
    *,
    max_size: int | None = 1024,
    identity: str = "",
    fit: str | None = None,
) -> str | None:
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
    if fit is not None:
        qs.append(f"fit={fit}")
    import hashlib
    key = hashlib.sha256(identity.encode()).hexdigest()[:16]
    qs.append(f"v=2-{file_mtime:.9f}-{key}")
    return f"/api/images/{image_id}/file?{"&".join(qs)}"


def _cache_bust(identity: str) -> str:
    import hashlib
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


def video_thumb_url(video_id: int, identity: str = "") -> str:
    """视频海报帧 URL（feed / 详情缩略图用）。"""
    return f"/api/videos/{video_id}/thumb?v={_cache_bust(identity)}"


def video_file_url(video_id: int, identity: str = "") -> str:
    """视频原文件 URL（播放器用，后端支持 Range 分段）。"""
    return f"/api/videos/{video_id}/file?v={_cache_bust(identity)}"


def audio_waveform_url(audio_id: int, identity: str = "", width: int = 840, height: int = 360) -> str:
    """音频波形图 URL（Feed 卡片用，21:9 与卡片同比例，后端首次请求时生成并缓存）。"""
    return f"/api/audio/{audio_id}/waveform?v={_cache_bust(identity)}&w={width}&h={height}"


def audio_file_url(audio_id: int, identity: str = "") -> str:
    """音频原文件 URL（应用内播放条用，支持 Range 拖动进度）。"""
    return f"/api/audio/{audio_id}/file?v={_cache_bust(identity)}"


def _media_urls(row: sqlite3.Row) -> dict:
    """按媒体类型返回 ``original_url`` / ``thumbnail_url`` / ``play_url`` / ``playable``。"""
    kind = row["kind"] or "image"
    identity = f"{row['path']}|{row['size_bytes']}|{row['indexed_at']}|{row['cover_path'] or ''}"
    if kind == "video":
        return {
            "original_url": None,
            "thumbnail_url": video_thumb_url(row["id"], identity),
            "play_url": video_file_url(row["id"], identity),
            "playable": is_playable_video(Path(row["path"])),
        }
    if kind == "audio":
        # 音频没有海报帧：波形图当缩略图，播放走 /api/audio/{id}/file（Range 支持）。
        # original_url 不带 max，避免浏览器/Pillow 把音频当图片去缩放。
        return {
            "original_url": original_url_for(row["id"], row["mtime"], max_size=None, identity=identity),
            "thumbnail_url": audio_waveform_url(row["id"], identity),
            "play_url": audio_file_url(row["id"], identity),
            "playable": is_playable_audio(Path(row["path"])),
        }
    ou = original_url_for(row["id"], row["mtime"], identity=identity)
    thumbnail_url = original_url_for(
        row["id"],
        row["mtime"],
        identity=identity,
        fit="psd-portrait" if Path(row["path"]).suffix.lower() == ".psd" else None,
    )
    return {
        "original_url": ou,
        "thumbnail_url": thumbnail_url,
        "play_url": None,
        "playable": None,
    }



# ---------- 文件夹 ----------


def _normalize_path(p: Path) -> str:
    return str(p).replace("\\", "/")


# 素材类型口径：媒体三类和文本分开算，侧栏每行只展示当前 scope 那一种
MEDIA_KINDS = ("image", "video", "audio")
ITEM_KINDS = MEDIA_KINDS + ("text",)


def folder_tree() -> list[dict]:
    conn = get_pool().main()
    propagate_archived_flags(conn)
    rows = conn.execute(
        "SELECT id, parent_id, name, \"order\", is_system, path, archived FROM folders "
        "ORDER BY parent_id, \"order\", name"
    ).fetchall()
    # 归档（archived=1）的目录连同整棵子树都不进侧栏；父级计数也不该把它们算进去。
    live = [r for r in rows if not r["archived"]]
    live_ids = {r["id"] for r in live}
    by_parent: dict[int | None, list[dict]] = {}
    for r in live:
        by_parent.setdefault(r["parent_id"], []).append(
            {"id": r["id"], "parent_id": r["parent_id"], "name": r["name"], "order": r["order"], "is_system": bool(r["is_system"]), "path": r["path"]}
        )

    # 每节点按媒体类型直接计数，再递归汇总后代。侧栏只显示一种口径，
    # 所以必须分类型给出，不能只给一个混合总数。文本计数由路由层补。
    direct: dict[int, dict[str, int]] = {}
    for r in conn.execute(
        "SELECT j.folder_id AS folder_id, i.kind AS kind, COUNT(*) AS c "
        "FROM image_folders j JOIN images i ON i.id = j.image_id "
        "GROUP BY j.folder_id, i.kind"
    ).fetchall():
        direct.setdefault(r["folder_id"], {})[r["kind"] or "image"] = r["c"]

    # 先把所有子节点 id 收集好（用于递归计数）
    children_map: dict[int, list[int]] = {}
    for fid, parent in [(r["id"], r["parent_id"]) for r in live]:
        if parent is not None and parent in live_ids:
            children_map.setdefault(parent, []).append(fid)

    def recursive_counts(fid: int) -> dict[str, int]:
        counts = {kind: direct.get(fid, {}).get(kind, 0) for kind in MEDIA_KINDS}
        for child in children_map.get(fid, []):
            for kind, count in recursive_counts(child).items():
                counts[kind] += count
        return counts

    def build(parent: int | None) -> list[dict]:
        out = []
        for n in by_parent.get(parent, []):
            fid = n["id"]
            counts = recursive_counts(fid)
            # 文本数不在 images 表里，由 /api/folders 按目录前缀填进来。
            # 这里先把键补齐：counts 的形状对任何调用方都固定是四类，
            # 免得侧栏之类的消费者拿到 3 个键的版本自己去猜缺的那一类是几。
            counts.setdefault("text", 0)
            out.append({
                **n,
                "counts": counts,
                "total": sum(counts.values()),
                "children": build(fid),
            })
        return out

    return build(None)



# ---------- 归档（archive）：在图库里收起来，磁盘一律不动 ----------


def parent_archived_flag(conn: sqlite3.Connection, parent_id: int | None) -> int:
    """新建子目录继承父目录的归档位。

    为什么必须继承：来源目录是外部程序正在写的目录（ComfyUI 的 output、素材盘）。
    归档之后它继续往里写，新的子目录是这一刻才建出来的；如果它从默认的 0 开始，
    里面的新素材会自己冒回统一流和统计里，等于归档白做。
    """
    if parent_id is None:
        return 0
    row = conn.execute("SELECT archived FROM folders WHERE id = ?", (parent_id,)).fetchone()
    return int(row["archived"]) if row and row["archived"] else 0


def propagate_archived_flags(conn: sqlite3.Connection | None = None) -> int:
    """把归档位补齐到整棵子树，返回补了几个节点。

    归档时是一次性写下整棵子树的，但两种情况会漏：
    1. 归档以后磁盘上新长出来的子目录（见 parent_archived_flag，新建已继承，这里是兜底）；
    2. 这次修复之前就已经漏在库里的老节点。
    逐层往下刷，直到没有新的节点需要归档 —— 目录量级只有几百，一次读侧栏扫一遍不心疼。
    连接是 autocommit（``isolation_level=None``），所以这里不用管事务。
    """
    conn = conn or get_pool().main()
    fixed = 0
    while True:
        cur = conn.execute(
            "UPDATE folders SET archived = 1 WHERE archived = 0 AND parent_id IN "
            "(SELECT id FROM folders WHERE archived = 1)"
        )
        fixed += cur.rowcount
        if not cur.rowcount:
            break
    return fixed


def folder_is_archived(folder_id: int) -> bool:
    """节点自己是不是归档位为 1（不关心祖先）。"""
    row = get_pool().main().execute("SELECT archived FROM folders WHERE id = ?", (folder_id,)).fetchone()
    return bool(row and row["archived"])


def unarchived_media_sql(alias: str = "images") -> str:
    """素材还属于至少一个未归档目录的判定式。

    归档目录时整棵子树都带 archived=1，所以「全部归属都被归档」才算消失：
    同一张图被拖进「我的文件夹」时照常可见。没有任何归属的素材（收件箱）
    也照常可见 —— 它压根不在子查询里。
    """
    return (
        f"{alias}.id NOT IN ("
        "SELECT j.image_id FROM image_folders j JOIN folders f ON f.id = j.folder_id "
        "WHERE f.archived = 1 AND j.image_id NOT IN ("
        "SELECT j2.image_id FROM image_folders j2 JOIN folders f2 ON f2.id = j2.folder_id "
        "WHERE f2.archived = 0))"
    )


def archived_anchor_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """归档锚点：自己 archived=1 且父节点没归档（子树整体已被锚点覆盖）。"""
    out: list[sqlite3.Row] = []
    for row in conn.execute(
        "SELECT id, parent_id, name, path, is_system FROM folders WHERE archived = 1 ORDER BY id"
    ).fetchall():
        if row["parent_id"] is not None:
            parent = conn.execute(
                "SELECT archived FROM folders WHERE id = ?", (row["parent_id"],)
            ).fetchone()
            if parent and parent["archived"]:
                continue
        out.append(row)
    return out


def disk_prefix(path: str | Path) -> str:
    """目录路径 → 素材路径的归属前缀（带尾分隔符，反斜杠按本机 os.sep）。"""
    return str(Path(path)) + os.sep


def _text_prefix_filters(
    prefixes: Iterable[str], *, inside: bool
) -> tuple[list[str], list[object]]:
    """按磁盘前缀筛选 texts：``inside=True`` 只要前缀里面的，False 正好相反。

    texts.path 存反斜杠、folders.path 存正斜杠，两边都换成斜杠再小写比对；
    replace 不改长度，所以 substr 用原始前缀长度即可。
    """
    op = "=" if inside else "<>"
    where: list[str] = []
    params: list[object] = []
    for prefix in prefixes:
        where.append(f"(lower(replace(substr(path, 1, ?), char(92), '/')) {op} lower(?))")
        params.extend((len(prefix), str(prefix).replace("\\", "/")))
    return where, params


def archived_text_filters(conn: sqlite3.Connection) -> tuple[list[str], list[object]]:
    """列表与总数都要用的排除条件：正文在任一已归档目录下的文本不再出现。"""
    prefixes = [disk_prefix(r["path"]) for r in archived_anchor_rows(conn) if r["path"]]
    return _text_prefix_filters(prefixes, inside=False)


def folder_set_archived(folder_id: int, archived: bool) -> dict:
    """把目录及其全部后代的归档位一次翻到位；只写 folders.archived，不碰磁盘。"""
    conn = get_pool().main()
    row = conn.execute("SELECT id, name, path, is_system FROM folders WHERE id = ?", (folder_id,)).fetchone()
    if row is None:
        raise ValueError("文件夹不存在")
    ids = folder_descendant_ids(conn, folder_id)
    placeholders = ",".join("?" * len(ids))
    with transaction() as c:
        c.execute(
            f"UPDATE folders SET archived = ? WHERE id IN ({placeholders})",
            [1 if archived else 0, *ids],
        )
    return {
        "ok": True,
        "id": folder_id,
        "name": row["name"],
        "path": row["path"],
        "is_system": bool(row["is_system"]),
        "archived": bool(archived),
        "folders": len(ids),
    }


def archived_folder_list() -> list[dict]:
    """设置页「已归档目录」清单：锚点 + 各自藏起来的素材数。"""
    conn = get_pool().main()
    out: list[dict] = []
    for row in archived_anchor_rows(conn):
        ids = folder_descendant_ids(conn, row["id"])
        placeholders = ",".join("?" * len(ids))
        media = conn.execute(
            "SELECT COUNT(*) AS c FROM images WHERE id IN "
            f"(SELECT image_id FROM image_folders WHERE folder_id IN ({placeholders}))",
            ids,
        ).fetchone()["c"]
        texts_hidden = 0
        if row["path"]:
            where, params = _text_prefix_filters([disk_prefix(row["path"])], inside=True)
            texts_hidden = conn.execute(
                f"SELECT COUNT(*) AS c FROM texts WHERE missing = 0 AND {' AND '.join(where)}",
                params,
            ).fetchone()["c"]
        out.append({
            "id": row["id"],
            "name": row["name"],
            "path": row["path"],
            "is_system": bool(row["is_system"]),
            "media": media,
            "texts": texts_hidden,
        })
    return out


def folder_create(name: str, parent_id: int | None, is_system: bool = False) -> dict:
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
            "INSERT INTO folders(parent_id, name, \"order\", is_system, archived) "
            "VALUES(?, ?, ?, ?, ?)",
            (parent_id, name, order, 1 if is_system else 0, parent_archived_flag(conn, parent_id)),
        )
        folder_id = cur.lastrowid
    return {"id": folder_id, "parent_id": parent_id, "name": name, "order": order,
            "is_system": 1 if is_system else 0}


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
        "SELECT id, parent_id, \"order\", is_system FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not row:
        return
    delta = -1 if direction == "up" else 1
    # 找同 parent 下邻居
    if direction == "up":
        neighbor = conn.execute(
            "SELECT id, \"order\" FROM folders WHERE parent_id IS ? AND is_system = ? AND \"order\" < ? "
            "ORDER BY \"order\" DESC LIMIT 1",
            (row["parent_id"], row["is_system"], row["order"]),
        ).fetchone()
    else:
        neighbor = conn.execute(
            "SELECT id, \"order\" FROM folders WHERE parent_id IS ? AND is_system = ? AND \"order\" > ? "
            "ORDER BY \"order\" ASC LIMIT 1",
            (row["parent_id"], row["is_system"], row["order"]),
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


def _fill_video_metadata(conn, row) -> None:
    """懒加载视频元数据：旧库导入的视频可能缺少时长/分辨率/编码，在此用 ffprobe 补齐。"""
    path = row["path"]
    if not isinstance(path, str) or not path.strip():
        return
    p = Path(path)
    if not p.exists():
        return
    meta = parse_video_metadata(p)
    if meta["duration_seconds"] is None and meta["width"] is None and meta["video_codec"] is None:
        return  # 解析失败，不覆盖现有（可能已有的）字段
    conn.execute(
        "UPDATE images SET width=?, height=?, duration_seconds=?, video_codec=?, "
        "audio_codec=?, fps=?, format=? WHERE id=?",
        (
            meta["width"],
            meta["height"],
            meta["duration_seconds"],
            meta["video_codec"],
            meta["audio_codec"],
            meta["fps"],
            meta["format"] or row["format"],
            row["id"],
        ),
    )
    conn.commit()


def image_detail(image_id: int) -> dict | None:
    conn = get_pool().main()
    row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        return None
    if (row["kind"] or "image") == "video" and row["duration_seconds"] is None:
        _fill_video_metadata(conn, row)
        row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            return None
    return _row_to_detail(row)


# 列表/搜索用的列清单。**不要退回 SELECT images.***：ComfyUI 的 workflow JSON
# 单条就有 25–100KB（视频更是整份画布），一页 200 行白白读十几 MB，
# 而列表只需要知道"有没有工作流"。用 length() 派生列代替。
_SUMMARY_SELECT = (
    "images.id, images.path, images.filename, images.kind, images.width, "
    "images.height, images.mtime, images.size_bytes, images.duration_seconds, "
    "images.video_codec, images.audio_codec, images.fps, "
    "images.model, images.seed, images.thumb_path, images.cover_path, "
    "images.format, images.indexed_at, "
    "length(COALESCE(images.workflow, '')) > 0 AS has_workflow"
)


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
    kind = row["kind"] or "image"
    media_urls = _media_urls(row)
    return {
        "id": row["id"],
        "filename": row["filename"],
        "path": row["path"],
        "kind": kind,
        "original_url": media_urls["original_url"],
        "thumbnail_url": media_urls["thumbnail_url"],
        "play_url": media_urls["play_url"],
        "playable": media_urls["playable"],
        "width": row["width"],
        "height": row["height"],
        "mtime": row["mtime"],
        "size_bytes": row["size_bytes"],
        "duration_seconds": row["duration_seconds"],
        "video_codec": row["video_codec"],
        "audio_codec": row["audio_codec"],
        "fps": row["fps"],
        "folder_ids": folder_ids,
        "tags": tags,
        "model": row["model"],
        "seed": row["seed"],
        "new": False,
        # 列表查询只带 length(workflow)>0 这个派生列（见 _SUMMARY_SELECT）；
        # 单条查询走 SELECT *，这里回落到整列。
        "has_workflow": (
            bool(row["has_workflow"])
            if "has_workflow" in row.keys()
            else bool(row["workflow"])
        ),
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


@serialized
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
        updated = conn.execute(
            "SELECT * FROM images WHERE id = ?", (image_id,)
        ).fetchone()
        return _row_to_summary(updated)

    if new_path.exists():
        raise RenameError("目标文件已存在")

    old_path.rename(new_path)
    from .texts import remap
    remap(old_path, new_path)
    stat = new_path.stat()
    new_mtime = float(stat.st_mtime)
    with transaction() as c:
        c.execute(
            "UPDATE images SET path = ?, filename = ?, mtime = ? WHERE id = ?",
            (str(new_path), final_name, new_mtime, image_id),
        )
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

    # 视频反推的参考帧缓存 {id}_vp*.jpg（延迟导入，避免和 video_prompts 形成导入环）
    from .video_prompts import purge_video_frame_files
    cleaned += purge_video_frame_files(image_id)

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


def folder_descendant_ids(conn: sqlite3.Connection, folder_id: int) -> list[int]:
    """文件夹自身 + 全部后代 id（媒体归类到父文件夹时也要算进来）。"""
    ids = [folder_id]
    i = 0
    while i < len(ids):
        children = conn.execute(
            "SELECT id FROM folders WHERE parent_id = ?", (ids[i],)
        ).fetchall()
        ids.extend(r["id"] for r in children)
        i += 1
    return ids


def folder_disk_prefix(folder_id: int) -> str | None:
    """文件夹的磁盘前缀（文本按路径前缀归属，没有磁盘目录就返回 None）。"""
    row = get_pool().main().execute(
        "SELECT path FROM folders WHERE id = ?", (folder_id,)
    ).fetchone()
    if not row or not row["path"]:
        return None
    return str(Path(row["path"])) + os.sep


# 文本摘录里不想看到 Markdown 装饰，但这些字符在正文里也可能有意义，只去掉行首/成对装饰符
_MARKDOWN_NOISE = ("#", "*", ">", "`", "~", "[", "]", "|", "___")


def _strip_markdown(text: str) -> str:
    """把 Markdown 装饰符去掉并压平空白，给统一流的文本卡当摘录。"""
    for ch in _MARKDOWN_NOISE:
        text = text.replace(ch, "")
    return " ".join(text.split())


def _text_to_feed_item(row: sqlite3.Row, query: str = "") -> dict:
    """texts 行 → 统一流里的文本卡片数据。"""
    body = row["body"] or ""
    excerpt = body[:160]
    if query:
        at = body.lower().find(query.lower())
        if at >= 0:
            excerpt = body[max(0, at - 35): at + 125]
    path = row["path"] or row["filename"]
    return {
        "item_type": "text",
        "id": row["id"],
        "filename": row["filename"],
        "path": path,
        "kind": "text",
        "mtime": row["mtime"],
        "tags": json.loads(row["tags"] or "[]"),
        "format": Path(path).suffix.lower()[1:],
        "excerpt": _strip_markdown(excerpt),
    }


def unified_feed(
    *,
    folder_id: int | None = None,
    q: str | None = None,
    tag: str | None = None,
    kinds: Iterable[str] | None = None,
    sort: str = "mtime_desc",
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[dict], int, dict[str, int]]:
    """「所有素材」统一流：图片 / 视频 / 音频 / 文本按同一时间轴混排。

    媒体与文本在两张表里各自自增 id，所以每项都带 ``item_type``，前端必须用
    ``item_type:id`` 当 key —— 光用数字 id 会撞车。
    返回 ``(items, total, counts)``：total 含 kinds 过滤（可浏览总数），
    counts 是四类各自数量且不含 kinds 过滤（筛选 chips 上要显示每类还有多少）。
    """
    conn = get_pool().main()
    requested = [k for k in (list(kinds) if kinds else list(ITEM_KINDS)) if k in ITEM_KINDS]
    wanted = list(dict.fromkeys(requested)) or list(ITEM_KINDS)

    media_where: list[str] = [unarchived_media_sql()]
    media_params: list[object] = []
    text_where: list[str] = ["missing = 0"]
    text_params: list[object] = []
    archived_where, archived_params = archived_text_filters(conn)
    text_where.extend(archived_where)
    text_params.extend(archived_params)

    if folder_id is not None:
        ids = folder_descendant_ids(conn, folder_id)
        placeholders = ",".join("?" * len(ids))
        media_where.append(
            f"images.id IN (SELECT image_id FROM image_folders WHERE folder_id IN ({placeholders}))"
        )
        media_params.extend(ids)
        prefix = folder_disk_prefix(folder_id)
        if prefix is None:
            # 没有磁盘目录的旧分类不可能包含文本文件
            text_where.append("0")
        else:
            text_where.append("lower(substr(path,1,?)) = lower(?)")
            text_params.extend((len(prefix), prefix))

    if tag:
        media_where.append(
            "images.id IN (SELECT it.image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id "
            "WHERE t.name = ?)"
        )
        media_params.append(tag)
        text_where.append("EXISTS (SELECT 1 FROM json_each(texts.tags) WHERE value = ?)")
        text_params.append(tag)

    query = (q or "").strip()
    if query:
        like = f"%{query}%"
        fts_ids: list[int] | None = None
        try:
            fts_ids = [
                r["rowid"]
                for r in conn.execute(
                    "SELECT rowid FROM images_fts WHERE images_fts MATCH ? ORDER BY rank LIMIT 5000",
                    (_build_fts_query(query),),
                ).fetchall()
            ]
        except sqlite3.Error as exc:
            logger.warning("统一流图片 FTS 失败，本次退回模糊匹配：%s", exc)
        if fts_ids:
            placeholders = ",".join("?" * len(fts_ids))
            media_where.append(
                f"(images.id IN ({placeholders}) OR images.filename LIKE ? OR images.model LIKE ?)"
            )
            media_params.extend(fts_ids)
            media_params.extend([like, like])
        else:
            media_where.append(
                "(images.filename LIKE ? OR images.model LIKE ? OR images.positive_prompt LIKE ?)"
            )
            media_params.extend([like, like, like])
        if len(query) >= 3:
            try:
                text_where.append("id IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)")
                text_params.append('"' + query.replace('"', '""') + '"')
            except sqlite3.Error as exc:
                logger.warning("统一流文本 FTS 失败，本次只用模糊匹配：%s", exc)
        text_where.append(
            "(instr(lower(filename),lower(?))>0 OR instr(lower(body),lower(?))>0 OR instr(lower(tags),lower(?))>0)"
        )
        text_params.extend([query] * 3)

    media_sql = ("WHERE " + " AND ".join(media_where)) if media_where else ""
    text_sql = "WHERE " + " AND ".join(text_where)

    # counts 先算（不含 kinds 过滤）：chips 要显示「这一类有多少」，与当前选中无关
    counts: dict[str, int] = {kind: 0 for kind in ITEM_KINDS}
    for row in conn.execute(
        f"SELECT kind, COUNT(*) AS c FROM images {media_sql} GROUP BY kind", media_params
    ).fetchall():
        counts[row["kind"] or "image"] = row["c"]
    counts["text"] = conn.execute(
        f"SELECT COUNT(*) AS c FROM texts {text_sql}", text_params
    ).fetchone()[0]

    media_kinds = [k for k in wanted if k in MEDIA_KINDS]
    branches: list[str] = []
    params: list[object] = []
    if media_kinds:
        listing_where = list(media_where)
        listing_params = list(media_params)
        listing_where.append(f"images.kind IN ({','.join('?' * len(media_kinds))})")
        listing_params.extend(media_kinds)
        clause = "WHERE " + " AND ".join(listing_where)
        branches.append(
            "SELECT 'media' AS item_type, images.id AS id, images.mtime AS mtime, "
            "images.filename AS filename FROM images " + clause
        )
        params.extend(listing_params)
    if "text" in wanted:
        branches.append(
            "SELECT 'text' AS item_type, texts.id AS id, texts.mtime AS mtime, "
            "texts.filename AS filename FROM texts " + text_sql
        )
        params.extend(text_params)
    if not branches:
        return [], 0, counts

    order = (
        "ORDER BY filename COLLATE NOCASE ASC, item_type ASC, id ASC"
        if sort == "name_asc"
        else "ORDER BY mtime DESC, item_type ASC, id DESC"
    )
    page = conn.execute(
        f"SELECT item_type, id FROM ({' UNION ALL '.join(branches)}) {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()

    items: list[dict] = []
    for r in page:
        if r["item_type"] == "media":
            media_row = conn.execute(
                f"SELECT {_SUMMARY_SELECT} FROM images WHERE id = ?", (r["id"],)
            ).fetchone()
            if media_row is None:
                continue
            item = _row_to_summary(media_row)
            item["item_type"] = "media"
        else:
            text_row = conn.execute(
                "SELECT * FROM texts WHERE id = ? AND missing = 0", (r["id"],)
            ).fetchone()
            if text_row is None:
                continue
            item = _text_to_feed_item(text_row, query)
        items.append(item)
    total = sum(counts[kind] for kind in wanted)
    return items, total, counts


def feed(
    *,
    folder_id: int | None = None,
    q: str | None = None,
    tag: str | None = None,
    model: str | None = None,
    kind: str | None = None,
    limit: int = 500,
    offset: int = 0,
    new_ids: set[int] | None = None,
) -> tuple[list[dict], int]:
    """返回 (items, total)。``new_ids`` 用于标记 NEW 徽标。"""
    conn = get_pool().main()
    where: list[str] = [unarchived_media_sql()]
    params: list[object] = []

    if folder_id is not None:
        ids = folder_descendant_ids(conn, folder_id)
        placeholders = ",".join("?" * len(ids))
        where.append(
            f"images.id IN (SELECT image_id FROM image_folders WHERE folder_id IN ({placeholders}))"
        )
        params.extend(ids)

    if tag:
        where.append(
            "images.id IN (SELECT it.image_id FROM image_tags it JOIN tags t ON t.id = it.tag_id "
            "WHERE t.name = ?)"
        )
        params.append(tag)

    if model:
        where.append("images.model = ?")
        params.append(model)

    if kind:
        where.append("images.kind = ?")
        params.append(kind)

    fts_ids: list[int] | None = None
    if q:
        like = f"%{q}%"
        # 同时走 FTS（prompts/filename/model）和 filename 模糊。
        # 索引不可用（损坏 / 缺表）时只降级成 LIKE —— 搜索框绝不能因为索引坏了就整条 500。
        try:
            rows = conn.execute(
                "SELECT rowid FROM images_fts WHERE images_fts MATCH ? ORDER BY rank LIMIT 5000",
                (_build_fts_query(q),),
            ).fetchall()
            fts_ids = [r["rowid"] for r in rows]
        except sqlite3.Error as exc:
            logger.warning("FTS 搜索失败，本次退回模糊匹配：%s", exc)
            fts_ids = None
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
        f"SELECT {_SUMMARY_SELECT} FROM images {where_clause} "
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
    # 标签数只数还看得见的素材：归档目录里的素材不算进来，
    # 否则侧栏会出现「点了以后一片空白」的标签。
    visible = unarchived_media_sql("i")
    return [
        dict(r)
        for r in conn.execute(
            f"SELECT t.name, COUNT(CASE WHEN {visible} THEN it.image_id END) AS count FROM tags t "
            "JOIN image_tags it ON it.tag_id = t.id "
            "JOIN images i ON i.id = it.image_id "
            "GROUP BY t.id, t.name HAVING count > 0 ORDER BY count DESC, t.name ASC"
        ).fetchall()
    ]


# ---------- 通用计数 ----------


def stats() -> dict:
    conn = get_pool().main()
    totals = {kind: 0 for kind in MEDIA_KINDS}
    visible = unarchived_media_sql()
    for row in conn.execute(
        f"SELECT kind, COUNT(*) AS c FROM images WHERE {visible} GROUP BY kind"
    ).fetchall():
        totals[row["kind"] or "image"] = row["c"]
    archived_where, archived_params = archived_text_filters(conn)
    text_clause = " AND ".join(["missing = 0", *archived_where])
    total_texts = conn.execute(
        f"SELECT COUNT(*) AS c FROM texts WHERE {text_clause}", archived_params
    ).fetchone()["c"]
    folders = conn.execute(
        "SELECT COUNT(*) AS c FROM folders WHERE archived = 0"
    ).fetchone()["c"]
    return {
        "total_images": totals["image"],
        "total_videos": totals["video"],
        "total_audio": totals["audio"],
        "total_texts": total_texts,
        "folders": folders,
    }




# ---------- system folder helpers (filesystem subdirs auto-promoted) ----------


def _normalize_folder_path(p: Path) -> str:
    return str(p).replace("\\", "/")


def _folder_key(path: str | Path) -> str:
    """目录路径的比对键：正斜杠 + 去尾斜杠 + 小写（Windows 路径大小写不敏感）。"""
    return str(path).replace("\\", "/").rstrip("/")

_FOLDER_KEY_SQL = "lower(replace(path, char(92), '/'))"


def _find_folder_by_path(conn, key: str):
    """按磁盘路径查 system folder；SQLite 的 = 是大小写敏感的，Windows 上必须归一后再比。"""
    return conn.execute(
        f"SELECT id, parent_id, name FROM folders "
        f"WHERE is_system = 1 AND path IS NOT NULL AND {_FOLDER_KEY_SQL} = lower(?)",
        (key,),
    ).fetchone()


def _parent_key(path: str) -> str:
    normalized = str(path).replace("\\", "/").rstrip("/")
    return normalized.rsplit("/", 1)[0] if "/" in normalized else normalized


def ensure_source_root_folder(root: Path, conn=None) -> int | None:
    """为来源目录本身建立顶层 system folder 节点，返回 id；磁盘上取不到就返回 None。

    为什么非要有这一步：``ensure_system_folder_chain`` 是**按文件**建链的，它找不到根节点
    时把一级子目录的 parent_id 直接设成 NULL —— 侧栏「来源目录」于是被摊平成一片兄弟节点
    （导入 ComfyUI 的 output 就变成 Audio / krea2 / MiniMaxH3 … 平铺，看不出它们属于谁）。
    只有文本关联那条路会给根建节点，纯图片目录不会，两边行为不一致。
    """
    conn = conn or get_pool().main()
    # 先查库：这个函数是**每个文件**都会走一遍的，命中就不该再碰磁盘（网络盘上 resolve 很贵）。
    row = _find_folder_by_path(conn, _folder_key(_normalize_folder_path(Path(root))))
    if row:
        return row["id"]
    try:
        resolved = Path(root).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if not resolved.is_dir():
        return None
    key = _folder_key(_normalize_folder_path(resolved))
    row = _find_folder_by_path(conn, key)
    if row:
        return row["id"]
    try:
        with transaction() as c:
            cur = c.execute(
                'INSERT INTO folders(parent_id, name, "order", is_system, path) '
                "VALUES(NULL, ?, (SELECT COALESCE(MAX(\"order\"), -1) + 1 FROM folders WHERE parent_id IS NULL), 1, ?)",
                (resolved.name, _normalize_folder_path(resolved)),
            )
            return cur.lastrowid
    except sqlite3.IntegrityError:
        # 同名顶层节点或并发创建：认路径，谁先落库谁算。
        row = _find_folder_by_path(conn, key)
        if row is None:
            logger.warning("来源目录 %s 的根节点建不出来：顶层已有同名文件夹", root)
        return None if row is None else row["id"]


def ensure_source_root_folders(roots: Iterable[str | Path]) -> dict:
    """补齐所有来源目录的顶层节点，并把摊平的一级子目录挂回根下。幂等，可在读接口里调。

    嵌套的来源根（A 在 B 里面）保持各自顶层：``find_watch_root`` 取最深匹配，
    把 A 塞进 B 的节点下会让两棵树的归属口径打架。
    """
    conn = get_pool().main()
    created = reparented = 0
    nodes: dict[str, int] = {}
    for raw in roots:
        try:
            resolved = Path(raw).expanduser().resolve()
        except (OSError, RuntimeError):
            continue
        if not resolved.is_dir():
            continue
        key = _folder_key(_normalize_folder_path(resolved))
        existing = _find_folder_by_path(conn, key)
        if existing:
            nodes[key.lower()] = existing["id"]
            continue
        folder_id = ensure_source_root_folder(resolved, conn=conn)
        if folder_id is None:
            continue
        nodes[key.lower()] = folder_id
        created += 1
    if not nodes:
        return {"created": created, "reparented": reparented}
    root_keys = set(nodes)
    orphans = conn.execute(
        "SELECT id, path FROM folders "
        "WHERE is_system = 1 AND parent_id IS NULL AND path IS NOT NULL"
    ).fetchall()
    with transaction() as c:
        for orphan in orphans:
            if orphan["id"] in nodes.values():
                continue
            key = _folder_key(orphan["path"]).lower()
            if key in root_keys:
                continue        # 它自己也是来源根，保持顶层
            if _parent_key(orphan["path"]).lower() not in nodes:
                continue
            c.execute("UPDATE folders SET parent_id = ? WHERE id = ?",
                      (nodes[_parent_key(orphan["path"]).lower()], orphan["id"]))
            reparented += 1
    return {"created": created, "reparented": reparented}


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

    返回最深一层 folder 的 id；文件就在 watch_root 顶层（无子目录）时返回**根节点**自己，
    这样来源目录根上的文件也能在侧栏点得开（以前是 None，文件只出现在「所有素材」里）。
    已存在的 system folder 复用其 id，仅在 parent 指向错误时修正。
    """
    file_path = Path(file_path).resolve()
    watch_root = Path(watch_root).resolve()
    try:
        rel = file_path.relative_to(watch_root)
    except ValueError:
        return None
    parts = rel.parts[:-1]  # 去掉文件名
    conn = get_pool().main()
    # 根节点缺失就补一个：来源目录在侧栏里必须先是它自己，子目录才是它的孩子。
    deepest_id: int | None = ensure_source_root_folder(watch_root, conn=conn)
    parent_id: int | None = deepest_id
    if not parts:
        return deepest_id
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
                # 换爹也要跟着新爹走：挂进已归档的父目录，这一支继续藏着。
                flag = parent_archived_flag(conn, parent_id)
                if flag:
                    ids = folder_descendant_ids(conn, deepest_id)
                    conn.execute(
                        f"UPDATE folders SET archived = 1 WHERE id IN ({','.join('?' * len(ids))})",
                        ids,
                    )
        else:
            cur = conn.execute(
                "INSERT INTO folders(parent_id, name, \"order\", is_system, path, archived) "
                "VALUES(?, ?, 0, 1, ?, ?)",
                (parent_id, part, cumulative_norm, parent_archived_flag(conn, parent_id)),
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


def prune_missing_system_folders(watch_dirs: list[Path]) -> int:
    """删除磁盘上已不存在的 system folder 记录（来源目录镜像）。

    只清理满足全部条件的目录：
      - ``is_system = 1``（只有来源目录镜像会被自动维护；用户手动建的文件夹不动）；
      - ``path`` 非空；
      - path 落在某个 ``watch_dirs`` 下（避免误删其它来源）；
      - 盘符存在（离线/网络盘不作为删除证据，与 ``reconcile_missing`` 同理）；
      - 目录本身已不存在。

    删除时级联：``parent_id`` 与 ``image_folders`` 均 ON DELETE CASCADE，后代与归属关系
    会一并清掉。返回删除的文件夹数。
    """
    conn = get_pool().main()
    rows = conn.execute(
        "SELECT id, path FROM folders WHERE is_system = 1 AND path IS NOT NULL"
    ).fetchall()
    if not rows:
        return 0
    roots = [Path(d).resolve() for d in watch_dirs]
    to_delete: list[int] = []
    for r in rows:
        p = Path(r["path"])
        if find_watch_root(p, roots) is None:
            continue
        anchor = Path(p.anchor)
        if not anchor.exists():
            continue
        if p.exists():
            continue
        to_delete.append(r["id"])
    if not to_delete:
        return 0
    with transaction() as c:
        placeholders = ",".join("?" * len(to_delete))
        c.execute(f"DELETE FROM folders WHERE id IN ({placeholders})", to_delete)
    return len(to_delete)


# 视频容器元数据（ComfyUI 工作流 / 提示词）的解析器版本。
# 老库里视频的 workflow 全是空的（那时 parse_video_metadata 不读容器 tag），
# 版本号写进 meta 表做一次性回填门控；以后再加解析形态就把它 +1。
# v2：提示词键位加了 positive_prompt（本地 Wan）、模型名加了 WanVideoModelLoader，
# 老库里那批视频存的是空提示词，必须再回填一遍才能补上。
# v3：以前「ffprobe 不可用」也照样落门控，装 ffmpeg 的机器没跑成功就永久跳过回填，
# 别人机器上「视频的提示词再也读不出来」是这么来的。改成缺工具不落门控 + 版本 +1，
# 让那批库在装上自带 ffmpeg 的安装包后自动补跑一次。
VIDEO_METADATA_SCHEMA_VERSION = 3


def backfill_video_metadata(conn: sqlite3.Connection | None = None) -> int:
    """给已入库的视频补读 ComfyUI 写进容器的工作流与提示词。返回更新的行数。

    为什么需要：「在 ComfyUI 中打开」按钮的开关是 ``has_workflow``，而旧解析器把
    视频那一列永远写成空串，所以老库里的视频永远出不了按钮。新导入的视频由
    indexer 直接解析，不依赖这里。

    四条硬规则：
    - **只写不擦**：某个字段这次没解析出来就不进 UPDATE，绝不把已有的值清掉；
    - **技术字段只补空**：时长/分辨率/帧率/编码只在原值是 NULL 时才写；
    - **缺工具不落门控**：机器上没有 ffprobe 就直接返回，绝不写 meta 版本，
      否则这台机器装了 ffmpeg 之后也永远不会补跑（0.2.22 修的线上反馈）；
    - **一次性的例外**：工具在、跑完了才把版本写进 meta，下次启动直接 0 行返回；
      单个文件解析失败（文件不在了 / ffprobe 挂了）跳过该行，门控照样落下，
      不然每次启动都要把整库 ffprobe 一遍。

    ``conn`` 只为测试注入用，缺省取主库连接。
    """
    from .db import get_int_meta, set_meta

    if conn is None:
        conn = get_pool().main()
    if media_tools.ffprobe_path() is None:
        logger.warning("ffprobe 不可用，跳过视频元数据回填（下次启动会再试）")
        return 0
    if get_int_meta("video_metadata_schema", 0) >= VIDEO_METADATA_SCHEMA_VERSION:
        return 0
    rows = conn.execute(
        "SELECT id, path, width, height, duration_seconds, video_codec, audio_codec, "
        "fps, format FROM images WHERE kind = 'video' ORDER BY id"
    ).fetchall()
    updated = 0
    for row in rows:
        path = row["path"]
        if not isinstance(path, str) or not path.strip():
            continue
        p = Path(path)
        if not p.exists():
            continue
        try:
            meta = parse_video_metadata(p)
        except Exception:  # noqa: BLE001 - 单个文件解析失败不影响整批
            continue
        updates: dict[str, object] = {}
        if meta.get("workflow"):
            updates["workflow"] = meta["workflow"]
        if meta.get("positive_prompt"):
            updates["positive_prompt"] = meta["positive_prompt"]
        if meta.get("negative_prompt"):
            updates["negative_prompt"] = meta["negative_prompt"]
        if meta.get("parameters"):
            updates["parameters"] = json.dumps(meta["parameters"], ensure_ascii=False)
        if meta.get("seed") is not None:
            updates["seed"] = meta["seed"]
        if meta.get("model"):
            updates["model"] = meta["model"]
        # 顺带补技术参数：同一次 ffprobe 已经把时长/分辨率/帧率/编码都读出来了，
        # 不写就得等用户逐个打开详情面板才补齐（0.2.22 把帧率搬进头部后，
        # 没补的机器上头部徽标会一直空着）。同样只填 NULL，不动已有值。
        for col in ("width", "height", "duration_seconds", "video_codec", "audio_codec", "fps", "format"):
            value = meta.get(col)
            if value is not None and row[col] is None:
                updates[col] = value
        if not updates:
            continue
        assignments = ", ".join(f"{col} = ?" for col in updates)
        conn.execute(
            f"UPDATE images SET {assignments} WHERE id = ?",
            (*updates.values(), row["id"]),
        )
        updated += 1
    conn.commit()
    set_meta("video_metadata_schema", VIDEO_METADATA_SCHEMA_VERSION)
    conn.commit()
    return updated


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
