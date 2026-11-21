import type { BranchRoomSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { validateBranchSearch } from '../../app/routing/search';
import { parseShellLocation } from '../../app/shell/location';
import { branchRoomTarget, numbersRepeat, prHrefFor, repoParam, roomHref, roomRepo } from './prLinks';

function room(id: string, number: number, repo?: string, linkRepo = true): BranchRoomSummary {
  return {
    id,
    kind: 'branch',
    slug: id,
    title: `branch-${id}`,
    link: { type: 'pr', number, ...(repo && linkRepo ? { repo } : {}) },
    unread: 0,
    mentions: 0,
    memberCount: 2,
    prNumber: number,
    dmAgentId: null,
    lastMessageAt: null,
    branch: `branch-${id}`,
    prStatus: 'ready',
    dot: 'ok',
    ...(repo ? { repo } : {}),
  } as BranchRoomSummary;
}

const web = room('web', 1, 'whombat/web');
const infra = room('infra', 1, 'whombat/infra');
const billing = room('billing', 482, 'whombat/billing');

describe('branch rooms by repo and number (essentials item 5, AP-496)', () => {
  it('reads a room’s repo from the summary, else from its link', () => {
    expect(roomRepo(web)).toBe('whombat/web');
    expect(roomRepo({ ...web, repo: undefined } as BranchRoomSummary)).toBe('whombat/web');
    expect(roomRepo(room('old', 7))).toBeNull();
    expect(roomHref(web)).toBe('/pr/1?repo=whombat/web');
    expect(roomHref(room('old', 7))).toBe('/pr/7');
  });

  it('opens the asked repo, the only room with a number, or asks which when several repos share it', () => {
    const rooms = [billing, web, infra];
    expect(branchRoomTarget(rooms, 1, 'whombat/web')).toEqual({
      kind: 'open',
      repo: 'whombat/web',
      room: web,
    });
    expect(branchRoomTarget(rooms, 482, undefined)).toEqual({
      kind: 'open',
      repo: 'whombat/billing',
      room: billing,
    });
    const choose = branchRoomTarget(rooms, 1, undefined);
    expect(choose.kind).toBe('choose');
    // Sorted by repo, so the list reads the same every time.
    expect(choose.kind === 'choose' && choose.rooms.map((r) => r.id)).toEqual(['infra', 'web']);
    // Not in the sidebar (closed): the server decides.
    expect(branchRoomTarget(rooms, 9, undefined)).toEqual({ kind: 'open', repo: undefined, room: null });
    // An older runtime's rooms carry no repo: nothing to choose by, the first as before.
    const old = [room('a', 3), room('b', 3)];
    expect(branchRoomTarget(old, 3, undefined)).toEqual({ kind: 'open', repo: undefined, room: old[0] });
  });

  it('links a run’s PR by its repo when two repos share the number', () => {
    const rooms = [billing, web, infra];
    expect(prHrefFor(rooms, 482)).toBe('/pr/482?repo=whombat/billing');
    expect(prHrefFor(rooms, 1, 'whombat/infra')).toBe('/pr/1?repo=whombat/infra');
    expect(prHrefFor(rooms, 1)).toBe('/pr/1');
    expect(prHrefFor(rooms, 5, 'whombat/docs')).toBe('/pr/5?repo=whombat/docs');
    expect(numbersRepeat(rooms)).toBe(true);
    expect(numbersRepeat([billing, web])).toBe(false);
  });

  it('keeps ?repo= in the address only when it is owner/name, and the shell reads it', () => {
    expect(repoParam('whombat/web')).toBe('whombat/web');
    expect(repoParam('whombat')).toBeUndefined();
    expect(repoParam('a/b/c')).toBeUndefined();
    expect(validateBranchSearch({ repo: 'whombat/web', tab: 'files' })).toEqual({
      repo: 'whombat/web',
      tab: 'files',
    });
    expect(validateBranchSearch({ repo: 'not a repo' })).toEqual({});
    expect(parseShellLocation('/pr/1', { repo: 'whombat/web' })).toEqual({
      kind: 'pr',
      number: 1,
      repo: 'whombat/web',
    });
    expect(parseShellLocation('/pr/1')).toEqual({ kind: 'pr', number: 1 });
    expect(parseShellLocation('/runs/1907', { repo: 'whombat/web' })).toEqual({ kind: 'run', number: 1907 });
  });
});
