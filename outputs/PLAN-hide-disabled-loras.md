# Plan - 详情面板 LORA：隐藏未使用的 LoRA

## 用户诉求
工作流里"关闭的 LoRA"（节点被 bypass / mode 0/4）不应该出现在详情面板 LORA 部分，完全隐藏。

## 根因
`frontend/src/lib/params.ts:70-121` 的 `extractLoras` 走两条来源：
1. 正向 prompt 里的 `<lora:name:weight>` 标记
2. `parameters.loras`（数组 / 对象 / 字符串）

两条路径完全不读节点的启用状态字段。后端 `backend/app/parser.py` 把 API prompt JSON 解析后只抽了 positive/negative 文本，API prompt 原文没入库。

## 方案（后端权威 + 前端 fallback）

### 后端：`backend/app/parser.py`
1. 新增 LoRA 节点识别
   - 白名单：LoraLoader / LoRALoader / LoraLoaderAdvanced / LoRALoaderAdvanced / LoraLoaderMgr / PowerLoraLoader (rgthree) / PowerLoRAStacker / EfficientLoraLoader 等
   - 启发式：inputs 里出现 lora_name 字段且是字符串也算
2. 从 API prompt JSON 抽出每个 LoRA 节点的 (name, strength)
   - name: inputs.lora_name（字符串）；链接型跳过
   - strength: 按 strength_model / strength_clip / strength / lora_strength 优先级取；缺省 1.0
3. 把结果合并到 result["parameters"]["used_loras"]
4. **天然过滤 bypass**：API prompt 里被 bypass / mode 0/4 的节点根本不存在

### 前端：`frontend/src/lib/params.ts`
`extractLoras` 增加 fallback chain：
1. `parameters.used_loras` 存在 → 直接用作权威来源
2. 否则回退到现有逻辑（prompt 文本 `<lora:>` + `parameters.loras`）

### 测试
- 后端 `backend/tests/test_parser.py`：3 个 LoRA 节点 → used_loras 长度 = 3 / 链接型 name 跳过 / A1111 图不产生 used_loras
- 前端 `frontend/src/__tests__/params.test.ts`：used_loras 优先 / 三种形式支持 / 无 used_loras 回退

### 不破坏老图
- 老图 parameters 里没有 used_loras → 前端走 fallback，行为不变
- 触发"重新索引"后，新解析逻辑填进 used_loras

## 文件改动

| 文件 | 改动 |
|---|---|
| `backend/app/parser.py` | 新增 LoRA 抽取函数 + parse_metadata 合并调用 |
| `backend/tests/test_parser.py` | 新增测试用例 |
| `frontend/src/lib/params.ts` | extractLoras 优先读 used_loras |
| `frontend/src/__tests__/params.test.ts` | 新增测试用例 |
| `materials/lora-hide-disabled.md` | 交付记录 |

## 验证步骤
1. pytest 全过
2. vitest run 全过
3. vite build 成功
4. 触发重新索引一张含 bypassed LoRA 的图 → 详情面板只显示启用的
5. git commit（纯 ASCII message）