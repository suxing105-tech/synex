# M2 修复：填满右边缺口 + 缩略图 cache-bust 不再吃糊

## 两个问题

### 1. 右边缺口太大

上一版 grid track 是 `repeat(n, ${zoomSize}px)`，每列严格固定 = zoomSize。
columnCount = floor((容器 + gap)/(zoomSize + gap))，结果容器宽 - n*zoomSize - (n-1)*gap
会留下最多 ~zoomSize px 的空洞，slider 拉到 360 时右边看起来像被「啃了一口」。

### 2. 滑到 360 仍糊

缩略图已被按 size=360 重生成（id=101 thumb=(360,201)），但 thumb URL 是固定的
`/thumbs/{id}.webp`，浏览器对同一 URL 会用 disk cache（HTTP 304 + ETag），
即使用户重建后 mtime 变了，有些浏览器/代理层仍可能命中老图。

## 修复

### Feed.svelte：grid track 改 minmax

```svelte
<!-- before -->
<div class="masonry-grid"
     style="grid-template-columns: repeat({columnCount}, {$zoomSize}px); gap: {COL_GAP}px;">

<!-- after -->
<div class="masonry-grid"
     style="grid-template-columns: repeat({columnCount}, minmax({$zoomSize}px, 1fr)); gap: {COL_GAP}px;">
```

```css
.masonry-grid {
  display: grid;
  align-items: start;
  /* 不再 width: max-content，让 grid 占满父级；
     repeat(n, minmax(zoomSize, 1fr)) 会自动把多余空间均分到各列 → 0 右缺口 */
}
```

效果（container = 1300px, gap = 8）：

| zoomSize | n    | min 列宽 | + 1fr 分配 | 实际列宽 |
|---------|------|---------|-----------|----------|
| 140     | 8    | 140     | +15.5     | 155.5    |
| 220     | 5    | 220     | +33.6     | 253.6    |
| 360     | 3    | 360     | +68.0     | 428.0    |

每列至少 zoomSize，多余的容器宽度按列数均分 → **右缺口恒为 0**，
且 slider 仍能真切看到每列变粗变细。

### repository.py：thumb URL 带 cache-bust

```python
def _thumb_version(thumb_path: str | None) -> int:
    if not thumb_path:
        return 0
    try:
        return int(_os.path.getmtime(thumb_path))
    except OSError:
        return 0

def thumb_url_for(image_id: int, thumb_path: str | None, status: str | None) -> str | None:
    if status != "ready":
        return None
    return f"/thumbs/{image_id}.webp?v={_thumb_version(thumb_path)}"
```

每次 list 返回 `/thumbs/123.webp?v={file_mtime}`。thumb 文件被重建后 mtime 变 →
URL 变 → 浏览器不会再用老 256 版本。

### ws.ts：rebuild 完成自动 refreshFeed

```typescript
} else if (payload.type === "thumb_rebuild_done") {
  await refreshFeed();  // 拉一次 → 新 ?v= URL 立即生效
}
```

后端 rebuild_thumbnails 已经 emit 这个事件，前端只要订阅触发 refreshFeed 即可。

## 验证

- 后端 pytest **42/42**（+5 新增 test_repository.py：version / status / 缺文件 / 重写变化）
- 前端 vitest **40/40**
- `npm run build` 通过
- 实测：同一图 id=243 的 thumb URL
  - 第一次重建后：`?v=1788324944`
  - 二次重建后：`?v=1788325529`（变大，浏览器认新图）

## 文件变更

- frontend/src/components/Feed.svelte                  repeat(n, px) → repeat(n, minmax(px, 1fr)) + 删 width: max-content
- frontend/src/lib/ws.ts                              +thumb_rebuild_done → refreshFeed
- backend/app/repository.py                           +_thumb_version + thumb_url_for，_row_to_summary 改用它
- backend/tests/test_repository.py                    +5 新增（新建文件）
- materials/08-m2-fill-gap-and-cache.md               本记录
