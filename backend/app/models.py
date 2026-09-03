"""Pydantic 模型：路由入参 / 出参。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


# ---------- 图片 ----------


class ImageSummary(BaseModel):
    id: int
    filename: str
    path: str
    original_url: str | None = None  # 原图 URL（feed 拿 ?max=1024 预览，浏览器缩放）
    width: int | None = None
    height: int | None = None
    mtime: float
    size_bytes: int
    favorite: bool = False
    folder_ids: list[int] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    model: str | None = None
    seed: int | None = None
    new: bool = False  # 标记 NEW 徽标


class ImageDetail(ImageSummary):
    positive_prompt: str = ""
    negative_prompt: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)
    workflow: str = ""
    sampler: str | None = None
    steps: int | None = None
    cfg: float | None = None
    format: str | None = None
    created_at: datetime | None = None
    indexed_at: datetime | None = None


# ---------- 文件夹 ----------


class FolderNode(BaseModel):
    id: int
    parent_id: int | None
    name: str
    order: int
    image_count: int = 0
    recursive_count: int = 0
    children: list["FolderNode"] = Field(default_factory=list)


FolderNode.model_rebuild()


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    parent_id: int | None = None


class FolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    order: int | None = None
    parent_id: int | None = None


# ---------- 标签 ----------


class TagInfo(BaseModel):
    name: str
    count: int = 0


# ---------- 设置 ----------


class ConfigOut(BaseModel):
    watch_dirs: list[str]
    theme: str
    live_enabled: bool
    scan_workers: int


class ConfigUpdate(BaseModel):
    watch_dirs: list[str] | None = None
    live_enabled: bool | None = None


# ---------- 搜索 / Feed ----------


class FeedQuery(BaseModel):
    folder_id: int | None = None
    view: str | None = None  # all / favorite / recent
    q: str | None = None
    tag: str | None = None
    model: str | None = None
    limit: int = 500
    offset: int = 0


class FeedResponse(BaseModel):
    items: list[ImageSummary]
    total: int
    limit: int
    offset: int


# ---------- 扫描进度 ----------


# ---------- 拖拽导入 ----------
class ImportResultItem(BaseModel):
    id: int
    filename: str
    path: str


class ImportSkippedItem(BaseModel):
    filename: str
    reason: str  # unsupported_format / empty_filename / write_failed / indexed_failed


class ImportResponse(BaseModel):
    saved: list[ImportResultItem] = Field(default_factory=list)
    skipped: list[ImportSkippedItem] = Field(default_factory=list)
    folder_id: int | None = None
    inbox_dir: str


class ScanProgress(BaseModel):
    running: bool
    scanned: int = 0
    indexed: int = 0
    total: int = 0
    current_path: str = ""
    error: str | None = None
