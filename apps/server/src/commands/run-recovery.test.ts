/**
 * What the runner could not do, as people read it (run-checkout.md RC-09; resourceful-agents.md RA-DS55): one period,
 * never two, and the runner's own “could not check out” not said twice.
 */
import { describe, expect, it } from 'vitest';
import { asSentence, workspaceProblemLines } from './run-recovery';

describe('workspaceProblemLines', () => {
  it('reads a checkout problem once, and keeps the reason’s own period', () => {
    const [line] = workspaceProblemLines([
      {
        step: 'checkout',
        message:
          'could not check out acme/whombat-website@feat/fb-nrzj-x1fz-house-rules-accents: Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it).',
      },
    ]);
    expect(line).toBe(
      'Whombat couldn’t check out acme/whombat-website@feat/fb-nrzj-x1fz-house-rules-accents: Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it).',
    );
    expect(asSentence(line as string)).toBe(line);
  });

  it('other steps keep their words, and get a period only when they have none', () => {
    const lines = workspaceProblemLines([
      { step: 'push', message: 'GitHub refused the push' },
      { step: 'land', message: 'feat/x moved in the clone.' },
    ]);
    expect(lines).toEqual([
      'Whombat couldn’t push my commits: GitHub refused the push',
      'Whombat couldn’t put my commits in the clone: feat/x moved in the clone.',
    ]);
    expect(lines.map(asSentence)).toEqual([
      'Whombat couldn’t push my commits: GitHub refused the push.',
      'Whombat couldn’t put my commits in the clone: feat/x moved in the clone.',
    ]);
    expect(asSentence('Is it there?')).toBe('Is it there?');
  });
});
