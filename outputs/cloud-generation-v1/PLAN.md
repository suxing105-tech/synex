# 一键同款 · 云端 API 生成（图片 / 视频 / 语音）实施计划

基线：0.2.33（93eacd5）。日期：2026-11-02。
本文只定方案与顺序，不含代码改动。
2026-11-03 补：弹窗与设置页的确切交互以 **§11** 为准（苏醒给了草图）。
2026-11-03 定：服务商只做 **RunningHub**；§5「先接火山方舟+MiniMax」的建议作废。
2026-11-03 再定：**云端只调收费模型 API，不跑工作流** —— 以 **§13** 为准，§12.1/§12.2 那条「跑自己的工作流」与「原生 ComfyUI 代理路」全部作废，§6 的三族参考限制重新生效（改按模型 spec 判定）。

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

---

## 12. RunningHub 接入（2026-11-03 定稿：只做这一家）

> 依据：RunningHub 官方 API 文档站 runninghub-api-doc-cn（今日抓取）。凡我没抓到的字段一律标「待验证」，不猜。

### 12.1 为什么这家把你的工作量砍掉一半

RunningHub 卖的是**云端 ComfyUI**：你在它平台上有自己的工作流（`workflowId`），提交时用 `nodeInfoList` 覆盖节点里的值。而你的 `nodeInfoList` 就是「改某个节点的某个输入」——**和一键同款现在存的槽位（`slot_key(slot)` = `node` + `input` + 值）是一一对应的**：

    本机：  build_workflow(nodes, slots, …) → 整份 API 工作流 → POST /prompt
    云端：  slots → [{nodeId, fieldName, fieldValue}, …] → POST /task/openapi/*

所以 D1/D2/D3 全部成立，而且 **D2「云端要新写一份声明式槽位」这条路在 RunningHub 上不需要了**——槽位直接从你已经检测准的那份复用。原 §5 建议的火山方舟/MiniMax 才需要声明式槽位，那条建议作废。

顺带一条：它的模型 API 目录里就有 **MiniMax-H3 多模态参考生视频 / 图生视频 / 文生视频**、**seedance2.0 多模态视频**、**千问3-语音合成 / Qwen3 TTS 声音设计**、**Doubao 声音复刻**、**seedream-v5**——和你本机那三条工作流（Qwen-image、H3 参考生视频、Qwen3-TTS 音色克隆）对得上。含义：**工作流路万一跑不通（缺自定义节点或缺模型），同一家就有退路**，不用换服务商。

### 12.2 两条传输路，先花一小时测再定（S0）

文档给了两条，第二条是意外发现：

| | A. OpenAPI 任务路 | B. 原生 ComfyUI 代理路 |
|---|---|---|
| 地址 | `https://www.runninghub.cn/task/openapi/*` | `https://www.runninghub.cn/proxy/your-api-key`（48G 是 `/proxy-plus/`） |
| 官方说法 | 上传资源 → 提交任务 → 查任务 → 取 fileUrl → 可取消 | 「该地址功能等同于本地部署的 ComfyUI 地址 http://127.0.0.1:8188」 |
| 我们要写的代码 | 新适配器：slots→nodeInfoList、下载 fileUrl | **几乎为零**：现成的 `ComfyUIClient`（upload_image / queue / history / view / interrupt）换个 base_url |
| 计费形态 | 按任务，产物回 fileUrl | 按占用机器的时长（冷启动、会话是否常驻，文档没说清） |
| 关键未知 | 高级版提交端点的完整字段（文档页抓取超时）；产物链接有效期 | `/upload/image` `/history` `/view` `/interrupt` 是否全通；十分钟长任务会不会被切；机器怎么分配；**key 在 URL 路径里** |

**S0（开工前必做，约一小时，只花你账号里几毛钱）**：用你自己的 key 各跑一次——B 路打 `/proxy/<key>/system_stats` → 推一张参考 → 提交闪寻图片那条 → 轮 `/history` → `/view` 取回；A 路打 `/task/openapi/upload` → 提交（带 nodeInfoList）→ 查状态 → 取 fileUrl 下载。

决策规则写死在这里，免得到时候凭感觉：
- B 路四个端点全通、长任务不被切、且能拿到明确的计费口径 → **走 B**：`ComfyUIClient` 加一个「URL 里带 key」的模式（并强制打码），云端就退化成「换一台 ComfyUI 的地址」，R2/R3/R4 的工作量各砍一大半。
- 有任一项不通 → **走 A**：写 `RunningHubWorkflowBackend`（submit / poll / fetch / cancel 四个方法），B 路不碰。
- 允许「B 跑图、A 跑视频」这种混搭，但必须落在 `CloudBackend` 协议后面，别让弹窗知道有几条路——这是 Round 40「两条链路两个网络栈」那条教训的唯一防线。

### 12.3 已核实的端点与字段（A 路）

| 用途 | 端点 | 要点 | 
|---|---|---|
| 上传素材 | `POST /task/openapi/upload` | multipart：`apiKey`、`fileType=input`、`file`；返回 `fileName`，**填进 LoadImage 那类节点的 fieldValue**。示例明确说支持 image/audio/video → 参考族限制全部照本机 |
| 提交（简易） | `POST /task/openapi/create` | `{apiKey, workflowId}`，等价于「不改任何参数直接点运行」；带参数改写要 nodeInfoList |
| 提交（高级） | 文档页 `api-425749013` 抓取超时 | 字段以官方文档为准，S0 一并核；预期是 workflowId + nodeInfoList（+ instanceType default/plus/ultra、webhookUrl、title） |
| 查询产物 | `POST /task/openapi/outputs` | `{taskId, apiKey}`；进行中回 code 804(运行中)/813(排队中)；成功后 `data[]` 带 `fileUrl` |
| 取消 | 有独立端点 | 「取消」不等于退费，文案仍按 §3.5 说实话 |
| 账户 | `POST /uc/openapi/accountStatus` | 回 `remainCoins`（RH币余额）与 `currentTaskCounts`（运行中任务数）→ 设置页直接显示余额与并发，不用我们自己记账才知道还剩多少 |

`nodeInfoList` 的形状（官方举例）：`[{"nodeId":"6","fieldName":"text","fieldValue":"…"}]`。 `slot_key()` 拆出来的就是这两段，映射是纯字符串活，写一次测一次。

### 12.4 计费与余额（官网当前标价，会漂，以 accountStatus 为准）

- 机型按秒计：Lite ¥0.4/小时、Standard 24G ¥4/小时、Plus 48G ¥6/小时、Ultra ¥9/小时（`instanceType` 选 default/plus/ultra）。另一处页面写标准任务 24G 每秒 0.2 RH币、Plus 48G 每秒 0.4 RH币。
- 三方模型 API（seedance / H3 / TTS 那批）**另有单次调用费**，走钱包余额，与 RH币是两笔钱。**弹窗上的预估必须写「按运行时长计费，取决于排队与机型」这种区间口径**，别给一个假装精确的数。
- 落库：跑完把 `accountStatus` 的 `remainCoins` 差值记进 `gen_tasks`，这才是你真正看得懂的「这条花了多少」。**这是唯一诚实的计价方式**，比按厂商单价自己乘出来的准。
- `instanceType` 要做成模板参数：你 H3 那条 2K 片子和一条 TTS 十几秒的语音，不该用同一种机器。

### 12.5 API Key 保密（你点名要的那条）

- 设置页自己填：输入框 `type=password` + 「显示」开关默认关；粘贴后不预览明文；保存后接口只回 `has_api_key=true`，**任何接口都不回明文**，也不接受「读出来再填回去」这种流程。
- 存储走 D6 的 DPAPI（当前用户，不落明文文件，不进数据库备份可读文本）。非 Windows 只存本次进程，重启要重填，并在界面上说清。
- `清除` 一颗：清 BLOB 并让 `has_api_key` 立刻变 false。
- **B 路把 key 放在 URL 路径里**（`/proxy/<key>`）：所有日志、异常信息、`ComfyUIError.message`、以及 `outputs/comfyui-diag` 那类诊断脚本输出，一律按「scheme+host+」截断，绝不带路径。**这是新增的泄漏面**，A 路把 key 放 body 就没这问题——S0 测完要把这条算进选型。
- 「测试连通」用 `accountStatus` 打真请求：能一次同时验证 key 有效、网络通、余额可读，比只测 TCP 连上不连上有用。
- Key 不写进 `config.json`（那是可读明文配置文件），只进 `gen_accounts.credential`。

### 12.6 里程碑调整（其余不变）

- **S0**：一小时真机二选一，结论回写本节与 MEMORY。产出物：一段跑通的调用记录 + 一份「B 路支持哪些端点」的实测清单。
- R1 底座：不变（凭据 / 两张表 / `cloud/` 骨架 / engine 列 / 分派）。
- R2 出图：跑通**闪寻图片那一条**的云端跑法（同一条工作流、同一套槽位，只是换传输），这是最小可验证闭环。
- R3 出声音：Qwen3-TTS 那条 + `instanceType` 选小机器 + 时长/语种控件沿用。
- R4 出片：H3 那条 + 长任务 `gen_tasks` 落库与重启取回 + 取消实话 + 产物过期后 `/refetch`。
- R5 收口：余额显示、按 remainCoins 差值记账、失败自救、README/MEMORY 回写。

### 12.7 §6 的更正

「云端只吃文本 + 图片参考、音频/视频格子置灰」这条**在 RunningHub 的工作流路上不成立**：跑的就是你本机那份工作流，`LoadImage` / `LoadAudio` / `VHS_LoadVideo` 三族都能喂，官方上传接口示例就写了支持 image/audio/video。所以三族参考的连着放规则、素材选择器、编号口径，云端与本机**完全一致**，不需要置灰。

仍然要留的边界只剩两条：单文件体积上限（待 S0 实测，超限要说人话）；以及万一某条改走「模型 API 路」（不是跑工作流）时，才需要那份声明式槽位与张数上限收敛。

### 12.8 §10 三条的状态

- 「先接哪两家」→ **已定**：只接 RunningHub，§5 那条建议作废。
- 「产物位置」→ **已定**：`<数据盘>\SeekX-Data\generated\<类>\<日期>\`。
- 「账号」→ **还等你**：RunningHub 的 API Key（你自己在设置里填，我碰不到）、RH币/钱包是否有余额、以及你工作台里那三条工作流各自的 `workflowId`（云端提交要它；一条工作流一个 id，从 `…/workflow/<id>` 链接末尾取）。
- 「一族一个「当前」，本机与云端共抢」→ 你回「按你的建议来」，**按共抢实现**（§11.6）。
- 唯一还需要你动手的：**S0 那一小时**。它要真打你账号、真扣几毛钱 RH币，我不会自己发起。而且那时候设置页还没有 key 输入框（那是 R1 的活），所以 S0 的做法是：我写一个只读脚本，key 从环境变量或交互输入取、**全程不打印不回显**，你自己跑，把结果文件发我。我不会读你的 key，也不要你贴进对话。

---

## 13. 云端只调收费模型 API（2026-11-03 定稿，作废 §12.1/§12.2 的工作流路）

### 13.1 这条路的代价要说在前面

模型 API 的画质收益是真的（seedream-v5、MiniMax-H3-Max、seedance2.0/2.5 这些本机跑不动也拿不到权重）。但它是一次一锤子，**丢掉的是工作流的可控性**：没有 LoRA 挂点、没有 ControlNet/分区重绘、没有多步放大链、seed 是否可复现每个模型不一样。

所以本机那三条工作流不能撤，云端是**并列的一族行**——正是你草图里那个对等结构。别做成「云端取代本机」。

### 13.2 平台已有的共享基础设施（这三个直接决定实现形状）

| 能力 | 文档条目 | 我们要怎么用 |
|---|---|---|
| 查任务状态 / 查生成结果 / **查生成结果 V2** | 「任务和查询 & webhook」 | 所有模型共用一套轮询与取产物，**模型差异只在提交那一层**。`CloudBackend` 只写一个 `RunningHubModelBackend`，不是一个模型一个类 |
| **模型 API 价格预估** | api-454850620 | 弹窗按钮上的价格**直接调它**，不自己维护价目表。价目表会漂，自己乘出来的数是骗人的；官方预估 + 事后 `accountStatus.remainCoins` 差值对账，才是两个可信的数 |
| 资源上传 | 「资源上传」/ upload-file | 参考素材先传上去拿链接再提交。**已看到某模型页写「上传后获得的链接有效期为 1 天」**：所以「上传 → 立刻提交」要在同一个任务里连着做，不能缓存链接复用 |
| 模型 API 错误码说明 | doc-8435517 | 错误码表翻成人话进 `RunningHubError`，与 `ComfyUIError` 同一待遇：面向用户的中文，不带栈 |

### 13.3 槽位怎么从模型 spec 生成（D2 正式生效，并加一件事）

每个接进来的模型在 `cloud/spec.py` 里一份 spec：能力、参数枚举、参考位数量与种类、时长/比例/分辨率枚举、预估计价单位、超时。**弹窗的控件全部由 spec 生成，枚举值不给自由输入。**

新增一个原方案没有的语义：**参考位要能标角色**。目录里明摆着有一批「首尾帧」模型（`MiniMax-H3 图生视频（首尾帧）`、`MiniMax-H3-Max 图生视频（首尾帧）`、Vidu 首尾帧、可灵首尾帧）。现在参考位只有「图片1/图片2」这种序号语义，对首尾帧模型**必须标成「首帧」「尾帧」**——放错位置出来的片子完全不对，而且不报错，属于最坏的那种错。落点：`RefCell` 加一个可选 `role`，标签与素材选择器标题跟着它，接线按 role 而不是按序号。

### 13.4 接哪几个模型（建议：一次只接 5 条，别贪）

目录里几十条模型，但 **spec 是手写代码**，每接一条就是一份要维护、要测、要核价的规格。第一次交付按这个清单：

| 能力 | 建议接 | 为什么是它 | 备份/第二档 |
|---|---|---|---|
| 图片 | **seedream-v5-lite 图生图 + 文生图**（同族两条，共用一份 spec） | 你已有 Seedance/即梦那套画面描述体系，同族模型的提示词习惯最接近；图生图能吃多参考，接得上一键同款的参考位 | `qwen-image/text-to-image-2512`——与本机「闪寻图片」那条 Qwen-image 同族，风格能续上；`z-image-turbo` 做快而便宜的草稿档 |
| 视频 | **MiniMax H3 ref2va RH插件流（支持多参）** + **MiniMax-H3 图生视频（首尾帧）** | 你的 `$h3-prompt-writing` 技能写的就是 T2VA/I2VA/FL2VA/L2VA/Ref2VA 这几路，**RH 的模型名和你的提示词体系是同一套命名**，提示词资产几乎零翻译；ref2va 多参正是短剧分镜要的 | `seedance2.0/多模态视频`（Seedance 体系的另一头）；要高画质再上 `MiniMax-H3-Max`；`seedance2.5` 是 Token 计价，摸清计费前不默认露出 |
| 语音 | **minimax/voice-clone** + **minimax/speech-2.8-hd** | 复刻出来的音色和正文合成是同一家才能配对，接上你现在 Qwen3-TTS 音色克隆那条的用法（参考音频 + 台词） | `Doubao-声音复刻-2.0`(+训练，多一步注册流程)；`千问3-语音合成-Instruct-Flash` 适合要按指令控语气的场合 |
| 后处理 | **RH 视频超分 / RH 视频帧率增强**、`即梦智能超清`、`topazlabs 图像放大 High Fidelity V3` | 见 13.5，画质方案里性价比最高的一环 | `火山画质增强` 三档、`topazlabs 视频增强/降噪` |

目录里还有 `Vidu Q3 Drama 短剧成片`、`可灵 4.0 主体创建/音色创建`、`f-2-dev/edit`、`全能图片PRO` 这些，先不接，等真用得上再说。**具体模型名与参数以官方目录当日为准**，我这里列的是目录里确实存在的条目名，实现时逐条核字段。

### 13.5 建议单独做的一件事：把「超分/补帧」做成一条能右键用的 API 行

云端出片的钱大头在分辨率与时长。直接上最高档出 4K，比「**便宜档出片 → 再超分**」贵得多。所以后处理模型应该独立成行：右键图库里任何一条素材 → 选「RH 视频超分」/「即梦智能超清」→ 参考位就是这一条素材、只有几个枚举参数、单次费低。

这个正好复用一键同款的入口和弹窗（素材就是被右键的那条），几乎不加新代码，但直接改变你的出片策略。我把它列进 R4。

### 13.6 里程碑再调一次

- **S0**：内容换成「拿你的 key 各跑通一条」——seedream-v5-lite 图生图、H3 ref2va 多参、minimax/voice-clone，外加**价格预估端点**与**查结果 V2** 各打一次。要记录的六件事：提交端点与字段、参数枚举、参考素材是 URL 还是 base64（含链接有效期）、产物字段与有效期、单次费与预估口径、失败错误码。跑完这五件事，R2–R4 的 spec 就是抄文档而不是猜。
- R1 底座：不变（DPAPI 凭据 / `gen_accounts`+`gen_tasks` / `cloud/` 骨架 / engine 列 / 一处校验两处执行）。
- R2 出图：seedream 图生图 + 文生图，跑通「槽位→spec→提交→轮询→下载→入库→来源记录」全链，含价格预估显示。
- R3 出声音：voice-clone + speech-2.8-hd，含参考音频上传与两段文字位。
- R4 出片：H3 两条 + 首尾帧 role + 长任务落库与重启取回 + 取消实话 + **超分右键入口**。
- R5 收口：余额与花费页、错误码人话化、失败自救、README/MEMORY 回写。

### 13.7 §12 的残留状态

- 12.1/12.2（跑自己的工作流、`/proxy/<key>` 原生 ComfyUI 路）：**作废**，不实现。相关风险（key 在 URL 路径里、长任务被切、冷启动计费）随之消失——模型 API 的 key 在请求体里。
- 12.5（key 保密那整套）：**照用**，只是不再有 URL 打码那条。
- 12.4 的机型按秒计费：不适用了。模型 API 走单次调用费/Token，用官方价格预估 + `remainCoins` 差值。`instanceType` 那套不要了。
- 12.7（三族参考都放开）：**回到按模型 spec 判定**——某个模型只吃图就不给音频格子，置灰并说明原因。
