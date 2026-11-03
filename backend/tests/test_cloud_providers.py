"""云端模型声明（cloud/spec.py）的自洽检查。

为什么单独测这一份：spec 是「弹窗上能选什么」与「请求体里发什么」唯一的真话来源。
它和弹窗、和 clone_templates 的槽位体系之间只要有一次对不上，表现都是
「界面能点、云端报错」或者更坏的「云端收了但没按参考走且不报错」。
所以这里钉的是形状与契约，不是具体价格数字。

全程不打真网络：这里只拼请求体，一次请求都不发。
"""
from __future__ import annotations

import pytest

from app import clone_templates
from app.cloud import engine as cloud_engine
from app.cloud import spec as cloud_spec


def spec(key: str):
    return cloud_spec.spec_or_raise(key)


# ---------- 与弹窗/模板体系的对齐 ----------


def test_prompt_label_matches_clone_templates():
    """弹窗主输入框的标签只有一份。两边各写一次，迟早一个改了一个没改。"""
    assert cloud_spec.PRIMARY_PROMPT_LABEL == clone_templates.PRIMARY_PROMPT_LABEL


@pytest.mark.parametrize("key", ["image", "video", "audio"])
def test_slots_fit_the_same_slot_contract(key):
    """每条声明的槽位都必须能被本机那套槽位函数吃下——弹窗不写第二套渲染。"""
    item = spec(key)
    slots = item.slots()
    prompt = [s for s in slots if s["kind"] == "prompt"]
    assert len(prompt) == 1
    assert prompt[0]["label"] == clone_templates.PRIMARY_PROMPT_LABEL
    assert all(str(s["node"]) == cloud_spec.SPEC_NODE for s in slots)
    kinds = {str(s["kind"]) for s in slots}
    assert kinds <= clone_templates.KINDS
    for slot in slots:
        assert clone_templates.slot_key(slot).startswith(cloud_spec.SPEC_NODE + ".")
    # 参考槽位每族只占一行，格数靠 grow.names 续；这保证「图片1…图片9」沿用本机那套编号
    for family, limit in item.refs.items():
        refs = [s for s in slots if s["kind"] == family]
        assert len(refs) == 1
        grow = refs[0].get("grow") or {}
        names = clone_templates.grow_names(refs[0])
        if limit > 1:
            assert len(names) == limit - 1
            assert grow.get("group")
        else:
            assert names == []


@pytest.mark.parametrize("key", ["image", "video", "audio"])
def test_reference_cells_respect_declared_limits(key):
    """声明说图参考最多 9 张，参考格就得正好 9 格，编号 1 起连续。"""
    item = spec(key)
    cells = clone_templates.reference_cells(item.slots(), 0, item.tag_templates())
    for family, limit in item.refs.items():
        ones = [c for c in cells if c["kind"] == family]
        assert [c["ordinal"] for c in ones] == list(range(1, limit + 1))
    for cell in cells:
        assert cell["tag"] == item.tag_templates()[cell["kind"]].format(n=cell["ordinal"])


@pytest.mark.parametrize("key", ["image", "video", "audio"])
def test_cloud_template_reports_its_own_modes(key):
    """云端能用哪些生成档位由声明说，不看「参考链摘不摘得掉」——那边没有节点可摘。"""
    item = spec(key)
    template = {"engine": "cloud", "model": key, "media_kind": item.capability,
                "slots": item.slots(), "nodes": {}}
    assert clone_templates.modes_of(template) == list(item.modes)
    assert set(item.modes) <= set(clone_templates.workflow_edit.MODES)


def test_seedance_tags_are_not_the_local_ones():
    """全项目风险最高的一处：云端认 @Image 1，本机 H3 认 <Picture 1>。

    标签写错不会报错，只会让参考素材白传、片子不按参考走。所以钉死。
    """
    video = spec("video")
    template = {"engine": "cloud", "model": "video", "media_kind": "video",
                "slots": video.slots(), "nodes": {}}
    cells = clone_templates.reference_cells_with_tags(template)
    image = [c for c in cells if c["kind"] == "image"][0]
    assert image["tag"] == "@Image 1"
    assert image["tag"] != clone_templates.TAG_TEMPLATES["image"].format(n=1)


def test_cloud_tts_template_has_no_mention_tags():
    """TTS 那条没有引用语法：标签留空，并且明确告诉弹窗把 @ 引用禁掉。

    让本机那套 <Audio 1> 漏进台词，配音会真的把它念出来——这是能直接被听见的笑话。
    """
    audio = spec("audio")
    template = {"engine": "cloud", "model": "audio", "media_kind": "audio",
                "slots": audio.slots(), "nodes": {}}
    cells = clone_templates.reference_cells_with_tags(template)
    assert cells and all(cell["tag"] == "" for cell in cells)
    assert audio.empty_tags is True
    view = clone_templates.public({"id": 1, "name": "音频API", "engine": "cloud",
                                   "provider": "runninghub", "model": "audio",
                                   "workflow": "", "slots": audio.slots(),
                                   "media_kind": "audio", "params": "{}", "is_active": 0})
    assert view["is_cloud"] is True
    assert view["cloud"]["mentions"] is False
    assert view["modes"] == ["text", "single"]
    assert all(cell["tag"] == "" for cell in view["reference_cells"])
    # 参考位上限要说准：数槽位只会得到 1，弹窗照它就把 2-9 格藏了
    assert view["reference_count"] == len(view["reference_cells"]) == 1
    # 本机模板不受影响：没有 engine 字段的老行照旧拿 H3 标签
    local = {"engine": "comfyui", "slots": [{"kind": "image", "node": "543", "input": "image"}],
             "nodes": {}}
    assert clone_templates.reference_cells_with_tags(local)[0]["tag"] == "<Picture 1>"


def test_local_rows_default_to_comfyui():
    """库里没有 engine 列之前躺着的老行，一律当本机——不能凭空变成要花钱的那条。"""
    assert clone_templates.engine_of({}) == "comfyui"
    assert clone_templates.engine_of({"engine": None}) == "comfyui"
    assert clone_templates.engine_of({"engine": "cloud"}) == "cloud"
    assert clone_templates.cloud_spec_of({"engine": "cloud", "model": "nope"}) is None


def test_template_names_match_the_sketch():
    """一行一族，名字就是「图片API」那三行，别让弹窗里冒出第四种叫法。"""
    assert [cloud_spec.template_name(s) for s in cloud_spec.all_specs()] == \
           ["图片API", "视频API", "音频API"]


# ---------- 请求体 ----------


def build(key, *, mode, prompt="说好的提示词", refs=(), **controls):
    item = spec(key)
    merged = {**item.default_controls(), **controls}
    return cloud_spec.build_body(item, mode=mode, prompt=prompt, refs=list(refs), controls=merged)


def test_image_text_to_image_body():
    path, body = build("image", mode="text", ratio="9:16", quality="2K")
    assert path == "/openapi/v2/seedream-v5-lite/text-to-image"
    assert body["prompt"] == "说好的提示词"
    # 2K 是长边 2048；9:16 就是宽 1152 高 2048（凑到 16 的倍数，模型自己不再裁一次）
    assert (body["width"], body["height"]) == (1152, 2048)
    assert "ratio" not in body and "quality" not in body
    assert "imageUrls" not in body          # 没给就不发：让「没给」和「给错」在服务端分得开
    assert body["sequentialImageGeneration"] == "disabled" and body["maxImages"] == 1


def test_image_reference_urls_keep_order():
    path, body = build("image", mode="multi", refs=[("image", "u2"), ("image", "u1")])
    assert path.endswith("image-to-image")
    assert body["imageUrls"] == ["u2", "u1"]   # 顺序就是「图1/图2」的编号，绝不重排


def test_video_body_is_what_the_docs_show():
    path, body = build("video", mode="multi",
                       refs=[("image", "i1"), ("video", "v1"), ("audio", "a1")],
                       resolution="720p", duration=5, ratio="9:16",
                       generateAudio="开", returnLastFrame="关", seed=12)
    assert path == "/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video"
    assert body["imageUrls"] == ["i1"] and body["videoUrls"] == ["v1"]
    assert body["audioUrls"] == ["a1"]
    assert body["duration"] == "5"        # 官方示例是字符串
    assert body["generateAudio"] is True and body["returnLastFrame"] is False
    assert body["resolution"] == "720p" and body["ratio"] == "9:16" and body["seed"] == 12
    assert "tier" not in body             # 档位只用来选端点，不进请求体


def test_video_fast_variant_swaps_endpoint_only():
    slow, _ = build("video", mode="text", tier="2.0")
    fast, body = build("video", mode="text", tier="2.0-Fast")
    assert slow.endswith("sparkvideo-2.0/multimodal-video")
    assert fast.endswith("sparkvideo-2.0-fast/multimodal-video")
    assert "tier" not in body


def test_video_switch_off_and_number_defaults():
    _path, body = build("video", mode="text", generateAudio="关")
    assert body["generateAudio"] is False


def test_audio_text_mode_uses_text_field_and_text_only_params():
    path, body = build("audio", mode="text", voice_id="Elegant_Man", speed=1.2,
                       emotion="happy", accuracy=0.9, need_noise_reduction="开")
    assert path.endswith("text-to-audio/speech-2.8-hd")
    assert body["text"] == "说好的提示词" and "prompt" not in body
    assert body["voice_id"] == "Elegant_Man" and body["speed"] == 1.2
    assert body["emotion"] == "happy"
    # accuracy / 降噪 只在复刻那一档发；文生这一档模型根本不认这两个字段
    assert "accuracy" not in body and "need_noise_reduction" not in body
    assert "audio" not in body and "model" not in body


def test_audio_clone_mode_sends_single_url_and_fixed_synth_model():
    path, body = build("audio", mode="single", refs=[("audio", "https://signed/x.mp3")],
                       accuracy=0.8, need_noise_reduction="开")
    assert path.endswith("text-to-audio/voice-clone")
    assert body["audio"] == "https://signed/x.mp3"   # 单份，不是数组
    assert body["model"] == "speech-02-hd"
    assert body["accuracy"] == 0.8 and body["need_noise_reduction"] is True
    assert "voice_id" not in body and "emotion" not in body


def test_empty_values_are_not_sent():
    """空字符串/空数组一律不进请求体：给错和没给必须在服务端表现不一样。"""
    _path, body = build("image", mode="text", prompt="", ratio="", quality="")
    assert body["prompt"] == ""
    assert "width" not in body and "height" not in body


def test_unsupported_mode_says_so_in_chinese():
    with pytest.raises(ValueError):
        cloud_spec.build_body(spec("audio"), mode="multi", prompt="x", refs=[],
                              controls=spec("audio").default_controls())


@pytest.mark.parametrize("ratio,edge,want", [
    ("9:16", 2048, (1152, 2048)),
    ("16:9", 2048, (2048, 1152)),
    ("1:1", 1024, (1024, 1024)),
    ("4:3", 1024, (1024, 768)),
    ("乱七八糟", 1024, (1024, 1024)),
])
def test_size_from_ratio_snaps_to_sixteens(ratio, edge, want):
    assert cloud_spec.size_from_ratio(ratio, edge) == want


def test_describe_all_is_what_the_settings_page_needs():
    """设置页三节与弹窗参数都吃 describe_all；缺一样界面上就是一个 undefined。"""
    items = cloud_spec.describe_all()
    assert [i["capability"] for i in items] == ["image", "video", "audio"]
    for item in items:
        for field in ("key", "name", "model_label", "blurb", "modes", "slots", "controls",
                      "verified", "notes", "provider_label", "ref_limits", "tags"):
            assert field in item, field
        assert item["controls"], item["key"]
        assert item["blurb"] and item["model_label"]


def test_every_spec_declares_what_is_unverified():
    """verified=False 的模型必须逐条写清缺什么——「待实测」不能只是一句口号。"""
    for item in cloud_spec.all_specs():
        if not item.verified:
            assert item.notes, item.key
            assert any("未核实" in n or "待实测" in n for n in item.notes), item.key


# ---------- 预估价格的读数 ----------


@pytest.mark.parametrize("payload,want", [
    ({"code": 0, "data": {"coins": 12}}, 12.0),
    ({"data": [{"consumeCoins": 3.5}]}, 3.5),
    ({"price": "8"}, 8.0),
    ({"data": {"unrelated": 1}}, None),
    ({}, None),
    (None, None),
])
def test_coins_from_only_reads_declared_keys(payload, want):
    """认不出就回 None。说错价格比不说更伤信任。"""
    assert cloud_engine.coins_from(payload) == want

