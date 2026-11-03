# 一键同款 · 云端 API 生成（图片 / 视频 / 语音）实施计划

基线：0.2.33（93eacd5）。日期：2026-11-02。
本文只定方案与顺序，不含代码改动。
2026-11-03 补：弹窗与设置页的确切交互以 **§11** 为准（苏醒给了草图）。

---

## 0. 结论先行

**这不是「再加一条上传通道」，是给一键同款加第二个执行引擎（engine）。**

现在整条链路 = 「一份 ComfyUI API 格式工作流 + 本机 GPU」的壳：模板存工作流 JSON、槽位靠 object_info 检测、参考素材推 /upload/image、产物靠「ComfyUI 的 output 目录正好被监听」认领、任务只在内存里、跑一次多少钱等于电费。云端 API 六项全反：没有工作流、没有 object_info、产物在远端要下载、跑十分钟、按次收钱、而且很多任务取消不了。

所以正确的切法是把「槽位」升级成后端无关的契约：云端模板复用同一套槽位与同一个弹窗，POST /api/clone/generate 的请求体一字不改。engine 是模板的属性，不是用户新学的一个概念。

**顺序建议：图片 → 语音 → 视频。** 图片和语音是秒级、便宜、多数同步返回，能最快把「engine 分派 + 产物落盘 + 花钱确认」这套底座跑通；视频是异步长任务，会额外逼出「task_id 必须落库、重启能取回产物」这个真实的状态模型改动（见 D7），放最后单独一轮，别让它把前面的验证拖脏。

---

## 1. 现状盘点：一键同款里的 6 个 ComfyUI 假设

| # | 现有假设（代码位置） | 云端现实 | 影响 |
|---|---|---|---|
| 1 | 模板 = ComfyUI API 格式工作流 JSON（clone_templates.parse_workflow） | 云端没有工作流，只有 model + 参数 | 模板表要能表达「无工作流」 |
| 2 | 槽位从 object_info 检测（detect_slots + _object_info） | 云端参数表在服务商文档里 | 槽位改成声明式，内置模板不联网（与 clone_bundled 同一条理由） |
| 3 | 参考素材推 /upload/image，节点里填文件名 | 多数要 base64 / data URL / 公网 URL | 需要编码层 + 尺寸体积预压 |
| 4 | 产物 = watch_dirs 里新出现的文件（_output_on_disk） | 产物是响应里的 b64，或一个会过期的下载链 | 必须下载落盘，落盘位置要有规矩 |
| 5 | /prompt 排队 → /history 轮询 → /interrupt 中止 | 各家不同：同步返回 / submit+poll / 不可取消 | 取消语义要按后端能力说实话 |
| 6 | 花钱 = 电费，所以随便点 | 按次或按秒计费，取消常不退费 | 需要开关、预估、流水、上限 |

一条已有教训直接适用（Round 40）：**「两条链路两个网络栈」是这套代码反复出问题的形状**。这里必须一开始就杜绝——校验只有一份，执行器才分两个。

---

## 2. 架构决策

### D1 · 模板加 engine，不加新概念

clone_templates 加 4 列（在 initialize() 里按 reverse_prompts 补 provider 列的老办法 ALTER，老库自动升级）：

- engine TEXT NOT NULL DEFAULT 'comfyui'（comfyui | cloud）
- provider TEXT（volc / minimax / openai / …）
- model TEXT
- params TEXT(JSON)（默认参数：比例、时长、分辨率、音色的缺省值）

workflow 列对云端为 NULL。media_kind（image/video/audio）不动——它已经是「这一族卡片用哪条」的维度，engine 只是正交的第二维。

**影响**：GET /api/clone/templates 多回 4 个字段；前端 CloneTemplate 类型加 4 个可选字段；工作流选择器多一个「本机 / 云端」前缀。弹窗其余逻辑不动。

### D2 · 槽位由适配器声明，不再检测

新增 backend/app/cloud/spec.py：每个云端模型带一份静态 slot spec，形状与 detect_slots() 的输出完全一致（prompt / image / audio / video / select / number）。

- reference_cells()、promptGroups()、controlSlots()、mode_from_count()、plan_request() 全部原样工作；
- 内置云端模板像 bundled_workflows/*.json 一样随安装包发布（clone_bundled 那条「槽位固化、首启不联网」的理由对云端更成立——云端的参数表本来就不在用户机器上）；
- 控件的 options 来自 spec，不来自 object_info，所以「ComfyUI 没开导致比例/分辨率控件被静默丢掉」这一整族坑对云端模板天然不存在。

### D3 · 一份校验，两个执行器

clone_jobs.start() / plan_request() 保持不变，做**唯一**的请求校验（槽位存在、每族从第 1 格连着放、素材族别对得上、控件键是声明过的）。分派只发生在 _run() 里：

    _run(job) → engine == "comfyui" → _run_comfyui(job)   # 现有代码原样搬进来
              → engine == "cloud"   → _run_cloud(job)

云端不复用 build_workflow()（那是 ComfyUI 节点图操作），新增 build_cloud_request(template, prompt, slot_prompts, refs, controls)，但它读同一份 slots。**别写第二套参数校验**，否则又会出现「弹窗里合法、后端说不合法」两边打架。

### D4 · 云端产物落 data/generated/，不新增 watch_dir

新增 config.generated_dir() → <data>/generated/{image,video,audio}/YYYY-MM-DD/，下载后走 _register_output(path)（它接受任意 Path，内部就是 Indexer._process_path_sync）入库，并按 ensure_source_root_folder 的既有路子给侧栏一个「云端生成」来源节点。

- **不把 generated 加进 watch_dirs**：自己监听自己 = 同一文件被 watcher 与直接索引抢。inbox 已经给过结论（inbox 不在 watch_dirs，直接索引）。
- 语义差别要说清：本地出图是「认领 ComfyUI 写的文件」，云端是「图库自己写的文件」。两者都不是复制，images.path 就是权威位置。

### D5 · 代理口径和上一轮的 ComfyUI 修复正好相反（最容易踩）

Round 40 刚把 ComfyUI 的请求改成 trust_env=False + ProxyHandler({})（本机服务绝不走代理）。**云端必须反过来**：这台机器挂着 Clash/v2rayN，OpenAI / Gemini 这类要走代理才通；而火山 / 阿里 / MiniMax 走代理常常反而超时或 502。

云端客户端：httpx.AsyncClient(trust_env=True)（即默认），并给每个账号一个 proxy_mode：

- system（海外服务商默认）：跟随 HTTP(S)_PROXY；
- direct（国内服务商默认）：挂一个空代理 transport；
- 设置页每条账号一个「测试连通」，失败说人话原因（沿用 /status?draft= 那套 reason_code：refused/timeout/http_401/http_403/http_429/dns/proxy）。

这条不写进代码注释，下一个人照抄 comfyui_client.py 就会做出「只有 Python 侧连不上云端」的新 bug。

### D6 · 凭据复用 DPAPI，但另起一张账号表

reverse_prompts.py 里的 crypt()（DPAPI CurrentUser，无 UI）与 key_for()（非 Windows 只存进程内）抽成 backend/app/credentials.py，视觉模型与云生成共用同一套加密口径。**API Key 只进 credential BLOB：不回显、不写日志、httpx 日志里 Authorization 打码。**

新表（不放 model_configs）：

    gen_accounts(id, provider, name, base_url, credential BLOB, proxy_mode,
                 enabled INTEGER DEFAULT 0, created_at)

理由：一个 MiniMax / 火山方舟 key 同时出图、出片、出声音；model_configs 是「一行 = 一个视觉对话模型」的语义，硬塞会让反推提示词的卡片长出无关字段。

### D7 · 云端任务必须落库（本轮唯一的状态模型升级）

现状：任务状态只在内存（_job），重启即丢——本地无所谓，图还在 ComfyUI output 里。**云端不行**：一条视频十分钟，用户关窗 = 钱花了、下载链过期、没人认领。

    gen_tasks(id, provider, model, capability, state, remote_task_id, params JSON,
              estimated_cost REAL, image_ids JSON, error TEXT,
              created_at, updated_at, finished_at)

有了它才谈得上：重启后恢复「有件事还在跑」、链接过期后的「重新取回」、花费流水对账。内存 _job 继续当实时视图，gen_tasks 当账本，同一 job_id 关联。

**并发口径 v1 不变**：全局单任务槽 + 409（现有 clone_progress 契约不带任务数组，前端只有一枚 pill）。代价要写明：云端一条十分钟的视频会把本地 ComfyUI 一起堵在门外。放开「本地 + 云端各跑一条」是后续独立一轮。

---
## 3. 花钱的硬边界（对齐 AGENTS.md「未确认不调用付费服务」）

1. **总开关**：Config.cloud_enabled = False 默认关。在设置页「云端服务」卡片里开；未开时弹窗里云端模板置灰并说明「云端生成未启用」。
2. **点下去之前就知道要花**：生成按钮副文案显示「模型 · 预估消耗 ¥x–y（区间）」。spec.py 存计价档（例如按 1K/2K 两档、按 5/10 秒两档），明确是估算不是账单，别装精确。
3. **上限闸门**：设置页「单次不超过 ¥N」「当日累计不超过 ¥M」，超了后端直接 422 拦住，绝不发给服务商。
4. **花费流水**：gen_tasks + 服务商返回的 usage 落库，设置页给「本月：图片 n 次 / 视频 n 条 / 语音 n 条，累计约 ¥x」。
5. **取消说实话**：cancel() 按适配器能力分两种——能取消的走真取消；不能取消的文案固定为「云端任务已提交，图库只能停止等待，这一条仍会计费」，并要求一次确认。
6. **Key 安全**：DPAPI 存、任何接口只回 has_api_key（沿用 public_config() 的做法）、日志与错误信息打码 Authorization、自定义 base_url 沿用 reverse_prompts.normalize_url 里「不许指向 loopback/内网」那条守卫（防把 key 发给本机服务）。

---

## 4. 接口契约

POST /api/clone/generate、GET /api/clone/jobs/current、POST /api/clone/jobs/current/cancel **请求体不变**（engine 由 template_id 决定）。

新增：

| 端点 | 用途 |
|---|---|
| GET /api/clone/cloud/presets | 服务商 + 能力 + 模型清单（不含任何密钥） |
| GET/POST/PATCH/DELETE /api/clone/cloud/accounts[/{id}] | 账号 CRUD，只回 has_api_key |
| POST /api/clone/cloud/accounts/{id}/test | 连通 + 鉴权 + 模型权限，回 reason_code |
| GET /api/clone/cloud/estimate?template_id=&controls= | 预估消耗区间（弹窗按钮文案用） |
| GET /api/clone/cloud/spend?month= | 花费流水 |
| POST /api/clone/jobs/current/refetch | 长任务链接过期后重新取回产物 |

WS clone_progress 增量字段（前端 applyCloneProgress 必须对缺字段容错）：engine、provider、model、estimated_cost、task_id、recoverable。

前端新文件：frontend/src/lib/cloud-generation.ts、frontend/src/components/CloudServices.svelte（挂进 SettingsModal，抄 ModelSettings.svelte 那张卡片的骨架与「测试连通」交互）。

---
## 5. 服务商怎么选（需要你拍板，见 §10）

选服务商的第一性判据不是「哪家有名」，是**哪家能让你已有的提示词资产直接变现**——你手上已经有 seedance2.0、h3-prompt-writing、minimax-drama-prompt、image-prompt-qwen21 这几套体系。

| 能力 | 候选（按上述理由排序） | 为什么 |
|---|---|---|
| 图片 | 火山方舟 Seedream 系 · 阿里百炼 Qwen-Image 系 · OpenAI gpt-image 系 | Seedream 直接吃你 Seedance 那套画面描述；Qwen-Image 与本机「闪寻图片」那条 Qwen-image-2.1 同族，风格能续上；gpt-image 的多图编辑与透明底是独一份 |
| 视频 | 火山方舟 Seedance 系 · MiniMax 视频 · 可灵 · Google Veo（经 Gemini） | Seedance 是你已经在写的那套分镜提示词对应的同一模型，同一份提示词两边都能跑，这是最大的复利 |
| 语音 | MiniMax TTS（音色克隆）· 火山豆包 TTS · 阿里 CosyVoice · OpenAI TTS | MiniMax 有文件上传与音色克隆，接得上你现在 Qwen3-TTS 音色克隆那条的两段文字用法 |

**不凭记忆写死的事**：具体 model id、单价、是否支持多参考图、返回是 b64 还是 URL、链接有效期——实现时以各家官网当日文档为准，全部收在 cloud/spec.py 一个文件里，并保留「自定义 model id」入口（providers.py 对豆包 ep-... 就是这么兜底的）。价格档只做估算用。

---

## 6. 云端能力的硬边界（必须写死，否则弹窗能选、跑起来报错）

- **参考素材**：图片参考普遍支持（各家 1～4 张不等，按 spec 的 max_references 收敛）；音频/视频参考在多数云服务商没有（要公网 URL）。所以 v1 明确：云端模板只吃「文本 + 图片参考」，音频族里只放开音色克隆那一条（它有文件上传接口）。不支持的格子**置灰 + 说明**，不能报「要从每族第 1 格连着放」——那句在本机是对的，在云端是骗人。
- **mode_from_count 的 0/1/多 规则在云端按 max_references 截断**：超出张数直接不让加，而不是提交后报错。
- **体积**：参考图送云端前按 spec 上限降采样（复用 reverse_prompts.prepare_image 的 resize 思路），超限要报错而不是静默压糊。
- **超时**：图片 300s / 语音 300s / 视频 1800s。现有 POLL_TIMEOUT=900、POLL_TIMEOUT_VIDEO=3600 是照本机 GPU 定的，云端要按能力重设，别共用一个数。

---
## 7. 里程碑（一轮一交付、一轮一 commit）

**R1 · 底座（用户看不到任何变化）**
credentials.py 抽取（视觉模型那条改用它，行为不变）· gen_accounts / gen_tasks 建表 · cloud/ 包骨架 + CloudBackend 协议（probe / submit / poll / fetch / cancel）· clone_templates 四个新列迁移 · _run() 按 engine 分派（此时只有 comfyui）。
验收：全量后端 pytest 绿（**必须 Push-Location backend**，在仓库根跑会把 outputs/_*.py 当测试收进来）、迁移在旧库副本上跑一遍、clone_progress 契约无破坏。

**R2 · 云端出图（第一条真链路）**
OpenAI-兼容 images 适配器 + 一个国内服务商适配器 + data/generated 落盘入库 + 设置页「云端服务」卡片 + 弹窗工作流选择器分「本机 / 云端」+ 花费预估与确认 + 总开关。
验收：MockTransport 假服务端到端（提交 → 落盘 → 图库里出现这条 → clone_sources 来源对得上）；真机跑通一次，核对预估与账单同量级。

**R3 · 云端出声音**
TTS（含音色克隆一条：参考音频上传 + 台词/参考原文两段文字位）· 音频落 generated/audio · 波形缩略图与播放走既有口径 · 时长与语速控件。
验收：音频卡在云端模板下能出片，且信息条、波形、就地播放都正常（v0.2.31 那批修过的地方要回归）。

**R4 · 云端出片 + 断点取回**
异步 submit+poll 适配器 · gen_tasks 落库与重启恢复 · 过期后 /refetch · 「取消只停止等待」的诚实文案与二次确认 · 进度（服务商给进度就用，不给就显示已等待时长，别画假进度条）。
验收：进程中途 kill 再启动，正在跑的任务能恢复并取回产物；人为把下载链弄过期，/refetch 能救回来。

**R5 · 收口**
预算闸 + 花费页 · 失败自救（401/403/429/5xx 的文案与退避重试）· README 与 MEMORY 回写 · 安装包与快捷入口按惯例验证。

---

## 8. 测试与门禁

- **不打真实网络**。适配器一律注入 httpx.MockTransport（ComfyUIClient 已有 transport 参数，照抄这个设计）；假服务覆盖：成功、401、403、429（退避后仍失败）、5xx（重试一次）、超时、非法 JSON、下载 404。
- 新增 backend/tests/test_clone_cloud.py（分派 / 复用同一套槽位校验 / 落盘入库 / 取消语义 / 花费流水 / 重启恢复）、test_cloud_credentials.py（DPAPI 与非 Windows 退化）、test_cloud_providers.py（spec 自洽：每个模型的 slot 形状能被 reference_cells() 吃下）。
- 前端 vitest：钉住「云端模板渲染出与本机模板同一套槽位控件」、「applyCloneProgress 对新增字段缺省容错」。
- 交付门禁照旧：后端 pytest + 前端 vitest + svelte-check + cargo + build-preview.ps1 出包并 launch-preview.ps1 -CheckOnly。

---

## 9. 风险清单（按「会不会白花钱」排序）

1. **长任务产物链接过期** → 必须 gen_tasks 落 remote_task_id + /refetch（R4）。最容易白花钱的一处。
2. **取消不退费** → 文案说实话 + 二次确认，别让人以为按了取消就没事。
3. **多参考图不支持 / 各家张数上限不同** → spec 的 max_references 在弹窗侧就拦住。
4. **代理把国内服务商打死**（Round 40 的镜像问题）→ proxy_mode + 测试连通 + reason_code。
5. **base64 超限** → 上传前降采样 + 明确报「这张 4.2MB 太大，先压到 2K 以内」。
6. **Key 泄漏面变大** → 云端请求比现在多得多；日志与错误信息打码 Authorization，DPAPI + 只回 has_api_key。
7. **单任务槽被云端长任务占死**（v1 已知代价，写进 UI 说明，不偷偷发生）。
8. **模型 ID / 价格漂移** → 全收在 cloud/spec.py，改一处；自定义 model id 兜底。

---

## 10. 需要你拍板

1. **先接哪两家？** 建议：图片 + 视频都走火山方舟（Seedream / Seedance，一个 key 覆盖两能力，且吃你现成的 Seedance 提示词），语音走 MiniMax（音色克隆）。OpenAI / Gemini 作为 R2 之后的第二家。
2. **账号是否已开通**：Seedream / Seedance / MiniMax TTS 你手上有没有 key、额度还剩多少？没有的话 R2 只能在 Mock 上完成，真机验收推迟。
3. **产物位置**：确认云端产物落 <数据盘>\SeekX-Data\generated\<类>\<日期>\（图库自己写、侧栏一个「云端生成」来源节点）。若要把云端的图和 ComfyUI 的图混进同一个目录，要改的是本机出图的落盘位置，代价更大，不推荐。

---

## 11. 交互确认（2026-11-03 · 按苏醒的弹窗草图）

### 11.1 结论：就是这个形状，而且图里那版比原方案更好

你要的是：设置里配好图像 / 视频 / 音频三条 API，弹窗那枚「切换工作流」的清单里多出三条对等的项目（视频API / 音频API / 图片API），底部「加载本地工作流 JSON」旁边并一颗「选择 API…」，选中哪条就直接用云端出这一族。

原计划 §4 我写的是「工作流选择器加一个本机/云端前缀」——**你这张图的做法更好**：同一个清单、同一种行，不引入第二个概念，也不新加一层视觉编码。以图为准，§4 那句作废。

### 11.2 为什么这张图几乎能白拿

云端条目就是 `engine='cloud'` 的模板行：`media_kind` 决定它进哪一族，`workflow` 为空。于是数据源仍是 `GET /api/clone/templates`，`workflowMenuRows()` 不换数据源，「当前」那颗（`.cm-wf-tag`）、行末删除那颗（`.cm-wf-del`）、底部胶囊的名字（`workflowDisplayName()`）全部自动生效——前提是云端模板也走 `templateDisplayName()`。这正是 D1「engine 挂在模板上」换来的东西。

### 11.3 清单的确切排布

    切换工作流
    [视频] 闪寻视频                          ← 本机
    [视频] 视频API · 火山方舟 Seedance        ← 云端，同族并列
    [音频] 闪寻音频
    [图片] 闪寻图片                      当前
    ────────────────────────────────
    +  加载本地工作流 JSON
    ≡  选择 API…

- **排序：先按族，族内本机在前、云端在后。** 落点就在后端 `list_templates()` 的排序键加一位 engine；不按来源分两段，一族被切两半会让人扫两屏才找到那条。
- **命名**：一族只配一条云端模型时就叫「图片API」；多于一条展开成「图片API · 服务商 模型」。族徽（视频/音频/图片）保持现样，API 不另设颜色——颜色已经全部用在说族别了，再加一层就没颜色可用。
- **一族多条云端模型**：收成一条，底下那排模式按钮改成挑模型。这是音频族折叠那套现成机制（`workflowMenuRows` 的 `collapsed` + `AUDIO_MODE_GROUP_LABEL`），不新写一套。
- **「选择 API…」的行为**：当前族已配 ≥1 条 → 弹一层小清单选服务商/模型；一条都没配 → 直接把设置页开到「云端生成」那张卡并定位到对应那一节。
- **行末删除**：删的是这条云端快捷方式，**不动设置页的账号与 Key**，确认文案要这么写：「删的是这条快捷方式，API Key 还在设置里」。
- 云端模板下的参考位仍按 §6 收敛：图片族能用的就是图片参考，音频/视频格子置灰并说明原因，不要报「要从每族第 1 格连着放」。

### 11.4 底部那颗参数 pill 在云端要说云端的话

草图里是「9:16 / 2.2MP」。`megapixels` 是本机工作流的控件名，云端没有它——云端只有离散档位（例如 1K / 2K，或 1024×1024 这种枚举）。所以云端模板下这颗 pill 由 spec 的 select 选项渲染成「9:16 / 2K」，**不要把 megapixels 这个名字搬过去**，那是让人看见一个云端根本不存在的参数。

### 11.5 设置页：你要的三节

`SettingsModal` 里在「一键同款」旁边加一张「云端生成」，里面三节：**图像生成 / 视频生成 / 音频生成**。每节：服务商下拉 → 模型下拉（+ 自定义 model id）→ API Key（只回 `has_api_key`，永不清回显）→ 代理方式（D5）→ 测试连通（带 reason_code）→ 这一族的默认参数（比例 / 时长 / 尺寸 / 音色）→ 启用开关。卡片底部再放两条全局的：单次与当日花费上限、本月花费流水。

落点：卡片骨架抄 `ModelSettings.svelte`（服务商→模型→Key→测试连通那条链它已经写全），多条目列表与折叠抄 `CloneTemplates.svelte`。一张卡三节，而不是三张卡——设置页已经够长了。

### 11.6 需要你点头的一条语义

**一族只有一个「当前」，本机和云端共抢这一个位置**：点「图片API」→ 之后点任何图片卡，弹窗默认就是云端出图；想换回来再点一次「闪寻图片」。
另一条路是本机留一个当前、云端留一个当前（弹窗默认永远是本机，云端每次手点）。
建议共抢——你在图上把「当前」画在「图片API」上，要的就是让它变成默认；分两个位置等于每次都要手点，功能等于没做。技术上 `_ensure_active_kind()` 已经是按族管 `is_active`，不用碰。

### 11.7 这轮的改动面（对照草图核对）

- 前端 3 处：`workflowMenuRows()` 带出 engine 并改排序、菜单底部那颗「选择 API…」与它的小清单、云端模板下把不支持的参考族置灰。
- 后端 4 处：`list_templates()` 排序键、`cloud/` 包（spec + 适配器 + 凭据）、`gen_accounts` / `gen_tasks` 两张表、`_run()` 按 engine 分派。
- **不动**：`/api/clone/generate` 请求体、`clone_progress` 现有字段、素材选择器、产出认领与来源记录、音频波形与视频首帧那套缩略图口径。
