"""Which public-ci jobs a change needs (python3 -m unittest discover -s scripts/ci -p 'test_changed_parts.py')."""

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import changed_parts  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def needed(*paths):
    return sorted(job for job, run in changed_parts.jobs_for(paths).items() if run)


class ChangedParts(unittest.TestCase):
    def test_a_folders_change_runs_only_its_jobs(self):
        self.assertEqual(needed('appliance/manager/internal/x.go'), ['appliance_go'])
        self.assertEqual(needed('appliance/harness/src/a.ts'), ['appliance_go', 'appliance_harness'])
        # The harness's tests read the component list.
        self.assertEqual(needed('appliance/manifest/components.json'), ['appliance_go', 'appliance_harness'])
        self.assertEqual(needed('appliance/manifest/prod/tuf-root.json'), ['appliance_go'])
        self.assertEqual(needed('appliance/console/ui/src/a.tsx'), ['appliance_console', 'appliance_go'])
        self.assertEqual(needed('hosts/internal/hub/hub.go', 'hosts/web/src/App.tsx'), ['hosts'])

    def test_whombats_own_files_run_the_check_and_the_contracts_only_for_contracts(self):
        self.assertEqual(needed('apps/web/src/a.tsx', 'docs/decisions/x.md'), ['check'])
        self.assertEqual(needed('packages/core/src/a.ts'), ['check', 'contracts'])
        self.assertEqual(needed('contracts/schema/x.json'), ['check', 'contracts'])
        self.assertEqual(needed('packages/client/src/a.ts'), ['check'])

    def test_the_contracts_go_module_also_runs_the_appliance_that_builds_against_it(self):
        self.assertEqual(needed('contracts/go/release/compat.go'), ['appliance_go', 'check', 'contracts'])

    def test_an_input_of_a_fixed_hash_runs_its_check(self):
        self.assertEqual(needed('patches/postgres@3.4.9.patch'), ['check', 'fixed_hashes'])
        self.assertEqual(needed('appliance/go.sum'), ['appliance_go', 'fixed_hashes'])
        self.assertEqual(needed('hosts/go.mod'), ['fixed_hashes', 'hosts'])
        self.assertEqual(needed('appliance/flake.lock'), ['appliance_go', 'fixed_hashes'])
        self.assertEqual(needed('appliance/nix/fixed-hashes.json'), ['appliance_go', 'fixed_hashes'])
        self.assertEqual(needed('appliance/console/ui/pnpm-lock.yaml'),
                         ['appliance_console', 'appliance_go', 'fixed_hashes'])
        # A package's own package.json (its version moves with every release) and a source file are no input.
        self.assertEqual(needed('apps/web/package.json', 'packages/core/src/a.ts'), ['check', 'contracts'])

    def test_what_the_parts_share_runs_every_job(self):
        everything = sorted(changed_parts.JOBS)
        for path in ('.github/workflows/public-ci.yml', '.fast-test.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                     'scripts/ci/full.sh', 'package.json', 'biome.json', '.gitleaks.toml'):
            self.assertEqual(needed(path), everything, path)

    def test_words_at_the_root_run_the_check_alone(self):
        self.assertEqual(needed('README.md', 'LICENSE'), ['check'])

    def test_a_push_and_an_unknown_base_run_every_job(self):
        for argv in (['--event', 'push', '--base', 'a' * 40], ['--event', 'pull_request', '--base', ''],
                     ['--event', 'pull_request', '--base', '0' * 40], ['--event', 'pull_request', '--base', 'f' * 40]):
            lines = self.run_cli(argv)
            self.assertEqual(lines, [f'{job}=true' for job in changed_parts.JOBS], argv)

    def test_no_change_runs_nothing(self):
        self.assertEqual(self.run_cli(['--event', 'pull_request', '--base', self.head(), '--head', 'HEAD']),
                         [f'{job}=false' for job in changed_parts.JOBS])

    def test_the_workflow_asks_for_every_job_by_its_name(self):
        # A job this script names and the workflow doesn't read would never be skipped, and the other way round never run.
        workflow = (ROOT / '.github/workflows/public-ci.yml').read_text()
        for job in changed_parts.JOBS:
            self.assertIn(f'needs.changes.outputs.{job} ==', workflow)
            self.assertIn(f'{job}: ${{{{ steps.parts.outputs.{job} }}}}', workflow)

    def head(self):
        return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip()

    def run_cli(self, argv):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/ci/changed_parts.py'), *argv], cwd=ROOT,
                                capture_output=True, text=True, env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.split()


if __name__ == '__main__':
    unittest.main()
