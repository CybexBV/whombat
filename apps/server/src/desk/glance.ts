/**
 * The desk screen's glance (docs/decisions/desk-display.md DK-03, DK-05; desk-display-server.md DK-S08…DK-S11): what
 * the paired person's Home knows, made into the screen's shape. `buildFullGlance` reads everything once (Needs you with
 * each ask's detail, Working on, Done today, the servers, the tiles, the assistant's own line); `trimGlance` cuts it to
 * what the screen may show now — locked with the person's choice, or unlocked — so the runtime is the one that decides,
 * and locking or unlocking needs no new read.
 */
import {
  type Approval,
  type ApprovalView,
  approvalView,
  DESK_BOX_TONES,
  DESK_LOOKS_MAX,
  DESK_SERVER_ID_RE,
  DESK_SHOW_KEY_RE,
  DESK_WORDS,
  type DeskCalmActivity,
  type DeskCalmWork,
  type DeskLockedView,
  type DeskStatusInput,
  deskMayDecide,
  deskStatusLine,
  deskText,
  deskToneOf,
  fillDeskWords,
  type HomeRef,
  type HostServer,
  hostOsMark,
  LookResearch,
  type NeedsYouItem,
  type ThingSummary,
  type WorkingTask,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import { callArgsAad } from '../connections/call';
import { messages } from '../db/schema/index';
import { type DoneTask, recentDoneTasks } from '../home/done';
import { homeReads, needsYou, SNOOZE_HOUR, things, workingTask } from '../home/overview';
import type { SourceReads } from '../home/registry';
import { startOfLocalDay, tomorrowAt } from '../home/time';
import { homeWidgetsNow, type WidgetNow } from '../home/widgets';
import { serverLines, serverNotice, verdictOf } from '../hosts/quiet-lines';
import { HostsUnavailable, hostsFor } from '../hosts/service';
import { fleetFor } from '../hosts/sources';
import { type LookLine, lookLines } from '../looks/lines';
import { loadPrincipalsByIds, type PrincipalRow, shortName } from '../read/principals';
import { type ApprovalRow, approvalByNumber, approvalForViewer } from '../read/work';
import type { Services } from '../services';
import { thingLines, thingNotice } from '../things/quiet/connection';
import type { GlanceNotice } from '../things/quiet/glance';
import { takenFrom, takenWords } from '../things/quiet/windows';
import type {
  DeskAsk,
  DeskBox,
  DeskFound,
  DeskGlance,
  DeskLook,
  DeskMeter,
  DeskServer,
  DeskTile,
} from './shapes';

/* Display text ---------------------------------------------------------------------------------- */

/**
 * A string as the screen may show it in at most `max` code points (core `deskText`: one line, nothing invisible, cut
 * with “…”), after Markdown's emphasis and code marks and a heading or quote mark in front go. Empty when nothing is
 * left.
 */
export function screenText(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return deskText(
    text
      .normalize('NFC')
      .replace(/[*`]+/g, '')
      .replace(/^[#>\s]+/, ''),
    max,
  );
}

/* Servers --------------------------------------------------------------------------------------- */

const tone = (value: number, warn: number, bad: number): DeskMeter['tone'] =>
  value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';

/** A percentage as a meter: rounded, then toned by the rounded number, so the colour always fits it (DK-S81). */
export function meter(value: number, at: { warn: number; bad: number }): DeskMeter {
  const shown = Math.round(value);
  return { value: shown, tone: tone(shown, at.warn, at.bad) };
}

/** A temperature's tone (the card's since 0.100, DK-81): warm 15° under its limit, hot at it; 70° and 85° without one. */
export function tempTone(celsius: number, limit: number | null): DeskMeter['tone'] {
  return limit !== null ? tone(celsius, limit - 15, limit) : tone(celsius, 70, 85);
}

/** The server's id when the desk can carry it (`DeskServerId`): a card without one doesn't open (DK-88). */
export function deskServerId(id: string | null | undefined): string | null {
  return id && DESK_SERVER_ID_RE.test(id) ? id : null;
}

/** “up 41 d”, “up 5 h”, “up 12 min”. */
export function uptimeNote(seconds: number): string {
  if (seconds >= 86_400) return `up ${Math.floor(seconds / 86_400)} d`;
  if (seconds >= 3_600) return `up ${Math.floor(seconds / 3_600)} h`;
  return `up ${Math.max(1, Math.floor(seconds / 60))} min`;
}

const STATE: Record<Exclude<HostServer['status'], 'pending'>, DeskServer['state']> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  offline: 'off',
};

/**
 * A server as the screen draws it (mock 1; DK-80): its id (the card opens its screen, DK-83), mark, state and a short
 * note, CPU, memory, disk and the hottest sensor. A warm or hot sensor makes a server that is fine say so and take its
 * colour, and a hot one makes one to look at a server in trouble, keeping its note (DK-81); one that is off or in
 * trouble already stays as it is.
 */
export function deskServer(s: HostServer): DeskServer | null {
  if (s.status === 'pending') return null;
  const state = STATE[s.status];
  const name = screenText(s.name, 40);
  if (!name) return null;
  const said = s.statusNote?.trim() ? s.statusNote.trim() : '';
  const note =
    state !== 'ok' && said
      ? said
      : state === 'off'
        ? 'off'
        : said && /updat|restart|install/i.test(said)
          ? said
          : typeof s.uptimeS === 'number' && s.uptimeS > 0
            ? uptimeNote(s.uptimeS)
            : '';
  const lowered = note && /^[A-Z][a-z]/.test(note) ? note.charAt(0).toLowerCase() + note.slice(1) : note;
  const id = deskServerId(s.id);
  const out: DeskServer = {
    ...(id ? { id } : {}),
    name,
    mark: hostOsMark(s) ?? 'server',
    state,
    note: screenText(lowered, 40) || (state === 'ok' ? 'up' : state),
  };
  if (state !== 'off') {
    const { cpu, memory, storage } = DESK_BOX_TONES;
    if (s.cpuPct !== null) out.cpu = meter(s.cpuPct, cpu);
    if (s.memory.usedPct !== null) out.memory = meter(s.memory.usedPct, memory);
    if (s.storage.usedPct !== null) out.disk = meter(s.storage.usedPct, storage);
    const hot = s.temperature?.maxC;
    if (hot !== null && hot !== undefined) {
      // Older consoles still draw it; the server's screen shows it big (DK-80, DK-83).
      const value = Math.round(hot);
      out.temp = { value, tone: tempTone(value, s.temperature?.limitC ?? null) };
      const heat = out.temp.tone;
      if (heat !== 'ok' && state === 'ok') {
        out.state = heat;
        out.note = screenText(fillDeskWords(DESK_WORDS.hot, { n: value }), 40);
      } else if (heat === 'bad' && state === 'warn') out.state = 'bad';
    }
  }
  return out;
}

const SERVER_ORDER: Record<DeskServer['state'], number> = { bad: 0, off: 1, warn: 2, ok: 3 };

/** Worst first, then by name (DK-03). */
export function sortServers<T extends DeskServer>(servers: T[]): T[] {
  return servers.sort(
    (a, b) => SERVER_ORDER[a.state] - SERVER_ORDER[b.state] || a.name.localeCompare(b.name),
  );
}

/* Tiles ----------------------------------------------------------------------------------------- */

/** The tile's icon from what it measures (its name, the figure's label and unit). */
export function tileIcon(words: string, unit = ''): DeskTile['icon'] {
  const w = `${words} ${unit}`.toLowerCase();
  if (/heat ?pump|boiler|heating|furnace|hvac|thermostat/.test(w)) return 'heat';
  if (/solar|\bsun\b|\bpv\b/.test(w)) return 'sun';
  if (/°c|°f|temp/.test(w)) return 'temperature';
  if (/\bk?wh?\b|power|energy|watt|battery|charger/.test(w)) return 'power';
  if (/lock|door|gate/.test(w)) return 'lock';
  if (/light|lamp|bulb/.test(w)) return 'light';
  if (/water|leak|humid|pool|rain/.test(w)) return 'water';
  if (/network|wi-?fi|internet|router|ping|dns|mbit/.test(w)) return 'network';
  return 'generic';
}

/** “21.4 °C”, “3.2 kW”, “54 %”: a figure and its unit, one space apart. */
const figure = (value: string, unit?: string) => (unit ? `${value} ${unit}` : value);

/** Mail accounts are things too, but an unread count isn't a home figure and says nothing for a passer-by. */
const MAIL_THINGS = new Set(['google', 'imap', 'microsoft', 'gmail', 'outlook']);

/** A connection or device with a figure now, as a tile: the figure, the name and the next figure. */
export function thingTile(t: ThingSummary): DeskTile | null {
  if (t.kind === 'server' || MAIL_THINGS.has(t.catalogId ?? '') || MAIL_THINGS.has(t.icon)) return null;
  const [first, second] = t.facts.filter((f) => f.value && f.value !== '—');
  if (!first) return null;
  const value = screenText(figure(first.value, first.unit), 24);
  const next = second ? ` · ${second.label.toLowerCase()} ${figure(second.value, second.unit)}` : '';
  const label = screenText(`${t.name}${next}`, 48) || screenText(t.name, 48);
  if (!value || !label) return null;
  const tile: DeskTile = { icon: tileIcon(`${t.name} ${first.label}`, first.unit), value, label };
  if (t.catalogId && /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(t.catalogId) && t.catalogId !== 'device')
    tile.mark = t.catalogId;
  if (t.status === 'warn') tile.tone = 'warn';
  else if (t.status === 'bad' || t.status === 'offline') tile.tone = 'bad';
  return tile;
}

/** A widget pinned on Home, as a tile: its first value now. */
export function widgetTile(w: WidgetNow): DeskTile | null {
  if (w.problem) return null;
  const latest = w.latest.find((l) => l.value !== null);
  if (!latest || latest.value === null) return null;
  const series = w.series.find((s) => s.key === latest.key);
  const unit = latest.unit ?? series?.unit;
  const rounded =
    Math.abs(latest.value) >= 100 ? Math.round(latest.value) : Math.round(latest.value * 10) / 10;
  const value = screenText(figure(String(rounded), unit), 24);
  const label = screenText(w.subtitle ? `${w.title} · ${w.subtitle}` : w.title, 48);
  if (!value || !label) return null;
  return { icon: tileIcon(`${w.title} ${series?.label ?? ''}`, unit), value, label };
}

/** A Home widget as the calm glance's figure (`widget:<id>`, its value now); null without one, or with a problem. */
export function widgetFigure(w: WidgetNow): DeskCalmActivity | null {
  const tile = widgetTile(w);
  const name = screenText(w.title, 40);
  const key = `widget:${w.id}`;
  if (!tile || !name || !DESK_SHOW_KEY_RE.test(key)) return null;
  return { key, name, value: tile.value, active: false };
}

/* Working on ------------------------------------------------------------------------------------ */

const STEP: Record<WorkingTask['steps'][number]['state'], 'done' | 'now' | 'next'> = {
  done: 'done',
  active: 'now',
  waiting: 'now',
  todo: 'next',
};

/** Up to six steps, the window around the one going on. */
export function deskWorking(task: WorkingTask | null): DeskGlance['working'] {
  if (!task) return null;
  const title = screenText(task.title, 120);
  if (!title) return null;
  const all = task.steps.map((s) => ({ label: screenText(s.title, 40) || '…', state: STEP[s.state] }));
  const now = all.findIndex((s) => s.state !== 'done');
  const start = all.length <= 6 ? 0 : Math.max(0, Math.min((now < 0 ? all.length : now) - 1, all.length - 6));
  return { title, steps: all.slice(start, start + 6) };
}

/** The work as the calm glance counts it (“2 of 4 done”): every step, not only the screen's window of six. */
export function deskCalmWork(task: WorkingTask | null): DeskCalmWork | null {
  if (!task) return null;
  const title = screenText(task.title, 120);
  if (!title) return null;
  return {
    title,
    steps: task.steps
      .slice(0, 50)
      .map((s) => ({ label: screenText(s.title, 40) || '…', state: STEP[s.state] })),
  };
}

/* Asks ------------------------------------------------------------------------------------------ */

/** The approve button's words (DK-05): the ask's own (“Restart Plex”), without its question mark or its server. */
export function approveLabel(title: string, where: string | undefined): string {
  let words = screenText(title, 200).replace(/\?$/, '').trim();
  if (where && words.toLowerCase().endsWith(` on ${where.toLowerCase()}`))
    words = words.slice(0, -(where.length + 4)).trim();
  return words && Array.from(words).length <= 40 ? words : 'Approve';
}

/**
 * Questions have no number: the screen gives each one its own, stable while the runtime runs (from 1 000 000, past any
 * approval's), so the page can key its rows; `decide` finds no approval by it (DK-S09).
 */
export class QuestionNumbers {
  #next = 1_000_000;
  readonly #byId = new Map<string, number>();
  readonly #byNumber = new Map<number, string>();

  of(messageId: string): number {
    let n = this.#byId.get(messageId);
    if (n === undefined) {
      n = this.#next++;
      if (this.#byId.size > 500) {
        this.#byId.clear();
        this.#byNumber.clear();
      }
      this.#byId.set(messageId, n);
      this.#byNumber.set(n, messageId);
    }
    return n;
  }

  /** The question (its message) a screen number names, or null. */
  messageOf(number: number): string | null {
    return this.#byNumber.get(number) ?? null;
  }
}

/** What the screen's *Not now* is about: an approval by its number, or a question by its message. */
export type NotNowSubject = { kind: 'approval'; number: number } | { kind: 'question'; messageId: string };

/**
 * The screen's *Not now* (DK-S19): Home's own — the ask snoozed for the person until tomorrow at 09:00 in the burrow's
 * zone (`snooze_needs_you`, `SNOOZE_HOUR`), never a decline the requester hears.
 */
export function notNowSnooze(
  subject: NotNowSubject,
  now: Date,
  timeZone: string,
): { ref: HomeRef; until: string } {
  return {
    ref:
      subject.kind === 'approval'
        ? { kind: 'approval', id: String(subject.number) }
        : { kind: 'question', id: subject.messageId },
    until: tomorrowAt(now, timeZone, SNOOZE_HOUR).toISOString(),
  };
}

/**
 * A Servers or connection call's deferred arguments, opened for `deskMayDecide` (they stay sealed everywhere else,
 * CX-21): with them it reads the shell command a `server_command` runs (`args.command`, CT-535). Null for any other ask
 * or when they can't be opened: then its tool and words decide, and a `server_command` stays on the phone (DK-S25).
 */
export function callArgsOf(
  services: Pick<Services, 'custody'>,
  row: Pick<ApprovalRow, 'action' | 'command'>,
): Record<string, unknown> | null {
  if (row.action.type !== 'connection_call') return null;
  const input = row.command?.input as { callId?: unknown; argsEnc?: unknown } | undefined;
  if (typeof input?.callId !== 'string' || typeof input.argsEnc !== 'string') return null;
  try {
    const args = JSON.parse(services.custody.open(callArgsAad(input.callId), input.argsEnc));
    return args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The optional words of an ask as the screen may take them: a string with nothing left to show is left out, not sent
 * empty (the contract's display strings have at least one character; one empty string fails the whole `DeskState`,
 * DK-S24).
 */
function shown<K extends 'where' | 'detail' | 'approveLabel'>(key: K, text: string): { [P in K]?: string } {
  return (text ? { [key]: text } : {}) as { [P in K]?: string };
}

/** What an approval's ask is made of (read for it by `approvalAsk`). */
export interface ApprovalAskParts {
  number: number;
  item: Pick<NeedsYouItem, 'title' | 'body' | 'at'>;
  approval: Pick<Approval, 'action' | 'keyId' | 'explainer' | 'summary'>;
  view: Pick<ApprovalView, 'question' | 'title' | 'target' | 'content'> &
    Partial<Pick<ApprovalView, 'scopeChoices'>>;
  /** The call's deferred arguments for `deskMayDecide` (`callArgsOf`). */
  args: Record<string, unknown> | null;
  /** Who asks: the requester's name (TF-15). */
  from?: string | null;
}

/**
 * The wider answers the web card offers the paired person (task-feedback.md TF-14): its `scopeChoices` beyond once,
 * one per scope, labelled as on the card. `trimGlance` keeps them only where the screen may use them.
 */
export function deskAskChoices(view: Partial<Pick<ApprovalView, 'scopeChoices'>>): DeskAsk['choices'] {
  const out: NonNullable<DeskAsk['choices']> = [];
  for (const c of view.scopeChoices ?? []) {
    if (c.scope === 'once' || out.some((o) => o.scope === c.scope)) continue;
    const label = screenText(c.label, 120);
    if (label) out.push({ scope: c.scope, label });
  }
  return out.length ? out.slice(0, 2) : undefined;
}

/** An approval as the screen shows it (DK-S09): the web card's title (TF-15); words with nothing to show left out. */
export function deskApprovalAsk({ number, item, approval, view, args, from }: ApprovalAskParts): DeskAsk {
  const server =
    approval.action.type === 'connection_call' ? (approval.action.params.server?.name ?? '') : '';
  const where = screenText(server, 40);
  const title = screenText(view.title || item.title || view.question, 120) || 'A decision';
  const choices = deskAskChoices(view);
  const who = from ? screenText(from, 40) : '';
  const facts = [view.content?.text.split('\n')[0] ?? '', view.target]
    .map((f) => screenText(f, 80))
    .filter((f, i, all) => f && all.indexOf(f) === i)
    .slice(0, 3);
  const may = deskMayDecide({ action: approval.action, keyId: approval.keyId }, { args });
  return {
    number,
    kind: 'approval',
    title,
    at: item.at,
    ...shown('where', where),
    ...shown('detail', screenText(approval.explainer || approval.summary || item.body, 400)),
    ...(facts.length ? { facts } : {}),
    ...shown('approveLabel', approveLabel(view.title || title, where || undefined)),
    onDesk: may.ok,
    ...(may.ok ? {} : { phoneReason: may.reason }),
    // The person's no works for every approval (DK-61, DK-S60).
    deny: true,
    ...(choices ? { choices } : {}),
    ...(who ? { from: who } : {}),
  };
}

/** Where an ask was made: its conversation and message, and the thread that message is in (DK-S62). */
export interface AskPlace {
  conversationId: string;
  messageId: string | null;
  threadRootId: string | null;
}

interface PlacedAsk {
  ask: DeskAsk;
  at: Omit<AskPlace, 'threadRootId'>;
}

/** The web card's view of a pending approval for the paired person (`approvalView`), with who asked. */
async function approvalViewFor(services: Services, place: DeskPlace, row: ApprovalRow, now: Date) {
  const approval: Approval = await approvalForViewer(services.db, place.person.id, row);
  const [requester] = await loadPrincipalsByIds(services.db, [approval.requesterId]);
  const view = approvalView(approval, {
    names: (id) =>
      id === requester?.id ? { name: requester.name, shortName: shortName(requester) } : undefined,
    viewer: { id: place.person.id, kind: 'person' },
    now,
    timeZone: place.timeZone,
  });
  return { approval, requester, view };
}

/**
 * The wider scopes the ask with this approval offers the paired person now (TF-14, DK-S100): the web card's choices
 * beyond once, as `approvals.decide` would take them from them.
 */
export async function deskOfferedScopes(
  services: Services,
  place: DeskPlace,
  row: ApprovalRow,
  now: Date,
): Promise<('task' | 'agent')[]> {
  if (row.state !== 'pending') return [];
  const { view } = await approvalViewFor(services, place, row, now);
  return (deskAskChoices(view) ?? []).map((c) => c.scope);
}

async function approvalAsk(
  services: Services,
  place: DeskPlace,
  item: NeedsYouItem,
  now: Date,
): Promise<PlacedAsk | null> {
  const number = item.approvalNumber;
  if (!number) return null;
  const row = await approvalByNumber(services.db, place.burrow.id, number);
  if (row?.state !== 'pending') return null;
  const { approval, requester, view } = await approvalViewFor(services, place, row, now);
  return {
    ask: deskApprovalAsk({
      number,
      item,
      approval,
      view,
      args: callArgsOf(services, row),
      from: requester ? shortName(requester) || requester.name : null,
    }),
    at: { conversationId: row.conversationId, messageId: row.messageId },
  };
}

/**
 * A question the assistant asked in Chat as the screen shows it: its first line the title (Home's), the lines after it
 * the detail, none for a one-line question. Null when nothing of the title is left to show.
 */
export function deskQuestionAsk(
  number: number,
  item: Pick<NeedsYouItem, 'title' | 'at'>,
  text: string,
): DeskAsk | null {
  const title = screenText(item.title, 120);
  if (!title) return null;
  const lines = text.split('\n').filter((l) => l.trim());
  return {
    number,
    kind: 'question',
    title,
    at: item.at,
    ...shown('detail', screenText(lines.slice(1).join(' '), 400)),
    onDesk: true,
  };
}

async function questionAsk(
  services: Services,
  item: NeedsYouItem,
  numbers: QuestionNumbers,
): Promise<PlacedAsk | null> {
  const id = item.ref.id;
  const [row] = await services.db
    .select({ text: messages.text, conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.id, id)));
  if (!screenText(item.title, 120)) return null;
  const ask = deskQuestionAsk(numbers.of(id), item, row?.text ?? '');
  return ask && row ? { ask, at: { conversationId: row.conversationId, messageId: id } } : null;
}

/* The glance ------------------------------------------------------------------------------------ */

/** The paired person's place: their burrow, them, their assistant, their zone. */
export interface DeskPlace {
  burrow: BurrowRow;
  person: PrincipalRow;
  agent: PrincipalRow;
  accountId: string;
  timeZone: string;
}

/** Everything the screen could show, with each ask's detail; `trimGlance` cuts it per lock state. */
export interface FullGlance {
  /** The first asks, with their detail. */
  asks: DeskAsk[];
  /** Where each of `asks` was made, by its number (never sent; `inTalk`, DK-S62). */
  places: Record<number, AskPlace>;
  /** How many asks wait for the person (approvals they may decide, questions not answered yet). */
  askCount: number;
  /** The assistant's own line (“updating your server agents”), when it works on something. */
  doing: string | null;
  working: DeskGlance['working'];
  done: DeskGlance['done'];
  /** Every server, worst first. */
  servers: DeskServer[];
  tiles: DeskTile[];
  worst: DeskStatusInput['worst'];
  /** What needs a look (DK-93, DK-S110), worst first. */
  looks: DeskLook[];
  /** Every look, not only the first `DESK_LOOKS_MAX`: the calm glance counts them all (DK-112, DK-114). */
  everyLook: DeskLook[];
  /** The look keys of everything read now (servers and things), so a look gone because its read failed isn't “back”. */
  keys: string[];
  /** The work with all its steps, for the calm glance (DK-112, DK-117). */
  work: DeskCalmWork | null;
  /** Home's widgets as figures (DK-115). */
  figures: DeskCalmActivity[];
  /** The connections and devices Whombat watches (“14 services are running”, DK-112). */
  services: number;
  /**
   * The tasks the assistant finished, in its own words, newest first (today's and before): *Done today* and *Welcome
   * back* (done-today.md DN-03, DK-120).
   */
  recent: { text: string; at: string }[];
  /** How many of `recent` are today's. */
  doneToday: number;
  /** When each server that is off was last seen, by its id: since when it's down (DK-113). */
  downSince: Record<string, string>;
}

/** A glance with nothing in it: before the first read, or when Home can't be read. */
export const EMPTY_GLANCE: FullGlance = {
  asks: [],
  places: {},
  askCount: 0,
  doing: null,
  working: null,
  done: [],
  servers: [],
  tiles: [],
  worst: null,
  looks: [],
  everyLook: [],
  keys: [],
  work: null,
  figures: [],
  services: 0,
  recent: [],
  doneToday: 0,
  downSince: {},
};

const MAX_ASKS = 5;
/** Servers and tiles in `servers` and `tiles`, as every console since 0.100 takes them. */
const MAX_SERVERS = 4;
const MAX_TILES = 4;
/** The next ones in `extraServers` and `extraTiles` (0.104, DK-41): up to eight of each reach the screen. */
const MAX_EXTRA = 4;
const MAX_DONE = 3;
/** Looks the calm glance reads at most: far more than a screen says, few enough to read each one's facts. */
const EVERY_LOOK_MAX = 50;
/** The newest finished tasks read for *Done today* and *Welcome back* (done-today.md DN-03). */
const RECENT_DONE = 50;

/**
 * The worst server or thing that isn't fine: one that is off or doesn't answer (`down`), else one in trouble, else one
 * to look at; servers before things at the same level.
 */
export function worstOf(servers: DeskServer[], thingList: ThingSummary[]): DeskStatusInput['worst'] {
  const level = (s: string) => (s === 'off' || s === 'offline' ? 0 : s === 'bad' ? 1 : s === 'warn' ? 2 : 3);
  const candidates = [
    // A server card counts with a line behind it (QN-23): not one put aside, not one only warm (QN-S58).
    ...servers.filter((s) => cardNotice(s) !== null).map((s) => ({ name: s.name, level: level(s.state) })),
    ...thingList
      .filter((t) => t.kind !== 'server')
      .map((t) => ({ name: screenText(t.name, 40), level: level(t.status) })),
  ].filter((c) => c.level < 3 && c.name);
  const worst = candidates.sort((a, b) => a.level - b.level)[0];
  return worst ? { name: worst.name, down: worst.level === 0 } : null;
}

/* Looks ------------------------------------------------------------------------------------------ */

const LOOK_ORDER: Record<DeskLook['state'], number> = { down: 0, bad: 1, look: 2 };
const SERVER_LOOK: Partial<Record<DeskServer['state'], DeskLook['state']>> = {
  off: 'down',
  bad: 'bad',
  warn: 'look',
};
const THING_LOOK: Partial<Record<ThingSummary['status'], DeskLook['state']>> = {
  offline: 'down',
  bad: 'bad',
  warn: 'look',
};

/** Why, as the screen says it (“Filling up”, “Hot · 84°”); none when it only names the state. */
function lookReason(text: string | null | undefined): string | undefined {
  const reason = screenText(text, 120);
  if (!reason || /^(ok|up|warn|bad|off|offline)$/i.test(reason)) return undefined;
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * The line behind a look (quiet-notices.md QN-20, QN-S17): its check and item for *Ignore* and *Not now*, its kind of
 * line (a problem offers *Ask {assistant} to look into it*, only-you doesn't), Ignore's words and the line's own
 * question. A heads-up never colours a thing, so it never makes a look; a quiet line doesn't either.
 */
export function lookNotice(n: GlanceNotice | undefined): Partial<DeskLook> {
  if (!n || n.nature === 'fyi') return {};
  const subject = n.subject ? screenText(n.subject, 160) : '';
  const words = n.ignoreWords ? screenText(n.ignoreWords, 60) : '';
  const question = n.question ? screenText(n.question, 300) : '';
  return {
    notice: { check: n.check, ...(subject ? { subject } : {}) },
    nature: n.nature,
    ...(words ? { ignoreWords: words } : {}),
    ...(question ? { question } : {}),
  };
}

/**
 * What needs a look (DK-93, DK-S110): the server cards that aren't fine (with their id, so the screen can open one),
 * then the connections and devices whose status isn't; down first, then in trouble, then to look at, then by name; at
 * most `max` (`DESK_LOOKS_MAX`, the old glance's). Servers come from the cards, never from the server things, so a look and its card agree.
 */
/** Every line behind each look (`lookLinesOf`): what the assistant looks into when it looks into the thing. */
const LOOK_LINES = new WeakMap<DeskLook, LookLine[]>();

/** Every line behind a look, worst first; none when they weren't kept (a card read some other way). */
export function lookLinesOf(look: DeskLook): LookLine[] {
  return LOOK_LINES.get(look) ?? [];
}

export function deskLooks(
  servers: readonly DeskServer[],
  thingList: readonly ThingSummary[],
  max = DESK_LOOKS_MAX,
): DeskLook[] {
  const looks: DeskLook[] = [];
  // What a server that is down takes with it, from the things down because of it.
  const taken = takenFrom(thingList);
  for (const s of servers) {
    const state = SERVER_LOOK[s.state];
    if (!state) continue;
    // The line behind the card (QN-20, QN-23; QN-S58): none for a server whose “offline” alert is quiet, nor for a
    // card only warm (a heads-up); a card read some other way keeps its look without one.
    const notice = cardNotice(s);
    if (notice === null) continue;
    const takes = state === 'down' && s.id ? takenWords(taken.get(`server:${s.id}`) ?? []) : null;
    const reason = lookReason(takes ?? s.note);
    const look: DeskLook = {
      key: screenText(`server:${s.id ?? s.name}`, 120),
      kind: 'server',
      name: s.name,
      state,
      ...(reason ? { reason } : {}),
      ...(s.id ? { server: s.id } : {}),
      ...lookNotice(notice),
    };
    const row = CARD_ROWS.get(s);
    if (row) LOOK_LINES.set(look, lookLines(serverLines(row)));
    looks.push(look);
  }
  for (const t of thingList) {
    const state = THING_LOOK[t.status];
    const name = screenText(t.name, 40);
    const key = screenText(t.id, 120);
    if (t.kind === 'server' || !state || !name || !key) continue;
    // A heads-up isn't a look, as a card only warm isn't: Needs you folds it away and doesn't count it.
    const notice = thingNotice(t);
    if (notice?.nature === 'fyi') continue;
    const reason = lookReason(t.reason);
    const cause = t.causedBy
      ? { thing: screenText(t.causedBy.thing, 120), name: screenText(t.causedBy.name, 40) }
      : null;
    const look: DeskLook = {
      key,
      kind: t.kind,
      name,
      state,
      ...(reason ? { reason } : {}),
      ...lookNotice(notice),
      ...(cause?.thing && cause.name ? { causedBy: cause } : {}),
    };
    LOOK_LINES.set(look, lookLines(thingLines(t)));
    looks.push(look);
  }
  return looks
    .sort((a, b) => LOOK_ORDER[a.state] - LOOK_ORDER[b.state] || a.name.localeCompare(b.name))
    .slice(0, max);
}

/**
 * Each look with what the assistant found out about it (look-research.md LR-09), when the research passes the screen's
 * rules; the others as they are.
 */
export function withResearch(
  looks: readonly DeskLook[],
  research: ReadonlyMap<string, LookResearch>,
): DeskLook[] {
  return looks.map((look) => {
    const found = research.get(look.key);
    return found && LookResearch.safeParse(found).success ? { ...look, research: found } : look;
  });
}

/**
 * The line behind each server card (QN-20, QN-23): the row's worst line that asks for attention (`serverNotice`), null
 * when the row came to nothing that needs a look. A card made from a row not read through the hosts service's fleet
 * has none kept (undefined).
 */
const CARD_NOTICES = new WeakMap<DeskServer, GlanceNotice | null>();
/** The row each card was made from, for every line behind it. */
const CARD_ROWS = new WeakMap<DeskServer, HostServer>();

/** The line behind a server card: undefined when unknown, null when nothing behind it needs a look. */
export function cardNotice(card: DeskServer): GlanceNotice | null | undefined {
  return CARD_NOTICES.get(card);
}

/** The fleet as the screen has it: every server's card, worst first (the glance's order), and each one's row by id. */
export interface DeskFleet {
  cards: DeskServer[];
  rows: Map<string, HostServer>;
}

/** The servers as cards (DK-S08) and their rows; none when there is nothing to show. */
export function deskFleetOf(servers: readonly HostServer[]): DeskFleet {
  const rows = new Map<string, HostServer>();
  const cards: DeskServer[] = [];
  for (const row of servers) {
    const card = deskServer(row);
    if (!card) continue;
    if (verdictOf(row)) {
      CARD_NOTICES.set(card, serverNotice(row) ?? null);
      CARD_ROWS.set(card, row);
    }
    cards.push(card);
    if (card.id) rows.set(card.id, row);
  }
  return { cards: sortServers(cards), rows };
}

/**
 * The fleet for the screen, when the hosts service serves this burrow (null when it doesn't: no servers here). One the
 * service refuses, or doesn't give within `ms` when given, throws: the glance shows no servers then, *Servers* and a
 * server's screen say they can't reach them (DK-S82).
 */
export async function deskFleet(
  services: Services,
  burrowId: string,
  ms?: number,
  reads?: SourceReads,
): Promise<DeskFleet | null> {
  const hosts = hostsFor(services);
  if (!(await hosts.serves(burrowId).catch(() => false))) return null;
  const read = fleetFor(hosts, burrowId, reads);
  const fleet = ms === undefined ? read : within(read, ms);
  return deskFleetOf((await fleet).servers);
}

/** How long the screen waits for the hosts service (DK-S83): the console asks again in 10 s. */
export const DESK_HOSTS_WAIT_MS = 5_000;

/** `promise`, or `HostsUnavailable('timeout')` after `ms`. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HostsUnavailable('timeout', 'The servers didn’t answer in time.')),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function deskServers(services: Services, burrowId: string, reads?: SourceReads): Promise<DeskFleet> {
  const fleet = await deskFleet(services, burrowId, undefined, reads).catch(() => null);
  return fleet ?? { cards: [], rows: new Map() };
}

/** Since when each server that is off is down: when it was last seen. */
function downSinceOf(fleet: DeskFleet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const card of fleet.cards) {
    const seen = card.id && card.state === 'off' ? fleet.rows.get(card.id)?.lastSeen : null;
    if (card.id && seen) out[card.id] = seen;
  }
  return out;
}

/**
 * *Done today* and *Welcome back* from the tasks the agent finished, newest first (done-today.md DN-03): never the
 * changes it recorded on the way. `today` is the start of the person's day (ms).
 */
export function deskDone(
  finished: readonly DoneTask[],
  today: number,
): Pick<FullGlance, 'recent' | 'done' | 'doneToday'> {
  const recent = finished.map((d) => ({ text: screenText(d.text, 120), at: d.at })).filter((d) => d.text);
  const todays = recent.filter((d) => Date.parse(d.at) >= today);
  return { recent, done: todays.slice(0, MAX_DONE), doneToday: todays.length };
}

/** Reads the person's Home once for the screen. */
export async function buildFullGlance(
  services: Services,
  place: DeskPlace,
  numbers: QuestionNumbers,
  now = services.clock(),
): Promise<FullGlance> {
  const viewer = { burrow: place.burrow, principal: place.person };
  // Home's sections read what they share once: the agent (the place's), the chats, connections, what is quiet, the
  // fleet, the researches.
  const reads = homeReads(services, viewer, now, { agent: place.agent });
  const [items, task, thingList, widgets, finished, fleet, research] = await Promise.all([
    needsYou(services, viewer, now, reads),
    workingTask(services, viewer, reads),
    things(services, viewer, now, reads).catch(() => [] as ThingSummary[]),
    homeWidgetsNow(services.db, place.person, now).catch(() => [] as WidgetNow[]),
    recentDoneTasks(services.db, place.burrow.id, RECENT_DONE),
    deskServers(services, place.burrow.id, reads.shared),
    reads.research(),
  ]);
  const servers = fleet.cards;
  const placed: PlacedAsk[] = [];
  for (const item of items) {
    if (placed.length >= MAX_ASKS) break;
    const ask =
      item.kind === 'approval'
        ? await approvalAsk(services, place, item, now).catch(() => null)
        : item.kind === 'question'
          ? await questionAsk(services, item, numbers).catch(() => null)
          : null;
    if (ask) placed.push(ask);
  }
  const asks = placed.map((p) => p.ask);
  const places = await askPlaces(services, placed);
  const { recent, done, doneToday } = deskDone(finished, startOfLocalDay(now, place.timeZone).getTime());
  const tiles = [
    ...widgets.filter((w) => !w.thingId).map(widgetTile),
    ...thingList.filter((t) => t.kind === 'device').map(thingTile),
    ...thingList.filter((t) => t.kind === 'connection').map(thingTile),
  ]
    .filter((t): t is DeskTile => t !== null)
    .slice(0, MAX_TILES + MAX_EXTRA);
  const working = place.agent.status !== 'idle' || task ? place.agent.doing?.trim() || null : null;
  const everyLook = withResearch(deskLooks(servers, thingList, EVERY_LOOK_MAX), research);
  return {
    asks,
    places,
    askCount: Math.max(
      asks.length,
      items.filter((i) => i.kind === 'approval' || i.kind === 'question').length,
    ),
    doing: working ? screenText(working, 140) : null,
    working: deskWorking(task),
    done,
    servers,
    tiles,
    worst: worstOf(servers, thingList),
    looks: everyLook.slice(0, DESK_LOOKS_MAX),
    everyLook,
    keys: [
      ...servers.map((s) => screenText(`server:${s.id ?? s.name}`, 120)),
      ...thingList.filter((t) => t.kind !== 'server').map((t) => screenText(t.id, 120)),
    ],
    work: deskCalmWork(task),
    figures: widgets.map(widgetFigure).filter((f): f is DeskCalmActivity => f !== null),
    services: thingList.filter((t) => t.kind === 'connection' || t.kind === 'device').length,
    recent,
    doneToday,
    downSince: downSinceOf(fleet),
  };
}

/** The asks' places with the thread each message is in, by the ask's number (one read). */
async function askPlaces(
  services: Services,
  placed: readonly PlacedAsk[],
): Promise<Record<number, AskPlace>> {
  const ids = placed.flatMap((p) => (p.at.messageId ? [p.at.messageId] : []));
  const rows = ids.length
    ? await services.db
        .select({ id: messages.id, threadRootId: messages.threadRootId })
        .from(messages)
        .where(inArray(messages.id, ids))
    : [];
  const roots = new Map(rows.map((r) => [r.id, r.threadRootId]));
  const out: Record<number, AskPlace> = {};
  for (const p of placed)
    out[p.ask.number] = {
      ...p.at,
      threadRootId: p.at.messageId ? (roots.get(p.at.messageId) ?? null) : null,
    };
  return out;
}

/**
 * A new box (DK-23): no servers, no tiles, nothing that needs the person and nothing worked on. Its status line is
 * “All fine. I’m ready when you are.” with how to connect something as the muted part (core `deskStatusLine`'s
 * `fresh`), in *A summary* too.
 */
export function glanceFresh(full: FullGlance): boolean {
  return (
    full.servers.length === 0 &&
    full.tiles.length === 0 &&
    full.askCount === 0 &&
    !full.doing &&
    !full.working
  );
}

/** Whether *This Whombat* shows at all (DK-100): only on a glance without servers, never in *Only the time*. */
export function boxWanted(full: FullGlance, view: DeskLockedView): boolean {
  return full.servers.length === 0 && view !== 'time';
}

/** Whether *This Whombat* takes the servers' and tiles' place (DK-22): none of either, and not *Only the time*. */
export function boxShown(full: FullGlance, view: DeskLockedView): boolean {
  return full.tiles.length === 0 && boxWanted(full, view);
}

/**
 * What the screen may show now (DK-03): unlocked, everything; locked, what the person chose. `box` is the box's figures
 * when the manager answered: on a glance without servers and tiles in `box`, as since 0.101 (DK-22); beside tiles in
 * `self` (0.104, DK-39), which a console from before ignores; never beside servers (DK-100) nor in *Only the time*. The
 * first four servers and tiles go where they always did, the next four in `extraServers` and `extraTiles` (DK-41,
 * DK-42). `found` (0.110, desk-found.md DF-06, DF-11) shows locked and unlocked alike, never in *Only the time*; the
 * console places it.
 */
export function trimGlance(
  full: FullGlance,
  lock: {
    unlocked: boolean;
    view: DeskLockedView;
    /** The screen has a PIN: a risky ask may be approved with it (DK-62, DK-S62). */
    hasPin?: boolean;
    /** Whether the ask with this number was made in Talk's open conversation (DK-S62). */
    inTalk?: (number: number) => boolean;
  },
  box: DeskBox | null = null,
  found: DeskFound | null = null,
): DeskGlance {
  const view: DeskLockedView = lock.unlocked ? 'everything' : lock.view;
  const fresh = glanceFresh(full);
  const status = deskStatusLine({
    view,
    needsYou: full.askCount,
    worst: full.worst,
    doing: full.doing,
    firstAsk: full.asks[0]?.title ?? null,
    fresh,
  });
  const titles = view === 'everything';
  const figures = view !== 'time';
  const items = !titles
    ? []
    : full.asks.slice(0, MAX_ASKS).map((ask) => {
        const { choices, ...rest } = ask;
        const withPin = ask.kind === 'approval' && !ask.onDesk && lock.hasPin === true;
        const a: DeskAsk = {
          ...rest,
          ...(withPin ? { approveWithPin: true } : {}),
          ...(lock.inTalk?.(ask.number) ? { inTalk: true } : {}),
          // The wider answers only unlocked, on an ask the screen may approve, with a PIN to type (TF-14, CT-890).
          ...(choices?.length && lock.unlocked && lock.hasPin === true && (ask.onDesk || withPin)
            ? { choices }
            : {}),
        };
        if (lock.unlocked) return a;
        const { detail: _d, facts: _f, approveLabel: _l, ...shown } = a;
        return shown;
      });
  // The muted part names the first ask in *Everything*; a new box's is how to connect something, shown in a summary too.
  const more = titles || fresh ? screenText(status.more, 200) : '';
  const servers = figures ? full.servers : [];
  const tiles = figures ? full.tiles : [];
  // What needs a look (DK-93, DK-S111): with the cards, never in *Only the time*; what the assistant found out only where
  // titles show (look-research.md LR-09).
  const looks = figures ? full.looks.map((l) => (titles ? l : withoutResearch(l))) : [];
  const extraServers = servers.slice(MAX_SERVERS, MAX_SERVERS + MAX_EXTRA);
  const extraTiles = tiles.slice(MAX_TILES, MAX_TILES + MAX_EXTRA);
  return {
    status: {
      text: screenText(status.text, 200) || DESK_WORDS.status.allFine,
      ...(more ? { more } : {}),
    },
    needsYou: { count: full.askCount, items, ...(looks.length > 0 ? { looks } : {}) },
    working: titles ? full.working : null,
    done: titles ? full.done : [],
    servers: servers.slice(0, MAX_SERVERS),
    moreServers: Math.max(0, servers.length - MAX_SERVERS),
    ...(extraServers.length > 0 ? { extraServers } : {}),
    tiles: tiles.slice(0, MAX_TILES),
    ...(extraTiles.length > 0 ? { extraTiles } : {}),
    ...(box && boxShown(full, view) ? { box } : box && boxWanted(full, view) ? { self: box } : {}),
    ...(found && figures ? { found } : {}),
  };
}

/** A look without the assistant's words. */
function withoutResearch(look: DeskLook): DeskLook {
  const { research: _r, ...rest } = look;
  return rest;
}

/** The person as the screen draws them (“Unlock as John”, a round initial in their tone). */
export function deskPerson(person: Pick<PrincipalRow, 'name' | 'kind' | 'shortName' | 'tone'>) {
  const name = screenText(shortName(person as PrincipalRow), 40) || screenText(person.name, 40) || 'You';
  // At most two code points: some letters capitalise to more (“ﬃ” to “FFI”).
  const initial = Array.from(Array.from(name)[0]?.toUpperCase() ?? '?')
    .slice(0, 2)
    .join('');
  return { name, initial, tone: deskToneOf(person.tone ?? '') };
}
