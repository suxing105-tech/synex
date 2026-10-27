"""/api/videos 视频反推提示词路由：分镜方案 + 段正文（Seedance 2.0 / MiniMax H3）。

所有外部请求都从后端发出；复用图片反推的模型配置、DPAPI 凭据与请求实现。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .. import reverse_prompts
from .. import video_prompts as service
from .reverse_prompts import SafeValidationRoute

router = APIRouter(prefix="/api", tags=["video-prompts"], route_class=SafeValidationRoute)


class SettingsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    default_model_id: int | None = None
    instruction_plan: str = Field(min_length=1, max_length=12000)
    instruction_seedance: str = Field(min_length=1, max_length=12000)
    instruction_h3: str = Field(min_length=1, max_length=12000)
    default_mode_h3: str = "t2va"
    default_mode_seedance: str = "t2v"
    frame_limit: int = Field(default=12, ge=4, le=16)
    max_unit_seconds: int = Field(default=15, ge=5, le=15)
    max_units: int = Field(default=12, ge=1, le=24)


class PlanInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    model_config_id: int | None = None
    sound_note: str | None = Field(default=None, max_length=2000)
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, ge=1)
    max_unit_seconds: int | None = Field(default=None, ge=5, le=15)


class SegmentInput(BaseModel):
    model_config_id: int | None = None
    target: str
    # 两种目标格式都有模式，只是取值不同；不传就用设置里该格式的默认模式。
    mode: str | None = None


class EditInput(BaseModel):
    target: str
    prompt: str = Field(min_length=1, max_length=50000)
    parent_id: int | None = None


def _collect_frames(path, seconds):
    return service.trim_frames(service.collect_frames(path, seconds))


def _resolve_target(target: str) -> str:
    if target not in service.TARGETS:
        raise HTTPException(422, "未知的目标格式")
    return target


def _resolve_mode(target: str, mode: str | None) -> str:
    """模式按目标格式各自的清单校验；没传就用设置里那一格的默认值。"""
    resolved = mode or service.settings()["default_mode_" + ("h3" if target == "h3" else "seedance")]
    if resolved not in service.MODES_BY_TARGET[target]:
        label = "MiniMax H3" if target == "h3" else "Seedance 2.0"
        raise HTTPException(422, f"未知的 {label} 模式")
    return resolved


def _clamp_range(payload: PlanInput, duration_ms: int) -> tuple[int, int]:
    """区间秒数一律取整：结束秒不超过整片时长的整数部分（15.116 秒的视频最多到 15 秒）。"""
    last = int(duration_ms // 1000) * 1000
    start = min(max(0, service.snap_second(payload.start_ms or 0)), max(0, last - 1000))
    end = service.snap_second(payload.end_ms) if payload.end_ms is not None else last
    return start, min(max(end, start + 1000), last)


# ---------- 设置 ----------


@router.get("/video-prompt-settings")
def get_settings():
    return service.settings()


@router.put("/video-prompt-settings")
def update_settings(payload: SettingsInput):
    if payload.default_model_id is not None:
        reverse_prompts.get_config(payload.default_model_id)
    return service.save_settings(
        default_model_id=payload.default_model_id,
        instruction_plan=payload.instruction_plan,
        instruction_seedance=payload.instruction_seedance,
        instruction_h3=payload.instruction_h3,
        default_mode_h3=payload.default_mode_h3,
        default_mode_seedance=payload.default_mode_seedance,
        frame_limit=payload.frame_limit,
        max_unit_seconds=payload.max_unit_seconds,
        max_units=payload.max_units,
    )


# ---------- 阶段一：分镜方案（与目标格式无关） ----------


@router.post("/videos/{video_id}/video-prompts/plans")
async def create_plan(video_id: int, payload: PlanInput):
    settings = service.settings()
    meta = service.video_meta(video_id)
    start_ms, end_ms = _clamp_range(payload, meta["duration_ms"])
    max_unit_seconds = payload.max_unit_seconds or settings["max_unit_seconds"]
    config = service.resolve_model_config(payload.model_config_id)
    key = reverse_prompts.key_for(config)
    sound_note = (payload.sound_note or "").strip()
    if key:
        sound_note = sound_note.replace(key, "[已隐藏密钥]")
    instruction = settings["instruction_plan"] + service.PLAN_TIME_RULE
    if key:
        instruction = instruction.replace(key, "[已隐藏密钥]")
    service.acquire_plan(video_id)
    try:
        cuts = await run_in_threadpool(service.detect_shots, meta["path"])
        units = service.plan_units(cuts, start_ms, end_ms, max_unit_seconds)
        service.check_unit_limit(units, settings["max_units"])
        frames = await run_in_threadpool(
            _collect_frames, meta["path"], service.sample_timestamps(start_ms, end_ms, settings["frame_limit"]))
        content = service.plan_request(units, frames, meta=meta, range_start_ms=start_ms,
                                      range_end_ms=end_ms, sound_note=sound_note)
        try:
            text = await reverse_prompts.request_model(config, key, content, instruction,
                                               output_rule=service.PLAN_OUTPUT_RULE)
            anchors, enriched, terms = service.parse_plan(text, units)
        except HTTPException as exc:
            service.create_run(video_id, units=[], anchors="", sound_note=sound_note, frames=[],
                               instruction=instruction + service.PLAN_OUTPUT_RULE, config=config,
                               range_start_ms=start_ms, range_end_ms=end_ms,
                               frame_limit=settings["frame_limit"], max_unit_seconds=max_unit_seconds,
                               status="failed", error=str(exc.detail))
            raise
        run = service.create_run(video_id, units=enriched, anchors=anchors, sound_note=sound_note,
                                 frames=frames, instruction=instruction + service.PLAN_OUTPUT_RULE,
                                 config=config, range_start_ms=start_ms, range_end_ms=end_ms,
                                 frame_limit=settings["frame_limit"], max_unit_seconds=max_unit_seconds,
                                 risk_terms=terms)
        # 提示词里的 @图片 1 / <Picture 1> 就是这些首尾帧，先把它们落到磁盘上，前端才有图可显示。
        await run_in_threadpool(service.prime_reference_frames, video_id, run["id"],
                                service.run_units(run), meta["path"])
        return service.listing(video_id, 1, 0)["runs"][0]
    finally:
        service.release_plan(video_id)


# ---------- 阶段二：段正文（按目标格式） ----------


@router.post("/videos/{video_id}/video-prompts/runs/{run_id}/segments/{index}")
async def generate_segment(video_id: int, run_id: int, index: int, payload: SegmentInput):
    target = _resolve_target(payload.target)
    mode = _resolve_mode(target, payload.mode)
    run = service.get_run(run_id, video_id)
    if run["status"] != "planned":
        raise HTTPException(409, "分镜方案未完成，无法生成段正文")
    unit = service.find_unit(run, index)
    settings = service.settings()
    meta = service.video_meta(video_id)
    config = service.resolve_model_config(payload.model_config_id)
    key = reverse_prompts.key_for(config)
    instruction = (settings["instruction_seedance"] if target == "seedance2" else settings["instruction_h3"])
    instruction += service.time_rule(target) + service.mode_rule(target, mode)
    if key:
        instruction = instruction.replace(key, "[已隐藏密钥]")
    units = service.run_units(run)
    service.acquire_segment(run_id, index, target, video_id)
    try:
        seconds = service.sample_timestamps(
            unit["start_ms"], unit["end_ms"],
            service.unit_frame_count((unit["end_ms"] - unit["start_ms"]) / 1000, run["frame_limit"]))
        frames = await run_in_threadpool(_collect_frames, meta["path"], seconds)
        base = unit["start_ms"] / 1000
        relative = [(round(moment - base, 3), url) for moment, url in frames]
        content = service.segment_request(target, mode, unit, meta=meta,
                                         anchors=run["anchors_text"], role=unit.get("role", ""),
                                         frames=relative, sound_note=run["sound_note"],
                                         total_units=len(units))
        output_rule = service.segment_output_rule(target, mode)
        text = await reverse_prompts.request_model(config, key, content, instruction,
                                         output_rule=output_rule)
        prompt, terms, raw, status, notes = service.parse_segment(
            text, target=target, mode=mode, unit=unit)
        record = service.create_record(run, segment_index=index, target=target, mode=mode, prompt=prompt,
                                       risk_terms=terms, raw_text=raw, status=status, source="generated",
                                       parent_id=None, instruction=instruction + output_rule,
                                       config=config, frames=relative, notes=notes)
        return service.public_record_for(record, video_id, unit)
    finally:
        service.release_segment(run_id, index, target)


@router.post("/videos/{video_id}/video-prompts/runs/{run_id}/segments/{index}/edits")
def edit_segment(video_id: int, run_id: int, index: int, payload: EditInput):
    target = _resolve_target(payload.target)
    run = service.get_run(run_id, video_id)
    unit = service.find_unit(run, index)
    record = service.edit_record(run, segment_index=index, target=target,
                                 prompt=payload.prompt, parent_id=payload.parent_id)
    return service.public_record_for(record, video_id, unit)


# ---------- 译文：中英文一键切换 ----------


class TranslationInput(BaseModel):
    target: str
    model_config_id: int | None = None


@router.post("/videos/{video_id}/video-prompts/runs/{run_id}/segments/{index}/translations")
async def translate_segment(video_id: int, run_id: int, index: int, payload: TranslationInput):
    """翻译该段当前版本的正文。方向由正文主体语言决定，中文正文出英文、英文正文出中文。

    一个版本只存一条译文：再点一次直接读缓存，不再花一次调用。
    """
    target = _resolve_target(payload.target)
    run = service.get_run(run_id, video_id)
    record = service.current_record(run, index, target)
    body = (record["prompt"] or "").strip() or (record["raw_text"] or "").strip()
    if not body:
        raise HTTPException(422, "该段正文为空，无法翻译")
    language = service.translation_language(body)
    cached = service.get_translation(record["id"])
    if cached and cached["text"].strip():
        return {**service.public_translation(cached), "source": "cache"}
    service.acquire_translation(record["id"])
    try:
        config = service.resolve_model_config(payload.model_config_id)
        key = reverse_prompts.key_for(config)
        instruction = service.TRANSLATION_INSTRUCTION
        if key:
            instruction = instruction.replace(key, "[已隐藏密钥]")
        text = await reverse_prompts.request_model(
            config, key, [{"type": "text", "text": body}], instruction,
            output_rule=service.TRANSLATION_OUTPUT_RULE)
        cleaned = service.clean_translation(text)
        if not cleaned:
            raise HTTPException(502, "模型没有返回译文，请重试或更换模型")
        saved = service.store_translation(record["id"], language=language, text=cleaned, config=config)
        return {**service.public_translation(saved), "source": "model"}
    finally:
        service.release_translation(record["id"])


# ---------- 读取与取帧 ----------


@router.get("/videos/{video_id}/video-prompts/runs/{run_id}/segments/{index}/records")
def segment_records(video_id: int, run_id: int, index: int, target: str,
                    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
    run = service.get_run(run_id, video_id)
    return service.record_versions(run, index, _resolve_target(target), limit, offset)


@router.delete("/videos/{video_id}/video-prompts/runs/{run_id}/segments/{index}/records/{record_id}")
def delete_segment_record(video_id: int, run_id: int, index: int, record_id: int, target: str):
    """删除某段某格式的一个历史版本。删的正好是最新版时，当前版本自动退回次新一版。"""
    run = service.get_run(run_id, video_id)
    service.find_unit(run, index)
    return service.delete_record(run, record_id=record_id, segment_index=index,
                                 target=_resolve_target(target))


@router.get("/videos/{video_id}/video-prompts")
def history(video_id: int, limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0)):
    service.video_row(video_id)
    return service.listing(video_id, limit, offset)


@router.get("/videos/{video_id}/video-prompts/runs/{run_id}/segments/{index}/frame")
async def segment_frame(video_id: int, run_id: int, index: int, which: str = Query("first")):
    """某段的首帧或末帧：提示词引用的 @图片 1 / <Picture 1> 就是这张图。"""
    if which not in service.FRAME_EDGES:
        raise HTTPException(422, "未知的参考帧位置，仅支持 first 或 last")
    run = service.get_run(run_id, video_id)
    unit = service.find_unit(run, index)
    meta = service.video_meta(video_id)
    return await run_in_threadpool(service.reference_frame, video_id, run_id, unit, which, meta["path"])


@router.get("/videos/{video_id}/frame")
def frame(video_id: int, at: float = Query(ge=0)):
    meta = service.video_meta(video_id)
    limit = max(0.0, meta["duration_ms"] / 1000 - service.TAIL_MARGIN_SECONDS)
    found = service.extract_frame_near(meta["path"], min(at, limit))
    if found is None:
        raise HTTPException(500, "取帧失败，视频可能已损坏或编码不受支持")
    raw, used = found
    return {"at": used, "duration_ms": meta["duration_ms"], "data_url": service.data_url(raw)}