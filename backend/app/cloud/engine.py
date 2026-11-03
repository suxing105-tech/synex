"""把弹窗里填的东西变成一次云端任务，再把产物领回图库。

顺序是固定的，两处都不能挪：

    参考素材 → 上传换签名 URL → 立刻提交 → 轮询 → 下载落盘 → 交给图库认领

上传与提交必须连着做：RunningHub 给的是带 signExpire 的签名链接（官方文档写约 1 天），
缓存下来下次用只会得到「素材不存在」，而那时钱已经扣了。

产物落 <数据盘>\\SeekX-Data\\generated\\<image|video|audio>\\<YYYY-MM-DD>\\，走本机同一套
_register_output 入库，不新增 watch_dir——inbox 早就证明了直接认领就够了。
"""
from __future__ import annotations

import hashlib
import io
import logging
import mimetypes
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from ..config import load_config
from ..db import get_pool
from . import accounts, spec as cloud_spec
from .client import RunningHubClient, RunningHubError
from . import tasks as cloud_tasks

log = logging.getLogger("suxing_gallery.cloud")

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv"}
UPLOAD_SUFFIXES = {"image": IMAGE_SUFFIXES, "audio": AUDIO_SUFFIXES, "video": VIDEO_SUFFIXES}
FAMILY_NAMES = {"image": "图片", "audio": "音频", "video": "视频"}
# 产出扩展名跟着 outputType 走；没有就给这一族的缺省。
DEFAULT_SUFFIX = {"image": ".png", "audio": ".mp3", "video": ".mp4"}


class CloudUnavailable(Exception):
    """账号没配、余额闸拦下——都是「还没到花钱那一步」的拒绝。"""


def generated_dir(capability: str) -> Path:
    """<数据目录>/generated/<image|video|audio>/<今天>/。按日期分一层，翻片子时不必在几千个文件里找。"""
    from ..config import cloud_output_root

    day = time.strftime("%Y-%m-%d")
    folder = cloud_output_root() / (capability if capability in DEFAULT_SUFFIX else "image") / day
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def availability() -> dict:
    """弹窗那句实话：现在能不能点云端这一行，不能的话差哪一步。

    这里没有「云端总开关」可查。设置页那张云端卡已经撤了（Key 的家在「模型服务API」
    那张厂商卡片里），再留一个默认关着的开关，等于把人挡在「现在还不能生成」前面
    却不给开关。真要拦花钱，靠的是 budget_check 与弹窗里那条预估价。
    """
    account = accounts.usable_account()
    if account is None:
        for row in accounts.list_accounts():
            if row["enabled"] and not row["has_api_key"]:
                return {"available": False, "reason": "这条云端账号还没有填 API Key"}
        return {"available": False, "reason": "还没有可用的云端账号，去设置 → 模型与反推里填 Key"}
    return {"available": True, "reason": "", "account_name": account["name"]}


def budget_check(estimated: float | None) -> str:
    """花钱闸门。超了回一句人话，调用方据此拦住，绝不把请求发出去。"""
    cfg = load_config()
    single = float(getattr(cfg, "cloud_max_single_coins", 0) or 0)
    daily = float(getattr(cfg, "cloud_max_daily_coins", 0) or 0)
    if single > 0 and estimated is not None and float(estimated) > single:
        return (f"这一条预估 {float(estimated):g} RH币，超过设置里的单次上限 {single:g} RH币。"
                "要跑就去设置里放宽上限。")
    if daily > 0:
        spent = cloud_tasks.spend_today_coins()
        if spent >= daily:
            return (f"今天已经花了 {spent:g} RH币，到了设置里的当日上限 {daily:g} RH币。"
                    "这条没有发出去，一分钱都没花。")
    return ""


def _media_row(image_id: int) -> dict | None:
    row = get_pool().main().execute(
        "SELECT filename, path, kind FROM images WHERE id=?", (image_id,)).fetchone()
    return dict(row) if row else None


def _prepare_image(content: bytes, suffix: str) -> bytes:
    """超过上限的参考图先降采样。压不下去才报错——静默压糊是最难查的失败。"""
    limit = cloud_spec.MAX_UPLOAD_BYTES["image"]
    if len(content) <= limit:
        return content
    try:
        from PIL import Image, ImageOps
    except ImportError:  # pragma: no cover - 打包里一定带着
        return content
    try:
        image = Image.open(io.BytesIO(content))
        image = ImageOps.exif_transpose(image)
        image.thumbnail((cloud_spec.MAX_IMAGE_EDGE, cloud_spec.MAX_IMAGE_EDGE))
        save = image.convert("RGB")
        out = io.BytesIO()
        for quality in (90, 82, 72, 60):
            out.seek(0)
            out.truncate()
            save.save(out, format="JPEG", quality=quality)
            if out.tell() <= limit:
                return out.getvalue()
        return out.getvalue()
    except Exception:  # noqa: BLE001 - 压不动就原样送，让服务端说清是不是它嫌大
        log.warning("cloud reference downscale failed", exc_info=True)
        return content


def prepare_reference(kind: str, image_id: int) -> tuple[bytes, str, str]:
    """读图库里这份素材，回 (字节, 上传文件名, content_type)。"""
    row = _media_row(image_id)
    if row is None:
        raise ValueError("参考素材已经不在图库里了，重新选一份。")
    path = Path(str(row["path"]))
    suffix = path.suffix.lower()
    family = FAMILY_NAMES.get(kind, kind)
    if suffix not in UPLOAD_SUFFIXES.get(kind, set()):
        hint = {"image": "先转成 PNG 或 JPG。", "audio": "先转成 MP3 或 WAV。",
                "video": "先转成 MP4。"}.get(kind, "")
        raise ValueError(f"{family}参考「{row['filename']}」的格式 {suffix or '（无扩展名）'}"
                         f" 云端读不了，{hint}")
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"读不到「{row['filename']}」，原文件可能已被移动或删除。") from exc
    if kind == "image":
        content = _prepare_image(content, suffix)
        if suffix == ".jpg":
            suffix = ".jpeg"
    limit = cloud_spec.MAX_UPLOAD_BYTES.get(kind, 0)
    if limit and len(content) > limit:
        raise ValueError(f"「{row['filename']}」有 {len(content) // (1024 * 1024) + 1}MB，"
                         f"超过云端单文件上限 {limit // (1024 * 1024)}MB，先压一份小的。")
    name = f"seekx_ref_{image_id}_{hashlib.sha1(content).hexdigest()[:12]}{suffix}"
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return content, name, content_type


def ordered_references(template: dict, references: list[dict]) -> list[tuple[str, int, str]]:
    """按参考位的编号排好，回 [(族, 素材 id, 槽位键), ...]。

    顺序就是 @Image 1 / @Video 1 的编号来源，乱发的后果是参考不生效且不报错。
    """
    cells = cloud_spec_cells(template)
    order = {str(cell["key"]): index for index, cell in enumerate(cells)}
    kinds = {str(cell["key"]): str(cell.get("kind") or "image") for cell in cells}
    items = []
    for ref in references:
        slot = str(ref.get("slot") or "")
        try:
            media_id = int(ref.get("image_id") or 0)
        except (TypeError, ValueError):
            continue
        if media_id <= 0:
            continue
        items.append((order.get(slot, 10_000), kinds.get(slot, "image"), media_id, slot))
    items.sort(key=lambda item: item[0])
    return [(kind, media_id, slot) for _order, kind, media_id, slot in items]


def cloud_spec_cells(template: dict) -> list[dict]:
    from ..clone_templates import reference_cells_with_tags

    return reference_cells_with_tags(template)


async def upload_references(client, template: dict, references: list[dict]) -> list[tuple[str, str]]:
    ordered = ordered_references(template, references)
    out: list[tuple[str, str]] = []
    for kind, media_id, _slot in ordered:
        content, name, content_type = prepare_reference(kind, media_id)
        out.append((kind, await client.upload(name, content, content_type)))
    return out


def wire_controls(controls: dict | None) -> dict:
    """弹窗传来的控件键是「节点.输入」（本机口径），云端没有节点，去掉那一段。

    弹窗只有一套控件协议是这次设计换来的东西之一；所以在引擎这一侧把它翻回
    声明里的参数名，而不是让前端为云端多写一套键。
    """
    out: dict[str, Any] = {}
    prefix = cloud_spec.SPEC_NODE + "."
    for key, value in (controls or {}).items():
        name = str(key)
        out[name[len(prefix):] if name.startswith(prefix) else name] = value
    return out


def request_for(template: dict, *, mode: str, prompt: str, refs: list[tuple[str, str]],
                controls: dict) -> tuple[str, dict]:
    spec = cloud_spec.spec_or_raise(template.get("model"))
    return cloud_spec.build_body(spec, mode=mode, prompt=prompt, refs=refs,
                                 controls=wire_controls(controls))


async def generate(job: dict, *, set_state=None) -> dict:
    """跑完一条云端任务。返回 {files, remote_task_id, cost_coins, state}。

    这里只管云端那一段；落库认领、来源登记留在 clone_jobs，跟本机那条路共用收尾。
    """
    from ..clone_templates import get_template

    set_state = set_state or _noop
    template = get_template(int(job["template_id"]))
    spec = cloud_spec.spec_or_raise(template.get("model"))
    account = accounts.usable_account()
    if account is None:
        raise CloudUnavailable(availability()["reason"] or "还没有可用的云端账号")
    key = accounts.key_for(account)
    client = RunningHubClient(str(account["base_url"]), key,
                              proxy_mode=str(account["proxy_mode"] or "system"))
    task_row_id = int(job.get("cloud_task_id") or 0)
    try:
        await set_state(state="uploading", message="上传参考素材到云端…")
        refs = await upload_references(client, template, job.get("references") or [])
        path, body = request_for(template, mode=str(job.get("mode") or "single"),
                                 prompt=str(job.get("prompt") or ""), refs=refs,
                                 controls=job.get("controls") or {})
        coins_before = None
        try:
            coins_before = (await client.account_status())["remain_coins"]
        except RunningHubError:
            coins_before = None
        if task_row_id:
            cloud_tasks.update(task_row_id, coins_before=coins_before,
                               params={**(job.get("params_snapshot") or {})})
        await set_state(state="queued", message="提交到云端…")
        submitted = await client.submit(path, body)
        task_id = submitted["task_id"]
        if task_row_id:
            cloud_tasks.update(task_row_id, state="running", remote_task_id=task_id)
        await set_state(state="running", message="云端生成中…", task_id=task_id)

        async def tick(elapsed: float) -> None:
            await set_state(message=f"云端生成中…已等待 {int(elapsed)} 秒")

        outcome = await client.wait(task_id, timeout=spec.timeout, interval=spec.poll,
                                    on_tick=tick)
        if outcome["state"] == "failed":
            raise RunningHubError(outcome["error"] or "云端说这一条失败了，没给原因")
        await set_state(state="downloading", message="取回生成结果…")
        files = await fetch_results(outcome["results"], spec.capability, task_id)
        coins_after = None
        try:
            coins_after = (await client.account_status())["remain_coins"]
        except RunningHubError:
            coins_after = None
        cost = None
        if coins_before is not None and coins_after is not None:
            cost = max(0.0, round(float(coins_before) - float(coins_after), 4))
        return {"files": files, "remote_task_id": task_id, "cost_coins": cost,
                "coins_before": coins_before, "coins_after": coins_after,
                "results": outcome["results"]}
    finally:
        await client.aclose()


async def fetch_results(results: list[dict], capability: str, task_id: str) -> list[Path]:
    """下载产物到 generated 目录。链接过期时这里会抛错，由 /refetch 再取一次。"""
    client_holder = RunningHubClient("", "", proxy_mode="system")
    folder = generated_dir(capability)
    out: list[Path] = []
    try:
        for index, item in enumerate(results):
            url = str(item.get("url") or "")
            if not url:
                continue
            content = await client_holder.download(url)
            suffix = _suffix_for(str(item.get("output_type") or ""), capability)
            digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
            name = f"seekx_{capability}_{task_id[-12:]}_{index + 1}_{digest}{suffix}"
            target = folder / name
            target.write_bytes(content)
            out.append(target)
    finally:
        await client_holder.aclose()
    return out


def _suffix_for(output_type: str, capability: str) -> str:
    cleaned = str(output_type or "").strip().lstrip(".").lower()
    if cleaned and len(cleaned) <= 5 and cleaned.isalnum():
        return "." + ("jpg" if cleaned == "jpeg" else cleaned)
    return DEFAULT_SUFFIX.get(capability, ".bin")


async def refetch(task: dict) -> list[Path]:
    """链接过期之后重新取回产物：只重新查一次任务，不重新生成、不二次扣费。"""
    account = accounts.usable_account()
    if account is None:
        raise CloudUnavailable(availability()["reason"] or "还没有可用的云端账号")
    remote = str(task.get("remote_task_id") or "")
    if not remote:
        raise ValueError("这一条还没提交到云端，没有能取回的东西。")
    client = RunningHubClient(str(account["base_url"]), accounts.key_for(account),
                              proxy_mode=str(account["proxy_mode"] or "system"))
    try:
        outcome = await client.query(remote)
        if outcome["state"] != "done":
            raise ValueError("云端那边这一条还没有出结果，再等一会儿来取。")
        files = await fetch_results(outcome["results"], str(task.get("capability") or "image"), remote)
        return files
    finally:
        await client.aclose()


async def test_account(account: dict) -> dict:
    """连通 + 鉴权：拿余额，能拿到就算通。"""
    key = accounts.key_for(account, quiet=True)
    if not key:
        return {"ok": False, "reason_code": "no_key", "message": "还没有填 API Key。"}
    client = RunningHubClient(str(account["base_url"]), key,
                              proxy_mode=str(account["proxy_mode"] or "system"))
    try:
        status = await client.account_status()
    except RunningHubError as exc:
        return {"ok": False, "reason_code": str(exc.code or exc.status or "error"),
                "message": str(exc)}
    finally:
        await client.aclose()
    return {"ok": True, "reason_code": "ok",
            "message": "连通，余额 " + (f"{status['remain_coins']:g} RH币"
                                        if status["remain_coins"] is not None else "未知"),
            "remain_coins": status["remain_coins"]}


async def estimate(template: dict, *, mode: str, prompt: str, controls: dict) -> dict | None:
    """官方价格预估。拿不到就回 None——弹窗宁可不说价，也不显示一个自己乘出来的假数。"""
    account = accounts.usable_account()
    if account is None:
        return None
    spec = cloud_spec.spec_or_raise(template.get("model"))
    client = RunningHubClient(str(account["base_url"]), accounts.key_for(account),
                              proxy_mode=str(account["proxy_mode"] or "system"))
    try:
        path, body = cloud_spec.build_body(spec, mode=mode, prompt=prompt, refs=[],
                                           controls=wire_controls(controls))
        payload = await client.estimate(path, body)
        if payload is None:
            return None
        return {"coins": coins_from(payload.get("raw")), "raw": payload.get("raw")}
    except Exception:  # noqa: BLE001 - 预估失败不影响能不能生成，只是不知道价
        log.info("cloud price estimate failed", exc_info=True)
        return None
    finally:
        await client.aclose()


# 官方价格预估的返回字段名没在文档里核实到，所以只认这几个常见写法，认不出就报「不知道」。
# 宁可不说价，也不自己乘一个假数——说错的价格比不说更伤信任。
PRICE_KEYS = ("coins", "consumeCoins", "consume_coins", "costCoins", "totalCoins",
              "price", "cost", "total", "fee")


def coins_from(payload: Any) -> float | None:
    """从预估返回里挑出那个「要花多少 RH币」的数。找不到回 None。"""
    if not isinstance(payload, dict):
        return None
    for key in PRICE_KEYS:
        if key in payload and payload[key] not in (None, ""):
            try:
                return max(0.0, float(payload[key]))
            except (TypeError, ValueError):
                continue
    data = payload.get("data")
    if isinstance(data, dict):
        return coins_from(data)
    if isinstance(data, list) and data:
        return coins_from(data[0] if isinstance(data[0], dict) else None)
    return None


def mount_output(path: Path, image_id: int) -> None:
    """把云端产物挂进侧栏的来源目录树：generated / <类> / <日期>。

    为什么不靠 Indexer 自己挂：它只认 watch_dirs 里的根，而云端产物故意不在监听目录里
    （自己监听自己 = 同一个文件被 watchdog 和直接索引抢两次）。所以链自己建、挂载自己做。
    挂不上只写日志——产物已经在图库里了，不能因为侧栏节点没建出来就报生成失败。
    """
    from .. import repository
    from ..config import cloud_output_root

    try:
        folder_id = repository.ensure_system_folder_chain(Path(path), cloud_output_root())
        if not folder_id:
            return
        conn = get_pool().main()
        conn.execute("INSERT OR IGNORE INTO image_folders(image_id, folder_id) VALUES(?, ?)",
                     (int(image_id), int(folder_id)))
    except Exception:  # noqa: BLE001
        log.warning("cloud output folder mount failed: %s", path, exc_info=True)


def pending_tasks() -> list[dict]:
    """还没拿到产物的云端任务，给「取回结果」那颗按钮当数据源。

    只回带 remote_task_id 的：没提交出去的请求本来就没东西可取回。
    """
    out = []
    for row in cloud_tasks.open_tasks():
        if not str(row.get("remote_task_id") or ""):
            continue
        out.append({k: row.get(k) for k in
                    ("id", "job_id", "capability", "model", "state", "state_label",
                     "remote_task_id", "cost_coins", "error", "created_at")})
    return out


async def _noop(**_changes: Any) -> None:
    """没接状态回调时的占位：不广播，也不报错。"""
    return None

