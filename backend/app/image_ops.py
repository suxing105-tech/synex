"""图片原地旋转（左右各 90°）+ 元数据原样搬运。

为什么不能「就一句 Pillow」：实测 Pillow 12.3 存 PNG 时不会把原文件的
tEXt / iTXt / zTXt 写回去（im.info 里看得见 prompt / workflow，save 之后整条
chunk 没了），顺手还丢掉 pHYs / cHRM。而在这个项目里那些 chunk 就是用户的
ComfyUI 工作流和提示词 —— 「点一下旋转按钮把工作流清掉」比不转更糟。
所以这里只把像素交给 Pillow，元数据按 chunk 整段字节从原文件搬回新文件。

JPEG 同理但做不到逐字节：旋转必须重编码。Pillow 认得的（EXIF / ICC / DPI /
注释 / 量化表 / 色度采样 / 是否 progressive）显式传回去；Pillow 不认的
APP13(Photoshop IRB) 与 APP1(XMP) 用 extra 原样搬。已知不搬 APP14 Adobe
（新文件按 JFIF APP0 表述，色度转换仍走标准 YCbCr）。
"""
from __future__ import annotations

import io
import os
import struct
from pathlib import Path

ROTATE_DIRECTIONS = ("left", "right")
"""left = 逆时针 90°，right = 顺时针 90°（以用户看到的画面为基准）。"""

SUPPORTED_ROTATE_EXTS = {".png", ".webp", ".jpg", ".jpeg"}
"""PSD 不在里面：写不回 PSD，只能拒绝，不能偷偷把它变成 PNG。"""


class RotateError(Exception):
    """旋转失败基类；HTTP 层按子类映射状态码。"""


class RotateUnsupported(RotateError):
    """这个文件转不了（→ 415）。"""


class RotateDecodeFailed(RotateError):
    """读不出来 / 编码失败 / 图太大（→ 422）。"""


class RotateBusy(RotateError):
    """文件或目录正被别的程序占用（→ 409）。"""


class RotateWriteFailed(RotateError):
    """落盘失败（→ 500）。"""


# ---------- PNG：chunk 整段搬运 ----------

_PNG_SIG = b"\x89PNG\r\n\x1a\n"

# 原样搬走的 ancillary chunk。项目实际库里出现过的是 tEXt(prompt/workflow/
# Software/CreationTime)、iTXt(XMP)、iCCP、pHYs、cHRM；其余按 PNG 规范补全。
# 白名单外的杂项 chunk 跟随 Pillow 的输出（宁可少带，不带错的）。
_PNG_KEEP = frozenset(
    {
        b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"iCCP", b"pHYs", b"cHRM", b"gAMA",
        b"sRGB", b"bKGD", b"sBIT", b"tRNS", b"hIST", b"sPLT", b"oFFs", b"pCAL", b"sTER",
    }
)
# APNG：只重编码第一帧会把动画变成静帧、帧描述(fcTL)还对不上新尺寸，直接拒绝。
_PNG_REJECT = frozenset({b"acTL", b"fcTL"})


def _png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    """返回 [(chunk 类型, 含长度与 CRC 的整段字节)]，顺序即文件里的顺序。"""
    if not data.startswith(_PNG_SIG):
        raise RotateDecodeFailed("不是有效的 PNG 文件")
    out: list[tuple[bytes, bytes]] = []
    i = len(_PNG_SIG)
    while i + 8 <= len(data):
        length = struct.unpack(">I", data[i : i + 4])[0]
        ctype = data[i + 4 : i + 8]
        end = i + 12 + length
        if end > len(data):
            raise RotateDecodeFailed("PNG 文件被截断")
        out.append((ctype, data[i:end]))
        if ctype == b"IEND":
            break
        i = end
    if not out or out[0][0] != b"IHDR":
        raise RotateDecodeFailed("PNG 缺少 IHDR")
    return out


def _png_keep_chunks(data: bytes, drop_exif: bool) -> bytes:
    chunks = _png_chunks(data)
    for ctype, _raw in chunks:
        if ctype in _PNG_REJECT:
            raise RotateUnsupported("动画 PNG（APNG）不支持旋转")
    keep = bytearray()
    for ctype, raw in chunks:
        if ctype not in _PNG_KEEP:
            continue
        # 带 orientation 的 PNG 少见但存在：像素已经按朝向转过，再把原来那条
        # eXIf 搬回去就是二次旋转，所以这条整段丢掉（其余 chunk 不受影响）。
        if ctype == b"eXIf" and drop_exif:
            continue
        keep += raw
    return bytes(keep)


def _png_with_chunks(new_data: bytes, keep: bytes) -> bytes:
    """新文件的 IHDR/PLTE + 原文件的 ancillary chunk + 新文件的 IDAT/IEND。

    搬来的 chunk 一律插在首个 IDAT 之前：这一个位置同时满足 tRNS 必须在
    PLTE 之后、IDAT 之前，以及 bKGD 必须在 PLTE 之后。Pillow 自己生成的
    ancillary（iCCP 等）整批丢掉，避免和搬来的那一份重复。
    """
    chunks = _png_chunks(new_data)
    out = bytearray(_PNG_SIG)
    middle = bytearray()
    tail = bytearray()
    for ctype, raw in chunks:
        if ctype in (b"IHDR", b"PLTE"):
            out += raw
        elif ctype in (b"IDAT", b"IEND"):
            tail += raw
        # 其余是 Pillow 重新生成的 ancillary：丢弃，统一用 keep 那一份
    if not tail:
        raise RotateDecodeFailed("旋转结果缺少图像数据")
    out += keep + tail
    return bytes(out)


def _rotate_png(oriented, op, data: bytes, drop_exif: bool) -> bytes:
    keep = _png_keep_chunks(data, drop_exif)
    buf = io.BytesIO()
    oriented.transpose(op).save(buf, format="PNG")
    return _png_with_chunks(buf.getvalue(), keep)


# ---------- JPEG：段级搬运 + 编码参数回传 ----------

_XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"
_SOF_MARKERS = (0xC0, 0xC1, 0xC2, 0xC3)


def _jpeg_segments(data: bytes) -> list[tuple[int, bytes]]:
    """返回 [(marker, 含 marker 与长度的整段)]，走到 SOS 为止。"""
    if not data.startswith(b"\xff\xd8"):
        raise RotateDecodeFailed("不是有效的 JPEG 文件")
    out: list[tuple[int, bytes]] = []
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            break
        marker = data[i + 1]
        if marker == 0xDA:  # SOS：后面是压缩流，别再按段走
            break
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        end = i + 2 + length
        if end > len(data):
            raise RotateDecodeFailed("JPEG 文件被截断")
        out.append((marker, data[i:end]))
        i = end
    return out


def _jpeg_extra(data: bytes) -> bytes:
    """Pillow 不会自己写、但整段搬走就完事的：APP13(Photoshop IRB) 与 APP1(XMP)。"""
    keep = bytearray()
    for marker, raw in _jpeg_segments(data):
        if marker == 0xED:
            keep += raw
        elif marker == 0xE1 and raw[4 : 4 + len(_XMP_NS)] == _XMP_NS:
            keep += raw
    return bytes(keep)


def _jpeg_subsampling(data: bytes) -> int | None:
    """从 SOFn 的采样因子读出色度采样：4:4:4 → 0、4:2:0 → 2、其余 → 1。

    Pillow 存 JPEG 默认按 4:2:0，不显式传就等于把原来 4:4:4 的图偷偷改掉细节
    （实测一张 413KB 的图会掉到 208KB）。读不出来返回 None，交给 Pillow 决定。
    """
    for marker, raw in _jpeg_segments(data):
        if marker not in _SOF_MARKERS:
            continue
        # raw 前 4 字节是 FF + marker + 长度，所以 ncomp 在 9、第 k 个分量
        # 的采样因子在 11 + 3k（前一个是分量 ID，后一个是量化表号）
        ncomp = raw[9] if len(raw) > 9 else 0
        if ncomp <= 0:
            return None
        if ncomp == 1:
            return 0  # 灰度没有色度采样
        factors = [raw[11 + 3 * k] for k in range(ncomp) if len(raw) > 11 + 3 * k]
        if not factors:
            return None
        if all(f == 0x11 for f in factors):
            return 0
        if factors[0] == 0x22:
            return 2
        return 1
    return None


def _rotate_jpeg(source, oriented, op, data: bytes, exif_bytes: bytes | None) -> bytes:
    kw: dict = {"optimize": True, "extra": _jpeg_extra(data)}
    # 量化表原样传回去 = 尽量维持原来的压缩强度（quality="keep" 要求存的还是
    # JpegImageFile 本身，transpose 出来的新图不满足，只能显式给 qtables）
    qtables = getattr(source, "quantization", None)
    if qtables:
        kw["qtables"] = qtables
    subsampling = _jpeg_subsampling(data)
    if subsampling is not None:
        kw["subsampling"] = subsampling
    if source.info.get("progressive"):
        kw["progressive"] = True
    for key in ("icc_profile", "dpi", "comment"):
        value = oriented.info.get(key)
        if value is None:
            value = source.info.get(key)
        if value is not None:
            kw[key] = value
    if exif_bytes:
        kw["exif"] = exif_bytes
    buf = io.BytesIO()
    oriented.transpose(op).save(buf, format="JPEG", **kw)
    return buf.getvalue()


def _rotate_webp(oriented, op, exif_bytes: bytes | None) -> bytes:
    kw: dict = {"quality": 100, "method": 6}
    if exif_bytes:
        kw["exif"] = exif_bytes
    for key in ("icc_profile", "xmp"):
        value = oriented.info.get(key)
        if value:
            kw[key] = value
    buf = io.BytesIO()
    oriented.transpose(op).save(buf, format="WEBP", **kw)
    return buf.getvalue()


# ---------- 入口 ----------

def rotated_bytes(path: Path, direction: str) -> bytes:
    """把图片转 90°，返回新文件字节。只读原文件，不碰磁盘。"""
    if direction not in ROTATE_DIRECTIONS:
        raise RotateUnsupported("旋转方向只支持 left / right")
    ext = path.suffix.lower()
    if ext == ".psd":
        raise RotateUnsupported("PSD 无法写回，不支持旋转")
    if ext not in SUPPORTED_ROTATE_EXTS:
        raise RotateUnsupported(f"{ext or '该'}格式不支持旋转")
    try:
        from PIL import Image, ImageOps
    except ImportError as e:  # pragma: no cover - sidecar 里一定带 Pillow
        raise RotateDecodeFailed("缺少 Pillow，无法旋转图片") from e
    try:
        data = path.read_bytes()
    except PermissionError as e:
        raise RotateBusy(f"原文件正被其它程序占用，请先关闭再旋转（{path.name}）") from e
    except OSError as e:
        raise RotateWriteFailed(f"读取原文件失败：{e.strerror or e}") from e

    # Pillow 的 ROTATE_90 是逆时针，这里按「用户看着画面往哪边转」来命名。
    op = Image.Transpose.ROTATE_90 if direction == "left" else Image.Transpose.ROTATE_270
    try:
        source = Image.open(io.BytesIO(data))
        source.load()
    except Exception as e:
        # 解压炸弹（超大图）也由 Pillow 在这里主动拒绝，别当成损坏文件
        raise RotateDecodeFailed(f"图片读不出来或过大，未旋转（{type(e).__name__}: {e}）") from e

    try:
        orientation = int(source.getexif().get(274) or 1)
    except Exception:
        orientation = 1
    # 先按 EXIF 摆正：预览里用户看到的就是摆正后的画面，旋转必须以那个方向为基准。
    # exif_transpose 会把 orientation 标记清掉，所以不会二次旋转。
    oriented = ImageOps.exif_transpose(source) if orientation not in (0, 1) else source
    exif_bytes = oriented.info.get("exif") or source.info.get("exif")
    try:
        if ext == ".png":
            return _rotate_png(oriented, op, data, drop_exif=orientation not in (0, 1))
        if ext == ".webp":
            return _rotate_webp(oriented, op, exif_bytes)
        return _rotate_jpeg(source, oriented, op, data, exif_bytes)
    except RotateError:
        raise
    except MemoryError as e:
        raise RotateDecodeFailed("图片太大，内存不够，未旋转") from e
    except Exception as e:
        raise RotateDecodeFailed(f"旋转后保存失败：{type(e).__name__}: {e}") from e


def _atomic_replace(path: Path, data: bytes) -> None:
    """同目录临时文件 + os.replace：失败时原文件一个字节都不动。"""
    tmp = path.with_name(f".{path.stem}.seekx-rotate-{os.getpid()}.tmp")
    try:
        tmp.write_bytes(data)
    except PermissionError as e:
        raise RotateBusy(f"目录不可写，无法旋转（{path.parent}）") from e
    except OSError as e:
        raise RotateWriteFailed(f"写入临时文件失败：{e.strerror or e}") from e
    try:
        os.replace(tmp, path)
    except PermissionError as e:
        raise RotateBusy("文件正被其它程序占用（例如 Photoshop），请先关闭再旋转") from e
    except OSError as e:
        raise RotateWriteFailed(f"替换原文件失败：{e.strerror or e}") from e
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def rotate_image_file(path: Path, direction: str) -> None:
    """原地旋转一个图片文件（原子替换）。失败抛 RotateError 子类。"""
    _atomic_replace(path, rotated_bytes(path, direction))
