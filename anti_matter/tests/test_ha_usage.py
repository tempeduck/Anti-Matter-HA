"""Automatic deployment flags with synthetic HA activity and controlled races."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from ha_client import HomeAssistantClient
from models import MatterCode
from storage import VaultBackupError, VaultChangedError

LINK = {"device_id": "device-a", "entity_id": "switch.fixture"}


def add(client, **extra):
    response = client.post("/api/codes", json={"name": "Synthetic deployed device", "ha_link": LINK, **extra})
    assert response.status_code == 201
    return response.json()


def snapshot(*, exists=True, active=True, running=True):
    return {"running": running, "devices": {"device-a": {
        "exists": exists, "entity_ids": ["switch.fixture", "sensor.fixture"] if exists else [],
        "active_entity_ids": ["switch.fixture"] if active and exists else []}}}


def setup(app, monkeypatch, reply=None):
    monkeypatch.setattr(app.ha, "enabled", True)
    read = AsyncMock(return_value=reply or snapshot())
    monkeypatch.setattr(app.ha, "usage_snapshot", read)
    return read


def sync(app):
    return asyncio.run(app._sync_ha_usage())


def current(app):
    return app.storage.load().codes[0]


def test_legacy_defaults_auto_and_manual_api_choices_are_preserved(client, app_module, monkeypatch):
    assert MatterCode(name="Old linked record", ha_link=LINK).in_use_mode == "auto"
    code = add(client, in_use=False)
    assert code["in_use_mode"] == "manual"
    read = setup(app_module, monkeypatch)
    assert sync(app_module) == 0
    read.assert_not_awaited()
    assert current(app_module).in_use is False
    assert client.put(f"/api/codes/{code['id']}", json={"in_use_mode": None}).status_code == 422
    assert client.put(f"/api/codes/{code['id']}", json={"in_use_mode": "invalid"}).status_code == 422


def test_confirmed_activity_sets_in_use_with_exact_verified_backup(client, app_module, monkeypatch):
    add(client)
    before = app_module.storage.path.read_bytes()
    setup(app_module, monkeypatch)
    assert sync(app_module) == 1
    code = current(app_module)
    assert code.in_use is True and code.in_use_mode == "auto"
    backups = list((app_module.storage.data_dir / "backups").glob("*.json"))
    assert len(backups) == 1 and backups[0].read_bytes() == before
    assert backups[0].stat().st_mode & 0o777 == 0o600
    raw = app_module.storage.path.read_bytes()
    assert sync(app_module) == 0 and app_module.storage.path.read_bytes() == raw
    assert len(list((app_module.storage.data_dir / "backups").glob("*.json"))) == 1


@pytest.mark.parametrize("in_use", [False, True])
def test_no_usable_state_retains_both_prior_values(client, app_module, monkeypatch, in_use):
    add(client, in_use=in_use, in_use_mode="auto")
    setup(app_module, monkeypatch, snapshot(active=False))
    before = app_module.storage.path.read_bytes()
    assert sync(app_module) == 0 and current(app_module).in_use is in_use
    assert app_module.storage.path.read_bytes() == before


def test_missing_device_requires_two_running_checks_at_least_a_minute_apart(client, app_module, monkeypatch):
    add(client, in_use=True, in_use_mode="auto")
    setup(app_module, monkeypatch, snapshot(exists=False))
    monkeypatch.setattr(app_module, "_usage_now", lambda: 100)
    assert sync(app_module) == 0 and current(app_module).in_use is True
    monkeypatch.setattr(app_module, "_usage_now", lambda: 159)
    assert sync(app_module) == 0 and current(app_module).in_use is True
    monkeypatch.setattr(app_module, "_usage_now", lambda: 160)
    assert sync(app_module) == 1 and current(app_module).in_use is False
    assert sync(app_module) == 0


@pytest.mark.parametrize("interruption", ["starting", "error", "exists"])
def test_startup_error_or_registry_reappearance_breaks_removal_sequence(client, app_module, monkeypatch, interruption, caplog):
    add(client, in_use=True, in_use_mode="auto")
    read = setup(app_module, monkeypatch, snapshot(exists=False))
    monkeypatch.setattr(app_module, "_usage_now", lambda: 100)
    assert sync(app_module) == 0
    if interruption == "error":
        read.side_effect = RuntimeError("private HA response must not be logged")
    else:
        read.return_value = snapshot(running=False) if interruption == "starting" else snapshot(active=False)
    monkeypatch.setattr(app_module, "_usage_now", lambda: 170)
    assert sync(app_module) == 0
    read.side_effect = None
    read.return_value = snapshot(exists=False)
    monkeypatch.setattr(app_module, "_usage_now", lambda: 230)
    assert sync(app_module) == 0 and current(app_module).in_use is True
    assert "private HA response" not in caplog.text


def test_selected_entity_must_belong_to_device_and_be_usable(client, app_module, monkeypatch):
    code = add(client, ha_link={"device_id": "device-a", "entity_id": "switch.unrelated"})
    setup(app_module, monkeypatch)
    assert sync(app_module) == 0 and current(app_module).in_use is False
    client.put(f"/api/codes/{code['id']}", json={"ha_link": {"device_id": "device-a"}})
    assert sync(app_module) == 1 and current(app_module).in_use is True


@pytest.mark.parametrize("operation", ["manual", "relink", "delete", "metadata"])
def test_activity_wait_preserves_concurrent_user_changes(client, app_module, monkeypatch, operation):
    add(client)
    setup(app_module, monkeypatch)
    async def pending(ids):
        vault = app_module.storage.load()
        code = vault.codes[0]
        if operation == "manual":
            code.in_use_mode = "manual"
            code.in_use = False
        elif operation == "relink":
            code.ha_link.device_id = "device-b"
        elif operation == "delete":
            vault.codes.clear()
        else:
            code.notes = "User notes written during HA request"
        app_module.storage.save(vault)
        return snapshot()
    monkeypatch.setattr(app_module.ha, "usage_snapshot", pending)
    changed = sync(app_module)
    assert changed == (1 if operation == "metadata" else 0)
    if operation == "delete":
        assert app_module.storage.load().codes == []
    else:
        saved = current(app_module)
        assert saved.in_use is (operation == "metadata")
        if operation == "metadata":
            assert saved.notes == "User notes written during HA request"
        elif operation == "relink":
            assert saved.ha_link.device_id == "device-b"


@pytest.mark.parametrize("failure", [VaultBackupError, OSError])
def test_failed_save_or_backup_keeps_current_flags(client, app_module, monkeypatch, failure):
    add(client)
    setup(app_module, monkeypatch)
    before = app_module.storage.path.read_bytes()
    monkeypatch.setattr(app_module.storage, "save_with_backup", lambda *args: (_ for _ in ()).throw(failure("private path")))
    assert sync(app_module) == 0 and app_module.storage.path.read_bytes() == before


def test_revision_race_keeps_user_changes_and_next_check_retries(client, app_module, monkeypatch):
    add(client)
    setup(app_module, monkeypatch)
    original = app_module.storage.save_with_backup
    def concurrent_change(*args):
        vault = app_module.storage.load()
        vault.codes[0].notes = "Concurrent notes survive"
        app_module.storage.save(vault)
        raise VaultChangedError("Changed")
    monkeypatch.setattr(app_module.storage, "save_with_backup", concurrent_change)
    assert sync(app_module) == 0 and current(app_module).in_use is False
    monkeypatch.setattr(app_module.storage, "save_with_backup", original)
    assert sync(app_module) == 1 and current(app_module).notes == "Concurrent notes survive"


def test_auto_editor_save_cannot_revert_a_new_background_confirmation(client, app_module, monkeypatch):
    code = add(client)
    setup(app_module, monkeypatch)
    assert sync(app_module) == 1
    response = client.put(f"/api/codes/{code['id']}", json={"notes": "Edited later", "in_use": False, "in_use_mode": "auto"})
    assert response.status_code == 200 and response.json()["in_use"] is True
    assert response.json()["notes"] == "Edited later"
    response = client.put(f"/api/codes/{code['id']}", json={"in_use": False})
    assert response.json()["in_use_mode"] == "manual"
    assert sync(app_module) == 0 and current(app_module).in_use is False


@pytest.mark.parametrize("mode,expected", [("auto", False), ("manual", True)])
def test_unlink_clears_only_automatic_deployment_flags(client, mode, expected):
    code = add(client, in_use=True, in_use_mode=mode)
    response = client.put(f"/api/codes/{code['id']}", json={"ha_link": {}})
    assert response.status_code == 200 and response.json()["in_use"] is expected


def test_ha_disabled_and_unlinked_records_do_not_query_or_write(client, app_module, monkeypatch):
    add(client, ha_link={})
    read = setup(app_module, monkeypatch)
    before = app_module.storage.path.read_bytes()
    assert sync(app_module) == 0
    read.assert_not_awaited()
    monkeypatch.setattr(app_module.ha, "enabled", False)
    assert sync(app_module) == 0 and app_module.storage.path.read_bytes() == before


def test_activity_reader_requires_running_core_and_returns_no_private_states(monkeypatch):
    ha = HomeAssistantClient()
    ha.enabled = True
    ha.token = "synthetic-fixture-only"
    calls = []
    def reply(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/config"):
            return httpx.Response(200, json={"state": "RUNNING", "private": "not returned"})
        template = json.loads(request.content)["template"]
        assert "has_value(eid)" in template and "device_attr(did, 'id') == did" in template
        assert "restored" in template and "assumed_state" in template
        assert '"update"' not in template
        return httpx.Response(200, json=[{"id": "device-a", "exists": True,
            "entity_ids": ["switch.fixture"], "active_entity_ids": ["switch.fixture"],
            "private": "not returned"}])
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(reply), **kw))
    result = asyncio.run(ha.usage_snapshot(["device-a"]))
    assert calls == ["/core/api/config", "/core/api/template"]
    assert "private" not in json.dumps(result)
    assert result["running"] is True


@pytest.mark.parametrize("reply", [[], [{"id": "device-a", "exists": False, "entity_ids": ["switch.fixture"], "active_entity_ids": []}],
    [{"id": "device-a", "exists": True, "entity_ids": [], "active_entity_ids": ["switch.unrelated"]}]])
def test_partial_or_contradictory_activity_response_is_not_removal_evidence(monkeypatch, reply):
    ha = HomeAssistantClient()
    ha.enabled = True
    real_client = httpx.AsyncClient
    def response(request):
        return httpx.Response(200, json={"state": "RUNNING"} if request.method == "GET" else reply)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(response), **kw))
    with pytest.raises(ValueError):
        asyncio.run(ha.usage_snapshot(["device-a"]))
