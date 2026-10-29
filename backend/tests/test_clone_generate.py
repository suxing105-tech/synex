"""一键同款生成链路：用一个假 ComfyUI 跑完上传→注入→排队→轮询→取图→入库。

绝不连真机：所有请求都被 httpx.MockTransport 截住，config 里的地址也指到一个
不可能的域名，万一哪天有人漏改一处，测试会连不上而不是在用户的 ComfyUI 里出图。
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest

from app import clone_jobs, clone_sources, clone_templates
from app.comfyui_client import ComfyUIClient
from app.db import get_pool
from app.indexer import Indexer

from .conftest import make_png

FAKE_URL = "http://comfy.test.invalid:9"


def workflow() -> dict:
    return {
        "540": {"class_type": "CR Prompt Text", "inputs": {"prompt": "内置提示词"}},
        "543": {"class_type": "LoadImage", "inputs": {"image": "旧参考图.png"}, "_meta": {"title": "加载图像"}},
        "564": {"class_type": "LoadImage", "inputs": {"image": "另一张旧图.png"}, "_meta": {"title": "背景参考"}},
        "553": {"class_type": "RandomNoise", "inputs": {"noise_seed": 111}},
        "558": {"class_type": "SamplerCustom", "inputs": {"noise": ["553", 0], "prompt": "内置提示词", "sampler_name": "euler", "conditioning": ["582", 0]}, "_meta": {"title": "采样器"}},
        "582": {"class_type": "TextEncodeQwenImage21", "inputs": {
            "prompt": "内置提示词", "negative_prompt": "糊", "images": ["543", 0], "images.image_2": ["564", 0]}},
        "600": {"class_type": "SaveImage", "inputs": {"images": ["558", 0], "filename_prefix": "Qwen"}},
    }


def slots() -> list[dict]:
    return [
        {"kind": "prompt", "node": "540", "input": "prompt", "label": "完整提示词"},
        {"kind": "prompt", "node": "582", "input": "prompt", "label": "完整提示词"},
        {"kind": "image", "node": "543", "input": "image", "label": "加载图像"},
        {"kind": "image", "node": "564", "input": "image", "label": "背景参考"},
        {"kind": "select", "node": "558", "input": "sampler_name", "label": "比例",
         "options": ["euler", "dpmpp_2m"], "value": "euler"},
    ]


class FakeComfy:
    """最小可用的 ComfyUI：够用就行，返回内容按需改。"""

    def __init__(self):
        self.running = True
        self.node_errors: dict = {}
        self.history_bodies: list[dict] = []
        self.history_left = 1          # 前 N 次 /history 返回空（任务还在跑）
        self.outputs = {"600": {"images": [{"filename": "Qwen_00001_.png", "subfolder": "", "type": "output"}]}}
        self.upload_subfolder = "seekx"
        self.status_str = "success"
        self.messages: list = []
        self.png = b""
        self.bodies: list[str] = []
        self.uploads: list[str] = []
        self.prompts: list[dict] = []
        self.interrupts = 0
        self.deleted: list[list[str]] = []

    def output_bytes(self, count: int, root: Path, subfolder: str = "") -> None:
        """假装 ComfyUI 已经把这些文件写在自己的 output 目录里。

        出图不再由图库复制一份，所以测试要提前把文件放到监听目录，
        被测代码只负责「找到它 + 收进图库」。
        """
        target = root / subfolder if subfolder else root
        target.mkdir(parents=True, exist_ok=True)
        names = [f"Qwen_{i:05d}_.png" for i in range(1, count + 1)]
        self.png = make_png(root / "seed.png", width=6, height=6).read_bytes()
        for name in names:
            (target / name).write_bytes(self.png)
        self.outputs = {"600": {"images": [
            {"filename": name, "subfolder": subfolder, "type": "output"} for name in names
        ] + [{"filename": "preview.png", "subfolder": "", "type": "temp"}]}}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if not self.running:
            raise httpx.ConnectError("boom", request=request)
        if path == "/system_stats":
            return httpx.Response(200, json={"systems": []})
        if path == "/upload/image":
            body = request.content.decode("utf-8", "replace")
            match = re.search(r'filename="([^"]+)"', body)
            self.uploads.append(match.group(1) if match else "")
            return httpx.Response(200, json={"name": match.group(1) if match else "x.png",
                                             "subfolder": self.upload_subfolder, "type": "input"})
        if path == "/prompt":
            payload = json.loads(request.content)
            self.prompts.append(payload)
            if self.node_errors:
                return httpx.Response(200, json={"error": None, "node_errors": self.node_errors})
            return httpx.Response(200, json={"prompt_id": "pid-1", "number": 1, "node_errors": {}})
        if path.startswith("/history/"):
            if self.history_left > 0:
                self.history_left -= 1
                return httpx.Response(200, json={})
            return httpx.Response(200, json={"pid-1": {
                "outputs": self.outputs,
                "status": {"status_str": self.status_str, "messages": self.messages},
            }})
        if path == "/view":
            return httpx.Response(200, content=self.png, headers={"content-type": "image/png"})
        if path == "/interrupt":
            self.interrupts += 1
            return httpx.Response(200, json={})
        if path == "/queue":
            self.deleted.append(json.loads(request.content).get("delete") or [])
            return httpx.Response(200, json=[])
        self.bodies.append(f"{method} {path}")
        return httpx.Response(404, json={"error": "nope"})


@pytest.fixture
def fake(tmp_path: Path, monkeypatch):
    """临时数据目录 + 假 ComfyUI + 不要真的等 1.5 秒轮询。"""
    watch = tmp_path / "comfyui_output"   # 用户实际监听的就是 ComfyUI 的 output 目录
    watch.mkdir()
    (tmp_path / "config.json").write_text(
        json.dumps({"watch_dirs": [str(watch)], "comfyui_url": FAKE_URL, "comfyui_enabled": True}), encoding="utf-8"
    )
    comfy = FakeComfy()
    comfy.output_bytes(1, watch)
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


@pytest.fixture
def source_image(tmp_path: Path, init_db) -> int:
    path = make_png(tmp_path / "源图.png", width=8, height=8)
    payload = Indexer()._process_path_sync(path)
    assert payload
    return int(payload["id"])


def template(**kwargs) -> dict:
    return clone_templates.create_template(kwargs.pop("name", "多图同款"), workflow(), kwargs.pop("slots", slots()))


async def finish() -> dict:
    task = clone_jobs._task
    assert task is not None
    await asyncio.wait_for(task, 5)
    return clone_jobs.public_state()


async def start(template_id: int, image_id: int, **kwargs) -> dict:
    return await clone_jobs.start(
        template_id=template_id,
        prompt=kwargs.pop("prompt", "一套新的提示词"),
        references=kwargs.pop("references", [{"slot": "543.image", "image_id": image_id}]),
        controls=kwargs.pop("controls", None),
        source_image_id=image_id,
    )


# ---------- 全链路 ----------


async def test_full_run_registers_the_file_comfyui_already_wrote(fake, source_image, init_db, tmp_path):
    """出图就留在 ComfyUI 输出目录：图库只负责把它认回来，不再复制一份。"""
    fake.history_left = 2  # 先转两轮，验证轮询不是只看一次
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert state["state"] == "done" and state["running"] is False
    assert len(state["image_ids"]) == 1
    row = get_pool().main().execute(
        "SELECT filename, path FROM images WHERE id=?", (state["image_ids"][0],)).fetchone()
    assert row["filename"] == "Qwen_00001_.png"
    assert Path(row["path"]).samefile(tmp_path / "comfyui_output" / "Qwen_00001_.png")
    # 绝不再建「一键同款」文件夹，也不往数据目录里多写一份图
    folders = get_pool().main().execute(
        "SELECT COUNT(*) c FROM folders WHERE name='一键同款'").fetchone()["c"]
    assert folders == 0
    assert [b for b in fake.bodies if "/view" in b] == []  # 没去 /view 再下载一遍


async def test_output_missing_from_watch_dirs_is_reported_not_fatal(fake, source_image, init_db):
    """图在监听目录之外（比如另开了一个 ComfyUI）：说清楚在哪，别把成功报成失败。"""
    fake.outputs = {"600": {"images": [{"filename": "在别处.png", "subfolder": "", "type": "output"}]}}
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert state["state"] == "done" and state["image_ids"] == []
    assert "在别处.png" in state["message"] and "没收进图库" in state["message"]


async def test_reference_upload_name_is_hashed_and_subfolder_aware(fake, source_image, init_db):
    tpl = template()
    await start(tpl["id"], source_image)
    await finish()
    name = fake.uploads[0]
    assert re.fullmatch(rf"seekx_ref_{source_image}_[0-9a-f]{{8}}\.png", name), name
    assert "源图" not in name  # 绝不复用原始文件名，免得覆盖用户 input 目录里的同名文件
    assert fake.prompts[0]["prompt"]["543"]["inputs"]["image"] == f"seekx/{name}"


async def test_reference_name_follows_content(fake, source_image, init_db):
    tpl = template()
    await start(tpl["id"], source_image)
    await finish()
    first = fake.uploads[0]
    path = Path(get_pool().main().execute("SELECT path FROM images WHERE id=?", (source_image,)).fetchone()["path"])
    make_png(path, width=12, height=4)  # 同名文件被换成另一张图
    clone_jobs.reset_for_tests()
    await start(tpl["id"], source_image)
    await finish()
    # 内容变了 → hash 变 → ComfyUI 不会拿上一次的旧参考图
    assert fake.uploads[1] != first
    assert fake.prompts[1]["prompt"]["543"]["inputs"]["image"].endswith(fake.uploads[1])


async def test_prompt_reference_and_controls_are_injected(fake, source_image, init_db):
    tpl = template()
    await start(tpl["id"], source_image, controls={"558.sampler_name": "dpmpp_2m"})
    await finish()
    prompt = fake.prompts[0]["prompt"]
    assert prompt["582"]["inputs"]["prompt"] == "一套新的提示词"
    assert prompt["540"]["inputs"]["prompt"] == "一套新的提示词"   # 孤立节点跟着改
    assert prompt["582"]["inputs"]["negative_prompt"] == "糊"      # 负向提示词不碰
    assert prompt["558"]["inputs"]["sampler_name"] == "dpmpp_2m"
    assert fake.prompts[0]["client_id"]


async def test_seed_changes_between_two_runs(fake, source_image, init_db):
    tpl = template()
    await start(tpl["id"], source_image)
    await finish()
    clone_jobs.reset_for_tests()
    await start(tpl["id"], source_image)
    await finish()
    seeds = [p["prompt"]["553"]["inputs"]["noise_seed"] for p in fake.prompts]
    assert seeds[0] != seeds[1] != 111


async def test_every_output_image_is_collected(fake, source_image, init_db, tmp_path):
    fake.output_bytes(3, tmp_path / "comfyui_output", subfolder="batch")
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert len(state["image_ids"]) == 3   # type=temp 的预览图不算交付物
    names = [Path(r["path"]).name for r in get_pool().main().execute(
        "SELECT path FROM images WHERE id IN (%s)" % ",".join("?" * 3), state["image_ids"])]
    assert len(set(names)) == 3


# ---------- 生成档位：文生图 / 单图编辑 / 多图编辑 ----------


def text_slots() -> list[dict]:
    """543 是这台工作流唯一的参考位，582 从 540 取提示词。"""
    return slots()


async def test_no_reference_is_text_mode_and_removes_every_load_image(fake, source_image, init_db):
    """一张参考图都不给＝文生图：参考节点整台摘掉，一张都不上传。"""
    tpl = template()
    await start(tpl["id"], source_image, references=[])
    state = await finish()
    assert state["state"] == "done", state
    sent = fake.prompts[0]["prompt"]
    assert "543" not in sent and "564" not in sent
    assert "images" not in sent["582"]["inputs"]
    assert fake.uploads == []                                 # 一张参考图都不上传
    assert sent["582"]["inputs"]["prompt"] == "一套新的提示词"


async def test_one_reference_drops_the_load_image_it_is_not_given(fake, source_image, init_db):
    """只喂一张图时，另一台没喂图的 LoadImage 要一起摘掉。

    留着它，ComfyUI 会拿工作流里那张旧图一起编辑——弹窗里看到的是 1 张参考，
    实际喂了 2 张。这种「偷偷多用了一张」比直接报错糟糕得多。
    """
    tpl = template()
    await start(tpl["id"], source_image, references=[{"slot": "543.image", "image_id": source_image}])
    state = await finish()
    assert state["state"] == "done", state
    sent = fake.prompts[0]["prompt"]
    assert "564" not in sent and "images.image_2" not in sent["582"]["inputs"]
    assert len(fake.uploads) == 1


async def test_two_references_are_a_multi_edit_and_keep_both(fake, source_image, init_db):
    tpl = template()
    await start(tpl["id"], source_image, references=[
        {"slot": "543.image", "image_id": source_image},
        {"slot": "564.image", "image_id": source_image},
    ])
    state = await finish()
    assert state["state"] == "done", state
    assert len(fake.uploads) == 2
    sent = fake.prompts[0]["prompt"]
    assert sent["543"]["inputs"]["image"] == f"seekx/{fake.uploads[0]}"
    assert sent["564"]["inputs"]["image"] == f"seekx/{fake.uploads[1]}"


async def test_references_must_start_at_the_first_cell(fake, source_image, init_db):
    """图片1 空着、图片2 有图＝不行：参考图的序号就是接线顺序，不能跳着填。"""
    tpl = template()
    with pytest.raises(ValueError, match="图片1"):
        clone_jobs.plan_request(template_id=tpl["id"],
                                references=[{"slot": "564.image", "image_id": source_image}],
                                controls=None)


async def test_the_same_slot_twice_is_refused(fake, source_image, init_db):
    tpl = template()
    with pytest.raises(ValueError, match="两遍"):
        clone_jobs.plan_request(template_id=tpl["id"], references=[
            {"slot": "543.image", "image_id": source_image},
            {"slot": "543.image", "image_id": source_image}], controls=None)


# ---------- 失败与并发 ----------


async def test_comfyui_not_running_is_reported_before_any_upload(fake, source_image, init_db):
    fake.running = False
    tpl = template()
    with pytest.raises(clone_jobs.CloneUnavailable):
        await start(tpl["id"], source_image)
    assert fake.uploads == []


async def test_node_errors_name_the_failing_node(fake, source_image, init_db):
    fake.node_errors = {"558": {"errors": [{"message": "No such node", "details": "SamplerCustom"}]}}
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert state["state"] == "error"
    assert "采样器" in state["error"] and "No such node" in state["error"]


async def test_execution_error_in_history_is_surfaced(fake, source_image, init_db):
    fake.status_str = "error"
    fake.messages = [["execution_error", {"node_id": 558, "exception_message": "CUDA out of memory"}]]
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert state["state"] == "error" and "CUDA out of memory" in state["error"]


async def test_workflow_without_save_node_fails_loudly(fake, source_image, init_db):
    fake.outputs = {"601": {"images": [{"filename": "p.png", "type": "temp"}]}}
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert state["state"] == "error" and "保存图像" in state["error"]


async def test_timeout_interrupts_and_clears_the_queue(fake, source_image, init_db, monkeypatch):
    monkeypatch.setattr(clone_jobs, "POLL_TIMEOUT", 0.01)
    fake.history_left = 10_000
    tpl = template()
    await start(tpl["id"], source_image)
    state = await finish()
    assert state["state"] == "error" and "还没出结果" in state["error"]
    assert fake.interrupts == 1
    assert fake.deleted == [["pid-1"]]


async def test_second_request_is_rejected_while_one_is_running(fake, source_image, init_db):
    fake.history_left = 10_000
    tpl = template()
    await start(tpl["id"], source_image)
    with pytest.raises(clone_jobs.CloneBusy):
        await start(tpl["id"], source_image)
    state = await clone_jobs.cancel()
    assert state["state"] == "cancelled"
    await finish()
    assert clone_jobs.public_state()["state"] == "cancelled"   # 取消不该被改写成生成失败


async def test_cancel_before_the_task_runs_never_queues(fake, source_image, init_db):
    """取消落在任务被调度起来之前：状态不能被后面的阶段改写，更不能真去排队。"""
    fake.history_left = 10_000
    tpl = template()
    await start(tpl["id"], source_image)
    await clone_jobs.cancel()
    await finish()
    assert fake.prompts == []
    assert clone_jobs.public_state()["state"] == "cancelled"


async def test_cancel_right_after_queueing_clears_the_queue(fake, source_image, init_db):
    fake.history_left = 10_000
    tpl = template()
    task = None
    await start(tpl["id"], source_image)
    await asyncio.sleep(0)  # 让任务跑到 /history 轮询之前
    task = clone_jobs._task
    await clone_jobs.cancel()
    await finish()
    assert clone_jobs.public_state()["state"] == "cancelled"
    assert fake.interrupts >= 1


async def test_missing_reference_or_unknown_slot_is_rejected_before_queueing(fake, source_image, init_db):
    tpl = template()
    with pytest.raises(ValueError):
        clone_jobs.plan_request(template_id=tpl["id"], references=[{"slot": "999.image", "image_id": source_image}], controls=None)
    with pytest.raises(ValueError):
        clone_jobs.plan_request(template_id=tpl["id"], references=[{"slot": "543.image", "image_id": source_image}], controls={"582.prompt": "x"})
    assert fake.prompts == []


async def test_reference_of_the_wrong_family_is_refused_before_upload(
    fake, source_image, init_db, tmp_path
):
    """图库里的视频塞进图片参考位：提交前就说是哪一格，别先把文件推给 ComfyUI
    再甩回一句 LoadAudio/LoadImage 读不了——那种报错用户读不出是自己拖错了格子。"""
    video = tmp_path / "片子.mp4"
    video.write_bytes(b"\x00" * 32)
    payload = Indexer()._process_path_sync(video)
    tpl = template()
    with pytest.raises(ValueError) as exc:
        await start(tpl["id"], int(payload["id"]))
    assert "图片1" in str(exc.value) and "视频" in str(exc.value)
    assert fake.uploads == []          # 一个字节都没往外推
    assert clone_jobs.public_state()["active"] is False


async def test_upload_guard_still_checks_kind_and_container(init_db, tmp_path):
    """上传这一步的守卫不能被上面的前置校验顶掉：直接喂错族/错容器照样得拦住。"""

    def make(kind: str, name: str):
        path = tmp_path / name
        path.write_bytes(b"\x00" * 32)
        return int(Indexer()._process_path_sync(path)["id"])

    video_id = make("video", "片子.avi")
    audio_id = make("audio", "声音.mp3")

    class NoClient:
        async def upload_image(self, *a, **k):  # 不该被走到
            raise AssertionError("不该发起上传")

    with pytest.raises(ValueError) as bad_kind:
        await clone_jobs._upload_reference(NoClient(), audio_id, "image")
    assert "音频" in str(bad_kind.value)
    with pytest.raises(ValueError) as bad_suffix:
        await clone_jobs._upload_reference(NoClient(), video_id, "video")
    assert "avi" in str(bad_suffix.value) and "MP4" in str(bad_suffix.value)


async def test_missing_template_is_refused_before_anything_runs(fake, source_image, init_db):
    "校验挪到 start 里之后，模板没了会在上传参考图之前就说清楚，不会留下一个失败任务。"""
    tpl = template()
    clone_templates.delete_template(tpl["id"])
    with pytest.raises(KeyError):
        await start(tpl["id"], source_image)
    assert fake.uploads == []
    assert clone_jobs.public_state()["active"] is False


# ---------- 多图参考：弹窗里多填的那几张会克隆 LoadImage 接进图组 ----------


def multi_workflow() -> dict:
    """一台 LoadImage 长进 autogrow 图组的那种工作流（扩位靠克隆 LoadImage）。"""
    wf = workflow()
    wf.pop("564", None)
    wf["582"]["inputs"].pop("images.image_2", None)
    wf["582"]["inputs"]["images.image_1"] = ["543", 0]
    return wf


def multi_slots() -> list[dict]:
    items = [dict(s) for s in slots() if not (s["kind"] == "image" and s["node"] == "564")]
    next(s for s in items if s["kind"] == "image")["grow"] = {
        "node": "582", "group": "images", "names": ["image_2", "image_3"],
    }
    return items


async def test_extra_reference_clones_load_image_and_uploads_both(fake, source_image, init_db):
    tpl = clone_templates.create_template("多图同款", multi_workflow(), multi_slots())
    await start(tpl["id"], source_image, references=[
        {"slot": "543.image", "image_id": source_image},
        {"slot": "543.image::image_2", "image_id": source_image},
    ])
    await finish()
    assert len(fake.uploads) == 2, "两张参考图都要上传"
    prompt = fake.prompts[0]["prompt"]
    loads = [nid for nid, node in prompt.items() if node.get("class_type") == "LoadImage"]
    assert len(loads) == 2, loads
    clone_id = next(nid for nid in loads if nid != "543")
    assert prompt["543"]["inputs"]["image"].endswith(fake.uploads[0])
    assert prompt[clone_id]["inputs"]["image"].endswith(fake.uploads[1])
    assert prompt["582"]["inputs"]["images.image_2"] == [clone_id, 0]


def test_grown_cells_are_optional_but_unknown_ones_are_rejected(fake, source_image, init_db):
    tpl = clone_templates.create_template("多图同款", multi_workflow(), multi_slots())
    # 只交一张：续位空着不该报错，多一张是加分项不是必填
    clone_jobs.plan_request(template_id=tpl["id"], references=[{"slot": "543.image", "image_id": source_image}], controls=None)
    clone_jobs.plan_request(template_id=tpl["id"], references=[
        {"slot": "543.image", "image_id": source_image},
        {"slot": "543.image::image_2", "image_id": source_image},
    ], controls=None)
    # 但工作流没空出第九格，就不能凭一个编出来的键把图塞进去
    with pytest.raises(ValueError, match="参考位"):
        clone_jobs.plan_request(template_id=tpl["id"], references=[{"slot": "543.image::image_9", "image_id": source_image}], controls=None)
    assert fake.prompts == []


# ---------- 来源记录：生成完的图要能说出自己当初喂了哪几张参考图 ----------


async def test_finished_run_records_its_references_in_cell_order(fake, source_image, init_db, tmp_path):
    """两张不同的参考图跑完之后，产出图要能原样读回那两张，顺序＝参考位顺序。

    这条是「点产出图的一键同款，参考位该摆两张」的数据来源。以前出完就忘，
    弹窗再打开只会把被点的这张图当唯一参考，多图编辑的工作流被降级成单图。
    """
    second = int(Indexer()._process_path_sync(make_png(tmp_path / "背景图.png", width=7, height=7))["id"])
    tpl = template()
    await start(tpl["id"], source_image, references=[
        {"slot": "543.image", "image_id": source_image},
        {"slot": "564.image", "image_id": second},
    ])
    state = await finish()
    produced = state["image_ids"][0]
    out = clone_sources.lookup(produced)
    assert [r["id"] for r in out["references"]] == [source_image, second]
    assert [r["slot"] for r in out["references"]] == ["543.image", "564.image"]
    assert out["dropped"] == 0 and out["template_id"] == tpl["id"] and out["source_image_id"] == source_image


async def test_text_mode_run_records_nothing_and_does_not_break(fake, source_image, init_db):
    """文生图（一张参考都不喂）没有来源可记：安静跳过，别把成功的出图说成失败。"""
    tpl = template()
    await start(tpl["id"], source_image, references=[])
    state = await finish()
    assert state["state"] == "done", state
    assert clone_sources.lookup(state["image_ids"][0])["references"] == []


async def test_a_run_that_fails_records_no_source(fake, source_image, init_db):
    """生成失败就不该留下来源：否则下次弹窗摆出一张其实没喂过的参考图。"""
    fake.running = False
    with pytest.raises(clone_jobs.CloneUnavailable):
        await start(template()["id"], source_image)
    assert get_pool().main().execute("SELECT COUNT(*) c FROM clone_sources").fetchone()["c"] == 0
