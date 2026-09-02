"""测试公共 fixture：临时数据目录 + 隔离的 SQLite 库。"""
from __future__ import annotations

import os
import sqlite3
import struct
import zlib
from pathlib import Path

import pytest


@pytest.fixture
def tmp_data_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    # 让模块重新读环境：清掉缓存
    import importlib

    from app import config

    importlib.reload(config)
    from app import db

    importlib.reload(db)
    return tmp_path


@pytest.fixture
def init_db(tmp_data_dir):
    from app.db import init_pool

    pool = init_pool()
    pool.initialize()
    yield pool


# ---------- 测试用 PNG 生成器 ----------


def make_png(path: Path, *, prompt: dict | None = None, workflow: dict | None = None, params: str | None = None, width: int = 8, height: int = 8) -> Path:
    """合成一个最小 PNG（含可选 tEXt chunk）。"""
    import json

    def chunk(ctype: bytes, data: bytes) -> bytes:
        length = struct.pack(">I", len(data))
        body = ctype + data
        crc = struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
        return length + body + crc

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = b""
    for y in range(height):
        raw += b"\x00" + (b"\x80\x80\x80" * width)
    idat = zlib.compress(raw)

    parts = [sig, chunk(b"IHDR", ihdr)]
    if prompt is not None:
        parts.append(chunk(b"tEXt", b"prompt\x00" + json.dumps(prompt).encode("utf-8")))
    if workflow is not None:
        parts.append(chunk(b"tEXt", b"workflow\x00" + json.dumps(workflow).encode("utf-8")))
    if params is not None:
        parts.append(chunk(b"tEXt", b"parameters\x00" + params.encode("utf-8")))
    parts.append(chunk(b"IDAT", idat))
    parts.append(chunk(b"IEND", b""))
    path.write_bytes(b"".join(parts))
    return path


def make_comfy_prompt(pos: str, neg: str, *, seed: int = 42, steps: int = 20, cfg: float = 7.0, sampler: str = "euler", model: str = "sd_xl_base_1.0") -> dict:
    return {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": pos, "clip": ["2", 0]},
        },
        "2": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler,
                "positive": ["1", 0],
                "negative": ["4", 0],
                "model": ["2", 0],
            },
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": neg, "clip": ["2", 0]},
        },
    }


def connect():
    import sqlite3

    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    return c
