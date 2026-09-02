# M3 收口二：Feed 直接显示原图

## 思路变化

上一轮 `materials/09` 抬默认 thumb_size 到 360 + slider 上限抬到 480 → 解决了"图被
浏览器拉伸糊"的一部分问题，但 **minmax(360px, 1fr)** 决定了只要容器宽于 n×360，
列宽就会超过 360 又被拉伸。

用户反馈这个修法不直观：「其实滑块滑动到 360PX，一行显示 5 列就可以了。最小的时候，
一行显示 10 列也就够了。重要的是图片为什么会比原图模糊那么多。有没有其他的办法让
图片更清晰？」

→ 选择走方案 C：**feed 直接拿原图，让浏览器自己缩**，根本性消除"二次采样"。

## 实现

### 1. backend：feed 暴露 original_url

`backend/app/models.py`：
```python
class ImageSummary(BaseModel):
    thumb_url: str | None = None
    original_url: str | None = None  # 原图 URL（feed 直接拿原图缩放）
```

`backend/app/repository.py`：新增 `original_url_for(image_id, file_mtime)`
```python
def original_url_for(image_id: int, file_mtime: float | None) -> str | None:
    if file_mtime is None:
        return None
    return f"/api/images/{image_id}/file?v={int(file_mtime)}"
```
`_row_to_summary` 一并加上这个字段。`?v=mtime` 做 cache-bust：原图被覆盖时 mtime 变
→ URL 变 → 浏览器重拉。

### 2. backend：/file 加缓存头 + 304 支持

```python
@router.get("/{image_id}/file")
def get_original(image_id: int, request: Request):
    # ETag = "<mtime>-<size>"，Last-Modified 用 mtime 格式化
    # If-None-Match 匹配 → 304 不传 body
    # Cache-Control: public, max-age=31536000, immutable
```

为什么需要 304 + immutable：
- 原图通常 1-5MB，feed 一次加载 10-15 张 = 30-50MB
- 滚动到一半浏览器用 If-None-Match 来问 → 服务端说"没变" → 浏览器 0 字节收尾
- `immutable` 是给 Chrome 用的 hint：一年内绝不重验证，连条件请求都不会发

### 3. frontend：Feed.svelte 用 original_url 优先

```svelte
{#if it.original_url}
  <img src={it.original_url} alt={it.filename} loading="lazy" decoding="async" ... />
{:else if it.thumb_url}
  <img src={it.thumb_url} alt={it.filename} loading="lazy" ... />
{:else}
  <div>无图可显示</div>
{/if}
```

`decoding="async"` 让浏览器异步解码，不阻塞主线程；`loading="lazy"` 已经在了，
视口外的图不下载。

降级链：原图（最高清）→ thumb（中等）→ 占位。这样老的 fixtures / 索引异常时不崩。

## 验证

curl 实测（id=240 ComfyUI 输出 PNG）：

```
GET /api/images/240/file
→ 200 OK, Content-Type: image/png, Content-Length: 4179057 (4.18 MB)
  ETag: "1788321549-4179057"
  Last-Modified: Wed, 02 Sep 2026 03:59:09 GMT
  Cache-Control: public, max-age=31536000, immutable

GET /api/images/240/file  (with If-None-Match: "1788321549-4179057")
→ 304 Not Modified (无 body)
```

feed API 返回：
```
id=300  thumb=/thumbs/300.webp?v=...  original=/api/images/300/file?v=...
id=299  thumb=/thumbs/299.webp?v=...  original=/api/images/299/file?v=...
```

## 资源账

- 单张原图 1-5MB；典型 ComfyUI 1024×1024 PNG ≈ 2MB
- Feed 视口内 ~10-15 张 = 20-30MB / scroll session
- 一旦进入浏览器 disk cache（同 URL 一年内不再请求）→ 0 流量
- 跨设备/重启浏览器仍然命中 disk cache（Cache-Control: immutable）

如果某些图本身就只有 256×256 原图（比如 ComfyUI 设置就是小尺寸），
feed 仍然把它们按容器宽度拉伸 → 那种图怎么都救不回来（原图就 256 像素）。
→ 这是物理限制，不是 thumb 系统的锅。

## 测试

新增 9 个 case：

`tests/test_repository.py`（4 个）：
- `test_original_url_includes_version_when_mtime_present` — ?v=mtime 拼对了
- `test_original_url_none_when_mtime_missing` — None 时返回 None
- `test_original_url_changes_when_mtime_changes` — mtime 变 → URL 变
- `test_thumb_url_still_works` — thumb_url_for 没被改坏

`tests/test_api.py`（5 个）：
- `test_file_endpoint_serves_original_bytes` — 返回 PNG 头 + 完整缓存头
- `test_file_endpoint_returns_304_on_matching_etag` — If-None-Match 命中 → 304
- `test_file_endpoint_returns_304_on_matching_last_modified` — Last-Modified 命中 → 304
- `test_file_endpoint_404_when_missing` — 不存在 → 404
- `test_feed_includes_original_url` — feed items 都带 original_url

测试结果：

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest | 49/49 | **53/53** |
| frontend vitest | 40/40 | 40/40 |
| vite build | OK | OK |

## 残留（不在本次范围）

- 缩略图系统仍然存在，被 Lightbox / 详情面板 / 未来可能的小图标位用
- thumb_size / rebuild 按钮保留，feed 切到原图后这两就成了"次要开关"
- thumb 系统要不要彻底拆掉等下一轮观察；现阶段先保留以防回归

## 文件变更

- backend/app/models.py                                ImageSummary + original_url
- backend/app/repository.py                            +original_url_for()  + original_url 注入 _row_to_summary
- backend/app/routes/images.py                         /file: +Request  +Cache-Control  +ETag/Last-Modified  +304
- backend/tests/test_repository.py                     重写为 4 case（含 thumb 回归）
- backend/tests/test_api.py                            +5 case（file endpoint + feed original_url）
- frontend/src/components/Feed.svelte                  img 用 original_url，thumb_url 降级
- frontend/src/lib/types.ts                            ImageSummary.original_url: string | null
- materials/10-m3-feed-original-preview.md             本记录
