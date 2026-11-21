"""The root allowlists carry the folders' own (python3 -I -m unittest discover -s scripts/ci -p 'test_scanner_allowlists.py')."""

import re
import shutil
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scanner_allowlists as lists  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


class ScannerAllowlists(unittest.TestCase):
    def tree(self, files):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        for name, text in files.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(text)
        return root

    def test_the_committed_blocks_are_what_the_folders_lists_give(self):
        # A copy of appliance/ or hosts/ that changed its allowlist without the root's being written again would make
        # public CI's secret scan report files the folder already reviewed.
        for path, text in lists.planned(ROOT).items():
            self.assertEqual(path.read_text(), text, f'{path.name}: run scripts/ci/scanner_allowlists.py --write')
        tomllib.loads((ROOT / '.gitleaks.toml').read_text())

    def test_a_folders_paths_get_the_folder_in_front(self):
        root = self.tree({
            'appliance/.gitleaks.toml': "[extend]\nuseDefault = true\n[[allowlists]]\ndescription = \"tests\"\n"
                                        "paths = ['''^harness/a\\.ts$''']\n",
            'hosts/.trufflehog-exclude.txt': '# a comment\n^internal/b_test\\.go$\n',
        })
        gitleaks = tomllib.loads(lists.gitleaks_block(root))
        self.assertEqual(gitleaks['allowlists'][0]['paths'], [r'^appliance/harness/a\.ts$'])
        self.assertEqual(lists.trufflehog_block(root), r'^hosts/internal/b_test\.go$')
        self.assertTrue(re.search(gitleaks['allowlists'][0]['paths'][0], 'appliance/harness/a.ts'))

    def test_a_folders_allowed_values_stay_inside_the_folder(self):
        root = self.tree({
            'hosts/.gitleaks.toml': "[[allowlists]]\ndescription = \"a public value\"\nregexTarget = \"match\"\n"
                                    "regexes = ['''^ABC$''']\n",
        })
        entry = tomllib.loads(lists.gitleaks_block(root))['allowlists'][0]
        self.assertEqual((entry['condition'], entry['paths'], entry['regexes'], entry['regexTarget']),
                         ('AND', ['^hosts/'], ['^ABC$'], 'match'))

    def test_what_it_cannot_carry_over_stops_it(self):
        for text in ("[[rules]]\nid = \"x\"\n", "[[allowlists]]\npaths = ['''harness/''']\n",
                     "[[allowlists]]\ncommits = ['abc']\n"):
            with self.assertRaises(SystemExit):
                lists.gitleaks_block(self.tree({'appliance/.gitleaks.toml': text}))

    def test_the_block_is_replaced_in_place_and_goes_with_the_folders(self):
        once = lists.with_block('kept = 1\n', 'a')
        self.assertTrue(once.startswith('kept = 1\n'))
        self.assertEqual(lists.with_block(once, 'a'), once)
        self.assertIn('\nb\n', lists.with_block(once, 'b'))
        self.assertNotIn('\na\n', lists.with_block(once, 'b'))
        self.assertEqual(lists.with_block('kept = 1\n', ''), 'kept = 1\n')


if __name__ == '__main__':
    unittest.main()
