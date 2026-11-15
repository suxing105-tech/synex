# MEMORY 索引

闪寻空间（Seek-X）的当前有效事实、已确认决策与未完待办。原始资料在 `Resources/`（本仓库暂无），
长期知识沉淀在 `Wiki/`（本仓库尚未建立）。

| 文件 | 内容 | 什么时候看它 |
|---|---|---|
| [决策点.md](决策点.md) | 已经确认的设计决定，以及当时为什么这么定 | 改 UI / 改交互前先看，避免把定过的规矩改回去 |
| [待办.md](待办.md) | 未完成事项、已知风险、需要用户拍板的问题 | 开工前扫一眼 |
| [事实.md](事实.md) | 会变但当前有效的客观信息（版本、端口、目录、测试规模） | 需要引用"现在是什么样"的时候 |

## 项目一句话

面向 ComfyUI 用户的**本地**图片 / 视频 / 音频 / 文本管理器：自动扫描配置的目录，
把 AI 产物按文件夹与时间铺成瀑布流，支持反推提示词、全文搜索、对比与工作流下载。
数据全在本机，不上云（另有可选的云端生成 API）。

## 当前状态（2026-11-15）

- 版本 **0.2.37**，六处版本号一致。
- dev 栈在跑：前端 <http://127.0.0.1:5199/>、后端 <http://127.0.0.1:8897>，跑的是仓库当前代码。
- 前端 **150 个测试文件 / 1645 个用例全绿**；`svelte-check` 0 error / 20 warning（warning 全是既有 a11y 提示）。
- 「选一张参考图」弹窗左栏现在有**文件夹分类**：按「来源目录 / 我的文件夹」分组，点哪一类只看哪一类，
  每行右侧只数当前这一族；与搜索词、族 tab 正交叠加，互不清空。
- 素材选择器开着的时候**右侧详情栏整个让位**（连分隔条一起收，中间列变宽）：它显示的还是
  上一张选中卡的提示词与参数，挑新素材时既干扰又是错的信息。
- 「提示词优化技能」现在能导**一整个技能包目录**（Codex 那种：SKILL.md + references/ + scripts/）：
  正文当写法，文本类附属文件作参考资料一起发给模型（预算 2 万字，正文点名过的优先），
  脚本只当参考文本不执行。桌面版选文件夹，浏览器开发模式走目录上传。

## 目录地图

```
frontend/          Svelte 5 + Vite + Tailwind 前端，src-tauri/ 是 Tauri 2 桌面壳
backend/           FastAPI + SQLite(FTS5) 后端，data/ 下是图库数据库与缓存
docs/              README 配图、发布流程等文档
materials/         每轮设计/功能迭代的原始素材（只读参考）
outputs/           构建产物、探针脚本、dev 栈日志（大部分被 .gitignore）
vendor/media-tools 自带的 ffmpeg / ffprobe（~190MB，被 gitignore）
```

## 工作流要点

- 开发：`powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\launch-dev.ps1`
  （`-Restart` / `-Stop` / `-CheckOnly`）。端口**故意**跟正式版 sidecar 错开，别手打 README 默认端口。
- 全量门禁：`frontend\scripts\verify-all.ps1`（后端 pytest + 前端 vitest + svelte-check + cargo）。
- 提交约定：改完就 `git commit`，提交信息用中文，不加任何 AI 署名。
