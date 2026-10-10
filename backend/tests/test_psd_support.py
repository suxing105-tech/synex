from __future__ import annotations

import io
import sys
import types
from pathlib import Path

import pytest
from PIL import Image

from .conftest import make_png


@pytest.fixture
def api_client(init_db):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        yield client


def install_fake_psd_tools(monkeypatch, *, fail=False, width=12, height=8):
    class FakePSD:
        pass

        def composite(self):
            if fail:
                raise ValueError("invalid PSD")
            return Image.new("RGBA", (self.width, self.height), (220, 40, 80, 255))

    FakePSD.width = width
    FakePSD.height = height

    module = types.ModuleType("psd_tools")

    def open_psd(_source):
        if fail:
            raise ValueError("invalid PSD")
        return FakePSD()

    module.PSDImage = types.SimpleNamespace(open=open_psd)
    monkeypatch.setitem(sys.modules, "psd_tools", module)


def test_psd_is_classified_and_dimensions_are_read(tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch)
    from app.parser import IMAGE_EXTS, SUPPORTED_EXTS, _extract_dimensions, classify

    path = tmp_path / "layered.PSD"
    path.write_bytes(b"fake PSD")

    assert ".psd" in IMAGE_EXTS and ".psd" in SUPPORTED_EXTS
    assert classify(path) == "image"
    assert _extract_dimensions(path) == (12, 8)


def test_psd_preview_uses_composite_and_source_digest_cache(tmp_data_dir, tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch)
    from app.thumbnails import generate_preview

    path = tmp_path / "art.psd"
    path.write_bytes(b"first PSD")
    first = generate_preview(path, 17, 256)
    assert first is not None
    with Image.open(first) as rendered:
        assert rendered.size == (12, 8)
        pixel = rendered.convert("RGB").getpixel((0, 0))
        assert all(abs(actual - expected) <= 5 for actual, expected in zip(pixel, (220, 40, 80)))
    assert generate_preview(path, 17, 256) == first

    path.write_bytes(b"second PSD")
    second = generate_preview(path, 17, 256)
    assert second is not None and second != first


def test_full_psd_preview_is_cached_and_invalid_composite_fails(tmp_data_dir, tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch)
    from app.thumbnails import generate_preview

    path = tmp_path / "art.psd"
    path.write_bytes(b"valid PSD")
    full = generate_preview(path, 18, None)
    assert full is not None and "maxfull" in full.name

    install_fake_psd_tools(monkeypatch, fail=True)
    broken = tmp_path / "broken.psd"
    broken.write_bytes(b"invalid PSD")
    assert generate_preview(broken, 19, 256) is None


def test_long_psd_feed_preview_is_cropped_before_downscaling(tmp_data_dir, tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch, width=600, height=2400)
    from app.thumbnails import generate_preview

    path = tmp_path / "long.psd"
    path.write_bytes(b"long PSD")
    preview = generate_preview(path, 23, 1024, crop_aspect=(9, 16))

    assert preview is not None
    assert "crop9x16" in preview.name
    with Image.open(preview) as image:
        assert image.size == (576, 1024)


def test_real_psd_composite_decodes_when_dependency_is_installed(tmp_data_dir, tmp_path):
    psd_tools = pytest.importorskip("psd_tools")
    from app.parser import _extract_dimensions
    from app.thumbnails import generate_preview

    path = tmp_path / "generated.psd"
    psd_tools.PSDImage.frompil(Image.new("RGB", (24, 16), (30, 120, 210))).save(path)

    assert _extract_dimensions(path) == (24, 16)
    preview = generate_preview(path, 20, 64)
    assert preview is not None
    with Image.open(preview) as image:
        assert image.size == (24, 16)


def test_psd_dimensions_failure_does_not_raise(tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch, fail=True)
    from app.parser import _extract_dimensions

    path = tmp_path / "broken.psd"
    path.write_bytes(b"invalid PSD")
    assert _extract_dimensions(path) == (None, None)


def test_psd_file_endpoint_returns_webp_preview(api_client, tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch)
    from app.indexer import Indexer

    path = tmp_path / "art.psd"
    path.write_bytes(b"PSD source")
    image_id = Indexer()._process_path_sync(path)["id"]

    response = api_client.get(f"/api/images/{image_id}/file")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/webp")
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (12, 8)


def test_psd_portrait_feed_preview_is_high_resolution_and_separate_from_full_composite(api_client, tmp_path, monkeypatch):
    install_fake_psd_tools(monkeypatch, width=600, height=2400)
    from app.indexer import Indexer

    path = tmp_path / "long.psd"
    path.write_bytes(b"long PSD source")
    image_id = Indexer()._process_path_sync(path)["id"]
    item = next(item for item in api_client.get("/api/images").json()["items"] if item["id"] == image_id)
    assert "fit=psd-portrait" in item["thumbnail_url"]
    assert "fit=" not in item["original_url"]

    preview_response = api_client.get(
        f"/api/images/{image_id}/file", params={"max": 1024, "fit": "psd-portrait"}
    )
    full_response = api_client.get(f"/api/images/{image_id}/file")

    assert preview_response.status_code == 200
    assert full_response.status_code == 200
    with Image.open(io.BytesIO(preview_response.content)) as image:
        assert image.size == (576, 1024)
    with Image.open(io.BytesIO(full_response.content)) as image:
        assert image.size == (600, 2400)


def test_open_photoshop_launches_original_path(api_client, tmp_path, monkeypatch):
    import platform
    import subprocess

    from app import photoshop
    from app.indexer import Indexer

    path = tmp_path / "art work.psd"
    path.write_bytes(b"PSD source remains untouched")
    before = path.read_bytes()
    image_id = Indexer()._process_path_sync(path)["id"]
    executable = Path("C:/Program Files/Adobe/Adobe Photoshop 2026/Photoshop.exe")
    launched = []
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(photoshop, "find_photoshop_executable", lambda: executable)
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: launched.append((args, kwargs)))

    response = api_client.post(f"/api/images/{image_id}/open-photoshop")

    assert response.status_code == 200
    assert launched[0][0][0] == [str(executable), str(path.resolve())]
    assert path.read_bytes() == before


def test_open_photoshop_rejects_non_psd_and_missing_install(api_client, tmp_path, monkeypatch):
    import platform
    import subprocess

    from app import photoshop
    from app.indexer import Indexer

    png_path = make_png(tmp_path / "ordinary.png")
    png_id = Indexer()._process_path_sync(png_path)["id"]
    assert api_client.post(f"/api/images/{png_id}/open-photoshop").status_code == 400

    psd_path = tmp_path / "art.psd"
    psd_path.write_bytes(b"source")
    psd_id = Indexer()._process_path_sync(psd_path)["id"]
    monkeypatch.setattr(photoshop, "find_photoshop_executable", lambda: None)
    response = api_client.post(f"/api/images/{psd_id}/open-photoshop")
    assert response.status_code == 503
    assert "未找到 Adobe Photoshop" in response.json()["detail"]

    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setattr(photoshop, "find_photoshop_executable", lambda: Path("Photoshop.exe"))
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("failed")))
    response = api_client.post(f"/api/images/{psd_id}/open-photoshop")
    assert response.status_code == 500


def test_photoshop_discovery_checks_standard_install_folder(tmp_path, monkeypatch):
    from app import photoshop

    exe = tmp_path / "Adobe" / "Adobe Photoshop 2026" / "Photoshop.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"exe")
    monkeypatch.setattr(photoshop, "_registry_candidates", list)
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    monkeypatch.delenv("ProgramW6432", raising=False)

    assert photoshop.find_photoshop_executable() == exe.resolve()
