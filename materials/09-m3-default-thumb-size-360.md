# M3 收口：缩略图默认 360 + 旧值迁移

## 用户反馈

> 中间的图片显示还是会模糊。

## 诊断

抽样缩略图实际尺寸（从 `backend/data/thumbs/` 解码）：

| thumb 最长边 | 数量 | 说明 |
|------|------|------|
| 360  | 246 | 上一波 material/07 手动 rebuild 后的图 |
| 256  | 35  | rebuild 之后通过 Live 入库的新图 |
| 16   | 9   | `backend/data/sample_images/` 测试 fixture |

35 张 256 是因为：
1. `materials/07-m2-thumb-size.md` 那次是手动 API 调用（POST `/api/thumbnails/rebuild?size=360`），没改默认
2. `Config.thumb_size` 仍是 256
3. Live 模式 `_index_one` 用 `self._cfg.thumb_size` 生成新图 → 全部落回 256

slider 默认 220、上限 360；只要用户把滑块拉到 360，这 35 张就被浏览器 1.4× 上采样，必然糊。
masonry 贪心分列后，35 张散在三段（顶部最新 240-243、中段 119-179、底部 id=12），视觉上像「中间」一片糊。

## 修复

### 1. backend/app/config.py

- `thumb_size` 默认 `256 → 360`，与 slider 上限对齐
- `Config.load()` 加载完后跑 `_migrate_legacy_defaults()`：仅当磁盘上的值命中 `_LEGACY_DEFAULTS=(256,)` 才抬到新默认，**用户主动改过的（如 512）原样保留**
- 迁移只在内存生效，不会偷偷回写 config.json；下次用户点「保存」才会落盘

### 2. frontend Feed slider 上限 360 → 480

- 给高 DPI 屏留 1.33× headroom，再糊就不礼貌了
- SettingsModal `ZOOM_MAX` 常量同步抬到 480，「推荐 ≥ ZOOM_MAX」提示也跟着生效

### 3. 实操：全量 rebuild 290 张 → 360

- 后端重启（让新 config.py 生效，migration 跑起来）
- POST `/api/thumbnails/rebuild {"size":360,"quality":80}`
- 跑完抽样验证：

| thumb 最长边 | 数量 | 备注 |
|------|------|------|
| 360  | 282 | 全部 ComfyUI 输出图（含 trunc 重生成功）|
| 256  | 1   | id=12 是 DB 僵尸记录（文件已被删，rebuild 时 path.exists() 跳过） |
| 16   | 9   | 16×16 fixture，Pillow.thumbnail 不放大，无法更高 |

## 残留问题（不在本次范围）

- id=12 (AnimateDiff_00001.png) 是 DB 里的孤儿记录，原文件已删但 indexer 没 GC。
  → 后续 P1 加「扫描时清理孤儿」时一起修。
- 9 张 16px fixture 永远是 16×16，因为 Pillow.thumbnail 只缩小不放大。
  → 后续如果要支持「保留原图」，需要换「不超过 size 但可以等于原图」的实现。
- 默认 thumb_size 仍是 360，不是 480。slider 拉到 480 会有 1.33× 上采样的轻微模糊。
  → 折中：留给用户在 Settings 里把 thumb_size 拉到 480 再手动 rebuild。激进做法：默认 480。
  → 这次先稳：用户上次手动 rebuild 选的就是 360，honor 用户上次选择。

## 测试

新增 `tests/test_config.py` 7 个 case：

- `test_default_thumb_size_is_360` — 新装用户默认 360
- `test_load_migrates_legacy_default` — 旧 config.json(256) → 加载后 360
- `test_load_keeps_custom_value` — 用户写 512 → 不动
- `test_load_keeps_new_default` — 写 360 → 不动
- `test_load_missing_returns_defaults` — config.json 不存在 → 走默认
- `test_load_corrupt_returns_defaults` — JSON 损坏 → 走默认
- `test_save_then_load_round_trip` — 400 这种非默认值 round-trip 保留

`tests/test_thumbnails.py::test_indexer_rebuild_regenerates_thumb_to_new_size` 顺手改：
- 第一遍默认 size 从 256 → 360（因为默认改了）
- rebuild size 从 384 → 480（验证更大尺寸时也真的换）

测试结果：

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest | 42/42 | **49/49** |
| frontend vitest | 40/40 | 40/40 |

## 文件变更

- backend/app/config.py                                 default 256→360 + _LEGACY_DEFAULTS + _migrate_legacy_defaults
- backend/tests/test_config.py                          +7 cases（新建）
- backend/tests/test_thumbnails.py                      默认值更新（256→360）+ rebuild size 更新（384→480）
- frontend/src/components/Feed.svelte                   slider max 360→480
- frontend/src/components/SettingsModal.svelte          ZOOM_MAX 360→480
- .gitignore                                            +*.err 规则（uvicorn.err / vite.err）
- materials/09-m3-default-thumb-size-360.md             本记录
