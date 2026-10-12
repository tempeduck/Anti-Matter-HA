"""Discovery/upserts against synthetic HA and vaults; no live account access."""
import json
import os
from unittest.mock import AsyncMock

import pytest

from ha_discovery import parse_code
from homekit_payload import compose_setup_uri
from models import MatterCode
from storage import VaultBackupError, VaultChangedError

MT = "MT:Y.K9042C00KA0648G00"
HK = compose_setup_uri(category_id=4, flag=10, password="11122333", setup_id="AB12")


def device(did="device-a", **kwargs):
    return {"id": did, "name": "Synthetic device", "manufacturer": "Example vendor", "model": "Model A", "area": "Kitchen",
            "entity_ids": ["sensor.fixture_a", "switch.fixture_a"], **kwargs}


def setup_ha(app, monkeypatch, devices=None, states=None):
    monkeypatch.setattr(app.ha, "enabled", True)
    monkeypatch.setattr(app.ha, "list_devices", AsyncMock(return_value=devices if devices is not None else [device()]))
    monkeypatch.setattr(app.ha, "list_states", AsyncMock(return_value=states if states is not None else [{"entity_id": "sensor.fixture_a", "attributes": {"qr_code": MT}}]))


def search(client):
    r = client.post("/api/ha/discover")
    assert r.status_code == 200, r.text
    return r.json()


def apply(client, preview, rows=None):
    selected = rows if rows is not None else [row for row in preview["rows"] if row["status"] in {"new", "update"}]
    return client.post("/api/ha/discover/apply", json={"session_id": preview["session_id"], "candidate_ids": [row["id"] for row in selected]})


def create(client, **fields):
    r = client.post("/api/codes", json={"name": "Custom saved name", **fields})
    assert r.status_code == 201, r.text
    return r.json()


def test_search_read_only_new_device_and_atomic_apply_with_exact_backup(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch)
    before = client.get("/api/vault").json()
    raw = app_module.storage.path.read_bytes()
    preview = search(client)
    assert preview["devices_searched"] == 1 and preview["rows"][0]["status"] == "new"
    assert MT not in json.dumps(preview), "preview needs field names, not raw secrets"
    assert client.get("/api/vault").json() == before
    r = apply(client, preview)
    assert r.status_code == 200 and r.json()["added"] == 1 and r.json()["updated"] == 0
    code = client.get("/api/vault").json()["codes"][0]
    assert code["qr_payload"] == MT and code["device_vendor"] == "Example vendor" and code["area"] == "Kitchen"
    assert code["ha_link"] == {"device_id": "device-a", "entity_id": "sensor.fixture_a"}
    backup = app_module.storage.data_dir / "backups" / r.json()["backup"]
    assert backup.read_bytes() == raw and backup.stat().st_mode & 0o777 == 0o600
    # Repeated search sees the already-filled record; no second addition/backup.
    assert search(client)["rows"][0]["status"] == "unchanged"
    assert apply(client, preview).status_code == 409
    assert len(client.get("/api/vault").json()["codes"]) == 1


def test_match_manual_to_qr_fills_blanks_and_preserves_all_populated_fields(client, app_module, monkeypatch):
    saved = create(client, manual_code="3497-011-2332", device_vendor="Custom vendor", notes="Custom notes", in_use=True, conn_wifi=True)
    setup_ha(app_module, monkeypatch)
    preview = search(client)
    row = preview["rows"][0]
    assert row["status"] == "update" and row["target_id"] == saved["id"]
    assert "manual_code" not in row["changes"] and "device_vendor" not in row["changes"]
    assert apply(client, preview).status_code == 200
    now = client.get("/api/vault").json()["codes"][0]
    for key, value in saved.items():
        if key not in {"qr_payload", "device_product", "device_type", "area", "ha_link", "updated_at"}:
            assert now[key] == value, key
    assert now["qr_payload"] == MT and len(client.get("/api/vault").json()["codes"]) == 1
    assert now["device_type"] == "switch"


def test_linked_metadata_refresh_without_exposed_code_preserves_chosen_entity(client, app_module, monkeypatch):
    saved = create(client, ha_link={"device_id": "device-a", "entity_id": "switch.fixture_a"}, area="Custom area")
    setup_ha(app_module, monkeypatch, states=[])
    preview = search(client)
    assert preview["without_codes"] == 1 and preview["rows"][0]["status"] == "update"
    assert apply(client, preview).status_code == 200
    now = client.get("/api/vault").json()["codes"][0]
    assert now["ha_link"] == saved["ha_link"] and now["area"] == "Custom area"
    assert now["device_vendor"] == "Example vendor" and now["qr_payload"] == ""


def test_empty_linked_slot_can_receive_homekit_data_without_new_record(client, app_module, monkeypatch):
    saved = create(client, ha_link={"device_id": "device-a"})
    setup_ha(app_module, monkeypatch, states=[{"entity_id": "sensor.fixture_a", "attributes": {"homekit_setup_uri": HK}}])
    assert apply(client, search(client)).status_code == 200
    codes = client.get("/api/vault").json()["codes"]
    assert len(codes) == 1 and codes[0]["id"] == saved["id"]
    assert codes[0]["code_type"] == "homekit" and codes[0]["qr_payload"] == HK and codes[0]["setup_id"] == "AB12"


def test_duplicate_attributes_and_entities_coalesce_prefer_full_qr(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch, states=[
        {"entity_id": "sensor.fixture_a", "attributes": {"setup_code": "34970112332", "qr_code": MT}},
        {"entity_id": "switch.fixture_a", "attributes": {"qr_payload": MT}},
    ])
    preview = search(client)
    assert len(preview["rows"]) == 1 and preview["rows"][0]["status"] == "new"
    assert apply(client, preview).status_code == 200
    assert client.get("/api/vault").json()["codes"][0]["qr_payload"] == MT


@pytest.mark.parametrize("value,key,protocol", [
    (MT, "unusual_attribute", "matter"), (HK, "unusual_attribute", "homekit"),
    ("34970112332", "matter_setup_code", "matter"), ("111-22-333", "setup_code", "homekit"),
    ("Z:00124B0001ABCDEF$I:00112233445566778899AABBCCDDEEFF0011", "qr_code", "other"),
    ("https://link.tuya.com/example", "pairing_qr", "other"),
])
def test_supported_code_recognition(value, key, protocol):
    assert parse_code(value, key)["code_type"] == protocol


@pytest.mark.parametrize("value,key", [
    ("34970112332", "energy_counter"), ("11122333", "friendly_name"), ("11111111", "homekit_pin"),
    (True, "setup_code"), (123.5, "setup_code"), ({"value": MT}, "qr_code"), (MT[:-3], "qr_code"),
    ("not a QR", "qr_code"), ("x" * 8193, "setup_code"),
])
def test_ordinary_attributes_and_malformed_values_are_not_imported(value, key):
    assert parse_code(value, key) is None


def test_state_code_sensor_recognized_but_generic_numeric_state_not_guessed(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch, devices=[device(entity_ids=["sensor.example_matter_setup_code", "sensor.counter"])], states=[
        {"entity_id": "sensor.example_matter_setup_code", "state": "34970112332"},
        {"entity_id": "sensor.counter", "state": "11122333"},
    ])
    row = search(client)["rows"][0]
    assert row["status"] == "new" and row["attribute"] == "state"


@pytest.mark.parametrize("kind", ["different_link", "different_pairing", "several_matches", "several_codes", "same_code_three_devices", "uncertain"])
def test_ambiguous_or_conflicting_matches_never_write(client, app_module, monkeypatch, kind):
    devs, states = [device()], [{"entity_id": "sensor.fixture_a", "attributes": {"qr_code": MT}}]
    if kind == "different_link":
        create(client, qr_payload=MT, ha_link={"device_id": "other-device"})
    elif kind == "different_pairing":
        create(client, code_type="homekit", qr_payload=HK, ha_link={"device_id": "device-a"})
    elif kind == "several_matches":
        create(client, qr_payload=MT)
        create(client, ha_link={"device_id": "device-a"})
    elif kind == "several_codes":
        states[0]["attributes"]["homekit_code"] = HK
    elif kind == "same_code_three_devices":
        devs = [device("device-" + str(n), entity_ids=[f"sensor.fixture_{n}"]) for n in range(3)]
        states = [{"entity_id": f"sensor.fixture_{n}", "attributes": {"qr_code": MT}} for n in range(3)]
    else:
        states[0]["attributes"] = {"setup_code": "11122333"}
    setup_ha(app_module, monkeypatch, devs, states)
    before = client.get("/api/vault").json()
    preview = search(client)
    assert preview["rows"] and all(row["status"] == "conflict" for row in preview["rows"])
    assert apply(client, preview, preview["rows"]).status_code == 422
    assert client.get("/api/vault").json() == before


def test_trashed_identity_is_not_recreated(client, app_module, monkeypatch):
    saved = create(client, qr_payload=MT)
    assert client.delete("/api/codes/" + saved["id"]).status_code == 200
    setup_ha(app_module, monkeypatch)
    preview = search(client)
    assert preview["rows"][0]["status"] == "trashed" and apply(client, preview, preview["rows"]).status_code == 422


def test_trashed_device_without_code_is_not_recreated(client, app_module, monkeypatch):
    saved = create(client, ha_link={"device_id": "device-a"})
    assert client.delete("/api/codes/" + saved["id"]).status_code == 200
    setup_ha(app_module, monkeypatch)
    assert search(client)["rows"][0]["status"] == "trashed"


@pytest.mark.parametrize("legacy_missing_setup_id", [False, True])
def test_same_pairing_pin_different_setup_id_requires_review(client, app_module, monkeypatch, legacy_missing_setup_id):
    create(client, code_type="homekit", qr_payload=compose_setup_uri(category_id=4, flag=10, password="11122333", setup_id="CD34"))
    if legacy_missing_setup_id:
        vault = app_module.storage.load()
        vault.codes[0].setup_id = ""
        app_module.storage.save(vault)
    setup_ha(app_module, monkeypatch, states=[{"entity_id": "sensor.fixture_a", "attributes": {"qr_code": HK}}])
    assert search(client)["rows"][0]["status"] == "conflict"


def test_legacy_inline_deleted_record_is_not_updated_or_recreated(client, app_module, monkeypatch):
    create(client, manual_code="34970112332")
    vault = app_module.storage.load()
    vault.codes[0].deleted_at = "2026-01-01T00:00:00Z"
    app_module.storage.save(vault)
    before = app_module.storage.path.read_bytes()
    setup_ha(app_module, monkeypatch)
    preview = search(client)
    assert preview["rows"][0]["status"] == "trashed"
    assert apply(client, preview, preview["rows"]).status_code == 422
    assert app_module.storage.path.read_bytes() == before


def test_invalid_selection_format_rejected_before_ha(client, app_module, monkeypatch):
    lookup = AsyncMock()
    monkeypatch.setattr(app_module.ha, "list_states", lookup)
    assert client.post("/api/ha/discover/apply", json={"session_id": "../invalid", "candidate_ids": []}).status_code == 422
    lookup.assert_not_called()


@pytest.mark.parametrize("operation", ["edit", "delete", "relink", "add_duplicate", "change_source"])
def test_change_while_apply_awaits_ha_rejects_entire_batch(client, app_module, monkeypatch, operation):
    saved = create(client, manual_code="34970112332")
    setup_ha(app_module, monkeypatch)
    preview = search(client)
    async def changed_lookup(**kwargs):
        vault = app_module.storage.load()
        if operation == "edit":
            vault.codes[0].device_vendor = "Concurrent edit"
        elif operation == "delete":
            vault.codes.clear()
        elif operation == "relink":
            vault.codes[0].ha_link.device_id = "other-device"
        elif operation == "add_duplicate":
            vault.codes.append(MatterCode(name="Concurrent new code", qr_payload=HK, code_type="homekit"))
        else:
            return [device(model="New model")]
        app_module.storage.save(vault)
        return [device()]
    monkeypatch.setattr(app_module.ha, "list_devices", changed_lookup)
    r = apply(client, preview)
    assert r.status_code == 409
    current = app_module.storage.load().codes
    if operation != "delete":
        original = next(c for c in current if c.id == saved["id"])
        assert original.qr_payload == "" and original.device_product == ""
    assert not list((app_module.storage.data_dir / "backups").glob("*.json"))


def test_backup_failure_and_storage_error_stop_batch_without_leaking(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch)
    preview = search(client)
    before = app_module.storage.path.read_bytes()
    for exception, code in [(VaultBackupError("private error"), "backup_failed"), (OSError("private error"), "storage_error")]:
        monkeypatch.setattr(app_module.storage, "save_with_backup", lambda *args: (_ for _ in ()).throw(exception))
        response = apply(client, preview)
        assert response.status_code == 500 and response.json()["detail"]["error"] == code
        assert "private error" not in response.text and app_module.storage.path.read_bytes() == before


def test_storage_cas_and_unique_safety_copies_without_pruning(client, app_module):
    create(client)
    storage = app_module.storage
    first = storage.save_with_backup(storage.load(), storage.revision())
    second = storage.save_with_backup(storage.load(), storage.revision())
    assert first != second and first.exists() and second.exists()
    revision = storage.revision()
    storage.path.write_bytes(storage.path.read_bytes() + b"\n")
    with pytest.raises(VaultChangedError):
        storage.save_with_backup(storage.load(), revision)


def test_disabled_unreachable_and_expired_preview_are_safe(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.ha, "enabled", False)
    assert client.post("/api/ha/discover").status_code == 503
    setup_ha(app_module, monkeypatch)
    preview = search(client)
    monkeypatch.setattr(app_module.ha, "list_states", AsyncMock(side_effect=RuntimeError("private details")))
    r = client.post("/api/ha/discover")
    assert r.status_code == 503 and "private details" not in r.text
    app_module._discovery_sessions[preview["session_id"]]["created"] -= 301
    assert apply(client, preview).json()["detail"]["error"] == "ha_discovery_expired"


def test_selected_subset_and_unknown_duplicate_ids_cannot_import_other_rows(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch, devices=[device(), device("device-b", entity_ids=["sensor.fixture_b"])], states=[
        {"entity_id": "sensor.fixture_a", "attributes": {"qr_code": MT}},
        {"entity_id": "sensor.fixture_b", "attributes": {"homekit_setup_uri": HK}},
    ])
    preview = search(client)
    r = client.post("/api/ha/discover/apply", json={"session_id": preview["session_id"], "candidate_ids": ["0" * 32]})
    assert r.status_code == 422
    assert apply(client, preview, [preview["rows"][0], preview["rows"][0]]).status_code == 422
    assert apply(client, preview, [preview["rows"][0]]).status_code == 200
    assert len(client.get("/api/vault").json()["codes"]) == 1


def test_matter_vacuum_without_code_imports_metadata_and_later_fills_pairing_in_place(client, app_module, monkeypatch):
    dev = device(name="Synthetic vacuum", integrations=["matter"],
                 entity_ids=["sensor.vacuum_battery", "vacuum.synthetic", "update.vacuum"])
    setup_ha(app_module, monkeypatch, devices=[dev], states=[
        {"entity_id": "vacuum.synthetic", "state": "idle", "attributes": {"friendly_name": "Synthetic vacuum"}},
        {"entity_id": "sensor.vacuum_battery", "state": "85"},
    ])
    assert client.get("/api/vault").status_code == 200
    raw = app_module.storage.path.read_bytes()
    preview = search(client)
    row = preview["rows"][0]
    assert row["status"] == "new" and row["protocol"] == "matter" and not row["has_code"]
    assert row["entity_id"] == "vacuum.synthetic" and row["details"]["device_type"] == "vacuum"
    assert app_module.storage.path.read_bytes() == raw
    result = apply(client, preview)
    assert result.status_code == 200 and result.json()["added"] == 1
    backup = app_module.storage.data_dir / "backups" / result.json()["backup"]
    assert backup.read_bytes() == raw
    saved = client.get("/api/vault").json()["codes"][0]
    assert saved["code_type"] == "matter" and saved["device_type"] == "vacuum"
    assert saved["manual_code"] == saved["qr_payload"] == ""
    assert saved["device_vendor"] == "Example vendor" and saved["device_product"] == "Model A"
    assert saved["ha_link"] == {"device_id": "device-a", "entity_id": "vacuum.synthetic"}
    assert saved["conn_matter"] is False, "Matter integration must not imply Thread"
    assert search(client)["rows"][0]["status"] == "unchanged"
    edited = client.put('/api/codes/' + saved['id'], json={"name": "My own name", "device_type": "My custom type", "notes": "My notes"})
    assert edited.status_code == 200
    setup_ha(app_module, monkeypatch, devices=[dev], states=[
        {"entity_id": "vacuum.synthetic", "attributes": {"matter_qr_payload": MT}},
    ])
    assert apply(client, search(client)).status_code == 200
    codes = client.get("/api/vault").json()["codes"]
    assert len(codes) == 1 and codes[0]["id"] == saved["id"] and codes[0]["qr_payload"] == MT
    assert codes[0]["name"] == "My own name" and codes[0]["device_type"] == "My custom type" and codes[0]["notes"] == "My notes"


@pytest.mark.parametrize("integrations,z2m,protocol,code_type,standard", [
    (["homekit_controller"], False, "homekit", "homekit", ""),
    (["homekit"], False, "homekit", "homekit", ""),
    (["zwave_js"], False, "zwave", "zwave", ""),
    (["zha"], False, "zigbee", "other", "Zigbee"),
    (["deconz"], False, "zigbee", "other", "Zigbee"),
    (["mqtt"], True, "zigbee", "other", "Zigbee"),
    (["tuya"], False, "tuya", "other", "Tuya"),
    (["localtuya"], False, "tuya", "other", "Tuya"),
    (["tuya_local"], False, "tuya", "other", "Tuya"),
    (["mqtt"], False, "", "other", ""),
    (["esphome"], False, "", "other", ""),
    (["matter", "homekit_controller"], False, "", "other", ""),
])
def test_inventory_protocols_and_unknowns_are_selectable_without_codes(client, app_module, monkeypatch, integrations, z2m, protocol, code_type, standard):
    setup_ha(app_module, monkeypatch, devices=[device(name="Matter HomeKit Zigbee words cannot classify me",
        integrations=integrations, zigbee2mqtt=z2m)], states=[])
    preview = search(client)
    assert preview["rows"][0]["protocol"] == protocol and not preview["rows"][0]["has_code"]
    assert preview["rows"][0]["status"] == "new"
    assert apply(client, preview).status_code == 200
    saved = client.get("/api/vault").json()["codes"][0]
    assert saved["code_type"] == code_type and saved["custom_standard"] == standard
    assert saved["manual_code"] == saved["qr_payload"] == ""
    assert saved["conn_matter"] is False
    assert saved["conn_zigbee"] is (protocol == "zigbee") and saved["conn_zwave"] is (protocol == "zwave")
    assert search(client)["rows"][0]["status"] == "unchanged"


def test_inventory_without_state_or_entity_imports_device_link_only(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch, devices=[device(integrations=["matter"], entity_ids=[])], states=[])
    preview = search(client)
    assert preview["rows"][0]["entity_id"] == ""
    assert apply(client, preview).status_code == 200
    saved = client.get("/api/vault").json()["codes"][0]
    assert saved["ha_link"] == {"device_id": "device-a", "entity_id": None}
    assert len(search(client)["rows"]) == 1


def test_code_less_trashed_device_stays_in_trash(client, app_module, monkeypatch):
    saved = create(client, ha_link={"device_id": "device-a"})
    assert client.delete('/api/codes/' + saved['id']).status_code == 200
    setup_ha(app_module, monkeypatch, devices=[device(integrations=["matter"])], states=[])
    preview = search(client)
    assert preview["rows"][0]["status"] == "trashed"
    assert apply(client, preview, preview["rows"]).status_code == 422
    assert client.get("/api/vault").json()["codes"] == []


def test_same_name_unlinked_record_requires_linking_before_metadata_import(client, app_module, monkeypatch):
    saved = create(client, name="Synthetic device", code_type="homekit", device_type="Custom type", notes="Preserved")
    setup_ha(app_module, monkeypatch, devices=[device(integrations=["homekit_controller"])], states=[])
    preview = search(client)
    row = preview["rows"][0]
    assert row["status"] == "conflict" and row["reason"] == "possible_existing" and row["target_id"] == saved["id"]
    assert apply(client, preview, preview["rows"]).status_code == 422
    assert client.put('/api/codes/' + saved['id'], json={"ha_link": {"device_id": "device-a"}}).status_code == 200
    assert apply(client, search(client)).status_code == 200
    codes = client.get("/api/vault").json()["codes"]
    assert len(codes) == 1 and codes[0]["id"] == saved["id"]
    assert codes[0]["code_type"] == "homekit" and codes[0]["device_type"] == "Custom type" and codes[0]["notes"] == "Preserved"


def test_protocol_change_after_preview_invalidates_metadata_only_batch(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch, devices=[device(integrations=["matter"])], states=[])
    preview = search(client)
    monkeypatch.setattr(app_module.ha, "list_devices", AsyncMock(return_value=[device(integrations=["homekit_controller"])]))
    result = apply(client, preview)
    assert result.status_code == 409 and result.json()["detail"]["error"] == "ha_discovery_source_changed"
    assert client.get("/api/vault").json()["codes"] == []
    assert not list((app_module.storage.data_dir / "backups").glob("*.json"))


def test_shared_entity_in_metadata_only_sources_is_not_imported_twice(client, app_module, monkeypatch):
    setup_ha(app_module, monkeypatch, devices=[device(), device("device-b")], states=[])
    preview = search(client)
    assert all(row["status"] == "conflict" and row["reason"] == "multiple_devices" for row in preview["rows"])
    assert apply(client, preview, preview["rows"]).status_code == 422
