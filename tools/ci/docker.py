#!/usr/bin/env python3
"""Exercise a throwaway standalone Compose installation; no HA or real vault."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true', help='Use the existing ANTIMATTER_IMAGE.')
    args = parser.parse_args()
    project = f'anti-matter-ci-{os.getpid()}'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, ANTIMATTER_PORT=str(port),
               ANTIMATTER_IMAGE=os.environ.get('ANTIMATTER_IMAGE', f'anti-matter-ci:{os.getpid()}'))
    command = ['docker', 'compose', '-f', str(ROOT / 'compose.yaml'), '-p', project]
    checks = 0

    def compose(*arguments: str) -> str:
        result = subprocess.run(command + list(arguments), cwd=ROOT, env=env,
                                text=True, capture_output=True, timeout=600)
        if result.returncode:
            raise RuntimeError(f'Docker Compose {arguments[0]} failed (exit {result.returncode})')
        return result.stdout

    def request(route: str, data=None) -> bytes:
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(f'http://127.0.0.1:{port}{route}', data=body,
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read()

    def check(condition: bool, label: str) -> None:
        nonlocal checks
        if not condition:
            raise RuntimeError(label)
        checks += 1
        print('PASS ' + label, flush=True)

    try:
        compose('config', '--quiet')
        if not args.skip_build:
            compose('build')
        compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
        info = json.loads(request('/api/info'))
        check(not info['ha_available'], 'standalone starts without Supervisor access')
        check('Anti-Matter' in request('/').decode(), 'actual UI is served')
        check('setup-code__value' in request('/static/css/sheets.css').decode(), 'bundled assets are served')
        check(compose('exec', '-T', 'anti-matter', 'id', '-u').strip() == '1000', 'container runs as UID 1000')
        status = json.loads(compose('ps', '--format', 'json'))
        check(status['Health'] == 'healthy' and bool(status['Publishers']) and
              all(binding['URL'] == '127.0.0.1' for binding in status['Publishers']),
              'healthy service publishes only on localhost')
        check(not json.loads(request('/api/vault'))['codes'], 'temporary vault starts empty')
        record = json.loads(request('/api/codes', {
            'name': 'Synthetic Docker persistence fixture', 'code_type': 'matter',
            'qr_payload': 'MT:Y.K9042C00KA0648G00',
        }))
        check(bool(record['id']), 'synthetic Matter record saves to the persistent volume')
        png = request('/api/codes/' + record['id'] + '/label.png')
        check(png.startswith(b'\x89PNG\r\n\x1a\n'), 'generated PNG labels work with bundled scalable fonts')
        backup = json.loads(request('/api/backup', {}))
        check(bool(backup), 'vault backup can be created as the non-root user')
        before = request('/api/vault')
        on_disk = compose('exec', '-T', 'anti-matter', 'python', '-c',
            'from pathlib import Path; import hashlib,json; '
            'files={str(p.relative_to("/config")):hashlib.sha256(p.read_bytes()).hexdigest() '
            'for p in Path("/config").rglob("*") if p.is_file()}; print(json.dumps(files,sort_keys=True))')
        check(any(name.startswith('backups/') for name in json.loads(on_disk)), 'backup file resides in the persistent volume')
        compose('down')
        compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
        check(request('/api/vault') == before, 'container replacement preserves the complete vault')
        after_disk = compose('exec', '-T', 'anti-matter', 'python', '-c',
            'from pathlib import Path; import hashlib,json; '
            'files={str(p.relative_to("/config")):hashlib.sha256(p.read_bytes()).hexdigest() '
            'for p in Path("/config").rglob("*") if p.is_file()}; print(json.dumps(files,sort_keys=True))')
        check(json.loads(on_disk) == json.loads(after_disk), 'container replacement preserves configuration and backup bytes')
        print(json.dumps({'standalone_docker': 'pass', 'checks': checks, 'version': info['version']}))
    finally:
        # Only this uniquely named fixture project and its synthetic volume are removed.
        compose('down', '--volumes', '--remove-orphans')


if __name__ == '__main__':
    main()
