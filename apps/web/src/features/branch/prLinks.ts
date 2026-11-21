/**
 * Branch rooms by repository and number (Whombat essentials item 5; contracts CT-170; AP-496…): a PR number is unique
 * only within its repo, so `/pr/:number?repo=owner/name` names a room. Links without `repo` (older ones, older
 * runtimes) still open: the one room with that number, or — when several repos have one — a short list to pick from,
 * never a silent pick. Pure; the rooms are the bootstrap sidebar's.
 */
import { appPath } from '@whombat/client';
import { type BranchRoomSummary, RepoFullName } from '@whombat/core';

/** The room's repository: `BranchRoomSummary.repo`, else its link's (the runtime sets both, CT-170). */
export function roomRepo(room: Pick<BranchRoomSummary, 'link'> & { repo?: string }): string | null {
  if (room.repo) return room.repo;
  return room.link.type === 'pr' && room.link.repo ? room.link.repo : null;
}

/** `owner/name` from a URL's `?repo=`, or undefined when it isn't one. */
export function repoParam(value: unknown): string | undefined {
  return typeof value === 'string' && RepoFullName.safeParse(value).success ? value : undefined;
}

/** The app path of a branch room, with its repo when known: `/pr/1?repo=whombat/web`. */
export function roomHref(room: Pick<BranchRoomSummary, 'prNumber' | 'link'> & { repo?: string }): string {
  const repo = roomRepo(room);
  return appPath({ type: 'pr', number: room.prNumber ?? 0, ...(repo ? { repo } : {}) });
}

export type BranchRoomTarget =
  /** Ask the server for this number (and repo, when known). */
  | { kind: 'open'; repo: string | undefined; room: BranchRoomSummary | null }
  /** Several repos have a room with this number and the link didn't say which: ask. */
  | { kind: 'choose'; rooms: BranchRoomSummary[] };

/**
 * Which room `/pr/:number[?repo=]` opens (AP-496): the asked repo; else the only room with that number (its repo); else,
 * with more than one and their repos known, a choice. Rooms of an older runtime carry no repo, so they can't be told
 * apart: the server picks, as before.
 */
export function branchRoomTarget(
  rooms: readonly BranchRoomSummary[],
  number: number,
  repo: string | undefined,
): BranchRoomTarget {
  const same = rooms.filter((r) => r.prNumber === number);
  if (repo) return { kind: 'open', repo, room: same.find((r) => roomRepo(r) === repo) ?? null };
  if (same.length === 1) {
    const only = same[0] as BranchRoomSummary;
    return { kind: 'open', repo: roomRepo(only) ?? undefined, room: only };
  }
  if (same.length > 1 && same.every((r) => roomRepo(r)))
    return {
      kind: 'choose',
      rooms: [...same].sort((a, b) => (roomRepo(a) ?? '').localeCompare(roomRepo(b) ?? '')),
    };
  return { kind: 'open', repo: undefined, room: same[0] ?? null };
}

/**
 * The branch room of PR `number` for a link that knows only the number and maybe the repo's id (a run, an automation
 * step): the one room with that number, else the one whose repo is `repoId`'s, else the bare number (the room asks).
 */
export function prHrefFor(
  rooms: readonly BranchRoomSummary[],
  number: number,
  repoFullName?: string | null,
): string {
  const same = rooms.filter((r) => r.prNumber === number);
  if (repoFullName) {
    const room = same.find((r) => roomRepo(r) === repoFullName);
    return room ? roomHref(room) : appPath({ type: 'pr', number, repo: repoFullName });
  }
  if (same.length === 1) return roomHref(same[0] as BranchRoomSummary);
  return appPath({ type: 'pr', number });
}

/** Whether the sidebar has two rooms with one number: only then does a run's repo need looking up. */
export function numbersRepeat(rooms: readonly Pick<BranchRoomSummary, 'prNumber'>[]): boolean {
  const seen = new Set<number>();
  for (const r of rooms) {
    if (r.prNumber === null) continue;
    if (seen.has(r.prNumber)) return true;
    seen.add(r.prNumber);
  }
  return false;
}
