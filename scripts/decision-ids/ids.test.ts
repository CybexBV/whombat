import { describe, expect, it } from 'vitest';
import { checkout, compare, rangeIds, readBaseline, scan, type Tree } from './ids';

/** A small tree: files with their contents. */
function tree(files: Record<string, string>): Tree {
  return { files: Object.keys(files), read: (path) => files[path] ?? '' };
}

describe('decision ids (decision-ids.md)', () => {
  it('finds an id defined in two decision files, and one cited in code that no doc mentions', () => {
    const findings = scan(
      tree({
        'docs/decisions/a.md': '| ZQ-01 | One. | Why. |\n| ZQ-02 | Two. | Why. |\n',
        'docs/app/decisions/b.md': '## ZQ-02 Also two\n\nSee ZQ-03…ZQ-05.\n',
        'docs/decisions/archive/old.md': '| ZQ-01 | Old. | Gone. |\n',
        'apps/server/src/x.ts': '// ZQ-01, ZQ-04, ZQ-04b, ZQ-09, and UTF-8 or SHA-256 are no decisions\n',
      }),
    );
    expect(findings).toEqual({ clashes: ['ZQ-02'], unresolved: ['ZQ-09'] });
  });

  it('spans a range with its letters and zeros', () => {
    expect(rangeIds('HE-S08', 'HE-S10')).toEqual(['HE-S08', 'HE-S09', 'HE-S10']);
    expect(rangeIds('DK-60', 'CT-62')).toEqual([]);
  });

  // The public copy leaves the decision files out, so the ids there can't be looked up and the baseline, made from
  // the full tree, doesn't describe it.
  const here = checkout();
  const hasDecisionFiles = here.files.some((path) => path.startsWith('docs/decisions/'));

  it.skipIf(!hasDecisionFiles)(
    'adds nothing to what the baseline lists, and the baseline lists nothing fixed',
    () => {
      const { added, fixed } = compare(scan(here), readBaseline());
      // New clashes: give the new decisions a prefix of their own. Unresolved: cite an id the docs have, or none
      // (CLAUDE.md: new code cites no decision codes). Fixed: remove them from baseline.json (`pnpm decision-ids`).
      expect(added).toEqual({ clashes: [], unresolved: [] });
      expect(fixed).toEqual({ clashes: [], unresolved: [] });
    },
  );
});
