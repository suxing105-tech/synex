# 项目减负方案 · 2026-11-04

## 结论

「删 v0.2.33 之前的内容」这条路基本没用，方向错了。项目 53 GB 里 **48.2 GB 是 `frontend\src-tauri\target` 的 Rust 编译缓存**，GitHub 上有没有它跟它一点关系都没有；而 `outputs/` 里真正被 git 跟踪的历史文件只有 **16.2 MB**。

磁盘现状：C 盘只剩 **22.9 GB** 空闲，光 target/debug 就是它的 1.8 倍。减负要按「能不能再生 + 有多大」排，不按时间排。

## 实测数据（2026-11-04 预演得到，明细见 deleted-*.csv）

| Tier | 内容 | 大小 | GitHub 上有没有 | 删掉的代价 |
|---|---|---|---|---|
| A | `.git` 里 25 个 `tmp_obj_*` 残留 + 不可达对象 | 0.6 GB + 约 2.0 GB | 不在任何 ref 上，GitHub 也没有 | 无。git 自己不要的东西 |
| B | `frontend\src-tauri\target\debug` | **39.5 GB** | 编译缓存，与仓库无关 | 下次 `cargo test`/dev 冷编译一次 |
| C | `frontend\src-tauri\target\release` | 7.6 GB | 同上 | 下次打包冷编译（LTO 开着，20–40 分钟） |
| D | `outputs/release-0.2.*/` 里的 exe、sig、app、sidecar、build 中间产物 | 0.7 GB | **有**：GitHub Release 每个版本都带安装包+sig+latest.json | 无，随时能下回来 |
| E | 库快照副本 + 验证 scratch 目录（splash 帧、rh-verify、`_healcheck`、`_clone_r10_data` 等） | 1.0 GB | **没有**（gitignored / untracked） | 不可恢复，见下面红线 |
| F | `outputs` 根目录未跟踪散落脚本/日志/截图（656 个文件） | 45.9 MB | 没有 | 不可恢复，但都是一次性补丁脚本 |
| G | 可再生依赖：`vendor/media-tools`、`backend/.venv`、`frontend/node_modules`、各类 cache | 0.4 GB | 靠脚本重新下载/安装 | 重新拉一次（media-tools 96 MB 走网络） |

全跑一遍 ≈ **51.8 GB**（A 的 gc 回收不计入文件求和）。

## 三条红线（先看完再动手）

1. **`outputs/auto-update-v1/private/updater.key`**：自动更新签名私钥，只存在于本地、被 gitignore、GitHub 上没有。脚本已经把它写进硬保护清单（`$Never`），但**建议你先把它复制到U盘/网盘另外存一份**——丢了这个 key，已发布的所有客户端永远收不到你的更新。
2. **`outputs/_clone_r10_data/backup/pre-0.2.33/db.sqlite`**：0.2.33 迁移前的真实库备份（81 MB）。生产库在 `C:\SeekX-Data`（不在项目里，脚本也不会碰）。Tier E 会连它一起删，如果 0.2.33+ 的数据你还想留一条回滚路，就把这个路径从 Tier E 清单里去掉。
3. **最近 25 个 commit（11-02、11-03）还没 push**，`origin` 停在 `65c3392 Release 0.2.33`。这部分的「GitHub 上有」目前**不成立**。清理之前建议先 push（要动外部状态，等你点头）。

## 怎么跑

脚本：`outputs\cleanup-20261104\cleanup.ps1`，默认**只预演**，不删任何东西；`-Apply` 才真删；`-Tiers` 传字母组合（不传就用文件里的 `$DefaultTiers = 'BDEF'`）。

```powershell
cd C:\Users\Administrator\Documents\ChatGPT\苏醒图库
# 1) 预演，看清单和总大小
powershell -NoProfile -ExecutionPolicy Bypass -File outputs\cleanup-20261104\cleanup.ps1 -Tiers AB
# 2) 确认无误再真删
powershell -NoProfile -ExecutionPolicy Bypass -File outputs\cleanup-20261104\cleanup.ps1 -Tiers AB -Apply
```

每删一项都会往 `outputs\cleanup-20261104\deleted-<时间戳>.csv` 写路径和大小。建议顺序：先 `AB`（40 GB，零风险），再 `DF`（0.7 GB），最后自己核一遍 `E` 的清单再决定，`C`/`G` 只在还想继续省的时候动。

## 为什么不动那些「旧内容」

- `outputs` 里 git 跟踪的 418 个文件（9 月的 PLAN、截图、验收记录）合计 16.2 MB，`docs/` 2.6 MB、`materials/` 0.2 MB。删它们要 `git rm` + commit，省不了空间，还丢掉「MEMORY.md 里的结论能点回原始证据」这条链路。
- `backend/data`（151 MB）是 dev 实例的数据目录，11-03 还在写，不属于垃圾。
- 真要防以后再涨：给 `frontend/src-tauri/Cargo.toml` 加 `[profile.dev] debug = 0`（或构建时设 `CARGO_INCREMENTAL=0`），debug 目录就不会再长到 40 GB。这条要改配置+跑测试，等你说了再做。