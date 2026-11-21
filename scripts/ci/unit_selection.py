"""Conservative PR unit-test selection. Unknown impact runs the complete suite."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import time


ROOT = Path(__file__).resolve().parents[2]
PR_REF = re.compile(r'refs/pull/[1-9][0-9]*/head')
SHA = re.compile(r'[a-f0-9]{40}')
MODULE = re.compile(r'apps/(?:server|web|mobile)/src/.+\.(?:ts|tsx|js|jsx)$')
# These have consumers outside ordinary imports, or change the test environment/security boundary.
BROAD = ('packages/', 'contracts/', 'scripts/', '.github/', 'ci/', 'patches/',
         'apps/server/src/db/', 'apps/server/src/commit/', 'apps/server/src/auth/',
         'apps/server/src/approvals/', 'apps/server/src/vault/', 'apps/server/src/managed/',
         'apps/server/src/runtime/', 'apps/server/src/test/', 'apps/server/src/seed/',
         'apps/web/src/test/', 'apps/mobile/src/test/')
ENTRY = {'apps/server/src/app.ts', 'apps/server/src/index.ts', 'apps/server/src/host-api.ts',
         'apps/server/src/services.ts', 'apps/server/src/config.ts'}


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.PIPE, timeout=30)


def full(reason, **facts):
    return {'mode': 'full', 'reason': reason, **facts}


def classify(changes):
    """Only ordinary source modules reduce coverage; renames/deletions and opaque inputs expand it."""
    paths = [path for status, path in changes]
    facts = {'changed': paths}
    if not paths:
        return full('The comparison contains no changed files.', **facts)
    modules = []
    for status, path in changes:
        parts = PurePosixPath(path).parts
        if not parts or path.startswith('/') or '..' in parts or '\\' in path:
            return full('A changed path is not understood.', **facts)
        if status not in ('A', 'M'):
            return full('Deleted, renamed or unusual files need the complete suite.', **facts)
        if path.startswith('docs/') and path.endswith('.md'):
            continue
        if path in ('README.md', 'LICENSE'):
            continue
        if path.startswith(BROAD) or path in ENTRY or not MODULE.fullmatch(path):
            return full('Shared code, configuration or an opaque input changed.', **facts)
        modules.append(path)
    return {'mode': 'affected' if modules else 'documentation',
            'reason': 'Select transitive unit-test importers.' if modules else 'Only documentation changed.',
            **facts}


def plan(root, environment, base=None):
    """The controller bundles ci-base at the admitted PR base, including its complete ancestry."""
    if environment.get('WHOMBAT_CI_FULL') == '1':
        return full('A complete run was requested.')
    if not PR_REF.fullmatch(environment.get('GITHUB_REF', '')):
        return full('Main, manual and benchmark runs use every unit test.')
    try:
        head = git(root, 'rev-parse', 'HEAD^{commit}').decode().strip()
        if head != environment.get('GITHUB_SHA') or not SHA.fullmatch(head):
            return full('The checkout does not match the admitted revision.')
        base = base or git(root, 'rev-parse', '--verify', 'refs/remotes/origin/ci-base^{commit}').decode().strip()
        if not SHA.fullmatch(base):
            return full('The PR base is not an exact commit.')
        ancestors = git(root, 'merge-base', '--all', base, head).decode().splitlines()
        if len(ancestors) != 1 or not SHA.fullmatch(ancestors[0]):
            return full('The PR comparison has no unambiguous merge base.')
        merged = ancestors[0]
        # No rename detection: a rename includes a deletion, which deliberately requires the full suite.
        fields = git(root, 'diff', '--no-renames', '--name-status', '-z', merged, head).decode().split('\0')
        if fields[-1] != '' or len(fields) % 2 != 1:
            return full('The complete changed-file list could not be read.')
        changes = list(zip(fields[0:-1:2], fields[1:-1:2]))
        if git(root, 'status', '--porcelain', '--untracked-files=no').strip():
            return full('Tracked inputs changed after checkout.')
        return {**classify(changes), 'head': head, 'base': base, 'merge_base': merged}
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return full('The exact PR comparison is unavailable.')


def discover(root, selection, environment, reports, config=None):
    """Ask Vitest to resolve its own aliases, mocks and transitive importers without executing tests."""
    destination = reports / 'unit-selected-files.json'
    destination.unlink(missing_ok=True)
    command = ['pnpm', 'exec', 'vitest', 'list', '--filesOnly',
               '--changed', selection['merge_base'], '--json=' + str(destination)]
    if config:
        command += ['--config', str(config)]
    with (reports / 'unit-selection.log').open('w') as log:
        subprocess.run(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=180)
    rows = json.loads(destination.read_text())
    if not isinstance(rows, list) or not rows:
        raise ValueError('No unit tests were found for changed source.')
    files = set()
    for row in rows:
        file = Path(row['file'])
        relative = file.resolve().relative_to(root.resolve()).as_posix()
        if not file.is_file() or not re.search(r'\.test\.[cm]?[jt]sx?$', relative):
            raise ValueError('Vitest reported an unexpected test file.')
        files.add(relative)
    return sorted(files)


def prepare(root, command, environment, reports):
    started = time.monotonic()
    selected = plan(root, environment)
    if selected['mode'] == 'affected':
        try:
            selected['files'] = discover(root, selected, environment, reports)
            command = [*command, *[str(root / file) for file in selected['files']]]
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            selected = {**selected, 'mode': 'full', 'reason': 'Dependency discovery was empty or uncertain.'}
    selected['discovery_seconds'] = time.monotonic() - started
    (reports / 'unit-selection.json').write_text(json.dumps(selected, indent=2) + '\n')
    print('Unit selection: ' + selected['mode'] + ' — ' + selected['reason'], flush=True)
    return command, selected


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', help='Exact base for a local, read-only policy preview')
    args = parser.parse_args()
    print(json.dumps(plan(ROOT, os.environ, args.base), indent=2))
