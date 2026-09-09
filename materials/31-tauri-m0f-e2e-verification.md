# Tauri M0-f 端到端交付 — E2E 验证
# 日期：2026-09-09
# 范围：M0-f splash 防黑屏修复 — 真实 Tauri WebView2 主窗口验收

## 一、验证目标

M0-f 修复（commit 958c39c + 38b7d2a）只在源码 + 测试层验证过：
- pnpm test 通过 ✓
- pnpm build 含 splash 类名 ✓
- cargo check 通过 ✓

但**没有在真实 Tauri WebView2 主窗口里肉眼验证过 splash 是否真的渲染**。
本次补做端到端验收 — 新构建 Tauri exe + 启动 + 截屏。

## 二、构建产物

```
frontend/src-tauri/target/release/suxing-gallery.exe   4.5 MB   (含新 splash 源码)
frontend/src-tauri/target/release/python-backend.exe   25.3 MB  (sidecar)

outputs/tauri-m0f-e2e/run/        → 含 sidecar（fast-path 测试用）
outputs/tauri-m0f-e2e/run-nosidecar/ → 不含 sidecar（slow-path 测超时）
```

构建命令：`cargo tauri build --no-bundle`（不打 NSIS，省 4-5 min），编译耗时 1m24s。

## 三、Fast-path 验证（带 sidecar，预期 splash 短到几乎不可见）

时间线（fullscreen 截图）：

| 时间 | 状态 | 证据 |
|---|---|---|
| t=0s | Tauri 主进程启动，无窗口 | fast-t00s.png |
| t=1s | **splash 显示中**（红 logo + spinner + "正在启动后端进程…"） | fast-t01s.png |
| t=2s | **主 UI 完整渲染**（文件夹树 + 搜索栏 + 空状态） | fast-t02s.png |
| t=5s+ | 稳定运行 | fast-t05s.png / fast-t10s.png |

**结论**：splash → 主 UI 切换约 1s（WebView2 cold start ~ 1.5s 与 sidecar 启动 ~ 1-2s 并行，谁先 paint 谁先呈现）。功能正确。

## 四、Slow-path 验证（无 sidecar，预期 splash 持续 + 30s 超时切错误卡）

时间线（fullscreen 截图）：

| 时间 | 状态 | 证据 |
|---|---|---|
| t=5s | **splash 持续显示**（红 logo + spinner + "正在启动后端进程…"） | fullscreen-t05s.png |
| t=15s | **splash 持续显示**（sidecar 仍未就绪） | fullscreen-t15s.png |
| t=30s | **30s 超时** markBackendFailed 触发，切错误卡 | nosidecar-t30s.png |
| t=35s | **红字错误卡完整显示**："后端进程异常：后端进程启动超时（30s）" + "请关闭应用并重试；若反复失败，运行 build-sidecar.ps1 重建 sidecar 后再启。" | fullscreen-t35s.png |

**结论**：splash 持久显示 + 30s 超时机制完整生效，错误提示含 `build-sidecar.ps1` 重建指引。

## 五、关键截图

| 文件 | 内容 |
|---|---|
| outputs/tauri-m0f-e2e/fast-t01s.png | fast-path t=1s，splash 显示（spinner + 启动文案） |
| outputs/tauri-m0f-e2e/fast-t02s.png | fast-path t=2s，splash 消失，主 UI 渲染 |
| outputs/tauri-m0f-e2e/fullscreen-t15s.png | slow-path t=15s，splash 持续 |
| outputs/tauri-m0f-e2e/fullscreen-t35s.png | slow-path t=35s，30s 超时错误卡 |

## 六、为什么 M0-f 修复是真的有效

| 场景 | 修复前（M0 旧 dist） | 修复后（M0-f 源码） |
|---|---|---|
| dev `pnpm dev` | splash 显示 → 后端 ready → 主 UI（dist 含 splash 代码） | 同左（源码一致） |
| prod `cargo tauri build` + 启动 | **#app 空 div 黑屏**（源码没 splash 代码，dist 永远落后） | splash 显示 → 后端 ready → 主 UI（源码 + dist 都含 splash） |
| prod 启动但 sidecar 异常 | 黑屏，用户不知道是后端问题还是前端崩溃 | 30s 内显示 splash，30s 后切红字错误卡 + 重建指引 |

## 七、验收状态

**M0-f 验收通过**：
- ✅ Splash overlay 在 Tauri WebView2 主窗口真实渲染（fast-path t=1s 截图）
- ✅ Splash → 主 UI 切换由 backendReady 状态控制（fast-path t=2s 截图）
- ✅ Splash 持久显示当 backend 未就绪（slow-path t=15s 截图）
- ✅ 30s 超时切红字错误卡 + build-sidecar.ps1 提示（slow-path t=35s 截图）
- ✅ 修复来源（源码）= 修复产物（dist），下次 cargo tauri build 不会再丢

## 八、仍待完成（M1+）

- [ ] sidecar 异常时把 stderr 错误日志写到错误卡下方（便于排查）
- [ ] splash 文案 polish（"正在启动后端进程…" vs "Loading…"，与产品沟通）
- [ ] NSIS 装机后再跑一遍 E2E 验证（覆盖 perMachine 部署场景）
- [ ] M1: NSIS 打包脚本进 CI、签名（自签测试证书）
- [ ] M2: 多语言、自动更新、Tray icon
- [ ] M3: 全局快捷键唤起
- [ ] M4: 性能与稳定性 profile