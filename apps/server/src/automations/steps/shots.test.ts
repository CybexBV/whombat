import { describe, expect, it } from 'vitest';
import { SHOTS_MAX, shotsBranch, shotsSection } from './shots';

const REPO = 'AcmeHQ/development';
const SHA = 'a'.repeat(40);

describe('shotsSection', () => {
  it('pairs before and after of each screen in one row, pictures from the commit', () => {
    const out = shotsSection(REPO, SHA, ['after-nl.png', 'before-en.png', 'after-en.png', 'before-nl.png']);
    const rows = (out ?? '').split('\n').filter((l) => l.startsWith('| en') || l.startsWith('| nl'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`/blob/${SHA}/before-en.png?raw=true`);
    expect(rows[0]).toContain('after-en.png');
    expect(rows[1]).toContain('before-nl.png');
  });

  it('is null without pictures, and leaves out folders and other files', () => {
    expect(shotsSection(REPO, SHA, [])).toBeNull();
    expect(shotsSection(REPO, SHA, ['README.md', 'notes.txt'])).toBeNull();
    expect(shotsSection(REPO, SHA, ['README.md', 'before.png'])).toContain('before.png');
  });

  it('shows a picture without a before or after on its own, and a lone side with an empty cell', () => {
    const out = shotsSection(REPO, SHA, ['overview.png', 'after-panel.png']) ?? '';
    expect(out).toContain('overview.png');
    expect(out).toMatch(/\| panel \| {2}\| <img [^|]*after-panel\.png/);
  });

  it('shows at most SHOTS_MAX pictures', () => {
    const names = Array.from({ length: 20 }, (_, i) => [`before-s${i}.png`, `after-s${i}.png`]).flat();
    expect((shotsSection(REPO, SHA, names) ?? '').match(/<img /g)).toHaveLength(SHOTS_MAX);
  });

  it('keeps file names out of the markup they could break', () => {
    const out = shotsSection(REPO, SHA, ['before-a|b"<x>.png']) ?? '';
    expect(out).not.toContain('"<x>');
    expect(out).toContain(encodeURIComponent('before-a|b"<x>.png'));
  });

  it('names the screenshots branch after the fix branch', () => {
    expect(shotsBranch('feat/tracker-2-22')).toBe('pr-shots/feat/tracker-2-22');
  });
});
