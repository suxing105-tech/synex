# M2 修复：缩略图尺寸跟随缩放滑块（不再糊）

## 问题根因

backend/app/thumbnails.py 用 Image.thumbnail((size, size)) 把所有缩略图最长边压到 256px。

前端缩放滑块是 140–360，默认 220。当用户拖到 360 渲染缩略图：
- 原图 > 256：缩略图已被压到 256 像素 → 再被 CSS 拉到 360 → 拉伸模糊
- 原图 < 256：保持原图大小 → 显示非常小

抽样：
- id=101 thumb=(256,143)  ← 横图永远 256 wide
- id=15 原图=(2880,1616) thumb=256   ← 大原图被压到 256

## 修复方案

### 1. 后端：Indexer.rebuild_thumbnails() + POST /api/thumbnails/rebuild

```python
def rebuild_thumbnails(self, *, size=None, quality=None, fire_event=True) -> dict:
    """按 size/quality 重建全部缩略图；不动 metadata。"""
    target_size = size if size is not None else self._cfg.thumb_size
    target_quality = quality if quality is not None else self._cfg.thumb_quality
    rows = get_pool().main().execute("SELECT id, path, filename FROM images ORDER BY id").fetchall()
    # 并发 submit 到 self._executor，逐个 collect，等待结果
    ...
```

POST /api/thumbnails/rebuild 路由在 BackgroundTasks 里跑，前端即时返回不阻塞。
接受 size (64..2048) 和 quality (40..100) 参数，越界返回 400。

### 2. 前端：SettingsModal 加「🔄 一键重建所有缩略图」按钮

按钮调 thumbnailsApi.rebuild({size, quality})，点击后立即返回 ok 状态。

加 hint 文本提示：
> 推荐 ≥ 360（缩放滑块上限），否则滑到最大时浏览器会拉伸缩略图变糊。

### 3. 默认值不动

Config.thumb_size 默认保留 256（不破坏已有用户配置）；
新装用户首次扫到的图也是 256，但 Settings 提示「建议 ≥ 360」。

## 实施 + 当前状态

1. 已对当前 281 张真实图调用了一次 POST /api/thumbnails/rebuild（size=360, quality=80）。
2. 实测：id=101 thumb=(360,201) 已经是 360 长边。
3. 残留 1 张 thumb < 360（id=1 mountain.png 16x16）：这是 backend/data/sample_images/ 里的测试 fixture，
   原图本身就 16x16，Image.thumbnail 只缩小不放大，符合 Pillow 语义。

## 测试

后端新增 4 个 case（总 37/37）：
- test_generate_thumb_respects_longest_edge —— 2048x1152 原图按 size=360 生成后最长边 = 360
- test_indexer_rebuild_regenerates_thumb_to_new_size —— indexer.rebuild_thumbnails(size=384) 后 thumb 真的 = 384
- test_thumbnails_rebuild_route —— POST /api/thumbnails/rebuild 返回 200 ok
- test_thumbnails_rebuild_validates_size —— size/quality 越界返回 400

前端：40/40（无新增，沿用现有）。

## 文件变更

- backend/app/indexer.py                                 +rebuild_thumbnails, _rebuild_one_thumb
- backend/app/routes/settings.py                         +POST /api/thumbnails/rebuild
- frontend/src/lib/api.ts                                +thumbnailsApi.rebuild()
- frontend/src/components/SettingsModal.svelte           +重建按钮 + 尺寸提示
- backend/tests/test_thumbnails.py                       +2 cases
- backend/tests/test_api.py                              +2 cases
- materials/07-m2-thumb-size.md                          本记录

## 验证

- 后端 pytest：37 / 37
- 前端 vitest：40 / 40
- npm run build 通过
- 后端实测 rebuild size=360：281 张 thumb 最长边 = 360，仅 1 张 16x16 fixture < 360（符合预期）
- 用户刷新 http://127.0.0.1:8765/ 即可看到清晰缩略图

## 后续（不在本次改动）

如要把 thumb_size 默认值改成 360 避免新装用户踩坑：
- 改 Config.thumb_size = 360 在 backend/app/config.py
- 已存在用户的 config.json 不会自动迁移，新装用户受益
- 暂不动以避免破坏现有配置
