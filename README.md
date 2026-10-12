<p align="center">
  <img src="anti_matter/banner.png" alt="Anti-Matter: local pairing-code vault and scanner" width="100%">
</p>

# Anti-Matter

A local vault for Matter, HomeKit, Z-Wave, Zigbee and Tuya pairing codes. Scan a
label, keep its setup details, and display a clean QR whenever you need to pair
the device again. Run it as a **Home Assistant app** or with **Docker Compose**.

[![Version](https://img.shields.io/badge/version-3.4.0-blue)](anti_matter/CHANGELOG.md)
[![CI](https://github.com/tempeduck/Anti-Matter-HA/actions/workflows/ci.yml/badge.svg)](https://github.com/tempeduck/Anti-Matter-HA/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![24 languages](https://img.shields.io/badge/languages-24-7B61FF)

[Install](#installation) · [User guide](anti_matter/DOCS.md) · [Docker guide](docs/docker.md) · [Changelog](anti_matter/CHANGELOG.md)

![Anti-Matter vault in dark and light themes with a phone scanning a label](docs/screenshots/hero.png)

## Features

- **Offline scanning:** live camera, photographs, screenshots, drag and drop,
  pasted text and the Home Assistant Companion scanner. Batch mode includes
  visible save receipts and duplicate detection.
- **Readable setup details:** decoded Matter, HomeKit and Z-Wave payloads,
  complete setup codes that scale to fit, and vendor/product names where available.
- **Cards, labels and tables:** search, filters, categories, printing, downloads
  and full-screen QR presentation.
- **Home Assistant integration:** find devices, select which to include, fill
  blank details without overwriting existing values, and link devices or entities.
  Pull a pairing code when its integration exposes one.
- **Automatic In use:** confirmed HA activity marks linked devices in use;
  outages retain the flag, and a manual override remains available.
- **Local backups:** scheduled backups, Trash with undo, JSON import/export
  and a downloadable HTML viewer that opens backups offline.
- **24 languages:** including Arabic and Hebrew layouts, with light, dark
  and inverted QR display modes.

HA integration and automatic usage checks require the Home Assistant app.
Standalone Docker provides the vault, scanner, labels and local backups.

## Installation

| Installation | Requirements | Access and storage |
| --- | --- | --- |
| Home Assistant app | HA OS or Supervised; amd64 or arm64 | HA sidebar and authentication; app config included in HA backups |
| Docker Compose | Docker with Compose v2; amd64 or arm64 | Localhost port 8099; persistent Docker volume |

### Home Assistant

[![Add this app repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Ftempeduck%2FAnti-Matter-HA)

1. Open **Settings → Apps → App store → ⋮ → Repositories**.
2. Add `https://github.com/tempeduck/Anti-Matter-HA`.
3. Install **Anti-Matter**, start it, and open it from the sidebar.

Older HA versions call these menus **Add-ons**. The app builds locally during
installation and updates, which can take a few minutes on a Raspberry Pi.

Moving from another fork creates a separate installation. Use Export/Import or
copy the stopped app's config folder; see [Moving from another repository](anti_matter/DOCS.md#moving-from-another-repository).

### Docker Compose

```sh
git clone https://github.com/tempeduck/Anti-Matter-HA.git
cd Anti-Matter-HA
docker compose up -d --build --wait
```

Open **http://localhost:8099** on the Docker host. Data is stored in the Compose
`data` volume and survives container replacement. The container runs as UID 1000
and includes a health check.

The standalone API has no login, so the default port binds to localhost. For
access from another device, use an authenticated HTTPS proxy; see the
[Docker guide](docs/docker.md) for ports, storage, updates and migration.

## Scanning and data

Live camera scanning needs **HTTPS or localhost**. On ordinary HTTP, use a
photograph or pasted image; the HA Companion app also offers its native scanner.
Images are decoded in the browser.

| Protocol | Accepted pairing data |
| --- | --- |
| Matter | `MT:…` QR or an 11/21-digit manual setup code |
| HomeKit | `X-HM://…` QR or an 8-digit pairing code |
| Z-Wave | SmartStart QR or a 40-digit DSK |
| Zigbee / Tuya / Other | Supported install-code/link formats or a preserved raw payload |

The vault and backups are plain JSON, so protect them like a password list.
Optional Matter name lookups send only vendor and product IDs to the CSA registry.
Fonts, QR tools, icons and Z-Wave names are bundled; there is no telemetry.
Every HA user who can open the app can read its codes.

The [user guide](anti_matter/DOCS.md) covers scanning, languages, HA linking,
configuration, shortcuts, backups, privacy and upgrades. The
[changelog](anti_matter/CHANGELOG.md) records release changes.

## Development

The backend is FastAPI; the frontend is plain JavaScript and CSS with bundled
assets and no build step.

```sh
python3 -m venv .venv
.venv/bin/pip install -r anti_matter/app/requirements.txt pytest
```

- Backend tests: `cd anti_matter` then `../.venv/bin/python -m pytest -q tests`.
- Static checks: `python3 tools/ci/version.py check` and `python3 tools/ci/check_i18n.py --locales`.
- Browser checks: [tools/ci](tools/ci); screenshots: [tools/screenshots](tools/screenshots/README.md).
- Docker validation: [Docker guide](docs/docker.md#development-and-validation).
- CI checks code, languages, browser behavior and container builds for amd64/arm64.
- Releases: `python3 tools/ci/version.py bump X.Y.Z`, fill in the changelog,
  then push to `main`. The release workflow runs CI before tagging and publishing.

## Credits and license

Based on Jesse Hulswit's [Rematters](https://github.com/Rematters/Rematters-HA),
[Cl3tus/Anti-Matter-HA](https://github.com/Cl3tus/Anti-Matter-HA), and
[kedube/Anti-Matter-HA](https://github.com/kedube/Anti-Matter-HA).
[Credits, bundled libraries and trademarks](docs/credits.md).

[MIT license](LICENSE).
