import { bootstrap } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { unreadTitle, unreadTotals } from './unread';

const world = bootstrap();
const zero = <S extends { unread: number; mentions: number }>(s: S): S => ({ ...s, unread: 0, mentions: 0 });
const quiet = {
  branchRooms: world.sidebar.branchRooms.map(zero),
  dms: world.sidebar.dms.map(zero),
};

describe('unreadTotals (AP-98)', () => {
  it('is zero and not unread when everything is read', () => {
    expect(unreadTotals(quiet)).toEqual({ count: 0, any: false });
  });

  it('counts unread messages in the person’s rooms and branch rooms’ mentions, not their plain traffic', () => {
    const [r0] = quiet.branchRooms;
    const [d0] = quiet.dms;
    if (!r0 || !d0) throw new Error('fixture world changed');
    const sidebar = {
      branchRooms: [{ ...r0, unread: 7, mentions: 2 }],
      dms: [{ ...d0, unread: 4 }, ...quiet.dms.slice(1)],
    };
    expect(unreadTotals(sidebar)).toEqual({ count: 6, any: true });
  });

  it('still counts a branch room’s mentions without a sidebar row for it (docs/decisions/settings-simplify.md SS-20)', () => {
    const [r0] = quiet.branchRooms;
    if (!r0) throw new Error('fixture world changed');
    expect(unreadTotals({ ...quiet, branchRooms: [{ ...r0, unread: 5, mentions: 1 }] })).toEqual({
      count: 1,
      any: true,
    });
  });

  it('shows a dot for a branch room’s traffic alone', () => {
    const [r0] = quiet.branchRooms;
    if (!r0) throw new Error('fixture world changed');
    expect(unreadTotals({ ...quiet, branchRooms: [{ ...r0, unread: 2 }] })).toEqual({ count: 0, any: true });
  });
});

describe('unreadTitle', () => {
  it('prefixes the count and caps it', () => {
    expect(unreadTitle(0)).toBe('Whombat');
    expect(unreadTitle(3)).toBe('(3) Whombat');
    expect(unreadTitle(120)).toBe('(99+) Whombat');
  });
});
