"""用户素材删除的唯一入口：只进 Windows 系统回收站，永不永久删除。

为什么要单独一个模块：这套 IFileOperation 硬规矩原先只长在 texts.py 里，于是删文本、
删文件夹走它，删图片/视频/音频却直接 Path.unlink()。用户素材是不可逆资产（AGENTS.md §5），
漏一处的后果是误点一下就把原文件永久删掉，而界面上只有一条 toast。媒体删除现在也从这里走；
texts.recycle_file 留成薄壳，旧调用点和测试的 patch 目标都不用改。

三条规矩都是踩出来的，一条都不许松：
- 非 Windows、网络路径、非本地固定磁盘：直接拒，不猜、更不降级成 unlink；
- CoInitializeEx 与 IFileOperation 每一步都查 HRESULT，负数就抛；
- 收尾必须回读：aborted 或原路径还在，就是没搬成，照样抛——绝不报「已删除」。

调用方注意：搬完再动数据库。这里抛出去就意味着文件和索引都还在原处。
"""
from __future__ import annotations

import os
import uuid


def recycle_path(p):
    """把 p 移入系统回收站；任何一步没成就抛，绝不永久删除。"""
    if os.name != 'nt':
        raise ValueError('当前平台没有可用的系统回收站接口，已停止删除')
    import ctypes
    from ctypes import wintypes
    if str(p).startswith('\\\\'):
        raise ValueError('网络路径无法保证回收站恢复，已停止删除')
    if ctypes.windll.kernel32.GetDriveTypeW(str(p.anchor)) != 3:
        raise ValueError('仅支持本地固定磁盘的回收站，已停止删除')
    class GUID(ctypes.Structure):
        _fields_ = [('a', wintypes.DWORD), ('b', wintypes.WORD), ('c', wintypes.WORD), ('d', ctypes.c_ubyte * 8)]
    def guid(value):
        return GUID.from_buffer_copy(uuid.UUID(value).bytes_le)
    def check(hr):
        if hr < 0:
            raise OSError(f'回收站操作失败 (HRESULT {hr & 0xffffffff:08x})，未执行永久删除')
    def method(pointer, slot, result, *args):
        table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *args)(table[slot])
    ole, shell = ctypes.OleDLL('ole32'), ctypes.WinDLL('shell32')
    initialized = ole.CoInitializeEx(None, 2)
    check(initialized)
    operation, item = ctypes.c_void_p(), ctypes.c_void_p()
    try:
        clsid = guid('3ad05575-8857-4850-9277-11b85bdb8e09')
        iid = guid('947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8')
        check(ole.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(iid), ctypes.byref(operation)))
        shell_iid = guid('43826d1e-e718-42ee-bc55-a1e261c37bfe')
        create_item = shell.SHCreateItemFromParsingName
        create_item.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
        create_item.restype = ctypes.c_long
        check(create_item(str(p), None, ctypes.byref(shell_iid), ctypes.byref(item)))
        flags = 0x00080000 | 0x00100000 | 0x00000400 | 0x00000010 | 0x00000004
        check(method(operation, 5, ctypes.c_long, wintypes.DWORD)(operation, flags))
        check(method(operation, 18, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(operation, item, None))
        check(method(operation, 21, ctypes.c_long)(operation))
        aborted = wintypes.BOOL()
        check(method(operation, 22, ctypes.c_long, ctypes.POINTER(wintypes.BOOL))(operation, ctypes.byref(aborted)))
        if aborted.value or p.exists():
            raise OSError('回收站操作未完成，未执行永久删除')
    finally:
        if item.value:
            method(item, 2, wintypes.ULONG)(item)
        if operation.value:
            method(operation, 2, wintypes.ULONG)(operation)
        ole.CoUninitialize()
