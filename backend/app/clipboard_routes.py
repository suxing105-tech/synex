"""「复制文件到剪贴板」几个端点共用的落地逻辑。

各路由只负责按自己的 id 取到真实路径，剩下的存在性检查、异常→HTTP 状态码翻译
都在这里，保证音频 / 视频 / 文本三条菜单给出的提示一模一样。
"""
from __future__ import annotations

from pathlib import Path
from typing import Union

from fastapi import HTTPException

from .windows_clipboard import ClipboardFailed, ClipboardUnsupported, copy_file_to_clipboard


def copy_row_file_to_clipboard(row_id: int, path: Union[str, Path], noun: str) -> dict:
    """把某条素材记录指向的原文件放上剪贴板，返回和旧视频接口一致的响应体。"""
    p = Path(path)
    if not p.is_file():
        raise HTTPException(404, f"{noun}文件不存在，可能已被移动或删除")
    try:
        copy_file_to_clipboard(p)
    except ClipboardUnsupported as error:
        raise HTTPException(501, str(error))
    except ClipboardFailed as error:
        raise HTTPException(500, str(error))
    return {"ok": True, "id": row_id, "path": str(p), "method": "clipboard"}
