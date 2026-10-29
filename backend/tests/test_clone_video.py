"""视频一键同款：H3 参考生视频工作流的识别、扩位、标签与生成链路。

fixture 是从 F:/常用/H3参考视频 .json 抄出来的最小同构体，节点号原样留着，
对着工作流看容易核；object_info 按本机 ComfyUI 0.43 的真实回包手写。
生成链路照旧走 httpx.MockTransport，绝不连真机 8188。
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest

from app import clone_jobs, clone_sources, clone_templates as ct
from app import workflow_edit
from app.comfyui_client import ComfyUIClient
from app.db import get_pool
from app.indexer import Indexer

from .conftest import make_png

FAKE_URL = "http://comfy.test.invalid:9"


def h3_nodes() -> dict:
    """H3 参考生视频：2 台 LoadImage + 1 台 LoadAudio + 1 台 VHS_LoadVideo。"""
    return {
        "129": {"class_type": "RandomNoise", "inputs": {"noise_seed": 525607799175747}},
        "136": {"class_type": "MiniMaxH3ReferenceToVideo", "_meta": {"title": "MiniMax H3 参考转视频"},
                "inputs": {
                    "prompt": ["265", 0], "width": ["228", 0], "height": ["228", 1],
                    "length": ["224", 1], "ref_image_size": "match",
                    "clip": ["232", 0], "vae": ["234", 0], "audio_vae": ["235", 0],
                    "ref_images.ref_image_0": ["199", 0], "ref_images.ref_image_1": ["188", 0],
                    "ref_videos.ref_video_0": ["185", 0], "ref_audios.ref_audio_0": ["182", 0]}},
        "182": {"class_type": "LoadAudio", "inputs": {"audio": "None", "audioUI": "None"},
                "_meta": {"title": "加载音频"}},
        "185": {"class_type": "VHS_LoadVideo", "inputs": {
            "video": "", "force_rate": 0, "custom_width": 0, "custom_height": 0,
            "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1,
            "format": "AnimateDiff"}, "_meta": {"title": "Load Video (Upload)"}},
        "121": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["125", 0], "vae": ["235", 0]}},
        "122": {"class_type": "VAEDecode", "inputs": {"samples": ["125", 0], "vae": ["234", 0]}},
        "123": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "er_sde"}},
        "125": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["129", 0], "guider": ["126", 0], "sampler": ["123", 0],
            "sigmas": ["255", 0], "latent_image": ["136", 1]}},
        "126": {"class_type": "BasicGuider", "inputs": {"model": ["127", 0], "conditioning": ["136", 0]}},
        "127": {"class_type": "UNETLoader", "inputs": {"unet_name": "MinimaxH3\\Cobijada_H3_Hy"}},
        "186": {"class_type": "忽略多组孤海", "inputs": {}},
        "188": {"class_type": "LoadImage", "inputs": {"image": "Qwen_image_2.1_00063.png"},
                "_meta": {"title": "加载图像"}},
        "199": {"class_type": "LoadImage", "inputs": {"image": "Qwen_image_2.1_00062.png"},
                "_meta": {"title": "加载图像"}},
        "224": {"class_type": "ComfyMathExpression", "inputs": {
            "expression": "max(5, round(a * 24))", "values.a": ["227", 0]}},
        "227": {"class_type": "PrimitiveFloat", "inputs": {"value": 8}, "_meta": {"title": "视频时长（秒）"}},
        "228": {"class_type": "ResolutionSelector", "inputs": {
            "aspect_ratio": "16:9 (Widescreen)", "megapixels": 1.1, "multiple": 32}},
        "232": {"class_type": "CLIPLoader", "inputs": {"clip_name": "MinimaxH3\\qwen3vl_32b_mi", "type": "minimax"}},
        "255": {"class_type": "ManualSigmas", "inputs": {"sigmas": "1, 0.99, 0.975"}},
        "264": {"class_type": "easy cleanGpuUsed", "inputs": {"anything": ["148", 0]}},
        "234": {"class_type": "VAELoader", "inputs": {"vae_name": "MinimaxH3\\minimax_h3_vid"}},
        "235": {"class_type": "VAELoader", "inputs": {"vae_name": "MinimaxH3\\minimax_h3_aud"}},
        "265": {"class_type": "PrimitiveStringMultiline",
                "inputs": {"value": "【风格】电影级 3D 产品大片风格，8 秒，16:9 横屏"},
                "_meta": {"title": "Text (System Prompt)"}},
        "148": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["122", 0], "audio": ["121", 0], "frame_rate": 24, "loop_count": 0,
            "filename_prefix": "AnimateDiff", "format": "video/h264-mp4"}},
    }


def _group(item: str, prefix: str, low: int, high: int, type_: str = "IMAGE") -> list:
    """真机回包里的 autogrow 写法：每格的类型在 template.input.required，格名靠 prefix 拼。"""
    return ["COMFY_AUTOGROW_V3", {"template": {
        "input": {"required": {item.rstrip("s"): [type_, {}]}},
        "prefix": prefix, "min": low, "max": high}}]


def h3_info() -> dict:
    return {
        "MiniMaxH3ReferenceToVideo": {"input": {
            "required": {
                "clip": ["CLIP", {}], "prompt": ["STRING", {"multiline": True}],
                "width": ["INT", {"default": 1280, "min": 256, "max": 4096}],
                "height": ["INT", {"default": 720, "min": 256, "max": 4096}],
                "length": ["INT", {"default": 192, "min": 5, "max": 4096}],
                "ref_image_size": ["COMBO", {"options": ["match", "720p"], "default": "match"}]},
            "optional": {
                "ref_images": _group("ref_images", "ref_image_", 0, 9),
                "ref_videos": _group("ref_videos", "ref_video_", 0, 3),
                "ref_video_audios": _group("ref_video_audios", "ref_video_audio_", 0, 3, "AUDIO"),
                "ref_audios": ["COMFY_AUTOGROW_V3", {"template": {
                    "input": {"required": {"ref_audio": ["AUDIO", {}]}},
                    "prefix": "ref_audio_", "min": 0, "max": 3}}]}}},
        "ResolutionSelector": {"input": {"required": {
            "aspect_ratio": ["COMBO", {"options": ["1:1 (Square)", "16:9 (Widescreen)", "9:16 (Portrait Widescreen)"],
                                       "default": "16:9 (Widescreen)"}],
            "megapixels": ["FLOAT", {"default": 1.0, "min": 0.1, "max": 4.0, "step": 0.1}],
            "multiple": ["INT", {"default": 32, "min": 16, "max": 128}]}}},
        "VHS_VideoCombine": {"output_node": True, "input": {"required": {
            "frame_rate": ["FLOAT", {"default": 8, "min": 1, "max": 120}],
            "format": ["COMBO", {"options": ["video/h264-mp4", "image/gif"], "default": "video/h264-mp4"}]}}},
    }

# ---------- 识别清单：这份工作流导入后必须被认成什么样 ----------


def detected() -> dict:
    return ct.detect_slots(h3_nodes(), h3_info())


def kinds_of(det: dict, kind: str) -> list[str]:
    return [s["node"] for s in det["slots"] if s["kind"] == kind]


def test_recognises_prompt_from_string_primitive(init_db):
    """提示词躺在 PrimitiveStringMultiline 里，键叫 value：按类名认，别按键名认。"""
    det = detected()
    prompts = [s for s in det["slots"] if s["kind"] == "prompt"]
    assert [(s["node"], s["input"]) for s in prompts] == [("265", "value")]
    # 时长那颗也叫 value，但它是 PrimitiveFloat——绝不能被当成提示词
    assert "227" not in kinds_of(det, "prompt")
    assert ct.default_prompt_for(h3_nodes(), det["slots"]).startswith("【风格】")


def test_recognises_all_three_reference_families(init_db):
    det = detected()
    assert kinds_of(det, "image") == ["188", "199"]
    assert kinds_of(det, "audio") == ["182"]
    assert kinds_of(det, "video") == ["185"]
    # 输入键各按族点名：视频加载器还有个 format 也是字符串，认错就把文件名写进格式框
    assert {s["input"] for s in det["slots"] if s["kind"] == "video"} == {"video"}
    assert {s["input"] for s in det["slots"] if s["kind"] == "audio"} == {"audio"}


def test_reference_cells_are_nine_images_three_audios_three_videos(init_db):
    """弹窗里的格子：图片 2 真槽 + 7 扩位 = 9（覆盖用户要的 6），音频 3，视频 3。"""
    cells = detected()["reference_cells"]
    assert [c["label"] for c in cells] == (
        [f"图片{i}" for i in range(1, 10)]
        + [f"音频{i}" for i in range(1, 4)]
        + [f"视频{i}" for i in range(1, 4)])
    assert [c["key"] for c in cells] == (
        ["188.image", "199.image"]
        + [f"188.image::ref_image_{i}" for i in range(2, 9)]
        + ["182.audio", "182.audio::ref_audio_1", "182.audio::ref_audio_2"]
        + ["185.video", "185.video::ref_video_1", "185.video::ref_video_2"])


def test_reference_cells_carry_h3_native_tags(init_db):
    """@ 引用要插的就是这个标签：带空格，与 H3 自己拼进上下文的写法一字不差。"""
    cells = detected()["reference_cells"]
    assert cells[0]["tag"] == "<Picture 1>"
    assert cells[8]["tag"] == "<Picture 9>"
    assert [c["tag"] for c in cells if c["kind"] == "audio"] == ["<Audio 1>", "<Audio 2>", "<Audio 3>"]
    assert [c["tag"] for c in cells if c["kind"] == "video"] == ["<Video 1>", "<Video 2>", "<Video 3>"]


def test_video_audio_output_does_not_become_an_extra_reference_cell(init_db):
    """VHS_LoadVideo 的 AUDIO 输出连到 ref_video_audios：那是那台视频自己的音轨，
    不能再多出一格参考位（否则用户会以为能多塞一段声音）。"""
    nodes = h3_nodes()
    nodes["136"]["inputs"]["ref_video_audios.ref_video_audio_0"] = ["185", 1]
    det = ct.detect_slots(nodes, h3_info())
    assert det["soundtracks"] == 1
    assert [c["key"] for c in det["reference_cells"] if c["kind"] == "video"] == [
        "185.video", "185.video::ref_video_1", "185.video::ref_video_2"]
    # 音轨在 H3 的呈现顺序里先占一个 <Audio j> 号，独立音频要从它后面接着数
    assert [c["tag"] for c in det["reference_cells"] if c["kind"] == "audio"] == [
        "<Audio 2>", "<Audio 3>", "<Audio 4>"]
    assert [c["tag"] for c in det["reference_cells"] if c["kind"] == "video"][:1] == ["<Video 1>"]


def test_soundtrack_count_only_counts_wired_video_soundtracks(init_db):
    assert ct.wired_reference_soundtracks(h3_nodes(), detected()["slots"]) == 0
    nodes = h3_nodes()
    nodes["136"]["inputs"]["ref_video_audios.ref_video_audio_1"] = ["185", 1]
    assert ct.wired_reference_soundtracks(nodes, detected()["slots"]) == 1


def test_media_kind_is_video_because_of_the_output_node(init_db):
    assert detected()["media_kind"] == "video"
    image_nodes = h3_nodes()
    image_nodes.pop("148")            # 出片节点没了
    image_nodes["136"]["class_type"] = "TextEncodeQwenImage21"   # 模型端也不再是视频模型
    image_nodes["600"] = {"class_type": "SaveImage", "inputs": {"filename_prefix": "Qwen"}}
    assert ct.detect_media_kind(image_nodes) == "image"


def test_controls_include_duration_ratio_and_resolution(init_db):
    controls = {s["node"] + "." + s["input"]: s for s in detected()["slots"]
                if s["kind"] in ("select", "number")}
    duration = controls["227.value"]
    assert (duration["label"], duration["unit"], duration["value"]) == ("时长", "秒", 8)
    assert duration["presets"] == [5, 8, 10, 12, 15]
    # 时长不占 MAX_AUTO_CONTROLS 那两个名额，比例和分辨率照样在
    assert controls["228.aspect_ratio"]["options"] and controls["228.megapixels"]["kind"] == "number"


def test_modes_are_text_single_and_multi(init_db):
    det = detected()
    assert set(det["modes"]) == {"text", "single", "multi"}
    assert ct.mode_labels({"media_kind": "video"})["text"] == "文生视频"
    assert ct.mode_labels({"media_kind": "image"})["text"] == ct.MODE_LABELS["text"]


# ---------- 注入：格子与实际接线必须一一对应 ----------


def video_template(**kwargs) -> dict:
    det = ct.detect_slots(h3_nodes(), h3_info())
    return ct.create_template(kwargs.pop("name", "H3 参考生视频"), h3_nodes(),
                              kwargs.pop("slots", det["slots"]), kwargs.pop("media_kind", None))


def full_refs() -> dict[str, str]:
    """6 张图 + 3 段音频 + 1 条视频，按弹窗格子键摆好。"""
    cells = ct.reference_cells_with_tags(video_template())
    refs: dict[str, str] = {}
    for cell in cells:
        if (cell["kind"], cell["ordinal"]) in {("image", 7), ("image", 8), ("image", 9),
                                               ("audio", 0)} or cell["ordinal"] > 6:
            continue
        if cell["kind"] == "image" and cell["ordinal"] > 6:
            continue
        if cell["kind"] in ("audio", "video") and cell["ordinal"] > 3:
            continue
        refs[cell["key"]] = f"seekx_ref_1_abc1234.{ {'image': 'png', 'audio': 'mp3', 'video': 'mp4'}[cell['kind']] }"
    return refs


def test_build_wires_every_family_into_its_own_group(init_db):
    tpl = video_template()
    slots, nodes = tpl["slots"], h3_nodes()
    refs = {c["key"]: f"seekx_ref_{c['ordinal']}_deadbeef."
            + {"image": "png", "audio": "mp3", "video": "mp4"}[c["kind"]]
            for c in ct.reference_cells(slots)
            if (c["kind"], c["ordinal"]) in {("image", 1), ("image", 2), ("image", 3),
                                             ("image", 4), ("image", 5), ("image", 6),
                                             ("audio", 1), ("audio", 2), ("audio", 3),
                                             ("video", 1)}}
    wf, _titles = ct.build_workflow(nodes, slots, prompt="新提示词", references=refs,
                                    controls={"227.value": 12}, info=h3_info())
    h3 = wf["136"]["inputs"]
    assert sorted(k for k in h3 if k.startswith("ref_images.")) == [
        f"ref_images.ref_image_{i}" for i in range(6)]
    assert sorted(k for k in h3 if k.startswith("ref_audios.")) == [
        f"ref_audios.ref_audio_{i}" for i in range(3)]
    assert sorted(k for k in h3 if k.startswith("ref_videos.")) == ["ref_videos.ref_video_0"]
    # 扩位是复制加载器：音频位长出来的必须是 LoadAudio，不能是 LoadImage
    cloned = {nid: n["class_type"] for nid, n in wf.items() if " · " in (n.get("_meta") or {}).get("title", "")}
    assert sorted(cloned.values()) == ["LoadAudio", "LoadAudio", "LoadImage", "LoadImage", "LoadImage", "LoadImage"]
    assert wf["265"]["inputs"]["value"] == "新提示词"
    assert wf["227"]["inputs"]["value"] == 12


def test_unfilled_loaders_are_detached(init_db):
    """只喂图片：工作流自带的旧音频和旧视频必须被摘掉，不能偷偷混进这一条片子。"""
    tpl = video_template()
    slots = tpl["slots"]
    refs = {"188.image": "a.png", "199.image": "b.png"}
    wf, _ = ct.build_workflow(h3_nodes(), slots, prompt="x", references=refs, info=h3_info())
    h3 = wf["136"]["inputs"]
    assert not any(k.startswith("ref_audios.") for k in h3)
    assert not any(k.startswith("ref_videos.") for k in h3)
    assert not any(str(v) == "None" for v in wf.values() if isinstance(v, dict))


def test_text_mode_drops_every_loader(init_db):
    tpl = video_template()
    wf, _ = ct.build_workflow(h3_nodes(), tpl["slots"], prompt="x", references={}, info=h3_info())
    h3 = wf["136"]["inputs"]
    assert not any(k.startswith(("ref_images.", "ref_audios.", "ref_videos.")) for k in h3)
    assert "188" not in wf and "182" not in wf and "185" not in wf


# ---------- 提交前校验：跳格要说人话 ----------


def test_gap_in_one_family_is_named_by_cell(init_db):
    tpl = video_template()
    slots = ct.reference_cells(tpl["slots"])
    audio2 = next(c["key"] for c in slots if c["kind"] == "audio" and c["ordinal"] == 2)
    image1 = next(c["key"] for c in slots if c["kind"] == "image" and c["ordinal"] == 1)
    with pytest.raises(ValueError) as exc:
        clone_jobs.plan_request(
            template_id=tpl["id"],
            references=[{"slot": image1, "image_id": 1}, {"slot": audio2, "image_id": 2}],
            controls=None)
    assert "音频1" in str(exc.value)


def test_family_warnings_point_at_the_missing_loader(init_db):
    det = detected()
    assert det["media_kind"] == "video"
    assert ct.family_warnings(det) == []          # 三族都接齐了
    no_audio = dict(det, slots=[s for s in det["slots"] if s["kind"] != "audio"])
    hints = ct.family_warnings(no_audio)
    assert len(hints) == 1 and "LoadAudio" in hints[0] and "音频" in hints[0]
    assert ct.family_warnings(dict(det, media_kind="image")) == []


def test_pruning_without_object_info_refuses_to_eat_the_output_node(init_db):
    """ComfyUI 没开时 object_info 是空的，产出节点只能靠类名认。
    认不出来就必须拒绝剪枝——静默排一份「只剩提示词」的工作流比报错坏得多。"""
    # 类名认得出 VHS_VideoCombine，所以没 object_info 也剪得动（不必退化成报错）
    kept = workflow_edit.drop_reference_images(h3_nodes(), ["188", "199", "182", "185"], {}, {}, {"265"})
    assert "148" in kept and "136" in kept

    # 但产出端被剪到没剩下时，必须拒绝，而不是安静交出一份空工作流：
    # 这里 SaveImage 唯一的必填输入 images 只由参考图供着，摘掉参考图它就成孤儿被删。
    starved = {
        "543": {"class_type": "LoadImage", "inputs": {"image": "旧图.png"}},
        "600": {"class_type": "SaveVideo", "inputs": {"video": ["543", 0], "filename_prefix": "S"}},
    }
    starved_info = {"SaveVideo": {"output_node": True, "input": {"required": {
        "video": ["VIDEO", {}], "filename_prefix": ["STRING", {}]}}}}
    with pytest.raises(workflow_edit.TextModeUnsupported) as exc:
        workflow_edit.drop_reference_images(starved, ["543"], starved_info, {}, set())
    assert "只支持按参考素材生成" in str(exc.value)
    # 带着 object_info（哪怕没标 output_node）就能靠类名把 Video Combine 认成产出端
    kept = workflow_edit.drop_reference_images(
        h3_nodes(), ["188", "199", "182", "185"],
        {"VHS_VideoCombine": {}}, {}, {"265"})
    assert "148" in kept and "136" in kept


# ---------- 模板族别：图片卡与视频卡各有各的「当前」 ----------


def image_workflow() -> dict:
    return {
        "543": {"class_type": "LoadImage", "inputs": {"image": "旧图.png"}},
        "582": {"class_type": "TextEncodeQwenImage21",
                "inputs": {"prompt": "内置提示词", "images": ["543", 0]}},
        "600": {"class_type": "SaveImage", "inputs": {"images": ["582", 0], "filename_prefix": "Qwen"}},
    }


def test_media_kind_defaults_per_family_and_can_be_rejudged(init_db):
    video = ct.create_template("H3 参考生视频", h3_nodes(), ct.detect_slots(h3_nodes(), h3_info())["slots"])
    image = ct.create_template("Qwen 多图编辑", image_workflow())
    assert (video["media_kind"], image["media_kind"]) == ("video", "image")
    # 各自成为各自那一族的「当前」，互不顶掉
    assert (video["is_active"], image["is_active"]) == (True, True)
    another_video = ct.create_template("第二条视频流", h3_nodes(),
                                       ct.detect_slots(h3_nodes(), h3_info())["slots"])
    assert another_video["is_active"] is False
    ct.set_active(another_video["id"])
    rows = {t["name"]: t for t in ct.list_templates()}
    assert rows["第二条视频流"]["is_active"] is True
    assert rows["H3 参考生视频"]["is_active"] is False
    assert rows["Qwen 多图编辑"]["is_active"] is True     # 图片那族没被动过
    # 设置页改判：视频判成图片后，它不再占视频族的「当前」
    ct.update_template(another_video["id"], {"media_kind": "image"})
    rows = {t["name"]: t for t in ct.list_templates()}
    assert rows["第二条视频流"]["media_kind"] == "image"
    assert rows["H3 参考生视频"]["is_active"] is True      # 视频族重新有了默认


def test_old_library_gets_media_kind_column(init_db):
    """旧库里这张表没有 media_kind：升级要补列并把老模板都算成图片工作流。"""
    conn = get_pool().main()
    conn.execute("ALTER TABLE clone_templates DROP COLUMN media_kind")
    ct.initialize(conn)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(clone_templates)")}
    assert "media_kind" in cols
    assert ct.create_template("老库里的一张图", image_workflow())["media_kind"] == "image"


def test_template_name_suggestion_strips_spaces():
    """ComfyUI 导出过「H3参考视频 .json」这种文件名，尾巴上的空格不能带进模板名。"""
    from app.routes.clone import _suggested_name
    assert _suggested_name(r"F:/常用/H3参考视频 .json") == "H3参考视频"


# ---------- 生成链路：产出的是视频也要收进图库、报回前端 ----------

from .test_clone_generate import FakeComfy  # noqa: E402  复用同一个假 ComfyUI


@pytest.fixture
def fake_video(tmp_path: Path, monkeypatch):
    watch = tmp_path / "comfyui_output"
    watch.mkdir()
    (tmp_path / "config.json").write_text(
        json.dumps({"watch_dirs": [str(watch)], "comfyui_url": FAKE_URL, "comfyui_enabled": True}),
        encoding="utf-8")
    comfy = FakeComfy()
    (watch / "AnimateDiff_00001_.mp4").write_bytes(b"\x00" * 64)
    comfy.outputs = {"148": {"gifs": [
        {"filename": "AnimateDiff_00001_.mp4", "subfolder": "", "type": "output", "format": "mp4/h264"},
        # 同一个文件被两个键各报一次（VHS 边预览边保存就这么干）：只能收一条
        {"filename": "AnimateDiff_00001_.mp4", "subfolder": "", "type": "output", "format": "mp4/h264"},
    ]}}
    comfy.png = b""
    transport = httpx.MockTransport(comfy.handler)
    real = ComfyUIClient

    def make(url, **kwargs):
        kwargs["transport"] = transport
        return real(url, **kwargs)

    monkeypatch.setattr(clone_jobs, "ComfyUIClient", make)
    monkeypatch.setattr(clone_jobs, "POLL_INTERVAL", 0.0)
    monkeypatch.setattr(clone_jobs, "POLL_TIMEOUT", 2.0)
    clone_jobs.reset_for_tests()
    yield comfy
    task = clone_jobs._task
    if task and not task.done():
        task.cancel()
    clone_jobs.reset_for_tests()


def ref_media(tmp_path: Path, name: str, folder: str = "input") -> int:
    path = tmp_path / folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = Path(name).suffix.lower()
    path.write_bytes(b"\x8aN\x9e\xa9" if suffix in {".mp3", ".wav"} else b"\x00" * 48
                     if suffix in {".mp4", ".mov"} else make_png(path).read_bytes())
    payload = Indexer()._process_path_sync(path)
    assert payload
    return int(payload["id"])


async def test_video_run_collects_gifs_once_and_reports_outputs(fake_video, tmp_path, init_db):
    tpl = video_template()
    slots = tpl["slots"]
    cells = ct.reference_cells(slots)
    want = {("image", 1), ("audio", 1), ("video", 1)}
    refs = []
    for cell in cells:
        if (cell["kind"], cell["ordinal"]) not in want:
            continue
        name = {"image": "参考图.png", "audio": "参考音频.mp3", "video": "参考视频.mp4"}[cell["kind"]]
        refs.append({"slot": cell["key"], "image_id": ref_media(tmp_path, name, cell["kind"])})
    state = await clone_jobs.start(template_id=tpl["id"], prompt="新的提示词", references=refs,
                                   controls={"227.value": 5}, source_image_id=None)
    assert state["media_kind"] == "video"
    task = clone_jobs._task
    await asyncio.wait_for(task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "done", state["error"]
    assert len(state["image_ids"]) == 1              # 兼容字段：老前端还在读它
    assert len(state["outputs"]) == 1                # 去重后只有一条
    out = state["outputs"][0]
    assert out["kind"] == "video" and out["filename"] == "AnimateDiff_00001_.mp4"
    # 缩略图走图库口径：视频是首帧地址（不是 /api/images/{id}/file）
    assert out["thumbnail_url"].startswith(f"/api/videos/{out['id']}/thumb")
    assert "条" in state["message"]
    # 三族素材各自上传成功，文件名仍然是 seekx_ref_<id>_<hash>
    assert len(fake_video.uploads) == 3
    assert all(re.match(r"seekx_ref_\d+_[0-9a-f]{8}\.(png|mp3|mp4)$", n) for n in fake_video.uploads)
    row = get_pool().main().execute("SELECT path FROM images WHERE id=?", (out["id"],)).fetchone()
    assert row and Path(row["path"]).name == "AnimateDiff_00001_.mp4"


async def test_video_timeout_uses_the_video_clock(fake_video, tmp_path, init_db, monkeypatch):
    monkeypatch.setattr(clone_jobs, "POLL_TIMEOUT_VIDEO", 0.01)
    assert clone_jobs._poll_timeout({"media_kind": "video"}) == 0.01
    assert clone_jobs._poll_timeout({"media_kind": "image"}) == clone_jobs.POLL_TIMEOUT
    tpl = video_template()
    fake_video.history_left = 999
    cells = ct.reference_cells(tpl["slots"])
    img = next(c["key"] for c in cells if c["kind"] == "image" and c["ordinal"] == 1)
    await clone_jobs.start(template_id=tpl["id"], prompt="x",
                           references=[{"slot": img, "image_id": ref_media(tmp_path, "图.png", "image")}],
                           controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "error" and "已请 ComfyUI 停下" in state["error"]
    assert fake_video.interrupts >= 1 and fake_video.deleted


async def test_sources_round_trip_keeps_kind(fake_video, tmp_path, init_db):
    """成图的来源要记住每一格当初是哪一族，重开弹窗时音频回音频行。"""
    produced = int(Indexer()._process_path_sync(make_png(tmp_path / "成片.png"))["id"])
    audio_id = ref_media(tmp_path, "声音.mp3", "audio")
    image_id = ref_media(tmp_path, "图.png", "image")
    clone_sources.record(image_ids=[produced], template_id=1, source_image_id=None,
                         references=[{"slot": "188.image", "image_id": image_id},
                                     {"slot": "182.audio", "image_id": audio_id}])
    refs = clone_sources.lookup(produced)["references"]
    assert [(r["slot"], r["kind"]) for r in refs] == [("188.image", "image"), ("182.audio", "audio")]
