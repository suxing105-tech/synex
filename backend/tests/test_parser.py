"""PNG/WebP 元数据解析器测试。"""
from __future__ import annotations

from pathlib import Path

from app.parser import _parse_parameters_text, parse_metadata

from .conftest import make_comfy_prompt, make_png


def test_parse_png_with_comfy_prompt(tmp_path: Path):
    p = tmp_path / "img.png"
    make_png(
        p,
        prompt=make_comfy_prompt("a cat", "blurry", seed=1234, steps=30, cfg=8.5, sampler="dpmpp_2m"),
    )
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == "a cat"
    assert meta["negative_prompt"] == "blurry"
    assert meta["seed"] == 1234
    assert meta["steps"] == 30
    assert meta["cfg"] == 8.5
    assert meta["sampler"] == "dpmpp_2m"
    assert meta["model"] == "sd_xl_base_1.0"


def test_parse_png_with_a1111_parameters(tmp_path: Path):
    p = tmp_path / "img.png"
    make_png(
        p,
        params="a beautiful landscape\nNegative prompt: ugly, low quality\nSteps: 25, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 42",
    )
    meta = parse_metadata(p)
    assert "beautiful" in meta["positive_prompt"]
    assert "ugly" in meta["negative_prompt"]
    assert meta["parameters"]["Steps"] == "25"
    assert meta["seed"] == 42


def test_parse_png_without_metadata(tmp_path: Path):
    p = tmp_path / "img.png"
    make_png(p)
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == ""
    assert meta["seed"] is None
    assert meta["filename"] == "img.png"


def test_parse_unknown_extension_returns_empty(tmp_path: Path):
    p = tmp_path / "img.jpg"
    p.write_bytes(b"fake jpg bytes")
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == ""


def test_parse_corrupt_png_returns_empty(tmp_path: Path):
    p = tmp_path / "img.png"
    p.write_bytes(b"not a png")
    meta = parse_metadata(p)
    assert meta["positive_prompt"] == ""


def test_parse_parameters_text_basic():
    pos, neg, params = _parse_parameters_text(
        "a fox\nNegative prompt: blurry\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 999"
    )
    assert pos == "a fox"
    assert neg == "blurry"
    assert params["Steps"] == "20"
    assert params["Seed"] == "999"
