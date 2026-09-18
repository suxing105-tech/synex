"""/api/images 路由：feed / detail / 删除 / 标签 / 收藏。"""
from __future__ import annotations

import logging
import asyncio
import os
import re
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile

from .. import repository
from ..config import inbox_dir
from ..folder_storage import target_directory

log = logging.getLogger(__name__)
from ..db import get_pool
from ..indexer import get_indexer
from ..events import get_bus
from ..models import (
    ImageDetail,
    ImportResponse,
    ImportResultItem,
    ImportSkippedItem,
)

router = APIRouter(prefix="/api/images", tags=["images"])


@router.get("")
def list_images(
    folder_id: int | None = None,
    view: str | None = None,
    q: str | None = None,
    tag: str | None = None,
    model: str | None = None,
    limit: int = Query(default=500, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    items, total = repository.feed(
        folder_id=folder_id,
        view=view,
        q=q,
        tag=tag,
        model=model,
        limit=limit,
        offset=offset,
    )
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{image_id}")
def get_image(image_id: int) -> ImageDetail:
    row = repository.image_detail(image_id)
    if not row:
        raise HTTPException(404, "图片不存在")
    return row


@router.get("/{image_id}/file")
def get_original(image_id: int, request: Request, max: int | None = Query(default=None, ge=64, le=4096)):
    """返回原图字节流（Lightbox / Feed 预览用）。

    参数：
    - max: 可选，缩放后最长边（像素）。None/缺省 = 原图。
      例如 max=1024 把图缩到最长边 1024 像素再返回（WebP 编码，落盘缓存到 previews/）。
      feed 用 ?max=1024 拿 ~200KB 预览代替 2-5MB 原图。

    缓存策略：
    - 原图 / 预览一旦落盘基本不变，按 mtime 给 1 年 Cache-Control + ETag/Last-Modified
    - 浏览器再请求时直接 304 不传 body，省流量
    - 文件被覆盖后 mtime 变 → URL ?v= 变 + ETag 变 → 浏览器重新拉
    - 预览缓存命中（同 max_size + 缓存 mtime >= 源 mtime）→ 直接返回，不解码原图
    """
    import email.utils
    from pathlib import Path
    from fastapi.responses import FileResponse, Response
    from ..db import get_pool

    row = get_pool().main().execute(
        "SELECT path, filename, mtime FROM images WHERE id = ?", (image_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "图片不存在")
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "原文件不存在")
    mtime = float(row["mtime"] or 0.0)
    stat = p.stat()

    # 决定要服务的物理文件：原图 or 预览缓存
    if max is not None:
        from ..thumbnails import generate_preview
        preview_path = generate_preview(p, image_id, max)
        if preview_path is None:
            raise HTTPException(500, "预览生成失败")
        preview_stat = preview_path.stat()
        serve_path = preview_path
        fname_stem = Path(row["filename"]).stem
        serve_filename = f"{fname_stem}_max{max}.webp"
        etag = f'"{int(mtime)}-{stat.st_size}-max{max}-{preview_stat.st_size}"'
        last_modified_dt = email.utils.formatdate(preview_stat.st_mtime, usegmt=True)
    else:
        serve_path = p
        serve_filename = row["filename"]
        etag = f'"{int(mtime)}-{stat.st_size}"'
        last_modified_dt = email.utils.formatdate(mtime, usegmt=True)

    # 304 Not Modified: client 带 If-None-Match 或 If-Modified-Since 来就回 304
    if_none_match = request.headers.get("if-none-match")
    if_modified_since = request.headers.get("if-modified-since")
    if if_none_match == etag or (
        if_modified_since and if_modified_since == last_modified_dt
    ):
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Last-Modified": last_modified_dt,
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

    return FileResponse(
        serve_path,
        filename=serve_filename,
        headers={
            "ETag": etag,
            "Last-Modified": last_modified_dt,
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.delete("/{image_id}")
def delete_image(image_id: int, remove_file: bool = True):
    """从数据库删除图片，同时清理磁盘文件 + 缩略图缓存 + 预览缓存。

    - remove_file=True（默认，对应右键菜单"删除图片"）：
        删 DB 行、删原 PNG、删 thumb_path、删 previews/{id}_max*.webp 全部
    - remove_file=False：
        仅删 DB 行 + 清 previews/{id}_max*.webp（保留原文件）

    404 → 图片不存在
    500 → 删除原文件时遇到 OSError
    """
    if not remove_file:
        conn = get_pool().main()
        row = conn.execute("SELECT id FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(404, "图片不存在")
        cleaned = 0
        from ..config import previews_dir
        pd = previews_dir()
        if pd.exists():
            for f in pd.glob(f"{image_id}_max*.webp"):
                try:
                    f.unlink()
                    cleaned += 1
                except OSError:
                    pass
        conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
        return {"ok": True, "id": image_id, "removed_file": False, "cleaned_previews": cleaned}

    try:
        result = repository.delete_image_files(image_id)
    except repository.RenameError as e:
        if str(e) == "not_found":
            raise HTTPException(404, "图片不存在")
        raise HTTPException(500, str(e))
    except OSError as e:
        raise HTTPException(500, f"删除文件失败: {e}")
    return {"ok": True, **result}


@router.post("/{image_id}/favorite")
def toggle_favorite(image_id: int, favorite: bool = True):
    repository.set_favorite(image_id, favorite)
    return {"id": image_id, "favorite": favorite}


@router.post("/{image_id}/tags")
def update_tags(image_id: int, payload: dict):
    tags = payload.get("tags", []) or []
    if not repository.image_detail(image_id):
        raise HTTPException(404, "图片不存在")
    cleaned = repository.set_tags(image_id, tags)
    return {"id": image_id, "tags": cleaned}


@router.post("/{image_id}/folder")
def update_folder(image_id: int, payload: dict):
    folder_id = payload.get("folder_id")
    if not repository.image_detail(image_id):
        raise HTTPException(404, "图片不存在")
    if folder_id is not None:
        # 校验文件夹存在
        conn = get_pool().main()
        exists = conn.execute("SELECT id FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "文件夹不存在")
    repository.assign_folder(image_id, folder_id)
    return {"id": image_id, "folder_id": folder_id}


@router.post("/bulk-assign-folder")
def bulk_update_folder(payload: dict):
    """把多张图批量移动到指定 user folder（替换式）。

    body: ``{"image_ids": [int, ...], "folder_id": int | null}``

    - folder_id=null：把图从所有 user folder 移出（保留 system folder 自动挂的归属）
    - folder_id=int：必须存在且 is_system=0
    """
    image_ids = payload.get("image_ids") or []
    if not isinstance(image_ids, list) or not image_ids:
        raise HTTPException(400, "image_ids 必须为非空数组")
    cleaned_ids: list[int] = []
    for x in image_ids:
        if isinstance(x, int) and not isinstance(x, bool):
            cleaned_ids.append(x)
    if not cleaned_ids:
        raise HTTPException(400, "image_ids 没有合法的 int 元素")
    folder_id = payload.get("folder_id")
    if folder_id is not None and (not isinstance(folder_id, int) or isinstance(folder_id, bool)):
        raise HTTPException(400, "folder_id 必须为 int 或 null")
    try:
        repository.bulk_assign_folder(cleaned_ids, folder_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ids": cleaned_ids, "folder_id": folder_id}


@router.patch("/{image_id}/filename")
def rename_image(image_id: int, payload: dict):
    """重命名图片文件 + 更新索引。

    body: { "filename": "<新文件名>" }
    成功 → 200 + 更新后的 ImageSummary
    404 → 图片不存在或原文件已被移走
    400 → 文件名非法
    409 → 同目录已有同名文件
    """
    new_filename = payload.get("filename") if isinstance(payload, dict) else None
    try:
        updated = repository.rename_image(image_id, new_filename or "")
    except repository.RenameError as e:
        msg = str(e)
        if msg == "not_found":
            raise HTTPException(404, "图片不存在")
        if msg == "目标文件已存在":
            raise HTTPException(409, msg)
        raise HTTPException(400, msg)
    return updated


@router.post("/{image_id}/reveal")
def reveal_image(image_id: int):
    """在操作系统默认文件管理器里打开图片所在位置。

    多策略兜底（按顺序尝试）：
    - Windows: explorer /select,path → explorer.exe 父目录 → os.startfile 父目录
    - macOS:   open -R path → open 父目录
    - 其它:    xdg-open 父目录

    即便所有策略失败（headless 容器无 GUI），只要 path 存在就返回 200，
    前端通过 method 字段知道是否真启动了 Shell，避免无意义的 500。
    """
    import logging
    import platform
    import subprocess
    from pathlib import Path

    path_str = repository.image_reveal_path(image_id)
    if not path_str:
        raise HTTPException(404, "图片或文件不存在")
    p = Path(path_str)
    parent = p.parent
    system = platform.system().lower()
    log = logging.getLogger(__name__)

    chosen = ""

    def try_exec(name, fn):
        nonlocal chosen
        if chosen:
            return True
        try:
            fn()
            chosen = name
            return True
        except (OSError, FileNotFoundError, ValueError) as e:
            log.debug("reveal fallback %s failed: %s", name, e)
            return False

    if system == "windows":
        try_exec("explorer-select", lambda: subprocess.Popen(
            ["explorer.exe", f"/select,{p}"], close_fds=True,
        ))
        if not chosen:
            try_exec("explorer-dir", lambda: subprocess.Popen(
                ["explorer.exe", str(parent)], close_fds=True,
            ))
        if not chosen and hasattr(os, "startfile"):
            try_exec("startfile-dir", lambda: os.startfile(str(parent)))
    elif system == "darwin":
        try_exec("open-R", lambda: subprocess.Popen(["open", "-R", str(p)]))
        if not chosen:
            try_exec("open-dir", lambda: subprocess.Popen(["open", str(parent)]))
    else:
        try_exec("xdg-open-dir", lambda: subprocess.Popen(["xdg-open", str(parent)]))

    return {
        "ok": True,
        "id": image_id,
        "path": str(p),
        "method": chosen or "noop",
        "platform": system,
    }


from ..parser import SUPPORTED_EXTS
_ALLOWED_EXTS = SUPPORTED_EXTS
_MAX_FILE_BYTES = 100 * 1024 * 1024  # 100 MB 单文件上限
_FILENAME_BAD = re.compile(r"[\\/\x00-\x1f\x7f]+")
_FILENAME_TRAILING_DOTS = re.compile(r"^[.]+|[.]+$")


def _sanitize_filename(raw: str) -> str:
    """把用户拖入的文件名清洗成安全的目标名。

    - 去掉所有路径分隔符（含 Windows 反斜杠 + 正斜杠）和控制字符；
    - 去掉首尾点（避免 ".png" / "..png" 这类容易出问题的名）；
    - 空名 / 全清洗掉 → 返回 None，由调用方换成默认名。
    """
    if not raw:
        return None
    # 取 basename：手动剥路径部分
    name = raw.replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = _FILENAME_BAD.sub("_", name).strip().strip(".")
    cleaned = _FILENAME_TRAILING_DOTS.sub("", cleaned)
    return cleaned or None


def _ensure_unique(target_dir: Path, filename: str) -> Path:
    """同名追加 _1 _2 直到不冲突。"""
    target = target_dir / filename
    if not target.exists():
        return target
    stem = target.stem
    ext = target.suffix
    i = 1
    while True:
        cand = target_dir / f"{stem}_{i}{ext}"
        if not cand.exists():
            return cand
        i += 1
        if i > 9999:  # 防止极端情况死循环
            raise HTTPException(500, "收件箱内同名文件过多")


@router.post("/import")
def import_images(
    files: list[UploadFile] = File(..., description="拖入的图片文件"),
    folder_id: int | None = Form(default=None, description="目标虚拟文件夹 id；None = 不分配文件夹"),
):
    """把拖入的文件保存到 data/inbox/ 并立即入库；可选自动归到指定文件夹。

    - 仅接收 .png / .webp（与 indexer 的 SUPPORTED_EXTS 对齐），其它进 skipped 列表。
    - 文件名冲突自动追加 _1 _2...
    - 直接调用 Indexer._process_path_sync 索引，不走 watchdog（inbox 不在 watch_dirs）。
    - folder_id 校验存在；不存在 → 400。
    """
    if not files:
        raise HTTPException(400, "files 不能为空")

    # 校验 folder_id（如有）
    if folder_id is not None:
        from ..db import get_pool

        row = (
            get_pool()
            .main()
            .execute("SELECT id FROM folders WHERE id = ?", (folder_id,))
            .fetchone()
        )
        if not row:
            raise HTTPException(400, f"文件夹 {folder_id} 不存在")

    try:
        inbox = target_directory(folder_id)
    except (ValueError, OSError) as error:
        raise HTTPException(400, str(error)) from error
    indexer = get_indexer()
    saved: list[ImportResultItem] = []
    skipped: list[ImportSkippedItem] = []

    for f in files:
        original_name = f.filename or ""
        ext = Path(original_name).suffix.lower()
        if ext not in _ALLOWED_EXTS:
            skipped.append(
                ImportSkippedItem(filename=original_name, reason="unsupported_format")
            )
            continue

        safe_name = _sanitize_filename(original_name)
        if not safe_name:
            safe_name = f"image{ext}"

        try:
            target = _ensure_unique(inbox, safe_name)
        except HTTPException:
            skipped.append(
                ImportSkippedItem(filename=original_name, reason="name_collision_exhausted")
            )
            continue

        try:
            content = f.file.read()
            if len(content) > _MAX_FILE_BYTES:
                skipped.append(
                    ImportSkippedItem(filename=original_name, reason="too_large")
                )
                continue
            target.write_bytes(content)
        except OSError as e:
            log.warning("write failed: %s (%s)", target, e)
            skipped.append(
                ImportSkippedItem(filename=original_name, reason="write_failed")
            )
            continue

        payload = indexer._process_path_sync(target)
        if not payload:
            skipped.append(
                ImportSkippedItem(filename=target.name, reason="indexed_failed")
            )
            continue

        image_id = payload["id"]
        if folder_id is not None:
            repository.assign_folder(image_id, folder_id)

        # 拖入的图入库后必须像 watchdog 一样广播 image_indexed，
        # 否则前端 WS 不会刷新 feed，缩略图要等手动刷新才出现。
        # 走 indexer 自带的 emit 路径：与 watchdog `_flush_pending` 同源，
        # 复用 lifespan 启动时挂上的主 asyncio 循环。
        if not indexer.emit_event_sync(payload):
            # 没有可用的运行中循环（单元测试 / 同步脚本）→ 直接同步 publish 兜底。
            try:
                asyncio.run(get_bus().publish(payload))
            except RuntimeError:
                pass

        saved.append(
            ImportResultItem(
                id=image_id,
                filename=target.name,
                path=str(target),
            )
        )

    return ImportResponse(
        saved=saved,
        skipped=skipped,
        folder_id=folder_id,
        inbox_dir=str(inbox),
    )


@router.post("/copy-files")
@router.post("/move-files", include_in_schema=False)
def copy_dropped_files(payload: dict):
    from ..file_transfer import copy_files
    paths = payload.get('paths')
    if not isinstance(paths, list) or not paths or len(paths) > 2000 or any(not isinstance(p, str) or not Path(p).is_absolute() for p in paths):
        raise HTTPException(400, '请提供有效的本地图片路径')
    folder_id = payload.get('folder_id')
    if folder_id is not None and (not isinstance(folder_id, int) or isinstance(folder_id, bool)):
        raise HTTPException(400, '文件夹无效')
    try:
        return copy_files(paths, folder_id)
    except (ValueError, OSError) as error:
        raise HTTPException(400, str(error)) from error


@router.get("/{image_id}/presence")
def image_presence(image_id: int):
    row = repository.image_detail(image_id)
    if not row:
        return {"exists": False}
    try:
        Path(row['path']).stat()
    except FileNotFoundError:
        payload = get_indexer()._process_path_sync(Path(row['path']), remove=True)
        if payload:
            get_indexer().emit_event_sync(payload)
        return {"exists": False}
    except OSError:
        return {"exists": True}
    return {"exists": True}
