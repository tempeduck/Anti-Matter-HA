"""Read-only HA pulls and self-contained viewer; synthetic data only."""
from unittest.mock import AsyncMock

import pytest


@pytest.mark.parametrize("value,expected", [
    ("  MT:SYNTHETIC  ", "MT:SYNTHETIC"), (123456789012345678901, "123456789012345678901"),
    ("01234567890", "01234567890"), (0, "0"),
])
def test_pull_exact_scalar_without_writing(client, app_module, monkeypatch, value, expected):
    monkeypatch.setattr(app_module.ha, "enabled", True)
    lookup = AsyncMock(return_value=value)
    monkeypatch.setattr(app_module.ha, "get_attribute", lookup)
    before = app_module.storage.export_json()
    r = client.get("/api/ha/pairing-code", params={"entity_id": "sensor.fixture", "attribute": "setup_code"})
    assert r.status_code == 200 and r.json() == {"text": expected}
    assert r.headers["cache-control"] == "no-store"
    lookup.assert_awaited_once_with("sensor.fixture", "setup_code")
    assert app_module.storage.export_json() == before


@pytest.mark.parametrize("value", [True, False, 1.25, [], {"private": "do not echo"}, "", " " * 5, "x" * 8193])
def test_pull_rejects_unsupported_values_without_echo(client, app_module, monkeypatch, value):
    monkeypatch.setattr(app_module.ha, "enabled", True)
    monkeypatch.setattr(app_module.ha, "get_attribute", AsyncMock(return_value=value))
    r = client.get("/api/ha/pairing-code?entity_id=sensor.fixture&attribute=setup_code")
    assert r.status_code == 422 and r.json()["detail"]["error"] == "ha_code_invalid"
    assert "do not echo" not in r.text


def test_missing_disabled_and_faults_are_distinct_and_redacted(client, app_module, monkeypatch):
    lookup = AsyncMock(return_value=None)
    monkeypatch.setattr(app_module.ha, "get_attribute", lookup)
    monkeypatch.setattr(app_module.ha, "enabled", False)
    url = "/api/ha/pairing-code?entity_id=sensor.fixture&attribute=setup_code"
    assert client.get(url).status_code == 503
    lookup.assert_not_called()
    monkeypatch.setattr(app_module.ha, "enabled", True)
    assert client.get(url).status_code == 404
    lookup.side_effect = RuntimeError("private upstream error")
    r = client.get(url)
    assert r.status_code == 503 and "private upstream" not in r.text


@pytest.mark.parametrize("path", ["attribute", "pairing-code"])
@pytest.mark.parametrize("params", [
    {"entity_id": "../config", "attribute": "code"},
    {"entity_id": "sensor.fixture?extra=1", "attribute": "code"},
    {"entity_id": "sensor.fixture", "attribute": ""},
    {"entity_id": "sensor.fixture", "attribute": "x" * 256},
])
def test_pull_parameters_validated_before_ha(client, app_module, monkeypatch, path, params):
    lookup = AsyncMock()
    monkeypatch.setattr(app_module.ha, "get_attribute", lookup)
    assert client.get(f"/api/ha/{path}", params=params).status_code == 422
    lookup.assert_not_called()


def test_viewer_has_no_vault_data_and_no_network_dependencies(client):
    assert client.post("/api/codes", json={"name": "Private fixture must not be embedded", "notes": "private fixture notes"}).status_code == 201
    r = client.get("/api/viewer")
    assert r.status_code == 200
    assert "Private fixture must not be embedded" not in r.text and "private fixture notes" not in r.text
    assert 'filename="anti-matter-viewer.html"' in r.headers["content-disposition"]
    assert "connect-src 'none'" in r.text
    assert "<script src=" not in r.text and '<link ' not in r.text
    assert "function qr(" in r.text and "qrcode.stringToBytes" in r.text


@pytest.mark.parametrize("locale", ["../en", "unknown", "<script>", "ar", "he", "nl"])
def test_viewer_locale_allowlist(client, locale):
    r = client.get("/api/viewer", params={"lang": locale})
    assert r.status_code == 200
    expected = locale if locale in {"ar", "he", "nl"} else "en"
    direction = "rtl" if expected in {"ar", "he"} else "ltr"
    assert f'<html lang="{expected}" dir="{direction}">' in r.text
