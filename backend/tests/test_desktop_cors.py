import pytest
from fastapi.testclient import TestClient
from app.main import app


@pytest.mark.parametrize("origin", ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://127.0.0.1:5173"])
def test_desktop_can_save_settings(origin):
    client = TestClient(app)
    response = client.options("/api/settings", headers={
        "Origin": origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    actual = client.get("/api/health", headers={"Origin": origin})
    assert actual.headers["access-control-allow-origin"] == origin
    assert actual.json() == {"status": "ok"}


def test_unrelated_website_is_not_allowed():
    response = TestClient(app).options("/api/settings", headers={
        "Origin": "https://example.com", "Access-Control-Request-Method": "PUT",
    })
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
