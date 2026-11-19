"""app.recycle：用户素材进系统回收站这条唯一入口的守卫。

为什么要单独钉一份：这套 COM 代码原先只长在 texts.py 里，于是删文本、删文件夹受它保护，
删图片和视频却是 Path.unlink() 直接永久删。同一个「删除」在两种素材上语义不同，用户只能
靠运气分辨，而 AGENTS.md §5 写的是「删除只进回收站」。现在入口收成一个，下面几条钉住收得住：
入口只有一个、守卫只拒绝不降级、真机确实搬得进去。
"""
from __future__ import annotations

import os
import types
from pathlib import Path

import pytest

from app import recycle, texts

# 本机真正的 Path 实现：导入时取，那时候还没有人贴平台补丁
REAL_PATH_CLS = type(Path("C:/x")).__name__


def test_texts_recycle_file_is_a_thin_delegate(monkeypatch):
    """texts.recycle_file 只能转发，不许留第二份 COM 实现。

    入口一分为二就是这次的病根：一份有回收站、一份没有，改的人只知道其中一份。
    """
    seen: list[object] = []
    monkeypatch.setattr(recycle, "recycle_path", lambda p: seen.append(p))
    texts.recycle_file("C:/somewhere/x.png")
    assert seen == ["C:/somewhere/x.png"]


def test_non_windows_refuses_instead_of_falling_back_to_unlink(monkeypatch, tmp_path):
    """没有系统回收站的平台直接拒绝，绝不「那就先按 unlink 删掉」。

    降级成 unlink 等于把永久删除藏进错误处理里，比没守卫更糟：调用方还以为安全。
    """
    # 换掉 recycle 模块自己那根 os 引用，不动全局 os.name：全局补丁会让同一时刻
    # 别人的 Path(...) 挑成 PosixPath（见 conftest 的 _no_platform_global_mutation）
    monkeypatch.setattr(recycle, "os", types.SimpleNamespace(name="posix"))
    p = tmp_path / "x.png"
    p.write_bytes(b"disposable")
    with pytest.raises(ValueError, match="回收站"):
        recycle.recycle_path(p)
    assert p.exists(), "拒绝就必须一个字节都不动"
    assert type(Path("C:/x")).__name__ == REAL_PATH_CLS, \
        "补丁外溢了：本机 Path 的实现被换掉，同一会话里别人的 Path 会直接抛"


@pytest.mark.skipif(os.name != "nt", reason="回收站守卫在 Windows 上验")
def test_network_share_is_refused():
    """网络共享上的「回收站」不保证可恢复（不少服务端就是永久删），所以直接拒。"""
    with pytest.raises(ValueError, match="网络路径"):
        recycle.recycle_path(Path(r"\\nas\share\x.png"))


@pytest.mark.skipif(os.name != "nt", reason="Windows recycle-bin integration")
def test_recycle_path_really_moves_the_file_out(tmp_path):
    """真机跑一次：媒体删除靠的就是这条路，桩验不出 COM 那几步对不对。"""
    p = tmp_path / "seekx-media-recycle-smoke.png"
    p.write_bytes(b"disposable")
    recycle.recycle_path(p)
    assert not p.exists()
