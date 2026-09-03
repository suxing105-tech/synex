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

