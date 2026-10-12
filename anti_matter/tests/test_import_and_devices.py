import asyncio
import json
import logging

import httpx
import pytest


@pytest.mark.parametrize("payload", ["not JSON", "{}", "[]", '{"other": []}',
    '{"codes": [], "categories": "wrong"}',
    '{"codes": [{"name": "Invalid", "category_ids": "wrong"}], "categories": []}'])
@pytest.mark.parametrize("merge", [False, True])
def test_rejected_import_preserves_vault(client, app_module, payload, merge, caplog):
    created = client.post("/api/codes", json={"name": "Synthetic Other", "code_type": "other"})
    assert created.status_code == 201
    before = app_module.storage.path.read_bytes()
    with caplog.at_level(logging.WARNING):
        response = client.post("/api/import", json={"data": payload, "merge": merge})
    assert response.status_code == 400
    assert app_module.storage.path.read_bytes() == before
    assert "Invalid Anti-Matter export" in response.json()["detail"]
    assert payload not in caplog.text


@pytest.mark.parametrize("merge", [False, True])
def test_valid_export_roundtrip(client, merge):
    assert client.post("/api/codes", json={"name": "Synthetic Other", "code_type": "other"}).status_code == 201
    export = client.get("/api/export").text
    assert client.post("/api/import", json={"data": export, "merge": merge}).status_code == 200
    assert len(client.get("/api/codes").json()) == 1


def test_genuine_empty_export_is_supported(client):
    export = client.get("/api/export").text
    assert client.post("/api/import", json={"data": export}).status_code == 200


def test_import_io_error_is_not_reported_as_invalid_json(client, app_module, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("Synthetic write failure")
    monkeypatch.setattr(app_module.storage, "import_json", fail)
    response = client.post("/api/import", json={"data": '{"codes": [], "categories": []}'})
    assert response.status_code == 500
    assert response.json()["detail"] == "Could not write the imported vault. Please try again."


def test_manual_matter_over_wifi_does_not_imply_thread(client):
    from matter_setup_payload import ParsedSetupPayload, CommissioningFlow, generate_manual_code
    # Synthetic test payload, never used for a real device.
    payload = ParsedSetupPayload(20202021, 15, 3840, 4, CommissioningFlow.STANDARD, 65521, 32768)
    response = client.post("/api/codes", json={"name": "Synthetic WiFi Matter",
        "code_type": "matter", "manual_code": generate_manual_code(payload), "conn_wifi": True})
    assert response.status_code == 201
    assert response.json()["code_type"] == "matter"
    assert response.json()["conn_wifi"] is True
    assert response.json()["conn_matter"] is False


def test_device_facts_and_entity_ids_are_returned_and_cached(app_module, monkeypatch):
    from ha_client import HomeAssistantClient
    calls = []
    async def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, text=json.dumps([
            {"id": "device-b", "name": "Identical", "area": "Office", "manufacturer": "Example",
             "model": "Model B", "entity_ids": ["switch.b", "sensor.b", "switch.b", None]},
            {"id": "device-a", "name": "Identical", "entity_ids": "invalid"},
            {"name": "Invalid device"},
        ]))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs:
        real_client(transport=httpx.MockTransport(respond), **kwargs))
    ha = HomeAssistantClient()
    ha.enabled = True
    devices = asyncio.run(ha.list_devices())
    assert len(devices) == 2
    assert devices[0]["manufacturer"] == "Example"
    assert devices[0]["entity_ids"] == ["sensor.b", "switch.b"]
    assert devices[1]["entity_ids"] == []
    assert devices[1]["manufacturer"] == ""
    assert "device_entities(did)" in calls[0]["template"]
    assert "device_attr(did, 'manufacturer')" in calls[0]["template"]
    assert asyncio.run(ha.list_devices()) == devices
    assert len(calls) == 1


def test_device_api_passes_through_facts(client, app_module, monkeypatch):
    devices = [{"id": "device-a", "name": "Synthetic", "entity_ids": ["switch.example"],
                "manufacturer": "Example", "model": "Model A", "area": "Office"}]
    async def listing():
        return devices
    monkeypatch.setattr(app_module.ha, "list_devices", listing)
    assert client.get("/api/ha/devices").json() == devices
