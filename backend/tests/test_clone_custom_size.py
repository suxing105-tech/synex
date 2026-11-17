# -*- coding: utf-8 -*-
r"""「自定义宽高」这一档必须真能改宽和高。

背景（2026-11-17 苏醒）：闪寻图片生成的比例菜单里有「自定义宽高」，选了它以下板却只有
百万像素——那两个像素输入框既不在槽位里也没处填，工作流正文里还写着 32×1024，
于是「自定义宽高」是个假选项。这里钉三件事：认得出这一对（且不乱认）、
条件字段能活着过存库、注入时真把宽和高写进工作流。
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from app import clone_templates as ct


def goohai_nodes(**override) -> dict:
    """孤海「比例与分辨率」那台节点的同构体：比例里有自定义宽高，宽高是同台的数字输入。"""
    inputs = {
        "倍数取整": 32,
        "固定边像素": 1536,
        "图像": ["543", 0],
        "模式": "总像素",
        "比例": "原始比例",
        "百万像素": 2,
        "自定宽度": 1024,
        "自定高度": 1024,
        "长边最大": 1536,
        "长边最小": 1024,
    }
    inputs.update(override)
    return {
        "543": {"class_type": "LoadImage", "inputs": {"image": "a.png"}, "_meta": {"title": "加载图像"}},
        "582": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "一份提示词"}},
        "584": {"class_type": "GoohaiRatioAndResolution", "inputs": inputs,
                "_meta": {"title": "比例与分辨率"}},
    }


def goohai_info(with_custom: bool = True) -> dict:
    options = ["原始比例", "1:1", "16:9"] + (["自定义宽高"] if with_custom else [])
    return {
        "GoohaiRatioAndResolution": {"input": {"required": {
            "比例": ["COMBO", {"options": options, "default": "原始比例"}],
            "模式": ["COMBO", {"options": ["总像素", "固定长边"], "default": "总像素"}],
            "百万像素": ["FLOAT", {"default": 2.0, "min": 0.2, "max": 50.0, "step": 0.1}],
            "自定宽度": ["INT", {"default": 1024, "min": 8, "max": 10240, "step": 1}],
            "自定高度": ["INT", {"default": 1024, "min": 8, "max": 10240, "step": 1}],
            "倍数取整": ["INT", {"default": 16, "min": 0, "max": 1024, "step": 1}],
            "固定边像素": ["INT", {"default": 1536, "min": 16, "max": 8192, "step": 8}],
            "长边最大": ["INT", {"default": 1536, "min": 16, "max": 8192, "step": 8}],
            "长边最小": ["INT", {"default": 1024, "min": 16, "max": 8192, "step": 8}],
        }}},
    }


def by_input(slots: list[dict]) -> dict[str, dict]:
    return {str(s.get("input")): s for s in slots}


# ---------- 检测 ----------


def gated_controls(nodes: dict) -> list[dict]:
    """面板上已经有「比例 + 百万像素」两颗控件——随包那条就是这个形状（槽位是配好的）。"""
    return [
        {"kind": "select", "node": "584", "input": "比例", "label": "比例",
         "options": ["原始比例", "1:1", "自定义宽高"], "value": "原始比例"},
        {"kind": "number", "node": "584", "input": "百万像素", "label": "分辨率", "value": 2},
    ]


def widgets_of(nodes: dict, info: dict) -> list:
    return ct._widgets(nodes, info)


def test_custom_size_pair_is_detected_and_gates_the_megapixel_knob():
    nodes = goohai_nodes()
    controls = gated_controls(nodes)
    pair = ct._custom_size_controls(nodes, widgets_of(nodes, goohai_info()), controls, set())
    width, height = pair
    mega = next(one for one in controls if one["input"] == "百万像素")
    assert width and height, "宽高两个框必须进槽位，否则这一档是死的"
    assert (width["kind"], width["label"], width["unit"]) == ("number", "宽度", "px")
    assert (height["label"], height["unit"]) == ("高度", "px")
    assert (width["input"], height["input"]) == ("自定宽度", "自定高度")
    assert width["show_when"] == {"input": "比例", "equals": "自定义宽高"}
    assert height["show_when"] == {"input": "比例", "equals": "自定义宽高"}
    # 这一档里节点不看百万像素，所以它在面板上必须让位给宽高
    assert mega["show_when"] == {"input": "比例", "not_equals": "自定义宽高"}
    # 尺寸要按 32 对齐算，步长从节点正文取（不是 info 里的默认 16）
    assert width["multiple"] == 32 and height["multiple"] == 32
    assert (width["min"], width["max"]) == (8, 10240)
    assert width["value"] == 1024


def test_custom_size_pair_not_invented_when_the_option_is_absent():
    """没有「自定义宽高」这个选项就不该有这一档：挂了条件那两个框会在所有档位下都不出现。"""
    nodes = goohai_nodes()
    controls = gated_controls(nodes)
    pair = ct._custom_size_controls(nodes, widgets_of(nodes, goohai_info(with_custom=False)),
                                    controls, set())
    assert pair == []
    assert "show_when" not in controls[1]


def test_custom_size_pair_needs_the_ratio_select_on_the_panel():
    """那颗下拉不在控件里就整对不认：没人能把条件扳过去，两个框会常驻在所有档位。"""
    nodes = goohai_nodes()
    only_mega = gated_controls(nodes)[1:]   # 只剩百万像素，没有那颗下拉
    assert ct._custom_size_controls(nodes, widgets_of(nodes, goohai_info()), only_mega, set()) == []


def test_custom_size_pair_needs_object_info():
    """认不出选项列表就整对不认（宁缺）：硬挂条件等于给所有档位添两颗常驻的框。"""
    nodes = goohai_nodes()
    assert ct._custom_size_controls(nodes, [], gated_controls(nodes), set()) == []


def test_custom_size_pair_needs_both_sides_on_the_same_node():
    """只有宽没有高＝认不出这一对，此时宽高都不给，免得用户改一半。"""
    nodes = goohai_nodes()
    del nodes["584"]["inputs"]["自定高度"]
    assert ct._custom_size_controls(nodes, widgets_of(nodes, goohai_info()),
                                    gated_controls(nodes), set()) == []


def test_custom_size_pair_skips_inputs_already_taken_by_a_slot():
    nodes = goohai_nodes()
    assert ct._custom_size_controls(nodes, widgets_of(nodes, goohai_info()),
                                    gated_controls(nodes), {"584.自定宽度"}) == []


def test_official_resolution_selector_with_custom_pixels_goes_through_detect_slots():
    """英文键那台（官方 ResolutionSelector 那族）走完整检测：比例、分辨率、宽高四颗都要在。"""
    nodes = {
        "582": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "一份提示词"}},
        "13": {"class_type": "ResolutionSelector", "inputs": {
            "aspect_ratio": "1:1", "megapixels": 2.0, "multiple": 32,
            "custom_width": 1024, "custom_height": 1024}},
    }
    info = {"ResolutionSelector": {"input": {"required": {
        "aspect_ratio": ["COMBO", {"options": ["1:1", "16:9", "自定义宽高"], "default": "1:1"}],
        "megapixels": ["FLOAT", {"default": 1.5, "min": 0.1, "max": 4.0, "step": 0.1}],
        "multiple": ["INT", {"default": 8, "min": 1, "max": 128}],
        "custom_width": ["INT", {"default": 1024, "min": 8, "max": 10240}],
        "custom_height": ["INT", {"default": 1024, "min": 8, "max": 10240}],
    }}}}
    got = by_input(ct.detect_slots(nodes, info)["slots"])
    assert {"aspect_ratio", "megapixels", "custom_width", "custom_height"} <= set(got)
    assert got["custom_width"]["show_when"] == {"input": "aspect_ratio", "equals": "自定义宽高"}
    assert got["megapixels"]["show_when"]["not_equals"] == "自定义宽高"
    assert got["custom_width"]["multiple"] == 32


# ---------- 存库 ----------


def test_normalize_slots_keeps_a_valid_show_when():
    slots = ct.normalize_slots([
        {"kind": "prompt", "node": "582", "input": "prompt"},
        {"kind": "number", "node": "584", "input": "自定宽度", "label": "宽度", "unit": "px",
         "show_when": {"input": "比例", "equals": "自定义宽高"}},
        {"kind": "number", "node": "584", "input": "百万像素", "label": "分辨率",
         "show_when": {"input": "比例", "not_equals": "自定义宽高"}},
    ], goohai_nodes())
    got = by_input(slots)
    assert got["自定宽度"]["show_when"] == {"input": "比例", "equals": "自定义宽高"}
    assert got["百万像素"]["show_when"] == {"input": "比例", "not_equals": "自定义宽高"}


def test_normalize_slots_keeps_show_when_across_redetect():
    """重新检测不许把这行约定冲掉（它不是从工作流里「看」出来的）。"""
    kept = ct.keep_authored_contract(
        [{"kind": "number", "node": "584", "input": "百万像素", "label": "分辨率",
          "show_when": {"input": "比例", "not_equals": "自定义宽高"}}],
        [{"kind": "number", "node": "584", "input": "百万像素", "label": "分辨率", "value": 2}],
    )
    assert kept[0]["show_when"] == {"input": "比例", "not_equals": "自定义宽高"}


@pytest.mark.parametrize("bad", [
    {"input": "不存在的输入", "equals": "自定义宽高"},
    {"input": "模式", "equals": 5},              # 值不是文字
    {"input": "自定宽度", "equals": "自定义宽高"},  # 挂到自己这类数字输入上
    {"input": "图像", "equals": "自定义宽高"},      # 那台节点的这项是连线值
    {"equals": "自定义宽高"},                     # 没说挂哪个输入
])
def test_normalize_slots_drops_unusable_show_when(bad):
    """认不出的条件一律丢掉，控件照常显示：条件写错就藏掉控件，是把参数弄丢。"""
    nodes = goohai_nodes()
    slots = ct.normalize_slots([
        {"kind": "prompt", "node": "582", "input": "prompt"},
        {"kind": "number", "node": "584", "input": "自定宽度", "show_when": bad},
    ], nodes)
    assert "show_when" not in by_input(slots)["自定宽度"]


# ---------- 注入 ----------


def test_build_workflow_writes_the_typed_width_and_height():
    nodes = goohai_nodes()
    slots = ct.normalize_slots([
        {"kind": "prompt", "node": "582", "input": "prompt"},
        {"kind": "select", "node": "584", "input": "比例", "label": "比例",
         "options": ["原始比例", "自定义宽高"], "value": "原始比例"},
        {"kind": "number", "node": "584", "input": "自定宽度", "label": "宽度", "unit": "px",
         "min": 8, "max": 10240, "multiple": 32,
         "show_when": {"input": "比例", "equals": "自定义宽高"}},
        {"kind": "number", "node": "584", "input": "自定高度", "label": "高度", "unit": "px",
         "min": 8, "max": 10240, "multiple": 32,
         "show_when": {"input": "比例", "equals": "自定义宽高"}},
    ], nodes)
    key_w = ct.slot_key(slots[2])
    key_h = ct.slot_key(slots[3])
    built, _ = ct.build_workflow(nodes, slots, prompt="换一套衣服",
                                controls={"584.比例": "自定义宽高", key_w: 1536, key_h: 1088})
    inputs = built["584"]["inputs"]
    assert inputs["比例"] == "自定义宽高"
    assert (inputs["自定宽度"], inputs["自定高度"]) == (1536, 1088)


def test_build_workflow_bounds_reject_absurd_pixels():
    nodes = goohai_nodes()
    slots = ct.normalize_slots([
        {"kind": "prompt", "node": "582", "input": "prompt"},
        {"kind": "number", "node": "584", "input": "自定宽度", "label": "宽度", "unit": "px",
         "min": 8, "max": 10240},
    ], nodes)
    with pytest.raises(ValueError, match="宽度"):
        ct.build_workflow(nodes, slots, controls={ct.slot_key(slots[1]): 99999})


# ---------- 随包那条 ----------


def test_bundled_image_template_really_offers_custom_pixels():
    """随包 JSON 必须自带这一对，并把正文里那个 32 换成能看的默认值：
    用户装完第一次选「自定义宽高」，用的就是这份正文里的数。"""
    from app import clone_bundled

    entry = next(one for one in clone_bundled.entries() if one["key"] == "qwen-multi-image-edit")
    nodes = ct.parse_workflow(entry["workflow"])
    inputs = nodes["584"]["inputs"]
    assert inputs["自定宽度"] == 1024 and inputs["自定高度"] == 1024
    got = by_input(entry["slots"])
    assert got["自定宽度"]["show_when"]["equals"] == "自定义宽高"
    assert got["自定高度"]["show_when"]["equals"] == "自定义宽高"
    assert got["百万像素"]["show_when"]["not_equals"] == "自定义宽高"
    assert "自定义宽高" in got["比例"]["options"]
    # 槽位得能过存库那一道校验（随包的那份是要 normalize 后写库的）
    stored = ct.normalize_slots(entry["slots"], nodes)
    assert by_input(stored)["自定宽度"]["show_when"]["equals"] == "自定义宽高"


def test_seeded_install_gets_the_custom_pixel_boxes(tmp_path: Path, monkeypatch):
    """老库升级也要拿到这一对：正文里的 32 一并刷掉，否则装好第一次选就是 32 宽。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    from app import clone_bundled, config, db

    importlib.reload(config)
    importlib.reload(db)
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "1")
    pool = db.init_pool()
    pool.initialize()
    conn = pool.main()
    row = conn.execute(
        "SELECT workflow, slots FROM clone_templates WHERE bundled_key=?",
        ("qwen-multi-image-edit",),
    ).fetchone()
    assert row is not None, "随包那条没装进来"
    got = by_input(json.loads(row["slots"]))
    assert {"自定宽度", "自定高度"} <= set(got)
    assert got["自定宽度"]["show_when"] == {"input": "比例", "equals": "自定义宽高"}
    assert json.loads(row["workflow"])["584"]["inputs"]["自定宽度"] == 1024
