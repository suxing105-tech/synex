"""ComfyUI 写进视频容器的工作流 / 提示词：解析、入库、回填、打开工作流。

事实依据（本机 ComfyUI v0.16.4 / 前端 0.33.0，output 目录 191 个 mp4 全量 ffprobe）：
- 46 个：顶层 tag ``workflow``（UI 工作流 JSON 字符串）+ ``prompt``（API prompt JSON 字符串）
- 139 个：只有 ``comment`` tag，整体是 JSON ``{"prompt": "<api json 字符串>", "workflow": {…dict…}}``
- 2 个：只有 ``prompt``（没法进画布）；4 个：被第三方二次编码洗掉（Topaz）
测试用 ``-movflags use_metadata_tags`` 复现第 1 种、``-metadata comment=`` 复现第 2 种。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from app.db import get_pool, init_pool
from app.indexer import Indexer
from app.parser import extract_video_comfyui_metadata, parse_video_metadata

UI_WORKFLOW = {
    "id": "wf-1",
    "last_node_id": 2,
    "nodes": [
        {"id": 1, "type": "MiniMaxH3ImageToVideo", "mode": 0, "widgets_values": []},
        {"id": 2, "type": "SaveVideo", "mode": 0, "widgets_values": []},
    ],
    "links": [],
    "groups": [],
    "config": {},
    "extra": {},
    "version": 0.4,
}
# API prompt：提示词在生成节点的 inputs.prompt，模型在 UNETLoader，seed 是整数
API_PROMPT = {
    "138": {
        "class_type": "UNETLoader",
        "inputs": {"unet_name": "MinimaxH3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors"},
    },
    "142": {
        "class_type": "MiniMaxH3ImageToVideo",
        "inputs": {"prompt": "镜头缓慢推进，主播看向镜头", "negative_prompt": "模糊", "seed": 4242},
    },
    # 干扰项：又长又不是提示词的字符串，不能被当成提示词
    "143": {"class_type": "ComfyMathExpression", "inputs": {"expression": "max(5, round(a * 24)) + 7"}},
}


def _make_mp4(path: Path, **metadata: str) -> Path:
    """用 ffmpeg 生成极小 mp4 并写入指定容器元数据。"""
    args = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x48:d=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "use_metadata_tags",
    ]
    for key, value in metadata.items():
        args += ["-metadata", f"{key}={value}"]
    args.append(str(path))
    subprocess.run(
        args, capture_output=True, text=True, check=False,
        encoding="utf-8", errors="replace",
    )
    assert path.exists(), "ffmpeg 未能生成测试视频"
    return path


@pytest.fixture(scope="module")
def samples(tmp_path_factory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("videowf")
    api_text = json.dumps(API_PROMPT, ensure_ascii=False)
    return {
        "tag": _make_mp4(
            root / "tag_form.mp4",
            workflow=json.dumps(UI_WORKFLOW, ensure_ascii=False),
            prompt=api_text,
        ),
        "comment": _make_mp4(
            root / "comment_form.mp4",
            comment=json.dumps(
                {"prompt": api_text, "workflow": UI_WORKFLOW}, ensure_ascii=False
            ),
        ),
        # 提示词挂在连线来源节点上（本机「影驰数字人」那批的真实形状）
        "linked": _make_mp4(
            root / "linked_form.mp4",
            comment=json.dumps(
                {
                    "prompt": json.dumps(
                        {
                            "265": {
                                "class_type": "MiniMaxH3ReferenceToVideo",
                                "inputs": {"prompt": ["404", 0], "seed": 99},
                            },
                            "404": {
                                "class_type": "PrimitiveStringMultiline",
                                "inputs": {"value": "subject_definitions:\n<Subject 1> 是新闻主播"},
                            },
                        },
                        ensure_ascii=False,
                    ),
                    "workflow": UI_WORKFLOW,
                },
                ensure_ascii=False,
            ),
        ),
        "prompt_only": _make_mp4(root / "prompt_only.mp4", prompt=api_text),
        # 外部来源：comment 是网址、description 是简介，绝不能被当成工作流
        "foreign": _make_mp4(
            root / "foreign.mp4",
            comment="https://www.xiaohongshu.com/explore/6979ee89",
            title="某 AI 产品视频",
        ),
        "bare": _make_mp4(root / "bare.mp4"),
    }


# ---------- 纯函数：tag 形态 ----------


def test_extracts_workflow_and_prompt_from_top_level_tags(samples):
    meta = parse_video_metadata(samples["tag"])
    assert meta["workflow"], "顶层 workflow tag 应该被读出来"
    assert json.loads(meta["workflow"])["nodes"]
    assert meta["parameters"]["comfyui_metadata"] == "workflow"
    assert meta["positive_prompt"] == "镜头缓慢推进，主播看向镜头"
    assert meta["negative_prompt"] == "模糊"
    # 模型名去目录去扩展名；表达式节点没被当成提示词
    assert meta["model"] == "minimax_h3_hybrid_fl2va_ref2va_b25-49-int8"
    assert "max(5" not in meta["positive_prompt"]
    assert meta["seed"] == 4242


def test_extracts_workflow_from_comment_wrapper(samples):
    meta = parse_video_metadata(samples["comment"])
    assert meta["parameters"]["comfyui_metadata"] == "comment"
    assert json.loads(meta["workflow"])["nodes"], "comment 里 workflow 是 dict，也要能规范成 JSON"
    assert meta["positive_prompt"] == "镜头缓慢推进，主播看向镜头"


def test_resolves_prompt_behind_a_link(samples):
    meta = parse_video_metadata(samples["linked"])
    assert meta["positive_prompt"].startswith("subject_definitions:")
    assert meta["seed"] == 99


def test_prompt_only_is_not_a_workflow(samples):
    meta = parse_video_metadata(samples["prompt_only"])
    assert meta["workflow"] == "", "API prompt 没有 nodes 数组，进不了画布"
    assert meta["positive_prompt"], "但仍能给出提示词"
    assert "comfyui_metadata" not in meta["parameters"]


def test_foreign_metadata_ignored(samples):
    meta = parse_video_metadata(samples["foreign"])
    assert meta["workflow"] == ""
    assert meta["positive_prompt"] == ""
    assert meta["model"] is None
    assert meta["kind"] == "video" and meta["duration_seconds"], "基础字段不受影响"


def test_bare_video_unchanged(samples):
    meta = parse_video_metadata(samples["bare"])
    assert meta["workflow"] == "" and meta["parameters"] == {}


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not json at all",
        json.dumps({"nodes": "不是数组"}),
        json.dumps({"1": {"class_type": "KSampler"}}),  # API 格式
        json.dumps([1, 2, 3]),
        None,
        123,
    ],
)
def test_ui_workflow_rejects_non_ui_shapes(raw):
    assert extract_video_comfyui_metadata({"workflow": raw})["workflow"] == ""


def test_extract_tolerates_garbage_tags():
    for tags in (None, [], "x", {"workflow": "{" * 500, "comment": "[1,", "prompt": 7}):
        out = extract_video_comfyui_metadata(tags)
        assert out["workflow"] == "" and out["positive_prompt"] == ""


# ---------- 入库 + feed ----------


def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    import importlib

    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    init_pool()


def test_indexing_video_stores_workflow_and_shows_flag(tmp_path, monkeypatch, samples):
    from app import repository

    _isolate(tmp_path, monkeypatch)
    Indexer()._process_path_sync(samples["tag"])
    row = get_pool().main().execute("SELECT id FROM images").fetchone()
    detail = repository.image_detail(row["id"])
    assert detail["workflow"] and detail["positive_prompt"]
    assert detail["kind"] == "video"
    items, total = repository.feed()
    assert total == 1
    assert items[0]["has_workflow"] is True
    assert "workflow" not in items[0], "列表不许把整份 JSON 甩给前端"
    assert items[0]["thumbnail_url"], "缩略图 URL 依赖的列必须在显式列表里"


def test_foreign_video_has_no_button(tmp_path, monkeypatch, samples):
    from app import repository

    _isolate(tmp_path, monkeypatch)
    Indexer()._process_path_sync(samples["foreign"])
    items, _total = repository.feed()
    assert items[0]["has_workflow"] is False
    assert repository.image_detail(items[0]["id"])["workflow"] == ""


def test_listing_selects_no_workflow_column():
    """锁死性能修复：列表查询不许把 workflow 整列读出来。"""
    from app import repository

    select = repository._SUMMARY_SELECT
    assert "images.*" not in select
    # workflow 只许出现在 length(COALESCE(...)) 派生列里一次
    assert select.count("images.workflow") == 1
    assert "length(COALESCE(images.workflow, '')) > 0 AS has_workflow" in select
    assert "images.indexed_at" in select, "缩略图 identity 需要 indexed_at"
    assert "images.thumb_path" in select and "images.cover_path" in select


# ---------- 一次性回填 ----------


def test_backfill_fills_old_rows_once(tmp_path, monkeypatch, samples):
    from app import repository
    from app.db import get_int_meta

    _isolate(tmp_path, monkeypatch)
    conn = get_pool().main()
    for name in ("tag", "comment"):
        path = samples[name]
        conn.execute(
            "INSERT INTO images(path, filename, kind, size_bytes, mtime) VALUES(?,?,?,?,?)",
            (path.as_posix(), path.name, "video", path.stat().st_size, path.stat().st_mtime),
        )
    conn.commit()
    assert repository.backfill_video_metadata() == 2
    rows = conn.execute("SELECT workflow, positive_prompt, model FROM images ORDER BY id").fetchall()
    assert all(r["workflow"] for r in rows)
    assert all(r["positive_prompt"] for r in rows)
    assert get_int_meta("video_metadata_schema", 0) == repository.VIDEO_METADATA_SCHEMA_VERSION
    # 第二次直接跳过
    assert repository.backfill_video_metadata() == 0


def test_backfill_never_wipes_and_survives_missing_file(tmp_path, monkeypatch, samples):
    from app import repository

    _isolate(tmp_path, monkeypatch)
    conn = get_pool().main()
    conn.execute(
        "INSERT INTO images(path, filename, kind, size_bytes, mtime, workflow, positive_prompt) "
        "VALUES(?,?,?,?,?,?,?)",
        (samples["foreign"].as_posix(), samples["foreign"].name, "video", 1, 0, "旧工作流", "旧提示词"),
    )
    conn.execute(
        "INSERT INTO images(path, filename, kind, size_bytes, mtime) VALUES(?,?,?,?,?)",
        ("C:/不存在的目录/gone.mp4", "gone.mp4", "video", 1, 0),
    )
    conn.commit()
    assert repository.backfill_video_metadata() == 0
    row = conn.execute("SELECT workflow, positive_prompt FROM images WHERE id = 1").fetchone()
    assert row["workflow"] == "旧工作流" and row["positive_prompt"] == "旧提示词"


# ---------- 路由 ----------


def test_set_meta_roundtrips():
    """顺带锁死一个潜伏 bug：``db.set_meta`` 的 UPSERT 之前写成 ``SET value = excluded``
    （表名，不是列），从来没被调用过所以从没生效过；回填门控是第一个用户。"""
    from app.db import get_int_meta, init_pool, set_meta

    init_pool()
    assert get_int_meta("probe_key", 7) == 7
    set_meta("probe_key", 3)
    assert get_int_meta("probe_key", 7) == 3
    set_meta("probe_key", 9)
    assert get_int_meta("probe_key", 7) == 9


def test_open_workflow_route_accepts_video(tmp_path, monkeypatch, samples):
    from fastapi.testclient import TestClient

    from app.main import app

    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr("app.routes.comfyui.probe", lambda url: True)
    Indexer()._process_path_sync(samples["tag"])
    video_id = get_pool().main().execute("SELECT id FROM images").fetchone()["id"]
    with TestClient(app) as client:
        resp = client.post(f"/api/integrations/comfyui/open_workflow/{video_id}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] and body["workflow"]["nodes"]
        assert body["file_path"].endswith("tag_form.json")
        missing = client.post("/api/integrations/comfyui/open_workflow/999999")
        assert missing.status_code == 404
        assert "媒体" in missing.json()["detail"]