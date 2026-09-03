# M3 prompt parser 修复：ZML_SelectTextV2 + ShowText|pysssss + ConditioningZeroOut

## 用户反馈

> 帮我看看为什么所有图片右边的详细参数，正面提示词和负面提示词都是显示为：
> `['71', 0]`，明显是 BUG，能不能正确显示提示词？

直接查 DB：`backend/data/db.sqlite` 里 67 张图，67 行都是 `"['71', 0]"`。
这是 ComfyUI 新版 + ZML 节点集流程特有的图生 prompt 拓扑，老 parser 不识别。

## 根因

用户的 ComfyUI 工作流（PNG 的 `tEXt:prompt` chunk 里的 JSON）：

```
KSamplerAdvanced(86)
  .positive = ['7', 0]   ->  CLIPTextEncode
  .negative = ['9', 0]   ->  ConditioningZeroOut
                              .conditioning = ['7', 0]   <- 与 positive 同链

CLIPTextEncode(7)
  .text = ['71', 0]      ->  ZML_SelectTextV2

ZML_SelectTextV2(71)
  .文本1 = ['226', 2]    ->  Lora Loader LoraManager (输出 LoRA string)
  .文本2 = ['174', 0]    ->  ShowText|pysssss
  .分隔符 = ",\n"
  .启用1/2 = True

ShowText|pysssss(174)
  .text_0 = "A seventeen-year-old female guqin master..."   <- 真 prompt
  .text   = ['30', 0]     ->  PromptExpand
                              继续走会拿到 LLM system context
```

老 parser 在 `_extract_comfyui_prompts` 里只识别 `CLIPTextEncode` + 上一级 link，
遇到 list 字段就 `str(['71', 0])` = Python repr，存进 DB 就是这个字符串。

## 修复

### `backend/app/parser.py` 重构 `_extract_comfyui_prompts`

1. **整体重写 resolve 逻辑**：把原 `resolve_text` 拆为 `resolve_text` + `_text_from_node` +
   `_resolve_value` 三层闭包，全部 inside `if ksamplers:` block（之前的版本把
   `def _text_from_node` 写在缩进 4（与 if 同级），却把 `inputs = ks.get("inputs") or {}`
   放在缩进 8（被识别为 `_text_from_node` 函数体），导致 `pos = resolve_text(...)` 从未执行。

2. **ShowText|pysssss 识别**：
   `inputs.text` 是在 ComfyUI 画布上显示连线用的 link，
   `inputs.text_0/text_1/...` 才是用户实际写的 prompt 字符串。
   必须优先读这些真字符串，不要顺着 `text` link 追到 PromptExpand -> ZML_SelectTextV2 -> LLM system context 链里去。

3. **ZML_SelectTextV2 识别**：
   有 文本1/文本2/... + 分隔符 + 启用1/启用2/... 的字典类节点，
   按分隔符 join 所有启用的项。Enabled flag 是 启用N（N 是跟 文本N 一样的尾数字），
   不是 文本N启用。

4. **ConditioningZeroOut 短路**：
   用户在 workflow 把 `negative -> ConditioningZeroOut` 故意让 `negative` 是空。
   这个节点仅有 `conditioning` input 连回同一 positive CLIP encode 链，
   原 parser 从"conditioning link"跟下去会把 positive prompt 原对原返回当 negative。
   增加 `if ct == "ConditioningZeroOut": return ""` 提前返回。

5. **Link 逻辑修正**：
   原 parser 在递归遇到 link 格式但目标返回空字符串（例如 `ConditioningZeroOut`）时，
   会"悄悄"落到多行 join 的 fallback，把 `[node_id, output_index]` 当成 `[str, 0]` join 成
   `"5\n0"`。改为：识别出是 link 就尊重 link 结果（哪怕是空），不再静默退化为多行 join。

### `backend/scripts/reindex_prompts.py`（新增）

```bash
cd backend && .venv/Scripts/python scripts/reindex_prompts.py
```

只重写 positive_prompt / negative_prompt（外加 seed/sampler/steps/cfg/model 兜底），
保留 favorite、FTS、thumb 状态不变。比 `rm data/db.sqlite && 重启 + /api/scan` 更安全。

默认只扫 prompt 为空 / `"[]"` / 以 `[` 开头（老 parser 的产物）的行；加 `--all` 全量重扫。

## 验证

跑了一遍用户的实际图（id=17）：

| | 之前 | 现在 |
|--|------|------|
| positive_prompt | `"['71', 0]"` | LoRA string + 真 prompt（9444 chars） |
| negative_prompt | `"['71', 0]"` | `""`（ConditioningZeroOut 应为空） |

DB 扫全表 67 行：
- 之前：67/67 都是 `"['71', 0]"`
- 现在：0 行 `[`-style garbage，49 行正常 prompt，18 行仍为空 —— 这些是
  Flux 2 + `KSamplerSelect` / `SamplerCustomAdvanced` + `CFGGuider` 拓扑，
  prompt 不在 KSampler.inputs.positive 上（scope 外，本期不动）。

## 测试

新增 `backend/tests/test_parser.py` 4 个测试：

- `test_extract_comfyui_prompts_handles_list_text_link` —— 新版 ComfyUI 中间夹 Reroute/ZML
  节点时，CLIPTextEncode.inputs.text 是 list link，parser 能跟 link 拿到真 prompt。
- `test_extract_comfyui_prompts_prefers_showtext_text_n_over_text_link` —— ShowText|pysssss
  同时有 `text`（link 到 LLM 链）和 `text_0`（真 prompt），parser 必须优先 `text_0`
  不能误跟 `text`。
- `test_extract_comfyui_prompts_conditioning_zero_out_returns_empty_negative` —— `negative ->
  ConditioningZeroOut` 必须返回空，不能被 fall-through 拿到 positive 的 prompt。
- `test_extract_comfyui_prompts_zml_select_text_v2_joins_segments` —— ZML 字典节点按分隔符
  join 启用项，禁用项正确跳过。

| 套件 | 之前 | 现在 |
|------|------|------|
| backend pytest (test_parser.py) | 6/6 | **10/10**（+4 新 case）|
| backend pytest (全部) | 63/63 | **63/63** |

## 范围外 / 后续

- **Flux 2 + Qwen TE 拓扑**（`KSamplerSelect` → `SamplerCustomAdvanced` → `CFGGuider`）：
  sampler 节点没有 `positive` / `negative` input，prompt 经 `CFGGuider.positive` →
  `ReferenceLatent` → `CLIPTextEncode` 传递。需要另外的启发式（例如找图里的 `CFGGuider`
  节点），本期不动。
- **A1111 `parameters` chunk**：已支持（之前就有）。
- **WebP XMP**：未触及。
