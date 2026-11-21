/**
 * A line of Worth a look as Whombat watches it (quiet-notices.md QN-01…QN-04, QN-11): its kind of line (`nature`), the
 * check and the item it is about, how an Ignore of it ends, and the server-only parts the health pass compares from one
 * pass to the next (`episode`, `band`, `confirm`). The wire's `ThingPageNotice` (contracts 0.122, CT-1060…) carries
 * `nature`, `check`, `subject`, `ignore` and `quiet`; `toWireNotice` (S0) drops the server-only parts.
 */
import type { ThingPageNotice } from '@whombat/core';

/** Problem: the assistant can look into it · Only you: only a person can act · Heads-up: information (QN-01). */
export type NoticeNature = 'problem' | 'you' | 'fyi';

/**
 * How an Ignore ends by itself (QN-11): `fixed` when the check saw it back to normal twice in a row, `newer` when the
 * line's `episode` changes (a newer version, another failure, a different set of items), `period` at `ignore.until`
 * (when the week or month resets). Any of them ends early when the line gets worse (a higher tone or `band`).
 */
export type QuietLifts = 'fixed' | 'newer' | 'period';

/** The item a line is about (QN-03): a stable id the reader keeps across reads, and its name as people know it. */
export interface NoticeSubject {
  /** At most 160 characters: `device:<UniFi id>`, `container:<environment>/<name>`, `invoice:<id>`. */
  id: string;
  /** At most 80 characters: “Hallway AP”. */
  name: string;
}

/** What Ignore does for a line (QN-10, QN-11). */
export interface NoticeIgnore {
  lifts: QuietLifts;
  /** When you'll hear again, at most 60 characters, a sentence: “Until it’s back online.”, “Until the week resets.” */
  words: string;
  /** `period` only: when it resets (ISO). */
  until?: string;
}

/** The parts every kind fills on every line from contracts 0.122 on (`KindView.notices`, `KindSeen.notices`). */
export interface NoticeWatch {
  nature: NoticeNature;
  /**
   * The check, stable across releases, `<kind>.<what>` in lower case with dots and underscores, at most 80 characters:
   * `unifi.device_offline`, `fusebox.week_runs_out`, `conn.answers`, `machine.disk`. The same id is a switch in
   * What Whombat watches (`KindModule.checks`).
   */
  check: string;
  /** The item, when the line is about one (absent: the whole thing). */
  subject?: NoticeSubject;
  /** Absent: the line can't be quieted (rare: a line that only explains another). */
  ignore?: NoticeIgnore;
  /** Server only: what `newer` compares (a version, a hash of the items of a grouped line, a week's reset). */
  episode?: string;
  /** Server only: a level within the tone that makes it worse when it rises (75, 90 for a disk). */
  band?: number;
  /** Server only: 2 when it colours the dot only after two health passes in a row (QN-04: reboots, reconnects). */
  confirm?: 2;
  /**
   * Server only: the head's badge and the card's reason when this is the worst active line and its title is too long
   * for them, at most 40 characters (“1 access point offline”). Absent: the title.
   */
  badge?: string;
  /**
   * Server only: the thing doesn't answer at all (`conn.answers` without an answer, a device that doesn't): when this is
   * the worst active line, the dot says offline rather than bad (QN-S06).
   */
  offline?: true;
}

/** A line as a kind makes it. */
export type KindNotice = ThingPageNotice & NoticeWatch;

/**
 * A line during the move (until every kind fills `NoticeWatch`): without `check` it can't be quieted and its nature is
 * `defaultNature`'s. The streams make every kind's lines `KindNotice`; the lead then narrows `KindView.notices`.
 */
export type LooseNotice = ThingPageNotice & Partial<NoticeWatch>;

/** One switch in What Whombat watches (QN-15): every check a kind can raise, also while it raises none. */
export interface KindCheck {
  check: string;
  /** Plain words, at most 80 characters: “Access points and switches going offline”. */
  name: string;
  nature: NoticeNature;
  /** Its lines are about one item each, so Stop watching can be for one item. */
  perItem: boolean;
  /**
   * Whombat watches it from the start. Only what is very important and what Whombat can act on or tell something useful
   * about starts on; the rest is off until someone turns it on (`docs/decisions/watch-defaults.md`).
   */
  startsOn: boolean;
}

/** The nature of a line from an older kind (or an older server): info a heads-up, an ask link a problem, else only you. */
export function defaultNature(n: Pick<ThingPageNotice, 'tone' | 'link'>): NoticeNature {
  if (n.tone === 'info') return 'fyi';
  return n.link?.kind === 'ask' ? 'problem' : 'you';
}
