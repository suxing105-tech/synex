# 闪寻空间 (Seek-X)

![闪寻空间 - 图片与视频本地媒体管理器](docs/images/main.png)

**闪寻空间 (Seek-X)** 是面向 ComfyUI 用户的**本地图片、视频、音频与文本管理器**。它会自动扫描你配置的目录，把 AI 生成的成品按文件夹/时间整理成瀑布流，并支持反推提示词、标签、全文搜索，以及本地视频播放、对比与音频波形播放。

> 由「苏醒图库」更名而来，界面、数据目录与更新通道保持不变。

---

## ✨ 核心能力

### 图片 & 视频统一管理
- 三栏布局：左侧文件夹树 / 中间瀑布流缩略图 / 右侧详情面板
- 默认落在**所有素材**：图片、视频、音频、文本按时间混排在一条无限滚动的流里，用类型 chips 单选过滤（默认「全部」，点某类只看那类）
- 图片：PNG / WebP / JPG / PSD 等，自动解析常见元数据（A1111 / ComfyUI tEXt）；PSD 缩略图按 9:16 裁切铺满，预览显示合成画面，右键可在 Photoshop 中打开
- 视频：MP4 / MOV / M4V / WebM / MKV / AVI / WMV / FLV，自动生成**海报帧缩略图**，点击播放按钮内嵌播放，支持**左右对比（默认）/ 分割对比**（开关和图片一样在顶栏正中，`S` 反复切换），对比时右键画面可**同步播放 / 同步停止 / 取消同步**，可**一键改封面**
- 音频：MP3 / WAV / FLAC / M4A / AAC / OPUS / OGG 与图片视频同等入库（单文件上限 200MB，够放 24bit FLAC 母带），21:9 的**懒生成波形缩略图** + 时长徽标，**点缩略图就地播放、再点暂停**（进度画在卡片顶部，没有常驻底栏）、右键**复制音频**是把文件本身放进剪贴板（可直接粘进文件夹）；内核解不了的容器一键转系统播放器
- 缩略图生成与磁盘缓存，滚动流畅
- 瀑布流工具栏自适应：宽列时搜索框落在工具栏正中间（全圆角 pill，点进去提示文字自动隐去，失焦回来）；详情面板展开、窗口变窄时类型 chips 与列数滑块整组贴右并自动换行，**不会被面板裁掉**，也不会被拉开成大空档
- 全局快捷键：<code>Ctrl+F</code> 光标直接进搜索框（原有内容整段选中，接着打字即替换）、<code>F</code> 沉浸循环（收起左右侧栏 → 最大化 → **全屏只剩缩略图**（标题栏、两条侧栏、搜索工具栏全部退场）→ 还原窗口与原侧栏，再按从头再来）、对比中 <code>S</code> 在左右与分割之间反复切换（图片和视频同一个开关、同一份偏好）。这几条连同侧栏 / 复制 Prompt 都能在「设置 → 快捷键」里改键

### 本地文本管理
- 支持 TXT / Markdown / SRT / VTT，关联原文件或目录，编辑直接保存到原文件
- 多文档标签页、Markdown 阅读与编辑、中文正文搜索、标签
- 自动保存、外部修改冲突提示、本地草稿和历史版本；删除进入系统回收站
- 双击文件名改名、长按拖动排序；拖动列表右侧分隔线调整宽度
- 侧栏一行一个口径，快捷键 <code>Q</code> 或 <code>0</code> 回所有素材，<code>A / I / V / T</code> 切音频、图片、视频、文本（输入时不触发；这五个键不给自定义快捷键占用）

### 反推提示词
- 内置 **OpenAI 兼容**的几家 API 预设（含 DeepSeek），各预设提供多个模型下拉
- 输入 API Key 保存即可使用；也保留**手动自定义**入口
- 支持简单 / 详细两档提示词输出

### 整理 & 搜索
- 文件夹树：来源目录 + 我的文件夹，支持**新建 / 重命名 / 上移 / 下移 / 所在文件夹位置 / 归档**
- **来源目录 = 导入的那个文件夹本身**：它先是一个节点，里面的子目录逐级展开在它下面；标题右边的 `+` 直接添加来源目录
- 来源目录只登记位置 + 递归监听，**不复制也不移动任何文件**；改它的名字只是图库里的显示标签，磁盘上的真实目录不动（「我的文件夹」住在图库数据目录里，改名仍同步物理目录）
- **归档 ≠ 删除**：右键「归档」只在图库里收起这个目录和它里面的素材，磁盘上的文件夹与文件一个都不动，标签也留着；恢复在 设置 → 通用 → 已归档目录，侧栏会写明有几个目录被归档了。「删除文件夹（移入回收站）」只出现在**我的文件夹**上——那些目录本来就在图库数据目录里，才可以连磁盘一起删
- 标签（逗号分隔，自动去重）
- 侧栏计数只有一个口径：每行显示当前类型的数量，分组标题右侧写明「计数 · 音频」，hover 给出四类明细；一万以上折成「1.2万」
- 全文搜索（SQLite FTS5 + 模糊双轨）
- 批量多选、拖拽导入

### 桌面体验
- **自带 ffmpeg / ffprobe**：视频海报帧、音频波形、读取视频容器里的 ComfyUI 工作流不再要求用户自己装 ffmpeg（旧版在没有 ffmpeg 的电脑上海报和提示词会静默变空）
- 设置 → 关于与更新 常驻「媒体组件」状态，直接显示 ffmpeg/ffprobe 的版本与来源，缺了会写清下一步
- 左侧栏 & 右侧详情栏均可一键收起
- ComfyUI 一键打开（生成临时 `.json` 并跳转）
- Onboarding 引导、扫描进度、快捷键
- 签名自动更新（GitHub Releases）

---

## 🛠 技术栈

| 层 | 技术 |
|------|------|
| 桌面壳 | Tauri 2 (Rust) + NSIS `x64` |
| 后端 | Python FastAPI + SQLite / FTS5 |
| 前端 | Svelte 5 + Vite + Tailwind |
| 视频 / 音频处理 | `ffmpeg` / `ffprobe`（海报帧、波形图、时长与编码信息，无额外 Python 依赖；随安装包自带，不要求用户自装） |
| 平台 | Windows |

---

## 🚀 安装

从 [GitHub Releases](https://github.com/suxing105-tech/synex/releases) 下载最新版 `suxing-gallery_<版本>_x64-setup.exe` 安装即可。已装用户可通过应用内更新自动升级。

### 从源码构建

```powershell
# 0) 准备 ffmpeg / ffprobe（安装包要用，约 5s；已备好会跳过）
#    依次找 -SourceDir → vendor\media-tools\ → PATH（winget 装的即可），
#    命中后缓存进 vendor\media-tools\（已 gitignore，约 190MB）
& "frontend\scripts\fetch-media-tools.ps1"

# 1) 打包后端 sidecar（约 30s）
& "frontend\scripts\build-sidecar.ps1"

# 2) 构建 Tauri + NSIS（约 30s~5min）
cd frontend\src-tauri
cargo tauri build

# 产物
#   target\release\suxing-gallery.exe                     主程序
#   target\release\bundle\nsis\闪寻空间_<版本>_x64-setup.exe   NSIS 安装包
```

> `build-preview.ps1` / `package-release.ps1` / `build-update.ps1` 会自己先跑第 0 步，缺工具直接中止并告诉你要放哪些文件，不会再打出「装了也用不了」的包。
> 安装包里的 ffmpeg/ffprobe 来自 gyan.dev 的 GPL-3.0 构建，许可证全文随包安装为 `ffmpeg-LICENSE.txt`。
> 发布、预览包与公网校验的完整流程见 [docs/release-process.md](docs/release-process.md)；签名安装包由 `frontend\scripts\build-update.ps1` 产出（需更新签名私钥）。

### 本地开发

```powershell
# 后端
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8765

# 前端（新终端）
cd ..\frontend
pnpm install
pnpm dev        # http://localhost:5173（代理到 8765）
```

---

## 🧪 测试

- 后端：`558 passed + 1 skipped`（parser / indexer / repository / api / video / audio / folders / text / psd / 迁移 / 发布脚本；需在 `backend\.venv` 里跑，那里才有 `psd_tools`，用系统 Python 会跳过 1 条 PSD 用例）
- 前端：`876 passed`（107 个测试文件）
- Rust：`43 passed` + 1 个集成测试（另有 1 个需真机环境的集成测试默认 ignore）
- `svelte-check`：`0 errors`

```powershell
# 一次跑完上面四套（日志与 VERIFY.txt 落在 outputs\verify-latest）
powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\verify-all.ps1

# 后端单独跑
cd backend && .\.venv\Scripts\python.exe -m pytest -q

# 前端单独跑
cd frontend && pnpm test -- --run
```

---

## 📁 目录结构

```
闪寻空间\
├── backend\                # FastAPI 后端
│   ├── app\                # 入口 / 解析 / 缩略图 / 索引 / 仓储 / 路由
│   └── tests\              # pytest
├── frontend\               # Svelte 5 + Vite + Tailwind
│   ├── src\                # App / 组件 / stores / api
│   ├── src-tauri\          # Rust 壳 + NSIS 配置（resources\ 放随包的 ffmpeg 许可证）
│   └── scripts\            # sidecar / 更新 / 发布 / ffmpeg 取用脚本
├── vendor\media-tools\     # 本地 ffmpeg/ffprobe 缓存（gitignore，打包时进安装包）
├── docs\images\            # README 配图
├── outputs\                # 产品 / 技术文档、构建产物
└── materials\              # 调研 / 决策记录
```

---

## 🔌 API 简表（部分）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/images?kind=&folder_id=&q=&tag=&limit=&offset=` | 单一类型列表（`kind=image|video|audio`） |
| GET | `/api/items?folder_id=&q=&tag=&kinds=&sort=&limit=&offset=` | **所有素材**统一流（四类混排 + 分类型计数） |
| GET | `/api/images/{id}` | 详情 |
| GET | `/api/images/{id}/file` | 原文件 |
| GET | `/api/videos/{id}/file` | 视频流（支持 Range 拖动） |
| GET | `/api/videos/{id}/thumb` | 海报帧 |
| GET | `/api/videos/{id}/open` | 用系统播放器打开 |
| GET | `/api/audio/{id}/file` | 音频流（支持 Range 拖动） |
| GET | `/api/audio/{id}/waveform?w=&h=` | 波形图，默认 840x360（21:9）与卡片同比例（波形只画中间一条再补透明边；懒生成 + 落盘缓存，缺 ffmpeg 时 404 由前端降级） |
| POST | `/api/audio/{id}/open` | 用系统播放器打开 |
| POST | `/api/images/{id}/tags` | 标签 |
| GET | `/api/folders` · POST · PATCH · DELETE | 文件夹管理 |
| POST | `/api/folders/{id}/move?direction=` | 上移/下移 |
| GET | `/api/health` | 健康检查 + 媒体工具诊断（`media_tools.tools.{ffmpeg,ffprobe}` 的 path/source/version） |
| GET | `/api/stats` | 统计（`total_images` / `total_videos` / `total_audio` / `total_texts` / `folders`） |
| GET | `/api/folders` | 文件夹树，节点带 `counts{image,video,audio,text}` + `total` |
| PUT | `/api/integrations/comfyui/config` | ComfyUI 配置 |
| WS | `/ws/events` | 实时事件 |

---

## 📝 说明

- 视频/音频处理依赖的 ffmpeg 由安装包自带；临时换版本或排障可设 `SUXING_FFMPEG_DIR`，或把 `ffmpeg.exe`/`ffprobe.exe` 放进数据目录的 `tools\` 文件夹（查找优先级：`SUXING_FFMPEG_DIR` → 可执行文件同级 → 内嵌目录 → `数据目录\tools` → `vendor\media-tools` → PATH）。
- 本仓库暂无 `LICENSE`；如需开源授权请补充。
- 自动更新使用签名安装包，更新清单见 Release 里的 `latest.json`。
- 详细设计 / 决策记录见 `outputs/`、`materials/`。
