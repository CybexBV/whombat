/** Which commit a review of T3 Code's work says it approved (report-trackers.md TA-57). */
import { describe, expect, it } from 'vitest';
import { namedCommit, sameCommit } from './observe';

describe('the commit a review names', () => {
  it('is the hex id on the verdict’s own line', () => {
    expect(namedCommit(['Approve — reviewed 8c94527.\n\nIt checked 1209c71 on main too.'])).toBe('8c94527');
    expect(namedCommit(['Some notes first.', 'Changes needed (3bcb170): one case is left.'])).toBe('3bcb170');
    // “reviewed …” names it even when it has only digits.
    expect(namedCommit(['Approve — reviewed 1234567'])).toBe('1234567');
    expect(namedCommit(['Approve — reviewed `8C94527`.'])).toBe('8c94527');
  });

  it('is none when the verdict’s line names no commit, or there is no verdict', () => {
    expect(namedCommit(['Approve.\n\nThe review found nothing; it read 8c94527.'])).toBeNull();
    expect(namedCommit(['Reviewed 8c94527 and it looks fine.'])).toBeNull();
    // A plain number on the verdict's line isn't a commit.
    expect(namedCommit(['Approve: 2026110912 tests pass.'])).toBeNull();
    expect(namedCommit([])).toBeNull();
  });

  it('is an id of digits alone when the line presents it as the commit', () => {
    expect(namedCommit(['Changes needed — `701385852`'])).toBe('701385852');
    expect(namedCommit(['Approve, see `701385852` for the fix.'])).toBe('701385852');
    expect(namedCommit(['Approve 701385852'])).toBe('701385852');
    expect(namedCommit(['Changes needed — 701385852'])).toBe('701385852');
    expect(namedCommit(['Changes needed — 701385852: one case is left.'])).toBe('701385852');
    expect(namedCommit(['Approve: commit 7013858'])).toBe('7013858');
    expect(namedCommit(['**Approve** (at 7013858).'])).toBe('7013858');
    expect(namedCommit(['> Approve — 7013858'])).toBe('7013858');
  });

  it('keeps the forms that already named a commit', () => {
    expect(namedCommit(['Changes needed `3ea45072d`'])).toBe('3ea45072d');
    expect(namedCommit(['Approve — 8c94527fb1c624336cfabe7ba406560bcd0493b6'])).toBe(
      '8c94527fb1c624336cfabe7ba406560bcd0493b6',
    );
  });

  it('prefers “reviewed”, then backticks, then the id after the verdict', () => {
    expect(namedCommit(['Approve 1111111 — reviewed 2222222, see `3333333`'])).toBe('2222222');
    expect(namedCommit(['Approve 1111111 — see `3333333`'])).toBe('3333333');
    expect(namedCommit(['Approve 1111111, it also touches abc1234'])).toBe('1111111');
  });

  it('is no bare number elsewhere on the verdict’s line', () => {
    expect(namedCommit(['Approve — 2 of 1234567 tests failed'])).toBeNull();
    expect(namedCommit(['Changes needed, see PR #1234567'])).toBeNull();
    expect(namedCommit(['Approve — 1234567 tests pass'])).toBeNull();
  });

  it('matches a short id against the full head', () => {
    expect(sameCommit('8c94527', '8c94527fb1c624336cfabe7ba406560bcd0493b6')).toBe(true);
    expect(sameCommit('8C94527', '8c94527fb1c624336cfabe7ba406560bcd0493b6')).toBe(true);
    expect(sameCommit('1209c71', '8c94527fb1c624336cfabe7ba406560bcd0493b6')).toBe(false);
  });
});
