"""Evidence-based deployment flag updates; temporary outages retain prior state."""
from __future__ import annotations

import re

from models import utc_now

DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,255}$")
REMOVAL_CONFIRM_SECONDS = 60.0


def automatic_devices(vault):
    return {code.ha_link.device_id for code in vault.codes
            if not code.deleted_at and code.in_use_mode == "auto" and code.ha_link.device_id
            and DEVICE_ID.fullmatch(code.ha_link.device_id)}


def update_usage(vault, baseline_links, snapshot, missing, now):
    """Patch only stable auto links. Missing registry identities need two observations.

    The first observation is not counted again by an overlapping/fast refresh.
    Failed or startup reads break the confirmation sequence. Entity unavailability
    never clears the flag, even if every entity is unavailable.
    """
    if not snapshot["running"]:
        missing.clear()
        return 0
    current_ids = automatic_devices(vault)
    evidence = snapshot["devices"]
    for did in list(missing):
        if did not in current_ids or did not in evidence or evidence[did]["exists"]:
            missing.pop(did, None)
    for did in current_ids & evidence.keys():
        if not evidence[did]["exists"]:
            missing.setdefault(did, now)
    changed = 0
    for code in vault.codes:
        if code.deleted_at or code.in_use_mode != "auto":
            continue
        link = code.ha_link.model_dump()
        if baseline_links.get(code.id) != link:
            continue
        did = link["device_id"]
        device = evidence.get(did)
        if device is None:
            continue
        value = code.in_use
        if device["exists"]:
            active = device["active_entity_ids"]
            if active and (not link["entity_id"] or link["entity_id"] in active):
                value = True
        elif did in missing and now - missing[did] >= REMOVAL_CONFIRM_SECONDS:
            value = False
        if value != code.in_use:
            code.in_use = value
            code.updated_at = utc_now()
            changed += 1
    return changed
