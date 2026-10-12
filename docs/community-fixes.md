# Community fixes (2.0.6)

This fork builds on Cl3tus's Anti-Matter 2.0.5. The original MIT license and
credits are retained. The large 3.0 redesign proposed in upstream PR #10 is
separate from this release.

## Changes

- Mobile scanning can use the Home Assistant Companion app's native QR scanner
  when the ingress panel exposes it. Browser camera errors are caught, with
  instructions for using a photo or changing camera permissions.
- **Take photo** and **Choose image** are separate buttons. Choosing an image
  no longer forces the camera to open on phones.
- Photos are retried with a white margin, smaller sizes, grayscale contrast,
  and inversion. A failing native browser decoder falls back to the bundled
  offline decoder. No image or camera frame is uploaded to a server to decode it.
- Closing the scanner cancels pending results and releases cameras that finish
  opening after the dialog has closed. Temporary photo readers are removed.
- Import failures are shown in the UI. Unrelated JSON such as `{}` is rejected
  before it can replace a vault. Validation details from a rejected file are
  omitted from logs and error messages because they can contain pairing codes.
- HA device suggestions show and search entity IDs. Linking fills empty vendor,
  product and area fields while preserving entered values. Identical device
  names without entities use their device IDs to remain distinguishable.

The legacy JSON field `conn_matter` means **Thread connectivity**, not the
Matter protocol. `code_type: "matter"` identifies a Matter code. A Matter-over-Wi-Fi
device can correctly have `conn_wifi: true` and `conn_matter: false`; this fork
does not force a Thread flag on every Matter device.

The card-grid size control already exists in 2.0.5: use the minus/plus buttons
and percentage menu at the bottom left, or Ctrl+scroll.

## Camera requirements

A browser requires a secure HTTPS page for live camera access (localhost is
also allowed for development). HTTP pages can still use **Take photo** or
**Choose image**. Companion apps with a supported native scanner can use it
over HTTP as well. Allow camera access for Home Assistant in the phone's app
settings when prompted.

The Companion integration feature-checks Home Assistant's frontend bridge.
This is an internal frontend interface and can change. If it is unavailable,
the browser camera and photo options remain available.

For a failed photo, try a sharp, well-lit image with white space around the QR.
Tightly cropping to the code's edges can remove the margin a reader needs.
Black-and-white processing alone does not resolve every scan failure.

## Install or move an existing vault

Add `https://github.com/tempeduck/Anti-Matter-HA` to the Home Assistant app/add-on
store repositories, then install **Anti-Matter (community fixes)**.

Installing from a different repository creates a separate app and config folder
with an empty vault. Export the vault from the original app and import that file
into the fork. This transfers codes and categories; the original app's Trash,
scheduled-backup settings and backup history remain in its original folder.
Export files contain pairing secrets: keep them private.

## Validation

These commands use synthetic test codes and temporary local vaults. They do not
connect to a live Home Assistant server.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r anti_matter/app/requirements.txt pytest
.venv/bin/python -m pytest -q anti_matter/tests
npm ci
npx playwright install chromium
PYTHON="$PWD/.venv/bin/python" npm test
```

The browser tests exercise the real bundled image decoder and a same-origin
iframe with a simulated Companion bridge. Passing those tests establishes
the local behavior; a physical phone still needs to verify its camera,
permissions and installed Companion version.
