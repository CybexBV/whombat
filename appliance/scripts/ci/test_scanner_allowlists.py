"""The secret scanners' allowlists name the vendored contracts release (python3 -I -m unittest discover -s scripts/ci)."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ScannerAllowlists(unittest.TestCase):
    def test_the_scanners_allow_the_vendored_contracts_tarballs(self):
        # The harness vendors one contracts release's tarballs, whose conformance vectors hold made-up JWTs and URLs
        # with a password. Both allowlists name that release's tarballs one by one; when the harness moves to another
        # release they must move with it, or public CI's secret scan stops (it did at 3.1.0 → 3.21.0 and 3.21.0 → 4.0.0).
        vendored = sorted(p.relative_to(ROOT).as_posix()
                          for p in (ROOT / 'harness/vendor/whombat-contracts').glob('*/whombat-contracts-*.tar.gz'))
        self.assertTrue(vendored)
        gitleaks = (ROOT / '.gitleaks.toml').read_text()
        trufflehog = (ROOT / '.trufflehog-exclude.txt').read_text()
        for rules, name in [(re.findall(r"'''(.+?)'''", gitleaks), '.gitleaks.toml'),
                            ([line for line in trufflehog.splitlines() if line and not line.startswith('#')],
                             '.trufflehog-exclude.txt')]:
            for path in vendored:
                self.assertTrue(any(re.search(rule, path) for rule in rules), f"{name} doesn't allow {path}")


if __name__ == '__main__':
    unittest.main()
