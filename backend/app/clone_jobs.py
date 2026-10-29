"""一键同款的生成任务：单任务串行，跑在本机 ComfyUI 上。

为什么串行：本地只有一块 GPU，两个任务一起排队只会互相拖慢，还要用户分辨"哪张是
哪次生成的"。所以第二个请求直接 409 挡回去，比假装支持并发诚实。

状态只存在内存里 + 走 WS：生成结果本身就是历史（图片进图库），再建一张任务表除了
同步负担没有收益。应用重启会丢掉"正在生成"的视图，ComfyUI 那边跑完的图仍留在它的
output 目录里，不会静默丢。
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

from . import clone_sources, clone_templates, workflow_edit
from .comfyui_client import ComfyUIError, ComfyUIClient
from .config import load_config
from .db import get_pool
from .events import get_bus
from .indexer import Indexer, get_indexer

log = logging.getLogger("suxing_gallery.clone")

POLL_INTERVAL = 1.5
POLL_TIMEOUT = 900.0
RUNNING_STATES = ("uploading", "queued", "running", "downloading")
# ComfyUI 的 LoadImage 只吃这几种；PSD/TIF 之类先让用户转，别在链路中段莫名失败。
UPLOADABLE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

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
                "image_ids": [], "template_id": None, "source_image_id": None, "elapsed": 0.0}
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
        "template_id": job.get("template_id"),
        "source_image_id": job.get("source_image_id"),
        "elapsed": round(time.time() - float(job.get("started_at") or time.time()), 1),
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


def plan_request(*, template_id: int, references: list[dict],
                 controls: dict | None) -> tuple[dict, str]:
    """先按模板槽位把请求校验一遍，避免把注定失败的请求丢给 ComfyUI。

    生成方式不是请求里的一个选项，是参考图数量的函数：0 张文生图、1 张单图编辑、
    2 张以上多图编辑。所以这里只做三件事——参考位存不存在、有没有跳着填、
    这份工作流撑不撑得住这个数量（文生图要看参考链摘不摘得掉）。

    抛 KeyError → 模板不存在（404）；ValueError → 参数不对（400）。
    """
    template = clone_templates.get_template(template_id)
    slots = template["slots"]
    cells = clone_templates.reference_cell_keys(slots)
    given: list[str] = []
    for ref in references:
        key = str(ref.get("slot") or "")
        if key not in cells:
            raise ValueError(f"这份工作流没有叫 {key} 的参考位，关掉弹窗重开一次试试。")
        if key in given:
            raise ValueError(f"参考位 {key} 填了两遍，关掉弹窗重开一次试试。")
        given.append(key)
    mode = clone_templates.mode_from_count(len(given))
    clone_templates.check_mode(template, mode)
    # 参考图要从「图片1」开始连着放：跳着填的话弹窗里的编号和实际接线的顺序就对不上，
    # 而且空着的那格会被当成「没喂图」摘掉，用户以为传了、其实没传。
    filled = {cells.index(key) for key in given}
    gaps = [i for i in range(max(filled) + 1 if filled else 0) if i not in filled]
    if gaps:
        raise ValueError("参考图要从图片1 开始连着放，中间不能空着："
                         + "、".join(f"图片{i + 1}" for i in gaps))
    control_keys = {clone_templates.slot_key(s) for s in slots if s.get("kind") in ("select", "number")}
    for key in (controls or {}):
        if key not in control_keys:
            raise ValueError(f"{key} 不是这份工作流声明的控件，关掉弹窗重开一次试试。")
    return template, mode


async def start(
    *,
    template_id: int,
    prompt: str,
    references: list[dict],
    controls: dict | None,
    source_image_id: int | None,
) -> dict:
    global _job, _task
    # 先按槽位校验，再管忙不忙：参数写错了就该告诉用户哪儿写错，而且换个调用方也绕不过
    _template, mode = plan_request(
        template_id=template_id, references=references, controls=controls,
    )
    async with _lock:
        if _job and _job.get("state") in RUNNING_STATES:
            raise CloneBusy("已经有一键同款正在生成，等这一批出来再点。")
        cfg = load_config()
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
            "job_id": uuid.uuid4().hex[:12],
            "state": "uploading",
            "message": "准备中…",
            "error": "",
            "image_ids": [],
            "template_id": template_id,
            "source_image_id": source_image_id,
            "prompt": prompt,
            "references": [dict(ref) for ref in references],
            "controls": dict(controls or {}),
            "mode": mode,
            "started_at": time.time(),
            "cancelled": False,
            "prompt_id": "",
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
    client = ComfyUIClient(url)
    try:
        template = clone_templates.get_template(int(job["template_id"]))
        slots: list[dict] = template["slots"]

        # 一张参考图都没有（＝文生图）时别谎报「上传参考图」，状态要说人话。
        if job["references"]:
            await _set(job, state="uploading", message="上传参考图…")
        references: dict[str, str] = {}
        for ref in job["references"]:
            if job.get("cancelled"):
                return
            key = str(ref.get("slot") or "")
            if key not in clone_templates.reference_slot_keys(slots)[1]:
                raise ValueError(f"这份工作流没有叫 {key} 的参考位。")
            references[key] = await _upload_reference(client, int(ref.get("image_id") or 0))

        # 只要有参考链要摘（包括一张都不喂的文生图），就得带 object_info 去摘，
        # 不然分不清哪个输入是必填的，会静默摘坏。全喂满时不用浪费这几十次请求。
        info = await _object_info(client, template["nodes"]) \
            if clone_templates.unused_reference_nodes(slots, references) else None
        workflow, titles = clone_templates.build_workflow(
            template["nodes"],
            slots,
            prompt=job["prompt"],
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
        ids, missing = await _collect_outputs(outputs)
        if not ids and not missing:
            raise ValueError("ComfyUI 跑完了但没交回图片，检查这份工作流里有没有保存图像的节点。")
        message = f"已生成 {len(ids)} 张" if ids else "图已经在 ComfyUI 输出目录，没在图库监听目录里"
        if missing:
            message += "；没收进图库：" + "、".join(missing[:2])
        # 来源赶在「已完成」广播之前落库：前端收到 done 就可能立刻点产出图重开同款，
        # 那一刻读不到来源，弹窗又会退回复用被点的这张图当唯一参考——正是这次要修的毛病。
        await asyncio.to_thread(_record_sources, job, ids)
        await _set(job, state="done", message=message, image_ids=ids)
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


async def _object_info(client: ComfyUIClient, nodes: dict) -> dict | None:
    """文生图要按 object_info 判断哪些输入是必填的；ComfyUI 没答话就退化成乐观判断。"""
    classes = sorted({str(node.get("class_type") or "") for node in nodes.values() if isinstance(node, dict)})
    try:
        return await client.object_info([c for c in classes if c]) or None
    except (ComfyUIError, OSError):
        return None


async def _upload_reference(client: ComfyUIClient, image_id: int) -> str:
    """把图库里的素材推进 ComfyUI 的 input 目录，返回 LoadImage 认的写法。"""
    row = get_pool().main().execute(
        "SELECT filename, path, kind FROM images WHERE id=?", (image_id,)
    ).fetchone()
    if row is None:
        raise ValueError("参考图已经不在图库里了，重新选一张。")
    if (row["kind"] or "image") != "image":
        raise ValueError(f"「{row['filename']}」不是图片，不能当参考图。")
    path = Path(row["path"])
    suffix = path.suffix.lower()
    if suffix not in UPLOADABLE_SUFFIXES:
        raise ValueError(f"参考图格式 {suffix or '（无扩展名）'} ComfyUI 读不了，先转成 PNG 或 JPG。")
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"读不到「{row['filename']}」，原文件可能已被移动或删除。") from exc
    # 名字带图片 id + 内容 hash：既不覆盖用户 input 目录里的原始文件，
    # 也让"同一张参考图反复生成"在 ComfyUI 侧命中同一份，不堆垃圾。
    digest = hashlib.sha1(content).hexdigest()[:8]
    name = f"seekx_ref_{image_id}_{digest}{suffix}"
    uploaded = await client.upload_image(name, content, mimetypes.guess_type(name)[0])
    subfolder = uploaded.get("subfolder") or ""
    return f"{subfolder}/{uploaded['name']}" if subfolder else uploaded["name"]


async def _await_outputs(client: ComfyUIClient, job: dict, prompt_id: str) -> dict:
    """轮询 history。ComfyUI 只在任务结束（成功或报错）时才写入 history。"""
    deadline = time.monotonic() + POLL_TIMEOUT
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
            raise ValueError(f"生成超过 {int(POLL_TIMEOUT // 60)} 分钟还没出结果，已请 ComfyUI 停下。")
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
    entries: list[dict] = []
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for item in node_output.get("images") or []:
            if not isinstance(item, dict) or not item.get("filename"):
                continue
            # PreviewImage 之类节点的临时预览图 type=temp，不是交付物。
            if str(item.get("type") or "output") != "output":
                continue
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
    """登记「这批成图当初喂了哪几张参考图」。失败只写日志：来源只是替用户省一次重新选图，
    不能因为它把已经出好的图说成生成失败。"""
    try:
        clone_sources.record(
            image_ids=image_ids,
            template_id=job.get("template_id"),
            source_image_id=job.get("source_image_id"),
            references=job.get("references") or [],
        )
    except Exception as exc:  # noqa: BLE001 - 图已经出来了，记不上来源不值得惊动用户
        log.warning("clone sources record failed: %s", exc)


async def _collect_outputs(outputs: dict) -> tuple[list[int], list[str]]:
    """(收进图库的 id, 没能收进来的文件名)。"""
    entries = _output_entries(outputs)
    if not entries:
        return [], []
    ids: list[int] = []
    missing: list[str] = []
    for item in entries:
        filename = str(item.get("filename") or "")
        path = await asyncio.to_thread(_output_on_disk, item)
        if path is None:
            missing.append(filename)
            continue
        image_id = await asyncio.to_thread(_register_output, path)
        if image_id:
            ids.append(image_id)
        else:
            missing.append(filename)
    return ids, missing
