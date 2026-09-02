# M2 改进：缩略图按原图比例展示

## 改动前

`Feed.svelte` 用 `aspect-ratio: 1 / 1` + `object-cover` 强制正方形，竖图被裁掉上下、横图被裁掉左右，看不出原图内容形态。

## 改动

### 后端：入库时记录图片尺寸

- `backend/app/parser.py`：新增 `_extract_dimensions(path)`（Pillow `Image.open`）。在 `parse_metadata` 返回值里加 `width` / `height` 字段。
- `backend/app/indexer.py`：INSERT / UPDATE SQL 加 `width` / `height` 两列；线程池多 worker 并发写库会出现 "database is locked"（WAL 单写者），加 `_write_lock` 把 UPSERT + 缩略图 UPDATE 串行化。
- `backend/app/routes/settings.py`：`/api/scan` 默认行为由「扫描首个 watch_dir」 改成「扫描全部 watch_dirs」，已存在图片 UPSERT 时自动回填新字段。
- 历史 280 张图回填：用户/系统触发一次 `POST /api/scan` 即可。

### 前端：每张图用自己的宽高比

- `frontend/src/components/Feed.svelte`：
  - `aspect-ratio: {it.width} / {it.height};` 直接写内联样式，缺尺寸退到 `1 / 1`。
  - 缩放滑块仍控制「基准宽度」，横图/竖图都按各自比例算出 grid 列宽，避免在 `auto-fill, 1fr` 下出现高度参差不齐。
  - `object-cover` 保留：缩略图（webp）尺寸与原图比例一致，cover 不会裁掉任何东西。

## 测试

- `backend/tests/test_parser_dimensions.py`：parser 正确返回 width/height；坏字节不抛。
- `backend/tests/test_indexer_dimensions.py`：indexer UPSERT 写库；8 线程并发 20 张图 无 database locked，且全部带尺寸。
- `frontend/src/__tests__/feed-aspect.test.ts`：横图 / 竖图 / 正方形 / 缺尺寸 退化路径；缩放滑块 140→360 同比放大。

## 验证

- 后端 pytest：**31/31**（旧 27 + Bug B 2 + parser 2 + indexer 2）
- 前端 vitest：**29/29**（旧 14 + Bug A 2 + store-template 8 + feed-aspect 5）
- 真实数据回填：280/280 全部带尺寸，ratio 多为 0.56（竖图，符合 ComfyUI SDXL 输出）。
- DOM probe：`.thumb` 上 `aspect-ratio: 2560 / 4588` / `1152 / 2064` 已按图渲染。
