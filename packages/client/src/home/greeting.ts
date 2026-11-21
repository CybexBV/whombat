/**
 * Home's first lines (mock 1; one-whombat.md ONE-05; app one-whombat-shell.md AP-1265): “Good afternoon, John” and one
 * plain sentence about how things are, true to the worst of them (status-line.md): “All good. I fixed 1 thing
 * overnight.”, “**2 things need you**, and I’m adding your Daikin heat pump.”, “**The disk array on blackbox has
 * failed.** I’m looking into it.” Pure; web and phone share it.
 */
import type { DoneTodayItem, HomeChat, HomeOverview, NeedsYouItem, ThingSummary } from '@whombat/core';
import { zonedParts } from '@whombat/core/text';

/** By the local hour: morning from 05:00, afternoon from 12:00, evening from 18:00 (and through the night). */
export function greetingFor(now: Date | number, timeZone: string): string {
  const { hour } = zonedParts(now, timeZone);
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** `Good afternoon, John`: the person's first name, or the greeting alone. */
export function homeGreeting(name: string | null | undefined, now: Date | number, timeZone: string): string {
  const first = name?.trim().split(/\s+/)[0];
  const greeting = greetingFor(now, timeZone);
  return first ? `${greeting}, ${first}` : greeting;
}

/** A piece of the status sentence; `strong` pieces are set in the ink colour at 600 (the mock's `<b>`). */
export interface StatusPart {
  text: string;
  strong?: boolean;
}

/**
 * What Whombat is doing, as it would say it: a title that starts with a verb in -ing (“Adding your Daikin heat pump”)
 * becomes “I’m adding your Daikin heat pump”; any other “I’m working on Night-time heating”.
 */
export function workingPhrase(title: string): string {
  const t = title.trim();
  const first = t.split(/\s+/)[0] ?? '';
  if (/^[A-Z][a-z]+ing$/.test(first)) return `I’m ${first.toLowerCase()}${t.slice(first.length)}`;
  return `I’m working on ${t}`;
}

/** How the status sentence's dot reads: all good, something needs the person or is watched, something is wrong. */
export type StatusTone = 'ok' | 'warn' | 'bad';

/** The status sentence and its tone (`homeStatus`). */
export interface HomeStatus {
  parts: StatusPart[];
  tone: StatusTone;
  /** The Inbox item the sentence names (its serious problem), so the sentence can lead to it; absent otherwise. */
  itemId?: string;
}

/** What the sentence reads of the overview; tests and older callers pass less. */
export type StatusInput = Pick<HomeOverview, 'summary'> & {
  needsYou?:
    | readonly (Pick<NeedsYouItem, 'kind' | 'severity' | 'title' | 'research'> & { id?: string })[]
    | undefined;
  things?: readonly Pick<ThingSummary, 'name' | 'status'>[] | undefined;
  /** Contracts 0.91 (CT-403): the chat the assistant is working in. */
  chats?: readonly Pick<HomeChat, 'title' | 'state' | 'default'>[] | undefined;
  doneToday?: readonly Pick<DoneTodayItem, 'at' | 'fixed'>[] | undefined;
};

/**
 * The first screen's answer to “Is everything OK, and do you need me?” (status-line.md), true to the worst state:
 *
 * - something serious, named: the worst problem in Needs you (“The disk array on blackbox has failed.”, the assistant's
 *   own words once it found out), with what the assistant does about it (“I’m looking into it.”) and how many other
 *   things need the person; else what is offline (“pve-01 is offline.”) or broken (“Something’s wrong with blackbox.”);
 * - else what needs the person: “**2 things need you**, and I’m adding your heat pump.”;
 * - else what the assistant keeps an eye on (open problems nobody has to decide yet);
 * - else “All good.”, with what it fixed (“I fixed 1 thing overnight.”) and what it is doing, or “Nothing needs you.”
 *
 * A thing that only runs warm or a heads-up never makes it say something is wrong; nothing open ever reads “All good”.
 * `timeZone` tells a night's fix (before 07:00) from the day's.
 */
export function homeStatus(overview: StatusInput, options: { timeZone?: string } = {}): HomeStatus {
  const { needsYou, problems } = overview.summary;
  // The default chat's title is the assistant's own name: “I’m working on Neo” says nothing.
  const title = overview.chats?.find((c) => c.state === 'working' && !c.default)?.title;
  const doing = title ? workingPhrase(title) : null;
  const serious = overview.needsYou?.find(
    (i) =>
      i.severity === 'bad' && i.kind !== 'approval' && i.kind !== 'question' && i.research?.state !== 'fixed',
  );
  if (serious) {
    const research = serious.research;
    // Once it found out, its words say what is wrong better than the alert's (look-research.md LR-09).
    const words =
      research && (research.state === 'found' || research.state === 'fixing') && research.title
        ? research.title
        : serious.title;
    const parts: StatusPart[] = [{ text: sentence(words), strong: true }];
    if (research?.state === 'looking') parts.push({ text: ' I’m looking into it.' });
    if (research?.state === 'fixing') parts.push({ text: ' I’m fixing it.' });
    parts.push(...needYou(needsYou - 1, 'other'));
    return { parts, tone: 'bad', ...(serious.id ? { itemId: serious.id } : {}) };
  }
  const things = overview.things ?? [];
  const offline = things.filter((t) => t.status === 'offline');
  const broken = things.filter((t) => t.status === 'bad');
  if (offline.length || broken.length) {
    const text = offline.length
      ? offline.length === 1
        ? `${offline[0]?.name} is offline.`
        : `${offline.length} things are offline.`
      : broken.length === 1
        ? `Something’s wrong with ${broken[0]?.name}.`
        : `Something’s wrong with ${broken.length} things.`;
    return { parts: [{ text, strong: true }, ...needYou(needsYou)], tone: 'bad' };
  }
  if (needsYou > 0) {
    const count = `${needsYou} ${needsYou === 1 ? 'thing needs' : 'things need'} you`;
    return {
      parts: [{ text: count, strong: true }, { text: doing ? `, and ${lowerFirst(doing)}.` : '.' }],
      tone: 'warn',
    };
  }
  if (problems > 0) {
    const watched = `I’m keeping an eye on ${problems} ${problems === 1 ? 'thing' : 'things'}.`;
    return { parts: [{ text: `Nothing needs you. ${watched}` }], tone: 'warn' };
  }
  const fixes = (overview.doneToday ?? []).filter((d) => d.fixed);
  const said = [
    fixes.length
      ? `I fixed ${fixes.length} ${fixes.length === 1 ? 'thing' : 'things'} ${overnight(fixes, options.timeZone) ? 'overnight' : 'today'}.`
      : null,
    doing ? `${doing}.` : null,
  ].filter(Boolean);
  return {
    parts: [{ text: `All good. ${said.length ? said.join(' ') : 'Nothing needs you.'}` }],
    tone: 'ok',
  };
}

/**
 * The status sentence's pieces (Connections' title, the phone's Connections): `homeStatus` without its tone. Open Watch
 * items (`summary.problems`) only say “keeping an eye on” when nothing else does.
 */
export function homeStatusLine(overview: StatusInput, options: { timeZone?: string } = {}): StatusPart[] {
  return homeStatus(overview, options).parts;
}

/**
 * “ **2 things need you**.” after what is wrong, or “ 2 other things need you.” after the problem it names (which is
 * the sentence's one strong part then); nothing when none do.
 */
function needYou(count: number, other?: 'other'): StatusPart[] {
  if (count <= 0) return [];
  const what = [String(count), other, count === 1 ? 'thing needs' : 'things need'].filter(Boolean).join(' ');
  return other
    ? [{ text: ` ${what} you.` }]
    : [{ text: ' ' }, { text: `${what} you`, strong: true }, { text: '.' }];
}

/** Whether every fix of the day was made in the night, before 07:00 (Done today holds only the person's day). */
function overnight(fixes: readonly Pick<DoneTodayItem, 'at'>[], timeZone: string | undefined): boolean {
  return !!timeZone && fixes.every((f) => zonedParts(f.at, timeZone).hour < MORNING_HOUR);
}

/** Before this local hour a fix counts as overnight. */
const MORNING_HOUR = 7;

/** A title as a sentence: its own full stop when it has none. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** “I’m …” stays as it is; anything else loses its capital after “and”. */
function lowerFirst(text: string): string {
  return text.startsWith('I’m') ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** The status sentence as plain text (an accessible name, the phone's line). */
export function statusText(parts: readonly StatusPart[]): string {
  return parts.map((p) => p.text).join('');
}

/**
 * Overview's first line (docs/decisions/overview-server-connection-final.md): the broken thing itself when something
 * serious is open — its title as a heading (the assistant's words once it found out), its consequence under it, one
 * *Look into it*, and how many other things need the person — else the status sentence as before (`homeStatus`).
 */
export type OverviewHeadline =
  | {
      kind: 'broken';
      /** “blackbox’s disk array failed”, without its full stop: it is a heading. */
      title: string;
      /** “Your files have no protection now.”; empty when the item says no more. */
      detail: string;
      itemId: string;
      /** The other things that need the person, for “2 other things need you”. */
      others: number;
      /** The assistant is already looking into it or fixing it: no button, its words instead. */
      busy: 'looking' | 'fixing' | null;
    }
  | { kind: 'status'; status: HomeStatus };

export function overviewHeadline(
  overview: Omit<StatusInput, 'needsYou'> & {
    needsYou?: readonly (Pick<NeedsYouItem, 'kind' | 'severity' | 'title' | 'research' | 'body'> & {
      id?: string;
    })[];
  },
  options: { timeZone?: string } = {},
): OverviewHeadline {
  const status = homeStatus(overview, options);
  const item = status.itemId ? overview.needsYou?.find((i) => i.id === status.itemId) : undefined;
  if (!item || !status.itemId) return { kind: 'status', status };
  const research = item.research;
  const found =
    research && (research.state === 'found' || research.state === 'fixing') && research.title
      ? research
      : null;
  const title = (found?.title ?? item.title).trim().replace(/\.$/, '');
  const detail = (found?.summary ?? item.body).trim();
  return {
    kind: 'broken',
    title,
    detail,
    itemId: status.itemId,
    others: Math.max(0, overview.summary.needsYou - 1),
    busy: research?.state === 'looking' ? 'looking' : research?.state === 'fixing' ? 'fixing' : null,
  };
}
