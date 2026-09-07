# Tauri 桌面 App 版实施计划（M0 → M4）

## 背景

- 原方案：`tech-design.md` §1–3 形态 = Tauri 2.x（Rust 壳 + Python sidecar）+ Svelte + SQLite/FTS5，仅 Windows。
- 当前本轮：M0–M3 已通过 Web 版（FastAPI + Vite）交付，但缺少原生壳与打包产物。
- 本计划目标：**复活 M0，把现有 Web 版装进 Tauri 壳，并产出 NSIS 安装包**。
- 环境现状（2026-09-07 已验证）：
  - `rustc 1.98.1` / `cargo 1.98.1`，stable-x86_64-pc-windows-msvc
  - MSVC 19.51.36256（VS Community 2026 18.9）
  - WebView2 Runtime 152.0.4191.66
  - Python 3.14.6、pnpm 已装
  - **缺**：`tauri-cli`（需安装）

## 形态决策（遵循 `tech-design.md` §3，不再变更）

| 关注点 | 决策 | 理由 |
|---|---|---|
| Tauri 版本 | **Tauri 2.x stable** | 原方案指定；Tauri 1 已 EOL |
| 项目布局 | **`frontend/src-tauri/`** | tech-design §9.1 已写明；不动前端结构 |
| Sidecar 通信 | **stdio JSON-RPC** | tech-design §6 已写明；IPC 打通前提 |
| Sidecar 打包 | **PyInstaller 单文件** | tech-design §3 / §7.3；NSIS 安装包需要 |
| Bundle 目标 | **`["nsis"]`** | tech-design §7.2；中文 UI + 桌面快捷方式 + 卸载 |
| IPC 角色分工 | Rust 只管 sidecar 生命周期 + 权限类操作；业务 HTTP 仍走 127.0.0.1:8765 | tech-design §6 已论证：便于独立调试 |
| dev / prod sidecar 一致性 | **统一用 PyInstaller 产物** | 避免 dev/prod 行为漂移；spec 文件复用 |
| 数据目录（运行时） | `%APPDATA%\苏醒图库\`（prod）/ `<project>/backend/data/`（dev） | Tauri `app_data_dir()` API |

## 目录结构（新增部分用 `+` 标识）

```
苏醒图库\
├── outputs\
│   └── PLAN-tauri-app.md          ← 本文件
├── materials\
│   └── 29-tauri-m0-delivery.md    ← M0 交付记录（实施后补）
├── backend\                       ← 现状不变
│   ├── app\
│   ├── data\
│   ├── tests\
│   └── pyproject.toml
├── frontend\
│   ├── src\                       ← 现状不变
│   ├── dist\                      ← 现状不变
│   ├── package.json               ← + 加 tauri 脚本（dev/build）
│   ├── vite.config.ts             ← 现状不变（已代理到 8765）
│   + src-tauri\                   ← 新增
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── build.rs
│   │   ├── icons\                 ← 5 个 PNG/ICO（占位先用现有 logo）
│   │   ├── capabilities\
│   │   │   └── default.json
│   │   └── src\
│   │       ├── main.rs            ← 入口
│   │       ├── lib.rs             ← run() 函数
│   │       ├── sidecar.rs         ← spawn / health / shutdown
│   │       └── commands.rs        ← Tauri commands（前端 invoke）
│   + pyinstaller\
│   │   ├── python-backend.spec    ← PyInstaller 配置
│   │   └── hooks\                 ← PyInstaller runtime hooks（uvicorn/wsgi）
│   + scripts\
│       ├── dev-sidecar.ps1        ← 启 venv uvicorn（fallback，调试用）
│       ├── build-sidecar.ps1      ← 跑 PyInstaller
│       └── verify-app.ps1         ← 端到端冒烟
```

## 阶段划分

### M0-a：脚手架（Tauri Hello World）

**目标**：跑通 `cargo tauri dev`，弹出空窗口 + 占位 HTML。

步骤：
1. 安装 tauri-cli：`cargo install tauri-cli --version "^2.0" --locked`。
2. 在 `frontend/` 下建 `src-tauri/`，手写 `Cargo.toml` / `tauri.conf.json` / `build.rs`（避免 init 模板带一堆用不到的 UI 套件）。
3. `tauri.conf.json`：
   - `productName`: `苏醒图库`
   - `version`: `0.1.0`
   - `identifier`: `com.suxing.gallery`
   - `build.beforeDevCommand`: `pnpm dev`
   - `build.beforeBuildCommand`: `pnpm build`
   - `build.frontendDist`: `../dist`
   - `build.devUrl`: `http://localhost:5173`
   - `app.windows`: 1 个，title=`苏醒图库`，width=1280，height=800
   - `bundle.targets`: `["nsis"]`
   - `bundle.externalBin`: `["binaries/python-backend"]`（先留空路径占位，M0-b 再填）
4. `capabilities/default.json`：core:default + 一个占位 allowlist。
5. 占位 `main.rs`：`tauri::Builder::default().run(...)`，先不接 sidecar。
6. 图标：把现有 PNG 拷到 `icons/`，再跑 `cargo tauri icon` 生成全套。
7. 验收：`cargo tauri dev` 启动后窗口出现，显示 Svelte 首页。

测试：
- Rust：`cargo test`（先只跑默认空 test）。
- 端到端：`scripts/verify-app.ps1` 启 tauri dev，curl `http://127.0.0.1:5173/` 期望 200。

### M0-b：Sidecar PyInstaller 打包

**目标**：`binaries/python-backend.exe` 单文件，**不依赖**任何 Python 安装，独立起 8765。

步骤：
1. `frontend/pyinstaller/python-backend.spec`：
   - `Analysis(['-c', 'from backend.app.main import app; print("READY", flush=True)'])` 或写一个独立 `run_server.py` 入口（更稳）
   - `hiddenimports`: `fastapi`, `uvicorn`, `uvicorn.logging`, `uvicorn.loops`, `uvicorn.loops.auto`, `uvicorn.protocols`, `uvicorn.protocols.http`, `uvicorn.protocols.http.auto`, `uvicorn.protocols.websockets`, `uvicorn.protocols.websockets.auto`, `uvicorn.lifespan`, `uvicorn.lifespan.on`, `watchdog`, `watchdog.observers`, `watchdog.events`, `PIL`, `PIL._imaging`, `aiosqlite` 之类按需
   - `collect_all`: `fastapi`, `watchdog`, `pydantic`（防漏子包）
   - `onefile=True`, `name='python-backend'`, `console=True`
   - `datas`: 把 `backend/app/templates/`（如有）和 `backend/data/config.json` 模板（如果存在）打进去
2. 写 `run_server.py`：通过 `uvicorn.run(app, host='127.0.0.1', port=8765, log_level='info')` 启动，启动后往 stdout 打一行 `READY {"port": 8765}`。
3. `frontend/scripts/build-sidecar.ps1`：激活 venv → `pyinstaller --clean --noconfirm pyinstaller/python-backend.spec` → 把产物 `dist/python-backend.exe` 拷到 `frontend/src-tauri/binaries/python-backend-x86_64-pc-windows-msvc.exe`（Tauri externalBin 命名约定）。
4. 验收：双击运行 `python-backend.exe` → 等 ~3s → curl `127.0.0.1:8765/api/health` 期望 `{"status":"ok"}` → 关进程。

测试：
- `backend/tests/test_sidecar_artifact.py`：用 `subprocess.Popen` 启打包后的 exe，等待 stdout 出现 `READY`（30s 超时），curl `/api/health`，再 `terminate()`。前提：M0-b 跑过一次。
- 暂未跑 PyInstaller 的情况下，标记为 `@pytest.mark.skip`。

### M0-c：Rust 端 sidecar 生命周期

**目标**：Tauri 主进程 spawn sidecar、等 READY、转发给前端、优雅 shutdown。

设计：

```
Tauri main process
    |
    v
sidecar.rs::spawn()
    |-- Command::new(sidecar_path)         // 从 externalBin 取绝对路径
    |-- .env("SUXING_DATA_DIR", app_data_dir)
    |-- .env("SUXING_PORT", "8765")
    |-- .stdout(piped) / .stderr(piped)
    |-- 异步 task: 读 stdout 行 → match "READY {...}" → emit("sidecar-ready", payload)
    |-- 异步 task: 读 stderr 行 → log::warn! 转发到主进程日志
    |-- 退出码 !=0 → emit("sidecar-died", payload)
    |-- AppHandle::on_window_event(CloseRequested) → sidecar.kill()
```

实现要点：
- 用 `tokio::process::Command` 异步 spawn。
- 用 `tauri::async_runtime::spawn` 起两个 task：stdout 监听 / stderr 监听。
- sidecar path 通过 `app.path().resource_dir()` 拼：在 dev 是 `target/debug/binaries/`；prod 是 `resources/binaries/`。
- 把端口从「写死 8765」改为「Rust 选空闲端口 → 通过 READY 消息告诉前端」 → 前端 `vite.config.ts` 代理也得跟着改。**但**为了不破坏现有前端构建链路（M0 最小目标），先继续写死 8765 + 前端启动前显示 loading，sidecar 死后弹 toast 让用户重启 App。这一步在 M0-c 注释里留 TODO。

实现文件：
- `sidecar.rs`：`SidecarState { handle, child, port: u16, ready: AtomicBool }`
- `commands.rs`：`#[tauri::command] fn get_sidecar_status(state: State<...>) -> SidecarInfo`
- `main.rs`：setup hook 中 `app.manage(SidecarState::default())` + spawn sidecar

验收：
- `cargo tauri dev` 启动后，前端 dev server 起 + Tauri 窗口起 + sidecar 进程起（Task Manager 可见）。
- `curl 127.0.0.1:8765/api/health` 返回 ok。
- 关窗口 → sidecar 进程退出（Task Manager 消失）。

### M0-d：前端适配

**目标**：前端等 Tauri `sidecar-ready` 事件后才发请求；UI 给出 loading + 错误兜底。

实现：
- `frontend/src/lib/tauri.ts`：`isTauri()` 判断是否在 Tauri WebView 中。
- `frontend/src/lib/api.ts`：在 `isTauri()` 时 listen `'sidecar-ready'` 事件，set `backendReady=true`；未 ready 时所有 API 调用排队 / 报"后端启动中"。
- `frontend/src/App.svelte`：显示 splash overlay 直到 ready。
- `frontend/src/components/SidecarStatusToast.svelte`（新）：订阅 `'sidecar-died'` 显示「后端进程已退出，请重启应用」。

验收：
- 冷启动 → splash 显示 ~3s → 自动消失进入主页。
- 手动 kill sidecar 进程 → toast 弹出。

### M0-e：构建 NSIS 安装包

**目标**：`cargo tauri build` 产出 `.exe` 和 `苏醒图库_0.1.0_x64-setup.exe`。

步骤：
1. `cargo tauri build` 在 `frontend/src-tauri/` 跑。
2. 预期产物：`frontend/src-tauri/target/release/苏醒图库.exe` + `target/release/bundle/nsis/苏醒图库_0.1.0_x64-setup.exe`。
3. 把这两个产物路径记到 `materials/29-tauri-m0-delivery.md`。

测试：
- 安装包静默安装到 `C:\Program Files\苏醒图库\`。
- 双击桌面快捷方式 → 启动 → sidecar 自动 spawn → UI 出来。
- 控制面板卸载 → 残留目录清理验证。

### M0-f：文档 & 提交

- `README.md` 在「本轮交付」加 "M0 完成 = Tauri 壳 + sidecar + NSIS 安装包"。
- 新增「桌面 App 快速开始」段落。
- `materials/29-tauri-m0-delivery.md`：实施记录 + 关键截图 + 已知限制。
- Git：每个子阶段一个 commit。

## 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| Rust 单元 | `cargo test` | sidecar path 解析、env 注入、READY 解析 |
| Rust 集成 | `cargo test --test integration` | spawn sidecar.exe → 等 READY（前提 build 跑过） |
| Sidecar 产物 | pytest `test_sidecar_artifact.py` | 启 exe → 等 READY → curl health |
| 端到端 | `scripts/verify-app.ps1` | tauri dev 启动后 curl 8765 health |
| 安装 | 手动 + 冒烟脚本 | NSIS 静默安装 → 启动 → 卸载 |

所有测试必须通过才能交付 M0。

## 已知限制 / 推迟项（沿用 `materials/00-implementation-decisions.md`）

- **多窗口 / 系统托盘 / 全局快捷键**：P1，M0 只做单窗口。
- **原图 asset:// 协议**：P1，M0 让前端用 `http://127.0.0.1:8765/api/images/{id}/file` 直接拿（与 Web 版一致）。
- **原生文件对话框**：P1，前端用 `<input type="file">` 暂时满足设置页目录选择。
- **代码签名**：无证书，Windows Defender 会报警（仅打包测试，不分发给外部用户）。
- **跨平台**：本计划仅 Windows；macOS / Linux 暂不涉及。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| PyInstaller hiddenimports 漏包，启动崩溃 | M0-b 先用 dev 模式跑 spec；漏了就补 hiddenimports；用 `collect_all` 兜底 |
| Tauri build 编译慢（首次 5–15 min） | 后台 build，期间做 M0-d 前端；预先 `cargo fetch` |
| MSVC 链接器版本与 Tauri 2 不兼容 | 已确认 VS Community 2026（18.9）+ MSVC 19.51；理论上 Tauri 2 已支持 |
| WebView2 bootstrapper：旧版 Win10 没装 WebView2 | `tauri.conf.json` 加 `bundle.windows.webviewInstallMode: downloadBootstrapper`；或降级到 embedBootstrapper |
| 数据迁移：Web 版 `backend/data/` → Tauri `%APPDATA%\苏醒图库\` | M0 不做迁移；首次启动 sidecar 检测旧 db 存在则提示用户手动复制（TODO） |

## 验收清单（M0 完成判定）

- [ ] `cargo tauri dev` 弹出窗口并自动 spawn sidecar
- [ ] 前端能在窗口内正常浏览 / 搜索 / 收藏 / 打开 ComfyUI（与 Web 版一致）
- [ ] 关窗口 → sidecar 进程被清理
- [ ] `cargo tauri build` 成功产出 `.exe` + NSIS 安装包
- [ ] NSIS 装包 + 桌面快捷方式可用 + 卸载干净
- [ ] `cargo test` + `pytest` + `pnpm test` 全绿
- [ ] README / PLAN / materials/29 文档齐
