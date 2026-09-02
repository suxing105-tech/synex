# M3 收口三：feed 预览默认 max=1024 + 拆掉「一键重建」按钮

## 用户反馈

上一轮 `materials/10` 直接让 feed 拿原图，浏览器自己缩 → 清晰度问题彻底解决，
但流量账有点重：

- 单张原图 1-5MB
- feed 视口内 10-15 张 × 2-5MB = 30-50MB / scroll session
- 高 DPI 屏 1× 显示器下，1024px 长边的预览肉眼跟 2048px 几乎看不出差别
  （1× DPI 下显示像素 = 预览像素，已经精准对齐）

→ 用户要求：

1. 设置 MAX=1024：feed 默认拿 1024px 长边的 WebP 预览（~200KB）替代原图（~2MB）
2. 拆掉「一键重建所有缩略图」按钮：feed 不用 thumb 了，按钮没意义

## 实现

### 1. backend：/file 加 ?max 参数 + 磁盘缓存

**`backend/app/thumbnails.py`** 新增 `generate_preview()`：

```python
def generate_preview(image_path: Path, image_id: int, max_size: int, quality: int = 85) -> Path | None:
    """为 image_path 生成最长边 max_size 的 WebP 预览，缓存到 previews/{id}_max{N}.webp。

    缓存策略：
    - 缓存路径含 max_size → 不同 size 互不干扰
    - 缓存 mtime < 源文件 mtime → 重生成（源文件被覆盖时自动失效）
    - 命中缓存 → 直接返回，O(1) 不解码原图
    """
```

**`backend/app/routes/images.py`** /file 加 `max` 参数：

```python
def get_original(
    image_id: int, request: Request,
    max: int | None = Query(default=None, ge=64, le=4096),
):
    if max is not None:
        preview_path = generate_preview(p, image_id, max)
        ...
        etag = f'"{int(mtime)}-{stat.st_size}-max{max}-{preview_stat.st_size}"'
        serve_path = preview_path
        serve_filename = f"{stem}_max{max}.webp"
    else:
        # 原图（原行为不变，Lightbox 用）
        serve_path = p
        etag = f'"{int(mtime)}-{stat.st_size}"'
```

ETag 包含 max → 不同 max 是不同的缓存条目，浏览器不会混淆。

**`backend/app/config.py`** 加 `previews_dir()` 路径 helper（与 `thumbs_dir()` 并列）。

**`backend/app/repository.py`** `original_url_for()` 加 `max_size` 参数（默认 1024）：

```python
def original_url_for(image_id: int, file_mtime: float | None, *, max_size: int | None = 1024) -> str | None:
    ...
    qs = []
    if max_size is not None:
        qs.append(f"max={int(max_size)}")
    qs.append(f"v={int(file_mtime)}")
    return f"/api/images/{image_id}/file?{chr(38).join(qs)}"
```

默认 max=1024 → feed 自动拿预览；Lightbox 显式传 max_size=None 拿原图。

### 2. frontend：SettingsModal 拆掉「缩略图」分区

`frontend/src/components/SettingsModal.svelte`：
- 删除 `thumbnailsApi` import
- 删除 `rebuilding` / `rebuildMsg` / `lastSavedThumbSize` 状态
- 删除 `rebuildAllThumbs` 函数
- 删除 `ZOOM_MAX` 常量
- 删除整个 `<section>`（监听目录 / 缩略图 / Live 三段 → 监听目录 / Live 两段）
- 删除按钮 + 「后台跑，不阻塞你浏览」提示
- 删除「推荐 ≥ 480」提示（slider max=480 也跟着作废了——后面单独修）

`save()` 函数保留 thumb_size/thumb_quality 字段（API 兼容），但用户没有 UI 入口改它们。
后端 config.json 里的旧值原样保留；不影响功能。

## 实测

单张图 (id=240，ComfyUI 1024×1024 PNG)：

| | 字节 | 比例 |
|------|------|------|
| 原图（?）| 4,179,057 | 100% |
| max=1024 预览（?max=1024）| 123,480 | **3.0%** |
| **节省** | | **97.0%** |

缓存目录 `backend/data/previews/` 已经在跑：

```
162_max1024.webp   106,590 bytes
163_max1024.webp   134,594 bytes
240_max1024.webp   123,480 bytes
...
```

ETag 验证：

```
GET /api/images/240/file?max=1024
  ETag: "1788321549-4179057-max1024-123480"
  Content-Type: image/webp
  Cache-Control: public, max-age=31536000, immutable

GET /api/images/240/file?max=1024
  If-None-Match: "1788321549-4179057-max1024-123480"
→ 304 Not Modified (body 0 bytes)
```

## 测试

新增 11 个 case（10 个 backend）：

**`tests/test_thumbnails.py`** +3：
- `test_generate_preview_caches_to_disk` — 落盘到 previews/，第二次复用
- `test_generate_preview_regenerates_when_source_newer` — 源 mtime 更新 → 重生成
- `test_generate_preview_handles_missing_source` — 源不存在 → None

**`tests/test_api.py`** +5：
- `test_file_endpoint_with_max_returns_webp_preview` — image/webp，比原图小
- `test_file_endpoint_with_max_304_on_cache_hit` — 预览的 ETag 也命中 304
- `test_file_endpoint_with_different_max_uses_different_cache` — max=256 vs max=1024 独立缓存
- `test_file_endpoint_max_validation` — 越界（<64 或 >4096）→ 422
- `test_feed_includes_max_in_original_url` — feed 自动带 max=1024

**`tests/test_repository.py`** +3：
- `test_original_url_includes_max_by_default` — 默认 max=1024
- `test_original_url_with_custom_max` — max=2048 → URL 变
- `test_original_url_with_max_none_omits_max` — Lightbox 路径无 max

测试结果：

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest | 53/53 | **63/63** |
| frontend vitest | 40/40 | 40/40 |

## 资源账（修订版）

旧方案（全原图）：30-50 MB / scroll session
新方案（1024 预览）：1-2 MB / scroll session（再缩 20-30×）

首次滚动：浏览器下载 ~15 张 1024px webp × 100-200KB ≈ 2-3 MB
二次滚动：disk cache 命中 → 0 流量
刷新页面：304 命中 → 0 流量

高 DPI 屏（DPR=2）下，1024px 预览在 512px 容器里渲染 = 4× oversampling → 仍然锐利。
即使 DPR=1，1024px 长边对比典型容器 200-360px 也已经 2-5× oversampling。

## 残留（不在本次范围）

- slider max=480 这个数字已经是历史（feed 不用 thumb、不直接看缩放宽度）；
  本轮没动它，等用户反馈要不要改成「浏览器屏幕宽度估算」之类的新语义
- SettingsModal 还保留 thumb_size / thumb_quality 字段在 save payload 里（API 兼容），
  但前端不再有 UI 入口。如果用户不需要，下次可以一并清掉
- backend 的 thumb 生成逻辑（`Indexer._process_path_sync`）仍在跑，
  新图入库仍会生成 thumb，但没人用了 —— 这是浪费 CPU + 磁盘。
  本轮没拆，等用户进一步反馈

## 文件变更

- backend/app/config.py                                +previews_dir()
- backend/app/thumbnails.py                            +generate_preview()  + previews_dir import
- backend/app/repository.py                            original_url_for + max_size 参数（默认 1024）
- backend/app/routes/images.py                         /file: +max Query 参数 + 分支处理
- backend/tests/test_thumbnails.py                     +3 case (preview 缓存)
- backend/tests/test_api.py                            +5 case (max endpoint) + 1 case 调整
- backend/tests/test_repository.py                     +3 case (original_url_with_max) + 1 case 调整
- frontend/src/components/SettingsModal.svelte         -缩略图 section -rebuild 按钮 -thumbnailApi
- materials/11-m3-preview-1024-and-no-rebuild.md       本记录
