# API 反推配置页升级计划（预设化）

日期：2026-09-21
状态：已确认 5 项决策，待细化实现任务

## 决策结论

1. 预设清单 = 原建议 + DeepSeek。
2. v1 只做 OpenAI 兼容预设；不做 Anthropic/Gemini 原生适配器。
3. 每家预设提供「多个模型下拉」。
4. 保留「自定义」手动入口作为兜底。
5. 兼容策略：现有已配置模型继续按 custom 处理，不删老数据、不动用户配置。

## 目标

把「模型与反推」从「手动填 5 项（名称/Base URL/模型 ID/Key/超时）」
改成「选服务商 → 输 API Key → 选默认/切换模型 → 保存即可用」，
高级字段（Base URL / 超时 / 命名）折叠起来，需要时才展开。

## 预设注册表（后端为唯一事实来源，前端不硬编码）

每项结构：

```python
ProviderPreset = {
  "id": "qwen",              # 稳定标识
  "name": "通义千问 Qwen",     # 展示名
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "models": [
    {"id": "qwen-vl-max", "label": "Qwen-VL-Max", "recommended": True},
  ],
  "default_timeout": 120,
  "format": "openai",
}
```

### 预设清单

| id | 名称 | base_url | 推荐模型（可下拉切换） |
|----|------|----------|------------------------|
| openai | OpenAI | `https://api.openai.com/v1` | gpt-4o-mini（推荐）/ gpt-4o / gpt-4.1-mini / gpt-4.1 |
| gemini | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | gemini-2.5-flash（推荐）/ gemini-2.0-flash / gemini-2.5-pro |
| qwen | 通义千问 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | qwen2.5-vl-72b-instruct（推荐）/ qwen-vl-max / qwen-vl-plus / qwen2.5-vl-32b-instruct |
| doubao | 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seed-1-6-vision-*（推荐，需按用户账号的 endpoint id 填写）/ doubao-1-5-vision-pro-* |
| zhipu | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | glm-4.5v（推荐）/ glm-4v-plus / glm-4v / glm-4.1v-thinking-flash |
| siliconflow | 硅基流动 | `https://api.siliconflow.cn/v1` | Qwen/Qwen2.5-VL-72B-Instruct（推荐）/ Qwen/Qwen2.5-VL-32B-Instruct / deepseek-ai/deepseek-vl2 |
| moonshot | Kimi / Moonshot | `https://api.moonshot.cn/v1` | moonshot-v1-8k-vision-preview（推荐）/ moonshot-v1-32k-vision-preview |
| deepseek | DeepSeek | ⚠️ 见下 | ⚠️ 见下 |
| custom | 自定义 | 由用户填写 | —— |

### DeepSeek 关键注意点

DeepSeek 官方 API 当前只提供纯文本模型，没有视觉输入；DeepSeek 未来会补视觉模型。
当前实际用法（已确认）：通过魔搭 ModelScope 托管
- `base_url`：`https://api-inference.modelscope.cn/v1`
- 模型 ID：`deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`（支持图片识别）
- 认证用 ModelScope 推理 API Key；若地址/模型有差异可在高级设置里覆盖。

## 后端改造（backend/app）

- 新增 `providers.py`：
  - `PRESETS` 注册表（上表）。
  - `get_preset(id)` / `list_presets()`。
  - `validate_model(preset_id, model_id)`：自定义允许任意 model；预设校验模型是否在允许集合内。
- `model_configs` 表新增 `provider` 列（`TEXT`，nullable；`custom`=手动；旧数据迁移为 `custom`/NULL）。
- `reverse_prompts.py`：
  - `save_config`：当 `provider` 是预设时，用 preset 补全默认 `base_url`，校验 `model`，超时用 preset 默认。
  - `normalize_url`：预设地址视为可信，跳过「仅供本机/局域网」白名单；自定义地址维持现有校验。
  - `request_model`：v1 仅处理 `format=="openai"`，沿用现有 `/chat/completions` 请求；给 `format` 预留分支。
- `routes/reverse_prompts.py`：
  - 新增 `GET /api/model-providers` 返回预设列表（不含任何密钥）。
  - 入参 `ModelInput/ModelPatch` 增加可选 `provider`、`model` 校验逻辑；`name/base_url` 允许为空（由 preset 生成）。
- 迁移：`initialize()` 中 `ALTER TABLE model_configs ADD COLUMN provider TEXT`（幂等），旧行 `provider=NULL`。

## 前端改造（frontend/src）

- `lib/reverse-prompts.ts`：
  - 新增 `ProviderPreset` 类型 + `fetchProviders()`。
  - `ModelConfig` / `ModelDraft` 增加 `provider?: string`。
- `components/ModelSettings.svelte`（核心重做）：
  - 顶部保留已配置模型 chip + 「＋ 添加」。
  - 添加/编辑时先选「服务商」下拉/卡片；预设选中后自动填充 base_url、可换模型、可配置名称。
  - 主界面只保留：服务商、模型下拉（含推荐标记）、API Key、配置名称（自动生成）。
  - 「高级设置」折叠区放：Base URL 覆盖、请求超时、清除已保存密钥。
  - 保留：测试图片识别、删除配置、默认模型、反推指令。
  - 非预设（custom/旧数据）继续展示全部手填字段。
- `components/SettingsModal.svelte`、`App.svelte` 的入口无需改。

## 数据迁移与兼容

- 旧 `model_configs` 行 `provider` 为空 => 前端按 custom 展示原有字段，历史反推记录（`reverse_prompts`）不受影响。
- `reverse_prompt_settings` 表不动。
- 不改动任何图片/文件夹/标签数据。

## 测试与验证

- 后端（`backend/.venv` 下 `pytest`）：
  - 预设查找 / 预设 model 校验（合法/非法）。
  - `provider` 为预设时 `save_config` 能补全 base_url、预设地址不触发白名单。
  - 老数据迁移后 `provider=NULL` 仍可正常读取、仍为 custom。
  - `GET /api/model-providers` 不泄露密钥字段。
  - 保留既有 `test_reverse_prompts.py` 用例不被破坏。
- 前端（`frontend/` 下 `pnpm test`）：
  - 更新 `reverse-prompts.test.ts` 的 `ModelSettings` 断言。
  - 新增：选服务商后模型下拉加载、只填 Key 保存成功、高级设置展开、custom 仍显示手填字段。
- 手动验证：用内置测试图走 `POST /api/model-configs/test`，确认预设地址能正常发起请求并返回描述。

## 开放项（已确认）

1. DeepSeek：使用魔搭 ModelScope 的 `DeepSeek-V4-Flash-Vision-Exp`。
2. 豆包：下拉放常见名称；endpoint id（ep-...）可在高级设置里覆盖模型 ID。
3. 模型 id 由我在后续升级时维护 `providers.py` 默认值。
4. 格式：v1 只做 OpenAI 兼容预设；保留「自定义」手动入口。

## 交付物

- `backend/app/providers.py`（新增）
- `backend/app/reverse_prompts.py`、`backend/app/routes/reverse_prompts.py`（改造）
- `frontend/src/lib/reverse-prompts.ts`、`frontend/src/components/ModelSettings.svelte`（改造）
- 后端 `tests/test_providers.py`（新增）+ 更新 `test_reverse_prompts.py`
- 前端 `reverse-prompts.test.ts`（更新/新增）
- 本计划文件存于 `outputs/PLAN-api-presets.md`
