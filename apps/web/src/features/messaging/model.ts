/**
 * Pure view logic for the conversation screens: history pages → rows grouped by day, composer autocomplete
 * (mentions and commands). Everything that formats copy comes from
 * `@whombat/core`; this only arranges it for the components and is unit-tested.
 */
import { foldIntoRuns, type WorkLine } from '@whombat/client';
import {
  type Bootstrap,
  dayKey,
  formatDayDivider,
  type Message,
  type MessagePage,
  type Principal,
} from '@whombat/core';
import { currentLocale } from '../../i18n/provider';

export type PrincipalLookup = (id: string) => Principal | undefined;

/** Principals by id, from the bootstrap (every person and agent in the burrow). */
export function principalLookup(bootstrap: Pick<Bootstrap, 'principals'> | undefined): PrincipalLookup {
  const map = new Map((bootstrap?.principals ?? []).map((p) => [p.id, p]));
  return (id) => map.get(id);
}

/** The zone times are shown in: the viewer's preference, else the burrow's. */
export function viewerTimeZone(bootstrap: Pick<Bootstrap, 'preferences' | 'burrow'> | undefined): string {
  return bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? 'Europe/Amsterdam';
}

/** Infinite history (`pages[0]` is the newest page, each page oldest first) → one list, oldest first. */
export function historyMessages(pages: readonly MessagePage[] | undefined): Message[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: Message[] = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    for (const m of pages[i]?.messages ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

export interface DayGroup {
  /** `2026-09-23` in the viewer's zone. */
  key: string;
  /** "Today · Wednesday 23 September" */
  label: string;
  messages: Message[];
}

/** A list with what runs did folded into them (docs/decisions/card-settle.md AP-732). */
export interface FoldedMessages {
  /** The rows the list shows, oldest first. */
  visible: Message[];
  /** By run message id: the messages that show as lines inside that run. */
  inside: Map<string, Message[]>;
  /** The messages left out as rows. */
  hidden: Set<string>;
}

/**
 * Skills a run learned and turns it scheduled show inside the run when its message is in the same list above them
 * (`foldIntoRuns`); the list leaves their own messages out. A message somebody replied to stays a row of its own, so
 * its thread link stays.
 */
export function foldMessages(messages: readonly Message[]): FoldedMessages {
  const candidates = messages.filter((m) => m.replyCount === 0 || m.card?.kind === 'run');
  const { inside, hidden } = foldIntoRuns(candidates);
  if (hidden.size === 0) return { visible: [...messages], inside, hidden };
  return { visible: messages.filter((m) => !hidden.has(m.id)), inside, hidden };
}

/** Messages split by calendar day in the viewer's zone, each with its divider label. */
export function groupByDay(messages: readonly Message[], now: Date | number, timeZone: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const m of messages) {
    const key = dayKey(m.createdAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.messages.push(m);
    else
      groups.push({
        key,
        label: formatDayDivider(m.createdAt, now, timeZone, currentLocale()),
        messages: [m],
      });
  }
  return groups;
}

/* Composer: triggers ------------------------------------------------------------------------------- */

/** Insert a trigger character (`@`, `/`) at the caret, with a space before it when needed. */
export function insertTrigger(
  text: string,
  caret: number,
  trigger: '@' | '/',
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const pad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${pad}${trigger}`;
  return { text: `${next}${text.slice(caret)}`, caret: next.length };
}

/* Composer: /commands ------------------------------------------------------------------------------ */

/**
 * The `/skill` being typed: only while the draft is a single `/word` at its very start. Skill names have digits and
 * dashes (`/3-statement-model`, SL-09). There are no other commands: `/topic` and `/invite` were the channels' (OA-04).
 */
export function activeCommand(text: string): { query: string } | null {
  const m = /^\/([a-z0-9._-]*)$/i.exec(text);
  return m ? { query: (m[1] as string).toLowerCase() } : null;
}

/* Composer: /skills (skills-library.md SL-09; AP-212) ---------------------------------------------- */

/** A skill the composer offers after `/`: an enabled skill of the agent. */
export interface SkillCommand {
  name: string;
  description: string;
  agentId: string;
  agentName: string;
  /** What choosing it puts in the draft: `/name `. */
  insert: string;
}

/** The skills whose name starts with the query, in the order given (the room's agents in order). */
export function skillCommandsFor(skills: readonly SkillCommand[], query = ''): SkillCommand[] {
  const q = query.toLowerCase();
  return skills.filter((s) => s.name.startsWith(q));
}

/**
 * A draft that starts with a skill command (`/name …`, a skill's name as Hermes names it), or null. `//` is no command.
 * The message goes as typed: Hermes reads the command itself (HE-41; AP-5235).
 */
export function skillCommandOf(text: string): { name: string } | null {
  const m = /^\/([a-z0-9][a-z0-9._-]{0,63})(?:\s|$)/.exec(text.trimStart());
  return m ? { name: m[1] as string } : null;
}

/**
 * A `/skill` draft that doesn't address the agent (AP-248): in a branch room, where the agent answers when mentioned,
 * “Mention @Neo to use /docx.”; null when the draft isn't one of its skills or does address it.
 */
export function skillAddressNotice(
  text: string,
  skills: readonly Pick<SkillCommand, 'name' | 'agentId' | 'agentName'>[],
  addressed: readonly string[],
): string | null {
  const parsed = skillCommandOf(text);
  if (!parsed) return null;
  const holder = skills.find((s) => s.name === parsed.name);
  if (!holder || addressed.includes(holder.agentId)) return null;
  return `Mention @${holder.agentName} to use /${parsed.name}.`;
}

/** Two work lines that draw the same, so a memoized row isn't drawn again when nothing it shows changed. */
export function sameWorkLine(a: WorkLine | null | undefined, b: WorkLine | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.who === b.who &&
    a.text === b.text &&
    a.tone === b.tone &&
    a.since === b.since &&
    a.spoken === b.spoken &&
    JSON.stringify(a.progress) === JSON.stringify(b.progress) &&
    JSON.stringify(a.members) === JSON.stringify(b.members)
  );
}
