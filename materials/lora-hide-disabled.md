# 详情面板 LORA：隐藏未使用的 LoRA（交付记录）

## 用户诉求
工作流里被取消勾选（LoRA Manager 里 active=false）的 LoRA 不应出现在详情面板 LORA 部分，完全隐藏。

## 真实工作流形态（关键发现）

用户工作流是 ComfyUI-LoraManager 插件（willmiao/ComfyUI-Lora-Manager），不是标准 LoRA Loader 节点。
LoraManager 节点的 widgets_values 结构：
```
[0] = { version, textWidgetName }                    元数据对象
[1] = "<lora:NAME:WEIGHT> ..."                      注入到 prompt 的字符串
[2] = [{ name, strength, active, ... }, ...]        结构化 LoRA 列表（每个有 active 字段）
```

用户实际每张图：18 个 LoRA 配置，但只有 5 个 `active=true`。剩下的 13 个就是"关闭的"。

## 方案（基于 ComfyUI-LoraManager 节点）

### 后端 `backend/app/parser.py`
1. 新增 `_extract_active_loras_from_lora_manager(workflow_obj)`：
   - 找 `type === "Lora Loader (LoraManager)"` 节点（白名单兼容多种命名）
   - 取 `widgets_values[2]` 数组，**过滤 `active === true`**
   - 抽 `name + strength`（strength 字符串/数字都接受）
   - **不**因 `mode 0/4` 跳过 —— 用户可能主动 bypass 节点但仍用 widgets 列表管理 LoRA
2. `parse_metadata` 写入 `parameters.used_loras`：
   - 优先级：LoraManager active LoRA -> 标准 LoRA 节点（兜底）

### 前端 `frontend/src/lib/params.ts`
`extractLoras` 入口加 used_loras 短路，缺失时回退到 prompt 文本 + `parameters.loras`。

### 测试
- 后端 `backend/tests/test_parser.py`：10 个新测试用例（6 LoraManager + 4 workflow LoRA 节点）
- 前端 `frontend/src/__tests__/params.test.ts`：5 个新测试用例（used_loras 优先级）

## 验证
- 后端 150 测试全过（含 10 新）
- 前端 212 测试全过（25 文件，含 5 新）
- 后端重启后触发 `/api/scan` 重新索引 121 张图
- 关键 PNG `二采_00022_.png`：`used_loras` 长度 5（之前从 prompt 文本抽 19 个，现在精准到 active=true 的 5 个）
- vite build 成功

## 兼容性

- 老图：触发重新扫描前 parameters 无 used_loras -> 前端走 fallback，行为不变
- 重新扫描后：新解析逻辑生效
- 不使用 LoraManager 的工作流：fallback 到 UI workflow 里的标准 LoRA 节点

## 不影响

- 用户原本的 PNG metadata 不动（只在解析时新增合并字段）
- 旧的 Icon.svelte / comfyui-logo.png / outputs/*.png 等用户私货未捎带