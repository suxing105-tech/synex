"""DPAPI 保护的凭据存储：视觉模型反推与云端生成共用这一套。

为什么要抽出来：「Windows 用 DPAPI CurrentUser、别的平台只存本次进程」这套规则在
reverse_prompts 里已经跑了一年多，云端账号要的是同一件事。两处各写一遍的结果必然是
其中一处忘了打码、或者忘了只回 has_api_key，key 就从接口漏出去了。

两条不许破的规矩：
- 明文只在「取出 key 去发请求」的那一瞬间存在于内存；入库的一律是密文 BLOB；
- 任何接口只回 has_api_key 布尔值，没有「把 key 读出来再填回去」这条路。
"""
from __future__ import annotations

import ctypes
import sys

from fastapi import HTTPException

# 非 Windows 上 key 只活在本次进程，按 (库路径, 作用域) 存着，重启必须重填。
SESSION_KEYS: dict[tuple[str, object], str] = {}


def crypt(data: bytes, *, decrypt: bool = False) -> bytes:
    """DPAPI CurrentUser，不弹界面；密文永不通过接口返回。"""
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    src = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    out = Blob()
    dll = ctypes.WinDLL("crypt32", use_last_error=True)
    fn = dll.CryptUnprotectData if decrypt else dll.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(src), None, None, None, None, 1, ctypes.byref(out)):
        raise HTTPException(500, "密钥加密或解密失败，请重新配置 API Key")
    try:
        return ctypes.string_at(out.data, out.size)
    finally:
        free = ctypes.WinDLL("kernel32", use_last_error=True).LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(out.data)


def key_persistence() -> str:
    """encrypted = 能跨重启；session = 重启要重填（界面上要照这个说）。"""
    return "encrypted" if sys.platform == "win32" else "session"


def protect(text: str) -> bytes | None:
    """加密成入库的 BLOB。非 Windows 没有可持久化的密文，回 None（调用方改用 session）。"""
    if not text or sys.platform != "win32":
        return None
    return crypt(text.encode("utf-8"))


def unprotect(blob) -> str:
    if not blob:
        return ""
    if sys.platform != "win32":
        raise HTTPException(400, "此密钥由 Windows 加密，请在当前设备重新输入")
    return crypt(bytes(blob), decrypt=True).decode("utf-8")


def session_put(scope, value: str) -> None:
    SESSION_KEYS[scope] = value


def session_get(scope) -> str:
    return SESSION_KEYS.get(scope, "")


def session_pop(scope) -> None:
    SESSION_KEYS.pop(scope, None)
