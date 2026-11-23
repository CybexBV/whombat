/**
 * Servers on the phone (Whombat one-whombat.md ONE-11…ONE-13; one-whombat-mobile.md AP-1363…AP-1367): the phone's own
 * parts — the Guests list and whether power buttons show; a server's Summary is
 * `serverDashboard` (dashboards-mobile.md AP-2127). What web and phone share — status words, a guest's kind and state
 * words, its power actions and their questions, the note after one — is `@whombat/client/hosts` (AP-1372), and a
 * guest's own screen is `@whombat/client/hosts/mobile` (AP-1485…). Pure; the screens are `screens/ServerScreen.tsx`
 * and `screens/GuestScreen.tsx` (Connections' Servers rows are `data/homeServers.ts`).
 */
import {
  GUEST_STATE_WORDS,
  type GuestKindView,
  guestKind,
  guestStateTone,
  shownGuests,
  splitTemporary,
  TEMPORARY_WORDS,
  type Verdict,
} from '@whombat/client/hosts';
import {
  HOST_STATUS_LABELS,
  type HostGuest,
  type HostGuestState,
  type HostRemoteControl,
  type HostServerStatus,
  type ThingStatus,
} from '@whombat/core';

export const SERVER_COPY = {
  summary: 'Summary',
  guests: 'Guests',
  backups: 'Backups',
  /** An Unraid server's (incus-unraid-mobile.md AP-1634). */
  array: 'Array',
  plugins: 'Plugins',
  /** A Mac's (macos-servers.md MAC-34). */
  screen: 'Screen',
  noGuests: 'Nothing runs on this server.',
  guestsFailed: 'This list didn’t load.',
  /** The fold at the foot of the Summary: versions, processor, address, helper, storage and pools. */
  technical: 'Technical details',
  failed: 'This server didn’t load.',
  absent: 'Servers aren’t set up on this Whombat.',
  ask: (name: string) => `Ask about ${name}`,
  powerOff: 'Power control is off for this server.',
  cancel: 'Cancel',
} as const;

const DASH = '—';

/** A server's status as a thing's (its dot): `pending` is not checked yet. */
export function serverThingStatus(status: HostServerStatus): ThingStatus {
  return status === 'pending' ? 'unknown' : status;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v)}%`);
const num = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? DASH : v.toFixed(v >= 100 || digits === 0 ? 0 : digits).replace(/\.0$/, '');

/** A verdict's dot: its tone, waiting as no tone. */
export function verdictDot(v: Pick<Verdict, 'tone'>): 'ok' | 'warn' | 'bad' | null {
  return v.tone === 'mut' ? null : v.tone;
}

/* Guests ------------------------------------------------------------------------------------------------------------ */

/**
 * A server's list of machines and apps on the phone: temporary machines (CI jobs, sandboxes) left out until asked for,
 * with the row that brings them back (“5 temporary machines hidden”, Show) — the same rule as the web's.
 */
export interface ServerGuestList {
  rows: GuestRowView[];
  /** The quiet row's words and button; null when there are none. */
  temporary: { text: string; button: string } | null;
}

export function serverGuestList(guests: readonly HostGuest[], showTemporary: boolean): ServerGuestList {
  const { shown } = shownGuests(guests, showTemporary);
  const count = splitTemporary(guests).temporary.length;
  return {
    rows: guestRows(shown),
    temporary: count
      ? {
          text: showTemporary ? TEMPORARY_WORDS.shown(count) : TEMPORARY_WORDS.hidden(count),
          button: showTemporary ? TEMPORARY_WORDS.hide : TEMPORARY_WORDS.show,
        }
      : null,
  };
}

/** A guest's dot: the shared state tone, `mut` (stopped) as no tone. */
function rowTone(state: HostGuestState): 'ok' | 'warn' | 'bad' | null {
  const tone = guestStateTone(state);
  return tone === 'mut' ? null : tone;
}

export interface GuestRowView {
  id: string;
  guest: HostGuest;
  name: string;
  /**
   * What it is, drawn as a mark before the name (less-is-more.md AP-1755, AP-1810): Docker's, Linux Containers' or a
   * screen; its words (“Incus VM”, “Proxmox VM 118”) are only in `label`, Proxmox's number shown muted after the name.
   */
  kind: GuestKindView;
  /** `CPU 4% · 2.1 of 8 GB`; `ci-platform · update ready` (IU-05): no kind words, the mark says it. */
  meta: string;
  /** The guest this Whombat runs in: its row carries “This Whombat” (IU-02). */
  self: boolean;
  stateText: string;
  tone: 'ok' | 'warn' | 'bad' | null;
  label: string;
}

const memText = (usedMb: number | null, limitMb: number | null) => {
  if (usedMb == null) return null;
  const gb = (mb: number) => num(mb / 1024);
  return limitMb ? `${gb(usedMb)} of ${gb(limitMb)} GB` : `${gb(usedMb)} GB`;
};

/**
 * The Guests list (AP-1365): running and unhealthy first, then paused, then stopped; by name within each. No tags in
 * the list (Whombat connections-page.md CN-08, AP-2562): they are on the guest's page.
 */
export function guestRows(guests: readonly HostGuest[]): GuestRowView[] {
  const rank: Record<HostGuestState, number> = { unhealthy: 0, running: 1, paused: 2, stopped: 3 };
  return [...guests]
    .sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
    .map((g) => {
      const on = g.state === 'running' || g.state === 'unhealthy';
      const kind = guestKind(g);
      const meta = [
        g.platform === 'incus' && g.project && g.project !== 'default' ? g.project : null,
        on ? `CPU ${pct(g.cpuPct)}` : null,
        on ? memText(g.memoryUsedMb, g.memoryLimitMb) : null,
        g.platform === 'docker' && g.updateAvailable ? 'update ready' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const stateText = GUEST_STATE_WORDS[g.state];
      const self = !!g.self;
      return {
        id: g.id,
        guest: g,
        name: g.name,
        kind,
        meta,
        self,
        stateText,
        tone: rowTone(g.state),
        label: [g.name, kind.label, self ? 'This Whombat' : null, stateText, meta || null]
          .filter(Boolean)
          .join(', '),
      };
    });
}

/**
 * Whether power buttons show (AP-1366), and the sentence when they don't: the server lets power through (the hub's and
 * the agent's switch). Offline guests' servers can't be reached either.
 */
export function canPower(
  rc: Pick<HostRemoteControl, 'power' | 'powerReason'> | null | undefined,
  serverOnline = true,
): { ok: true } | { ok: false; reason: string } {
  if (!serverOnline) return { ok: false, reason: HOST_STATUS_LABELS.offline };
  if (rc && !rc.power) return { ok: false, reason: rc.powerReason?.trim() || SERVER_COPY.powerOff };
  return { ok: true };
}
