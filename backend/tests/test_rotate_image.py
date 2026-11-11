"""预览视图那两个旋转按钮的后端半边：真转、真写回、元数据一个字节都不许掉。

这条改动最怕的就是「按钮好使，素材毁了」：Pillow 存 PNG 默认不写回 tEXt/iTXt
（im.info 里看得见 prompt / workflow，save 完整条 chunk 没了），而本项目里那些
chunk 就是用户的 ComfyUI 工作流。所以下面每条用例都把 chunk 值逐字节比回去，
并且把「左旋再右旋 = 原图像素」钉死——这是「不留备份也敢改原图」的唯一依据。
"""
from __future__ import annotations

import io
import os
import struct
import zlib
from pathlib import Path

import pytest
from PIL import Image

from app import image_ops, repository
from app.db import get_pool, init_pool
from app.indexer import Indexer, get_indexer
from app.parser import _read_png_chunks

from .conftest import make_comfy_prompt
# client 这条 fixture 住在 test_api 里，导入它才进得了本模块的用例（同 test_preview_identity）
from .test_api import client  # noqa: F401

# 库里真实存在的形态：iTXt(zip=False) 的 prompt、iTXt(zip=True) 的 workflow、
# tEXt 的 parameters、外加 iCCP 与 pHYs（实测 503 张 PNG 里 75 张带 iCCP、161 张带 pHYs）
ICC = b"\x00\x00\x02\x0facspappl" + b"\x11" * 512


def _marker(size=(40, 20)):
    """左上角一个红点：判断「顺时针 90° 之后它该在右上角」用。"""
    im = Image.new("RGB", size, (10, 20, 30))
    im.putpixel((0, 0), (255, 0, 0))
    return im


def _comfy_png(path: Path, *, size=(40, 20)) -> Path:
    from PIL.PngImagePlugin import PngInfo

    prompt = make_comfy_prompt("\u4e00\u53ea\u732b", "low quality")
    info = PngInfo()
    import json

    info.add_itxt("prompt", json.dumps(prompt, ensure_ascii=False), lang="", zip=False)
    info.add_itxt("workflow", json.dumps({"nodes": ["\u5de5\u4f5c\u6d41"]}, ensure_ascii=False), lang="", zip=True)
    info.add_text("parameters", "Steps: 20, Sampler: euler")
    _marker(size).save(path, pnginfo=info, icc_profile=ICC, dpi=(72, 72))
    return path


def _rows():
    return get_pool().main().execute("SELECT id, path FROM images ORDER BY id").fetchall()


def test_rotate_right_swaps_dims_and_keeps_every_text_chunk(tmp_data_dir):
    """右旋：磁盘与索引里的宽高互换，prompt/workflow/XMP 类 chunk 逐字节不变。"""
    init_pool()
    path = _comfy_png(tmp_data_dir / "a.png")
    image_id = Indexer()._process_path_sync(path)["id"]
    before_chunks = dict(_read_png_chunks(path))
    before_size = path.stat().st_size

    repository.rotate_image(image_id, "right")

    with Image.open(path) as rotated:
        assert rotated.size == (20, 40)
        assert rotated.info.get("icc_profile") == ICC, "iCCP 丢了颜色会整体偏色"
    assert dict(_read_png_chunks(path)) == before_chunks, "文本 chunk 必须逐字节原样"
    assert path.stat().st_size != before_size
    row = get_pool().main().execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    assert (row["width"], row["height"]) == (20, 40)
    assert row["size_bytes"] == path.stat().st_size
    assert row["mtime"] == pytest.approx(path.stat().st_mtime)
    assert len(_rows()) == 1, "旋转不许多出一行索引"


def test_left_then_right_restores_the_original_pixels(tmp_data_dir):
    """左旋再右旋 = 原图像素逐字节相同：这是「不留备份也敢写回原图」的依据。"""
    init_pool()
    path = _comfy_png(tmp_data_dir / "roundtrip.png")
    image_id = Indexer()._process_path_sync(path)["id"]
    with Image.open(path) as origin:
        origin_px = origin.convert("RGB").tobytes()

    repository.rotate_image(image_id, "left")
    repository.rotate_image(image_id, "right")

    with Image.open(path) as back:
        assert back.size == (40, 20)
        assert back.convert("RGB").tobytes() == origin_px
    row = get_pool().main().execute("SELECT width, height FROM images WHERE id = ?", (image_id,)).fetchone()
    assert (row["width"], row["height"]) == (40, 20)


def test_right_moves_the_marker_to_the_top_right_corner(tmp_data_dir):
    """方向语义：right = 顺时针，左上角的点应落到右上角；left 反过来。"""
    init_pool()
    path = _comfy_png(tmp_data_dir / "dir.png")
    image_id = Indexer()._process_path_sync(path)["id"]

    repository.rotate_image(image_id, "right")
    with Image.open(path) as im:
        w, h = im.size
        assert im.convert("RGB").getpixel((w - 1, 0)) == (255, 0, 0)

    repository.rotate_image(image_id, "left")
    repository.rotate_image(image_id, "left")
    with Image.open(path) as im:
        w, h = im.size
        assert im.convert("RGB").getpixel((0, h - 1)) == (255, 0, 0)


def test_no_temp_file_left_behind_and_watcher_events_suppressed(tmp_data_dir):
    """写盘要么换掉原文件、要么不动它；临时文件不留在用户目录里。"""
    init_pool()
    path = _comfy_png(tmp_data_dir / "clean.png")
    image_id = Indexer()._process_path_sync(path)["id"]

    repository.rotate_image(image_id, "right")

    leftovers = [p.name for p in tmp_data_dir.iterdir() if "seekx-rotate" in p.name]
    assert leftovers == []
    indexer = get_indexer()
    indexer.enqueue("created", path)
    assert indexer._normalize(path) not in indexer._pending, "旋转那一下该吞掉 watchdog 事件"


def test_watcher_report_after_rotate_reuses_the_same_row(tmp_data_dir):
    """就算 watchdog 还是上报了同一张图，也认得是那一行，不再插一条。"""
    init_pool()
    indexer = Indexer()
    path = _comfy_png(tmp_data_dir / "again.png")
    image_id = indexer._process_path_sync(path)["id"]

    repository.rotate_image(image_id, "left")
    payload = indexer._process_path_sync(path)

    assert payload["id"] == image_id
    assert len(_rows()) == 1


def test_rotate_purges_stale_previews(tmp_data_dir):
    """预览按内容摘要命名，转完旧那份就作废：清掉，别在 previews 里越堆越多。"""
    from app.config import previews_dir
    from app.thumbnails import generate_preview

    init_pool()
    path = _comfy_png(tmp_data_dir / "prev.png", size=(900, 600))
    image_id = Indexer()._process_path_sync(path)["id"]
    stale = generate_preview(path, image_id, 512)
    assert stale.exists()
    assert stale.name.startswith(f"{image_id}_max512")

    repository.rotate_image(image_id, "right")

    assert not stale.exists(), "旧预览没清掉，磁盘上会随旋转次数堆积"
    assert list(previews_dir().glob(f"{image_id}_max*.webp")) == []


def test_jpeg_keeps_exif_icc_dpi_sampling_and_photoshop_segment(tmp_data_dir):
    """JPG 只能重编码，但量化表 / 色度采样 / ICC / DPI / XMP / Photoshop IRB 都得留住。"""
    init_pool()
    ex = Image.Exif()
    ex[270] = "a cat, masterpiece\nSteps: 20"
    ex[271] = "TestCam"
    exif_bytes = ex.tobytes()
    path = tmp_data_dir / "p.jpg"
    _marker((60, 40)).save(
        path, quality=92, exif=exif_bytes, icc_profile=ICC, dpi=(300, 300),
        subsampling=0, progressive=True,
    )
    # Pillow 写不了 APP13，手拼一段 Photoshop IRB 插进 SOI 之后（Photoshop 导出的图都有）
    irb = b"Photoshop 3.0\x00" + b"8BIM" + b"\x00" * 8
    raw = path.read_bytes()
    seg = b"\xff\xed" + struct.pack(">H", 2 + len(irb)) + irb
    path.write_bytes(raw[:2] + seg + raw[2:])

    image_id = Indexer()._process_path_sync(path)["id"]
    # 注：Pillow 自己的 Exif.tobytes() 会把非 ASCII 的 270 写成 ???，所以这里用 ASCII；
    # 旋转路径搬的是原文件的 EXIF 原始字节，不看解码结果。
    exif_before = Image.open(path).info.get("exif")

    repository.rotate_image(image_id, "right")

    out = path.read_bytes()
    with Image.open(path) as im:
        assert im.size == (40, 60)
        assert im.info.get("icc_profile") == ICC
        assert tuple(round(v) for v in im.info.get("dpi", (0, 0))) == (300, 300)
        assert bool(im.info.get("progressive")), "原图是 progressive，转完不该变回 baseline"
        assert im.info.get("exif") == exif_before, "EXIF 必须整段原样搬回去"
        got = Image.Exif(); got.load(im.info.get("exif"))
        assert got.get(270) == "a cat, masterpiece\nSteps: 20"
    assert b"Photoshop 3.0" in out, "APP13(Photoshop IRB) 丢了等于抹掉版权信息"
    assert image_ops._jpeg_subsampling(out) == 0, "4:4:4 转成 4:2:0 会偷偷糊掉细节"
    row = get_pool().main().execute("SELECT width, height FROM images WHERE id = ?", (image_id,)).fetchone()
    assert (row["width"], row["height"]) == (40, 60)


def test_exif_orientation_is_baked_once_not_twice(tmp_data_dir):
    """带 orientation=6 的 JPG：预览里看到的是竖的，转一次只能在那个方向上加 90°。"""
    init_pool()
    ex = Image.Exif(); ex[274] = 6
    path = tmp_data_dir / "o6.jpg"
    _marker((60, 40)).save(path, quality=92, exif=ex.tobytes())
    image_id = Indexer()._process_path_sync(path)["id"]

    repository.rotate_image(image_id, "right")

    with Image.open(path) as im:
        assert im.size == (60, 40), "存储宽高：先按 EXIF 摆正成 40x60，再顺时针转回 60x40"
        got = Image.Exif(); got.load(im.info.get("exif", b"Exif\x00\x00"))
        assert got.get(274) in (None, 1), "朝向标记必须清掉，否则浏览器再转一次"
    row = get_pool().main().execute("SELECT width, height FROM images WHERE id = ?", (image_id,)).fetchone()
    assert (row["width"], row["height"]) == (60, 40)


def test_psd_and_animated_png_and_unknown_ext_are_refused(tmp_data_dir):
    """写不回去的格式一律拒绝，不能偷偷把 PSD 变成 PNG。"""
    psd = tmp_data_dir / "layered.psd"
    psd.write_bytes(b"8BPS\x00\x01" + b"\x00" * 20)
    with pytest.raises(image_ops.RotateUnsupported):
        image_ops.rotated_bytes(psd, "left")

    still = _comfy_png(tmp_data_dir / "still.png")
    apng = tmp_data_dir / "anim.png"

    def chunk(ctype: bytes, data: bytes) -> bytes:
        body = ctype + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = still.read_bytes()
    cut = 8 + 25  # 签名 + IHDR
    apng.write_bytes(raw[:cut] + chunk(b"acTL", struct.pack(">II", 3, 0)) + raw[cut:])
    with pytest.raises(image_ops.RotateUnsupported):
        image_ops.rotated_bytes(apng, "left")

    other = tmp_data_dir / "note.txt"
    other.write_text("x", encoding="utf-8")
    with pytest.raises(image_ops.RotateUnsupported):
        image_ops.rotated_bytes(other, "right")


def test_rotate_rejects_non_image_rows_and_bad_direction(tmp_data_dir):
    init_pool()
    path = _comfy_png(tmp_data_dir / "kind.png")
    image_id = Indexer()._process_path_sync(path)["id"]
    with pytest.raises(repository.RotateError):
        repository.rotate_image(image_id, "up")

    get_pool().main().execute("UPDATE images SET kind = 'video' WHERE id = ?", (image_id,))
    with pytest.raises(repository.RotateError):
        repository.rotate_image(image_id, "left")
    with Image.open(path) as im:
        assert im.size == (40, 20), "拒绝之后原文件一个字节都不该动"


def test_busy_file_maps_to_409_and_leaves_the_file_intact(tmp_data_dir, monkeypatch):
    """文件被 Photoshop 占着：报 409 并原样留着，不写半个文件、不剩临时文件。"""
    init_pool()
    path = _comfy_png(tmp_data_dir / "busy.png")
    image_id = Indexer()._process_path_sync(path)["id"]
    before = path.read_bytes()
    real_os = os

    class BlockedReplace:
        def getpid(self):
            return real_os.getpid()

        def replace(self, *_a, **_kw):
            raise PermissionError(13, "being used by another process")

        def __getattr__(self, name):
            return getattr(real_os, name)

    monkeypatch.setattr(image_ops, "os", BlockedReplace())
    with pytest.raises(image_ops.RotateBusy):
        image_ops.rotate_image_file(path, "right")

    assert path.read_bytes() == before
    assert [p.name for p in tmp_data_dir.iterdir() if "seekx-rotate" in p.name] == []


def test_api_rotate_contract(client, tmp_path):
    """接口口径：200 带回互换后的宽高；方向非法 400；未知 id 404；PSD 415。"""
    path = _comfy_png(tmp_path / "api.png")
    image_id = Indexer()._process_path_sync(path)["id"]

    r = client.post(f"/api/images/{image_id}/rotate", json={"direction": "right"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["width"], body["height"]) == (20, 40)
    assert body["original_url"] and "max=1024" in body["original_url"]

    r = client.post(f"/api/images/{image_id}/rotate", json={"direction": "up"})
    assert r.status_code == 400
    r = client.post("/api/images/424242/rotate", json={"direction": "left"})
    assert r.status_code == 404

    psd = tmp_path / "layer.psd"
    psd.write_bytes(b"8BPS\x00\x01" + b"\x00" * 20)
    psd_id = Indexer()._process_path_sync(psd)["id"]
    r = client.post(f"/api/images/{psd_id}/rotate", json={"direction": "left"})
    assert r.status_code == 415

    gone = _comfy_png(tmp_path / "gone.png")
    gone_id = Indexer()._process_path_sync(gone)["id"]
    gone.unlink()
    r = client.post(f"/api/images/{gone_id}/rotate", json={"direction": "left"})
    assert r.status_code == 404
