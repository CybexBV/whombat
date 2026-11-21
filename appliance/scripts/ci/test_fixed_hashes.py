"""The fixed hashes follow their inputs (python3 -I -m unittest discover -s scripts/ci -p 'test_fixed_hashes.py')."""

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixed_hashes  # noqa: E402

REPO = Path(__file__).resolve().parents[3]


class FixedHashes(unittest.TestCase):
    def setUp(self):
        # A small repository with the files the four hashes are taken for, and a hashes file that is up to date.
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        files = {
            'package.json': '{"name":"root"}',
            'pnpm-lock.yaml': 'lockfileVersion: 9\n',
            'pnpm-workspace.yaml': 'packages: [apps/*]\n',
            'apps/server/package.json': '{"name":"server"}',
            'apps/server/src/index.ts': 'export {};\n',
            'apps/server/deep/package.json': '{"name":"not a workspace package"}',
            'packages/core/package.json': '{"name":"core"}',
            'patches/a@1.patch': 'diff\n',
            'docs/readme.md': 'words\n',
            'appliance/console/ui/package.json': '{"name":"console"}',
            'appliance/console/ui/pnpm-lock.yaml': 'lockfileVersion: 9\n',
            'appliance/console/ui/pnpm-workspace.yaml': 'packages: [.]\n',
            'appliance/go.mod': 'module appliance\n',
            'appliance/go.sum': '',
            'hosts/go.mod': 'module rackoon\n',
            'hosts/go.sum': '',
            fixed_hashes.LOCK: json.dumps(
                {'root': 'root', 'nodes': {'root': {'inputs': {'nixpkgs': 'nixpkgs'}}, 'nixpkgs': {'locked': {'rev': 'a' * 40}}}}
            ),
            fixed_hashes.HASHES: json.dumps(
                {
                    'runtimePnpm': {'hash': 'sha256-r', 'digest': '', 'fetcherVersion': 4, 'pnpmWorkspaces': ['a...', 'b...']},
                    'consolePnpm': {'hash': 'sha256-c', 'digest': '', 'fetcherVersion': 4},
                    'applianceGo': {'hash': 'sha256-a', 'digest': ''},
                    'hostsGo': {'hash': 'sha256-h', 'digest': ''},
                }
            ),
        }
        for path, text in files.items():
            self.write(path, text)
        self.git('init', '-q')
        self.git('add', '-A')
        hashes = fixed_hashes.load(self.root)
        for name, value in fixed_hashes.today(self.root, hashes).items():
            hashes[name]['digest'] = value
        fixed_hashes.save(self.root, hashes)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)

    def check(self):
        """The check's exit code and what it said."""
        said = io.StringIO()
        with contextlib.redirect_stdout(said), contextlib.redirect_stderr(said):
            code = fixed_hashes.check(self.root)
        return code, said.getvalue()

    def stale(self):
        return fixed_hashes.stale(self.root, fixed_hashes.load(self.root))

    def test_nothing_is_stale_after_a_refresh(self):
        self.assertEqual(self.check()[0], 0)

    def test_a_changed_lockfile_fails_the_check_and_names_the_refresh(self):
        self.write('pnpm-lock.yaml', 'lockfileVersion: 9\npackages: {left-pad: 1}\n')
        code, said = self.check()
        self.assertEqual(code, 1)
        self.assertEqual(self.stale(), ['runtimePnpm'])
        self.assertIn('--refresh runtimePnpm', said)
        self.assertIn(fixed_hashes.HASHES, said)

    def test_each_input_makes_only_its_own_hash_stale(self):
        cases = {
            'pnpm-workspace.yaml': ['runtimePnpm'],
            'patches/a@1.patch': ['runtimePnpm'],
            'appliance/console/ui/pnpm-lock.yaml': ['consolePnpm'],
            'appliance/go.sum': ['applianceGo'],
            'hosts/go.mod': ['hostsGo'],
        }
        for path, names in cases.items():
            with self.subTest(path):
                before = (self.root / path).read_text()
                self.write(path, before + 'changed\n')
                self.assertEqual(self.stale(), names)
                self.write(path, before)
                self.assertEqual(self.stale(), [])

    def test_a_new_patch_makes_the_runtime_store_stale(self):
        self.write('patches/b@2.patch', 'diff\n')
        self.git('add', 'patches/b@2.patch')
        self.assertEqual(self.stale(), ['runtimePnpm'])
        self.git('rm', '-q', '-f', 'patches/b@2.patch')
        self.assertEqual(self.stale(), [])

    def test_a_package_s_own_version_is_no_input(self):
        # An app or contracts release bumps these; the store follows the lockfile, which `--frozen-lockfile` holds the
        # manifests to.
        self.write('apps/server/package.json', '{"name":"server","version":"9.9.9"}')
        self.write('packages/core/package.json', '{"name":"core","version":"9.9.9"}')
        self.assertEqual(self.stale(), [])

    def test_what_no_download_reads_changes_nothing(self):
        # Source files, documents and a file git doesn't track.
        self.write('apps/server/src/index.ts', 'export const x = 1;\n')
        self.write('docs/readme.md', 'other words\n')
        self.write('apps/server/deep/package.json', '{"name":"changed"}')
        self.write('patches/untracked.patch', 'not added\n')
        self.assertEqual(self.stale(), [])

    def test_another_nixpkgs_makes_every_hash_stale(self):
        lock = json.loads((self.root / fixed_hashes.LOCK).read_text())
        lock['nodes']['nixpkgs']['locked']['rev'] = 'b' * 40
        self.write(fixed_hashes.LOCK, json.dumps(lock))
        self.assertEqual(self.stale(), ['runtimePnpm', 'consolePnpm', 'applianceGo', 'hostsGo'])

    def test_what_a_store_is_fetched_with_is_an_input(self):
        hashes = fixed_hashes.load(self.root)
        hashes['runtimePnpm']['pnpmWorkspaces'] = ['a...']
        hashes['consolePnpm']['fetcherVersion'] = 5
        fixed_hashes.save(self.root, hashes)
        self.assertEqual(self.stale(), ['runtimePnpm', 'consolePnpm'])

    def test_an_entry_without_a_hash_is_stale(self):
        hashes = fixed_hashes.load(self.root)
        hashes['hostsGo']['hash'] = ''
        fixed_hashes.save(self.root, hashes)
        self.assertEqual(self.stale(), ['hostsGo'])

    def test_a_missing_entry_fails_the_check(self):
        hashes = fixed_hashes.load(self.root)
        del hashes['applianceGo']
        fixed_hashes.save(self.root, hashes)
        code, said = self.check()
        self.assertEqual(code, 1)
        self.assertIn('applianceGo', said)

    def test_the_digest_is_the_documented_form(self):
        # One line per file, "<sha256>  <path>", sorted by path; then "<name>=<value>" sorted by name. Nix computes the
        # same (nix/lib/sources.nix digestOf), so the form is fixed here.
        import hashlib

        files = ['hosts/go.sum', 'hosts/go.mod']
        text = (
            f'{hashlib.sha256(b"module rackoon\n").hexdigest()}  hosts/go.mod\n'
            f'{hashlib.sha256(b"").hexdigest()}  hosts/go.sum\n'
            'a=2\nb=1\n'
        )
        self.assertEqual(
            fixed_hashes.digest(self.root, files, {'b': '1', 'a': '2'}), hashlib.sha256(text.encode()).hexdigest()
        )

    def test_the_repository_s_own_hashes_are_up_to_date(self):
        said = io.StringIO()
        with contextlib.redirect_stdout(said), contextlib.redirect_stderr(said):
            code = fixed_hashes.check(REPO)
        self.assertEqual(code, 0, said.getvalue())


if __name__ == '__main__':
    unittest.main()
