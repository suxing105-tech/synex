# M3 收尾：彻底拆掉缩略图生成管道

## 用户反馈

上一轮 (materials/11) 让 feed 直接拿原图（max=1024 预览），「一键重建缩略图」按钮也拆了，UI 干净了。
但用户的两个 follow-up：

1. **thumb 整套生成管道还在跑** — 后端每张图入库时还会调 generate_thumb 写一个 data/thumbs/{id}.webp，CPU + 磁盘白费。
   这条管道已经从 materials/10（方案 C）开始就**没有任何调用方**了：feed 用 original_url → 直接渲染原图；Lightbox 也是 original_url；SettingsModal 的「一键重建」按钮拆了。
   现在是「管道还在写、但没人读」的纯浪费。

2. **slider zoomSize → targetColumns** — 旧的 zoomSize: number 控制列宽 px，但用户思考时是「一行显示几张」而不是「列宽多少 px」。把语义换过来更顺手。

(用户最新一句：先做 Task 1 拆 thumb 管道，Task 2 改 slider 语义是另外的小事)

## 实现：Task 1 — 彻底拆 thumb 生成管道

### backend

- backend/app/config.py
  - 删 thumb_size / thumb_quality / _LEGACY_DEFAULTS / _migrate_legacy_defaults
  - 删 thumbs_dir()（helpers 只剩 data_dir / db_path / previews_dir / logs_dir / config_path）

- backend/app/thumbnails.py — 整个模块只剩 generate_preview() 和一行 docstring 解释「为啥这模块还在」：
  - 删 generate()（thumb 缩放）
  - 删 thumb_url_path()（URL helper）
  - 模块 docstring 改写：feed 已切 ?max=N 预览后，thumb 系统的所有调用方都消失了，整个模块只有 generate_preview 这条生产路径在用

- backend/app/indexer.py
  - _process_path_sync 删 generate_thumb 调用 + INSERT/UPDATE SQL 里的 thumb_status 列
  - 删 rebuild_thumbnails 方法 + _rebuild_one_thumb
  - 删 thumbs_dir / generate import

- backend/app/models.py
  - ImageSummary 删 thumb_url / thumb_status
  - ImageDetail 删 thumb_status
  - ConfigOut / ConfigUpdate 删 thumb_size / thumb_quality

- backend/app/repository.py
  - 删 thumb_url_for() / _thumb_version()
  - 删所有 thumb_url / thumb_status 字段引用
  - 删 thumbs_ready 字段

- backend/app/main.py
  - 删 app.mount("/thumbs", StaticFiles...)
  - 删 thumbs_dir import
  - SPA fallback 里也删 thumbs/ 相关分支

- backend/app/routes/images.py
  - 删 thumb_url_path import
  - DELETE 处理里删 thumb_status 列引用

- backend/app/routes/settings.py
  - 删 POST /api/thumbnails/rebuild 端点

- backend/app/db.py — schema 保留 thumb_path / thumb_status 两列（生产库 IF NOT EXISTS 不重建，删了反而要写迁移；这两列没人写没人读，是无害的死列）

> 一个踩到的坑：上一轮已经把 indexer.py 的 INSERT 列表从 14 列压缩到 15 列（去掉 thumb_status），但 VALUES 的 ? 没改 → 跑测试报 "14 values for 15 columns"。补上第 15 个 ? 后通过。

### frontend

- frontend/src/lib/types.ts
  - 删 ImageSummary.thumb_url / ImageDetail.thumb_status
  - 删 ConfigOut.thumb_size / .thumb_quality

- frontend/src/lib/api.ts
  - 删整个 thumbnailsApi 块（POST /api/thumbnails/rebuild）

- frontend/src/lib/ws.ts
  - 删 thumb_rebuild_done 事件处理（同时补上漏掉的 }，见下）

> 一个踩到的坑：上一轮把 if (thumb_rebuild_done) { ... } else if (scan_progress) { ... } 改成 if (scan_progress) { ... } 时漏删一个 } → esbuild 报 "Unexpected catch"。补上后通过。

- frontend/src/components/Feed.svelte
  - 简化 <img> 为只用 original_url（去掉 {:else if it.thumb_url} 分支）

- frontend/src/components/Lightbox.svelte
  - src={originalUrl ?? ''}（去掉 it.thumb_url）

### 测试

- 删 backend/tests/test_config.py（整个文件都是 thumb_size 默认值 / 迁移测试）
- backend/tests/test_thumbnails.py 删 4 个 thumb 测试，只保留 3 个 generate_preview 测试
- backend/tests/test_repository.py 删 test_thumb_url_still_works + thumb_url_for import
- backend/tests/test_api.py
  - 删 test_thumbnails_rebuild_route / test_thumbnails_rebuild_validates_size
  - test_settings_round_trip 原本测 thumb_size: 200，改成测 live_enabled: False（ConfigUpdate 接受 live_enabled）

- frontend/src/__tests__/stores.test.ts
  - sample ImageSummary 改 thumb_url → original_url
- frontend/src/__tests__/masonry-greedy.test.ts
  - thumb_url → original_url（上一轮已改）

### 物理清理

backend/data/thumbs/（239 个废 webp 文件）→ 删。下一张图入库不会再生成了。

## 验证

### 测试

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest | 63/63 | **49/49** |
| frontend vitest | 40/40 | **40/40** |
| vite build | OK | OK |

> 测试总数从 63 → 49：删了 8 个 thumb 相关测试（test_config.py 7 个 + test_thumbnails.py 4 个 thumb 测试 + test_api.py 2 个 rebuild 测试 − 重新加的 settings_round_trip = −14），其余是 test_repository 也少 1 个 thumb 测试。

### API curl

GET /api/images?limit=1
{ items: [{ id: 344, original_url: /api/images/344/file?max=1024&v=1788337034, ... 没有 thumb_url / thumb_status }] }

GET /thumbs/1.webp → 200（SPA fallback 返回 index.html；反正前端没人引用 thumbs/）
POST /api/thumbnails/rebuild → 405（路由已删）
GET /api/images/344/file?max=1024 → 200 webp
GET /api/images/344/file → 200 原图

### 资源账（以 id=240 为例）

| 资源 | 之前 | 现在 |
|------|------|------|
| data/thumbs/240.webp | 4-50 KB / 张（永远写、永远没人读） | 不再生成了 |
| data/previews/240_max1024.webp | 200 KB（feed 用） | 同上 |
| feed 流量 | 1-2 MB / scroll session | 同上 |

CPU + 磁盘 + 索引时间，省了一整条 thumb 管道。

## 范围外（下一步要做）

- **Task 2：slider zoomSize → targetColumns**
  - 4-12，默认 7
  - stores.ts zoomSize 改名 targetColumns
  - Feed.svelte slider min=4 max=12 step=1，列宽 = 容器宽 / targetColumns
  - UI 文案「缩放」→「列数」
  - 同步 vitest