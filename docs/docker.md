# Standalone Docker

[Overview and Home Assistant installation](../README.md) · [User guide](../anti_matter/DOCS.md)

The standalone image runs the same vault, browser scanner, labels and local
backup tools without Home Assistant's Supervisor. Home Assistant discovery,
device/entity linking and automatic In use tracking require the HA app.

## Start

Install Docker with the Compose v2 plugin, then run:

```sh
git clone https://github.com/tempeduck/Anti-Matter-HA.git
cd Anti-Matter-HA
docker compose up -d --build --wait
```

Open **http://localhost:8099**. The image builds from this checkout, includes all
browser assets, and runs as user `antimatter` (UID/GID 1000). A health check reads
`/api/info`; Compose waits for the service to become healthy.

To use another host port:

```sh
ANTIMATTER_PORT=8100 docker compose up -d --build --wait
```

The container continues listening on 8099; this changes only the host mapping.

## Access from another device

The default mapping, `127.0.0.1:8099:8099`, makes the app reachable on the Docker
host. Anti-Matter has no standalone login. For remote use, route it through a
reverse proxy with authentication and HTTPS. A proxy on the host can forward to
`http://127.0.0.1:8099`; a container proxy on the same Docker network can forward
to `http://anti-matter:8099`.

HTTPS enables phone browser cameras. On HTTP outside localhost, use a photo,
pasted image or text instead. Home Assistant's sidebar authentication and its
native Companion scanner are features of the HA installation.

## Storage and backups

Compose mounts the persistent `data` volume at `/config`:

```text
/config/
├── anti_matter.json          vault
├── anti-matter-bin.json      Trash
├── backup_settings.json      scheduled-backup settings
├── options.json             optional interface defaults
├── backups/                 vault backup files
└── media/anti_matter/        saved label/image copies
```

Use **Backups** for scheduled backups, **Export** for the vault, and the offline
HTML viewer to inspect a saved JSON file. Vault exports/backups exclude Trash
and saved image copies. Back up the complete Docker volume to preserve all
files. Home Assistant's backups do not cover this separate container.

`docker compose down` stops the service and keeps its data volume. The `-v` flag
removes that volume and its data. Keep the Compose project name consistent when
updating so the service continues using the same volume.

For a host-directory mount, replace `data:/config` with a bind mount and make the
directory writable by UID/GID 1000. See Docker's [volume documentation](https://docs.docker.com/engine/storage/volumes/).

## Update

Back up/export current data, then update the source and recreate the container:

```sh
git pull --ff-only
docker compose up -d --build --wait
docker compose ps
```

Use `docker compose logs --tail 100 anti-matter` to inspect startup problems.
Rebuilding or recreating the container preserves the volume.

## Bring over an existing vault

Export JSON from the old installation and import it into the new one. Review
the imported records before retiring the old installation. To preserve Trash,
saved image copies and schedules too, stop both instances before copying their complete
storage folders. Never let two running instances write the same vault directory.

The Home Assistant app's Dockerfile remains under `anti_matter/`; the root
Dockerfile is for standalone use and starts Python directly.

## Development and validation

```sh
docker compose config --quiet
docker compose build
docker compose up -d --wait
```

The image supports amd64 and arm64. CI builds both platforms and runs a temporary
Compose instance to check health, the UI, synthetic saves, backups and persistence
after container replacement. See [`tools/ci/docker.py`](../tools/ci/docker.py).
