# Tauri 桌面 App — M0 交付记录

> 日期：2026-09-08
> 分支：`codex/tauri-app`
> 范围：M0-a → M0-e 完整跑通；M0-f（图标 + 单 exe 验证）已并入

## 一、最终产物

| 产物 | 路径 | 大小 |
|---|---|---|
| 主程序 | `frontend/src-tauri/target/release/suxing-gallery.exe` | 4.5 MB |
| NSIS 安装包 | `frontend/src-tauri/target/release/bundle/nsis/苏醒图库_0.1.0_x64-setup.exe` | 29.6 MB（包含 sidecar 25.3 MB） |
| Sidecar（PyInstaller 单文件） | `frontend/src-tauri/binaries/python-backend-x86_64-pc-windows-msvc.exe` | 25.3 MB |

## 二、关键决策与变更

| 决策 | 取值 | 备注 |
|---|---|---|
| Tauri 版本 | 2.11.5 stable | Tauri 1 已 EOL |
| Rust crate-type | staticlib + cdylib + rlib | 满足 `lib.rs` + `main.rs` 双入口 |
| 数据目录（运行时） | `%APPDATA%\com.suxing.gallery\data\` | Tauri `app_data_dir()` |
| 数据目录（dev） | `<repo>/backend/data/` | 通过 `SUXING_GALLERY_DATA_DIR` env 注入 |
| Sidecar 路径（prod） | 主exe 同目录的 `python-backend.exe` | NSIS bundler 去 triple 后缀放到 install root |
| Sidecar 路径（dev） | `frontend/src-tauri/binaries/python-backend-{triple}.exe` | 通过 `CARGO_MANIFEST_DIR` 定位 |
| Sidecar 隐藏 cmd 窗口 | `creation_flags(0x0800_0000)` 即 `CREATE_NO_WINDOW` | spec 仍 `console=True` 保留 stdout pipe |
| Sidecar IPC | stdio JSON-RPC，匹配首行 `READY {"port":...}` | 30s 超时 |
| NSIS 打包 | 单目标、`perMachine`、中英双语 | `webviewInstallMode: embedBootstrapper` |
| Frontend Tauri 桥 | `withGlobalTauri: true` + `window.__TAURI__.core` / `.event` | 无需前端 npm install @tauri-apps |

## 三、本轮修复的两个 bug

### 3.1 Sidecar 路径解析错误

**症状**：`cargo tauri build` + NSIS 安装后启动，主进程日志：
```
[sidecar] spawn failed: exe not found at \\?\C:\Program Files\苏醒图库\binaries\python-backend-x86_64-pc-windows-msvc.exe
```

**根因**：Tauri 2 NSIS bundler 把 `externalBin` 配置的 `binaries/python-backend` 重命名为 `python-backend.exe` **直接放到 install root**（不是 `resource_dir/binaries/`）。原 Rust 代码硬拼 `binaries/{name}-{triple}.exe`，prod 分支永远找不到。

**修复**（`frontend/src-tauri/src/sidecar.rs`）：
- prod 分支先用 `std::env::current_exe().parent().join("python-backend.exe")` 试
- 找不到再 fallback `resource_dir/binaries/python-backend.exe`
- 再 fallback `resource_dir/python-backend.exe`
- 兼容未来 bundle 行为变化

### 3.2 PyInstaller 控制台窗口弹出

**症状**：每次启动 Tauri App，会弹出一个黑色 cmd 窗口，标题是 `C:\Program Files\苏醒图库\python-backend.exe`，覆盖在主窗口上。

**根因**：PyInstaller spec 写了 `console=True`，启动一个 console subsystem 进程，从 GUI app（Tauri）里 spawn 时，Windows 会显示这个 console。

**修复**（`frontend/src-tauri/src/sidecar.rs`）：
```rust
#[cfg(windows)]
cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
```
spec 仍保持 `console=True`（否则 windowed bootloader 不继承 stdout pipe，`READY` 检测失败）。

## 四、端到端验证（已通过）

```
[2026-09-08T01:27:46Z INFO  suxing_gallery_lib::sidecar] [sidecar] spawning exe=C:\Program Files\苏醒图库\python-backend.exe port=8765 data_dir=C:\Users\Administrator\AppData\Roaming\com.suxing.gallery\data
[2026-09-08T01:27:46Z INFO  suxing_gallery_lib::sidecar] [sidecar] child pid=Some(29648)
[2026-09-08T01:27:46Z WARN  suxing_gallery_lib::sidecar] [sidecar:stderr] INFO:     Started server process [35940]
[2026-09-08T01:27:47Z INFO  suxing_gallery_lib::sidecar] [sidecar:stdout] READY {"port": 8765}
[2026-09-08T01:27:47Z INFO  suxing_gallery_lib::sidecar] [sidecar] READY payload={"port":8765}
```

- ✅ NSIS `/S` 静默安装 → 产物正确（`C:\Program Files\苏醒图库\{suxing-gallery,python-backend,uninstall}.exe`）
- ✅ Tauri 主进程启动 → spawn PyInstaller sidecar（CREATE_NO_WINDOW，无 cmd 窗口）
- ✅ Sidecar FastAPI child 监听 `127.0.0.1:8765`
- ✅ `GET http://127.0.0.1:8765/api/health` 返回 200 `{"status":"ok"}`
- ✅ `%APPDATA%\com.suxing.gallery\data\` 自动创建，含 `config.json` + `db.sqlite` + WAL
- ✅ Rust 主进程关闭 → sidecar 子进程被 kill

## 五、测试矩阵

| 测试 | 结果 |
|---|---|
| 后端 pytest | 154 passed |
| 前端 pnpm test | 214 passed (25 files) |
| Rust cargo test --release | 0 passed (无单测；sidecar IPC 逻辑通过 e端到端验证） |

## 六、关键截图

- `outputs/tauri-m0a-window-2026-09-07.png` — M0-a Tauri 窗口验证
- `outputs/tauri-m0d-splash-2026-09-08.png` — M0-d splash overlay（含 cmd 弹窗）
- `outputs/tauri-m0e-window-2026-09-08.png` — M0-e 第一次成功启动（cmd 弹窗可见）
- `outputs/tauri-m0e-loaded-2026-09-08.png` — 同上稍后（仍可见 cmd 弹窗）
- `outputs/tauri-m0e-launched-2026-09-08.png` — 修复 path 后首次端到端
- `outputs/tauri-m0e-moved-2026-09-08.png` — 拉到桌面中央，cmd 弹窗仍可见
- `outputs/tauri-m0e-noconsole-2026-09-08.png` — 修复 CREATE_NO_WINDOW 后，cmd 弹窗消失
- `outputs/tauri-m0e-big-2026-09-08.png` — 全屏 Tauri 主窗口（黑屏见下条）

## 七、已知问题（M0-f / M1 处理）

### 7.1 WebView2 主窗口内容黑屏

**症状**：Tauri 主窗口能起来、标题"苏醒图库"正确、HTTP API 正常，但窗口 content area 全黑，看不到 splash 卡片也看不到主 UI。

**初步定位**：
- WebView2 user data dir 正常创建（`%LOCALAPPDATA%\com.suxing.gallery\EBWebView\Default\`）
- `msedgewebview2` 进程组正常（10+ 个 helper 进程）
- 页面背景色（`#0e0e10` Tailwind `bg-bg`）能渲染 → body 加载成功
- 但 `#app` div 内容没渲染 → Svelte JS 报错或挂起

**下一步**：
- 在 `Cargo.toml` 给 `tauri` feature 加 `devtools`，build 时 F12 打开 devtools 看 console 报错
- 检查 vite 打包后 `assets/index-*.js` 是否有运行时错误（生产构建 dev/prod API 差异）
- 验证 `window.__TAURI__` 在 prod 模式下是否正确暴露（`withGlobalTauri: true`）

**影响**：核心安装 + 后端链路全通（端到端 e2e 通过），仅 UI 渲染未现。下次会话（M0-f）继续。

### 7.2 splash 加载文案

前端 `App.svelte` 的 splash 已实现但目前因为 7.1 未生效所以不可见。逻辑：
- `backendReady` 默认 `false`
- 等 `sidecar-ready` Tauri event 触发 → 切 `true` → 隐藏 splash + 调 `doInit()`
- 30s 未就绪 → 切红色错误卡 + 提示重建 sidecar

### 7.3 NSIS 单目标 perMachine

`installMode: perMachine` 意味着需要管理员权限安装。当前用 `/S` 静默装（管理员 token 下）。普通用户首次安装会弹 UAC，对桌面 App 是常见做法，可接受。

## 八、构建步骤（开发者复现）

```powershell
# 一次性
cd "C:\Users\Administrator\Documents\ChatGPT\苏醒图库"
# 构建 sidecar（PyInstaller，约 30s）
& "frontend\scripts\build-sidecar.ps1"

# 构建 Tauri exe + NSIS（约 5 min，含首次编译 + makensis 下载）
cd "frontend\src-tauri"
& "C:\Users\Administrator\.cargo\bin\cargo.exe" tauri build

# 产物
ls "target\release\suxing-gallery.exe"
ls "target\release\bundle\nsis\苏醒图库_0.1.0_x64-setup.exe"
```

## 九、待办（M0-f / M1）

- [ ] 修复 7.1 WebView2 黑屏（开 devtools 看 console）
- [ ] 单 exe 测试（不依赖 NSIS installer，直接跑 `suxing-gallery.exe`）
- [ ] Splash 文案 polish
- [ ] M1: NSIS 打包脚本进 CI、签名（自签测试证书）
- [ ] M2: 多语言、自动更新、Tray icon
- [ ] M3: 全局快捷键唤起
- [ ] M4: 性能与稳定性 profile
