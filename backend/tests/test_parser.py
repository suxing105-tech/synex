"""PNG/WebP 元数据解析器测试。"""


from pathlib import Path

from app.parser import _parse_parameters_text, parse_metadata

from .conftest import make_comfy_prompt, make_png


def test_parse_png_with_comfy_prompt(tmp_path: Path):
    p = tmp_path / "img.png"
    make_png(
        p,
        prompt=make_comfy_prompt("a cat", "blurry", seed=1234, steps=30, cfg=8.5, sampler="dpmpp_2m"),
    )
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == "a cat"
    assert meta["negative_prompt"] == "blurry"
    assert meta["seed"] == 1234
    assert meta["steps"] == 30
    assert meta["cfg"] == 8.5
    assert meta["sampler"] == "dpmpp_2m"
    assert meta["model"] == "sd_xl_base_1.0"


def test_parse_png_with_a1111_parameters(tmp_path: Path):
    p = tmp_path / "img.png"
    make_png(
        p,
        params="a beautiful landscape\nNegative prompt: ugly, low quality\nSteps: 25, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 42",
    )
    meta = parse_metadata(p)
    assert "beautiful" in meta["positive_prompt"]
    assert "ugly" in meta["negative_prompt"]
    assert meta["parameters"]["Steps"] == "25"
    assert meta["seed"] == 42


def test_parse_png_without_metadata(tmp_path: Path):
    p = tmp_path / "img.png"
    make_png(p)
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == ""
    assert meta["seed"] is None
    assert meta["filename"] == "img.png"


def test_parse_unknown_extension_returns_empty(tmp_path: Path):
    p = tmp_path / "img.jpg"
    p.write_bytes(b"fake jpg bytes")
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == ""


def test_parse_corrupt_png_returns_empty(tmp_path: Path):
    p = tmp_path / "img.png"
    p.write_bytes(b"not a png")
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == ""


def test_parse_parameters_text_basic():
    pos, neg, params = _parse_parameters_text(
        "a fox\nNegative prompt: blurry\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 999"
    )
    assert pos == "a fox"
    assert neg == "blurry"
    assert params["Steps"] == "20"
    assert params["Seed"] == "999"


def test_extract_comfyui_prompts_handles_list_text_link():
    """CLIPTextEncode.inputs.text is a [node_id, output_index] list link (newer ComfyUI
    where a Reroute or ZML node sits in between). The parser must walk the link.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {"class_type": "Reroute", "inputs": {"source": ["2", 0]}},
        "2": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "real prompt text", "clip": ["3", 0]},
        },
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "4": {
            "class_type": "KSampler",
            "inputs": {
                "positive": ["1", 0],
                "negative": ["5", 0],
                "model": ["3", 0],
                "seed": 1, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
            },
        },
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "neg prompt", "clip": ["3", 0]}},
    }
    pos, neg, _ = _extract_comfyui_prompts(wf)
    assert pos == "real prompt text"
    assert neg == "neg prompt"


def test_extract_comfyui_prompts_prefers_showtext_text_n_over_text_link():
    """ShowText|pysssss debug nodes store the real prompt in inputs.text_0/text_1/...
    while inputs.text is a link to a PromptExpand/LLM chain (for canvas display).
    The parser must prefer the real strings, not follow the text link.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": ["2", 0], "clip": ["3", 0]},
        },
        "2": {
            "class_type": "ZML_SelectTextV2",
            "inputs": {
                "\u6587\u672c1": ["4", 0],
                "\u5206\u9694\u7b26": ",\n",
                "\u542f\u75281": True,
            },
        },
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "4": {
            "class_type": "ShowText|pysssss",
            "inputs": {
                "text_0": "REAL user prompt",
                "text": ["5", 0],  # link to LLM chain - must NOT be followed
            },
        },
        "5": {
            "class_type": "PromptExpand",
            "inputs": {
                "user_prompt": ["6", 0],
                "custom_rule_content": ["7", 0],
            },
        },
        "6": {
            "class_type": "ZML_SelectTextV2",
            "inputs": {"\u6587\u672c1": "WRONG should never appear", "\u542f\u75281": True},
        },
        "7": {"class_type": "ZML_TextInput", "inputs": {"\u6587\u672c": "WRONG LLM system prompt"}},
        "8": {
            "class_type": "KSampler",
            "inputs": {
                "positive": ["1", 0],
                "negative": ["9", 0],
                "model": ["3", 0],
                "seed": 1, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
            },
        },
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": "neg text", "clip": ["3", 0]}},
    }
    pos, neg, _ = _extract_comfyui_prompts(wf)
    assert pos == "REAL user prompt"
    assert "WRONG" not in pos
    assert neg == "neg text"


def test_extract_comfyui_prompts_conditioning_zero_out_returns_empty_negative():
    """When the user wires `negative -> ConditioningZeroOut`, the negative prompt
    is intentionally empty. The parser must NOT follow the conditioning link back
    into the positive prompt chain.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "positive text", "clip": ["3", 0]},
        },
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "4": {
            "class_type": "ConditioningZeroOut",
            "inputs": {"conditioning": ["1", 0]},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "positive": ["1", 0],
                "negative": ["4", 0],
                "model": ["3", 0],
                "seed": 1, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
            },
        },
    }
    pos, neg, _ = _extract_comfyui_prompts(wf)
    assert pos == "positive text"
    assert neg == ""


def test_extract_comfyui_prompts_zml_select_text_v2_joins_segments():
    """ZML_SelectTextV2 nodes (text1/text2/... + separator + enabled flags) should
    be joined by separator, skipping disabled entries.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {"class_type": "ZML_TextInput", "inputs": {"\u6587\u672c": "lora:foo:1.0"}},
        "2": {"class_type": "ShowText|pysssss", "inputs": {"text_0": "main prompt"}},
        "3": {
            "class_type": "ZML_SelectTextV2",
            "inputs": {
                "\u6587\u672c1": ["1", 0],
                "\u6587\u672c2": ["2", 0],
                "\u6587\u672c3": "disabled segment",
                "\u5206\u9694\u7b26": ", \n",
                "\u542f\u75281": True,
                "\u542f\u75282": True,
                "\u542f\u75283": False,
            },
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": ["3", 0], "clip": ["5", 0]},
        },
        "5": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "positive": ["4", 0],
                "negative": ["7", 0],
                "model": ["5", 0],
                "seed": 1, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
            },
        },
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["5", 0]}},
    }
    pos, neg, _ = _extract_comfyui_prompts(wf)
    assert "lora:foo:1.0" in pos
    assert "main prompt" in pos
    assert "disabled segment" not in pos
    assert pos.startswith("lora:foo:1.0")  # segment 1 joined first
    assert neg == ""



def test_extract_comfyui_prompts_resolves_ksampler_advanced_noise_seed_link():
    """KSamplerAdvanced uses inputs.noise_seed (not inputs.seed), and the value
    is often a [node_id, output_index] link to a separate seed-source node like
    `easy seed` / `RandomNoise`. The parser must follow the link and return
    the underlying int.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "hello", "clip": ["3", 0]},
        },
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "10": {
            "class_type": "easy seed",
            "inputs": {"seed": 601532383345810},
        },
        "20": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "noise_seed": ["10", 0],
                "steps": 8, "cfg": 1.0,
                "sampler_name": "er_sde", "scheduler": "simple",
                "positive": ["1", 0],
                "negative": ["1", 0],
                "model": ["3", 0],
            },
        },
    }
    pos, neg, params = _extract_comfyui_prompts(wf)
    assert params.get("seed") == 601532383345810


def test_extract_comfyui_prompts_resolves_ksampler_advanced_inline_int_seed():
    """KSamplerAdvanced sometimes has noise_seed as a plain int (no link).
    The parser should still surface it as `seed`.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "hello", "clip": ["3", 0]},
        },
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "20": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "noise_seed": 12345,
                "steps": 8, "cfg": 1.0,
                "sampler_name": "er_sde", "scheduler": "simple",
                "positive": ["1", 0],
                "negative": ["1", 0],
                "model": ["3", 0],
            },
        },
    }
    pos, neg, params = _extract_comfyui_prompts(wf)
    assert params.get("seed") == 12345


def test_extract_comfyui_prompts_seed_missing_returns_none():
    """If the sampler has no noise_seed / seed at all, params["seed"] is absent
    (not present at all, not 0, not None). parse_metadata then leaves result["seed"]
    as None.
    """
    from app.parser import _extract_comfyui_prompts
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "hello", "clip": ["3", 0]},
        },
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl"}},
        "20": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "steps": 8, "cfg": 1.0,
                "sampler_name": "er_sde", "scheduler": "simple",
                "positive": ["1", 0],
                "negative": ["1", 0],
                "model": ["3", 0],
            },
        },
    }
    pos, neg, params = _extract_comfyui_prompts(wf)
    assert "seed" not in params



"""End-to-end regression test for the user's actual ComfyUI workflow pattern.

Real user workflow (Krea2):
  KSamplerAdvanced
      noise_seed -> easy seed (custom node, plain int)
      positive   -> CLIPTextEncode -> ZML_SelectTextV2
                                          文本1 -> Lora Loader (LoraManager) STRING output
                                          文本2 -> ZML_TextInput (real user prompt)
                                          分隔符 = ",\n", 启用1/2 = True
      negative   -> ConditioningZeroOut (intentionally empty)

Earlier uvicorn sessions that loaded an older parser turned the un-walked
`positive` link `["71", 0]` into the literal Python repr `"['71', 0]"` and
stored `seed = null`. This regression test asserts the *combined* chain
(sampler + clip encode + ZML multi-segment + lora STRING link + conditioning
zero + easy seed link) produces the right prompts and seed in one shot —
guards against future single-feature fixes that drop coverage of the union
of features.
"""


from pathlib import Path

from app.parser import parse_metadata

from .conftest import make_png


def test_real_user_workflow_ksampler_advanced_zml_lora_easy_seed(tmp_path: Path):
    wf = {
        # 7 = CLIPTextEncode, text link -> 71
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": ["71", 0], "clip": ["226", 1]},
        },
        # 9 = ConditioningZeroOut for the negative side
        "9": {
            "class_type": "ConditioningZeroOut",
            "inputs": {"conditioning": ["7", 0]},
        },
        # 71 = ZML_SelectTextV2 with two segments joined by `,\n`
        "71": {
            "class_type": "ZML_SelectTextV2",
            "inputs": {
                "\u6587\u672c1": ["226", 2],          # link to Lora Loader STRING output
                "\u6587\u672c2": ["232", 0],          # link to ZML_TextInput
                "\u6587\u672c3": "",
                "\u6587\u672c4": "",
                "\u6587\u672c5": "",
                "\u5206\u9694\u7b26": ",\n",
                "\u542f\u75281": True,
                "\u542f\u75282": True,
                "\u542f\u75283": False,
                "\u542f\u75284": False,
                "\u542f\u75285": False,
            },
        },
        # 226 = Lora Loader (LoraManager) emitting a STRING of lora tags via inputs.text
        "226": {
            "class_type": "Lora Loader (LoraManager)",
            "inputs": {
                "text": "<lora:Krea2/wukong:1.2> <lora:Krea2/detail:0.6>",
                "loras": [],
            },
        },
        # 232 = ZML_TextInput with the real user-written prompt
        "232": {
            "class_type": "ZML_TextInput",
            "inputs": {"\u6587\u672c": "Create a tranquil coastal scene in Greece."},
        },
        # 256 = easy seed: stores plain int
        "256": {
            "class_type": "easy seed",
            "inputs": {"seed": 341872450086182},
        },
        # 86 = KSamplerAdvanced (user uses two passes, take the first)
        "86": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "add_noise": "enable",
                "noise_seed": ["256", 0],
                "steps": 8,
                "cfg": 1.0,
                "sampler_name": "er_sde",
                "scheduler": "simple",
                "start_at_step": 5,
                "end_at_step": 10000,
                "return_with_leftover_noise": "disable",
                "model": ["226", 0],
                "positive": ["7", 0],
                "negative": ["9", 0],
                "latent_image": ["177", 0],
            },
        },
    }

    p = tmp_path / "user_real_workflow.png"
    make_png(p, prompt=wf, width=1152, height=2064)
    meta = parse_metadata(p)

    # prompt: 文本1 (lora tags) joined by `,\n` with 文本2 (user text)
    assert meta["positive_prompt"] == (
        "<lora:Krea2/wukong:1.2> <lora:Krea2/detail:0.6>,\n"
        "Create a tranquil coastal scene in Greece."
    )
    # negative intentionally routed through ConditioningZeroOut
    assert meta["negative_prompt"] == ""
    # seed walked through easy seed link
    assert meta["seed"] == 341872450086182
    assert meta["steps"] == 8
    assert meta["cfg"] == 1.0
    assert meta["sampler"] == "er_sde"
    # raw inputs preserved (latent_image / noise_seed links kept as-is, that's expected)
    assert meta["parameters"]["noise_seed"] == ["256", 0]
    assert meta["parameters"]["sampler_name"] == "er_sde"
    assert meta["parameters"]["add_noise"] == "enable"



def _wf(nodes):  # 构造 UI workflow JSON 的小工具
    """wf = {"nodes": nodes}"""
    return {"nodes": nodes}


def test_extract_used_loras_basic():
    """3 个 LoRA 节点（含 1 个 PowerLoraLoader） -> used_loras 长度=3，按 |strength| 降序。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {"id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["x.safetensors"]},
        {"id": 20, "type": "LoraLoader", "widgets_values": ["foo.safetensors", 0.8, 0.8]},
        {"id": 21, "type": "LoRALoader", "widgets_values": ["bar.safetensors", 1.0, 1.0]},
        {"id": 22, "type": "Power Lora Loader (rgthree)", "widgets_values": ["baz.safetensors", 0.5]},
    ])
    result = _extract_used_loras_from_workflow(workflow)
    assert len(result) == 3
    assert result[0] == {"name": "bar", "strength": 1.0}
    assert result[1] == {"name": "foo", "strength": 0.8}
    assert result[2] == {"name": "baz", "strength": 0.5}


def test_extract_used_loras_skips_bypassed_nodes():
    """mode 0 / mode 4 (bypass) 的 LoRA 节点被过滤。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {"id": 20, "type": "LoraLoader", "widgets_values": ["foo.safetensors", 0.8, 0.8]},
        {"id": 21, "type": "LoraLoader", "mode": 0, "widgets_values": ["bypassed0.safetensors", 1.0, 1.0]},
        {"id": 22, "type": "LoraLoader", "mode": 4, "widgets_values": ["bypassed4.safetensors", 1.0, 1.0]},
        {"id": 23, "type": "LoraLoader", "mode": 1, "widgets_values": ["active1.safetensors", 0.5, 0.5]},
        {"id": 24, "type": "LoraLoader", "mode": 2, "widgets_values": ["active2.safetensors", 0.6, 0.6]},
    ])
    result = _extract_used_loras_from_workflow(workflow)
    names = [r["name"] for r in result]
    # mode 0 / mode 4 被过滤，mode 1 / mode 2 / 无 mode 都视为启用
    assert "bypassed0" not in names
    assert "bypassed4" not in names
    assert "active1" in names
    assert "active2" in names
    assert "foo" in names


def test_extract_used_loras_skips_non_lora_nodes():
    """CheckpointLoader / KSampler / CLIPTextEncode 不算 LoRA。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {"id": 10, "type": "CheckpointLoaderSimple", "widgets_values": ["x.safetensors"]},
        {"id": 30, "type": "KSampler", "widgets_values": [12345]},
        {"id": 40, "type": "CLIPTextEncode", "widgets_values": ["girl"]},
    ])
    assert _extract_used_loras_from_workflow(workflow) == []


def test_extract_used_loras_dedup_same_name():
    """同名 LoRA 多节点 -> strength 取绝对值大者。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {"id": 20, "type": "LoraLoader", "widgets_values": ["foo.safetensors", 0.3, 0.3]},
        {"id": 21, "type": "LoraLoader", "widgets_values": ["foo.safetensors", 0.9, 0.9]},
    ])
    result = _extract_used_loras_from_workflow(workflow)
    assert result == [{"name": "foo", "strength": 0.9}]


def test_extract_used_loras_default_strength():
    """没指定 strength 字段 -> 默认 1.0。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {"id": 20, "type": "LoraLoader", "widgets_values": ["foo.safetensors"]},
    ])
    assert _extract_used_loras_from_workflow(workflow) == [{"name": "foo", "strength": 1.0}]


def test_extract_used_loras_handles_invalid_input():
    """非 dict / 无 nodes 字段 -> 空列表，不抛异常。"""
    from app.parser import _extract_used_loras_from_workflow
    assert _extract_used_loras_from_workflow(None) == []
    assert _extract_used_loras_from_workflow("not a dict") == []
    assert _extract_used_loras_from_workflow([]) == []
    assert _extract_used_loras_from_workflow({"nodes": "not a list"}) == []
    assert _extract_used_loras_from_workflow({"k": "v"}) == []
    assert _extract_used_loras_from_workflow({"nodes": ["not a dict"]}) == []


def test_extract_used_loras_heuristic_safetensors_filename():
    """启发式：不在白名单但 widgets_values[0] 是 .safetensors 文件名 -> 也算 LoRA 节点。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {
            "id": 20,
            "type": "CustomLoraLoader_v2",
            "widgets_values": ["experimental.safetensors", 0.6],
        },
    ])
    result = _extract_used_loras_from_workflow(workflow)
    assert result == [{"name": "experimental", "strength": 0.6}]


def test_extract_used_loras_strips_extensions():
    """name 自动去常见扩展名（.safetensors / .ckpt / .pt / .pth）。"""
    from app.parser import _extract_used_loras_from_workflow
    workflow = _wf([
        {"id": 20, "type": "LoraLoader", "widgets_values": ["foo.safetensors", 0.5, 0.5]},
        {"id": 21, "type": "LoraLoader", "widgets_values": ["bar.ckpt", 0.6, 0.6]},
        {"id": 22, "type": "LoraLoader", "widgets_values": ["baz.pt", 0.7, 0.7]},
    ])
    result = _extract_used_loras_from_workflow(workflow)
    names = {r["name"] for r in result}
    assert names == {"foo", "bar", "baz"}


def test_parse_metadata_writes_used_loras():
    """parse_metadata 从 workflow chunk 抽出 used_loras，写进 parameters。"""
    import struct
    import zlib
    from pathlib import Path
    from app.parser import parse_metadata

    def _png_chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    ihdr_chunk = _png_chunk(b"IHDR", ihdr)
    raw = b"\x00\xff\x00\x00"
    idat_chunk = _png_chunk(b"IDAT", zlib.compress(raw))
    # UI workflow JSON: 一个启用 LoRA 节点 + 一个 bypassed 节点
    workflow_json = (
        '{"nodes": ['
        '  {"id": 20, "type": "LoraLoader", "widgets_values": ["foo.safetensors", 0.7, 0.7]},'
        '  {"id": 21, "type": "LoraLoader", "mode": 4, "widgets_values": ["hidden.safetensors", 1.0, 1.0]}'
        ']}'
    ).encode("utf-8")
    workflow_chunk = _png_chunk(b"tEXt", b"workflow\x00" + workflow_json)
    iend_chunk = _png_chunk(b"IEND", b"")
    png_bytes = sig + ihdr_chunk + workflow_chunk + idat_chunk + iend_chunk

    tmp = Path("outputs/_used_loras_fixture.png")
    tmp.parent.mkdir(exist_ok=True)
    tmp.write_bytes(png_bytes)
    try:
        meta = parse_metadata(tmp)
        used = meta["parameters"].get("used_loras")
        assert used is not None, f"expected used_loras, got parameters={meta['parameters']}"
        # 只有 foo (启用)，hidden (bypass) 被过滤
        assert used == [{"name": "foo", "strength": 0.7}]
    finally:
        tmp.unlink(missing_ok=True)


def test_extract_lora_manager_active_only():
    """LoraManager 节点有 18 个 LoRA 配置，只有 5 个 active=true -> used_loras 只有 5 个。"""
    from app.parser import _extract_active_loras_from_lora_manager
    workflow = _wf([
        {
            "id": 226,
            "type": "Lora Loader (LoraManager)",
            "widgets_values": [
                {"version": 1, "textWidgetName": "text"},
                "<lora:foo:0.8> <lora:bar:0.5> ...",
                [
                    {"name": "foo", "strength": "0.8", "active": True},
                    {"name": "bar", "strength": "0.5", "active": False},  # 关闭
                    {"name": "baz", "strength": "1.0", "active": True},
                    {"name": "qux", "strength": "0.3", "active": False},  # 关闭
                    {"name": "quux", "strength": "0.6", "active": True},
                ],
            ],
        },
    ])
    result = _extract_active_loras_from_lora_manager(workflow)
    names = [r["name"] for r in result]
    assert names == ["baz", "foo", "quux"]  # 按 |strength| 降序 (1.0 > 0.8 > 0.6)
    by_name = {r["name"]: r["strength"] for r in result}
    assert by_name["foo"] == 0.8
    assert by_name["baz"] == 1.0
    assert by_name["quux"] == 0.6
    # 关闭项不在结果里
    assert "bar" not in names
    assert "qux" not in names


def test_extract_lora_manager_bypassed_node_still_uses_active_list():
    """LoraManager 节点 mode=0 (bypass) 仍抽 active LoRA —— 用户可能主动 bypass 节点但用 widgets 列表管 LoRA。"""
    from app.parser import _extract_active_loras_from_lora_manager
    workflow = _wf([
        {
            "id": 226,
            "type": "Lora Loader (LoraManager)",
            "mode": 0,
            "widgets_values": [
                {"version": 1},
                "<lora:foo:0.8>",
                [
                    {"name": "foo", "strength": "0.8", "active": True},
                    {"name": "bar", "strength": "0.5", "active": False},
                ],
            ],
        },
    ])
    result = _extract_active_loras_from_lora_manager(workflow)
    # bypass 节点仍抽 active LoRA（这是用户管理 LoRA 的真实意图）
    assert result == [{"name": "foo", "strength": 0.8}]


def test_extract_lora_manager_dedup_same_name():
    """多个 LoraManager 节点同名 LoRA -> strength 取绝对值大者。"""
    from app.parser import _extract_active_loras_from_lora_manager
    workflow = _wf([
        {
            "id": 1,
            "type": "Lora Loader (LoraManager)",
            "widgets_values": [
                {}, "",
                [{"name": "foo", "strength": "0.3", "active": True}],
            ],
        },
        {
            "id": 2,
            "type": "Lora Loader (LoraManager)",
            "widgets_values": [
                {}, "",
                [{"name": "foo", "strength": "0.9", "active": True}],
            ],
        },
    ])
    result = _extract_active_loras_from_lora_manager(workflow)
    assert result == [{"name": "foo", "strength": 0.9}]


def test_extract_lora_manager_handles_invalid_input():
    """异常输入 -> 空列表，不抛。"""
    from app.parser import _extract_active_loras_from_lora_manager
    assert _extract_active_loras_from_lora_manager(None) == []
    assert _extract_active_loras_from_lora_manager({"nodes": "x"}) == []
    workflow = _wf([
        {
            "id": 1,
            "type": "Lora Loader (LoraManager)",
            "widgets_values": [{}, "", "not a list"],
        },
    ])
    assert _extract_active_loras_from_lora_manager(workflow) == []


def test_extract_lora_manager_strength_string_to_float():
    """strength 是字符串数字 -> 正确转 float。"""
    from app.parser import _extract_active_loras_from_lora_manager
    workflow = _wf([
        {
            "id": 1,
            "type": "Lora Loader (LoraManager)",
            "widgets_values": [
                {}, "",
                [
                    {"name": "foo", "strength": "0.85", "active": True},
                    {"name": "bar", "strength": 0.5, "active": True},
                    {"name": "baz", "strength": "1", "active": True},
                ],
            ],
        },
    ])
    result = _extract_active_loras_from_lora_manager(workflow)
    by_name = {r["name"]: r["strength"] for r in result}
    assert by_name["foo"] == 0.85
    assert by_name["bar"] == 0.5
    assert by_name["baz"] == 1.0


def test_parse_metadata_lora_manager_priority():
    """parse_metadata 优先用 LoraManager active LoRA，忽略 prompt 文本里的 <lora:> tags。"""
    import struct
    import zlib
    from pathlib import Path
    from app.parser import parse_metadata

    def _png_chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    ihdr_chunk = _png_chunk(b"IHDR", ihdr)
    raw = b"\x00\xff\x00\x00"
    idat_chunk = _png_chunk(b"IDAT", zlib.compress(raw))
    workflow_obj = {
        "nodes": [
            {
                "id": 226,
                "type": "Lora Loader (LoraManager)",
                "widgets_values": [
                    {"version": 1, "textWidgetName": "text"},
                    "<lora:active1:0.8> <lora:active2:0.5> <lora:closed1:0.7> <lora:closed2:0.6>",
                    [
                        {"name": "active1", "strength": "0.8", "active": True},
                        {"name": "active2", "strength": "0.5", "active": True},
                        {"name": "closed1", "strength": "0.7", "active": False},
                        {"name": "closed2", "strength": "0.6", "active": False},
                    ],
                ],
            },
        ],
    }
    import json as _json
    workflow_json = _json.dumps(workflow_obj).encode("utf-8")
    workflow_chunk = _png_chunk(b"tEXt", b"workflow\x00" + workflow_json)
    iend_chunk = _png_chunk(b"IEND", b"")
    png_bytes = sig + ihdr_chunk + workflow_chunk + idat_chunk + iend_chunk

    tmp = Path("outputs/_lora_manager_fixture.png")
    tmp.parent.mkdir(exist_ok=True)
    tmp.write_bytes(png_bytes)
    try:
        meta = parse_metadata(tmp)
        used = meta["parameters"].get("used_loras")
        assert used is not None
        names = [r["name"] for r in used]
        assert set(names) == {"active1", "active2"}
        assert "closed1" not in names
        assert "closed2" not in names
    finally:
        tmp.unlink(missing_ok=True)


def test_parse_metadata_no_workflow_chunk_no_used_loras():
    """PNG 没有 workflow chunk -> 不写 used_loras，让前端走 fallback。"""
    import struct
    import zlib
    from pathlib import Path
    from app.parser import parse_metadata

    def _png_chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    ihdr_chunk = _png_chunk(b"IHDR", ihdr)
    raw = b"\x00\xff\x00\x00"
    idat_chunk = _png_chunk(b"IDAT", zlib.compress(raw))
    iend_chunk = _png_chunk(b"IEND", b"")
    png_bytes = sig + ihdr_chunk + idat_chunk + iend_chunk

    tmp = Path("outputs/_no_workflow_fixture.png")
    tmp.parent.mkdir(exist_ok=True)
    tmp.write_bytes(png_bytes)
    try:
        meta = parse_metadata(tmp)
        assert "used_loras" not in meta["parameters"]
    finally:
        tmp.unlink(missing_ok=True)

