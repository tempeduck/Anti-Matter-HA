"""Assemble a generic, self-contained viewer. No vault or HA data is embedded."""
from __future__ import annotations

import html
import json
from pathlib import Path

STATIC = Path(__file__).resolve().parent / "static"


def build_viewer(locale: str = "en") -> str:
    locales = {p.stem: p for p in (STATIC / "locales").glob("*.json")}
    locale = locale if locale in locales else "en"
    labels = json.loads(locales["en"].read_text())
    labels.update(json.loads(locales[locale].read_text()))
    labels = {key: value for key, value in labels.items() if isinstance(value, str)}
    # JSON text is inert, including translations containing HTML terminators.
    strings = json.dumps(labels, ensure_ascii=False).replace("<", "\\u003c")
    scripts = "\n".join((STATIC / p).read_text() for p in (
        "vendor/qrcode/qrcode.js", "vendor/qrcode/qrcode_UTF8.js", "viewer/viewer.js",
    )).replace("</script", "<\\/script")
    css = (STATIC / "viewer/viewer.css").read_text()
    title = html.escape(labels["viewer.title"])
    direction = "rtl" if locale in {"ar", "he"} else "ltr"
    return f'''<!doctype html>
<html lang="{locale}" dir="{direction}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; object-src 'none'">
<title>{title}</title><style>{css}</style></head><body>
<main id="viewer"></main>
<noscript>This local backup viewer requires JavaScript.</noscript>
<script type="application/json" id="strings">{strings}</script>
<script>{scripts}</script></body></html>'''
