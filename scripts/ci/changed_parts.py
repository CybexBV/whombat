#!/usr/bin/env python3
"""Which jobs of public CI a change needs (.github/workflows/public-ci.yml, the job `changes`).

    python3 -I scripts/ci/changed_parts.py --event pull_request --base <commit> --head <commit>

Prints `<job>=true` or `<job>=false` for each job, and writes the same lines to $GITHUB_OUTPUT when it is set. A job
runs when its part of the repository changed. Every job runs for a push (the check of `main` is always whole), when
the change can't be worked out, and when the change touches what the parts share: the workflows, the test recipe,
the lockfile and workspace file, `scripts/ci/` or a settings file at the root. Python 3 standard library only.
"""
import argparse
import os
import re
import subprocess
import sys

# The contracts' own packages (`pnpm contracts:gen:check` reads them); the rest of the job's inputs is contracts/.
CONTRACT_PACKAGES = ('core', 'protocol', 'fixtures', 'canvas-schema', 'secure-channel', 'control-contracts', 'release')
JOBS = ('check', 'contracts', 'appliance_go', 'appliance_harness', 'appliance_console', 'hosts', 'fixed_hashes')
# What the fixed hashes of the Nix build's downloads were taken for (appliance/scripts/ci/fixed_hashes.py), the file
# that holds them and the check itself. The root's own manifest, workspace file and lockfile run every job anyway.
FIXED_HASH_INPUTS = re.compile(
    r'^(patches/|appliance/console/ui/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'
    r'|(appliance|hosts)/go\.(mod|sum)$|appliance/flake\.lock$|appliance/nix/fixed-hashes\.json$'
    r'|appliance/scripts/ci/[^/]*fixed[-_]hashes)'
)
SHARED = re.compile(r'^(\.github/|scripts/ci/)')
# Words at the root: they change no check.
ROOT_WORDS = re.compile(r'^([^/]+\.md|LICENSE)$')


def jobs_for(paths):
    """The jobs these changed paths need, as {job: bool}."""
    paths = [p for p in paths if p]
    if any(SHARED.match(p) or ('/' not in p and not ROOT_WORDS.match(p)) for p in paths):
        return dict.fromkeys(JOBS, True)
    contracts = tuple(f'packages/{name}/' for name in CONTRACT_PACKAGES) + ('contracts/',)
    return {
        'check': any(not p.startswith(('appliance/', 'hosts/')) for p in paths),
        'contracts': any(p.startswith(contracts) for p in paths),
        # The appliance's Go module builds against contracts/go (its go.mod's replace).
        'appliance_go': any(p.startswith(('appliance/', 'contracts/go/')) for p in paths),
        # The harness's tests read the component list.
        'appliance_harness': any(
            p.startswith('appliance/harness/') or p == 'appliance/manifest/components.json' for p in paths
        ),
        'appliance_console': any(p.startswith('appliance/console/ui/') for p in paths),
        'hosts': any(p.startswith('hosts/') for p in paths),
        'fixed_hashes': any(FIXED_HASH_INPUTS.match(p) for p in paths),
    }


def changed_paths(base, head):
    """What head changed since it left base, or None when git can't say (no such commit, a shallow clone)."""
    for spec in (f'{base}...{head}', f'{base}..{head}'):
        result = subprocess.run(['git', 'diff', '--name-only', '--no-renames', '-z', spec], capture_output=True)
        if result.returncode == 0:
            return result.stdout.decode('utf-8', 'replace').split('\0')
    return None


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--event', default='')
    parser.add_argument('--base', default='')
    parser.add_argument('--head', default='HEAD')
    args = parser.parse_args(argv)
    paths = None
    if args.event != 'push' and re.fullmatch(r'[0-9a-f]{40}', args.base) and set(args.base) != {'0'}:
        paths = changed_paths(args.base, args.head)
    jobs = dict.fromkeys(JOBS, True) if paths is None else jobs_for(paths)
    why = 'every job (a push, or the change could not be worked out)' if paths is None else f'{len([p for p in paths if p])} changed files'
    print(f'changed_parts: {why}', file=sys.stderr)
    lines = ''.join(f'{job}={"true" if run else "false"}\n' for job, run in jobs.items())
    sys.stdout.write(lines)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
            out.write(lines)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
