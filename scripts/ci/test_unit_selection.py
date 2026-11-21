"""Coverage regressions for exact-base selection and the real Vitest import graph."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import unit_selection as selection


class Policy(unittest.TestCase):
    def test_source_changes_with_notes_select_importers(self):
        plan = selection.classify([('M', 'apps/server/src/council/answers.ts'),
                                   ('A', 'docs/decisions/council.md')])
        self.assertEqual(plan['mode'], 'affected')

    def test_shared_opaque_or_deleted_inputs_always_expand(self):
        for path in ('pnpm-lock.yaml', 'package.json', 'tsconfig.base.json', 'ci/platform/ci.yml',
                     'scripts/ci/check.py', 'apps/web/vitest.config.ts', 'apps/server/package.json',
                     'packages/core/src/domain/council.ts', 'packages/client/src/council.ts',
                     'packages/hermes-whombat/whombat_hermes/skills/council/SKILL.md',
                     'apps/server/src/db/schema/councils.ts', 'apps/server/src/commit/pipeline.ts',
                     'apps/server/src/test/harness.ts', 'apps/web/src/test/setup.ts',
                     'apps/server/src/config.ts', 'apps/server/src/managed/routes.ts',
                     'apps/web/src/theme.css', 'apps/web/src/fixture.json', 'unknown/file.ts',
                     '../apps/server/src/council/answers.ts'):
            with self.subTest(path=path):
                self.assertEqual(selection.classify([('M', path)])['mode'], 'full')
        for status in ('D', 'R100', 'T', 'U'):
            self.assertEqual(selection.classify([(status, 'apps/web/src/a.ts')])['mode'], 'full')
        self.assertEqual(selection.classify([])['mode'], 'full')

    def test_only_reviewed_documentation_paths_omit_units(self):
        self.assertEqual(selection.classify([('M', 'docs/github.md'), ('M', 'README.md')])['mode'],
                         'documentation')
        self.assertEqual(selection.classify([('M', 'docs/design-handoff/design/mock.dc.html')])['mode'], 'full')

    def test_non_pr_and_explicit_full_never_consult_git(self):
        with patch.object(selection, 'git', side_effect=AssertionError('No comparison needed')):
            for ref in ('refs/heads/main', 'refs/heads/fix/small', 'refs/tags/release', 'refs/pull/1/merge', ''):
                self.assertEqual(selection.plan(Path('.'), {'GITHUB_REF': ref})['mode'], 'full')
            self.assertEqual(selection.plan(Path('.'), {'GITHUB_REF': 'refs/pull/1/head',
                                                       'WHOMBAT_CI_FULL': '1'})['mode'], 'full')

    def test_unknown_or_empty_discovery_executes_the_full_command(self):
        command = ['pnpm', 'exec', 'vitest', 'run']
        with tempfile.TemporaryDirectory() as tmp, redirect_stdout(io.StringIO()):
            for error in (ValueError('empty'), subprocess.TimeoutExpired('vitest', 180),
                          json.JSONDecodeError('bad JSON', '', 0)):
                with patch.object(selection, 'plan', return_value={'mode': 'affected', 'reason': 'source'}), \
                     patch.object(selection, 'discover', side_effect=error):
                    actual, plan = selection.prepare(Path(tmp), command, {}, Path(tmp))
                self.assertEqual(actual, command)
                self.assertEqual(plan['mode'], 'full')


class ExactComparison(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'CI test')
        self.git('config', 'user.email', 'ci@example.invalid')
        self.write('apps/server/src/council/score.ts', 'export const score = 8;\n')
        self.commit()
        self.base = self.head()
        self.git('update-ref', 'refs/remotes/origin/ci-base', self.base)

    def git(self, *args):
        return selection.git(self.root, *args)

    def write(self, path, contents):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(contents)

    def commit(self):
        self.git('add', '.')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')

    def head(self):
        return self.git('rev-parse', 'HEAD').decode().strip()

    def environment(self):
        return {**os.environ, 'CI': 'true', 'GITHUB_REF': 'refs/pull/42/head', 'GITHUB_SHA': self.head(),
                'WHOMBAT_CI_FULL': '0', 'VITEST_MAX_WORKERS': '2'}

    def test_exact_base_and_head_are_recorded_and_dirty_or_missing_inputs_expand(self):
        self.write('apps/server/src/council/score.ts', 'export const score = 9;\n')
        self.commit()
        plan = selection.plan(self.root, self.environment())
        self.assertEqual(plan['mode'], 'affected')
        self.assertEqual((plan['base'], plan['merge_base'], plan['head']), (self.base, self.base, self.head()))
        self.assertEqual(selection.plan(self.root, {**self.environment(), 'GITHUB_SHA': 'a' * 40})['mode'], 'full')
        self.git('update-ref', '-d', 'refs/remotes/origin/ci-base')
        self.assertEqual(selection.plan(self.root, self.environment())['mode'], 'full')
        self.git('update-ref', 'refs/remotes/origin/ci-base', self.base)
        self.write('apps/server/src/council/score.ts', 'export const score = 10;\n')
        self.assertEqual(selection.plan(self.root, self.environment())['mode'], 'full')

    def test_renames_include_the_deleted_path_and_expand(self):
        self.git('mv', 'apps/server/src/council/score.ts', 'apps/server/src/council/rating.ts')
        self.commit()
        self.assertEqual(selection.plan(self.root, self.environment())['mode'], 'full')

    def test_real_vitest_follows_transitive_alias_and_dynamic_importers_but_omits_proxmox(self):
        self.write('apps/server/src/council/answers.ts', "export {score} from './score';\n")
        self.write('apps/server/src/council/answers.test.ts',
                   "import {score} from './answers'; it('scores', () => expect(score).toBe(9));\n")
        self.write('apps/web/src/card.test.ts',
                   "import {score} from '../../server/src/council/answers'; it('card', () => expect(score).toBe(9));\n")
        self.write('apps/web/src/lazy.test.ts',
                   "it('lazy', async () => expect((await import('../../server/src/council/score')).score).toBe(9));\n")
        self.write('apps/web/src/alias.test.ts',
                   "import {score} from '@score'; it('alias', () => expect(score).toBe(9));\n")
        self.write('apps/server/src/provision/proxmox.test.ts', "it('proxmox', () => expect(true).toBe(true));\n")
        self.write('package.json', '{"type":"module"}\n')
        config = self.root / 'vitest.config.mts'
        self.write(config.name, '\n'.join([
            f'import {{defineConfig}} from {json.dumps(str(selection.ROOT / "node_modules/vitest/dist/config.js"))};',
            f'import {{withModuleCache}} from {json.dumps(str(selection.ROOT / "scripts/vitest-project.ts"))};',
            'export default defineConfig(withModuleCache({',
            '  resolve: {alias: {"@score": ' + json.dumps(str(self.root / 'apps/server/src/council/score.ts')) + '}},',
            '  test: {globals: true, include: ["apps/**/*.test.ts"], globalSetup: [' +
            json.dumps(str(selection.ROOT / 'scripts/vitest-temp-root.ts')) + ']}}));',
        ]))
        self.commit()
        base = self.head()
        self.git('update-ref', 'refs/remotes/origin/ci-base', base)
        self.write('apps/server/src/council/score.ts', 'export const score = 9;\n')
        self.commit()
        reports = self.root / 'reports'
        reports.mkdir()
        plan = selection.plan(self.root, self.environment())
        # The real Vitest executable is supplied by this checkout; the fixture has no installed packages of its own.
        environment = {**self.environment(), 'PATH': str(selection.ROOT / 'node_modules/.bin') + ':' + os.environ['PATH']}
        files = selection.discover(self.root, plan, environment, reports, config)
        self.assertEqual(files, ['apps/server/src/council/answers.test.ts', 'apps/web/src/alias.test.ts',
                                 'apps/web/src/card.test.ts', 'apps/web/src/lazy.test.ts'])


if __name__ == '__main__':
    unittest.main()
