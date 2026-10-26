"""ffmpeg / ffprobe 定位（media_tools）回归测试。

背景：安装到其他电脑时没有 ffmpeg，视频海报与容器里的 ComfyUI 提示词全部静默变空，
而视频照样能播。修法是安装包自带 ffmpeg/ffprobe + 运行时按固定优先级定位。
这里锁的就是「优先级」和「找不到时不炸」这两件事。
"""
from __future__ import annotations

import hashlib
import pytest

from app import media_tools


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    """每条用例从干净环境开始：无 env 覆盖、无 vendor、无 data/tools。"""
    monkeypatch.delenv("SUXING_FFMPEG_DIR", raising=False)
    monkeypatch.setenv("SUXING_REPO_ROOT", str(tmp_path / "empty-repo"))
    media_tools.reset_cache()
    yield
    media_tools.reset_cache()


def _write_fake(dir_, name: str) -> None:
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / f"{name}.exe").write_bytes(b"fake")


def test_env_dir_wins_over_everything_else(monkeypatch, tmp_path):
    env_dir = tmp_path / "chosen"
    _write_fake(env_dir, "ffmpeg")
    _write_fake(env_dir, "ffprobe")
    monkeypatch.setenv("SUXING_FFMPEG_DIR", str(env_dir))

    assert media_tools.ffmpeg_path() == env_dir / "ffmpeg.exe"
    assert media_tools.tool_source("ffprobe") == "env"
    assert media_tools.ffmpeg_cmd() == [str(env_dir / "ffmpeg.exe")]


def test_data_tools_dir_beats_vendor(monkeypatch, tmp_path):
    from app import config

    data_tools = tmp_path / "data" / "tools"
    _write_fake(data_tools, "ffmpeg")
    vendor = tmp_path / "repo" / "vendor" / "media-tools"
    _write_fake(vendor, "ffmpeg")
    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("SUXING_REPO_ROOT", str(tmp_path / "repo"))

    assert media_tools.ffmpeg_path() == data_tools / "ffmpeg.exe"
    assert media_tools.tool_source("ffmpeg") == "data-tools"


def test_vendor_is_used_before_path(monkeypatch, tmp_path):
    from app import config

    vendor = tmp_path / "repo" / "vendor" / "media-tools"
    _write_fake(vendor, "ffmpeg")
    on_path = tmp_path / "bin"
    _write_fake(on_path, "ffmpeg")
    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("SUXING_REPO_ROOT", str(tmp_path / "repo"))
    monkeypatch.setenv("PATH", str(on_path))

    assert media_tools.ffmpeg_path() == vendor / "ffmpeg.exe"
    assert media_tools.tool_source("ffmpeg") == "vendor"


def test_path_is_the_last_resort(monkeypatch, tmp_path):
    from app import config

    on_path = tmp_path / "bin"
    _write_fake(on_path, "ffmpeg")
    _write_fake(on_path, "ffprobe")
    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("PATH", str(on_path))

    assert media_tools.tool_source("ffmpeg") == "path"
    assert media_tools.available()


def test_missing_tools_degrade_instead_of_raising(monkeypatch, tmp_path):
    from app import config

    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("PATH", str(tmp_path / "nothing-here"))

    assert media_tools.ffmpeg_path() is None
    assert media_tools.missing_tools() == ["ffmpeg", "ffprobe"]
    # 关键：cmd() 原样返回命令名，让 subprocess 抛 FileNotFoundError，
    # 各调用点原有的「失败返回 None / 空字段 / 404」分支照常生效。
    assert media_tools.cmd("ffmpeg") == ["ffmpeg"]
    status = media_tools.status()
    assert status["available"] is False
    assert status["missing"] == ["ffmpeg", "ffprobe"]
    assert status["tools"]["ffmpeg"]["path"] is None


def test_resolution_is_cached_until_reset(monkeypatch, tmp_path):
    from app import config

    first = tmp_path / "first"
    _write_fake(first, "ffmpeg")
    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("SUXING_FFMPEG_DIR", str(first))
    assert media_tools.ffmpeg_path() == first / "ffmpeg.exe"

    second = tmp_path / "second"
    _write_fake(second, "ffmpeg")
    monkeypatch.setenv("SUXING_FFMPEG_DIR", str(second))
    assert media_tools.ffmpeg_path() == first / "ffmpeg.exe"  # 仍然吃缓存
    media_tools.reset_cache()
    assert media_tools.ffmpeg_path() == second / "ffmpeg.exe"


def test_status_does_not_spawn_subprocess(monkeypatch, tmp_path):
    from app import config

    monkeypatch.setattr(config, "DEFAULT_DATA_DIR", tmp_path / "data")

    def boom(*args, **kwargs):  # pragma: no cover - 被调用即失败
        raise AssertionError("status() 不该开子进程")

    monkeypatch.setattr(media_tools.subprocess, "run", boom)
    media_tools.status()  # 不抛 = 通过


def test_warm_reports_versions_of_the_real_binary(tmp_path):
    if not media_tools.available():
        pytest.skip("本机没有可用的 ffmpeg/ffprobe，版本探测无从校验")
    versions = media_tools.warm()
    assert versions["ffmpeg"]
    assert versions["ffprobe"]


def test_poster_cache_key_streams_the_source_hash(tmp_path):
    """海报缓存名必须等于源文件 sha256：顺手锁住「不再整份读进内存」。"""
    from app import thumbnails

    if media_tools.ffmpeg_path() is None:
        pytest.skip("需要 ffmpeg 生成海报帧")
    video = tmp_path / "clip.mp4"
    subprocess = __import__("subprocess")
    subprocess.run(
        [str(media_tools.ffmpeg_path()), "-y", "-f", "lavfi",
         "-i", "color=c=black:s=64x48:r=10:d=1", str(video)],
        capture_output=True,
        check=True,
    )
    digest = hashlib.sha256(video.read_bytes()).hexdigest()
    previews = tmp_path / "previews"
    previews.mkdir()
    import app.thumbnails as th

    original = th.previews_dir
    th.previews_dir = lambda: previews
    try:
        out = th.generate_video_thumbnail(video, 777)
    finally:
        th.previews_dir = original
    assert out is not None
    assert out.name == f"777_poster_{digest}.webp"
