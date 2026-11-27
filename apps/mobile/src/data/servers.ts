/**
 * Servers on the phone (Whombat one-whombat.md ONE-11…ONE-13; one-whombat-mobile.md AP-1363…AP-1367): the phone's own
 * parts — the Guests list and whether power buttons show; a server's Summary is
 * `serverDashboard` (dashboards-mobile.md AP-2127). What web and phone share — status words, a guest's kind and state
 * words, its power actions and their questions, the note after one — is `@whombat/client/hosts` (AP-1372), and a
 * guest's own screen is `@whombat/client/hosts/mobile` (AP-1485…). Pure; the screens are `screens/ServerScreen.tsx`
 * and `screens/GuestScreen.tsx` (Connections' Servers rows are `data/homeServers.ts`).
 */

import {
  type GuestKindView,
  guestKind,
  guestStateTone,
  guestStateWords,
  shownGuests,
  splitTemporary,
  temporaryWords,
  type Verdict,
} from '@whombat/client/hosts';
import {
  type HostGuest,
  type HostGuestState,
  type HostRemoteControl,
  type HostServerStatus,
  hostStatusLabels,
  type ThingStatus,
} from '@whombat/core';
import { formatLocaleOf } from '@whombat/core/i18n';
import { mobileTranslator } from '../i18n/translate';

export function serverCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    summary: t('servers.serverCopy.summary'),
    guests: t('servers.serverCopy.guests'),
    backups: t('servers.serverCopy.backups'),
    /** An Unraid server's (incus-unraid-mobile.md AP-1634). */
    array: t('servers.serverCopy.array'),
    plugins: t('servers.serverCopy.plugins'),
    /** A Mac's (macos-servers.md MAC-34). */
    screen: t('servers.serverCopy.screen'),
    /** A Mac's Find My, on a Whombat from before Find My was a connection (findmy-connection.md). */
    findmy: t('servers.serverCopy.findmy'),
    noGuests: t('servers.serverCopy.noGuests'),
    guestsFailed: t('servers.serverCopy.guestsFailed'),
    /** The fold at the foot of the Summary: versions, processor, address, helper, storage and pools. */
    technical: t('servers.serverCopy.technical'),
    failed: t('servers.serverCopy.failed'),
    absent: t('servers.serverCopy.absent'),
    ask: (name: string) => t('servers.serverCopy.ask', { name }),
    powerOff: t('servers.serverCopy.powerOff'),
    cancel: t('servers.serverCopy.cancel'),
  } as const;
}
export const SERVER_COPY = serverCopy();

const DASH = '—';

/** A server's status as a thing's (its dot): `pending` is not checked yet. */
export function serverThingStatus(status: HostServerStatus): ThingStatus {
  return status === 'pending' ? 'unknown' : status;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v)}%`);
const num = (v: number | null | undefined, locale?: string) =>
  v === null || v === undefined
    ? DASH
    : new Intl.NumberFormat(formatLocaleOf(locale), {
        maximumFractionDigits: v >= 100 ? 0 : 1,
        useGrouping: false,
      }).format(v);

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

export function serverGuestList(
  guests: readonly HostGuest[],
  showTemporary: boolean,
  locale?: string,
): ServerGuestList {
  const { shown } = shownGuests(guests, showTemporary);
  const count = splitTemporary(guests).temporary.length;
  const words = temporaryWords(locale);
  return {
    rows: guestRows(shown, locale),
    temporary: count
      ? {
          text: showTemporary ? words.shown(count) : words.hidden(count),
          button: showTemporary ? words.hide : words.show,
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

const memText = (usedMb: number | null, limitMb: number | null, locale?: string) => {
  if (usedMb == null) return null;
  const gb = (mb: number) => num(mb / 1024, locale);
  return limitMb
    ? mobileTranslator(locale).t('data.servers.memOf', { used: gb(usedMb), limit: gb(limitMb) })
    : `${gb(usedMb)} GB`;
};

/**
 * The Guests list (AP-1365): running and unhealthy first, then paused, then stopped; by name within each. No tags in
 * the list (Whombat connections-page.md CN-08, AP-2562): they are on the guest's page.
 */
export function guestRows(guests: readonly HostGuest[], locale?: string): GuestRowView[] {
  const { t } = mobileTranslator(locale);
  const states = guestStateWords(locale);
  const rank: Record<HostGuestState, number> = { unhealthy: 0, running: 1, paused: 2, stopped: 3 };
  return [...guests]
    .sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
    .map((g) => {
      const on = g.state === 'running' || g.state === 'unhealthy';
      const kind = guestKind(g, locale);
      const meta = [
        g.platform === 'incus' && g.project && g.project !== 'default' ? g.project : null,
        on ? `CPU ${pct(g.cpuPct)}` : null,
        on ? memText(g.memoryUsedMb, g.memoryLimitMb, locale) : null,
        g.platform === 'docker' && g.updateAvailable ? t('data.servers.updateReady') : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const stateText = states[g.state];
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
        label: [g.name, kind.label, self ? t('data.servers.thisWhombat') : null, stateText, meta || null]
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
  locale?: string,
): { ok: true } | { ok: false; reason: string } {
  if (!serverOnline) return { ok: false, reason: hostStatusLabels(locale).offline };
  if (rc && !rc.power) return { ok: false, reason: rc.powerReason?.trim() || serverCopy(locale).powerOff };
  return { ok: true };
}
