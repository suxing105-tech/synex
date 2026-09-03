# 25 — ComfyUI 新图元数据又被显示成 `['71', 0]`

## 用户报告

> 为什么我 comfyui 新生成的图，详细信息又不对。提示词什么的又不能识别呢？

右侧详情面板再次出现 `['71', 0]` 的提示词（之前 22 修过同类问题）。

## 根因

不是 parser 代码坏了 — 直接调用 `parse_metadata(...)` 在 `backend/.venv` 里返回正确结果，
正反向提示词 / seed / sampler / steps / cfg 全都解出来了。

真正原因是 **uvicorn 进程在内存里还装着旧版 parser**：

1. 早期 uvicorn 是用 `python -m uvicorn app.main:app --app-dir .` 启动的（**没有 `--reload`**）。
2. parser.py 后来被改了几次（commit `06239ca` 处理 ZML/ShowText/ConditioningZeroOut、
   commit `0fa4502` 解 `KSamplerAdvanced.noise_seed` 链接），但 uvicorn 没热重载，
   旧逻辑一直驻留在内存里。
3. 今天 9/3 用户连续跑了 ComfyUI 出图，watchdog 把新文件交给老 uvicorn 处理；
   解析逻辑沿用旧版 `str([..])` 兜底分支，把 `CLIPTextEncode.text = ["71", 0]` 这种没走通的链接
   直接当文本存进了库。
4. 同样因为老 parser 没走 noise_seed 链接解析，**`seed` 字段被存成 NULL**。

D B 中证据（修复前）：
```
id=381  positive_prompt="['71', 0]"  negative_prompt="['71', 0]"  seed=null
id=383  ... 同上
id=386  ... 同上（uvicorn 重启前最后一张）
id=387  ... 正确（uvicorn 重启后第一张）
```

## 修复步骤

1. **跑一次性 reindex 修复脏数据**：
   ```
   cd backend
   .venv/Scripts/python scripts/reindex_prompts.py --db data/db.sqlite --all
   ```
   79 张图，63 张被正确改写（16 张本来 prompt 就是空的，跳过）。

2. **重启 uvicorn，让进程加载新版 parser**：
   ```
   .venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --app-dir . --reload
   ```
   加 `--reload` 是关键 —以后 parser.py 一旦改动就自动热重启，避免再次踩同一个坑。

3. **加端到端回归测试**：
   `backend/tests/test_parser.py::test_real_user_workflow_ksampler_advanced_zml_lora_easy_seed`
   把用户实际 workflow 完整复刻进合成 PNG：
   - `KSamplerAdvanced.noise_seed` 是指向 `easy seed` 节点的链接
   - `positive` → `CLIPTextEncode.text` → `ZML_SelectTextV2` 的 `文本1` (Lora Loader 链接) + `文本2` (ZML_TextInput 链接)，
     分隔符 `,\n`，启用 1/2 = true，3/4/5 = false
   - `negative` → `ConditioningZeroOut`
   - 一次性验证提示词、负向为空、`seed` 走链接解开、采样器等参数都正确。
   之前零散的单元测试各自覆盖一个特性，缺一个端到端的 union — 一旦某次重构只动一个特性，这个 union 就裸奔。
   本测试正是守住这条 union。

## 验证

```
backend/.venv/Scripts/python -m pytest -q
71 passed in 8.13s
```

新增 1 个测试（`test_real_user_workflow_ksampler_advanced_zml_lora_easy_seed`），总测试数 70 → 71。

API 抽样（修复后）：
```
GET /api/images/386
{
  "id": 386,
  "filename": "场景_00231_.png",
  "positive_prompt": "<lora:Krea2/krea2_wukong_sytle_c1-st5000:1.20> <lora:Krea2/detail_slider_krea2_l",
  "negative_prompt": null,
  "seed": 341872450086182,
  "sampler": "er_sde",
  ...
}
```

## 备注

- `seed = 341872450086182` 是个 15 位整数（来自用户 `easy seed` 节点的 seed widget 值）。
  SQLite INTEGER = int64，JS Number = float53 (2^53 ≈ 9×10^15)，都装得下，所以这次没溢出。
  但如果以后 `easy seed` 配的随机种子接近 2^53，需要留意精度。
- 现在用的是 venv 里的 `python -m uvicorn ... --reload`，启动日志写到 `backend/uvicorn-new.log/.err`。
  之前的 uvicorn 没有日志文件，因为没用重定向 — 这次顺手补上。
- `_tmp_query.py` 和 `materials/logo-replacement-verify.txt` 按之前会话约定不动。
