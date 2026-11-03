"""一键同款的云端那条路：假 RunningHub 跑完整链，外加花钱边界与取回语义。

和生成链路测试同一条纪律：任何云端请求都被 httpx.MockTransport 截住，
测试绝不会拿开发者自己的账号在 RunningHub 上排队扣钱。

这里钉的事按「钱」与「东西」排：
1. 花钱之前的闸（开关、账号、上限）必须在请求发出去之前拦住；
2. 花的钱要记在账上（余额差值，不是自己乘的单价）；
3. 付过钱的东西必须能落到图库里，一时落不下的永远留着一条「取回结果」的路。
"""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import clone_jobs, clone_sources, clone_templates
from app.cloud import accounts as cloud_accounts
from app.cloud import engine as cloud_engine
from app.cloud import spec as cloud_spec
from app.cloud import tasks as cloud_tasks
from app.cloud import templates as cloud_rows
from app.config import load_config, save_config
from app.db import get_pool, transaction
from app.indexer import Indexer
from app.main import app as fastapi_app

from .conftest import make_png

REAL_SLEEP = asyncio.sleep
HUB = "https://hub.test"
SECRET = "sk-cloudsentinel-77aa"


class FakeHub:
    """最小可用的 RunningHub：上传换签名 URL、提交给任务号、查询回结果。"""

    def __init__(self) -> None:
        self.uploads: list[str] = []
        self.bodies: list[dict] = []
        self.paths: list[str] = []
        self.running_left = 0            # 前 N 次 query 回 RUNNING
        self.coins = 100.0
        self.coins_after_submit = 88.0  # 提交这一条花掉 12
        self.query_status = "SUCCESS"
        self.query_code = ""
        self.submit_status = 200
        self.submit_code = 0
        self.download_status = 200
        self.results = [{"url": f"{HUB}/signed/out-1.png", "outputType": "png"}]
        self.price_coins = 12.0
        self.png = b""
        self.balance_calls = 0

    # ---- 各端点 ----

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.paths.append(f"{request.method} {path}")
        if request.method == "GET":
            if self.download_status >= 400:
                return httpx.Response(self.download_status, json={"error": "expired"})
            return httpx.Response(200, content=self.png, headers={"content-type": "image/png"})
        # 上传那一发是 multipart，正文里有 PNG 字节，不能当 JSON 读
        if self.submit_status >= 400:
            # key 坏了不会只在一个端点上失败：每一条鉴权的路都得回 401
            return httpx.Response(self.submit_status,
                                  json={"code": self.submit_code or self.submit_status,
                                        "message": "unauthorized"})
        body = {} if path == "/openapi/v2/media/upload/binary" else (
            json.loads(request.content) if request.content else {})
        if path == "/openapi/v2/media/upload/binary":
            match = re.search(rb'filename="([^"]+)"', request.content)
            self.uploads.append(match.group(1).decode() if match else "?")
            index = len(self.uploads)
            return httpx.Response(200, json={"code": 0, "data": {
                "type": "input", "fileName": self.uploads[-1],
                "download_url": f"{HUB}/signed/ref-{index}.png?q-sign-time=1"}})
        if path == "/uc/openapi/accountStatus":
            self.balance_calls += 1
            return httpx.Response(200, json={"code": 0, "data": {
                "remainCoins": self.coins, "currentTaskCounts": 0}})
        if path.startswith("/openapi/v2/price-preview/"):
            self.bodies.append({"_price_for": path, **body})
            return httpx.Response(200, json={"code": 0, "data": {"coins": self.price_coins}})
        if path == "/openapi/v2/query":
            if self.running_left > 0:
                self.running_left -= 1
                return httpx.Response(200, json={"code": 0, "data": {
                    "taskId": "task-77", "taskStatus": "RUNNING"}})
            data = {"taskId": "task-77", "taskStatus": self.query_status}
            if self.query_status == "SUCCESS":
                data["results"] = self.results
            else:
                data["errorCode"] = self.query_code or "810"
                data["errorMessage"] = "素材读不了"
            return httpx.Response(200, json={"code": 0, "data": data})
        # 剩下的都是模型提交
        self.bodies.append({"_path": path, **body})
        if self.submit_status >= 400:
            return httpx.Response(self.submit_status, json={"code": self.submit_code,
                                                            "message": "unauthorized"})
        self.coins = self.coins_after_submit
        return httpx.Response(200, json={"code": 0, "data": {
            "taskId": "task-77", "taskStatus": "RUNNING"}})

    # ---- 便捷断言 ----

    def submitted(self) -> dict:
        return next(b for b in self.bodies if "_path" in b)

    def submits(self) -> list[dict]:
        return [b for b in self.bodies if "_path" in b]


@pytest.fixture(autouse=True)
def _cloud_rows_on(monkeypatch):
    """这个文件测的就是那三条快捷方式，把 conftest 关掉的种子打开。"""
    monkeypatch.setenv("SUXING_SEED_CLOUD_TEMPLATES", "1")


@pytest.fixture
def hub(monkeypatch, init_db, tmp_path):
    """干净的库 + 没设花费上限 + 假服务商 + 轮询不真等。"""
    from app.config import config_path

    config_path().write_text(json.dumps({}), encoding="utf-8")
    server = FakeHub()
    server.png = make_png(tmp_path / "产物.png", width=6, height=6).read_bytes()
    transport = httpx.MockTransport(server.handler)
    real = cloud_engine.RunningHubClient

    def make(base_url, api_key, **kwargs):
        kwargs.setdefault("transport", transport)
        return real(base_url, api_key, **kwargs)

    monkeypatch.setattr(cloud_engine, "RunningHubClient", make)
    # 轮询真的等 2 秒没意义，但要留给事件循环：否则取消/并发的用例测不到真实交错
    async def fast(_delay):
        await REAL_SLEEP(0.005)
    import app.cloud.client as cloud_client
    monkeypatch.setattr(cloud_client, "asyncio", SimpleNamespace(sleep=fast))
    clone_jobs.reset_for_tests()
    cloud_tasks.reset_for_tests()
    yield server
    task = clone_jobs._task
    if task and not task.done():
        task.cancel()
    clone_jobs.reset_for_tests()


@pytest.fixture
def account(hub):
    return cloud_accounts.save_account({"name": "我的账号", "api_key": SECRET})


@pytest.fixture
def source_image(init_db, tmp_path) -> int:
    path = make_png(tmp_path / "源图.png", width=8, height=8)
    payload = Indexer()._process_path_sync(path)
    assert payload
    return int(payload["id"])


def cloud_template(kind: str) -> dict:
    rows = [t for t in clone_templates.list_templates() if t.get("is_cloud")]
    wanted = next((t for t in rows if t["media_kind"] == kind), None)
    assert wanted, f"没种出 {kind} 族的云端快捷方式"
    return wanted


async def finish() -> dict:
    task = clone_jobs._task
    assert task is not None
    await asyncio.wait_for(task, 5)
    return clone_jobs.public_state()


async def run(kind: str, **kwargs) -> dict:
    tpl = cloud_template(kind)
    await clone_jobs.start(template_id=tpl["id"],
                           prompt=kwargs.pop("prompt", "把这套视觉搬过来"),
                           references=kwargs.pop("references", []),
                           controls=kwargs.pop("controls", None),
                           source_image_id=kwargs.pop("source_image_id", None))
    return await finish()


# ---------- 那三条快捷方式 ----------


def test_three_rows_are_seeded_once(init_db):
    rows = [t for t in clone_templates.list_templates() if t.get("is_cloud")]
    assert [(t["name"], t["media_kind"]) for t in rows] == [
        ("图片API", "image"), ("视频API", "video"), ("音频API", "audio")]
    for row in rows:
        assert row["engine"] == "cloud" and row["provider"] == "runninghub"
        assert row["slots"] and row["default_controls"]
    # 自动种子只跑一次；显式 sync 幂等，跑几次都不会多长一份
    assert cloud_rows.seed_once()["skipped"] is True
    again = cloud_rows.sync()
    assert again["created"] == []
    assert sorted(again["updated"]) == sorted(["图片API", "视频API", "音频API"])
    assert len([t for t in clone_templates.list_templates() if t.get("is_cloud")]) == 3


def make_local(name: str, kind: str, node: str = "13") -> dict:
    """本机那条配方：至少要有一个能写提示词的文本输入，否则建不出来（后端要求的）。"""
    return clone_templates.create_template(
        name, {node: {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "旧提示词"}}},
        [{"kind": "prompt", "node": node, "input": "value",
          "label": clone_templates.PRIMARY_PROMPT_LABEL}], kind)


def test_seeding_never_becomes_the_current_workflow(init_db):
    """把一条要花钱的通道设成默认，等于替用户做了一个他没做过的决定。

    所以种子永远不抢「当前」：本机那条在用时不换；一族里只有云端那条时也不抢，
    想要它当默认，得在切换清单里自己点一次。
    """
    local = make_local("闪寻图片", "image")
    assert local["is_active"] is True
    cloud_rows.sync()
    assert clone_templates.get_template(int(local["id"]))["is_active"]
    rows = {t["name"]: t for t in clone_templates.list_templates() if t.get("is_cloud")}
    assert [r["is_active"] for r in rows.values()] == [False, False, False]


def test_only_cloud_row_still_does_not_become_default(init_db):
    assert [t["is_active"] for t in clone_templates.list_templates()] == [False, False, False]


def test_cloud_row_sits_right_after_its_family(init_db):
    """清单顺序：本机在前、云端紧跟同族，一族不能被来源切成两半。"""
    make_local("闪寻视频", "video", "9")
    names = [t["name"] for t in clone_templates.list_templates()]
    assert names.count("视频API") == 1
    # 同族的本机在前、云端紧跟其后
    assert names.index("闪寻视频") + 1 == names.index("视频API")
    # 没有本机配方的族，云端那条落在清单末尾，族之间仍按 图/视/音 的顺序
    assert [n for n in names if n.endswith("API")] == ["视频API", "图片API", "音频API"]


def test_deleted_cloud_row_stays_deleted_and_can_be_restored(init_db):
    row = cloud_template("image")
    clone_templates.delete_template(int(row["id"]))
    assert cloud_rows.seed_once()["skipped"] is True      # 删了就是不想看见，别长回来
    assert [t for t in clone_templates.list_templates() if t["name"] == "图片API"] == []
    out = cloud_rows.sync()                               # 显式恢复
    assert out["created"] == ["图片API"]


def test_cloud_prompt_label_and_tags_come_from_the_backend(init_db):
    """@ 引用与主输入框标签由后端一处算准：前端自己算就会在 Seedance 上写错语法。"""
    image = cloud_template("image")
    assert image["slots"][0]["label"] == clone_templates.PRIMARY_PROMPT_LABEL
    assert [c["tag"] for c in image["reference_cells"]] == ["图1", "图2", "图3", "图4"]
    video = cloud_template("video")
    tags = [c["tag"] for c in video["reference_cells"]]
    assert "@Image 1" in tags and "@Video 1" in tags and "@Audio 1" in tags
    audio = cloud_template("audio")
    assert [c["tag"] for c in audio["reference_cells"]] == [""]
    assert audio["cloud"]["mentions"] is False



# ---------- 全链：花钱与落盘 ----------


def ref_args(template: dict, count: int, source_image: int, kind: str = "image") -> list[dict]:
    keys = [c["key"] for c in template["reference_cells"] if c["kind"] == kind]
    return [{"slot": keys[i], "image_id": source_image} for i in range(min(count, len(keys)))]


async def test_full_cloud_image_run_pays_downloads_and_books_it(hub, account, source_image):
    """一次出图：上传换签名 URL → 提交 → 轮询 → 下载落盘 → 收进图库 → 记来源与花费。"""
    tpl = cloud_template("image")
    await clone_jobs.start(template_id=tpl["id"], prompt="把这套视觉搬过来",
                           references=ref_args(tpl, 1, source_image),
                           controls={"model.ratio": "9:16", "model.quality": "2K"},
                           source_image_id=source_image)
    state = await finish()
    assert state["state"] == "done", state
    assert state["engine"] == "cloud" and state["model"] == "image"
    assert len(state["image_ids"]) == 1 and len(state["outputs"]) == 1
    image_id = state["image_ids"][0]

    # 1) 上传：文件名带图库 id 与内容指纹，同一份素材重传一眼就看得出来
    assert hub.uploads and hub.uploads[0].startswith(f"seekx_ref_{source_image}_")
    # 2) 请求体：控件键已从「model.ratio」翻回声明里的参数名，比例+画质换成宽高
    body = hub.submitted()
    assert body["_path"] == "/openapi/v2/seedream-v5-lite/image-to-image"
    assert body["prompt"] == "把这套视觉搬过来"
    assert body["imageUrls"] == [f"{HUB}/signed/ref-1.png?q-sign-time=1"]
    assert (body["width"], body["height"]) == (1152, 2048)
    assert "ratio" not in body and "quality" not in body

    # 3) 落盘：SeekX-Data/generated/image/<日期>/seekx_image_…，并挂上来源目录节点
    row = get_pool().main().execute("SELECT path, filename FROM images WHERE id=?",
                                    (image_id,)).fetchone()
    path = Path(row["path"])
    assert path.parent.parent.name == "image" and path.parent.parent.parent.name == "generated"
    assert path.name.startswith(f"seekx_image_task-77_1_") and path.suffix == ".png"
    mounted = get_pool().main().execute(
        "SELECT 1 FROM image_folders if_ JOIN folders f ON f.id=if_.folder_id "
        "WHERE if_.image_id=? AND f.path LIKE '%generated%'", (image_id,)).fetchone()
    assert mounted, "云端产物没挂进侧栏的来源目录，用户在侧栏里找不到它"

    # 4) 来源：下次点开这张图，能看见当初喂了哪份素材、说了哪句话
    src = clone_sources.lookup(image_id)
    assert src["origin"] == "db" and src["prompt"] == "把这套视觉搬过来"
    assert [r["id"] for r in src["references"]] == [source_image]

    # 5) 账：花费取余额差值（100 → 88），不是自己乘的单价
    task = cloud_tasks.recent(1)[0]
    assert task["state"] == "done" and task["remote_task_id"] == "task-77"
    assert task["cost_coins"] == pytest.approx(12.0)
    assert task["image_ids"] == [image_id]
    assert state["cost_coins"] == pytest.approx(12.0)
    # 「取回结果」要的是本地账本的行 id。它和云端任务号都叫 task_id 时，
    # 点一次按钮就是拿云端号来查本地账本，永远 404（见 test_progress_…）。
    assert state["task_row_id"] == task["id"]
    assert cloud_tasks.spend_today_coins() == pytest.approx(12.0)


async def test_multiple_references_keep_their_declared_order(hub, account, source_image):
    """@Image 的编号来自参考格顺序：顺序错了参考不生效而且不报错，是全项目最贵的一种错。"""
    tpl = cloud_template("image")
    await clone_jobs.start(template_id=tpl["id"], prompt="两张图合成一张",
                           references=ref_args(tpl, 3, source_image), controls={},
                           source_image_id=source_image)
    state = await finish()
    assert state["state"] == "done", state
    assert len(hub.uploads) == 3
    assert hub.submitted()["imageUrls"] == [f"{HUB}/signed/ref-{i}.png?q-sign-time=1"
                                            for i in (1, 2, 3)]


async def test_tts_run_sends_text_and_lands_in_audio_folder(hub, account, monkeypatch):
    """音频那条：字段叫 text，产物落 generated/audio/，收尾仍走同一套入库认领。

    这里把 _register_output 换成假 id：索引一段真音频要 ffprobe，与这条要钉的事无关。
    """
    seen: list[Path] = []
    real = clone_jobs._register_output

    def fake_register(path):
        seen.append(Path(path))
        return 4242

    monkeypatch.setattr(clone_jobs, "_register_output", fake_register)
    hub.results = [{"url": f"{HUB}/signed/voice.mp3", "outputType": "mp3"}]
    tpl = cloud_template("audio")
    await clone_jobs.start(template_id=tpl["id"], prompt="这段是要念的台词",
                           references=[], controls={"model.voice_id": "Elegant_Man",
                                                    "model.speed": 1.1},
                           source_image_id=None)
    state = await finish()
    assert state["state"] == "done", state
    body = hub.submitted()
    assert body["_path"].endswith("text-to-audio/speech-2.8-hd")
    assert body["text"] == "这段是要念的台词" and "prompt" not in body
    assert body["voice_id"] == "Elegant_Man" and body["speed"] == 1.1
    assert seen and seen[0].parent.parent.name == "audio" and seen[0].name.startswith("seekx_audio_")
    assert state["outputs"][0]["id"] == 4242


async def test_cloud_runs_without_comfyui(hub, account, source_image):
    """ComfyUI 没开着也能出图——这正是接云端最要紧的那个场景。"""
    from app.config import config_path

    config_path().write_text(json.dumps({"comfyui_enabled": False}), encoding="utf-8")
    state = await run("image", references=ref_args(cloud_template("image"), 1, source_image),
                      controls=None)
    assert state["state"] == "done", state


# ---------- 花钱之前的闸 ----------


async def test_single_limit_stops_before_any_request(hub, account, source_image):
    """超过单次上限就一分钱都不该花：请求根本没发出去才算数。"""
    cfg = load_config()
    cfg.update(cloud_max_single_coins=5)
    save_config(cfg)
    tpl = cloud_template("image")
    with pytest.raises(clone_jobs.CloneUnavailable) as boom:
        await clone_jobs.start(template_id=tpl["id"], prompt="贵的一条",
                               references=ref_args(tpl, 1, source_image), controls={},
                               source_image_id=source_image)
    assert "单次上限" in str(boom.value)
    assert hub.submits() == []
    assert cloud_tasks.recent() == []


async def test_daily_limit_stops_the_next_one(hub, account, source_image):
    cfg = load_config()
    cfg.update(cloud_max_daily_coins=50)
    save_config(cfg)
    cloud_tasks.start(job_id="old", spec_key="image", capability="image", model="image",
                      params={})
    with transaction() as conn:
        conn.execute("UPDATE gen_tasks SET cost_coins=60 WHERE id=(SELECT MAX(id) FROM gen_tasks)")
    tpl = cloud_template("image")
    with pytest.raises(clone_jobs.CloneUnavailable) as boom:
        await clone_jobs.start(template_id=tpl["id"], prompt="今天已经花够了",
                               references=[], controls={}, source_image_id=None)
    assert "当日上限" in str(boom.value)
    assert hub.submits() == []


@pytest.mark.parametrize("mutate,phrase", [
    ("no_account", "还没有可用"),
    ("no_key", "还没有填 API Key"),
])
async def test_unavailable_says_which_step_is_missing(hub, mutate, phrase, account, source_image):
    """弹窗里那条置灰必须说清差哪一步，不能只说「不可用」。"""
    if mutate == "no_account":
        for row in cloud_accounts.list_accounts():
            cloud_accounts.delete_account(int(row["id"]))
    else:
        cloud_accounts.save_account({"api_key": ""}, int(account["id"]))
    reason = cloud_engine.availability()
    assert reason["available"] is False and phrase in reason["reason"]
    tpl = cloud_template("image")
    with pytest.raises(clone_jobs.CloneUnavailable) as boom:
        await clone_jobs.start(template_id=tpl["id"], prompt="想花钱", references=[],
                               controls={}, source_image_id=None)
    assert phrase in str(boom.value)
    assert hub.submits() == []


async def test_a_leftover_master_switch_cannot_gate_anything(hub, account):
    """老 config.json 里残留的 cloud_enabled 不许还能拦住云端。

    这个字段跟着设置页那张卡一起删了，load_config 把它当未知字段丢掉。留这一条是给
    下一次看的：别再往可用性判断里塞默认关着的开关——界面没有开关的闸门就是死路。
    """
    from app.config import config_path

    config_path().write_text(json.dumps({"cloud_enabled": False}), encoding="utf-8")
    assert cloud_engine.availability()["available"] is True


# ---------- 云端说「不行」的时候 ----------


async def test_bad_key_fails_with_a_readable_reason_and_no_task_row(hub, account, source_image):
    """鉴权失败：说人话，并且账本里不该留一条「还在跑」的任务。"""
    hub.submit_status, hub.submit_code = 401, 401
    state = await run("image", references=ref_args(cloud_template("image"), 1, source_image))
    assert state["state"] == "error" and "API Key" in state["error"]
    assert state["recoverable"] is False
    rows = cloud_tasks.recent()
    assert len(rows) == 1 and rows[0]["state"] == "failed"


async def test_refetch_recovers_a_task_the_cloud_had_reported_failed(hub, account, source_image):
    """云端先说失败、链接事后又能下：取回就行，不重新生成也不二次扣费。"""
    hub.query_status = "FAILED"
    tpl = cloud_template("image")
    await clone_jobs.start(template_id=tpl["id"], prompt="先失败的一条",
                           references=ref_args(tpl, 1, source_image), controls={},
                           source_image_id=source_image)
    state = await finish()
    assert state["state"] == "error" and state["recoverable"] is True
    task = cloud_tasks.recent(1)[0]
    assert task["state"] == "lost" and task["remote_task_id"] == "task-77"
    assert [t["id"] for t in cloud_engine.pending_tasks()] == [task["id"]]

    # 云端那条链接当时没好、事后又能下了：只重新查一次就取回来
    hub.query_status = "SUCCESS"
    got = await clone_jobs.refetch(int(task["id"]))
    assert got["count"] == 1
    assert cloud_tasks.get(int(task["id"]))["state"] == "done"
    src = clone_sources.lookup(got["image_ids"][0])
    assert src["prompt"] == "先失败的一条"
    assert cloud_engine.pending_tasks() == []


async def test_refetch_never_submits_the_job_again(hub, account, source_image):
    hub.query_status = "FAILED"
    await run("image", references=ref_args(cloud_template("image"), 1, source_image))
    hub.query_status = "SUCCESS"
    task = cloud_tasks.recent(1)[0]
    submits_before = len(hub.submits())
    await clone_jobs.refetch(int(task["id"]))
    assert len(hub.submits()) == submits_before     # 一次都没重新提交


# ---------- 停止等待 / 重启 ----------


async def test_cancel_stops_waiting_but_products_still_land(hub, account, source_image):
    """云端点「停止」退不回钱：后台继续等到底，把已经付过钱的东西收进图库。"""
    hub.running_left = 400
    tpl = cloud_template("image")
    await clone_jobs.start(template_id=tpl["id"], prompt="等不及了",
                           references=ref_args(tpl, 1, source_image), controls={},
                           source_image_id=source_image)
    await REAL_SLEEP(0.05)
    mid = await clone_jobs.cancel()
    assert mid["state"] == "cancelled"
    # 已经付过钱了，只是不再盯着跑：recoverable 必须为真，
    # 否则前端那句「云端仍在跑，点取回结果」永远出不来。
    assert mid["recoverable"] is True
    assert mid["task_row_id"]
    hub.running_left = 0
    state = await finish()
    assert state["state"] == "done" and state["image_ids"]
    assert "停止过等待" in state["message"]


async def test_progress_carries_the_row_id_the_refetch_button_needs(hub, account, source_image):
    """进度里那两个 id 不是一回事：task_id 是云端的任务号，task_row_id 是本地账本的行号。

    前端拿后者调 /cloud/tasks/{id}/refetch。少带这一个字段，「取回结果」就点不动；
    带错了（把云端号当行号）则是 404，用户只会看到一句「找不到这条云端任务」。
    """
    hub.running_left = 400
    tpl = cloud_template("image")
    started = await clone_jobs.start(template_id=tpl["id"], prompt="还在跑",
                                     references=ref_args(tpl, 1, source_image), controls={},
                                     source_image_id=source_image)
    assert started["engine"] == "cloud"
    assert started["task_id"] == ""          # 还没提交出去，云端那边还没有号
    row = cloud_tasks.get(started["task_row_id"])
    assert row is not None and row["job_id"] == started["job_id"]
    await clone_jobs.cancel()
    hub.running_left = 0
    await finish()


async def test_resume_takes_back_what_finished_while_the_app_was_closed(hub, account, source_image):
    """关掉应用再打开：云端跑完了的立刻取回，还没跑完的标成待取回。"""
    hub.running_left = 0
    task_id = cloud_tasks.start(job_id="ghost", spec_key="image", capability="image",
                                model="image", params={"template_id": 1, "prompt": "关机前那条",
                                                       "references": [], "controls": {},
                                                       "slot_prompts": {}})
    cloud_tasks.update(task_id, state="running", remote_task_id="task-77")
    result = await clone_jobs.resume_cloud_tasks()
    assert result["recovered"] == 1 and result["waiting"] == 0
    assert cloud_tasks.get(task_id)["state"] == "done"
    assert clone_sources.lookup(cloud_tasks.get(task_id)["image_ids"][0])["prompt"] == "关机前那条"


async def test_resume_keeps_an_unfinished_task_visible(hub, account):
    hub.running_left = 5
    task_id = cloud_tasks.start(job_id="ghost", spec_key="video", capability="video",
                               model="video", params={})
    cloud_tasks.update(task_id, state="running", remote_task_id="task-77")
    result = await clone_jobs.resume_cloud_tasks()
    assert result["waiting"] == 1
    assert cloud_tasks.get(task_id)["state"] == "lost"
    assert [t["id"] for t in cloud_engine.pending_tasks()] == [task_id]


async def test_a_task_that_never_reached_the_cloud_is_not_refetchable(hub, account):
    task_id = cloud_tasks.start(job_id="ghost", spec_key="image", capability="image",
                                model="image", params={})
    result = await clone_jobs.resume_cloud_tasks()
    assert result == {"recovered": 0, "waiting": 0}
    assert cloud_tasks.get(task_id)["state"] == "failed"


# ---------- HTTP 层 ----------


@pytest.fixture
def client(init_db):
    return TestClient(fastapi_app)


def test_http_status_reports_everything_the_settings_page_needs(client, hub, account):
    body = client.get("/api/clone/cloud/status").json()
    assert body["seeded"] is True and "cloud_enabled" not in body
    assert [p["capability"] for p in body["presets"]] == ["image", "video", "audio"]
    assert body["accounts"][0]["has_api_key"] is True
    assert SECRET not in json.dumps(body, ensure_ascii=False)
    assert body["availability"]["available"] is True
    assert body["pending"] == []


def test_http_settings_round_trip(client, hub):
    assert client.get("/api/clone/cloud/settings").json() == {
        "cloud_max_single_coins": 0.0, "cloud_max_daily_coins": 0.0}
    out = client.put("/api/clone/cloud/settings",
                     json={"cloud_max_single_coins": 30, "cloud_max_daily_coins": 500}).json()
    assert out == {"cloud_max_single_coins": 30.0, "cloud_max_daily_coins": 500.0}
    assert client.put("/api/clone/cloud/settings", json={"cloud_max_single_coins": -1}).status_code == 422
    # 总开关已从契约里撤走：多传这一个字段既不报错，也不起作用
    assert "cloud_enabled" not in client.put("/api/clone/cloud/settings",
                                             json={"cloud_enabled": False}).json()


def test_http_accounts_never_echo_the_key(client, hub):
    created = client.post("/api/clone/cloud/accounts",
                          json={"name": "HTTP 建的", "api_key": SECRET})
    assert created.status_code == 201
    body = created.json()
    assert body["has_api_key"] is True and SECRET not in created.text
    patched = client.patch(f"/api/clone/cloud/accounts/{body['id']}", json={"name": "改名"})
    assert patched.json()["has_api_key"] is True
    cleared = client.patch(f"/api/clone/cloud/accounts/{body['id']}", json={"api_key": ""})
    assert cleared.json()["has_api_key"] is False
    assert client.delete(f"/api/clone/cloud/accounts/{body['id']}").json()["deleted"] == body["id"]
    assert client.patch("/api/clone/cloud/accounts/9999", json={"name": "x"}).status_code == 404


def test_http_test_account_reports_balance(client, hub, account):
    out = client.post(f"/api/clone/cloud/accounts/{account['id']}/test").json()
    assert out["ok"] is True and "100" in out["message"]
    hub.submit_status = 401
    bad = client.post(f"/api/clone/cloud/accounts/{account['id']}/test").json()
    assert bad["ok"] is False and "API Key" in bad["message"]


def test_http_estimate_returns_the_official_price(client, hub, account):
    tpl = cloud_template("image")
    out = client.post("/api/clone/cloud/estimate", json={"template_id": tpl["id"],
                                                         "controls": {}}).json()
    assert out["coins"] == 12.0 and out["mode"] in ("multi", "single", "text")
    local = make_local("本机那条", "image")
    assert client.post("/api/clone/cloud/estimate",
                       json={"template_id": local["id"]}).status_code == 400


def test_http_spend_and_pending_and_sync(client, hub, account):
    spend = client.get("/api/clone/cloud/spend").json()
    assert spend["counts"] == {"image": 0, "video": 0, "audio": 0}
    assert spend["today_coins"] == 0 and spend["recent"] == []
    assert client.get("/api/clone/cloud/pending").json()["items"] == []
    tpl = cloud_template("audio")
    clone_templates.delete_template(int(tpl["id"]))
    out = client.post("/api/clone/cloud/templates/sync").json()
    assert out["ok"] is True and out["created"] == ["音频API"]


def test_http_refetch_reports_a_bad_task_id(client, hub, account):
    assert client.post("/api/clone/cloud/tasks/12345/refetch").status_code == 400


# ---------- 老库升级 ----------


def test_old_database_gets_the_four_columns_and_stays_local(tmp_path, monkeypatch):
    """老库只有本机配方：补列之后必须仍然全部算本机，不能被认成云端那条要花钱的。"""
    db_file = tmp_path / "db.sqlite"
    conn = sqlite3.connect(db_file)
    conn.executescript("""
        CREATE TABLE clone_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            workflow TEXT NOT NULL, slots TEXT NOT NULL DEFAULT '[]',
            default_prompt TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 0,
            media_kind TEXT NOT NULL DEFAULT 'image', bundled_key TEXT,
            bundled_sha TEXT NOT NULL DEFAULT '',
            created_at TEXT, updated_at TEXT);
        INSERT INTO clone_templates(name, workflow, slots, is_active, media_kind)
        VALUES('老配方','{}','[]',1,'image');
    """)
    conn.commit()
    conn.close()
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config as config_module
    from app import db as db_module
    importlib.reload(config_module)
    importlib.reload(db_module)
    pool = db_module.init_pool()
    pool.initialize()
    cols = {r["name"] for r in pool.main().execute("PRAGMA table_info(clone_templates)").fetchall()}
    assert {"engine", "provider", "model", "params"} <= cols
    rows = clone_templates.list_templates()
    old = next(r for r in rows if r["name"] == "老配方")
    assert old["engine"] == "comfyui" and old["is_cloud"] is False and old["is_active"] is True
