"""一键同款：模板解析与槽位检测。

这里不读用户机器上的真实工作流，样例是从 F:/常用/Qwen-image-2.1多图编辑.json 抄出来的
最小同构体：540 是孤立的 CR Prompt Text、582 才是真正进采样的文本编码，543 是唯一的
LoadImage，13 是比例/百万像素，553 是随机种子。真实导入的验收在真机上跑。
"""
from __future__ import annotations

import json

import pytest

from app import clone_templates as ct


def sample_nodes() -> dict:
    return {
        "13": {
            "class_type": "ResolutionSelector",
            "inputs": {"aspect_ratio": "9:16 (Portrait Widescreen)", "megapixels": 2.2},
            "_meta": {"title": "分辨率选择"},
        },
        "472": {"class_type": "EmptyLatentImage", "inputs": {"width": ["13", 0], "height": ["13", 1], "batch_size": 1}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen.safetensors", "type": "flux"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_vae.safetensors"}},
        "540": {"class_type": "CR Prompt Text", "inputs": {"prompt": "孤立节点里的同一份提示词"}, "_meta": {"title": "CR Prompt Text"}},
        "543": {"class_type": "LoadImage", "inputs": {"image": "高清_00036_.png"}, "_meta": {"title": "加载图像"}},
        "553": {"class_type": "RandomNoise", "inputs": {"noise_seed": 922131566643457}},
        "582": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {"prompt": "一份完整的中文提示词", "negative_prompt": "模糊、低画质", "clip": ["2", 0]},
            "_meta": {"title": "文本编码 Qwen Image 2.1"},
        },
        "558": {"class_type": "SamplerCustom", "inputs": {"noise": ["553", 0], "conditioning": ["582", 0], "latent_image": ["472", 0]}},
        "601": {"class_type": "VAEDecode", "inputs": {"samples": ["558", 0], "vae": ["3", 0]}},
        "600": {"class_type": "SaveImage", "inputs": {"images": ["601", 0], "filename_prefix": "Qwen"}},
    }


def info_new() -> dict:
    """ComfyUI 0.42 的形状：["COMBO", {"options": [...], "default": ...}]。"""
    return {
        "ResolutionSelector": {"input": {"required": {
            "aspect_ratio": ["COMBO", {"options": ["1:1 (Square)", "9:16 (Portrait Widescreen)", "16:9 (Landscape)"], "default": "1:1 (Square)"}],
            "megapixels": ["FLOAT", {"default": 1.5, "min": 0.1, "max": 4.0, "step": 0.1}],
        }}},
        "EmptyLatentImage": {"input": {"required": {
            "width": ["INT", {"default": 1024, "min": 16, "max": 8192, "step": 8}],
            "height": ["INT", {"default": 1024, "min": 16, "max": 8192, "step": 8}],
            "batch_size": ["INT", {"default": 1, "min": 1, "max": 64}],
        }}},
        "SaveImage": {"input": {"required": {"filename_prefix": ["COMBO", {"contentOptions": ["Qwen", "Default"]}]}}},
    }


def info_old() -> dict:
    """老形状：下拉是 [[...], {default}]，数值是 [默认值, {min,max,step}]。"""
    return {
        "ResolutionSelector": {"input": {"required": {
            "aspect_ratio": [["1:1 (Square)", "9:16 (Portrait Widescreen)"], {"default": "1:1 (Square)"}],
            "megapixels": [1.5, {"default": 1.5, "min": 0.1, "max": 4.0, "step": 0.1}],
        }}},
    }


# ---------- parse_workflow ----------


def test_api_format_accepted_as_dict_and_text():
    nodes = ct.parse_workflow(sample_nodes())
    assert nodes["582"]["class_type"] == "TextEncodeQwenImage21"
    again = ct.parse_workflow(json.dumps(sample_nodes(), ensure_ascii=False))
    assert again == nodes


def test_ui_format_is_rejected_with_export_hint():
    with pytest.raises(ValueError) as exc:
        ct.parse_workflow({"nodes": [{"id": 1}], "links": []})
    assert "API 格式" in str(exc.value)


def test_empty_and_garbage_rejected():
    for bad in ({}, "", [], "not json", {"abc": 1}, {"1": {"inputs": {}}}):
        with pytest.raises(ValueError):
            ct.parse_workflow(bad)


# ---------- 提示词槽 ----------


def test_prompt_slots_hit_isolated_node_together_with_encoder():
    slots = ct.detect_slots(sample_nodes())["slots"]
    prompts = [(s["node"], s["input"]) for s in slots if s["kind"] == "prompt"]
    # 540（孤立 CR Prompt Text）必须一起写：只写 582 会让用户在 ComfyUI 里看到两份不一样的文本
    assert prompts == [("540", "prompt"), ("582", "prompt")]


def test_negative_prompt_never_becomes_a_prompt_slot():
    detected = ct.detect_slots(sample_nodes())
    assert all("negative" not in s["input"].lower() for s in detected["slots"])
    assert all("negative" not in c["input"].lower() for c in detected["candidates"])


def test_linked_text_input_is_not_offered_as_prompt():
    nodes = sample_nodes()
    nodes["582"]["inputs"]["prompt"] = ["540", 0]  # 文本由上游节点喂
    prompts = [s for s in ct.detect_slots(nodes)["slots"] if s["kind"] == "prompt"]
    assert [s["node"] for s in prompts] == ["540"]


def test_empty_prompt_string_is_skipped():
    nodes = sample_nodes()
    nodes["540"]["inputs"]["prompt"] = "   "
    prompts = [s for s in ct.detect_slots(nodes)["slots"] if s["kind"] == "prompt"]
    assert [s["node"] for s in prompts] == ["582"]


# ---------- 参考槽 ----------


def test_image_slot_uses_node_title():
    slots = [s for s in ct.detect_slots(sample_nodes())["slots"] if s["kind"] == "image"]
    assert [(s["node"], s["label"]) for s in slots] == [("543", "加载图像")]


def test_two_load_image_nodes_give_two_slots():
    nodes = sample_nodes()
    nodes["544"] = {"class_type": "LoadImage", "inputs": {"image": "b.png"}}
    slots = [s for s in ct.detect_slots(nodes)["slots"] if s["kind"] == "image"]
    assert [(s["node"], s["label"]) for s in slots] == [("543", "加载图像"), ("544", "图片2")]


def test_load_image_driven_by_upstream_is_warned_not_slotted():
    nodes = sample_nodes()
    nodes["543"]["inputs"]["image"] = ["700", 0]
    detected = ct.detect_slots(nodes)
    assert not [s for s in detected["slots"] if s["kind"] == "image"]
    assert any("543" in w for w in detected["warnings"])


# ---------- 控件 ----------


def test_controls_detected_from_both_object_info_shapes():
    for info in (info_new(), info_old()):
        detected = ct.detect_slots(sample_nodes(), info)
        controls = [s for s in detected["slots"] if s["kind"] in ("select", "number")]
        assert [c["input"] for c in controls] == ["aspect_ratio", "megapixels"], info
        assert controls[0]["options"][:2] == ["1:1 (Square)", "9:16 (Portrait Widescreen)"]
        assert controls[0]["value"] == "9:16 (Portrait Widescreen)"  # 工作流里的现值优先于 default
        assert controls[1]["kind"] == "number" and controls[1]["value"] == 2.2


def test_at_most_two_auto_controls_and_rest_fall_to_candidates():
    info = info_new()
    info["KSampler"] = {"input": {"required": {
        "steps": ["INT", {"default": 20, "min": 1, "max": 100}],
        "cfg": ["FLOAT", {"default": 7.0, "min": 0.0, "max": 30.0, "step": 0.5}],
    }}}
    nodes = sample_nodes()
    nodes["700"] = {"class_type": "KSampler", "inputs": {"steps": 30, "cfg": 3.5}}
    detected = ct.detect_slots(nodes, info)
    assert [s["input"] for s in detected["slots"] if s["kind"] in ("select", "number")] == ["aspect_ratio", "megapixels"]
    assert {c["input"] for c in detected["candidates"]} >= {"steps", "cfg", "batch_size"}


def test_combo_without_options_is_dropped_not_rendered():
    info = {"ResolutionSelector": {"input": {"required": {"aspect_ratio": ["COMBO", {}], "megapixels": ["FLOAT", {"default": 1.5}]}}}}
    controls = [s for s in ct.detect_slots(sample_nodes(), info)["slots"] if s["kind"] in ("select", "number")]
    assert [c["input"] for c in controls] == ["megapixels"]


def test_no_object_info_still_finds_prompt_and_image_slots():
    detected = ct.detect_slots(sample_nodes(), None)
    assert {s["kind"] for s in detected["slots"]} == {"prompt", "image"}
    assert detected["candidates"] == []


@pytest.mark.parametrize("raw,want", [
    (["COMBO", {"options": ["a", "b"], "default": "b"}], "combo"),
    ([["a", "b"], {"default": "a"}], "combo"),
    (["INT", {"default": 5, "min": 1, "max": 9}], "int"),
    ([5, {"default": 5, "min": 1, "max": 9}], "int"),
    ([1.5, {"default": 1.5}], "float"),
    (["COMBO", {"contentOptions": ["x"]}], "combo"),
    (["STRING", {}], "other"),
    ([], "other"),
    ("nonsense", "other"),
])
def test_widget_spec_normalises_both_shapes(raw, want):
    assert ct.widget_spec(raw)["kind"] == want


def test_widget_spec_is_imported_from_client():
    # 两种 object_info 形状的兼容只有 ComfyUI 客户端一处实现，模板层必须复用它
    from app import comfyui_client
    assert ct.widget_spec is comfyui_client.widget_spec


# ---------- normalize_slots ----------


def test_normalize_slots_rejects_bogus_bindings():
    nodes = sample_nodes()
    for bad in (
        [{"kind": "prompt", "node": "999", "input": "prompt"}],       # 节点不存在
        [{"kind": "prompt", "node": "582", "input": "nope"}],          # 输入不存在
        [{"kind": "number", "node": "472", "input": "width"}],         # width 由 13 连过来 → 不是字面量
        [{"kind": "mystery", "node": "582", "input": "prompt"}],       # 未知类型
        [{"kind": "prompt", "node": "540", "input": "prompt"},
         {"kind": "select", "node": "13", "input": "aspect_ratio"}],   # select 没带选项
    ):
        with pytest.raises(ValueError):
            ct.normalize_slots(bad, nodes)


def test_normalize_slots_requires_a_prompt_slot():
    with pytest.raises(ValueError) as exc:
        ct.normalize_slots([{"kind": "image", "node": "543", "input": "image"}], sample_nodes())
    assert "提示词" in str(exc.value)


def test_normalize_slots_keeps_labels_and_dedupes():
    slots = ct.normalize_slots([
        {"kind": "prompt", "node": "582", "input": "prompt", "label": "完整提示词"},
        {"kind": "prompt", "node": "582", "input": "prompt", "label": "重复的"},
        {"kind": "number", "node": "13", "input": "megapixels", "value": 2.2, "min": 0.1, "max": 4},
    ], sample_nodes())
    assert [(s["kind"], s["label"]) for s in slots] == [("prompt", "完整提示词"), ("number", "megapixels")]
    assert slots[1]["value"] == 2.2 and slots[1]["max"] == 4


# ---------- build_workflow ----------


def slots_for_build() -> list[dict]:
    return ct.detect_slots(sample_nodes(), info_new())["slots"]


def test_build_workflow_writes_prompt_into_every_prompt_slot():
    workflow, titles = ct.build_workflow(sample_nodes(), slots_for_build(), prompt="新的提示词")
    assert workflow["582"]["inputs"]["prompt"] == "新的提示词"
    assert workflow["540"]["inputs"]["prompt"] == "新的提示词"
    assert workflow["582"]["inputs"]["negative_prompt"] == "模糊、低画质"
    assert titles["582"] == "文本编码 Qwen Image 2.1"


def test_build_workflow_keeps_original_when_prompt_is_none():
    workflow, _ = ct.build_workflow(sample_nodes(), slots_for_build(), prompt=None)
    assert workflow["582"]["inputs"]["prompt"] == "一份完整的中文提示词"


def test_build_workflow_injects_reference_and_controls():
    workflow, _ = ct.build_workflow(
        sample_nodes(), slots_for_build(),
        references={"543.image": "seekx_ref_1_ab12cd34.png"},
        controls={"13.aspect_ratio": "1:1 (Square)", "13.megapixels": 1.0},
    )
    assert workflow["543"]["inputs"]["image"] == "seekx_ref_1_ab12cd34.png"
    assert workflow["13"]["inputs"]["aspect_ratio"] == "1:1 (Square)"
    assert workflow["13"]["inputs"]["megapixels"] == 1.0


def test_build_workflow_rejects_unknown_slots_and_bad_values():
    nodes = sample_nodes()
    for kwargs in (
        {"references": {"999.image": "x.png"}},
        {"controls": {"543.image": "nope"}},
        {"controls": {"13.aspect_ratio": "7:11 (Nonsense)"}},
        {"controls": {"13.megapixels": "lots"}},
        {"controls": {"13.megapixels": 99}},
    ):
        with pytest.raises(ValueError):
            ct.build_workflow(nodes, slots_for_build(), **kwargs)


def test_build_workflow_does_not_mutate_the_stored_workflow():
    nodes = sample_nodes()
    ct.build_workflow(nodes, slots_for_build(), prompt="改了也不影响原表", references={"543.image": "x.png"})
    assert nodes["582"]["inputs"]["prompt"] == "一份完整的中文提示词"
    assert nodes["543"]["inputs"]["image"] == "高清_00036_.png"


def test_seeds_randomised_on_every_build():
    nodes = sample_nodes()
    first, _ = ct.build_workflow(nodes, slots_for_build())
    second, _ = ct.build_workflow(nodes, slots_for_build())
    assert first["553"]["inputs"]["noise_seed"] != second["553"]["inputs"]["noise_seed"]
    assert isinstance(first["553"]["inputs"]["noise_seed"], int)
    assert nodes["553"]["inputs"]["noise_seed"] == 922131566643457


# ---------- 模板表 ----------


def test_first_template_becomes_active_and_name_is_unique(init_db):
    first = ct.create_template("多图编辑", sample_nodes())
    assert first["is_active"] == 1
    assert first["default_prompt"] == "一份完整的中文提示词"
    second = ct.create_template("另一套", sample_nodes())
    assert second["is_active"] == 0
    with pytest.raises(ct.DuplicateNameError):
        ct.create_template("多图编辑", sample_nodes())


def test_is_active_is_exclusive_across_the_table(init_db):
    a = ct.create_template("A", sample_nodes())
    b = ct.create_template("B", sample_nodes())
    ct.set_active(b["id"])
    states = {t["id"]: t["is_active"] for t in ct.list_templates()}
    assert states == {a["id"]: 0, b["id"]: 1}


def test_deleting_active_template_falls_back_to_the_oldest(init_db):
    a = ct.create_template("A", sample_nodes())
    b = ct.create_template("B", sample_nodes())
    ct.set_active(b["id"])
    ct.delete_template(b["id"])
    assert [t for t in ct.list_templates() if t["is_active"]][0]["id"] == a["id"]


def test_naming_rules(init_db):
    with pytest.raises(ValueError):
        ct.create_template("   ", sample_nodes())
    with pytest.raises(ValueError):
        ct.create_template("名字" * 30, sample_nodes())
    with pytest.raises(ValueError):
        ct.create_template("UI 格式", {"nodes": []})


def test_replacing_workflow_redetects_slots_instead_of_reusing_stale_bindings(init_db):
    row = ct.create_template("多图编辑", sample_nodes())
    stale = [{"kind": "prompt", "node": "582", "input": "text", "label": "完整提示词"}]
    # 先塞一条只在旧工作流里成立的槽位，替换后必须按新工作流重新检测
    ct.update_template(row["id"], {"slots": [{"kind": "prompt", "node": "582", "input": "prompt", "label": "完整提示词"}]})
    nodes = sample_nodes()
    nodes.pop("540")
    updated = ct.update_template(row["id"], {"workflow": nodes})
    assert [s["node"] for s in updated["slots"] if s["kind"] == "prompt"] == ["582"]
    with pytest.raises(ValueError):
        ct.update_template(row["id"], {"workflow": {"nodes": []}})


def test_rename_and_missing_row(init_db):
    row = ct.create_template("A", sample_nodes())
    other = ct.create_template("B", sample_nodes())
    assert ct.update_template(row["id"], {"name": "改过了"})["name"] == "改过了"
    with pytest.raises(ct.DuplicateNameError):
        ct.update_template(row["id"], {"name": "B"})
    assert ct.update_template(row["id"], {"is_active": True})["is_active"] == 1
    with pytest.raises(KeyError):
        ct.get_row(other["id"] + 999)


def test_public_rows_hide_workflow_body_but_keep_counts(init_db):
    row = ct.create_template("多图编辑", sample_nodes())
    listed = ct.list_templates()[0]
    assert "workflow" not in listed
    assert listed["node_count"] == len(sample_nodes())
    assert listed["reference_count"] == 1
    assert listed["prompt_count"] == 2
    # 导入时没给 object_info（ComfyUI 可能没开）→ 认不出控件，但提示词与参考位照样能用
    assert listed["control_count"] == 0
    assert json.loads(ct.workflow_json(row["id"]))["543"]["class_type"] == "LoadImage"


def test_default_prompt_prefers_the_effective_text_node():
    # 540 是孤立的文本块、582 才连进采样器：给用户看的那一条必须是生效的那一条
    nodes = sample_nodes()
    slots = ct.detect_slots(nodes)["slots"]
    assert ct.default_prompt_for(nodes, slots) == "一份完整的中文提示词"
    nodes["558"]["inputs"].pop("conditioning")
    assert ct.default_prompt_for(nodes, slots) == "孤立节点里的同一份提示词"


def test_default_prompt_is_empty_when_no_text_slot(init_db):
    assert ct.default_prompt_for(sample_nodes(), []) == ""


def test_node_overview_lists_every_literal_input(init_db):
    overview = {n["node"]: n for n in ct.node_overview(sample_nodes())}
    assert overview["582"]["title"] == "文本编码 Qwen Image 2.1"
    kinds = {i["input"]: i["kind"] for i in overview["582"]["inputs"]}
    assert kinds["prompt"] == "text" and kinds["clip"] == "link"
    literal = {i["input"]: i["literal"] for i in overview["472"]["inputs"]}
    assert literal["width"] is False and literal["batch_size"] is True


# ---------- 多图参考：工作流原生支持 autogrow 图组 ----------


def nodes_multi() -> dict:
    """把 543 连进 582 的 images.image_1——真实那份工作流就是这么只连了一张。"""
    nodes = sample_nodes()
    nodes["582"]["inputs"]["images.image_1"] = ["543", 0]
    return nodes


def info_autogrow() -> dict:
    info = info_new()
    # 与 ComfyUI 0.43 真机回包同构：格名在 names 里，每格的类型在 template.input.required
    info["TextEncodeQwenImage21"] = {"input": {"required": {
        "prompt": ["STRING", {"multiline": True}],
        "negative_prompt": ["STRING", {"multiline": True}],
        "clip": ["CLIP", {}],
        "images": ["COMFY_AUTOGROW_V3", {"template": {
            "input": {"required": {"image": ["IMAGE", {}]}},
            "names": [f"image_{i}" for i in range(1, 17)],
            "min": 0,
        }}],
    }}}
    return info


def test_autogrow_group_gives_free_reference_cells():
    nodes = nodes_multi()
    detected = ct.detect_slots(nodes, info_autogrow())
    slot = next(s for s in detected["slots"] if s["kind"] == "image")
    assert slot["grow"] == {"node": "582", "group": "images", "type": "IMAGE",
                            "names": [f"image_{i}" for i in range(2, 17)]}
    # 生成方式 = 参考图数量，所以没有「必填参考位」这回事了；扩位和真槽位一样可提交
    required, allowed = ct.reference_slot_keys(detected["slots"])
    assert required == []
    assert ct.grow_key(slot, "image_2") in allowed
    assert "582.prompt" not in allowed
    # 画面顺序：真槽位在前、扩位在后，弹窗编号和后端接线靠同一个顺序
    assert ct.reference_cell_keys(detected["slots"])[:2] == ["543.image", ct.grow_key(slot, "image_2")]


def test_autogrow_without_object_info_gives_no_cells():
    """没开 ComfyUI 时不能瞎猜能扩几张——猜错就是提交一份跑不通的工作流。"""
    detected = ct.detect_slots(nodes_multi(), None)
    assert "grow" not in next(s for s in detected["slots"] if s["kind"] == "image")


def test_load_image_not_wired_into_a_growable_group_gets_no_cells():
    detected = ct.detect_slots(sample_nodes(), info_autogrow())
    assert "grow" not in next(s for s in detected["slots"] if s["kind"] == "image")


def test_normalize_slots_keeps_grow_only_when_the_target_node_exists():
    nodes = nodes_multi()
    kept = ct.normalize_slots([{
        "kind": "image", "node": "543", "input": "image", "label": "加载图像",
        "grow": {"node": "582", "group": "images", "names": ["image_2", "image_3"]},
    }, {"kind": "prompt", "node": "582", "input": "prompt", "label": "提示词"}], nodes)
    assert next(s for s in kept if s["kind"] == "image")["grow"]["names"] == ["image_2", "image_3"]

    dropped = ct.normalize_slots([{
        "kind": "image", "node": "543", "input": "image", "label": "加载图像",
        "grow": {"node": "9999", "group": "images", "names": ["image_2"]},
    }, {"kind": "prompt", "node": "582", "input": "prompt", "label": "提示词"}], nodes)
    assert "grow" not in next(s for s in dropped if s["kind"] == "image")


def test_grown_reference_clones_load_image_and_wires_the_empty_cell():
    nodes = nodes_multi()
    slots = ct.detect_slots(nodes, info_autogrow())["slots"]
    image_slot = next(s for s in slots if s["kind"] == "image")
    workflow, _ = ct.build_workflow(
        nodes, slots,
        references={"543.image": "a.png", ct.grow_key(image_slot, "image_2"): "b.png"},
        randomize_seed=False,
    )
    clones = [nid for nid, node in workflow.items() if node.get("class_type") == "LoadImage"]
    assert len(clones) == 2
    clone_id = next(nid for nid in clones if nid != "543")
    assert workflow["543"]["inputs"]["image"] == "a.png"
    assert workflow[clone_id]["inputs"]["image"] == "b.png"
    assert "image_2" in workflow[clone_id]["_meta"]["title"]
    assert workflow["582"]["inputs"]["images.image_1"] == ["543", 0]     # 原有连线不动
    assert workflow["582"]["inputs"]["images.image_2"] == [clone_id, 0]  # 连线类型跟着原写法


def test_grown_reference_link_type_follows_int_style_workflow():
    nodes = nodes_multi()
    nodes["582"]["inputs"]["images.image_1"] = [543, 0]
    slots = ct.detect_slots(nodes, info_autogrow())["slots"]
    image_slot = next(s for s in slots if s["kind"] == "image")
    workflow, _ = ct.build_workflow(nodes, slots, references={ct.grow_key(image_slot, "image_3"): "c.png"},
                                    randomize_seed=False)
    clone_id = next(nid for nid, node in workflow.items()
                    if node.get("class_type") == "LoadImage" and nid != "543")
    assert workflow["582"]["inputs"]["images.image_3"] == [int(clone_id), 0]


def test_growing_the_same_cell_twice_is_refused():
    """同名格子重复提交会克隆两台接同一格，ComfyUI 里表现为后一张悄悄顶掉前一张。"""
    nodes = nodes_multi()
    slots = ct.detect_slots(nodes, info_autogrow())["slots"]
    image_slot = next(s for s in slots if s["kind"] == "image")
    with pytest.raises(ValueError, match="空着的参考位"):
        ct.build_workflow(nodes, slots, references={ct.grow_key(image_slot, "image_99"): "x.png"},
                          randomize_seed=False)


def test_split_reference_key_separates_real_slot_from_grown_cell():
    assert ct.split_reference_key("543.image") == ("543.image", None)
    assert ct.split_reference_key("543.image::image_2") == ("543.image", "image_2")
