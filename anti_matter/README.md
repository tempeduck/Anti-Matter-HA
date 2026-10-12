<p align="center">
  <img src="https://raw.githubusercontent.com/tempeduck/Anti-Matter-HA/main/anti_matter/banner.png" alt="Anti-Matter: local pairing-code vault and scanner" width="100%">
</p>

# Anti-Matter for Home Assistant

[![Version](https://img.shields.io/badge/version-3.4.0-blue)](https://github.com/tempeduck/Anti-Matter-HA/blob/main/anti_matter/CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/tempeduck/Anti-Matter-HA/blob/main/LICENSE)
![Supports aarch64](https://img.shields.io/badge/aarch64-yes-green)
![Supports amd64](https://img.shields.io/badge/amd64-yes-green)
![24 languages](https://img.shields.io/badge/languages-24-7B61FF)

Keep Matter, HomeKit, Z-Wave, Zigbee and Tuya pairing codes in a local vault.
Open Anti-Matter from the HA sidebar, scan a label, and display its QR or manual
setup code whenever you need to pair the device again.

![The vault in dark and light themes](https://raw.githubusercontent.com/tempeduck/Anti-Matter-HA/main/docs/screenshots/hero.png)

## Features

- **Offline scanner:** browser cameras, photos, screenshots, pasted text and the
  Companion app's native camera. Batch mode shows a Saved receipt and Scan next.
- **Decoded setup details:** Matter, HomeKit and Z-Wave fields, vendor/product
  names, and complete codes that scale to fit their display.
- **HA device discovery:** select devices to include, fill blank metadata,
  link devices/entities, and pull pairing data when an integration exposes it.
- **Automatic In use:** confirmed HA activity marks linked records in use;
  temporary outages retain their flag. Manual tracking remains available.
- **Organised storage:** cards, printable labels, tables, categories, search,
  filters, full-screen QR presentation and 24 languages.
- **Backups and recovery:** Trash with undo, scheduled backups, JSON import/export
  and a downloadable HTML viewer for offline access to saved backups.

## Configuration

| Option | Values | Purpose |
| --- | --- | --- |
| Language | Auto or one of 24 languages | Default interface language; Auto follows HA, then the browser |
| Theme | Auto, Light or Dark | Default appearance; Auto follows HA |
| Backups to keep | 1–100 | Initial backup retention; the in-app Backups dialog takes precedence after saving |

Language and theme choices inside the app are remembered by that browser.

## Storage and access

Data is plain JSON in the app's config folder and is included in HA backups that
contain this app. Over Samba, look for `app_configs/<hash>_anti_matter`.
Backups/exports contain the vault; copying the entire stopped app's config folder
preserves Trash and backup settings too. Every HA user who can open the panel can read
the pairing codes.

Live browser cameras need HTTPS or localhost. On ordinary HTTP, use a photo or
the HA Companion scanner. Optional CSA lookups send only vendor/product IDs;
QR decoding, fonts and other assets are bundled locally.

## Documentation

[User guide](https://github.com/tempeduck/Anti-Matter-HA/blob/main/anti_matter/DOCS.md) ·
[Changelog](https://github.com/tempeduck/Anti-Matter-HA/blob/main/anti_matter/CHANGELOG.md) ·
[Standalone Docker](https://github.com/tempeduck/Anti-Matter-HA/blob/main/docs/docker.md) ·
[Credits and licenses](https://github.com/tempeduck/Anti-Matter-HA/blob/main/docs/credits.md)

Based on [Rematters](https://github.com/Rematters/Rematters-HA),
[Cl3tus/Anti-Matter-HA](https://github.com/Cl3tus/Anti-Matter-HA) and
[kedube/Anti-Matter-HA](https://github.com/kedube/Anti-Matter-HA).
