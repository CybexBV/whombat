"""Execution contracts for the paired disposable-guest benchmark."""

from copy import deepcopy
import importlib.util
from pathlib import Path
import json
import unittest


spec = importlib.util.spec_from_file_location('runtime_ci_check', Path(__file__).with_name('check.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class CheckContracts(unittest.TestCase):
    def passing(self, workers):
        return {'schema': 1, 'exit_code': 0, 'workers': workers, 'revision': 'same-exact-source',
                'condition': 'warm', 'gates_sha256': 'same-gates', 'seconds': 100 if workers == 4 else 80,
                'phases': [{'name': name, 'seconds': 10, 'exit_code': 0} for name, _ in check.phases()],
                'tests': {suite: {'total': 2, 'passed': 2, 'failed': 0, 'pending': 0,
                                 'identity_sha256': 'same-tests'} for suite in ('unit', 'server')}}

    def test_parallel_suites_share_the_budget_only_with_enough_cpu_and_memory(self):
        gib = 1024 ** 3
        self.assertEqual(check.test_schedule(8, 8, 12 * gib),
                         {'parallel': True, 'workers_per_suite': 4})
        for workers, cpus, memory in ((4, 4, 12 * gib), (8, 4, 12 * gib), (8, 8, 8 * gib)):
            self.assertEqual(check.test_schedule(workers, cpus, memory),
                             {'parallel': False, 'workers_per_suite': workers})

    def test_app_projects_share_one_bounded_playwright_pool(self):
        script = (check.ROOT / 'scripts/ci/app.sh').read_text()
        combined = [line for line in script.splitlines() if 'playwright test' in line and '--project=managed' in line]
        self.assertEqual(len(combined), 1)
        self.assertIn('--project=hosted', combined[0])
        self.assertIn('--workers=4', combined[0])
        self.assertEqual(script.count('--project=runtime'), 1)

    def test_worker_limit_rejects_oversubscription_and_ambiguous_input(self):
        self.assertEqual(check.worker_count('4'), 4)
        self.assertEqual(check.worker_count('8'), 8)
        for value in ('0', '9', '16', '4.0', '4 ', '-4', 'auto', '٤', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                check.worker_count(value)

    def test_complete_equivalent_pair_reports_improvement(self):
        result = check.compare(self.passing(4), self.passing(8), 'warm')
        self.assertEqual(result['improvement_percent'], 20)

    def test_comparison_rejects_source_coverage_and_execution_changes(self):
        baseline = self.passing(4)
        modifications = [
            lambda value: value.update(revision='different-source'),
            lambda value: value.update(gates_sha256='changed-soak-or-gates'),
            lambda value: value.update(exit_code=1),
            lambda value: value.update(condition='cold'),
            lambda value: value['phases'].pop(),
            lambda value: value['phases'][0].update(exit_code=1),
            lambda value: value['tests']['server'].update(identity_sha256='missing-test'),
            lambda value: value['tests']['unit'].update(pending=1),
            lambda value: value['phases'][5].update(selection={'mode': 'affected'}),
        ]
        for change in modifications:
            candidate = deepcopy(self.passing(8))
            change(candidate)
            with self.subTest(change=change), self.assertRaises(ValueError):
                check.compare(baseline, candidate, 'warm')

    def test_contracts_generated_files_and_go_module_are_checked(self):
        gates = dict(check.phases())
        scripts = json.loads((check.ROOT / 'package.json').read_text())['scripts']
        for phase, script in (('contracts-generated', 'contracts:gen:check'), ('contracts-go', 'contracts:test:go')):
            self.assertEqual(gates[phase], ['pnpm', script])
            self.assertIn(script, scripts)

    def test_third_party_notices_are_checked_in_ci_and_pnpm_check(self):
        gates = dict(check.phases())
        scripts = json.loads((check.ROOT / 'package.json').read_text())['scripts']
        self.assertEqual(gates['notices'], ['pnpm', 'notices', '--check'])
        self.assertIn('pnpm notices --check', scripts['check'])

    def test_soak_and_database_suite_remain_required(self):
        gates = dict(check.phases())
        self.assertEqual(gates['soak'], ['pnpm', 'soak:managed', '--minutes', '2', '--max-growth-mb', '40'])
        self.assertIn('vitest.int.config.ts', gates['server'])
        self.assertIn('--frozen-lockfile', gates['install'])

    def test_cli_database_suite_and_hermes_plugin_on_the_pin_are_checked(self):
        gates = dict(check.phases())
        self.assertEqual(gates['cli'][:3], ['pnpm', '--filter', '@whombat/cli'])
        self.assertIn('vitest.int.config.ts', gates['cli'])
        self.assertTrue((check.ROOT / 'apps/cli/vitest.int.config.ts').exists())
        self.assertEqual(gates['hermes'][1:], ['packages/hermes-whombat/scripts/test.py', '--hermes', 'pin'])
        self.assertTrue((check.ROOT / gates['hermes'][1]).exists())

    def test_types_check_what_pnpm_typecheck_checks_a_few_packages_at_a_time(self):
        gates = dict(check.phases())
        script = json.loads((check.ROOT / 'package.json').read_text())['scripts']['typecheck']
        self.assertIn('-r', gates['types'])
        self.assertNotIn('--parallel', gates['types'])
        self.assertEqual(gates['types'][-1], 'typecheck')
        self.assertIn(' '.join(gates['types-root'][2:]), script)

    def test_reporter_flags_are_forwarded_to_vitest_not_pnpm(self):
        gates = dict(check.phases())
        self.assertEqual(gates['unit'][:4], ['pnpm', 'exec', 'vitest', 'run'])
        self.assertEqual(gates['server'][:6], ['pnpm', '--filter', '@whombat/server', 'exec', 'vitest', 'run'])
        for name in ('unit', 'server'):
            self.assertGreater(gates[name].index('--reporter=json'), gates[name].index('vitest'))

    def test_frozen_install_first_and_workflow_starts_without_pnpm_implicit_install(self):
        self.assertEqual(check.phases()[0][0], 'install')
        self.assertIn('--frozen-lockfile', dict(check.phases())['install'])
        workflow = (check.ROOT / 'ci/platform/ci.yml').read_text()
        self.assertIn('run: python3 scripts/ci/check.py run', workflow)
        self.assertNotIn('run: pnpm ci:check', workflow)

    def test_app_job_runs_the_real_chat_smoke_test_against_its_own_postgres(self):
        app = (check.ROOT / 'scripts/ci/app.sh').read_text()
        self.assertIn('--project=runtime', app)
        self.assertIn('--output=../../tmp/playwright/web/runtime', app)
        workflow = (check.ROOT / 'ci/platform/ci.yml').read_text()
        job = workflow.split('\n  app:\n', 1)[1].split('\n  package:\n', 1)[0]
        self.assertIn('image: postgres:', job)
        self.assertIn("DATABASE_URL=postgres://whombat:whombat@127.0.0.1:${{ job.services.postgres.ports['5432'] }}", job)


if __name__ == '__main__':
    unittest.main()
