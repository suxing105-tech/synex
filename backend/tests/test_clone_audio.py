"""音频一键同款：Qwen3 音色克隆工作流的族别识别、产物收法与生成链路。

fixture 是从 F:/常用/闪寻音频.json 抄出来的同构体（裁掉多余分支后的那条音色克隆链）。
生成链路走 httpx.MockTransport，绝不连真机 8188。
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest

from app import clone_bundled, clone_jobs, clone_sources, clone_templates as ct
from app.comfyui_client import ComfyUIClient
from app.db import get_pool
from app.indexer import Indexer

from .conftest import make_png
from .test_clone_generate import FakeComfy  # noqa: F401  复用同一个假 ComfyUI

FAKE_URL = "http://comfy.test.invalid:9"


def qwen3_nodes() -> dict:
    """音色克隆那条链：加载模型 → 参考音频 → 克隆 → 存音频。"""
    return {
        "41": {"class_type": "Qwen3Loader", "inputs": {"model": "Qwen3-TTS-12Hz-1.7B-Base"}},
        "44": {"class_type": "LoadAudio", "_meta": {"title": "加载音频"},
               "inputs": {"audio": "SOPHIE 1.flac", "audioUI": ""}},
        "45": {"class_type": "Qwen3VoiceClone", "_meta": {"title": "声音克隆"}, "inputs": {
            "model": ["41", 0], "ref_audio": ["44", 0],
            "text": "你好，我是一条声音样本。",
            "ref_text": "你好，我是一条声音样本。",
            "language": "Auto", "seed": 42, "max_new_tokens": 2048,
            "ref_audio_max_seconds": 30}},
        "46": {"class_type": "SaveAudioAdvanced", "inputs": {
            "audio": ["45", 0], "filename_prefix": "audio/闪寻音频克隆", "format": "flac"}},
    }


# ---------- 族别 ----------


def test_media_kind_is_audio_because_of_the_saving_node():
    assert ct.detect_media_kind(qwen3_nodes()) == "audio"
    assert "audio" in ct.MEDIA_KINDS


def test_video_beats_audio_when_both_output_nodes_are_present():
    """H3 那种出片工作流也带 PreviewAudio：先判音频会把一条片子错归到音频族。"""
    nodes = qwen3_nodes()
    nodes["148"] = {"class_type": "VHS_VideoCombine", "inputs": {"audio": ["45", 0]}}
    assert ct.detect_media_kind(nodes) == "video"


def test_audio_family_wording():
    assert ct.mode_labels({"media_kind": "audio"})["single"] == "参考音色克隆"
    assert ct.reference_noun({"media_kind": "audio"}) == "参考音频"
    assert ct.is_audio({"media_kind": "audio"}) and not ct.is_video({"media_kind": "audio"})


def test_audio_family_warns_when_there_is_no_loader():
    """没有 LoadAudio 就没有「同款」可言，导入当时就要说清该补什么。"""
    nodes = qwen3_nodes()
    nodes.pop("44")
    nodes["45"]["inputs"].pop("ref_audio")
    detected = ct.detect_slots(nodes)
    assert detected["media_kind"] == "audio"
    warnings = ct.family_warnings(detected)
    assert warnings and "LoadAudio" in warnings[0]
    assert ct.family_warnings(ct.detect_slots(qwen3_nodes())) == []


def test_missing_kind_defaults_to_image():
    """老库里没有 media_kind 列的行：一律当图片，不能凭空变成音频。"""
    assert ct.media_kind_of_template({}) == "image"
    assert ct.media_kind_of_template({"media_kind": "nonsense"}) == "image"


# ---------- 收产物 ----------


def test_output_entries_reads_the_singular_audio_bucket():
    """真机 SaveAudioAdvanced 回的是单数 audio，不是 audios。"""
    one = {"filename": "闪寻音频克隆_00001.flac", "subfolder": "audio", "type": "output"}
    got = clone_jobs._output_entries({"46": {"audio": [one]}})
    assert [g["filename"] for g in got] == ["闪寻音频克隆_00001.flac"]


def test_output_entries_dedupes_the_same_file_reported_twice():
    one = {"filename": "a.flac", "subfolder": "audio", "type": "output"}
    got = clone_jobs._output_entries({
        "46": {"audio": [one], "audios": [dict(one)]},
        "47": {"audio": [{"filename": "b.flac", "subfolder": "audio", "type": "output"},
                         {"filename": "preview.flac", "subfolder": "", "type": "temp"}]},
    })
    assert sorted(g["filename"] for g in got) == ["a.flac", "b.flac"]


def test_audio_timeout_still_uses_the_short_clock():
    """音频是十几秒级的事，不该跟着视频吃 60 分钟的超时。"""
    assert clone_jobs._poll_timeout({"media_kind": "audio"}) == clone_jobs.POLL_TIMEOUT


# ---------- 生成链路 ----------


@pytest.fixture
def fake_audio(tmp_path: Path, monkeypatch):
    watch = tmp_path / "comfyui_output"
    (watch / "audio").mkdir(parents=True)
    (tmp_path / "config.json").write_text(
        json.dumps({"watch_dirs": [str(watch)], "comfyui_url": FAKE_URL, "comfyui_enabled": True}),
        encoding="utf-8")
    comfy = FakeComfy()
    (watch / "audio" / "闪寻音频克隆_00001.flac").write_bytes(b"fLaC" + b"\x00" * 60)
    comfy.outputs = {"46": {"audio": [
        {"filename": "闪寻音频克隆_00001.flac", "subfolder": "audio", "type": "output"},
        # 预览与保存各报一次同一个文件：只能收一条
        {"filename": "闪寻音频克隆_00001.flac", "subfolder": "audio", "type": "output"},
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


def audio_template(name="闪寻音频克隆") -> dict:
    """直接用随包那条：槽位是真机检测出来的（含语言下拉），离线检测拿不到 combo 选项。"""
    entry = [e for e in clone_bundled.entries() if e["key"] == "qwen3-tts-voice-clone"][0]
    return ct.create_template(name, entry["workflow"], entry["slots"])


def ref_media(tmp_path: Path, name: str, kind: str) -> int:
    path = tmp_path / "refs" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "image":
        path.write_bytes(make_png(path).read_bytes())
    else:
        path.write_bytes(b"fLaC" + b"\x00" * 40 if name.endswith(".flac") else b"\x8aN\x9e\xa9")
    payload = Indexer()._process_path_sync(path)
    assert payload, "indexer 没认这个文件"
    row = get_pool().main().execute("SELECT kind FROM images WHERE id=?", (int(payload["id"]),)).fetchone()
    assert row and str(row["kind"]) == kind, row
    return int(payload["id"])


async def test_audio_run_uploads_reference_and_collects_the_flac(fake_audio, tmp_path, init_db):
    tpl = audio_template()
    assert tpl["media_kind"] == "audio"
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    state = await clone_jobs.start(template_id=tpl["id"], prompt="换一段台词",
                                   references=[{"slot": cell["key"],
                                                "image_id": ref_media(tmp_path, "音色.flac", "audio")}],
                                   controls={"45.language": "Chinese"}, source_image_id=None)
    assert state["media_kind"] == "audio"
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "done", state["error"]
    assert len(state["outputs"]) == 1, state["outputs"]
    out = state["outputs"][0]
    assert out["kind"] == "audio" and out["filename"] == "闪寻音频克隆_00001.flac"
    # 音频产出给的是波形图，不是原始文件——前端拿 /api/images/{id}/file 会画出噪点
    assert out["thumbnail_url"].startswith(f"/api/audio/{out['id']}/waveform")
    assert "条" in state["message"]
    assert fake_audio.uploads and re.match(r"seekx_ref_\d+_[0-9a-f]{8}\.flac$", fake_audio.uploads[0])
    sent = json.dumps(fake_audio.prompts[-1], ensure_ascii=False)
    assert "换一段台词" in sent and '"Chinese"' in sent


async def test_audio_run_writes_both_prompt_inputs(fake_audio, tmp_path, init_db):
    """音色克隆要同时有 ref_text 与 text：只写一个节点会当场报错。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    await clone_jobs.start(template_id=tpl["id"], prompt="同一句话喂两个输入",
                           references=[{"slot": cell["key"],
                                        "image_id": ref_media(tmp_path, "音色.flac", "audio")}],
                           controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    node = fake_audio.prompts[-1]["prompt"]["45"]["inputs"]
    assert node["text"] == node["ref_text"] == "同一句话喂两个输入"


async def test_audio_slot_rejects_an_image(fake_audio, tmp_path, init_db):
    """往音频格子塞图片要在提交当场说清是哪一格，不该丢给 ComfyUI 去报红。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    with pytest.raises(ValueError) as exc:
        await clone_jobs.start(template_id=tpl["id"], prompt="x",
                               references=[{"slot": cell["key"],
                                            "image_id": ref_media(tmp_path, "照片.png", "image")}],
                               controls=None, source_image_id=None)
    assert "音频1" in str(exc.value) and "图片" in str(exc.value)
    assert clone_jobs.public_state()["active"] is False


async def test_audio_slot_rejects_an_unreadable_container(fake_audio, tmp_path, init_db):
    """容器放行了但 ComfyUI 吃不下（aiff 不在放行表里）→ 报格式并给出路。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    # .opus 是图库认的音频、却不在 ComfyUI 吃得下的容器里：正好测「放行表」这一层
    media = ref_media(tmp_path, "音色.opus", "audio")
    await clone_jobs.start(template_id=tpl["id"], prompt="x",
                           references=[{"slot": cell["key"], "image_id": media}],
                           controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "error"
    assert ".opus" in state["error"] and "MP3" in state["error"]


# ---------- 两段文字：台词与参考音频的原话 ----------


def transcript_first_nodes() -> dict:
    """真机那份导出里 ref_text 就排在 text 前面（JSON 里的键序），顺序不能决定谁是主框。"""
    nodes = json.loads(json.dumps(qwen3_nodes()))
    inputs = nodes["45"]["inputs"]
    nodes["45"]["inputs"] = {"ref_text": "参考音频里说的原话",
                             **{k: v for k, v in inputs.items() if k != "ref_text"}}
    return nodes


def test_reference_transcript_is_its_own_prompt_slot():
    """ref_text 要单独成槽并带上原话：混进主框的话，用户一改台词就把原话冲掉，音色立刻不像。"""
    prompts = {s["input"]: s for s in ct.detect_slots(qwen3_nodes())["slots"] if s["kind"] == "prompt"}
    assert prompts["text"]["label"] == "完整提示词"
    assert prompts["ref_text"]["label"] == "参考音频的文本"
    assert prompts["ref_text"]["value"] == "你好，我是一条声音样本。"


def test_prompt_order_in_the_json_does_not_decide_which_box_is_the_script():
    """键序把原话排最前也一样：主框认标签，不认谁先来。"""
    prompts = {s["input"]: s for s in ct.detect_slots(transcript_first_nodes())["slots"] if s["kind"] == "prompt"}
    assert prompts["text"]["label"] == "完整提示词"
    assert prompts["ref_text"]["label"] == "参考音频的文本"


def test_default_prompt_prefers_the_script_over_the_transcript():
    """工作流内置那条要预填台词：预填成原话会让用户以为那是他要改的东西。"""
    nodes = transcript_first_nodes()
    slots = ct.detect_slots(nodes)["slots"]
    assert ct.default_prompt_for(nodes, slots) == "你好，我是一条声音样本。"


def test_transcript_slot_keeps_its_value_through_the_database(init_db):
    """存库要留住原话：弹窗靠它预填，留不住就等于每次都把原话交给回落逻辑。"""
    nodes = qwen3_nodes()
    tpl = ct.create_template("音色克隆", nodes, ct.detect_slots(nodes)["slots"])
    got = {s["input"]: s for s in ct.get_template(tpl["id"])["slots"] if s["kind"] == "prompt"}
    assert got["ref_text"]["value"] == "你好，我是一条声音样本。"


def test_build_workflow_fills_each_prompt_slot_on_its_own():
    nodes = qwen3_nodes()
    slots = ct.normalize_slots(ct.detect_slots(nodes)["slots"], nodes)
    workflow, _ = ct.build_workflow(nodes, slots, prompt="新台词",
                                    slot_prompts={"45.ref_text": "原话照旧"},
                                    references={"44.audio": "seekx_ref_7_aabbccdd.flac"})
    assert workflow["45"]["inputs"]["text"] == "新台词"
    assert workflow["45"]["inputs"]["ref_text"] == "原话照旧"


def test_build_workflow_without_a_transcript_falls_back_to_the_script():
    """没给原话才退回台词——老请求体（不带 slot_prompts）行为一字不改。"""
    nodes = qwen3_nodes()
    slots = ct.normalize_slots(ct.detect_slots(nodes)["slots"], nodes)
    workflow, _ = ct.build_workflow(nodes, slots, prompt="只有台词",
                                    references={"44.audio": "seekx_ref_7_aabbccdd.flac"})
    assert workflow["45"]["inputs"]["text"] == workflow["45"]["inputs"]["ref_text"] == "只有台词"


async def test_start_rejects_a_slot_prompt_the_workflow_does_not_have(fake_audio, tmp_path, init_db):
    """往工作流没声明的文字位塞话要当场拒，不能静默丢掉用户填的那一段。"""
    tpl = audio_template()
    with pytest.raises(ValueError) as exc:
        await clone_jobs.start(template_id=tpl["id"], prompt="x", references=[], controls=None,
                               source_image_id=None, slot_prompts={"999.ref_text": "原话"})
    assert "999.ref_text" in str(exc.value)
    assert clone_jobs.public_state()["active"] is False


async def test_audio_run_keeps_the_reference_transcript_apart(fake_audio, tmp_path, init_db):
    """端到端：弹窗分两格填，节点收到的就该是两段不同的话。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    await clone_jobs.start(template_id=tpl["id"], prompt="换一段台词",
                           references=[{"slot": cell["key"],
                                        "image_id": ref_media(tmp_path, "音色.flac", "audio")}],
                           controls=None, source_image_id=None,
                           slot_prompts={"45.ref_text": "参考音频里说的原话"})
    await asyncio.wait_for(clone_jobs._task, 10)
    assert clone_jobs.public_state()["state"] == "done"
    node = fake_audio.prompts[-1]["prompt"]["45"]["inputs"]
    assert node["text"] == "换一段台词"
    assert node["ref_text"] == "参考音频里说的原话"


async def test_audio_run_records_the_two_texts_as_sources(fake_audio, tmp_path, init_db):
    """音频文件带不走提示词（PNG 有 tEXt、片子有元数据，flac 什么都没有）：
    所以「同款」要能重新打开这两格，唯一出路是生成当时自己记一份。"""
    tpl = audio_template()
    cell = next(c for c in ct.reference_cells(tpl["slots"]) if c["kind"] == "audio")
    await clone_jobs.start(template_id=tpl["id"], prompt="这条声音要念的话",
                           references=[{"slot": cell["key"],
                                        "image_id": ref_media(tmp_path, "音色.flac", "audio")}],
                           controls=None, source_image_id=None,
                           slot_prompts={"45.ref_text": "样本里的原话"})
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "done", state["error"]
    out = clone_sources.lookup(int(state["outputs"][0]["id"]))
    assert out["prompt"] == "这条声音要念的话"
    assert out["slot_prompts"] == {"45.ref_text": "样本里的原话"}
    # 参考音频也要照常记回来，重开弹窗时它还站在「音频1」
    assert [r["slot"] for r in out["references"]] == ["44.audio"]


def test_shipped_audio_workflow_carries_both_texts():
    """安装包那条要自带两段文字的初始值：缺了原话，新用户第一次克隆就是拿台词凑原话。"""
    entry = [e for e in clone_bundled.entries() if e["key"] == "qwen3-tts-voice-clone"][0]
    prompts = {s["input"]: s for s in entry["slots"] if s.get("kind") == "prompt"}
    assert prompts["text"]["label"] == "完整提示词"
    assert prompts["ref_text"]["label"] == "参考音频的文本"
    assert prompts["ref_text"]["value"].strip()
    assert prompts["ref_text"]["value"] == entry["workflow"]["45"]["inputs"]["ref_text"]


# ---------- 三种出声方式：参考音色 / 音色描述 / 指定音色 ----------

LANGS = ["Auto", "Chinese", "English", "Japanese", "Korean", "German",
         "French", "Russian", "Portuguese", "Spanish", "Italian"]
SPEAKERS = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]


def voice_design_nodes() -> dict:
    """音色描述那条链：不吃参考音频，一句话决定声音长什么样。"""
    return {
        "42": {"class_type": "Qwen3Loader", "inputs": {"repo_id": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"}},
        "38": {"class_type": "Qwen3VoiceDesign", "_meta": {"title": "音色设计"}, "inputs": {
            "model": ["42", 0], "text": "这是一段用文字描述出来的声音。",
            "instruct": "年轻女性，声音甜美温柔", "language": "Auto", "seed": 42}},
        "47": {"class_type": "SaveAudioAdvanced", "inputs": {
            "audio": ["38", 0], "filename_prefix": "audio/闪寻音色描述", "format": "flac"}},
    }


def custom_voice_nodes() -> dict:
    """指定音色那条链：音色从模型自带的人物里挑，同样不吃参考音频。"""
    return {
        "43": {"class_type": "Qwen3Loader", "inputs": {"repo_id": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"}},
        "37": {"class_type": "Qwen3CustomVoice", "_meta": {"title": "指定音色"}, "inputs": {
            "model": ["43", 0], "text": "这是用选定音色念的一句台词。", "language": "Auto",
            "speaker": "Vivian", "seed": 42, "instruct": "", "custom_speaker_name": "",
            "max_new_tokens": 2048}},
        "47": {"class_type": "SaveAudioAdvanced", "inputs": {
            "audio": ["37", 0], "filename_prefix": "audio/闪寻指定音色", "format": "flac"}},
    }


def three_branch_nodes() -> dict:
    """用户那份 F:/常用/闪寻音频.json：三条分支并排在同一张图里（连 PreviewAudio 都照抄）。"""
    nodes = {}
    nodes.update(qwen3_nodes())
    nodes.update(voice_design_nodes())
    nodes.update(custom_voice_nodes())
    # 原文件里三条分支各有自己的输出节点，谁都没连谁——这才是一键同款要跑三遍的原因
    nodes["39"] = {"class_type": "PreviewAudio", "inputs": {"audio": ["38", 0]}}
    nodes["40"] = {"class_type": "PreviewAudio", "inputs": {"audio": ["37", 0]}}
    return nodes


def tts_object_info() -> dict:
    """真机 object_info 的同构体（选项就是从 8188 上抄下来的那两份）。"""
    return {
        "Qwen3VoiceDesign": {"input": {"required": {
            "model": ["QWEN3_MODEL"], "text": ["STRING", {"multiline": True}],
            "instruct": ["STRING", {"multiline": True}],
            "language": [LANGS, {"default": "Auto"}],
            "seed": ["INT", {"default": 42, "min": 1, "max": 18446744073709551615}]}}},
        "Qwen3CustomVoice": {"input": {"required": {
            "model": ["QWEN3_MODEL"], "text": ["STRING", {"multiline": True}],
            "language": [LANGS, {"default": "Auto"}],
            "speaker": [SPEAKERS, {"default": "Vivian"}],
            "seed": ["INT", {"default": 42, "min": 1, "max": 18446744073709551615}]},
            "optional": {"instruct": ["STRING", {"multiline": True, "default": ""}]}}},
        "Qwen3VoiceClone": {"input": {"required": {
            "model": ["QWEN3_MODEL"], "text": ["STRING", {"multiline": True}],
            "seed": ["INT", {"default": 42}]},
            "optional": {"language": [LANGS, {"default": "Auto"}],
                         "ref_audio": ["AUDIO"], "ref_text": ["STRING", {"multiline": True}],
                         "max_new_tokens": ["INT", {"default": 2048}],
                         "ref_audio_max_seconds": ["FLOAT", {"default": 30.0}]}}},
    }


def test_voice_design_is_audio_and_needs_no_reference_at_all():
    """音色描述：音频族没错，但缺 LoadAudio 不该被当成毛病来指责用户。"""
    detected = ct.detect_slots(voice_design_nodes())
    assert detected["media_kind"] == "audio"
    assert ct.reference_slots(detected["slots"]) == []
    assert ct.family_warnings(detected) == []
    assert detected["modes"] == ["text"]
    # 参考音色的那条仍然会报——它确实少了跑不动的东西
    broken = qwen3_nodes()
    broken.pop("44")
    broken["45"]["inputs"].pop("ref_audio")
    assert ct.family_warnings(ct.detect_slots(broken))


def test_instruct_is_a_labelled_second_box_not_a_mystery_text():
    """音色描述这一格必须有自己的名字，而且不能顶掉台词那格。"""
    detected = ct.detect_slots(voice_design_nodes())
    slots = {(s["input"], s["label"]) for s in detected["slots"] if s["kind"] == "prompt"}
    assert ("text", ct.PRIMARY_PROMPT_LABEL) in slots
    assert ("instruct", "音色描述") in slots
    assert detected["default_prompt"] == "这是一段用文字描述出来的声音。"


def test_speaker_and_language_become_dropdowns_for_the_audio_modes():
    """出声音的工作流没有比例分辨率，弹窗里要能改的是语种与音色这两颗下拉。"""
    design = ct.detect_slots(voice_design_nodes(), tts_object_info())
    assert {s["label"] for s in design["slots"] if s["kind"] == "select"} == {"语言"}
    custom = ct.detect_slots(custom_voice_nodes(), tts_object_info())
    controls = {s["label"]: s for s in custom["slots"] if s["kind"] == "select"}
    assert set(controls) == {"音色", "语言"}
    assert controls["音色"]["options"] == SPEAKERS and controls["音色"]["value"] == "Vivian"
    assert controls["语言"]["options"] == LANGS


def test_image_and_video_workflows_do_not_get_the_audio_warnings():
    """那两句音频专属提醒不该冒到图片工作流里：它既不缺 LoadAudio 也不缺分支。"""
    nodes = {
        "10": {"class_type": "CR Prompt Text", "inputs": {"prompt": "一句"}},
        "11": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "12": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": ["10", 0], "negative_prompt": "糊"}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0]}},
    }
    detected = ct.detect_slots(nodes)
    assert detected["media_kind"] == "image"
    assert ct.family_warnings(detected) == []
    assert detected["warnings"] == []


def test_three_branches_say_up_front_that_one_click_makes_three_clips():
    """并排三条分支的那份原始 JSON：导入当时就得说清点一次出三段、弹窗有三个台词框。"""
    nodes = three_branch_nodes()
    detected = ct.detect_slots(nodes)
    assert detected["media_kind"] == "audio"
    assert ct.branch_prompt_nodes(nodes, detected["slots"]) == ["37", "38", "45"]
    text = " ".join(detected["warnings"])
    assert "3 段" in text and "台词框" in text
    # 孤立文本节点不算分支：图片工作流那种「同一段话再摆一份」不该被乱报
    solo = {"540": {"class_type": "CR Prompt Text", "inputs": {"prompt": "同一句话"}},
            "541": {"class_type": "CR Prompt Text", "inputs": {"prompt": "同一句话"}},
            "542": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
            "543": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": ["541", 0]}},
            "544": {"class_type": "SaveImage", "inputs": {"images": ["543", 0]}}}
    solo_detected = ct.detect_slots(solo)
    assert ct.branch_prompt_nodes(solo, solo_detected["slots"]) == ["541"]


def audio_mode_template(key: str, name: str) -> dict:
    entry = [e for e in clone_bundled.entries() if e["key"] == key][0]
    return ct.create_template(name, entry["workflow"], entry["slots"])


def write_output_audio(watch_root: Path, comfy, node: str, name: str) -> None:
    target = watch_root / "audio"
    target.mkdir(parents=True, exist_ok=True)
    (target / name).write_bytes(b"fLaC" + b"\x00" * 60)
    comfy.outputs = {node: {"audio": [
        {"filename": name, "subfolder": "audio", "type": "output"}]}}


async def test_voice_design_run_needs_no_reference_and_fills_both_boxes(fake_audio, tmp_path, init_db):
    tpl = audio_mode_template("qwen3-tts-voice-design", "闪寻音色描述")
    write_output_audio(tmp_path / "comfyui_output", fake_audio, "47", "闪寻音色描述_00001.flac")
    state = await clone_jobs.start(
        template_id=tpl["id"], prompt="今天天气不错", references=[],
        controls={"38.language": "Chinese"}, source_image_id=None,
        slot_prompts={"38.instruct": "成熟男声，低沉，语速慢"})
    assert state["media_kind"] == "audio"
    await asyncio.wait_for(clone_jobs._task, 10)
    done = clone_jobs.public_state()
    assert done["state"] == "done", done["error"]
    assert [o["filename"] for o in done["outputs"]] == ["闪寻音色描述_00001.flac"]
    assert done["outputs"][0]["kind"] == "audio"
    node = fake_audio.prompts[-1]["prompt"]["38"]["inputs"]
    assert node["text"] == "今天天气不错"
    assert node["instruct"] == "成熟男声，低沉，语速慢"
    assert node["language"] == "Chinese"
    # 不吃参考音频 → 一个文件都不该上传
    assert fake_audio.uploads == []


async def test_custom_voice_run_writes_the_picked_speaker(fake_audio, tmp_path, init_db):
    tpl = audio_mode_template("qwen3-tts-custom-voice", "闪寻指定音色")
    write_output_audio(tmp_path / "comfyui_output", fake_audio, "47", "闪寻指定音色_00001.flac")
    await clone_jobs.start(template_id=tpl["id"], prompt="换个音色念一句", references=[],
                           controls={"37.speaker": "Uncle_Fu", "37.language": "Chinese"},
                           source_image_id=None,
                           slot_prompts={"37.instruct": "温柔一点，带笑意"})
    await asyncio.wait_for(clone_jobs._task, 10)
    assert clone_jobs.public_state()["state"] == "done"
    node = fake_audio.prompts[-1]["prompt"]["37"]["inputs"]
    assert node["speaker"] == "Uncle_Fu" and node["language"] == "Chinese"
    assert node["instruct"] == "温柔一点，带笑意"
    assert node["text"] == "换个音色念一句"


async def test_custom_voice_empty_style_stays_empty(fake_audio, tmp_path, init_db):
    """语气那格留空＝不写指令，不能被后端自作主张灌成台词。"""
    tpl = audio_mode_template("qwen3-tts-custom-voice", "闪寻指定音色")
    write_output_audio(tmp_path / "comfyui_output", fake_audio, "47", "闪寻指定音色_00001.flac")
    await clone_jobs.start(template_id=tpl["id"], prompt="只填台词", references=[],
                           controls=None, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    assert clone_jobs.public_state()["state"] == "done"
    node = fake_audio.prompts[-1]["prompt"]["37"]["inputs"]
    assert node["instruct"] == "" and node["text"] == "只填台词"


async def test_a_made_up_speaker_never_reaches_comfyui(fake_audio, tmp_path, init_db):
    """音色下拉里的选项是模型给的，编一个名字要在提交前就挡下，且一份东西都不许发出去。"""
    tpl = audio_mode_template("qwen3-tts-custom-voice", "闪寻指定音色")
    await clone_jobs.start(template_id=tpl["id"], prompt="x", references=[],
                           controls={"37.speaker": "苏醒"}, source_image_id=None)
    await asyncio.wait_for(clone_jobs._task, 10)
    state = clone_jobs.public_state()
    assert state["state"] == "error"
    assert "音色" in state["error"] and "Vivian" in state["error"]
    assert fake_audio.prompts == []


def test_modes_of_the_two_no_reference_modes_are_text_only(init_db):
    for key, name in (("qwen3-tts-voice-design", "闪寻音色描述"),
                      ("qwen3-tts-custom-voice", "闪寻指定音色")):
        tpl = audio_mode_template(key, name)
        assert ct.modes_of(tpl) == ["text"], key
        assert ct.check_mode(tpl, "text") == "text", key
        assert ct.reference_cells(tpl["slots"]) == [], key
