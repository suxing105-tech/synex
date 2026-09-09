# 桌面启动超时诊断

## 实际发现

- 用户报告 `spawn failed: not ready within 30s`。
- 检查时 8765 监听进程为 PID 15224，路径 `C:\Program Files\苏醒图库\python-backend.exe`，旧桌面父进程已退出。
- PyInstaller 单文件程序包含启动器和服务子进程。此前 Rust 只停止直接子进程，Python 未使用已有的 `SUXING_PARENT_PID`，可能残留服务进程。
- Rust 此前只等待 READY，未检查进程提前退出；前端只订阅事件，可能错过 WebView 加载前发出的 READY。

## 修复依据

- Python 使用 Windows 进程句柄监控桌面父进程及 PyInstaller 启动器，任一退出后服务随即退出。
- Windows 官方说明：进程句柄支持 WaitForSingleObject，需 SYNCHRONIZE 权限。
  https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject
- Uvicorn 本地实现仅在 lifespan 初始化及端口绑定成功后设置 `server.started`。在 startup 完成且 started 为真后发出 READY；直接 await serve 传播失败。
- Rust 提前检查端口、监控子进程、记录失败状态，并在超时后清理进程。
- 前端先订阅事件，再读取状态快照；较新的事件优先，初始化只执行一次。

## 提交范围

本次在工作区已有的 splash-gate 抽取基础上修复。为使提交可独立运行，包含相关 App.svelte 接线及对应测试；其余历史未提交文件不纳入。

测试、打包日志和实际二进制验证脚本位于 `outputs/startup-fix/`。
