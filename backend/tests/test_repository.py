"""repository 单元测试。"""
from __future__ import annotations

import time

from app.repository import original_url_for, thumb_url_for


def test_original_url_includes_max_by_default():
    """original_url 默认带 max=1024，feed 拿 webp 预览，~200KB 替代 2-5MB 原图。"""
    url = original_url_for(240, 1788329145.7)
    assert url == "/api/images/240/file?max=1024&v=1788329145"


def test_original_url_none_when_mtime_missing():
    """mtime 为 None（理论上不会出现）→ 返回 None，feed 不渲染 img。"""
    assert original_url_for(1, None) is None


def test_original_url_changes_when_mtime_changes():
    """mtime 变 → URL 变 → 浏览器走新图。"""
    a = original_url_for(5, 1000.0)
    b = original_url_for(5, 2000.0)
    assert a != b


def test_thumb_url_still_works():
    """原有的 thumb_url_for 行为不能变（/thumbs/{id}.webp?v={file_mtime}）。"""
    from pathlib import Path
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        # 写一个真实 thumb 文件让 _thumb_version 能 stat 到
        thumb = td / "1.webp"
        thumb.write_bytes(b"\x00")
        time.sleep(0.01)
        url = thumb_url_for(1, str(thumb), "ready")
        assert url is not None
        assert url.startswith("/thumbs/1.webp?v=")
        v = int(url.split("?v=")[1])
        assert v > 0

def test_original_url_with_custom_max():
    """调用方显式传 max=2048 → URL 带上 max=2048。"""
    url = original_url_for(240, 1788329145.7, max_size=2048)
    assert "max=2048" in url
    assert "v=1788329145" in url


def test_original_url_with_max_none_omits_max():
    """显式 max_size=None → 不带 max 参数，Lightbox 用，拿到完整原图。"""
    url = original_url_for(240, 1788329145.7, max_size=None)
    assert url == "/api/images/240/file?v=1788329145"
    assert "max" not in url