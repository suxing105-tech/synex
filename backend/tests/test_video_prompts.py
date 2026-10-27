"""视频反推提示词测试：切点装箱、分镜方案、段正文两格式、版本链与护栏。"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, reverse_prompts
from app import video_prompts as service
from app import video_prompts_legacy as legacy
from app.routes.reverse_prompts import router as model_router
from app.routes.video_prompts import router


# ---------- 测试素材 ----------


SPEC = "s=64x48:r=10:d="
# 四段不同画面硬切，切点固定在 5/10/15 秒（或 1.5/3/4.5 秒）。
SOURCES = ("testsrc", "smptebars", "color=c=blue", "color=c=red")


def lavfi(source: str, seconds: float) -> str:
    """lavfi 源串：带自有选项的源（color=c=blue）用 : 分隔，否则用 = 。"""
    return f"{source}:{SPEC}{seconds}" if "=" in source else f"{source}={SPEC}{seconds}"


def make_scene_video(path: Path, *, scene_seconds: float, sources: tuple[str, ...] = SOURCES) -> Path:
    """用多个 lavfi 源硬切拼接，制造确定的镜头切点。"""
    args = ["ffmpeg", "-y"]
    for source in sources:
        args += ["-f", "lavfi", "-i", lavfi(source, scene_seconds)]
    labels = "".join(f"[{i}:v]" for i in range(len(sources)))
    args += ["-filter_complex", f"{labels}concat=n={len(sources)}:v=1:a=0[out]",
             "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(args, capture_output=True, text=True, check=False)
    assert path.exists(), "ffmpeg 未能生成测试视频：" + str(path)
    return path


def index_video(pool, path: Path, duration: float) -> int:
    stat = path.stat()
    return pool.main().execute(
        "INSERT INTO images(path,filename,mtime,size_bytes,kind,duration_seconds,width,height,fps,format)"
        " VALUES(?,?,?,?,?,?,?,?,?,?)",
        (str(path), path.name, stat.st_mtime, stat.st_size, "video", duration, 64, 48, 10.0, "MP4"),
    ).lastrowid


@pytest.fixture
def client(init_db):
    """视频反推路由与模型配置路由挂在同一个 app 上（与 main.py 一致）。"""
    app = FastAPI()
    app.include_router(model_router)
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def video_id(init_db, tmp_path):
    """20 秒、3 个硬切（5/10/15 秒）。"""
    path = make_scene_video(tmp_path / "cut.mp4", scene_seconds=5)
    return index_video(init_db, path, 20.0)


@pytest.fixture
def short_video_id(init_db, tmp_path):
    """6 秒、3 个硬切（1.5/3/4.5 秒）。"""
    path = make_scene_video(tmp_path / "short.mp4", scene_seconds=1.5)
    return index_video(init_db, path, 6.0)


@pytest.fixture
def flat_video_id(init_db, tmp_path):
    """6 秒纯色，无镜头切点。"""
    path = tmp_path / "flat.mp4"
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x48:r=10:d=6",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
                   capture_output=True, text=True, check=False)
    return index_video(init_db, path, 6.0)


@pytest.fixture
def image_id(init_db, tmp_path):
    picture = tmp_path / "still.png"
    picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    stat = picture.stat()
    return init_db.main().execute(
        "INSERT INTO images(path,filename,mtime,size_bytes) VALUES(?,?,?,?)",
        (str(picture), picture.name, stat.st_mtime, stat.st_size)).lastrowid


def model_config(client, name="视觉模型"):
    return client.post("/api/model-configs", json={
        "name": name, "base_url": "https://example.com/api/v1", "model": "vision", "timeout": 60}).json()


def fake_frames(path, seconds):
    return [(round(moment, 3), "data:image/jpeg;base64,QUJD") for moment in seconds]


def stub_frames(monkeypatch):
    monkeypatch.setattr(service, "collect_frames", lambda path, seconds: fake_frames(path, seconds))


def stub_model(monkeypatch, payload, captured=None):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)

    async def model(config, key, content, instruction, output_rule=reverse_prompts.OUTPUT_RULE):
        if captured is not None:
            captured.append({"content": content, "instruction": instruction,
                             "system": instruction + output_rule, "output_rule": output_rule})
        return text

    monkeypatch.setattr(reverse_prompts, "request_model", model)


# ---------- 装箱规则（纯函数） ----------


def test_plan_units_single_unit_when_short():
    units = service.plan_units([1.5, 3.0, 4.5], 0, 6000, 15)
    assert len(units) == 1
    assert units[0]["start_ms"] == 0 and units[0]["end_ms"] == 6000
    assert len(units[0]["shots"]) == 4


def test_plan_units_bins_on_cuts_without_overlap():
    units = service.plan_units([5.0, 10.0, 15.0], 0, 20000, 15)
    assert [(u["start_ms"], u["end_ms"]) for u in units] == [(0, 15000), (15000, 20000)]
    assert all(u["end_ms"] - u["start_ms"] <= 15000 for u in units)
    for previous, following in zip(units, units[1:]):
        assert previous["end_ms"] == following["start_ms"]
    assert units[0]["shots"][-1]["end_ms"] == 15000
    assert all(not shot["synthetic"] for unit in units for shot in unit["shots"])


def test_plan_units_splits_single_long_shot_and_marks_synthetic():
    units = service.plan_units([], 0, 40000, 15)
    assert len(units) == 3
    assert all(unit["end_ms"] - unit["start_ms"] <= 15000 for unit in units)
    assert units[0]["shots"][0]["synthetic"] is True
    assert units[-1]["end_ms"] == 40000


def test_plan_units_covers_respects_range_and_cuts_edges():
    units = service.plan_units([5.0, 9.9, 14.0], 2000, 17000, 5)
    assert units[0]["start_ms"] == 2000 and units[-1]["end_ms"] == 17000
    assert all(u["end_ms"] - u["start_ms"] <= 5000 for u in units)
    # 距区间端点不足 0.4 秒的切点被丢弃，不会切出碎段
    assert all(u["end_ms"] - u["start_ms"] >= 400 for u in units)
    boundaries = {u["end_ms"] for u in units}
    assert 5000 in boundaries and 14000 in boundaries


def test_plan_units_merges_short_tail_when_it_fits():
    units = service.plan_units([4.0, 8.0], 0, 10000, 15)
    assert len(units) == 1 and units[0]["end_ms"] == 10000


def test_plan_units_keeps_short_tail_with_warning_when_it_cannot_merge():
    units = service.plan_units([5.0, 10.0, 15.0], 0, 17000, 5)
    assert units[-1]["end_ms"] - units[-1]["start_ms"] == 2000
    assert units[-1]["warn"] == "短于 4 秒"


def test_plan_units_rejects_short_range():
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        service.plan_units([], 0, 1000, 15)
    assert error.value.status_code == 422


def test_check_unit_limit_reports_needed_segments():
    from fastapi import HTTPException

    units = service.plan_units([5.0, 10.0, 15.0], 0, 20000, 5)
    with pytest.raises(HTTPException) as error:
        service.check_unit_limit(units, 1)
    assert error.value.status_code == 422
    assert "需要" in error.value.detail and "上限 1" in error.value.detail


def test_unit_frame_count_formula():
    assert service.unit_frame_count(15, 12) == 10
    assert service.unit_frame_count(5, 12) == 4
    assert service.unit_frame_count(1.2, 12) == 4
    assert service.unit_frame_count(60, 8) == 8


def test_sample_timestamps_stay_inside_range():
    points = service.sample_timestamps(1000, 3000, 4)
    assert len(points) == 4
    assert points[0] > 1.0 and points[-1] < 3.0


# ---------- ffmpeg 镜头切点 ----------


def test_detect_shots_finds_hard_cuts(video_id, init_db):
    path = Path(init_db.main().execute("SELECT path FROM images WHERE id=?", (video_id,)).fetchone()["path"])
    cuts = service.detect_shots(path)
    assert len(cuts) >= 1
    assert all(cut > 0 for cut in cuts)
    assert cuts == sorted(cuts)


def test_detect_shots_returns_empty_for_static_video(flat_video_id, init_db):
    path = Path(init_db.main().execute("SELECT path FROM images WHERE id=?", (flat_video_id,)).fetchone()["path"])
    assert service.detect_shots(path) == []


def test_extract_frame_returns_jpeg_without_touching_cover(video_id, init_db):
    row = init_db.main().execute("SELECT path, cover_path FROM images WHERE id=?", (video_id,)).fetchone()
    raw = service.extract_frame(Path(row["path"]), 1.0)
    assert raw and raw[:2] == b"\xff\xd8"
    assert init_db.main().execute("SELECT cover_path FROM images WHERE id=?", (video_id,)).fetchone()["cover_path"] == row["cover_path"]

# ---------- 设置 ----------


def settings_payload(**overrides):
    base = {"default_model_id": None, "instruction_plan": "方案指令", "instruction_seedance": "即梦指令",
            "instruction_h3": "H3 指令", "default_mode_h3": "t2va", "default_mode_seedance": "t2v",
            "frame_limit": 12, "max_unit_seconds": 15, "max_units": 12}
    return {**base, **overrides}


def test_settings_expose_three_instructions_and_defaults(client):
    payload = client.get("/api/video-prompt-settings").json()
    assert payload["instruction_plan"] == service.DEFAULT_PLAN_INSTRUCTION
    assert payload["instruction_seedance"] == service.DEFAULT_SEEDANCE_INSTRUCTION
    assert payload["instruction_h3"] == service.DEFAULT_H3_INSTRUCTION
    assert payload["defaults"]["max_unit_seconds"] == 15 and payload["defaults"]["max_units"] == 12
    assert payload["default_mode_h3"] == "t2va" and payload["default_mode_seedance"] == "t2v"
    assert set(service.H3_MODES) == {"t2va", "i2va", "fl2va", "ref2va"}
    assert set(service.SEEDANCE_MODES) == {"t2v", "i2v", "flv", "ref"}
    assert service.MODES_BY_TARGET["seedance2"] == service.SEEDANCE_MODES
    # 新默认必须按镜头序号写分镜：2.0 不响应秒级时间轴
    assert "镜头1：" in service.DEFAULT_SEEDANCE_INSTRUCTION
    assert "X-Y 秒" not in service.DEFAULT_SEEDANCE_INSTRUCTION
    assert "保持无字幕" in service.DEFAULT_SEEDANCE_INSTRUCTION


def test_settings_roundtrip_and_validation(client):
    saved = client.put("/api/video-prompt-settings", json=settings_payload(frame_limit=6, max_units=3)).json()
    assert saved["frame_limit"] == 6 and saved["max_units"] == 3 and saved["instruction_h3"] == "H3 指令"
    assert client.put("/api/video-prompt-settings", json=settings_payload(frame_limit=99)).status_code == 422
    assert client.put("/api/video-prompt-settings", json=settings_payload(max_unit_seconds=30)).status_code == 422
    assert client.put("/api/video-prompt-settings", json=settings_payload(default_mode_h3="l2va")).status_code == 422
    assert client.put("/api/video-prompt-settings",
                      json=settings_payload(default_mode_seedance="fl2va")).status_code == 422
    assert client.put("/api/video-prompt-settings",
                      json=settings_payload(default_mode_seedance="flv")).json()["default_mode_seedance"] == "flv"
    assert client.put("/api/video-prompt-settings", json=settings_payload(instruction_plan="  ")).status_code == 422
    assert client.put("/api/video-prompt-settings", json=settings_payload(default_model_id=4242)).status_code == 404


def test_model_resolution_falls_back_to_image_reverse_default(client, short_video_id, monkeypatch):
    stub_frames(monkeypatch)
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []})
    assert client.post(f"/api/videos/{short_video_id}/video-prompts/plans", json={}).status_code == 400
    image_default = model_config(client)
    client.put("/api/reverse-prompt-settings", json={"default_model_id": image_default["id"],
                                                    "instruction": "图片指令"})
    assert client.post(f"/api/videos/{short_video_id}/video-prompts/plans", json={}).status_code == 200


# ---------- 阶段一：分镜方案 ----------


def seed_plan(client, monkeypatch, video_id, anchors="写实风格，16:9，同一女主播"):
    if not client.get("/api/model-configs").json():
        model_config(client)
    stub_frames(monkeypatch)
    stub_model(monkeypatch, {"anchors": anchors, "unit_roles": [], "risk_terms": []})
    response = client.post(f"/api/videos/{video_id}/video-prompts/plans", json={})
    assert response.status_code == 200, response.text
    return response.json()


def test_plan_single_unit_for_short_video_and_ignores_model_boundaries(client, init_db, short_video_id,
                                                       monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    captured = []
    stub_model(monkeypatch, {"anchors": "电影级写实，16:9", "unit_roles": [{"index": 1, "role": "建立场景"},
                                                                          {"index": 99, "role": "越界编号"}],
                             "risk_terms": ["真人 → 写实风格"],
                             "units": [{"index": 1, "start_ms": 0, "end_ms": 999999}]}, captured)
    run = client.post(f"/api/videos/{short_video_id}/video-prompts/plans", json={}).json()
    assert run["status"] == "planned" and run["risk_terms"] == ["真人 → 写实风格"]
    assert run["anchors_text"] == "电影级写实，16:9"
    assert [(u["start_ms"], u["end_ms"]) for u in run["units"]] == [(0, 6000)]
    assert run["units"][0]["role"] == "建立场景"
    assert len(run["units"][0]["shots"]) == 4
    assert "单元 1：0–6 秒" in captured[0]["content"][0]["text"]
    assert captured[0]["output_rule"] == service.PLAN_OUTPUT_RULE
    # 视频请求不能被拼上图片反推的中英双字段规则
    assert "prompt_zh" not in captured[0]["system"]
    stored = init_db.main().execute("SELECT instruction FROM video_prompt_runs WHERE id=?",
                                    (run["id"],)).fetchone()["instruction"]
    assert stored.endswith(service.PLAN_OUTPUT_RULE)


def test_plan_bins_20s_video_into_two_units_with_role_fallback(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    assert [(u["start_ms"], u["end_ms"]) for u in run["units"]] == [(0, 15000), (15000, 20000)]
    assert run["units"][1]["role"]  # 模型没给职责时服务端兜底
    assert run["units"][1]["warn"] is None


def test_plan_sends_frames_and_sound_note(client, short_video_id, monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    captured = []
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []}, captured)
    client.post(f"/api/videos/{short_video_id}/video-prompts/plans",
                json={"sound_note": "女声：我回来了。配乐：钢琴", "start_ms": 1500})
    texts = [part["text"] for part in captured[0]["content"] if part["type"] == "text"]
    assert any("用户提供的真实声音信息" in text and "我回来了" in text for text in texts)
    assert any("反推区间：绝对时间 2–6 秒" in text for text in texts)
    assert sum(1 for part in captured[0]["content"] if part["type"] == "image_url") == service.DEFAULT_FRAME_LIMIT


def test_plan_clamps_requested_range_to_duration(client, short_video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, short_video_id)
    model_config(client)
    captured = []
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []}, captured)
    later = client.post(f"/api/videos/{short_video_id}/video-prompts/plans",
                        json={"start_ms": 4000, "end_ms": 999999}).json()
    assert later["range_start_ms"] == 4000 and later["range_end_ms"] == 6000
    assert run["range_start_ms"] == 0


def test_plan_records_failed_run_when_model_output_is_unusable(client, init_db, short_video_id, monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    stub_model(monkeypatch, "模型开始自由发挥，没有 JSON")
    assert client.post(f"/api/videos/{short_video_id}/video-prompts/plans", json={}).status_code == 502
    row = init_db.main().execute("SELECT status, error FROM video_prompt_runs WHERE video_id=?",
                                 (short_video_id,)).fetchone()
    assert row["status"] == "failed" and "JSON" in row["error"]
    failed = client.get(f"/api/videos/{short_video_id}/video-prompts").json()["runs"][0]
    assert failed["status"] == "failed" and failed["units"] == []
    stub_model(monkeypatch, {"unit_roles": [], "risk_terms": []})
    assert client.post(f"/api/videos/{short_video_id}/video-prompts/plans", json={}).status_code == 502


def test_plan_rejects_when_units_exceed_limit(client, short_video_id, monkeypatch):
    model_config(client)
    client.put("/api/video-prompt-settings", json=settings_payload(max_units=1, max_unit_seconds=5))
    stub_frames(monkeypatch)
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []})
    response = client.post(f"/api/videos/{short_video_id}/video-prompts/plans", json={})
    assert response.status_code == 422
    assert "需要 2 段" in response.json()["detail"]


def test_plan_uses_uniform_frames_when_no_shots(client, flat_video_id, monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    captured = []
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []}, captured)
    run = client.post(f"/api/videos/{flat_video_id}/video-prompts/plans", json={}).json()
    assert len(run["units"]) == 1 and len(run["units"][0]["shots"]) == 1
    assert run["units"][0]["shots"][0]["end_ms"] == 6000


def test_plan_and_history_reject_non_videos(client, image_id, video_id, init_db, monkeypatch):
    assert client.post(f"/api/videos/{image_id}/video-prompts/plans", json={}).status_code == 404
    assert client.get(f"/api/videos/{image_id}/video-prompts").status_code == 404
    assert client.get("/api/videos/99999/video-prompts").status_code == 404
    seed_plan(client, monkeypatch, video_id)
    other = init_db.main().execute(
        "INSERT INTO images(path,filename,mtime,size_bytes,kind,duration_seconds) VALUES(?,?,?,?,?,?)",
        ("X:/missing.mp4", "missing.mp4", 0, 0, "video", 20.0)).lastrowid
    assert client.post(f"/api/videos/{other}/video-prompts/plans", json={}).status_code == 404

# ---------- 阶段二：段正文 ----------

SEEDANCE_OK = (
    "【风格】电影级写实风格，15 秒，16:9，静谧\n\n"
    "【分镜】\n"
    "镜头1：远景，缓慢推镜，女主播走入画面、脚步平稳，从画面右侧走到中部，云层缓慢飘动，<风声>\n"
    "镜头2：中景，跟镜头，女主播驻足回望、嘴角上扬，停在树下，落叶飘散，（钢琴配乐）\n\n"
    "【约束】保持无字幕，不要生成水印，不要生成 Logo，人物服饰全程保持一致"
)
SEEDANCE_REF_OK = (
    "【风格】电影级写实风格，15 秒，16:9，静谧\n\n"
    "【主体】\n"
    "@图片1 中的绿发、白衬衫、背帆布包的年轻女人定义为主角\n"
    "@图片2 中的江边步道与芦苇定义为本段场景\n"
    "@音频1 参考它的低厚男声音色\n\n"
    "【分镜】\n"
    "镜头1：全景，缓慢推镜，主角@图片1 沿步道走来、步伐轻快，江面有货轮驶过，<江水拍岸>\n"
    "镜头2：近景，固定镜头，主角@图片1 停下、望向远处，芦苇随风摇曳，（轻钢琴）\n\n"
    "【约束】保持无字幕，不要生成水印，不要生成 Logo"
)
H3_OK = (
    "integrated_multimodal_description: [Shot 1] Cinematic, a young woman stands by the rain-covered window.\n\n"
    "overall_soundscape: Rain taps the glass while room ambience continues.\n\n"
    "non_diegetic_music: N/A"
)
I2VA_LINE = ("For the target video, at 0.00 seconds into the target video, "
             "<Picture 1> (from [Shot 1]) is fully referenced.")


def plan_url(video_id):
    return f"/api/videos/{video_id}/video-prompts"


def segment_url(video_id, run_id, index):
    return f"{plan_url(video_id)}/runs/{run_id}/segments/{index}"


def generate(client, video_id, run_id, index, target, mode=None):
    body = {"target": target}
    if mode:
        body["mode"] = mode
    response = client.post(segment_url(video_id, run_id, index), json=body)
    assert response.status_code == 200, response.text
    return response.json()


def frame_labels(content):
    text = "\n".join(part["text"] for part in content if part["type"] == "text")
    return [float(match.group(1)) for match in re.finditer(r"帧 \d+ @([0-9]+\.[0-9]{2}) 秒", text)]


def test_segment_seedance_first_unit_vs_follow_up(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    captured = []
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": ["真实 → 写实风格"]}, captured)
    first = generate(client, video_id, run["id"], 1, "seedance2")
    assert first["status"] == "complete" and first["target"] == "seedance2"
    assert first["mode"] == "t2v" and first["references"] == []
    assert first["risk_terms"] == ["真实 → 写实风格"]
    texts = [part["text"] for part in captured[0]["content"] if part["type"] == "text"]
    # 文生视频不传素材：要明说不许出现 @ 引用，也不能提上一段续接
    assert any("正文不要出现任何 @ 素材引用" in text for text in texts)
    assert "正文不得出现 @图片 / @视频 / @音频" in captured[0]["instruction"]
    assert any("段内镜头数：3 个" in text for text in texts)
    assert any("镜头1：…镜头3：" in text for text in texts)
    assert "Seedance 2.0 文生视频（t2v）附加要求" in captured[0]["instruction"]
    assert any("中文分块提示词（t2v 模式）" in text for text in texts)
    assert not any("将@视频 1 延长" in text for text in texts)

    second = generate(client, video_id, run["id"], 2, "seedance2")
    assert second["segment_index"] == 2
    texts = [part["text"] for part in captured[1]["content"] if part["type"] == "text"]
    assert any("独立成片的文生视频" in text for text in texts)
    assert not any("将@视频 1 延长" in text for text in texts)


def test_segment_frames_are_unit_scoped_with_relative_time(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    captured = []
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []}, captured)
    generate(client, video_id, run["id"], 1, "seedance2")
    generate(client, video_id, run["id"], 2, "seedance2")
    assert sum(1 for part in captured[0]["content"] if part["type"] == "image_url") == service.unit_frame_count(15, 12)
    assert sum(1 for part in captured[1]["content"] if part["type"] == "image_url") == service.unit_frame_count(5, 12)
    first_labels = frame_labels(captured[0]["content"])
    assert first_labels and all(0 <= label < 15.0 for label in first_labels)
    second_labels = frame_labels(captured[1]["content"])
    assert second_labels and all(0 <= label < 5.0 for label in second_labels)
    assert second_labels == sorted(second_labels)
    header = captured[1]["content"][0]["text"]
    assert "对应原片 15–20 秒" in header and "本段生成时长 5 秒" in header
    assert "段内镜头切分（秒）：0 | 5" in header
    assert "全局一致性锚点" in header and "写实风格，16:9" in header


@pytest.mark.parametrize("mode,expected_first", [
    ("t2va", "integrated_multimodal_description:"),
    ("i2va", "For the target video, at 0.00 seconds into the target video,"),
    ("fl2va", "How the reference pictures align with the target video"),
])
def test_segment_h3_first_line_is_server_generated(client, video_id, monkeypatch, mode, expected_first):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "h3", mode)
    assert record["status"] == "complete"
    assert record["prompt"].splitlines()[0].startswith(expected_first)
    if mode == "fl2va":
        assert "Picture 2 (from Shot 3) aligns with the 15.00-second mark" in record["prompt"]


def test_segment_h3_replaces_wrong_alignment_line_and_uses_unit_duration(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    sloppy = I2VA_LINE.replace("0.00 seconds", "9.99 seconds") + "\n\n" + H3_OK
    stub_model(monkeypatch, {"prompt": sloppy, "risk_terms": []})
    first = generate(client, video_id, run["id"], 1, "h3", "i2va")
    assert first["prompt"].splitlines()[0] == I2VA_LINE
    follow = generate(client, video_id, run["id"], 2, "h3", "fl2va")
    assert follow["prompt"].splitlines()[0] == (
        "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with "
        "the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the "
        "5.00-second mark of the target video.")
    assert follow["prompt"].count("integrated_multimodal_description:") == 1


def test_segment_status_warning_and_unstructured_keep_history(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": "【风格】写实风格，15 秒，16:9\n\n【声音】风声", "risk_terms": []})
    warning = generate(client, video_id, run["id"], 1, "seedance2")
    assert warning["status"] == "format_warning" and "【分镜】" not in warning["prompt"]
    stub_model(monkeypatch, "模型直接输出了散文，不是 JSON")
    loose = generate(client, video_id, run["id"], 2, "seedance2")
    assert loose["status"] == "unstructured" and loose["prompt"] == ""
    assert loose["raw_text"].startswith("模型直接输出")
    assert client.get(plan_url(video_id)).json()["running"] is False


def test_segment_rejects_unknown_target_mode_and_missing_unit(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    assert client.post(segment_url(video_id, run["id"], 1), json={"target": "kling"}).status_code == 422
    assert client.post(segment_url(video_id, run["id"], 1),
                       json={"target": "h3", "mode": "l2va"}).status_code == 422
    # 模式按目标格式各自的清单校验：H3 的模式不能拿来生成 Seedance 正文
    assert client.post(segment_url(video_id, run["id"], 1),
                       json={"target": "seedance2", "mode": "fl2va"}).status_code == 422
    assert client.post(segment_url(video_id, run["id"], 1),
                       json={"target": "seedance2", "mode": "ref"}).status_code == 200
    assert client.post(segment_url(video_id, run["id"], 9),
                       json={"target": "seedance2"}).status_code == 404
    assert client.post(segment_url(video_id, 999999, 1), json={"target": "seedance2"}).status_code == 404


def test_segment_requires_planned_run(client, init_db, short_video_id, monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    stub_model(monkeypatch, "没有 JSON")
    assert client.post(plan_url(short_video_id) + "/plans", json={}).status_code == 502
    failed_run = init_db.main().execute("SELECT id FROM video_prompt_runs WHERE video_id=?",
                                       (short_video_id,)).fetchone()["id"]
    assert client.post(segment_url(short_video_id, failed_run, 1),
                       json={"target": "seedance2"}).status_code == 409


# ---------- 版本链与历史 ----------


def test_two_targets_share_one_plan_with_independent_versions(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    seedance = generate(client, video_id, run["id"], 1, "seedance2")
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    h3 = generate(client, video_id, run["id"], 1, "h3", "i2va")
    assert h3["prompt"].startswith("For the target video")

    listing = client.get(plan_url(video_id)).json()
    assert listing["total"] == 1
    current_run = listing["runs"][0]
    assert set(current_run["units"][0]["current"]) == {"seedance2", "h3"}
    assert current_run["anchors_text"] == "写实风格，16:9，同一女主播"

    edited = client.post(segment_url(video_id, run["id"], 1) + "/edits",
                         json={"target": "seedance2",
                               "prompt": "【风格】改过的风格，15 秒，16:9，安静\n\n【时间轴】\n"
                                         "0-15 秒：远景，推镜头，人物走入，云动，硬切，风声"}).json()
    assert edited["source"] == "edited" and edited["parent_id"] == seedance["id"]
    after = client.get(plan_url(video_id)).json()["runs"][0]
    assert after["units"][0]["current"]["seedance2"]["id"] == edited["id"]
    assert after["units"][0]["current"]["h3"]["id"] == h3["id"]
    assert after["versions"] == {"seedance2": 2, "h3": 1}


def test_segment_records_lists_versions_newest_first(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    first = generate(client, video_id, run["id"], 1, "seedance2")
    edited = client.post(segment_url(video_id, run["id"], 1) + "/edits",
                         json={"target": "seedance2",
                               "prompt": "【风格】改过的风格，15 秒，16:9，安静\n\n【时间轴】\n"
                                         "0-15 秒：远景，推镜头，人物走入，云动，硬切，风声"}).json()
    listing = client.get(segment_url(video_id, run["id"], 1) + "/records?target=seedance2").json()
    assert [r["id"] for r in listing["records"]] == [edited["id"], first["id"]]
    assert listing["records"][0]["source"] == "edited"
    assert listing["total"] == 2
    assert client.get(segment_url(video_id, run["id"], 1) + "/records?target=h3").json()["records"] == []
    assert client.get(segment_url(video_id, run["id"], 1) + "/records?target=nope").status_code == 422
    assert client.get(segment_url(video_id, run["id"], 9) + "/records?target=seedance2").status_code == 404


def test_edit_rejects_blank_missing_version_and_bad_target(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 1, "seedance2")
    assert client.post(segment_url(video_id, run["id"], 1) + "/edits",
                       json={"target": "seedance2", "prompt": "   "}).status_code == 422
    assert client.post(segment_url(video_id, run["id"], 1) + "/edits",
                       json={"target": "h3", "prompt": "正文"}).status_code == 404
    assert client.post(segment_url(video_id, run["id"], 2) + "/edits",
                       json={"target": "seedance2", "prompt": "正文"}).status_code == 404


def test_history_lists_multiple_runs_with_pagination(client, video_id, monkeypatch):
    first = seed_plan(client, monkeypatch, video_id)
    second_plan = client.post(plan_url(video_id) + "/plans", json={}).json()
    assert second_plan["id"] != first["id"]
    page = client.get(f"{plan_url(video_id)}?limit=1").json()
    assert page["total"] == 2 and len(page["runs"]) == 1
    assert page["runs"][0]["id"] == second_plan["id"]


def test_listing_flags_changed_video(client, video_id, init_db, monkeypatch):
    path = Path(init_db.main().execute("SELECT path FROM images WHERE id=?", (video_id,)).fetchone()["path"])
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "seedance2")
    assert record["video_changed"] is False
    path.write_bytes(path.read_bytes() + b"\0")
    shown = client.get(plan_url(video_id)).json()["runs"][0]
    assert shown["video_changed"] is True
    assert shown["units"][0]["current"]["seedance2"]["video_changed"] is True


def test_frame_endpoint_clamps_timestamp(client, video_id, flat_video_id):
    payload = client.get(f"/api/videos/{video_id}/frame?at=999").json()
    # 片尾取帧会退到最后一个可解码时刻（20 秒 - 0.25 秒余量）
    assert payload["at"] == 19.75 and payload["data_url"].startswith("data:image/jpeg;base64,")
    assert client.get(f"/api/videos/{video_id}/frame?at=0").json()["at"] == 0.0
    assert client.get(f"/api/videos/{video_id}/frame?at=-1").status_code == 422
    assert client.get(f"/api/videos/{flat_video_id}/frame?at=2").json()["at"] == 2.0
    assert client.get("/api/videos/99999/frame?at=1").status_code == 404


# ---------- 参考帧：提示词引用的 @图片 1 / <Picture 1> ----------


def frame_files(video_id, run_id, index, edge):
    from app.config import previews_dir

    return sorted(previews_dir().glob(service.frame_pattern(video_id, run_id, index, edge)))


def frame_url(video_id, run_id, index, edge="first"):
    return f"{plan_url(video_id)}/runs/{run_id}/segments/{index}/frame?which={edge}"


def test_edge_seconds_leaves_tail_margin():
    unit = {"start_ms": 15000, "end_ms": 22000}
    assert service.edge_seconds(unit, "first") == 15.0
    assert service.edge_seconds(unit, "last") == 21.75


def test_plan_primes_reference_frames_for_every_unit(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    assert len(run["units"]) == 2
    for unit in run["units"]:
        for edge in service.FRAME_EDGES:
            assert frame_files(video_id, run["id"], unit["index"], edge), (unit["index"], edge)
    assert run["units"][0]["frames"]["first"]["at"] == 0.0
    assert run["units"][0]["frames"]["last"]["at"] == pytest.approx(14.75, abs=0.6)
    assert run["units"][1]["frames"]["first"]["at"] == pytest.approx(15.0, abs=0.6)


def test_segment_frame_endpoint_serves_cached_reference(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    head = client.get(frame_url(video_id, run["id"], 1)).json()
    assert head["edge"] == "first" and head["source"] == "cache" and head["at"] == 0.0
    assert head["data_url"].startswith("data:image/jpeg;base64,")
    tail = client.get(frame_url(video_id, run["id"], 1, "last")).json()
    assert tail["source"] == "cache" and tail["requested_at"] == 14.75


def test_segment_frame_endpoint_reextracts_when_cache_is_gone(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    for stale in frame_files(video_id, run["id"], 2, "last"):
        stale.unlink()
    assert not frame_files(video_id, run["id"], 2, "last")
    payload = client.get(frame_url(video_id, run["id"], 2, "last")).json()
    assert payload["source"] == "video"
    assert frame_files(video_id, run["id"], 2, "last"), "重新取的帧要落盘，别让前端反复触发 ffmpeg"


def test_segment_frame_endpoint_validates_request(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    assert client.get(frame_url(video_id, run["id"], 1, "middle")).status_code == 422
    assert client.get(frame_url(video_id, run["id"], 99)).status_code == 404
    assert client.get(frame_url(video_id, 99999, 1)).status_code == 404


def test_reference_frames_never_touch_the_custom_cover(client, video_id, monkeypatch):
    from app.config import previews_dir

    cover = previews_dir() / f"{video_id}_cover.webp"
    cover.write_bytes(b"FAKE-COVER")
    run = seed_plan(client, monkeypatch, video_id)
    client.get(frame_url(video_id, run["id"], 1, "last"))
    assert cover.read_bytes() == b"FAKE-COVER"


def test_frame_cache_scan_matches_per_file_lookup(client, video_id, monkeypatch):
    from app.config import previews_dir

    run = seed_plan(client, monkeypatch, video_id)
    cache = service.scan_frame_cache(video_id)
    for unit in run["units"]:
        for edge in service.FRAME_EDGES:
            path, stamp = cache[(run["id"], unit["index"], edge)]
            assert path.exists() and path.name.startswith(f"{video_id}_vp{run['id']}_")
            assert service.find_frame(video_id, run["id"], unit["index"], edge, cache)[1] == stamp
    assert service.scan_frame_cache(999999) == {}


def test_reextracted_frame_replaces_its_cache_file(client, video_id, monkeypatch):
    from app.config import previews_dir

    run = seed_plan(client, monkeypatch, video_id)
    target = frame_files(video_id, run["id"], 1, "first")[0]
    stale = previews_dir() / f"{video_id}_vp{run['id']}_01first_9.99.jpg"
    target.unlink()
    stale.write_bytes(b"")  # 坏缓存（空文件）+ 秒数不同，都要被重新取的帧替掉
    monkeypatch.setattr(service, "extract_frame_near", lambda path, seconds: (b"NEWHDR", 1.23))
    payload = client.get(frame_url(video_id, run["id"], 1)).json()
    assert payload["at"] == 1.23 and payload["source"] == "video"
    kept = frame_files(video_id, run["id"], 1, "first")
    assert [f.name for f in kept] == [f"{video_id}_vp{run['id']}_01first_1.23.jpg"]


def test_deleting_video_purges_reference_frame_cache(client, init_db, video_id, monkeypatch):
    from app import repository
    from app.config import previews_dir

    run = seed_plan(client, monkeypatch, video_id)
    assert frame_files(video_id, run["id"], 1, "first")
    cleaned = repository.delete_image_files(video_id)
    assert cleaned["cleaned_previews"] >= 2 * len(run["units"])
    assert not list(previews_dir().glob(f"{video_id}_vp*.jpg"))


# ---------- 并发 ----------


def test_locks_are_per_target_not_per_segment():
    service.acquire_segment(7, 1, "h3", 55)
    service.acquire_segment(7, 1, "seedance2", 55)
    assert set(service.busy_for_video(55)["segments"]) == {"7:1:h3", "7:1:seedance2"}
    service.release_segment(7, 1, "h3")
    assert service.busy_for_video(55)["segments"] == ["7:1:seedance2"]
    service.release_segment(7, 1, "seedance2")
    assert service.busy_for_video(55) == {"plan": False, "segments": []}


async def test_plan_conflict_while_running(client, short_video_id, monkeypatch):
    from fastapi import HTTPException

    from app.routes.video_prompts import PlanInput, create_plan

    model_config(client)
    stub_frames(monkeypatch)
    entered, finish = asyncio.Event(), asyncio.Event()

    async def wait(*args, **kwargs):
        entered.set()
        await finish.wait()
        return '{"anchors":"锚点","unit_roles":[],"risk_terms":[]}'

    monkeypatch.setattr(reverse_prompts, "request_model", wait)
    pending = asyncio.create_task(create_plan(short_video_id, PlanInput()))
    await entered.wait()
    with pytest.raises(HTTPException) as conflict:
        await create_plan(short_video_id, PlanInput())
    assert conflict.value.status_code == 409
    finish.set()
    assert (await pending)["status"] == "planned"


async def test_segment_conflict_is_per_format(client, video_id, monkeypatch):
    from fastapi import HTTPException

    from app.routes.video_prompts import SegmentInput, generate_segment

    run = seed_plan(client, monkeypatch, video_id)
    entered, finish = asyncio.Event(), asyncio.Event()

    async def wait(*args, **kwargs):
        entered.set()
        await finish.wait()
        return json.dumps({"prompt": H3_OK if kwargs.get("output_rule") == service.SEGMENT_OUTPUT_RULE else "",
                           "risk_terms": []})

    monkeypatch.setattr(reverse_prompts, "request_model", wait)
    pending_h3 = asyncio.create_task(
        generate_segment(video_id, run["id"], 1, SegmentInput(target="h3", mode="t2va")))
    await entered.wait()
    with pytest.raises(HTTPException) as conflict:
        await generate_segment(video_id, run["id"], 1, SegmentInput(target="h3", mode="i2va"))
    assert conflict.value.status_code == 409
    other = asyncio.create_task(generate_segment(video_id, run["id"], 1, SegmentInput(target="seedance2")))
    done, _ = await asyncio.wait({other}, timeout=0.2)
    assert not done  # 另一个格式不被挡住
    finish.set()
    assert (await pending_h3)["target"] == "h3"
    assert (await other)["target"] == "seedance2"

# ---------- 整数秒：界面、分段边界与正文共用同一口径 ----------


def test_seconds_are_whole_numbers():
    assert service.sec_text(15116) == "15" and service.sec_text(11300) == "11"
    assert service.snap_second(15116) == 15000 and service.snap_second(400) == 0


def test_plan_units_boundaries_land_on_whole_seconds():
    units = service.plan_units([4.7, 11.266, 19.99], 0, 15116, 15)
    assert units[0]["end_ms"] == 15000  # 15.116 秒的视频不写出 15.116 秒的段
    for unit in units:
        assert unit["start_ms"] % 1000 == 0 and unit["end_ms"] % 1000 == 0
        for shot in unit["shots"]:
            assert shot["start_ms"] % 1000 == 0 and shot["end_ms"] % 1000 == 0


def test_plan_snaps_requested_range_to_whole_seconds(client, video_id, monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    captured = []
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []}, captured)
    run = client.post(plan_url(video_id) + "/plans", json={"start_ms": 3400, "end_ms": 18600}).json()
    assert (run["range_start_ms"], run["range_end_ms"]) == (3000, 19000)
    assert any("反推区间：绝对时间 3–19 秒" in part["text"] for part in captured[0]["content"]
               if part["type"] == "text")


def test_default_end_second_stays_inside_the_video(client, video_id, init_db, monkeypatch):
    init_db.main().execute("UPDATE images SET duration_seconds=15.116 WHERE id=?", (video_id,))
    run = seed_plan(client, monkeypatch, video_id)
    assert run["range_end_ms"] == 15000 and run["units"][-1]["end_ms"] == 15000


def test_time_rule_reaches_both_stages(client, video_id, monkeypatch):
    model_config(client)
    stub_frames(monkeypatch)
    plan_capture = []
    stub_model(monkeypatch, {"anchors": "锚点", "unit_roles": [], "risk_terms": []}, plan_capture)
    run = client.post(plan_url(video_id) + "/plans", json={}).json()
    assert "所有秒数一律写整数" in plan_capture[0]["instruction"]
    segment_capture = []
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []}, segment_capture)
    generate(client, video_id, run["id"], 1, "seedance2")
    header = segment_capture[0]["content"][0]["text"]
    # Seedance 的秒数口径是「分镜行不写秒数」，H3 的口径才是整数时间戳
    assert "【分镜】每行不写任何秒数" in segment_capture[0]["instruction"]
    assert "At MM:SS.000" not in segment_capture[0]["instruction"]
    assert "段内镜头切分（秒）：0 | 5 | 10 | 15" in header
    assert "对应原片 0–15 秒；本段生成时长 15 秒" in header
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []}, segment_capture)
    generate(client, video_id, run["id"], 1, "h3", "fl2va")
    assert "At MM:SS.000" in segment_capture[1]["instruction"]
    assert "【分镜】每行不写任何秒数" not in segment_capture[1]["instruction"]


def test_only_the_selected_mode_rule_reaches_the_model(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    captured = []
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []}, captured)
    generate(client, video_id, run["id"], 1, "seedance2", "i2v")
    instruction = captured[0]["instruction"]
    assert "图生视频·首帧（i2v）附加要求" in instruction
    assert "全能参考（ref）附加要求" not in instruction
    assert "Ref2VA (full-reference generation)" not in instruction
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []}, captured)
    generate(client, video_id, run["id"], 1, "h3", "fl2va")
    assert "Ref2VA (full-reference generation)" not in captured[1]["instruction"]


# ---------- 译文：一键中英互译，复制走的仍是原文 ----------


def translation_url(video_id, run_id, index):
    return f"{segment_url(video_id, run_id, index)}/translations"


def test_translation_helpers_detect_language_and_strip_wrappers():
    assert service.dominant_language(H3_OK) == "en"
    assert service.dominant_language("【风格】写实风格，女主播走入画面") == "zh"
    assert service.translation_language(SEEDANCE_OK) == "en"
    assert service.clean_translation("```json\n译文：A host walks in.\n```") == "A host walks in."
    assert service.clean_translation("译文：  A host walks in.") == "A host walks in."
    assert service.clean_translation("```markdown\n\nA host.\n\n```") == "A host."


def test_translation_follows_body_language_and_is_cached_per_version(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "h3", "t2va")
    assert record["translation"] is None
    captured = []
    stub_model(monkeypatch, "【风格】写实风格，15 秒，16:9，静谧\n\n【声音】环境风", captured)
    result = client.post(translation_url(video_id, run["id"], 1), json={"target": "h3"})
    assert result.status_code == 200
    body = result.json()
    assert body["language"] == "zh" and body["source"] == "model"
    assert body["text"].startswith("【风格】")
    assert captured[0]["content"] == [{"type": "text", "text": record["prompt"]}]
    assert captured[0]["output_rule"] == service.TRANSLATION_OUTPUT_RULE
    assert "结构标记与占位符原样保留" in captured[0]["instruction"]

    again = client.post(translation_url(video_id, run["id"], 1), json={"target": "h3"}).json()
    assert again["source"] == "cache" and again["text"] == body["text"]
    assert len(captured) == 1  # 再点一次按钮直接读缓存，不再花一次调用

    shown = client.get(plan_url(video_id)).json()["runs"][0]
    assert shown["units"][0]["current"]["h3"]["translation"]["language"] == "zh"


def test_chinese_prompt_translates_to_english_and_edits_get_a_clean_version(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 1, "seedance2")
    stub_model(monkeypatch, "Style: realistic, 15 s\n\nSound: wind")
    result = client.post(translation_url(video_id, run["id"], 1), json={"target": "seedance2"}).json()
    assert result["language"] == "en" and result["text"].startswith("Style:")
    edited = client.post(segment_url(video_id, run["id"], 1) + "/edits",
                         json={"target": "seedance2", "prompt": "【风格】改过的风格"}).json()
    assert edited["translation"] is None  # 新版本是新内容，不继承旧译文
    versions = client.get(segment_url(video_id, run["id"], 1) + "/records?target=seedance2").json()["records"]
    assert versions[1]["translation"]["language"] == "en"  # 老版本的译文留着


def test_translation_rejects_bad_requests_and_empty_bodies(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    assert client.post(translation_url(video_id, run["id"], 1), json={"target": "kling"}).status_code == 422
    assert client.post(translation_url(video_id, run["id"], 1), json={"target": "h3"}).status_code == 404
    assert client.post(translation_url(video_id, run["id"], 9), json={"target": "h3"}).status_code == 404
    stub_model(monkeypatch, "   ")
    blank = generate(client, video_id, run["id"], 1, "seedance2")
    assert blank["status"] == "unstructured" and blank["raw_text"] == ""
    assert client.post(translation_url(video_id, run["id"], 1), json={"target": "seedance2"}).status_code == 422
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 2, "h3", "t2va")
    stub_model(monkeypatch, "译文：  ")
    assert client.post(translation_url(video_id, run["id"], 2), json={"target": "h3"}).status_code == 502


async def test_translation_conflict_while_running(client, video_id, monkeypatch):
    from fastapi import HTTPException

    from app.routes.video_prompts import TranslationInput, translate_segment

    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 1, "h3", "t2va")
    entered, finish = asyncio.Event(), asyncio.Event()

    async def wait(*args, **kwargs):
        entered.set()
        await finish.wait()
        return "【风格】写实风格"

    monkeypatch.setattr(reverse_prompts, "request_model", wait)
    pending = asyncio.create_task(translate_segment(video_id, run["id"], 1, TranslationInput(target="h3")))
    await entered.wait()
    with pytest.raises(HTTPException) as conflict:
        await translate_segment(video_id, run["id"], 1, TranslationInput(target="h3"))
    assert conflict.value.status_code == 409
    finish.set()
    assert (await pending)["language"] == "zh"


# ---------- 本段需要哪些参考素材 ----------


REF2VA_OK = (
    "subject_definitions:\n"
    "<Picture 1> is reference image 1 to upload: the last frame of the previously generated "
    "segment, used as the first frame of this segment.\n"
    "<Picture 2> is reference image 2 to upload: front-facing full-body view of the green-haired "
    "young woman on a plain background, used by <Subject 1>.\n"
    "<Subject 1> the green-haired young woman, referenced from <Picture 2>.\n\n"
    "summary: [reference generation] <Subject 1> appears in every shot, <Picture 9> is unused.\n\n"
    "retention_analysis: <Picture 2> is fully preserved.\n\n"
    "detailed_description: [Shot 1] Static Shot at slow speed, <Subject 1> raises her hand.\n\n"
    "overall_soundscape: Wind ambience and cloth rustle.\n\n"
    "non_diegetic_music: N/A"
)

UNIT_FIRST = {"index": 1, "start_ms": 0, "end_ms": 15000, "shots": []}
UNIT_FOLLOW = {"index": 2, "start_ms": 15000, "end_ms": 20000, "shots": []}


def test_references_for_seedance_modes():
    # 文生视频什么都不用传，列出来只会让用户白找文件
    assert service.references_for(SEEDANCE_OK, target="seedance2", mode="t2v", unit=UNIT_FIRST) == []
    # 图生视频·首帧：只有 @图片1，第一段的图本工具直接给
    i2v = service.references_for(SEEDANCE_OK, target="seedance2", mode="i2v", unit=UNIT_FIRST)
    assert [item["label"] for item in i2v] == ["@图片1"]
    assert i2v[0]["frame"] == {"index": 1, "edge": "first"} and i2v[0]["warn"] is None
    chain = service.references_for(SEEDANCE_OK, target="seedance2", mode="i2v", unit=UNIT_FOLLOW)
    assert chain[0]["frame"] == {"index": 2, "edge": "first"}
    assert "上一段生成结果的最后一帧" in chain[0]["what"]
    assert "先跑完上一段" in chain[0]["warn"]
    # 首尾帧：两张图，位置就是本段的首尾
    flv = service.references_for(SEEDANCE_OK, target="seedance2", mode="flv", unit=UNIT_FIRST)
    assert [item["label"] for item in flv] == ["@图片1", "@图片2"]
    assert flv[0]["frame"] == {"index": 1, "edge": "first"}
    assert flv[1]["frame"] == {"index": 1, "edge": "last"}
    # 全能参考：正文写了几个编号就要几个文件，模型给的中文说明优先
    refs = service.references_for(SEEDANCE_REF_OK, target="seedance2", mode="ref", unit=UNIT_FIRST,
                                  notes=[{"slot": "@图片2", "zh": "江边步道实景照，作场景参考"}])
    assert [item["label"] for item in refs] == ["@图片 1", "@图片 2", "@音频 1"]
    assert [item["slot"] for item in refs] == ["picture", "picture", "audio"]
    assert refs[1]["what"] == "江边步道实景照，作场景参考"
    assert refs[2]["frame"] is None
    assert all(re.search(r"[\u4e00-\u9fff]", item["what"]) for item in refs)


def test_references_for_seedance_continuation_and_slot_limit():
    follow = service.references_for("【主体】\n@视频1 参考它的运镜\n\n【分镜】\n镜头1：中景，跟镜，"
                                    "人继续往前走，衣摆飘动，<脚步声>",
                                    target="seedance2", mode="ref", unit=UNIT_FOLLOW)
    assert [item["label"] for item in follow] == ["@视频 1"]
    assert follow[0]["slot"] == "video" and follow[0]["frame"] is None
    assert "先跑完上一段" in follow[0]["warn"]
    many = "【主体】\n" + "\n".join(f"@图片{i} 的特征{i} 定义为主体{i}" for i in range(1, 11))
    over = service.references_for(many, target="seedance2", mode="ref", unit=UNIT_FIRST)
    assert len(over) == 10 and over[0]["frame"] == {"index": 1, "edge": "first"}
    assert "上限 9" in over[0]["warn"]


def test_references_for_legacy_seedance_records_follow_the_prompt():
    refs = service.references_for("【参考】@图片 1 作为首帧，@音频 2 是配乐",
                                  target="seedance2", mode=None, unit=UNIT_FIRST)
    assert [item["label"] for item in refs] == ["@图片 1", "@音频 2"]
    assert [item["slot"] for item in refs] == ["picture", "audio"]
    assert refs[0]["frame"] == {"index": 1, "edge": "first"} and refs[1]["frame"] is None
    follow = service.references_for("将@视频 1 延长 5 秒\n\n【参考】@视频 1 为上一段生成结果",
                                    target="seedance2", mode=None, unit=UNIT_FOLLOW)
    assert [item["label"] for item in follow] == ["@视频 1"]
    assert follow[0]["slot"] == "video"
    assert follow[0]["frame"] is None and "上一段" in follow[0]["warn"]
    # 老正文没写【参考】时也要给出该上传什么
    bare = service.references_for("【风格】写实风格，15 秒，16:9", target="seedance2",
                                  mode=None, unit=UNIT_FIRST)
    assert [item["label"] for item in bare] == ["@图片 1"]


def test_valid_prompt_checks_shot_lines_and_per_mode_asset_discipline():
    assert service.valid_prompt(SEEDANCE_OK, "seedance2", "t2v")
    assert service.valid_prompt(SEEDANCE_OK, "seedance2", "i2v")  # 首帧靠上传，正文没 @ 也算对
    assert service.valid_prompt(SEEDANCE_OK + "\n@图片3 备用", "seedance2", "i2v") is False
    assert service.valid_prompt(SEEDANCE_OK + "\n@图片2 尾帧", "seedance2", "flv")
    assert service.valid_prompt(SEEDANCE_OK + "\n@图片3 尾帧", "seedance2", "flv") is False
    assert service.valid_prompt(SEEDANCE_OK, "seedance2", "ref") is False  # 全参考要交代每个编号
    assert service.valid_prompt(SEEDANCE_REF_OK, "seedance2", "ref")
    assert service.valid_prompt(SEEDANCE_OK, "seedance2", "t2v")
    seconds = ("【风格】写实，15 秒，16:9\n\n【分镜】\n"
               "0-15 秒：远景，推镜，人走来，云动，<风声>")
    assert service.valid_prompt(seconds, "seedance2", "t2v") is False  # 2.0 不认秒级时间轴
    assert service.valid_prompt("【风格】写实\n\n【分镜】\n没有镜头行", "seedance2", "t2v") is False
    assert service.valid_prompt("【风格】写实\n\n【时间轴】\n0-15 秒：远景，推镜", "seedance2", "t2v") is False


def test_mode_rules_and_slot_limits_come_from_the_official_spec():
    assert service.SEEDANCE_SLOT_LIMITS == {"图片": 9, "视频": 3, "音频": 3}
    assert service.SEEDANCE_FILE_LIMIT == 12
    assert set(service.SEEDANCE_MODE_RULES) == set(service.SEEDANCE_MODES)
    assert service.MODE_DEFAULTS == {"seedance2": "t2v", "h3": "t2va"}
    assert service.mode_rule("seedance2", "flv") == service.SEEDANCE_MODE_RULES["flv"]
    assert service.mode_rule("seedance2", "t2v") != ""
    assert service.mode_rule("h3", "i2va") == ""
    assert service.mode_rule("h3", "ref2va") == service.REF2VA_RULE
    assert service.mode_rule("seedance2", "ref2va") == ""
    # 首尾帧不能混参考图，全能参考要写编号纪律
    assert "不得出现 @图片3" in service.SEEDANCE_MODE_RULES["flv"]
    assert "不超过 12 个文件" in service.SEEDANCE_MODE_RULES["ref"]
    assert "「参考」" in service.continuity_note("seedance2", "ref", UNIT_FOLLOW)


def test_mode_columns_and_untouched_defaults_upgrade(init_db):
    conn = init_db.main()
    # 造一个 0.2.22 的库：列名退回旧名，指令换成当时的默认原文
    conn.execute("ALTER TABLE video_prompt_records RENAME COLUMN mode TO h3_mode")
    conn.execute("ALTER TABLE video_prompt_settings RENAME COLUMN default_mode_h3 TO default_h3_mode")
    conn.execute("ALTER TABLE video_prompt_settings DROP COLUMN default_mode_seedance")
    conn.execute("UPDATE video_prompt_settings SET default_h3_mode='ref2va', instruction_plan=?,"
                 "instruction_seedance=?",
                 (legacy.LEGACY_DEFAULT_PLAN_INSTRUCTION, legacy.LEGACY_DEFAULT_SEEDANCE_INSTRUCTION))
    video = conn.execute("INSERT INTO images(path,filename,mtime,size_bytes,kind,duration_seconds) "
                         "VALUES('X:/legacy.mp4','legacy.mp4',0,0,'video',20.0)").lastrowid
    run = conn.execute("INSERT INTO video_prompt_runs(video_id,range_start_ms,range_end_ms,status,"
                       "frame_limit,max_unit_seconds) VALUES(?,?,20000,'planned',12,15)",
                       (video, 0)).lastrowid
    conn.execute("INSERT INTO video_prompt_records(run_id,segment_index,target,h3_mode,prompt,status,source)"
                 " VALUES(?,1,'seedance2',NULL,'老正文','complete','generated')", (run,))

    service.initialize(conn)
    service.initialize(conn)  # 幂等：第二次不该再改任何东西

    settings_cols = {row["name"] for row in
                     conn.execute("PRAGMA table_info(video_prompt_settings)").fetchall()}
    record_cols = {row["name"] for row in
                   conn.execute("PRAGMA table_info(video_prompt_records)").fetchall()}
    assert {"default_mode_h3", "default_mode_seedance"} <= settings_cols
    assert "default_h3_mode" not in settings_cols and "h3_mode" not in record_cols
    row = conn.execute("SELECT * FROM video_prompt_settings WHERE id=1").fetchone()
    assert row["default_mode_h3"] == "ref2va"  # 用户挑过的默认模式要留着
    assert row["default_mode_seedance"] == "t2v"
    assert row["instruction_seedance"] == service.DEFAULT_SEEDANCE_INSTRUCTION  # 没改过的才升级
    assert row["instruction_plan"] == service.DEFAULT_PLAN_INSTRUCTION
    old_row = conn.execute("SELECT * FROM video_prompt_records WHERE target='seedance2'").fetchone()
    assert old_row["mode"] is None  # 老行不硬套新模式
    assert service.references_for(old_row["prompt"], target="seedance2", mode=None,
                                 unit=UNIT_FIRST)[0]["label"] == "@图片 1"


def test_user_written_instructions_survive_the_upgrade(init_db):
    conn = init_db.main()
    conn.execute("UPDATE video_prompt_settings SET instruction_seedance=?", ("我自己写的 Seedance 口径",))
    service.initialize(conn)
    row = conn.execute("SELECT instruction_seedance FROM video_prompt_settings WHERE id=1").fetchone()
    assert row["instruction_seedance"] == "我自己写的 Seedance 口径"
    assert row["instruction_seedance"] != service.DEFAULT_SEEDANCE_INSTRUCTION


def test_references_for_h3_only_t2va_is_empty():
    assert service.references_for("x", target="h3", mode="t2va", unit=UNIT_FIRST) == []
    first = service.references_for("x", target="h3", mode="i2va", unit=UNIT_FIRST)
    assert [item["label"] for item in first] == ["<Picture 1>"]
    assert first[0]["slot"] == "picture"
    assert first[0]["frame"] == {"index": 1, "edge": "first"} and first[0]["warn"] is None
    chain = service.references_for("x", target="h3", mode="i2va", unit=UNIT_FOLLOW)
    assert chain[0]["frame"] == {"index": 2, "edge": "first"}
    assert "上一段生成结果的最后一帧" in chain[0]["warn"]
    fl2va = service.references_for("x", target="h3", mode="fl2va", unit=UNIT_FOLLOW)
    assert [item["label"] for item in fl2va] == ["<Picture 1>", "<Picture 2>"]
    assert fl2va[1]["frame"] == {"index": 2, "edge": "last"}
    assert "对齐到 5 秒" in fl2va[1]["what"]


def test_references_for_ref2va_lists_only_upload_slots():
    refs = service.references_for(REF2VA_OK, target="h3", mode="ref2va", unit=UNIT_FOLLOW)
    assert [item["label"] for item in refs] == ["<Picture 1>", "<Picture 2>"]
    assert [item["slot"] for item in refs] == ["picture", "picture"]
    # 界面上不能出现英文说明：中文缺失时用服务端兜底，英文原文只留在 what_en 里做悬停提示
    assert "自备" in refs[1]["what"] and "front-facing full-body view" in refs[1]["what_en"]
    assert refs[1]["frame"] is None
    assert refs[0]["frame"] == {"index": 2, "edge": "first"}
    assert "上一段生成结果的最后一帧" in refs[0]["warn"]
    # <Subject N> 是正文里的内容标签、不是文件；summary 顺带提到的编号也不算素材
    assert not any(item["label"].startswith("<Subject") for item in refs)
    assert not any(item["label"] == "<Picture 9>" for item in refs)


def test_references_for_ref2va_orders_slots_and_recovers_loose_prose():
    mixed = ("subject_definitions:\n"
             "<Audio 1> is reference audio 1 to upload: the voice timbre of the speaker.\n"
             "<Video 1> is reference video 1 to upload: the previously generated segment.\n"
             "<Picture 1> is reference image 1 to upload: the first frame of this segment.\n"
             "<Subject 1> the diver, referenced from <Picture 1>.\n\n"
             "summary: [video continuation] x\n\nretention_analysis: y\n\n"
             "detailed_description: z\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A")
    refs = service.references_for(mixed, target="h3", mode="ref2va", unit=UNIT_FOLLOW)
    assert [item["label"] for item in refs] == ["<Picture 1>", "<Video 1>", "<Audio 1>"]
    assert [item["slot"] for item in refs] == ["picture", "video", "audio"]
    assert refs[0]["frame"] == {"index": 2, "edge": "first"}
    assert refs[1]["frame"] is None and "上一段" in refs[1]["warn"]
    assert refs[2]["frame"] is None and refs[2]["warn"] is None
    prose = service.references_for("<Video 1> is the source clip, kept as-is", target="h3",
                                   mode="ref2va", unit=UNIT_FIRST)
    assert [item["label"] for item in prose] == ["<Video 1>"]
    assert "source clip" in prose[0]["what_en"] and "上一段" in prose[0]["what"]
    loose = service.references_for("detailed_description: follow reference image 2 closely.",
                                   target="h3", mode="ref2va", unit=UNIT_FIRST)
    assert [item["label"] for item in loose] == ["<Picture 2>"]
    assert "没写用途" in loose[0]["what"]
    assert service.references_for("detailed_description: <Subject 1> waves.", target="h3",
                                  mode="ref2va", unit=UNIT_FIRST) == []


@pytest.mark.parametrize("extra,slot,total", [
    ("<Picture 3> x\n<Picture 4> x\n<Picture 5> x\n<Picture 6> x\n<Picture 7> x", "picture", 7),
    ("<Video 1> x\n<Video 2> x\n<Video 3> x\n<Video 4> x", "video", 4),
    ("<Audio 1> x\n<Audio 2> x\n<Audio 3> x\n<Audio 4> x", "audio", 4),
])
def test_ref2va_slot_counts_beyond_the_limit_are_rejected(extra, slot, total):
    prompt = REF2VA_OK.replace("<Subject 1> the green-haired",
                               extra + "\n<Subject 1> the green-haired")
    assert service.valid_prompt(prompt, "h3", "ref2va") is False
    # 超限的清单仍然列全，用户才能看出要合并哪几个编号
    listed = service.references_for(prompt, target="h3", mode="ref2va", unit=UNIT_FIRST)
    assert len([item for item in listed if item["slot"] == slot]) == total


def test_ref2va_slot_counts_at_the_limit_are_accepted():
    extra = "\n".join(f"<Picture {n}> is a reference image" for n in range(3, 7))
    prompt = REF2VA_OK.replace("<Subject 1> the green-haired",
                               extra + "\n<Subject 1> the green-haired")
    assert service.valid_prompt(prompt, "h3", "ref2va") is True



def test_segment_h3_ref2va_contract_and_t2va_lists_nothing(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    captured = []
    stub_model(monkeypatch, {"prompt": REF2VA_OK, "risk_terms": []}, captured)
    record = generate(client, video_id, run["id"], 1, "h3", "ref2va")
    assert record["status"] == "complete"
    assert record["prompt"].splitlines()[0] == "subject_definitions:"
    assert "Ref2VA (full-reference generation)" in captured[0]["instruction"]
    assert [item["label"] for item in record["references"]] == ["<Picture 1>", "<Picture 2>"]
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []}, captured)
    plain = generate(client, video_id, run["id"], 2, "h3", "t2va")
    assert plain["references"] == []
    assert "Ref2VA" not in captured[1]["instruction"]
    # 只有 Ref2VA 才向模型索要中文素材说明，其它模式的说法由服务端固定生成
    assert "reference_notes" in captured[0]["system"]
    assert "reference_notes" not in captured[1]["system"]


def test_segment_ref2va_warns_when_sections_are_missing(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": REF2VA_OK.replace("retention_analysis:", "retention notes:"),
                             "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "h3", "ref2va")
    assert record["status"] == "format_warning"


def test_history_versions_and_edits_carry_references(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_REF_OK, "risk_terms": []})
    first = generate(client, video_id, run["id"], 1, "seedance2", "ref")
    assert [item["label"] for item in first["references"]] == ["@图片 1", "@图片 2", "@音频 1"]
    assert first["references"][0]["frame"] == {"index": 1, "edge": "first"}
    assert first["references"][2]["slot"] == "audio"
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 1, "h3", "i2va")
    history = client.get(plan_url(video_id)).json()
    unit = history["runs"][0]["units"][0]
    assert [item["label"] for item in unit["current"]["seedance2"]["references"]] == ["@图片 1", "@图片 2", "@音频 1"]
    assert [item["label"] for item in unit["current"]["h3"]["references"]] == ["<Picture 1>"]
    versions = client.get(segment_url(video_id, run["id"], 1) + "/records?target=seedance2").json()["records"]
    assert versions[0]["references"][0]["frame"] == {"index": 1, "edge": "first"}
    assert versions[0]["mode"] == "ref"
    edited = client.post(segment_url(video_id, run["id"], 1) + "/edits", json={
        "target": "seedance2",
        "prompt": "【风格】写实，15 秒，16:9，安静\n\n【分镜】\n镜头1：远景，推镜，人走来，云动，<风声>\n\n"
                  "【约束】保持无字幕"}).json()
    # 编辑不改模式：全能参考的正文没交代编号，清单就是空的，格式也标成不完整让用户补【主体】
    assert edited["mode"] == "ref" and edited["references"] == []
    assert edited["status"] == "complete"  # 手改的正文不再标格式警告


def test_only_full_reference_modes_ask_for_chinese_slot_notes():
    assert "reference_notes" in service.segment_output_rule("h3", "ref2va")
    assert service.segment_output_rule("h3", "ref2va") != service.SEGMENT_OUTPUT_RULE
    assert "reference_notes" in service.segment_output_rule("seedance2", "ref")
    for mode in ("t2va", "i2va", "fl2va"):
        assert service.segment_output_rule("h3", mode) == service.SEGMENT_OUTPUT_RULE
    for mode in ("t2v", "i2v", "flv"):
        assert service.segment_output_rule("seedance2", mode) == service.SEGMENT_OUTPUT_RULE
    assert service.segment_output_rule("seedance2", None) == service.SEGMENT_OUTPUT_RULE


def test_ref2va_notes_prefer_model_chinese_and_keep_english_as_hint():
    notes = [{"slot": "<Picture 2>", "zh": "绿发少女正面全身立绘，纯色背景，给 <Subject 1> 用"},
             {"slot": "picture 1", "zh": "上一段成品视频的最后一帧"},
             {"slot": "<Subject 2>", "zh": "不是上传编号，应被忽略"},
             {"slot": "<Picture 1>", "zh": "   "}]
    refs = service.references_for(REF2VA_OK, target="h3", mode="ref2va", unit=UNIT_FOLLOW, notes=notes)
    assert [item["what"] for item in refs] == [
        "上一段成品视频的最后一帧", "绿发少女正面全身立绘，纯色背景，给 <Subject 1> 用"]
    assert refs[1]["what_en"].startswith("is reference image 2")
    assert refs[0]["what_en"].startswith("is reference image 1")


def test_ref2va_without_notes_never_shows_english_as_main_text():
    refs = service.references_for(REF2VA_OK, target="h3", mode="ref2va", unit=UNIT_FOLLOW)
    assert refs and all(re.search(r"[\u4e00-\u9fff]", item["what"]) for item in refs)
    assert all(item["what_en"] for item in refs)   # 英文原文留着做悬停提示


def test_ref2va_slot_notes_are_stored_and_survive_edits(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    captured = []
    stub_model(monkeypatch, {"prompt": REF2VA_OK, "risk_terms": [], "reference_notes": [
        {"slot": "<Picture 1>", "zh": "上一段成品视频的最后一帧"},
        {"slot": "<Picture 2>", "zh": "绿发少女正面全身立绘，纯色背景"}]}, captured)
    record = generate(client, video_id, run["id"], 1, "h3", "ref2va")
    notes = {item["label"]: item for item in record["references"]}
    assert notes["<Picture 2>"]["what"] == "绿发少女正面全身立绘，纯色背景"
    assert "front-facing full-body view" in notes["<Picture 2>"]["what_en"]
    edited = client.post(segment_url(video_id, run["id"], 1) + "/edits",
                         json={"target": "h3", "prompt": REF2VA_OK + "\n"}).json()
    assert {item["label"]: item["what"] for item in edited["references"]}[
        "<Picture 2>"] == "绿发少女正面全身立绘，纯色背景"


def test_settings_accept_ref2va_as_default_mode_h3(client):
    saved = client.put("/api/video-prompt-settings",
                       json=settings_payload(default_mode_h3="ref2va")).json()
    assert saved["default_mode_h3"] == "ref2va"


# ---------- 历史版本：能选、能删 ----------


def record_url(video_id, run_id, index, target, record_id):
    return segment_url(video_id, run_id, index) + "/records/" + str(record_id) + "?target=" + target


def test_version_delete_falls_back_to_previous_version(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    first = generate(client, video_id, run["id"], 1, "seedance2")
    edited = client.post(segment_url(video_id, run["id"], 1) + "/edits",
                         json={"target": "seedance2", "prompt": SEEDANCE_OK + " 补充"}).json()
    assert edited["id"] > first["id"]

    def current_id():
        return client.get(plan_url(video_id)).json()["runs"][0]["units"][0]["current"]["seedance2"]["id"]

    assert current_id() == edited["id"]
    # 删旧版不影响当前版
    gone = client.delete(record_url(video_id, run["id"], 1, "seedance2", first["id"]))
    assert gone.status_code == 200, gone.text
    assert gone.json()["current"] == edited["id"]
    assert current_id() == edited["id"]
    # 删掉最新版自动退回次新一版
    newest = client.post(segment_url(video_id, run["id"], 1) + "/edits",
                         json={"target": "seedance2", "prompt": SEEDANCE_OK + " 再改"}).json()["id"]
    assert client.delete(record_url(video_id, run["id"], 1, "seedance2", newest)).json()["current"] == edited["id"]
    assert current_id() == edited["id"]


def test_version_delete_only_touches_that_segment_and_target(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    seedance = generate(client, video_id, run["id"], 1, "seedance2")
    other_segment = generate(client, video_id, run["id"], 2, "seedance2")
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    h3 = generate(client, video_id, run["id"], 1, "h3", "i2va")
    answer = client.delete(record_url(video_id, run["id"], 1, "seedance2", seedance["id"]))
    assert answer.json() == {"deleted": seedance["id"], "segment_index": 1, "target": "seedance2", "current": None}
    units = client.get(plan_url(video_id)).json()["runs"][0]["units"]
    assert "seedance2" not in units[0]["current"]
    assert units[0]["current"]["h3"]["id"] == h3["id"]
    assert units[1]["current"]["seedance2"]["id"] == other_segment["id"]
    # 删完这段该格式就没有版本了，另一段/另一格式各算各的
    assert units[0]["versions"] == {"seedance2": 0, "h3": 1}
    assert units[1]["versions"] == {"seedance2": 1, "h3": 0}


def test_version_delete_validates_target_segment_and_owner(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "seedance2")
    assert client.delete(record_url(video_id, run["id"], 2, "seedance2", record["id"])).status_code == 404
    assert client.delete(record_url(video_id, run["id"], 1, "h3", record["id"])).status_code == 404
    assert client.delete(record_url(video_id, run["id"], 1, "seedance2", 99999)).status_code == 404
    assert client.delete(record_url(video_id, run["id"], 1, "bogus", record["id"])).status_code == 422
    assert client.delete("/api/videos/%d/video-prompts/runs/%d/segments/1/records/%d?target=seedance2"
                         % (video_id + 7000, run["id"], record["id"])).status_code == 404
    assert client.get(record_url(video_id, run["id"], 1, "seedance2", record["id"]) + "&x=1").status_code != 404


def test_version_delete_while_generating_is_refused(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "seedance2")
    service.acquire_segment(run["id"], 1, "seedance2", video_id)
    try:
        conflict = client.delete(record_url(video_id, run["id"], 1, "seedance2", record["id"]))
    finally:
        service.release_segment(run["id"], 1, "seedance2")
    assert conflict.status_code == 409
    assert "正在生成" in conflict.json()["detail"]


def test_version_delete_takes_its_translation_with_it(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    record = generate(client, video_id, run["id"], 1, "seedance2")
    stub_model(monkeypatch, "This is a close-up portrait.")
    translated = client.post(translation_url(video_id, run["id"], 1), json={"target": "seedance2"}).json()
    assert translated["source"] == "model"
    pool = db.get_pool()
    assert pool.main().execute("SELECT 1 FROM video_prompt_translations WHERE record_id=?",
                               (record["id"],)).fetchone()
    client.delete(record_url(video_id, run["id"], 1, "seedance2", record["id"]))
    assert not pool.main().execute("SELECT 1 FROM video_prompt_translations WHERE record_id=?",
                                   (record["id"],)).fetchone()


def test_listing_reports_versions_per_segment(client, video_id, monkeypatch):
    run = seed_plan(client, monkeypatch, video_id)
    stub_model(monkeypatch, {"prompt": SEEDANCE_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 1, "seedance2")
    client.post(segment_url(video_id, run["id"], 1) + "/edits",
                json={"target": "seedance2", "prompt": SEEDANCE_OK + " 改"})
    stub_model(monkeypatch, {"prompt": H3_OK, "risk_terms": []})
    generate(client, video_id, run["id"], 2, "h3", "t2va")
    units = client.get(plan_url(video_id)).json()["runs"][0]["units"]
    assert units[0]["versions"] == {"seedance2": 2, "h3": 0}
    assert units[1]["versions"] == {"seedance2": 0, "h3": 1}


