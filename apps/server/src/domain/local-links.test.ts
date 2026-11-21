import { describe, expect, it } from 'vitest';
import { unlinkLocalPaths } from './local-links';

describe('unlinkLocalPaths (MS-L01)', () => {
  it('keeps the label of a link to a skill on the runner', () => {
    expect(
      unlinkLocalPaths(
        'Review is required by the [requesting-code-review skill](/var/lib/whombat-runner/tmp/whombat-runner-952-skills/skills-c5226d3534ec99cd691155e8/developer-craft/skills/requesting-code-review/SKILL.md): “the person who asked reviews it”.',
      ),
    ).toBe('Review is required by the requesting-code-review skill: “the person who asked reviews it”.');
  });

  it('unlinks file:// links, titled and angle-bracketed paths', () => {
    expect(unlinkLocalPaths('See [notes](file:///home/agent/work/notes.md).')).toBe('See notes.');
    expect(unlinkLocalPaths('[log](</tmp/run.log> "the log")')).toBe('log');
    expect(unlinkLocalPaths('[the build](/workspace/dist)')).toBe('the build');
  });

  it('shows the path as code when the label is empty', () => {
    expect(unlinkLocalPaths('[](/tmp/a.txt)')).toBe('`/tmp/a.txt`');
  });

  it("leaves web addresses and Whombat's own links", () => {
    const text =
      'Merged [PR #2](https://github.com/acme/johns-morphe-patches/pull/2); see [#general](/c/general), [Dusty](/agents/dusty) and [vars](/variables).';
    expect(unlinkLocalPaths(text)).toBe(text);
  });

  it('leaves inline code and fenced blocks as written', () => {
    const text = 'Run `[x](/tmp/x)` and\n```md\n[skill](/var/lib/x/SKILL.md)\n```\nthen [y](/tmp/y).';
    expect(unlinkLocalPaths(text)).toBe(
      'Run `[x](/tmp/x)` and\n```md\n[skill](/var/lib/x/SKILL.md)\n```\nthen y.',
    );
  });
});
