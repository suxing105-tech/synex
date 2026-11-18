"""测试公共 fixture：临时数据目录 + 隔离的 SQLite 库。"""
from __future__ import annotations

import os
import sqlite3
import struct
import zlib
from pathlib import Path

import pytest

_SESSION_ROOT: Path | None = None


@pytest.fixture(scope="session", autouse=True)
def _data_dir_off_the_real_one(tmp_path_factory):
    """整个测试会话的默认数据目录搬进临时目录，并且当场拦住有人把库开回本机那份。

    为什么要有这条：`init_pool()` 只建不换（``_POOL is None`` 才建），所以**第一个**
    没声明 `tmp_data_dir` 就调到 `get_pool()` 的用例，会把池子永久钉在
    ``Path.cwd()/data/db.sqlite`` 上——那正是开发时在跑的那份库，之后整会话的用例
    写的都是它。「再次创作」接云端那天，11 条测试账号就是这么进的本机库。
    默认目录换掉是防，下面那层 __init__ 守卫是当场报错，不让人默默写进真库再查。
    """
    global _SESSION_ROOT
    import importlib
    import os

    root = tmp_path_factory.mktemp("seekx-session")
    _SESSION_ROOT = root
    previous = os.environ.get("SUXING_GALLERY_DATA_DIR")
    os.environ["SUXING_GALLERY_DATA_DIR"] = str(root)

    from app import config as config_module

    importlib.reload(config_module)

    yield
    if previous is None:
        os.environ.pop("SUXING_GALLERY_DATA_DIR", None)
    else:
        os.environ["SUXING_GALLERY_DATA_DIR"] = previous


@pytest.fixture(autouse=True)
def _no_real_dev_db_in_tests():
    """每条用例都不许把 SQLite 开在本机 ``cwd/data`` 上——进来贴守卫，收尾查一遍。

    守卫必须在每条用例里重新贴：``tmp_data_dir`` 会 ``reload(app.db)``，
    那会换掉类对象，会话级贴的那一层就此失效（第一版就是这么漏的）。
    """
    import importlib
    import sys

    db_module = sys.modules.get("app.db") or importlib.import_module("app.db")
    forbidden = (Path.cwd() / "data").resolve()
    pool_class = db_module.ConnectionPool
    original_init = pool_class.__init__

    def guarded_init(self, path, *args, **kwargs):
        resolved = Path(path).resolve()
        if resolved.parent == forbidden:
            raise AssertionError(
                "测试不许打开本机开发库 " + str(resolved)
                + "：要隔离数据库就声明 init_db / tmp_data_dir。"
            )
        return original_init(self, path, *args, **kwargs)

    pool_class.__init__ = guarded_init
    try:
        yield
    finally:
        pool_class.__init__ = original_init
        pool = getattr(db_module, "_POOL", None)
        if pool is not None and Path(pool.path).resolve().parent == forbidden:
            pytest.fail("有用例把连接池开到了本机开发库 " + str(pool.path))


@pytest.fixture(autouse=True)
def _no_bundled_clone_templates(monkeypatch):
    """新库默认不装内置的「再次创作」工作流。

    生产里默认是装的（安装包开箱就该有图片与视频各一份），但绝大多数老用例的前提
    是「模板表一开始是空的」。测内置本身的用例自己把它打开。
    """
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "0")


@pytest.fixture(autouse=True)
def _no_cloud_template_rows(monkeypatch):
    """新库默认不装「图片API / 视频API / 音频API」这三条快捷方式。

    生产里默认是装的（开箱就能在切换清单里看见它们）。但模板表在绝大多数用例里的
    前提是「只有本机会长出这几条」，而且云端那三条会让音频族的折叠计数变样。
    测云端的用例自己把它打开（见 test_clone_cloud.py）。
    """
    monkeypatch.setenv("SUXING_SEED_CLOUD_TEMPLATES", "0")


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


def _resync_indexer_singleton():
    """让会话级单例 Indexer 的配置跟着当前临时数据目录走。

    以前没人依赖它，但 ``GET /api/folders`` 会照 ``config.watch_dirs`` 补来源目录根节点：
    单例是会话级的，留着上一个测试写进去的目录，就会在下一个测试的库里长出野节点。
    """
    from pathlib import Path

    from app import indexer as indexer_module
    from app.config import load_config

    instance = indexer_module._INDEXER
    if instance is None:
        return
    instance._cfg = load_config()
    instance._watch_roots = [Path(d) for d in instance._cfg.watch_dirs]


@pytest.fixture
def init_db(tmp_data_dir):
    from app.db import init_pool

    pool = init_pool()
    pool.initialize()
    _resync_indexer_singleton()
    yield pool
    _resync_indexer_singleton()


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


# ---------- Lora 管理器：戏种开关与武打速度 ----------
# 一台 Lora 管理器挂两颗控件：整组开关（文戏／武戏）和其中一颗 lora 的强度。
# 它们的值都不是某个 node.input 的字面量，而是 loras 清单里的条目，
# 所以「撞键」「写错字段」「认错 lora」这三类错都只在我们这一侧会发生。
LORA_COMBAT = "MinimaxH3/H3_Combat_V2"
LORA_SPEED = "MinimaxH3/H3_speed_slider_1.1"


def lora_nodes() -> dict:
    def entry(name: str, strength: str) -> dict:
        return {"name": name, "strength": strength, "active": True, "expanded": False,
                "clipStrength": strength, "selected": False, "locked": False}

    return {
        "404": {"class_type": "PrimitiveStringMultiline",
                "inputs": {"value": "一份写好的默认提示词"}, "_meta": {"title": "提示词"}},
        "407": {
            "class_type": "Lora Loader (LoraManager)",
            "inputs": {
                # 运行时这一步直接 del text，节点读的是 loras 清单
                "text": f"<lora:{LORA_COMBAT}:0.65> <lora:{LORA_SPEED}:3.00>",
                "loras": {"__value__": [entry(LORA_COMBAT, "0.65"), entry(LORA_SPEED, "3.00")]},
                "model": ["412", 0],
            },
            "_meta": {"title": "LoRA加载器 (Lora管理器)"},
        },
        "412": {"class_type": "LoraLoaderModelOnly",
                "inputs": {"lora_name": "a.safetensors", "strength_model": 1}},
        "261": {"class_type": "BasicScheduler",
                "inputs": {"scheduler": "simple", "steps": 10, "denoise": 1, "model": ["412", 0]}},
        "265": {"class_type": "MiniMaxH3ReferenceToVideo",
                "inputs": {"prompt": ["404", 0], "length": 124}},
        "397": {"class_type": "SelfLiftH3Sampler",
                "inputs": {"seed": 12345, "sigmas": ["261", 0], "positive": ["265", 0]}},
        "600": {"class_type": "SaveImage", "inputs": {"images": ["397", 0]}},
    }


def lora_slots() -> list[dict]:
    return [
        {"kind": "prompt", "node": "404", "input": "value", "label": "完整提示词"},
        {"kind": "select", "node": "407", "input": "loras", "label": "戏种",
         "options": ["文戏", "武戏"], "value": "文戏",
         "lora_group": [LORA_COMBAT, LORA_SPEED], "lora_on": "武戏",
         "option_writes": {"文戏": [{"node": "261", "input": "steps", "value": 10}],
                           "武戏": [{"node": "261", "input": "steps", "value": 12}]}},
        {"kind": "number", "node": "407", "input": "loras", "label": "武打速度",
         "lora": LORA_SPEED, "min": 1, "max": 6, "step": 1, "value": 3, "slider": True,
         "show_when": {"input": "407.loras#@", "equals": "武戏"}},
    ]


def lora_keys() -> tuple[str, str]:
    """两颗 lora 控件的提交键：整组那根固定叫 407.loras#@，速度那根带 lora 名。"""
    from app import clone_templates as ct

    slots = ct.normalize_slots(lora_slots(), lora_nodes())
    group = next(s for s in slots if s.get("lora_group"))
    speed = next(s for s in slots if s.get("lora"))
    return ct.slot_key(group), ct.slot_key(speed)
