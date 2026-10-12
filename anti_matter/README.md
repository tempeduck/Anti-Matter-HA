<p align="center">
  <img src="https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/anti_matter/banner.png" alt="Anti-Matter: offline vault and scanner for smart-home pairing codes" width="100%">
</p>

# Anti-Matter

[![Version](https://img.shields.io/badge/version-3.1.0-blue)](https://github.com/tempeduck/Anti-Matter-HA/blob/main/anti_matter/CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/tempeduck/Anti-Matter-HA/blob/main/LICENSE)
![Supports aarch64](https://img.shields.io/badge/aarch64-yes-green)
![Supports amd64](https://img.shields.io/badge/amd64-yes-green)
![24 languages](https://img.shields.io/badge/languages-24-7B61FF)

Keep every **Matter**, **HomeKit**, **Z-Wave**, **Zigbee** and **Tuya** pairing code you own in one private vault
inside Home Assistant. Scan a label once, and you can show, print or re-pair from it whenever you need to. There is
no account and no cloud.

![Anti-Matter vault in the dark and light theme, with a phone scanning a Matter label](https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/docs/screenshots/hero.png)

## Features

- **Scan from anywhere.** You can use the live camera, a photo, a screenshot, drag and drop, or pasted text. The bundled decoder runs in every browser, including iPhone and Firefox, and works fully offline.
- **Home Assistant app scanner.** Choose batch mode before opening the native camera. Each batch save shows a visible **Saved** receipt with **Scan next**. This works even on `http://`.
- **Batch scanning.** Off by default, with your choice remembered. In the web scanner, **Save & scan next** stores each code and returns to the camera, with Undo for every code in the session.
- **Several codes in one photo.** Photograph a pile of labels and tick the ones to save.
- **Duplicate detection.** The same device is never saved twice, even when you scan its QR once and type its manual code another time.
- **Decoded for you.** For Matter you get the vendor and product (with official CSA names), passcode, discriminator and discovery modes. For Z-Wave you get the PIN, the security classes and the device name from a bundled offline database. For HomeKit you get the setup ID and accessory category.
- **Cards, labels or a table.** Printable labels with the official wordmarks, flip to the decoded back, and present full screen.
- **Organise.** Colour-and-icon categories, search, and filters for protocol, vendor, product, type, area, in use and connectivity.
- **Home Assistant device and entity links.** Search by entity ID, fill empty vendor/product/area from HA, and refresh remaining empty fields without replacing your edits. Optionally choose an entity to show its availability in details. Jump to the device page in one tap.
- **Search Home Assistant.** Preview exposed pairing codes and missing details on linked records, then select additions or blank-field updates. Match by HA identity or pairing code, preserve existing values, skip ambiguous and trashed records, and verify a vault backup before saving. Available in the sidebar, the phone's More menu and Import & export.
- **Trash, backups, export and import.** Backups can run hourly, daily, weekly or monthly, and they are also included in Home Assistant backups.
- **Pull code from HA.** Select a device and entity in the editor, enter the pairing-code attribute name and pull it into the form. Review before saving. The integration must expose a text or integer code; linking alone cannot retrieve one.
- **Offline backup viewer.** Download the HTML viewer from **Import & export**, open it in a browser and choose a JSON export or backup. Search records and view complete stored QR codes without Home Assistant or internet. The viewer is read-only and uploads nothing.
- **24 languages,** including Hebrew and Arabic right to left, plus light, dark and Invert themes that follow Home Assistant.

![Batch scanning: result sheet and the session tray](https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/docs/screenshots/scanner-result.png)

## Good to know

- **Live camera needs HTTPS.** Browsers only allow the camera on `https://` pages. On `http://`, use the Companion app, or scan from a photo; *Take photo* opens your phone's camera app.
- **Your data stays local.** Everything is stored in plain JSON in the add-on's config folder (`\\<HA-IP>\app_configs\<hash>_anti_matter\` over Samba). The only outbound request sends a Matter code's vendor ID and product ID to the official CSA registry, to look up the names.
- **Every Home Assistant user can open the panel.** That includes non-admins, so they can read the codes too.

![Details of a Matter code: linked Home Assistant device and decoded payload](https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/docs/screenshots/detail.png)

## Configuration

| Option | Values | What it does |
| --- | --- | --- |
| Language | `Auto` or one of 24 languages | Default app language. `Auto` follows Home Assistant, then the browser. |
| Theme | `Auto`, `Light`, `Dark` | Default theme. `Auto` follows Home Assistant. |
| Backups to keep | 1–100 | Starting value for the backup schedule. After you save the in-app Backups dialog, the value set there is used instead. |

A language or theme picked inside the app is remembered by that browser and takes precedence over these options.

The **Documentation** tab has the full manual. The
[project page](https://github.com/tempeduck/Anti-Matter-HA) has more screenshots, and the
[changelog](https://github.com/tempeduck/Anti-Matter-HA/blob/main/anti_matter/CHANGELOG.md) lists what changed in 3.0.

## Credits

Anti-Matter is a rewrite of [Rematters](https://github.com/Rematters/Rematters-HA) by
Jesse Hulswit ([JesseFPV](https://rematters.casa/)), reworked into a cloud-free, local-only
add-on. Full credit to Jesse for the original Rematters add-on and its design.

Matter, HomeKit, Z-Wave, Zigbee and Tuya are trademarks of their respective owners. They are used here only to
identify protocols.

**HA availability and connectivity.** Availability reflects the selected HA entity, not a separate network probe or a HomeKit pairing check. An app update entity describes the app, not every accessory it exports. **In use/Spare** remains your own inventory flag. The legacy JSON field `conn_matter` means **Thread**; the protocol is stored in `code_type`. Matter devices using Wi-Fi should not have Thread inferred from their protocol alone.
