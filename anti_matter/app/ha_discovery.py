"""Plan read-only HA discovery and blank-only vault updates; never log values."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from homekit_payload import decode_fields_from_uri, decode_pairing_from_uri, parse_setup_uri
from matter_setup_payload import parse_manual_payload, parse_qr_payload, generate_manual_code, format_manual_display
from models import MatterCode, Vault
from zwave_payload import normalize_fields as normalize_zwave, parse_dsk_groups, parse_qr_digits

ENTITY = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")
CODE_ATTRIBUTES = {
    "setup_code", "pairing_code", "setup_pin", "pairing_pin", "pin_code",
    "matter_setup_code", "matter_manual_code", "matter_qr_code", "matter_qr_payload", "matter_setup_payload",
    "homekit_code", "homekit_pin", "homekit_setup_code", "homekit_pairing_code", "homekit_setup_uri",
    "qr_code", "qrcode", "qr_payload", "pairing_qr", "pairing_qr_code", "setup_payload",
    "dsk", "zwave_dsk", "smartstart", "smartstart_qr", "install_code", "zigbee_install_code",
}
INVALID_HK = {str(n) * 8 for n in range(10)} | {"12345678", "87654321"}
ZIGBEE = [
    re.compile(pattern, re.I) for pattern in (
        r"^[0-9a-f]{16}\|(?:[0-9a-f]{4}){4,9}$",
        r"^Z:[0-9a-f]{16}\$I:(?:[0-9a-f]{4}){4,9}$",
        r"\$A:[0-9a-f]{16}\$I:(?:[0-9a-f]{4}){4,9}$",
        r"^RB01SG[0-9a-f]{50}DLK(?:[0-9a-f]{36}|[0-9a-f]{32})$",
    )
]


def text(value):
    return value.strip() if isinstance(value, str) else ""


def parse_code(value, attribute):
    """Structured signatures anywhere; bare numbers only in code-named sources.

    Reuses protocol parsers. Tuya/Zigbee recognition mirrors matter-scan.js;
    these identify labels, not a successful pairing or CRC verification.
    """
    if type(value) not in (str, int):
        return None
    try:
        raw = str(value).strip()
    except ValueError:
        return None
    if not raw or len(raw) > 8192:
        return None
    named = attribute.lower() in CODE_ATTRIBUTES
    compact = re.sub(r"[\s-]", "", raw)
    try:
        if raw.upper().startswith("MT:"):
            for part in raw[3:].split("*"):
                parse_qr_payload("MT:" + part)
            return {"code_type": "matter", "manual_code": format_manual_display(generate_manual_code(parse_qr_payload(raw))), "qr_payload": raw}
        if re.fullmatch(r"X-HM://[A-Z0-9]{9,}", raw, re.I) and parse_setup_uri(raw):
            pin = decode_pairing_from_uri(raw)
            if not pin or pin in INVALID_HK:
                return None
            fields = decode_fields_from_uri(raw)
            return {"code_type": "homekit", "manual_code": pin, "qr_payload": parse_setup_uri(raw)["uri"],
                    "setup_id": fields.get("setup_id", ""), "homekit_category": fields.get("homekit_category", "other"),
                    "homekit_flag": fields.get("homekit_flag", 2)}
        if compact.isascii() and compact.isdigit() and compact.startswith("90") and len(compact) >= 52 and parse_qr_digits(compact):
            n = normalize_zwave("", compact)
            return {"code_type": "zwave", **{key: n[key] for key in ("manual_code", "qr_payload", "zwave_pin")}}
        if named and re.fullmatch(r"[0-9\s-]+", raw):
            if len(compact) in (11, 21):
                parse_manual_payload(compact)
                return {"code_type": "matter", "manual_code": format_manual_display(compact), "qr_payload": ""}
            if len(compact) == 40 and parse_dsk_groups(compact):
                n = normalize_zwave("-".join(compact[i:i+5] for i in range(0, 40, 5)), "")
                return {"code_type": "zwave", **{key: n[key] for key in ("manual_code", "qr_payload", "zwave_pin")}}
            if len(compact) == 8 and compact not in INVALID_HK:
                return {"code_type": "homekit", "manual_code": compact, "qr_payload": "",
                        "uncertain": not (attribute.lower().startswith("homekit_") or re.fullmatch(r"\d{3}([ -])\d{2}\1\d{3}", raw))}
        uri = urlsplit(raw)
        if uri.scheme.lower() in {"tuyasmart", "smartlife", "thingsmart"} or (named and uri.scheme in {"http", "https"} and re.search(r"tuya|smartlife", uri.hostname or "", re.I)):
            return {"code_type": "other", "custom_standard": "Tuya", "manual_code": "", "qr_payload": raw}
        if any(pattern.search(raw) for pattern in ZIGBEE):
            return {"code_type": "other", "custom_standard": "Zigbee", "manual_code": "", "qr_payload": raw}
    except (ValueError, TypeError, OverflowError):
        pass
    return None


def equivalent(a, b, duplicate):
    code = MatterCode(**{"name": "", **{k: v for k, v in a.items() if k != "uncertain"}})
    return duplicate(Vault(codes=[code]), b) is not None


def collect_sources(devices, states, duplicate):
    if not isinstance(devices, list) or not isinstance(states, list):
        raise ValueError("Invalid discovery source")
    state_map = {s["entity_id"]: s for s in states if isinstance(s, dict) and isinstance(s.get("entity_id"), str)}
    sources = {}
    for dev in devices:
        if not isinstance(dev, dict) or not text(dev.get("id")):
            continue
        did = text(dev["id"])
        ids = sorted({eid for eid in dev.get("entity_ids", []) if isinstance(eid, str) and len(eid) <= 255 and ENTITY.fullmatch(eid)})
        payloads = []
        for eid in ids:
            state = state_map.get(eid, {})
            attrs = state.get("attributes")
            values = [(key, value, key) for key, value in attrs.items()] if isinstance(attrs, dict) else []
            source_name = eid.split(".", 1)[1]
            # Code sensors can expose their code as state, not as an attribute.
            alias = next((key for key in sorted(CODE_ATTRIBUTES) if source_name == key or source_name.endswith("_" + key)), "")
            values.append((alias or "state", state.get("state"), "state"))
            for attr, value, source_attribute in values:
                if not isinstance(attr, str):
                    continue
                parsed = parse_code(value, attr)
                if not parsed:
                    continue
                item = {"fields": parsed, "entity_id": eid, "attribute": source_attribute}
                match = next((old for old in payloads if equivalent(old["fields"], parsed, duplicate)), None)
                if match is None:
                    payloads.append(item)
                elif parsed.get("qr_payload") and not match["fields"].get("qr_payload"):
                    payloads[payloads.index(match)] = item
                elif match["fields"].get("uncertain") and not parsed.get("uncertain"):
                    payloads[payloads.index(match)] = item
                elif parsed.get("qr_payload") and match["fields"].get("qr_payload") and parsed["qr_payload"] != match["fields"]["qr_payload"]:
                    # Equivalent identity does not make two different full QRs interchangeable.
                    payloads.append(item)
        metadata = {key: text(dev.get(source)) for key, source in (
            ("name", "name"), ("device_vendor", "manufacturer"), ("device_product", "model"), ("area", "area"))}
        sources[did] = {"device_id": did, "entity_ids": ids, "metadata": metadata, "payloads": payloads}
    return list(sources.values())


def all_duplicates(codes, fields, duplicate):
    return [code for code in codes if duplicate(Vault(codes=[code]), fields)]


def plan_sources(sources, vault, trash, duplicate):
    rows = []
    live_codes = [c for c in vault.codes if not c.deleted_at]
    trashed_codes = trash.codes + [c for c in vault.codes if c.deleted_at]
    for source in sources:
        did, ids, payloads = source["device_id"], source["entity_ids"], source["payloads"]
        linked = [c for c in live_codes if c.ha_link.device_id == did or c.ha_link.entity_id and c.ha_link.entity_id in ids]
        fields = payloads[0]["fields"] if len(payloads) == 1 else None
        by_code = all_duplicates(live_codes, fields, duplicate) if fields else []
        matches = {c.id: c for c in linked + by_code}
        if not payloads and not matches:
            continue
        row = {"key": did, "name": source["metadata"]["name"] or did, "area": source["metadata"]["area"],
               "entity_id": payloads[0]["entity_id"] if payloads else "", "attribute": payloads[0]["attribute"] if payloads else "",
               "protocol": fields.get("custom_standard", fields["code_type"]).lower() if fields else "",
               "target_id": None, "existing_name": "", "status": "conflict", "reason": "", "patch": {}}
        if len(payloads) > 1:
            row["reason"] = "multiple_codes"
        elif len(matches) > 1:
            row["reason"] = "multiple_matches"
        elif fields and not matches and (all_duplicates(trashed_codes, fields, duplicate) or any(
            c.ha_link.device_id == did or c.ha_link.entity_id and c.ha_link.entity_id in ids for c in trashed_codes)):
            row.update(status="trashed", reason="in_trash")
        elif not matches:
            if fields.get("uncertain"):
                row["reason"] = "uncertain_protocol"
            else:
                row.update(status="new", patch={**source["metadata"], **{k: v for k, v in fields.items() if k != "uncertain"},
                    "ha_link": {"device_id": did, "entity_id": row["entity_id"]}})
        else:
            existing = next(iter(matches.values()))
            row.update(target_id=existing.id, existing_name=existing.name)
            if not row["protocol"]:
                row["protocol"] = (existing.custom_standard or existing.code_type).lower()
                row["entity_id"] = existing.ha_link.entity_id or ""
            has_pairing = bool(text(existing.manual_code) or text(existing.qr_payload) or text(existing.setup_id))
            conflict = existing.ha_link.device_id and existing.ha_link.device_id != did
            if fields and has_pairing and not all_duplicates([existing], fields, duplicate):
                conflict = True
            if fields and fields.get("setup_id"):
                stored_uri = parse_setup_uri(existing.qr_payload) or {}
                for setup_id in (existing.setup_id, stored_uri.get("setup_id", "")):
                    if setup_id and setup_id.upper() != fields["setup_id"].upper():
                        conflict = True
            if fields and fields.get("uncertain") and (not has_pairing or existing.code_type != "homekit"):
                conflict = True
            if conflict:
                row["reason"] = "identity_conflict"
            else:
                patch = {k: v for k, v in source["metadata"].items() if v and not text(getattr(existing, k))}
                if fields:
                    for key, value in fields.items():
                        if key not in {"code_type", "homekit_flag", "uncertain"} and value and not text(getattr(existing, key, "")):
                            patch[key] = value
                    if not has_pairing:
                        # Initialize the protocol/default format of an empty code slot.
                        patch["code_type"] = fields["code_type"]
                        if fields["code_type"] == "homekit":
                            patch["homekit_flag"] = fields.get("homekit_flag", 2)
                            if existing.homekit_category == "other":
                                patch["homekit_category"] = fields.get("homekit_category", "other")
                link = existing.ha_link.model_dump()
                if not link["device_id"]:
                    link["device_id"] = did
                if not link["entity_id"] and row["entity_id"]:
                    link["entity_id"] = row["entity_id"]
                if link != existing.ha_link.model_dump():
                    patch["ha_link"] = link
                patch = {k: v for k, v in patch.items() if getattr(existing, k) != v}
                row.update(status="update" if patch else "unchanged", patch=patch)
        rows.append(row)
    # Never plan two additions for the same identity or two updates to one record.
    collisions = set()
    for i, a in enumerate(rows):
        for j, b in enumerate(rows[i+1:], start=i+1):
            if a["status"] not in {"new", "update"} or b["status"] not in {"new", "update"}:
                continue
            collide = a["target_id"] and a["target_id"] == b["target_id"]
            if a["status"] == b["status"] == "new":
                collide = equivalent(a["patch"], b["patch"], duplicate)
            if collide:
                collisions.update((i, j))
    for i in collisions:
        rows[i].update(status="conflict", reason="multiple_devices", patch={})
    return rows


def public_row(row, row_id):
    return {key: row[key] for key in ("name", "area", "entity_id", "attribute", "protocol", "target_id", "existing_name", "status", "reason")} | {
        "id": row_id, "changes": list(row["patch"]),
        "metadata": {key: row["patch"][key] for key in ("device_vendor", "device_product", "area") if key in row["patch"]},
    }
