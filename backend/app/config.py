"""应用配置 + 路径常量。

设计要点：
- 所有运行时数据落到 ``<cwd>/data/``，便于调试时直接看到文件。
- 通过 ``SUXING_DATA_DIR`` (Tauri sidecar 注入) 或 ``SUXING_GALLERY_DATA_DIR`` (旧 dev 别名)
  环境变量切换；后者用于向后兼容。
- 配置文件 ``data/config.json`` 持久化监听目录、Live 开关等用户偏好。
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path


# ---------- 路径 ----------

DEFAULT_DATA_DIR = Path(
    os.environ.get("SUXING_DATA_DIR")
    or os.environ.get("SUXING_GALLERY_DATA_DIR")
    or (Path.cwd() / "data")
)


@dataclass
class Config:
    """可持久化的用户配置。"""

    watch_dirs: list[str] = field(default_factory=list)
    theme: str = "dark"  # 仅 dark；保留字段便于 P1 切亮色
    live_enabled: bool = True
    scan_workers: int = 4
    comfyui_url: str = "http://127.0.0.1:8188"  # 本机 ComfyUI 地址
    comfyui_enabled: bool = True  # 是否启用 ComfyUI 集成
    # 云端生成（RunningHub 的收费模型 API）没有总开关：填了 Key 就是愿意走这条路。
    # 挡在花钱前面的是那一下点击、弹窗里先报出来的预估价，和下面这两道上限。
    # 花钱闸门，0 = 不限。单次上限拦「这一条太贵」，当日上限拦「今天上头了」。
    cloud_max_single_coins: float = 0.0
    cloud_max_daily_coins: float = 0.0

    @classmethod
    def load(cls, path: Path) -> "Config":
        if not path.exists():
            return cls()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls()
        # 兼容未知字段：仅取已声明的键
        valid_keys = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in raw.items() if k in valid_keys})

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def update(self, **kwargs: object) -> None:
        for k, v in kwargs.items():
            if k in self.__dataclass_fields__:
                setattr(self, k, v)


# ---------- 路径辅助 ----------

def data_dir() -> Path:
    DEFAULT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DEFAULT_DATA_DIR


def db_path() -> Path:
    return data_dir() / "db.sqlite"


def previews_dir() -> Path:
    p = data_dir() / "previews"
    p.mkdir(parents=True, exist_ok=True)
    return p


def inbox_dir() -> Path:
    """拖拽导入的固定收件箱目录。

    设计取舍：
    - 不放到 watch_dirs：拖入时直接调用 Indexer._process_path_sync 索引，
      避免 watchdog + 直接调用双路径导致的重复扫描。
    - 文件保留在收件箱（用户可从 DetailPanel「打开位置」到 OS 文件管理器查看）。
    """
    p = data_dir() / "inbox"
    p.mkdir(parents=True, exist_ok=True)
    return p


def cloud_output_root() -> Path:
    """云端产物的落盘根：<数据目录>/generated/。

    故意不放进 watch_dirs：自己监听自己 = 同一个文件被 watchdog 与直接索引抢两次。
    inbox 早给过结论——落盘后直接调 Indexer._process_path_sync 认领就够了。
    """
    p = data_dir() / "generated"
    p.mkdir(parents=True, exist_ok=True)
    return p


def logs_dir() -> Path:
    p = data_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def config_path() -> Path:
    return data_dir() / "config.json"


def load_config() -> Config:
    return Config.load(config_path())


def save_config(cfg: Config) -> None:
    cfg.save(config_path())
