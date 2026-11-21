#!/usr/bin/env python3
"""The secret scanners' allowlists for appliance/ and hosts/, in the repository's own two files.

    python3 -I scripts/ci/scanner_allowlists.py --check    fails when a block is out of date
    python3 -I scripts/ci/scanner_allowlists.py --write    writes both blocks again

gitleaks and trufflehog read one allowlist each, at the repository's root (`.gitleaks.toml`,
`.trufflehog-exclude.txt`). The two folders keep their own (`appliance/.gitleaks.toml` and so on), with paths as seen
from the folder. This puts every entry of theirs into a marked block of the root files, with the folder in front of
each path, so a file reviewed there is not reported here. An allowlist of theirs that names values instead of paths
applies only inside its folder.

Never edit a block by hand: change the folder's file and run this with --write.
Python 3.11 standard library only.
"""
import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FOLDERS = ('appliance', 'hosts')
BEGIN = '# >>> appliance/ and hosts/: written by scripts/ci/scanner_allowlists.py from the folders’ own lists'
END = '# <<< appliance/ and hosts/'


def prefixed(folder: str, pattern: str) -> str:
    """A folder's path pattern as seen from the root. Every one of theirs starts at the folder (`^`)."""
    if not pattern.startswith('^'):
        raise SystemExit(f'{folder}: the path pattern {pattern!r} does not start with ^, so it has no one place '
                         'under the root')
    return f'^{folder}/{pattern[1:]}'


def literal(pattern: str) -> str:
    if "'''" in pattern:
        raise SystemExit(f"a pattern holds ''' and cannot be written as a TOML literal: {pattern!r}")
    return f"'''{pattern}'''"


def gitleaks_block(root: Path) -> str:
    out = []
    for folder in FOLDERS:
        path = root / folder / '.gitleaks.toml'
        if not path.is_file():
            continue
        config = tomllib.loads(path.read_text())
        extra = sorted(set(config) - {'extend', 'allowlists', 'title'})
        if extra:
            raise SystemExit(f'{folder}/.gitleaks.toml has parts this script does not carry over: {", ".join(extra)}')
        for entry in config.get('allowlists', []):
            unknown = sorted(set(entry) - {'description', 'paths', 'regexes', 'regexTarget'})
            if unknown:
                raise SystemExit(f'{folder}/.gitleaks.toml: an allowlist has fields this script does not carry over: '
                                 f'{", ".join(unknown)}')
            lines = ['[[allowlists]]', f'description = {json.dumps(folder + "/: " + entry.get("description", ""), ensure_ascii=False)}']
            if entry.get('regexes'):
                # Values, not paths: allowed only in this folder's files.
                if entry.get('paths'):
                    raise SystemExit(f'{folder}/.gitleaks.toml: an allowlist with both paths and regexes')
                lines.append('condition = "AND"')
                if 'regexTarget' in entry:
                    lines.append(f'regexTarget = {json.dumps(entry["regexTarget"])}')
                lines.append('regexes = [' + ', '.join(literal(r) for r in entry['regexes']) + ']')
                lines.append(f"paths = ['''^{folder}/''']")
            else:
                lines.append('paths = [')
                lines += [f'  {literal(prefixed(folder, p))},' for p in entry.get('paths', [])]
                lines.append(']')
            out.append('\n'.join(lines))
    return '\n\n'.join(out)


def trufflehog_block(root: Path) -> str:
    out = []
    for folder in FOLDERS:
        path = root / folder / '.trufflehog-exclude.txt'
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            if line.strip() and not line.startswith('#'):
                out.append(prefixed(folder, line))
    return '\n'.join(out)


def with_block(text: str, block: str) -> str:
    """The file's text with its marked block, which goes last, replaced (or taken out when there is nothing for it)."""
    pattern = re.compile(r'\n*' + re.escape(BEGIN) + r'\n.*?' + re.escape(END) + r'\n', re.S)
    rest = pattern.sub('\n', text).rstrip('\n') + '\n'
    return f'{rest}\n{BEGIN}\n{block}\n{END}\n' if block else rest


def planned(root: Path) -> dict[Path, str]:
    files = {root / '.gitleaks.toml': gitleaks_block(root), root / '.trufflehog-exclude.txt': trufflehog_block(root)}
    return {path: with_block(path.read_text(), block) for path, block in files.items()}


def main(argv: list[str]) -> int:
    if argv not in (['--check'], ['--write']):
        print(__doc__, file=sys.stderr)
        return 2
    stale = [path for path, text in planned(ROOT).items() if path.read_text() != text]
    if argv == ['--write']:
        for path, text in planned(ROOT).items():
            path.write_text(text)
        print(f'scanner allowlists: {len(stale)} file(s) written again' if stale else 'scanner allowlists: up to date')
        return 0
    for path in stale:
        print(f'{path.name}: its block for appliance/ and hosts/ is out of date: run '
              'python3 -I scripts/ci/scanner_allowlists.py --write', file=sys.stderr)
    return 1 if stale else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
