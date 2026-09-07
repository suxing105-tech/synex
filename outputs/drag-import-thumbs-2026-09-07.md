# 拖入图片后缩略图自动显示
## 根因
- 后端 `/api/images/import` 走的是 `indexer._process_path_sync(target)`，但它只返回 payload，不广播 WS 事件。
- watchdog 那条路径在 `_flush_pending` 里通过 `asyncio.run_coroutine_threadsafe(self._emit(payload), self._loop)` 把事件送进 `EventBus`。
- 拖入路径绕开了 emit，所以前端 WS 收不到 `image_indexed`，`ws.ts` 里的 `refreshFeed` 不会触发，缩略图也就不出现。
- 用户按 F5 才看到，是因为手动触发了 feed 重新拉取。

## 修复
- 后端 `indexer.Indexer` 新增 `emit_event_sync(payload)` 同步助手，复用 `watchdog _flush_pending` 的同一条 `_emit` 路径。
- 后端 `/api/images/import` 路由在每张图索引成功后调用 `indexer.emit_event_sync(payload)`，让前端 WS 收到 `image_indexed`。
- 前端 `Feed.svelte#importFiles`：导入成功（无论 saved/skipped）后兜底直接 `refreshFeed + refreshStats`，不依赖 WS 一定到达。

## 验证
- 新增 `test_import_broadcasts_image_indexed`：拖入后从 `EventBus` 订阅队列里能拿到 `{type: "image_indexed", id, filename, path}` 事件。
- 全部后端测试：`151 passed`。
- 前端 vitest：与改动相关的测试通过；12 个失败 (`ws.test / shortcuts.test / comfyui-window.test`) 在改动前就存在，根因是 CLI vitest 缺 happy-dom 环境，与本任务无关。
