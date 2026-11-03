"""一键同款的生成任务：单任务串行，跑在本机 ComfyUI 上。

为什么串行：本地只有一块 GPU，两个任务一起排队只会互相拖慢，还要用户分辨"哪张是
哪次生成的"。所以第二个请求直接 409 挡回去，比假装支持并发诚实。

本机那条路的进度只活在内存 + WS：出图本身就是历史，再建一张进度表除了同步负担没有收益。
云端不一样，必须落库（gen_tasks）：一条片子在云端跑十分钟，产物挂在会过期的签名链接上，
进程一重启就没人认领了——钱花了、链接过期了、东西没了，这是最容易白花钱的一处。
所以云端任务多了三件事：重启后还能说「有件事在跑」、链接过期后能重新取回、
以及「这一条到底花了多少」（余额前后差值，不是自己乘的单价）。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any

from . import clone_sources, clone_templates, repository, workflow_edit
from .cloud import engine as cloud_engine
from .cloud import tasks as cloud_tasks
from .cloud.client import RunningHubError
from .comfyui_client import ComfyUIError, ComfyUIClient
from .config import load_config
from .db import get_pool
from .events import get_bus
from .indexer import Indexer, get_indexer

log = logging.getLogger("suxing_gallery.clone")

POLL_INTERVAL = 1.5
POLL_TIMEOUT = 900.0          # 图片：15 分钟
POLL_TIMEOUT_VIDEO = 3600.0   # 视频：H3 一条片子在本地 GPU 上是十分钟级，给到 60 分钟
RUNNING_STATES = ("uploading", "queued", "running", "downloading")
# 参考素材按族放行。ComfyUI 的 /upload/image 不校验扩展名（server.py 只负责落盘），
# 所以音频和视频共用这一条上传通道；但 LoadAudio / VHS_LoadVideo 只读得动自己那几类
# 容器，在这里替用户把住关，别等节点报红才发现素材塞错了格子。
UPLOADABLE_SUFFIXES: dict[str, set[str]] = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".bmp"},  # PSD/TIF 之类先让用户转
    "audio": {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"},
    "video": {".mp4", ".mov", ".webm", ".mkv"},
}
UPLOAD_KIND_NAMES = {"image": "图片", "audio": "音频", "video": "视频"}
# VHS_VideoCombine 回的是 gifs，SaveImage 回的是 images，三类都读一遍再按文件去重。
# 单数 audio 也得读：SaveAudioAdvanced / SaveAudio / PreviewAudio 的历史里用的是
# {"audio": [...]}（真机实测），只找 audios 的话音频跑完只会得到一句「没交回产物」。
OUTPUT_HISTORY_KEYS = ("images", "gifs", "videos", "audios", "audio")

_job: dict[str, Any] | None = None
_task: asyncio.Task | None = None
_lock = asyncio.Lock()


class CloneBusy(Exception):
    """已经有一个任务在跑。"""


class CloneUnavailable(Exception):
    """ComfyUI 没在跑 / 集成被关掉。"""


# ---------- 状态 ----------


def public_state() -> dict:
    if not _job:
        return {"active": False, "running": False, "state": "", "message": "", "error": "",
                "image_ids": [], "outputs": [], "template_id": None, "source_image_id": None,
                "media_kind": "", "elapsed": 0.0, "engine": "comfyui", "provider": "",
                "model": "", "estimated_cost": None, "cost_coins": None, "task_id": "",
                "task_row_id": None, "recoverable": False}
    job = _job
    state = str(job.get("state") or "")
    return {
        "active": True,
        "job_id": job.get("job_id"),
        "state": state,
        "running": state in RUNNING_STATES,
        "message": job.get("message") or "",
        "error": job.get("error") or "",
        "image_ids": list(job.get("image_ids") or []),
        # 产出清单带 kind 与缩略图：前端不用再硬拼 /api/images/{id}/file——
        # 视频的首帧、音频的波形各有自己的地址，硬拼就是把波形当图片画。
        "outputs": [dict(o) for o in (job.get("outputs") or [])],
        "media_kind": job.get("media_kind") or "",
        "template_id": job.get("template_id"),
        "source_image_id": job.get("source_image_id"),
        "elapsed": round(time.time() - float(job.get("started_at") or time.time()), 1),
        # 下面这几样是云端加的。前端 applyCloneProgress 对缺字段必须容错——
        # 老前端配新后端、新前端配老后端都得照常画，不能因为少一个字段就白屏。
        "engine": job.get("engine") or "comfyui",
        "provider": job.get("provider") or "",
        "model": job.get("model") or "",
        "estimated_cost": job.get("estimated_cost"),
        "cost_coins": job.get("cost_coins"),
        "task_id": job.get("task_id") or "",
        # 本地那行 gen_tasks 的 id，和上面那个「云端任务号」不是一回事：
        # 「取回结果」要拿它调 /cloud/tasks/{id}/refetch。给错了对不上账。
        "task_row_id": int(job.get("cloud_task_id") or 0) or None,
        # recoverable = 云端那边可能还在跑 / 产物还能取回来，弹窗据此决定要不要给「取回结果」。
        "recoverable": bool(job.get("recoverable")),
    }


async def _set(job: dict, **changes: Any) -> None:
    if job.get("cancelled") and str(changes.get("state") or "") in RUNNING_STATES:
        # 取消已经落定：任务可能还没被调度起来，别让它再把状态推回"生成中"。
        return
    job.update(changes)
    try:
        await get_bus().publish({"type": "clone_progress", **public_state()})
    except Exception:  # noqa: BLE001
        log.warning("clone_progress publish failed", exc_info=True)


async def _publish() -> None:
    try:
        await get_bus().publish({"type": "clone_progress", **public_state()})
    except Exception:  # noqa: BLE001
        log.warning("clone_progress publish failed", exc_info=True)


def reset_for_tests() -> None:
    """测试用：清掉进程内的任务状态。"""
    global _job, _task
    _job = None
    _task = None


# ---------- 请求校验与启动 ----------


def media_kind_of(media_id: int) -> str:
    """图库里这条素材是 image / audio / video 中的哪一类，查不到给空字符串。"""
    if not media_id:
        return ""
    row = get_pool().main().execute("SELECT kind FROM images WHERE id=?", (media_id,)).fetchone()
    return str(row["kind"] or "") if row else ""


def plan_request(*, template_id: int, references: list[dict], controls: dict | None,
                 slot_prompts: dict | None = None) -> tuple[dict, str]:
    """先按模板槽位把请求校验一遍，避免把注定失败的请求丢给 ComfyUI。

    生成方式不是请求里的一个选项，是参考图数量的函数：0 张文生图、1 张单图编辑、
    2 张以上多图编辑。所以这里只做三件事——参考位存不存在、有没有跳着填、
    这份工作流撑不撑得住这个数量（文生图要看参考链摘不摘得掉）。

    抛 KeyError → 模板不存在（404）；ValueError → 参数不对（400）。
    """
    template = clone_templates.get_template(template_id)
    slots = template["slots"]
    cell_list = clone_templates.reference_cells(slots)
    cells = [c["key"] for c in cell_list]
    labels = {c["key"]: str(c["label"]) for c in cell_list}
    cell_kinds = {c["key"]: str(c["kind"]) for c in cell_list}
    given: list[str] = []
    for ref in references:
        key = str(ref.get("slot") or "")
        if key not in cells:
            raise ValueError(f"这份工作流没有叫 {key} 的参考位，关掉弹窗重开一次试试。")
        if key in given:
            raise ValueError(f"{labels.get(key, key)} 放了两遍，关掉弹窗重开一次试试。")
        given.append(key)
        # 素材类型对不对得上，提交前就得说是哪一格：把图片拖进音频位，ComfyUI 只会甩回
        # 一句 LoadAudio 读不了，用户根本猜不到是自己塞错了格子。
        want, got = cell_kinds.get(key, ""), media_kind_of(int(ref.get("image_id") or 0))
        if want and got and got != want:
            raise ValueError(f"{labels.get(key, key)} 要的是{UPLOAD_KIND_NAMES.get(want, want)}，"
                             f"你选的这份是{UPLOAD_KIND_NAMES.get(got, got)}，换一个。")
    mode = clone_templates.mode_from_count(len(given))
    clone_templates.check_mode(template, mode)
    # 每一族都要从第 1 格开始连着放（图片1 / 音频1 / 视频1）：跳着填的话弹窗里的编号
    # 和实际接线的顺序就对不上，而且空着的那格会被当成「没喂素材」摘掉，用户以为传了其实没传。
    gaps: list[str] = []
    for kind in clone_templates.REFERENCE_KINDS:
        family = [key for key in cells if cell_kinds.get(key) == kind]
        filled = {family.index(key) for key in given if key in family}
        gaps += [labels[family[i]] for i in range(max(filled) + 1 if filled else 0) if i not in filled]
    if gaps:
        raise ValueError("参考素材要从每族的第 1 格开始连着放，中间不能空着：" + "、".join(gaps))
    control_keys = {clone_templates.slot_key(s) for s in slots if s.get("kind") in ("select", "number")}
    for key in (controls or {}):
        if key not in control_keys:
            raise ValueError(f"{key} 不是这份工作流声明的控件，关掉弹窗重开一次试试。")
    # 文字位同理：多一个键就是有人在往工作流里没声明的地方塞话（主提示词之外的第二段文字，
    # 比如音色克隆的原话）。让它失败，别静默丢掉用户填的那一段。
    prompt_keys = {clone_templates.slot_key(s): str(s.get("label") or "")
                   for s in slots if s.get("kind") == "prompt"}
    for key in (slot_prompts or {}):
        if key not in prompt_keys:
            raise ValueError(f"{key} 不是这份工作流的文字位，关掉弹窗重开一次试试。")
    return template, mode


async def start(
    *,
    template_id: int,
    prompt: str,
    references: list[dict],
    controls: dict | None,
    source_image_id: int | None,
    slot_prompts: dict | None = None,
) -> dict:
    global _job, _task
    # 先按槽位校验，再管忙不忙：参数写错了就该告诉用户哪儿写错，而且换个调用方也绕不过
    template, mode = plan_request(
        template_id=template_id, references=references, controls=controls,
        slot_prompts=slot_prompts,
    )
    async with _lock:
        if _job and _job.get("state") in RUNNING_STATES:
            raise CloneBusy("已经有一键同款正在生成，等这一批出来再点。")
        cfg = load_config()
        engine = clone_templates.engine_of(template)
        cloud_task_id = 0
        estimated: float | None = None
        params_snapshot: dict[str, Any] = {}
        job_id = uuid.uuid4().hex[:12]
        if engine == "cloud":
            # 云端这条路不碰 ComfyUI：ComfyUI 没开着也能出图，这正是要紧的场景。
            status = cloud_engine.availability()
            if not status["available"]:
                raise CloneUnavailable(status["reason"])
            quote = await cloud_engine.estimate(template, mode=mode, prompt=prompt,
                                                controls=dict(controls or {}))
            estimated = (quote or {}).get("coins")
            blocked = cloud_engine.budget_check(estimated)
            if blocked:
                raise CloneUnavailable(blocked)
            params_snapshot = {
                "template_id": template_id, "mode": mode, "prompt": prompt,
                "references": [dict(ref) for ref in references],
                "slot_prompts": {str(k): str(v) for k, v in (slot_prompts or {}).items()},
                "controls": dict(controls or {}),
                "source_image_id": source_image_id,
            }
            cloud_task_id = cloud_tasks.start(
                job_id=job_id, spec_key=str(template.get("model") or ""),
                capability=str(template.get("media_kind") or "image"),
                model=str(template.get("model") or ""), params=params_snapshot,
                estimated_coins=estimated)
        else:
            if not cfg.comfyui_enabled:
                raise CloneUnavailable("ComfyUI 集成没打开，去设置 → ComfyUI 里启用。")
            probe_client = ComfyUIClient(cfg.comfyui_url)
            try:
                running = await probe_client.probe()
            finally:
                await probe_client.aclose()
            if not running:
                raise CloneUnavailable(f"连不上 ComfyUI（{cfg.comfyui_url}），先把它启动起来。")
        job = {
            "job_id": job_id,
            "state": "uploading",
            "message": "准备中…",
            "error": "",
            "image_ids": [],
            "outputs": [],
            # 弹窗与状态文案要知道这次出的是图还是片子：视频跑十分钟和出图三十秒，
            # 说「已生成 1 张」是骗人，超时报错按 15 分钟算更是把人坑在那里。
            "media_kind": str(template.get("media_kind") or "image"),
            "template_id": template_id,
            "source_image_id": source_image_id,
            "prompt": prompt,
            # 主框之外那些单独命名的文字位（音色克隆的参考原话）各填各的，
            # 没填的才跟着主提示词走——工作流里的原话不能被台词冲掉。
            "slot_prompts": {str(k): str(v) for k, v in (slot_prompts or {}).items()},
            "references": [dict(ref) for ref in references],
            "controls": dict(controls or {}),
            "mode": mode,
            "started_at": time.time(),
            "cancelled": False,
            "prompt_id": "",
            # 云端专用：跑在哪、哪条模型、账本里哪一行、预估与实际花费、远端任务号。
            "engine": engine,
            "provider": str(template.get("provider") or ""),
            "model": str(template.get("model") or ""),
            "cloud_task_id": cloud_task_id,
            "params_snapshot": params_snapshot,
            "estimated_cost": estimated,
            "cost_coins": None,
            "task_id": "",
            "recoverable": False,
        }
        _job = job
        await _publish()
        _task = asyncio.create_task(_run(job, cfg.comfyui_url))
        return public_state()


async def cancel() -> dict:
    """best-effort 中止：ComfyUI 的 interrupt 不一定立即停下当前这张图。"""
    job = _job
    if not job or job.get("state") not in RUNNING_STATES:
        return public_state()
    job["cancelled"] = True
    if str(job.get("engine") or "") == "cloud":
        # 云端这边没有「中断了就把钱退回来」这回事：请求已经进了人家的队列。
        # 所以点停止只是不再等，后台仍会轮询到底，把已经付过钱的产物收进图库——
        # 让它静默丢在一条会过期的链接上，才是真的把钱扔了。
        # recoverable 必须给 True：这一条已经付过钱了，只是不再盯着它跑。
        # 前端 cloneStatusLabel 就靠这个字段决定要不要说「云端仍在跑，点取回结果」。
        await _set(job, state="cancelled", message="已停止等待", error="", recoverable=True)
        return public_state()
    cfg = load_config()
    client = ComfyUIClient(cfg.comfyui_url)
    try:
        await client.interrupt()
        prompt_id = str(job.get("prompt_id") or "")
        if prompt_id:
            await client.delete_queue_items([prompt_id])
    finally:
        await client.aclose()
    await _set(job, state="cancelled", message="已取消生成", error="")
    return public_state()


# ---------- 执行 ----------


async def _run(job: dict, url: str) -> None:
    """按模板自带的 engine 分派。跑在哪是这条配方的属性，不是用户新学的一个开关。"""
    if str(job.get("engine") or "comfyui") == "cloud":
        await _run_cloud(job)
        return
    await _run_comfyui(job, url)


async def _run_comfyui(job: dict, url: str) -> None:
    client = ComfyUIClient(url)
    try:
        template = clone_templates.get_template(int(job["template_id"]))
        slots: list[dict] = template["slots"]

        # 一张参考素材都没有（＝纯文本生成）时别谎报「上传参考素材」，状态要说人话。
        if job["references"]:
            await _set(job, state="uploading", message="上传参考素材…")
        cell_kinds = {c["key"]: str(c["kind"]) for c in clone_templates.reference_cells(slots)}
        references: dict[str, str] = {}
        for ref in job["references"]:
            if job.get("cancelled"):
                return
            key = str(ref.get("slot") or "")
            if key not in cell_kinds:
                raise ValueError(f"这份工作流没有叫 {key} 的参考位。")
            references[key] = await _upload_reference(client, int(ref.get("image_id") or 0),
                                                      cell_kinds[key])

        # 只要有参考链要摘（包括一张都不喂的文生图），就得带 object_info 去摘，
        # 不然分不清哪个输入是必填的，会静默摘坏。全喂满时不用浪费这几十次请求。
        info = await _object_info(client, template["nodes"]) \
            if clone_templates.unused_reference_nodes(slots, references) else None
        workflow, titles = clone_templates.build_workflow(
            template["nodes"],
            slots,
            prompt=job["prompt"],
            slot_prompts=job.get("slot_prompts") or None,
            references=references,
            controls=job["controls"] or None,
            info=info,
        )

        await _set(job, state="queued", message="提交到 ComfyUI…")
        prompt_id = await client.queue(workflow, uuid.uuid4().hex, titles)
        job["prompt_id"] = prompt_id
        if job.get("cancelled"):
            # 刚提交完就被取消：这时 cancel() 还不知道 prompt_id，队列里会留着这条任务，
            # 所以由这边补一次中止 + 移出队列，不然 GPU 会白跑一张没人要的图。
            await client.interrupt()
            await client.delete_queue_items([prompt_id])
            return
        await _set(job, state="running", message="生成中…")

        outputs = await _await_outputs(client, job, prompt_id)
        if job.get("cancelled"):
            # 用户按了取消：_await_outputs 会空手回来，这里安静收尾。
            # 别再往下走「没交回图片」的报错分支，否则弹窗上「已取消」会变成「生成失败」。
            return
        await _set(job, state="downloading", message="登记生成结果…")
        ids, missing, produced = await _collect_outputs(outputs)
        if not ids and not missing:
            raise ValueError("ComfyUI 跑完了但没交回产物，检查这份工作流里有没有保存图像/视频/音频的节点。")
        kind = str(job.get("media_kind") or "")
        counter = "条" if kind in ("video", "audio") else "张"
        noun = "产物" if kind in ("video", "audio") else "图"
        message = f"已生成 {len(ids)} {counter}" if ids else f"{noun}已经在 ComfyUI 输出目录，没在图库监听目录里"
        if missing:
            message += "；没收进图库：" + "、".join(missing[:2])
        # 来源赶在「已完成」广播之前落库：前端收到 done 就可能立刻点产出图重开同款，
        # 那一刻读不到来源，弹窗又会退回复用被点的这张图当唯一参考——正是这次要修的毛病。
        await asyncio.to_thread(_record_sources, job, ids)
        await _set(job, state="done", message=message, image_ids=ids, outputs=produced)
    except asyncio.CancelledError:
        await _set(job, state="cancelled", message="已取消生成")
        raise
    except (ComfyUIError, ValueError, KeyError) as exc:
        log.warning("clone job failed: %s", exc)
        await _set(job, state="error", message="生成失败", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("clone job crashed")
        await _set(job, state="error", message="生成失败", error=f"未预期的错误：{exc}")
    finally:
        await client.aclose()


# ---------- 云端那条路 ----------


async def _cloud_set(job: dict, **changes: Any) -> None:
    """云端引擎的状态回调：顺手把远端任务号搬进 job，弹窗才说得出「云端生成中」。"""
    if "task_id" in changes:
        job["task_id"] = str(changes.pop("task_id") or "")
    await _set(job, **changes)


def _register_cloud_files(job_like: dict, files: list) -> tuple[list[int], list[dict]]:
    """把云端下回来的文件收进图库，并登记来源。收尾与本机那条路一字不差地共用。"""
    ids: list[int] = []
    produced: list[dict] = []
    for raw in files or []:
        path = Path(raw)
        image_id = _register_output(path)
        if not image_id:
            continue
        ids.append(image_id)
        cloud_engine.mount_output(path, image_id)
        produced.append(_output_summary(image_id, path.name))
    if ids:
        _record_sources(job_like or {}, ids)
    return ids, produced


def _cost_suffix(cost: float | None) -> str:
    if not cost:
        return ""
    return f" · 花 {cost:g} RH币"


async def _run_cloud(job: dict) -> None:
    """上传参考 → 提交 → 轮询 → 下载落盘 → 收进图库 → 记来源与花费。

    这里不碰 ComfyUI，也不猜产物在哪：云端的产物是响应里的链接，链接会过期，
    所以「下载」与「入库」必须挨着做完，中间不能等用户点按钮。
    """
    task_row = int(job.get("cloud_task_id") or 0)
    try:
        result = await cloud_engine.generate(job, set_state=lambda **kw: _cloud_set(job, **kw))
        job["task_id"] = str(result.get("remote_task_id") or "") or job.get("task_id", "")
        files = list(result.get("files") or [])
        cost = result.get("cost_coins")
        job["cost_coins"] = cost
        if task_row:
            cloud_tasks.update(task_row, remote_task_id=str(result.get("remote_task_id") or ""),
                               coins_before=result.get("coins_before"),
                               coins_after=result.get("coins_after"), cost_coins=cost,
                               params={**(job.get("params_snapshot") or {})})
        ids, produced = await asyncio.to_thread(_register_cloud_files, job, files)
        kind = str(job.get("media_kind") or "")
        counter = "条" if kind in ("video", "audio") else "张"
        if ids:
            base = f"已生成 {len(ids)} {counter}{_cost_suffix(cost)}"
            if job.get("cancelled"):
                # 用户按过「停止等待」：钱已经花了，云端那边还是跑完了，东西收回来了。
                # 这句必须说清楚，否则他会以为自己取消了、这些东西是凭空冒出来的。
                base = "刚才停止过等待，云端那边还是跑完了 · 已收进图库 " + \
                       f"{len(ids)} {counter}" + _cost_suffix(cost)
            if task_row:
                cloud_tasks.finish(task_row, "done", image_ids=ids)
            await _set(job, state="done", message=base, image_ids=ids, outputs=produced,
                       recoverable=False)
            return
        if task_row:
            cloud_tasks.finish(task_row, "failed", error="云端跑完了，但产物没能收进图库")
        await _set(job, state="error", message="生成失败",
                   error="云端跑完了但没交回产物，可能是这家服务商那边的问题。",
                   recoverable=bool(job.get("task_id")))
    except asyncio.CancelledError:
        if task_row:
            cloud_tasks.update(task_row, state="lost", error="应用退出或任务被打断")
        await _set(job, state="cancelled", message="已取消生成")
        raise
    except (RunningHubError, cloud_engine.CloudUnavailable, ValueError, KeyError) as exc:
        _fail_cloud_task(job, str(exc))
        log.warning("cloud clone job failed: %s", exc)
        await _set(job, state="error", message="生成失败", error=str(exc),
                   recoverable=bool(job.get("task_id")))
    except Exception as exc:  # noqa: BLE001
        _fail_cloud_task(job, f"未预期的错误：{exc}")
        log.exception("cloud clone job crashed")
        await _set(job, state="error", message="生成失败", error=f"未预期的错误：{exc}",
                   recoverable=bool(job.get("task_id")))


def _fail_cloud_task(job: dict, error: str) -> None:
    """失败也要留在账本上：有远端任务号的，标成「待取回」而不是抹掉。

    超时是最常见的一种「失败」——云端还在跑，钱已经扣，产物几分钟后就挂在链接上。
    标成 lost 而不是 failed，「取回结果」那颗按钮才有东西可点。
    """
    task_row = int(job.get("cloud_task_id") or 0)
    if not task_row:
        return
    recoverable = bool(job.get("task_id"))
    if recoverable:
        cloud_tasks.update(task_row, state="lost", error=error,
                           remote_task_id=str(job.get("task_id") or ""))
    else:
        cloud_tasks.finish(task_row, "failed", error=error)


async def refetch(task_id: int) -> dict:
    """重新取回一条云端任务的产物：只重新查一次任务，不重新生成、不二次扣费。"""
    task = cloud_tasks.get(int(task_id))
    if task is None:
        raise ValueError("找不到这条云端任务，可能已经被清掉了。")
    files = await cloud_engine.refetch(task)
    params = task.get("params") if isinstance(task.get("params"), dict) else {}
    ids, produced = await asyncio.to_thread(_register_cloud_files, params, files)
    if not ids:
        cloud_tasks.update(int(task_id), state="lost", error="产物下载下来了但没能收进图库")
        raise ValueError("产物取回来了但没能收进图库，去设置 → 模型与反推里看这条任务。")
    cloud_tasks.finish(int(task_id), "done", image_ids=ids)
    return {"task_id": int(task_id), "image_ids": ids, "outputs": produced,
            "count": len(ids), "cost_coins": task.get("cost_coins")}


async def resume_cloud_tasks() -> dict:
    """启动时清点云端：能取回的立刻取回，还在跑的标成「待取回」。

    为什么非做不可：一条片子在云端跑十分钟，这期间关掉应用是很正常的事。
    不清点就是「钱花了、产物挂在会过期的链接上、谁都不知道」。
    """
    recovered = 0
    waiting = 0
    for row in cloud_tasks.open_tasks():
        if not str(row.get("remote_task_id") or ""):
            cloud_tasks.finish(int(row["id"]), "failed", error="还没提交到云端就中断了")
            continue
        if (_job and _job.get("state") in RUNNING_STATES
                and str(_job.get("cloud_task_id") or "") == str(row["id"])):
            waiting += 1
            continue
        try:
            files = await cloud_engine.refetch(row)
        except Exception as exc:  # noqa: BLE001 - 还没跑完 / 链接过期 / 网络不通，都留给用户手点
            log.info("cloud task %s not fetchable yet: %s", row.get("id"), exc)
            cloud_tasks.update(int(row["id"]), state="lost", error=str(exc))
            waiting += 1
            continue
        params = row.get("params") if isinstance(row.get("params"), dict) else {}
        ids, _produced = await asyncio.to_thread(_register_cloud_files, params, files)
        if ids:
            cloud_tasks.finish(int(row["id"]), "done", image_ids=ids)
            recovered += len(ids)
        else:
            cloud_tasks.update(int(row["id"]), state="lost", error="产物没能收进图库")
            waiting += 1
    return {"recovered": recovered, "waiting": waiting}


async def _object_info(client: ComfyUIClient, nodes: dict) -> dict | None:
    """文生图要按 object_info 判断哪些输入是必填的；ComfyUI 没答话就退化成乐观判断。"""
    classes = sorted({str(node.get("class_type") or "") for node in nodes.values() if isinstance(node, dict)})
    try:
        return await client.object_info([c for c in classes if c]) or None
    except (ComfyUIError, OSError):
        return None


# 各族「转成什么」的指引：报格式不支持却不给出路，等于让人去猜。
SUFFIX_FIX_HINTS = {"image": "先转成 PNG 或 JPG。", "audio": "先转成 MP3 或 WAV。",
                    "video": "先转成 MP4。"}


async def _upload_reference(client: ComfyUIClient, media_id: int, kind: str = "image") -> str:
    """把图库里的素材推进 ComfyUI 的 input 目录，返回加载器认的写法。

    三类素材共用 /upload/image 这一条通道——ComfyUI 那边只管落盘、不校验扩展名，
    真正挑吃食的是 LoadImage / LoadAudio / VHS_LoadVideo，所以族别和容器都要在这里问清。
    """
    family_name = UPLOAD_KIND_NAMES.get(kind, kind)
    row = get_pool().main().execute(
        "SELECT filename, path, kind FROM images WHERE id=?", (media_id,)
    ).fetchone()
    if row is None:
        raise ValueError("参考素材已经不在图库里了，重新选一份。")
    row_kind = str(row["kind"] or "image")
    if row_kind != kind:
        raise ValueError(f"「{row['filename']}」是{UPLOAD_KIND_NAMES.get(row_kind, row_kind)}，"
                         f"不能当{family_name}参考。")
    path = Path(row["path"])
    suffix = path.suffix.lower()
    if suffix not in (UPLOADABLE_SUFFIXES.get(kind) or set()):
        raise ValueError(f"{family_name}格式 {suffix or '（无扩展名）'} ComfyUI 读不了，"
                         + SUFFIX_FIX_HINTS.get(kind, ""))
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"读不到「{row['filename']}」，原文件可能已被移动或删除。") from exc
    # 名字带素材 id + 内容 hash：既不覆盖用户 input 目录里的原始文件，
    # 也让"同一份参考素材反复生成"在 ComfyUI 侧命中同一份，不堆垃圾。
    # 来源记录（clone_sources）就是靠这个文件名把成图认回当初的参考，别改这个格式。
    digest = hashlib.sha1(content).hexdigest()[:8]
    name = f"seekx_ref_{media_id}_{digest}{suffix}"
    uploaded = await client.upload_image(name, content, mimetypes.guess_type(name)[0])
    subfolder = uploaded.get("subfolder") or ""
    return f"{subfolder}/{uploaded['name']}" if subfolder else uploaded["name"]


def _poll_timeout(job: dict) -> float:
    """图片 15 分钟，视频 60 分钟。拿图片的钟去等一条片子，等于替用户按下取消。"""
    return POLL_TIMEOUT_VIDEO if str(job.get("media_kind") or "") == "video" else POLL_TIMEOUT


async def _await_outputs(client: ComfyUIClient, job: dict, prompt_id: str) -> dict:
    """轮询 history。ComfyUI 只在任务结束（成功或报错）时才写入 history。"""
    timeout = _poll_timeout(job)
    deadline = time.monotonic() + timeout
    while True:
        if job.get("cancelled"):
            return {}
        history = await client.history(prompt_id)
        entry = history.get(prompt_id) if isinstance(history, dict) else None
        if isinstance(entry, dict):
            status = entry.get("status")
            if isinstance(status, dict) and str(status.get("status_str") or "") == "error":
                raise ValueError(_history_error_text(status))
            outputs = entry.get("outputs")
            return outputs if isinstance(outputs, dict) else {}
        if time.monotonic() > deadline:
            await client.interrupt()
            await client.delete_queue_items([prompt_id])
            raise ValueError(f"生成超过 {int(timeout // 60)} 分钟还没出结果，已请 ComfyUI 停下。")
        await asyncio.sleep(POLL_INTERVAL)


def _history_error_text(status: dict) -> str:
    parts: list[str] = []
    for message in status.get("messages") or []:
        items = message if isinstance(message, (list, tuple)) else [message]
        for item in items:
            if isinstance(item, dict):
                text = item.get("exception_message") or item.get("node_id") or item.get("type")
                if text:
                    parts.append(str(text))
            elif isinstance(item, str) and item not in {"execution_error", "execution_interrupted"}:
                parts.append(item)
    if not parts:
        return "ComfyUI 报错了，打开它看看哪个节点标红。"
    return "ComfyUI 报错了：" + "；".join(list(dict.fromkeys(parts)))


def _output_entries(outputs: dict) -> list[dict]:
    """ComfyUI 交回的产物。图在 images，VHS_VideoCombine 的片子在 gifs，
    音频在 audios——只认 images 的话，视频跑完只会得到一句「没交回产物」。
    同一个文件被两个节点各报一次（Video Combine 边预览边保存很常见），按
    (subfolder, filename) 去重，不然图库里会多出成对的重复记录。
    """
    entries: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for bucket in OUTPUT_HISTORY_KEYS:
            for item in node_output.get(bucket) or []:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                # PreviewImage 之类节点的临时预览图 type=temp，不是交付物。
                if str(item.get("type") or "output") != "output":
                    continue
                identity = (str(item.get("subfolder") or ""), str(item["filename"]))
                if identity in seen:
                    continue
                seen.add(identity)
                entries.append(item)
    return entries


def _output_on_disk(item: dict) -> Path | None:
    """在图库监听目录里找到 ComfyUI 刚写出的那张图。

    不再往图库里复制一份：大家监听的本来就是 ComfyUI 的 output 目录，复制就是同一张
    图存两遍，还会让「一键同款」文件夹和 ComfyUI 那边永远对不上号。
    """
    filename = str(item.get("filename") or "")
    if not filename:
        return None
    subfolder = str(item.get("subfolder") or "")
    relative = Path(subfolder) / filename if subfolder else Path(filename)
    roots = [Path(raw) for raw in load_config().watch_dirs]
    for root in roots:
        try:
            candidate = root / relative
            if candidate.is_file():
                return candidate
        except (OSError, ValueError):
            continue
    for root in roots:  # 监听的是上层目录时，兜底按文件名搜一次
        try:
            for hit in root.rglob(filename):
                if hit.is_file():
                    return hit
        except (OSError, ValueError):
            continue
    return None


def _register_output(path: Path) -> int | None:
    """把已经躺在监听目录里的成图收进图库；live 监视先抢到就算它的。"""
    pool = get_pool().main()
    normalized = Indexer._normalize(path)
    row = pool.execute("SELECT id FROM images WHERE path IN (?, ?)", (normalized, str(path))).fetchone()
    if row:
        return int(row["id"])
    payload = get_indexer()._process_path_sync(path)
    if not payload:
        return None
    get_indexer().emit_event_sync(payload)
    return int(payload.get("id") or 0) or None


def _record_sources(job: dict, image_ids: list[int]) -> None:
    """登记「这批产出当初喂了哪几张参考、说了哪几句话」。失败只写日志：来源只是替用户省一次
    重新选图和重新打字，不能因为它把已经出好的东西说成生成失败。"""
    try:
        clone_sources.record(
            image_ids=image_ids,
            template_id=job.get("template_id"),
            source_image_id=job.get("source_image_id"),
            references=job.get("references") or [],
            prompt=str(job.get("prompt") or ""),
            slot_prompts=job.get("slot_prompts") or {},
        )
    except Exception as exc:  # noqa: BLE001 - 图已经出来了，记不上来源不值得惊动用户
        log.warning("clone sources record failed: %s", exc)


def _output_summary(image_id: int, filename: str) -> dict:
    """产出 chip 需要的四样：图库 id、是哪一类、叫什么、缩略图在哪。

    缩略图一律走图库口径：视频给首帧、音频给波形。前端自己去拼
    /api/images/{id}/file 就会在视频上画出坏图，把音频当图片缩略图更是画出一段波形噪点。
    """
    summary = repository.image_summary(image_id=image_id) or {}
    return {"id": image_id, "kind": str(summary.get("kind") or "image"),
            "filename": str(summary.get("filename") or filename),
            "thumbnail_url": str(summary.get("thumbnail_url") or "")}


async def _collect_outputs(outputs: dict) -> tuple[list[int], list[str], list[dict]]:
    """(收进图库的 id, 没能收进来的文件名, 给前端的产出清单)。"""
    entries = _output_entries(outputs)
    if not entries:
        return [], [], []
    ids: list[int] = []
    missing: list[str] = []
    produced: list[dict] = []
    for item in entries:
        filename = str(item.get("filename") or "")
        path = await asyncio.to_thread(_output_on_disk, item)
        if path is None:
            missing.append(filename)
            continue
        image_id = await asyncio.to_thread(_register_output, path)
        if not image_id:
            missing.append(filename)
            continue
        ids.append(image_id)
        produced.append(_output_summary(image_id, filename))
    return ids, missing, produced
