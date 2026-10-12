"""HA linking and fault handling, with synthetic registry and vault data only."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from ha_client import HomeAssistantClient


DEV = {"id": "device-a", "name": "Outlet", "area": "Kitchen",
       "manufacturer": "Example vendor", "model": "Model A",
       "entity_ids": ["switch.outlet_a", "sensor.outlet_a_power"]}


def linked(client, **extra):
    response = client.post("/api/codes", json={"name": "Synthetic outlet",
        "ha_link": {"device_id": DEV["id"], "entity_id": "switch.outlet_a"}, **extra})
    assert response.status_code == 201
    return response.json()


def test_entity_link_round_trip_and_legacy(client):
    code = linked(client)
    exported = client.get("/api/export").text
    assert client.post("/api/import", json={"data": exported}).status_code == 200
    assert client.get("/api/vault").json()["codes"][0]["ha_link"] == code["ha_link"]
    legacy = client.put(f"/api/codes/{code['id']}", json={"ha_link": {"device_id": "device-b"}})
    assert legacy.status_code == 200
    assert legacy.json()["ha_link"] == {"device_id": "device-b", "entity_id": None}


@pytest.mark.parametrize("link", [{"entity_id": "switch.outlet_a"},
    {"device_id": "device-a", "entity_id": "../states/switch.a"},
    {"device_id": "device-a", "entity_id": "switch.a?secret=x"}])
def test_invalid_entity_links_rejected(client, link):
    assert client.post("/api/codes", json={"name": "Invalid", "ha_link": link}).status_code == 422


@pytest.mark.parametrize("state,expected", [("on", "available"), ("off", "available"),
    ("closed", "available"), ("unavailable", "unavailable"), ("unknown", "unknown"),
    (None, "unknown")])
def test_status_reports_availability_without_attributes(client, app_module, monkeypatch, state, expected):
    monkeypatch.setattr(app_module.ha, "enabled", True)
    monkeypatch.setattr(app_module.ha, "get_state", AsyncMock(return_value={
        "state": state, "attributes": {"private": "must not be returned"}}))
    response = client.get("/api/ha/status", params={"entity_id": "switch.outlet_a"})
    assert response.json() == {"entity_id": "switch.outlet_a", "availability": expected}


def test_missing_and_unreachable_are_distinct(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.ha, "enabled", True)
    monkeypatch.setattr(app_module.ha, "get_state", AsyncMock(return_value=None))
    assert client.get("/api/ha/status?entity_id=switch.outlet_a").json()["availability"] == "missing"
    monkeypatch.setattr(app_module.ha, "get_state", AsyncMock(side_effect=RuntimeError("private details")))
    r = client.get("/api/ha/status?entity_id=switch.outlet_a")
    assert r.status_code == 503 and "private details" not in r.text
    assert client.get("/api/ha/status?entity_id=bad/id").status_code == 422


def test_refresh_empty_fields_preserves_custom_values(client, app_module, monkeypatch):
    code = linked(client, device_vendor="Custom vendor", area="Custom area")
    monkeypatch.setattr(app_module.ha, "enabled", True)
    lookup = AsyncMock(return_value=[DEV])
    monkeypatch.setattr(app_module.ha, "list_devices", lookup)
    response = client.post(f"/api/codes/{code['id']}/ha-refresh")
    assert response.status_code == 200
    assert response.json()["device_vendor"] == "Custom vendor"
    assert response.json()["area"] == "Custom area"
    assert response.json()["device_product"] == "Model A"
    assert response.json()["ha_link"] == code["ha_link"]
    lookup.assert_awaited_once_with(refresh=True)
    before = app_module.storage.path.read_bytes()
    assert client.post(f"/api/codes/{code['id']}/ha-refresh").status_code == 200
    assert app_module.storage.path.read_bytes() == before, "no-op refresh must not rewrite the vault"


@pytest.mark.parametrize("operation", ["edit", "relink", "delete"])
def test_refresh_preserves_changes_while_ha_pending(client, app_module, monkeypatch, operation):
    code = linked(client)
    monkeypatch.setattr(app_module.ha, "enabled", True)
    async def delayed_lookup(**kwargs):
        vault = app_module.storage.load()
        current = vault.codes[0]
        if operation == "edit":
            current.device_product = "User edit while waiting"
        elif operation == "relink":
            current.ha_link.device_id = "device-b"
            current.ha_link.entity_id = "switch.outlet_b"
        else:
            vault.codes.clear()
        app_module.storage.save(vault)
        return [DEV]
    monkeypatch.setattr(app_module.ha, "list_devices", delayed_lookup)
    response = client.post(f"/api/codes/{code['id']}/ha-refresh")
    assert response.status_code == {"edit": 200, "relink": 409, "delete": 404}[operation]
    saved = app_module.storage.load().codes
    if operation == "edit":
        assert saved[0].device_product == "User edit while waiting"
    elif operation == "relink":
        assert saved[0].device_vendor == "" and saved[0].ha_link.device_id == "device-b"
    else:
        assert saved == []


def test_refresh_failures_preserve_vault(client, app_module, monkeypatch):
    code = linked(client)
    before = app_module.storage.path.read_bytes()
    monkeypatch.setattr(app_module.ha, "enabled", True)
    for result, status in [(AsyncMock(return_value=[]), 404),
                           (AsyncMock(side_effect=RuntimeError("private details")), 503)]:
        monkeypatch.setattr(app_module.ha, "list_devices", result)
        response = client.post(f"/api/codes/{code['id']}/ha-refresh")
        assert response.status_code == status and "private details" not in response.text
        assert app_module.storage.path.read_bytes() == before
    unlinked = client.post("/api/codes", json={"name": "Unlinked"}).json()
    assert client.post(f"/api/codes/{unlinked['id']}/ha-refresh").status_code == 400


def test_devices_cache_and_explicit_refresh(monkeypatch):
    monkeypatch.setenv("SUPERVISOR_TOKEN", "synthetic-test-token")
    ha = HomeAssistantClient()
    requests = []
    def reply(request):
        requests.append(request)
        template = json.loads(request.content)["template"]
        assert "device_entities(did)" in template
        assert "device_attr(did, 'manufacturer')" in template
        return httpx.Response(200, json=[DEV, {**DEV, "id": "device-b", "entity_ids": ["switch.outlet_b"]}])
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(reply), **kwargs))
    async def run():
        a = await ha.list_devices()
        assert a[0]["entity_ids"] == sorted(DEV["entity_ids"])
        assert a[0]["manufacturer"] == DEV["manufacturer"]
        assert await ha.list_devices() == a
        assert len(requests) == 1
        await ha.list_devices(refresh=True)
        assert len(requests) == 2
    asyncio.run(run())


@pytest.mark.parametrize("payload", ["not JSON: 111-22-333", '{"private": "11122333"}'])
def test_bad_ha_responses_never_log_body(monkeypatch, caplog, payload):
    monkeypatch.setenv("SUPERVISOR_TOKEN", "synthetic-test-token")
    ha = HomeAssistantClient()
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(lambda req: httpx.Response(200, text=payload)), **kwargs))
    with pytest.raises(ValueError, match="Invalid HA device response"):
        asyncio.run(ha.list_devices())
    assert payload not in caplog.text
    assert "11122333" not in caplog.text and "111-22-333" not in caplog.text


@pytest.mark.parametrize("merge", [True, False])
def test_import_write_failure_is_storage_error_and_atomic(client, app_module, monkeypatch, caplog, merge):
    linked(client)
    before = app_module.storage.path.read_bytes()
    from pathlib import Path
    original = Path.replace
    def fail_replace(path, target):
        if target == app_module.storage.path:
            raise PermissionError("private/path/111-22-333")
        return original(path, target)
    monkeypatch.setattr(Path, "replace", fail_replace)
    response = client.post("/api/import", json={"data": '{"codes": []}', "merge": merge})
    assert response.status_code == 500
    assert response.json()["detail"]["error"] == "storage_error"
    assert app_module.storage.path.read_bytes() == before
    assert "private/path" not in response.text + caplog.text


def test_backup_failure_has_safe_error(client, app_module, monkeypatch, caplog):
    linked(client)
    monkeypatch.setattr(app_module.storage, "backup_local_copy", lambda **kw: (_ for _ in ()).throw(
        OSError("private/path/11122333")))
    response = client.post("/api/backup")
    assert response.status_code == 500 and response.json()["detail"]["error"] == "backup_failed"
    assert "11122333" not in response.text + caplog.text


@pytest.mark.parametrize("value", ["11122333", "111-22-333", "X-HM://0081YCYEPAB12",
    "MT:Y.K9042C00KA0648G00", "3497-011-2332"])
def test_pairing_values_redacted(app_module, value):
    assert value not in app_module._redact("Failed input: " + value)


def test_homekit_validation_errors_are_redacted(client, caplog):
    response = client.post("/api/import", json={"data": json.dumps({"codes": [
        {"name": "Bad", "homekit_flag": "111-22-333"}]})})
    assert response.status_code == 400
    assert "111-22-333" not in response.text + caplog.text
