/**
 * Every kind of connection with a page of its own (service-dashboards.md SD-S01): its page part, the read a page starts
 * early, what the 5-minute health pass keeps from it (the card's figures, the sidebar dot and points, SD-05, SD-S06),
 * what always asks first, and its buttons (SD-07, SD-S04). `page.ts`, `home/health.ts` and `actions.ts` read only this.
 */
import type { ThingPageTab } from '@whombat/core';
import type { TrackedFacts } from '../../changes/diff';
import type { CatalogConnectionRow } from '../../connections/types';
import type { ConnectionGlance } from '../../home/types';
import type { Services } from '../../services';
import type { MachineNow } from '../machine';
import { colours } from '../quiet/glance';
import type { ThingQuiet } from '../quiet/store';
import type { KindCheck, KindNotice } from '../quiet/types';
import type { MachineFigures } from '../runs-on';
import type { PageRange } from '../series';
import type { KindCtx, KindPage, KindView } from './types';

/** What the health pass keeps from a kind's read: the card's glance and the points to store (DS-11). */
export interface KindSeen {
  glance: Partial<ConnectionGlance> & Pick<ConnectionGlance, 'facts'>;
  points: Record<string, number | null>;
  /**
   * Its Worth a look as this pass read it (quiet-notices.md QN-11, QN-S*): the health pass works out the dot, the reason
   * and when an Ignore ends from these, not from `glance.status`. Absent (an older kind): the glance's status stands.
   */
  notices?: KindNotice[];
  /** Checks this pass couldn't read (an optional part not read, a capped list): an Ignore of them doesn't end now. */
  skipped?: string[];
  /**
   * The machine as this kind sees it, for its disk points (`disk_pct`, `disk_gb`): Home Assistant OS's Supervisor's
   * when Whombat doesn't watch its machine. Absent: the machine Whombat watches.
   */
  machine?: (m: MachineFigures | null) => MachineNow | null;
  /**
   * What can change and the change log compares between reads (docs/decisions/outside-changes.md): the service's
   * version, its devices' firmware, its proxy hosts or tunnel routes. Absent: the kind tracks nothing; a part null:
   * not read this time.
   */
  tracked?: TrackedFacts;
}

/** What a button sends (`things.action`, CT-1006): which row or entity, and the value of a switch or stepper. */
export interface KindActionInput {
  target?: string;
  value?: string | number | boolean;
  /**
   * Only from Put it back (service-settings.md SST-03), never from a client: the value the setting must still have, else
   * it was changed since and isn't put back.
   */
  expect?: string | number | boolean;
}

export interface KindActionCtx {
  services: Services;
  row: CatalogConnectionRow;
  now: Date;
  timeZone: string;
}

/**
 * A button's outcome: the toast's words, the change's title (“Approved *Dune: Part Two*”), and whether it is an
 * everyday switch kept out of Done recently (SD-08).
 */
export interface KindActionResult {
  message: string;
  title: string;
  everyday?: boolean;
  /** Nothing changed (the setting already had that value): no change is recorded. */
  unchanged?: boolean;
  /** The change was sent, but Whombat couldn't confirm it took: recorded without Undo and does not finish an undo. */
  uncertain?: boolean;
  /** The change's kind after `thing.` in place of the action's (`setting.remote_quality`, SST-03). */
  changeKind?: string;
  /** The change's detail: the old value in words (“4 Mbps”), for “… changed this yesterday from 4 Mbps.”. */
  detail?: string;
  /** How to put it back (SST-03): the same action with this target and value, while the setting is still `expect`. */
  undo?: Required<Pick<KindActionInput, 'value'>> & Pick<KindActionInput, 'target' | 'expect'>;
}

/** What a change would do, in Whombat's words for an approval card (SST-04): “Change a Plex setting”, its lines. */
export interface KindActionWords {
  title: string;
  lines: string[];
}

/**
 * Runs one button as the connection after the central checks (manages it, not Look only); checks its own target and
 * value against what it offers and throws an `ApiError` in plain words when they don't fit.
 */
export type KindAction = (ctx: KindActionCtx, input: KindActionInput) => Promise<KindActionResult>;

/** A kind's declared settings: its tab, its `setting` action, and the approval card's words. */
export interface KindSettings {
  name: string;
  tab: (ctx: KindCtx) => Promise<ThingPageTab>;
  action: KindAction;
  describe: (ctx: KindActionCtx, input: KindActionInput) => Promise<KindActionWords | null>;
}

export interface KindModule {
  page: KindPage;
  /** Started before what the connection runs on is known; the page part finds it in the cache. */
  prefetch?: (services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) => Promise<unknown>;
  /** The health pass's look (SD-05); usually `seenFromView` of a page-less read. */
  seen?: (
    services: Services,
    row: CatalogConnectionRow,
    now: Date,
    timeZone: string,
    quiet?: ThingQuiet,
  ) => Promise<KindSeen>;
  /** “… · locks and alarms ask first” in the head's access line. */
  asksFirst?: string;
  actions?: Record<string, KindAction>;
  /** The service's declared settings, wired into the page's tab, `setting` action, and approval card. */
  settings?: KindSettings;
  /** An action in Whombat's words before it runs (the assistant's approval card, SST-04); null: the generic words. */
  describe?: (ctx: KindActionCtx, action: string, input: KindActionInput) => Promise<KindActionWords | null>;
  /**
   * How long its live part (what plays, downloads, the queue) is kept, in seconds (SD-09, SD-S05): `liveRead` in
   * `read.ts` reads that part under its own key with this (default `LIVE_CACHE_MS`, 4 s); the rest stays 30 s.
   */
  liveS?: number;
  /**
   * The ranges its page offers when the service keeps its own history for a fixed window (Pi-hole's and AdGuard's
   * last 24 hours): the page is built over the first when another is asked, and one range hides the picker.
   */
  ranges?: readonly PageRange[];
  /**
   * The card's words when its check got no answer, from what else it can tell (a console that says it is resting);
   * absent or null: the generic “Couldn’t reach it”.
   */
  unanswered?: (services: Services, row: CatalogConnectionRow, now: Date) => Promise<string | null>;
  /** Every check it can raise, for What Whombat watches (QN-15), also while it raises none. */
  checks?: readonly KindCheck[];
  /**
   * What its `seen` glance's `activity` is about, for Settings → Screen (“Who’s watching”); absent for a kind with no
   * activity.
   */
  activityLine?: string;
}

const TONE_RANK = { info: 0, warn: 1, bad: 2 } as const;

/**
 * The card's glance from a kind's view (SD-05): its first `figures` figures as facts, the dot from Worth a look —
 * red for a bad line, yellow for a warn line, fine otherwise — with the worst line's badge or title as the reason.
 * Heads-ups never colour it (quiet-notices.md QN-02). The health pass works the dot out again from `KindSeen.notices`
 * with what is quiet (QN-S03); this is what a kind says before that.
 */
export function seenFromView(
  view: Pick<KindView, 'kpis' | 'notices'>,
  { figures = 3, line }: { figures?: number; line?: string } = {},
): KindSeen['glance'] {
  const facts = (view.kpis ?? []).slice(0, figures).map((k) => ({
    label: k.label,
    value: k.value,
    ...(k.rest ? { note: k.rest.slice(0, 80) } : {}),
  }));
  const worst = view.notices.filter(colours).sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone])[0];
  const status = worst?.tone === 'bad' ? 'bad' : worst?.tone === 'warn' ? 'warn' : 'ok';
  return {
    status,
    facts,
    ...(line ? { line } : {}),
    ...(status !== 'ok' && worst ? { reason: (worst.badge ?? worst.title).slice(0, 120) } : {}),
  };
}
