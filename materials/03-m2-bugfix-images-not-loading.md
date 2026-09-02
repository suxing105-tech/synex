# M2 修复：图片加载不出来（两个串联 bug）

## 现象

`http://127.0.0.1:8765/` 正常打开，但 Feed 区一直显示「此视图下没有图片」，
控制台无明显错误，浏览器 DevTools 里 `<img>` 数为 0。

## 根因（两个 bug 串联）

### Bug A — 前端：`{#if newIds.has(it.id)}` 缺 `$` 前缀

`Feed.svelte` 第 90 行：

```svelte
{#if newIds.has(it.id)}   <!-- ← newIds 是 writable store，没有 .has -->
```

`svelte/store` 的 `writable()` 返回的 store 对象本身只有 `set / update / subscribe`，
没有 `.has`。所以这一行模板在每张图渲染时都抛 `TypeError: Bn.has is not a function`，
导致整个 `{#each $feedItems}` 块在 Svelte 内部被回滚 → 0 张图。

注意：class 字符串里那个 `{$newIds.has(it.id)}` 写法是对的（有 `$`），bug 只在
独立的 `{#if}` 块里。`1d60a70` 那次只改了 class 串，没动这个块。

**修复**

```svelte
{#if $newIds.has(it.id)}
```

### Bug B — 后端：SQLite 主连接跨线程竞争

修了 Bug A 后页面立即报 HTTP 500：

```
File "repository.py", line 246, in _row_to_summary
    for r in get_pool().main().execute(  ← 请求线程
        "SELECT t.name FROM tags ..."
        ...
sqlite3.InterfaceError: bad parameter or other API misuse
```

`ConnectionPool.main()` 返回的是单一共享 `sqlite3.Connection`。watchdog 索引线程
和 FastAPI 请求线程同时打到这个连接，sqlite3 不允许同一连接并发执行语句，
并发即抛 `InterfaceError`。

20 并发复现：

```
Invoke-WebRequest -Uri "...api/images?limit=5"  (x20)
旧版本：~30% 失败（500）
新版本：20/20 全 200
```

**修复**

把 `main()` 改成「线程局部」：每个调用线程拿到自己的连接，跨线程隔离；
所有连接 WAL 模式并发读写同一文件，本身由 SQLite 负责一致性。

`backend/app/db.py`：
- 加 `threading.local()`，连接按线程懒创建
- `initialize()` 完成后用 `Event` 通知其他线程可以开始建连接
- 同线程内仍走同一连接（事务上下文要复用）

并发回归测试 `backend/tests/test_concurrency.py`：
- `test_main_returns_thread_local_connection`：同线程复用、跨线程隔离
- `test_concurrent_reads_do_not_raise`：64 个并发 SELECT 全部成功

## 验证

- `frontend/src/__tests__/store-template-usage.test.ts`（新增 8 个用例）：
  扫所有 .svelte 组件模板，禁止 `storeName.xxx`（裸 store 调方法），强制 `$storeName.xxx`。
  把 `{#if newIds.has(...}` 临时改回去 → 测试会红。
- 后端 pytest：29 / 29（旧 27 + 新增 2）
- 前端 vitest：24 / 24（旧 14 + 上一轮 2 + 新增 8）
- `happy-dom` 端到端：DOM 里 `feedLen=239`，`<img>` 正常出现

## 文件变更

```
frontend/src/components/Feed.svelte                          ← Bug A 修复
frontend/src/__tests__/store-template-usage.test.ts          ← 回归测试
backend/app/db.py                                            ← Bug B 修复
backend/tests/test_concurrency.py                            ← 回归测试
materials/03-m2-bugfix-images-not-loading.md                 ← 本记录
```
