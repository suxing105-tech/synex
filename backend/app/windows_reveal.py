"""Select the exact original file via the Windows shell, without command-line parsing."""
from pathlib import Path
import ctypes
from ctypes import wintypes


def reveal_file(path: Path) -> None:
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    ole = ctypes.OleDLL('ole32')
    shell.ILCreateFromPathW.argtypes = [wintypes.LPCWSTR]
    shell.ILCreateFromPathW.restype = ctypes.c_void_p
    shell.ILFree.argtypes = [ctypes.c_void_p]
    shell.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, wintypes.DWORD]
    shell.SHOpenFolderAndSelectItems.restype = ctypes.c_long
    ole.CoInitialize.argtypes = [ctypes.c_void_p]
    ole.CoInitialize.restype = ctypes.c_long
    initialized = ole.CoInitialize(None) >= 0
    pidl = None
    try:
        pidl = shell.ILCreateFromPathW(str(path.resolve()))
        if not pidl:
            raise OSError('无法解析文件位置')
        result = shell.SHOpenFolderAndSelectItems(pidl, 0, None, 0)
        if result < 0:
            raise OSError(f'无法打开文件位置 ({result})')
    finally:
        if pidl:
            shell.ILFree(pidl)
        if initialized:
            ole.CoUninitialize()
