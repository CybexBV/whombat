#!/usr/bin/env python3
"""The fixed hashes of what the Nix build downloads, and what each was taken for (appliance/nix/fixed-hashes.json).

Nix can't predict four downloads: the runtime's pnpm store, the console page's pnpm store, and the Go modules of the
appliance and of the hosts service. Each has a hash in the file, and beside it the digest of the inputs it was taken
for: the lockfile and manifests, the Go version's nixpkgs, and so on. When an input changes, the hash is stale.

  fixed-hashes.sh --check              every entry's digest is today's inputs' (no Nix; exit 1 names the stale ones)
  fixed-hashes.sh --refresh [name …]   fetch the stale entries (or the named ones) with Nix and write hash and digest
  fixed-hashes.sh --digests            print today's digests
  fixed-hashes.sh --stale              print the names of the stale entries, one a line (exit 0)

The digest is the sha256 of one line per input file, "<sha256>  <path from the repository's root>", sorted by path,
then one line per other input, "<name>=<value>", sorted by name. appliance/nix/lib/sources.nix computes the same in
Nix, puts its start into the download's name, and refuses a hash whose digest is not today's.

Run --refresh in the change that touches an input, on a machine with Nix and the network, and commit the file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HASHES = 'appliance/nix/fixed-hashes.json'
LOCK = 'appliance/flake.lock'

# name -> what Nix builds to fetch it (an attribute of the flake in appliance/).
INSTALLABLES = {
    'runtimePnpm': 'whombat-runtime.pnpmDeps',
    'consolePnpm': 'whombat-console-ui.pnpmDeps',
    'applianceGo': 'whombat-manager.goModules',
    'hostsGo': 'whombat-hosts.goModules',
}


def tracked(root: Path, *patterns: str) -> list[str]:
    """The tracked files that match the patterns (`*` stays inside one folder, `**` crosses folders)."""
    out = subprocess.run(
        ['git', '-C', str(root), 'ls-files', '-z', '--', *[f':(glob){p}' for p in patterns]],
        check=True,
        capture_output=True,
    ).stdout
    # A file removed from the working tree but not yet from the index is gone for Nix too.
    return [p for p in out.decode().split('\0') if p and (root / p).is_file()]


def nixpkgs_rev(root: Path) -> str:
    lock = json.loads((root / LOCK).read_text())
    node = lock['nodes'][lock['root']]['inputs']['nixpkgs']
    return lock['nodes'][node]['locked']['rev']


def inputs(root: Path, name: str, entry: dict) -> tuple[list[str], dict[str, str]]:
    """The files and the other inputs an entry's hash depends on."""
    nixpkgs = nixpkgs_rev(root)
    if name == 'runtimePnpm':
        # What decides the store's contents: the lockfile, the workspace file, the root manifest and the patches.
        # Not each package's own package.json: its version changes with every app and contracts release, and a
        # dependency can't change there without the lockfile (`pnpm install --frozen-lockfile` refuses it).
        files = tracked(root, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/**')
        return files, {
            'nixpkgs': nixpkgs,
            'fetcherVersion': str(entry['fetcherVersion']),
            'pnpmWorkspaces': ' '.join(entry['pnpmWorkspaces']),
        }
    if name == 'consolePnpm':
        files = [f'appliance/console/ui/{f}' for f in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')]
        return files, {'nixpkgs': nixpkgs, 'fetcherVersion': str(entry['fetcherVersion'])}
    if name == 'applianceGo':
        return ['appliance/go.mod', 'appliance/go.sum'], {'nixpkgs': nixpkgs}
    if name == 'hostsGo':
        return ['hosts/go.mod', 'hosts/go.sum'], {'nixpkgs': nixpkgs}
    raise SystemExit(f'fixed-hashes: {HASHES} has an entry {name} this script does not know')


def digest(root: Path, files: list[str], params: dict[str, str]) -> str:
    lines = []
    for path in sorted(set(files), key=lambda p: p.encode()):
        lines.append(f'{hashlib.sha256((root / path).read_bytes()).hexdigest()}  {path}\n')
    for key in sorted(params):
        lines.append(f'{key}={params[key]}\n')
    return hashlib.sha256(''.join(lines).encode()).hexdigest()


def load(root: Path) -> dict:
    return json.loads((root / HASHES).read_text())


def save(root: Path, hashes: dict) -> None:
    (root / HASHES).write_text(json.dumps(hashes, indent=2) + '\n')


def today(root: Path, hashes: dict) -> dict[str, str]:
    return {name: digest(root, *inputs(root, name, entry)) for name, entry in hashes.items()}


def stale(root: Path, hashes: dict) -> list[str]:
    now = today(root, hashes)
    return [name for name, entry in hashes.items() if entry.get('digest') != now[name] or not entry.get('hash')]


def check(root: Path) -> int:
    hashes = load(root)
    missing = sorted(set(INSTALLABLES) - set(hashes))
    if missing:
        print(f'fixed-hashes: {HASHES} lacks {", ".join(missing)}', file=sys.stderr)
        return 1
    names = stale(root, hashes)
    if not names:
        print(f'fixed-hashes: all {len(hashes)} hashes were taken for today\'s inputs')
        return 0
    for name in names:
        files, _ = inputs(root, name, hashes[name])
        shown = ', '.join(files[:4]) + (' …' if len(files) > 4 else '')
        print(
            f'fixed-hashes: {name} is stale: one of its inputs changed ({shown}, or nixpkgs in {LOCK}).',
            file=sys.stderr,
        )
    print(
        f'Run appliance/scripts/ci/fixed-hashes.sh --refresh {" ".join(names)} on a machine with Nix and commit '
        f'{HASHES}. Without Nix, say so in the pull request: a maintainer adds the refresh.',
        file=sys.stderr,
    )
    return 1


GOT = re.compile(r'^\s*got:\s+(sha256-[A-Za-z0-9+/]{43}=)\s*$', re.MULTILINE)


def fetch(root: Path, name: str) -> str:
    """Builds the download with an empty hash and returns the hash Nix reports."""
    flake = f'git+file://{root}?dir=appliance#{INSTALLABLES[name]}'
    run = subprocess.run(
        ['nix', '--extra-experimental-features', 'nix-command flakes', 'build', '--no-link', '--no-update-lock-file', flake],
        capture_output=True,
        text=True,
    )
    found = GOT.findall(run.stderr)
    if not found:
        sys.stderr.write(run.stderr)
        raise SystemExit(f'fixed-hashes: Nix reported no hash for {name} ({flake})')
    return found[-1]


def refresh(root: Path, names: list[str]) -> int:
    hashes = load(root)
    unknown = [n for n in names if n not in hashes]
    if unknown:
        raise SystemExit(f'fixed-hashes: no entry {", ".join(unknown)} in {HASHES} (it has {", ".join(hashes)})')
    names = names or stale(root, hashes)
    if not names:
        print('fixed-hashes: nothing is stale')
        return 0
    for name in names:
        # The digest first and no hash: Nix then accepts the entry as today's and reports what it fetched.
        hashes[name]['digest'] = today(root, hashes)[name]
        hashes[name]['hash'] = ''
        save(root, hashes)
        print(f'fixed-hashes: fetching {name} …', file=sys.stderr)
        hashes[name]['hash'] = fetch(root, name)
        save(root, hashes)
        print(f'fixed-hashes: {name} = {hashes[name]["hash"]}')
    print(f'fixed-hashes: commit {HASHES}')
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog='fixed-hashes.sh', description=__doc__.split('\n')[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--refresh', nargs='*', metavar='NAME')
    mode.add_argument('--digests', action='store_true')
    mode.add_argument('--stale', action='store_true')
    parser.add_argument('--root', help='the repository (default: the one this script is in)')
    args = parser.parse_args(argv)
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[3]
    if args.check:
        return check(root)
    if args.stale:
        for name in stale(root, load(root)):
            print(name)
        return 0
    if args.digests:
        for name, value in today(root, load(root)).items():
            print(f'{value}  {name}')
        return 0
    return refresh(root, args.refresh)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
