/**
 * What the scripted Hermes reads in a turn and what it does about it (docs/decisions/hermes-engine.md HE-33,
 * HE-S100…HE-S109). It knows only what Hermes knows: the turn's prompt, which carries the facts a live agent needs too
 * (ids, run numbers, the search's results, the request), and the agent's name from the profile's `SOUL.md`. Pure.
 *
 * Node runs the scripted Hermes as TypeScript (type stripping): this file imports types only, so a quick reply starts
 * without loading `@whombat/core` (about 100 ms a turn); the few time helpers it needs are here.
 */
import type { CalendarEvent, MailSummary } from '@whombat/core';

/** A mention or a Chat message gets this after a moment of thinking (the mock's `sendDraft`). */
export const CANNED_REPLY = 'On it. I’ll post back here when I have something worth reading.';
/** A declined approval: the agent acknowledges and holds off. */
export const DECLINED_REPLY = 'Understood. I’ll hold off.';
/** The mock's thinking time before a reply. */
export const THINK_MS = 1600;
/** The mock's time between two LIVE lines of the storyline run (`LIVE_STEP_INTERVAL_MS`). */
export const TICK_MS = 2600;

/** A search result as the prompt lists it (`- id · TYPE · where · snippet`). */
export interface ResultFacts {
  id: string;
  type: string;
  /** Its first part (“#incidents”, “PR #311”). */
  where: string;
  /** Everything after the type: where and the snippet. */
  text: string;
}

export interface RunFacts {
  number: number;
  title: string;
  branch: string;
  steps: { title: string; state: string }[];
  /** The run's latest line (`Latest: …`). */
  activity: string;
}

export interface TurnFacts {
  /** The agent's own name (`SOUL.md`: “You are Dusty, Mara’s agent in Whombat…”). */
  agentName: string | null;
  conversationId: string | null;
  /** The room is a pull request's (its topic names `PR #n`). */
  prNumber: number | null;
  timeZone: string | null;
  /** The burrow's time now, from the prompt's first line; null when it has none. */
  now: Date | null;
  search: { query: string; answerId: string; results: ResultFacts[] } | null;
  run: RunFacts | null;
  /** What a person (or an automation) asks, and who. Null when several messages wait or nothing was asked. */
  request: { author: string; text: string } | null;
  declined: boolean;
  /** A Whombat Feedback assessment (its prompt names `submit_assessment`). */
  assessment: boolean;
}

/** Wall-clock parts of an instant in a time zone (`@whombat/core/text`'s `zonedParts`). */
function zonedParts(input: Date | number | string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(input));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** `11:22` in the zone (`formatClock`). */
function formatClock(input: Date | string, timeZone: string): string {
  const p = zonedParts(input, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The instant a local calendar day starts in a time zone. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  const p = zonedParts(guess, timeZone);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(guess - (local - guess));
}

/** “It is Wednesday 23 Sep 2026, 11:22 in Europe/Amsterdam; …” → the zone and the instant. */
function nowOf(prompt: string): { timeZone: string; now: Date } | null {
  const m = /It is \S+ (\d{1,2}) (\w{3}) (\d{4}), (\d{1,2}):(\d{2}) in ([^;\s]+);/.exec(prompt);
  if (!m) return null;
  const [, day, month, year, hour, minute, timeZone] = m as unknown as string[];
  const mi = MONTHS.indexOf(month as string);
  if (mi < 0 || !timeZone) return null;
  try {
    const midnight = zonedMidnight(Number(year), mi + 1, Number(day), timeZone);
    return { timeZone, now: new Date(midnight.getTime() + (Number(hour) * 60 + Number(minute)) * 60_000) };
  } catch {
    return null;
  }
}

/** The search question, its results and the answer's id. */
function searchOf(prompt: string): TurnFacts['search'] {
  const answerId = /\bpost_answer \(answerId ([^)\s]+)\)/.exec(prompt)?.[1];
  if (!answerId) return null;
  const query = /^Search question from .*?: “([\s\S]*?)”$/m.exec(prompt)?.[1] ?? '';
  const results: ResultFacts[] = [];
  for (const m of prompt.matchAll(/^- (\S+) · ([A-Z]+) · (.*)$/gm)) {
    const text = m[3] ?? '';
    results.push({ id: m[1] as string, type: m[2] as string, where: text.split(' · ')[0] ?? text, text });
  }
  return { query, answerId, results };
}

/** “Your run #1907 “title” on feat/x is live…”, its steps and its latest line. */
function runOf(prompt: string): RunFacts | null {
  const m = /Your run #(\d+) “([\s\S]*?)” on (\S+) is live/.exec(prompt);
  if (!m) return null;
  const stepsLine = /^Steps: (.*)$/m.exec(prompt)?.[1] ?? '';
  const steps = [...stepsLine.matchAll(/(?:^|; )\d+\. (.*?) \((\w+)\)(?=; \d+\. |$)/g)].map((s) => ({
    title: s[1] as string,
    state: s[2] as string,
  }));
  return {
    number: Number(m[1]),
    title: m[2] as string,
    branch: m[3] as string,
    steps,
    activity: /^Latest: (.*)$/m.exec(prompt)?.[1] ?? '',
  };
}

/** A message line's text: `[11:36] Mara: text (2 replies in thread) (id msg_x)` → `text`. */
function messageText(line: string): { author: string; text: string } | null {
  const m = /^\[\d{1,2}:\d{2}\] (.+?)(?: \(in the thread of \S+\))?: ([\s\S]*)$/.exec(line);
  if (!m) return null;
  const text = (m[2] as string)
    .replace(/ \(id [^)\s]+\)$/, '')
    .replace(/ \(\d+ repl(?:y|ies) in thread\)$/, '')
    .replace(/ \(edited\)$/, '')
    .trim();
  return { author: m[1] as string, text };
}

/** The message shown above with this id, from its line in the window or thread. */
function shownMessage(prompt: string, id: string): { author: string; text: string } | null {
  const end = prompt.lastIndexOf(`(id ${id})`);
  if (end < 0) return null;
  // Its line, or its lines for a message of several: back to the line that starts it.
  const lines = prompt.slice(0, end + `(id ${id})`.length).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\[\d{1,2}:\d{2}\] /.test(lines[i] as string)) return messageText(lines.slice(i).join('\n'));
  }
  return null;
}

/** “Mara is asking you in the message above (id msg_x).” or “… is asking you: text”. */
function requestOf(prompt: string): TurnFacts['request'] {
  const asks = [
    ...prompt.matchAll(
      /^(.+?)(?:, an automation a person set up,)? is asking you(?: in the message above \(id ([^)\s]+)\)\.|: (.*))$/gm,
    ),
  ];
  const m = asks.at(-1);
  if (!m) return null;
  const author = m[1] as string;
  if (m[2]) {
    const shown = shownMessage(prompt.slice(0, m.index), m[2]);
    return shown ? { author, text: shown.text } : null;
  }
  return { author, text: (m[3] ?? '').trim() };
}

/** What the turn's prompt and the agent's `SOUL.md` say. */
export function readTurn(prompt: string, soul = ''): TurnFacts {
  const when = nowOf(prompt);
  const conversation = /^Conversation: .*\(conversationId ([^)\s]+)\)(.*)$/m.exec(prompt);
  const pr = conversation ? /\bPR #(\d+)\b/.exec(conversation[0]) : null;
  return {
    agentName: /You are (.+?), [^,]*?agent\b/.exec(soul)?.[1] ?? null,
    conversationId: conversation?.[1] ?? /\(conversationId ([^)\s]+)\)/.exec(prompt)?.[1] ?? null,
    prNumber: pr ? Number(pr[1]) : null,
    timeZone: when?.timeZone ?? null,
    now: when?.now ?? null,
    search: searchOf(prompt),
    run: runOf(prompt),
    request: requestOf(prompt),
    declined: /\bdeclined your request\b/.test(prompt),
    assessment: /\bsubmit_assessment\b/.test(prompt),
  };
}

/* What it does ------------------------------------------------------------------------------------------------------ */

export type GuideTopic = 'email' | 'calendar' | 'files';

/** The email a “send an email to …” message asks for. */
export interface ScriptedMail {
  to: string[];
  subject: string;
  body: string;
}

export type Script =
  | { kind: 'canned'; text: string }
  | { kind: 'answer'; search: NonNullable<TurnFacts['search']> }
  | { kind: 'run'; run: RunFacts }
  | { kind: 'review_approve'; prNumber: number; conversationId: string }
  | { kind: 'assistant_inbox' }
  | { kind: 'assistant_calendar' }
  | { kind: 'assistant_send'; mail: ScriptedMail }
  | { kind: 'assistant_guide'; topic: GuideTopic }
  | { kind: 'command'; command: string };

/** What the scripted agent does with a turn. */
export function chooseScript(facts: TurnFacts): Script {
  // A Feedback assessment: the stand-in has no assessment to give, so it says the canned line (FB-21: the report fails).
  if (facts.assessment) return { kind: 'canned', text: CANNED_REPLY };
  if (facts.search) return { kind: 'answer', search: facts.search };
  if (facts.run) return { kind: 'run', run: facts.run };
  const request = facts.request;
  // Woken in a pull request's room by someone else's push (one-agent.md OA-15: the review is a turn of its own).
  if (
    facts.prNumber !== null &&
    facts.conversationId &&
    request?.text.startsWith('Pushed ') &&
    request.author !== facts.agentName
  )
    return { kind: 'review_approve', prNumber: facts.prNumber, conversationId: facts.conversationId };
  if (facts.declined) return { kind: 'canned', text: DECLINED_REPLY };
  if (!request) return { kind: 'canned', text: CANNED_REPLY };
  const mail = mailFromText(request.text);
  if (mail) return { kind: 'assistant_send', mail };
  const command = /\brun\s+`([^`\n]+)`/i.exec(request.text)?.[1]?.trim();
  if (command) return { kind: 'command', command };
  const text = request.text.toLowerCase();
  const guide = guideTopicFromText(text);
  if (guide) return { kind: 'assistant_guide', topic: guide };
  if (/\b(inbox|mail|emails?)\b/.test(text)) return { kind: 'assistant_inbox' };
  if (/\b(calendar|agenda|meetings?|schedule)\b/.test(text)) return { kind: 'assistant_calendar' };
  return { kind: 'canned', text: CANNED_REPLY };
}

/* The personal assistant (connectors-google-tools.md GT-12) ----------------------------------------------------------- */

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * “Send an email to a@b.com [and c@d.com] [about <subject>] [saying <body>]”: the recipients, a subject (“about …”,
 * else “A quick note”) and a body (“saying …”, else the subject). Null without “send” and an address.
 */
export function mailFromText(text: string): ScriptedMail | null {
  if (!/\bsend\b/i.test(text)) return null;
  const to = [...new Set((text.match(ADDRESS) ?? []).map((a) => a.toLowerCase()))];
  if (to.length === 0) return null;
  const clean = (s: string | undefined) =>
    (s ?? '')
      .trim()
      .replace(/[.!?]+$/, '')
      .trim();
  const body = (/\bsaying:?\s+([\s\S]+)$/i.exec(text)?.[1] ?? '').trim();
  const subject = clean(/\babout\s+(.+?)(?:\s+saying\b|$)/i.exec(text)?.[1]);
  const title = subject ? subject.charAt(0).toUpperCase() + subject.slice(1) : 'A quick note';
  return { to, subject: title, body: body || title };
}

/** “Set up my email”, “connect my calendar”: the guide to start (AG-01), or null. */
export function guideTopicFromText(text: string): GuideTopic | null {
  const t = text.toLowerCase();
  if (!/\b(set ?up|connect|hook up|link)\b/.test(t)) return null;
  if (/\b(e-?mail|mail|inbox|gmail)\b/.test(t)) return 'email';
  if (/\b(calendar|agenda|meetings?)\b/.test(t)) return 'calendar';
  if (/\b(files?|drive|docs|documents?|sheets)\b/.test(t)) return 'files';
  return null;
}

/** Gmail's search for today's inbox. */
export const INBOX_TODAY_QUERY = 'in:inbox newer_than:1d';

/** When a tool refuses (nothing connected, a lapsed connection): the fix, in the assistant's words. */
export const NOT_CONNECTED_REPLY =
  'I can’t reach your account yet. Connect Google in Settings → Connections, then ask me again.';

/** `mail_send` asked the person: where to say yes. */
export const SEND_ASKED_REPLY = 'I’ve written it. Approve the card above and I’ll send it right away.';

/** A Whombat tool's answer as the scripted agent reads it. */
export interface ToolAnswer {
  /** False on a tool error or a `blocked` outcome. */
  ok: boolean;
  /** The structured outcome (the commit outcome, or `{error: {code, message}}`). */
  body: Record<string, unknown>;
}

/** “Priya Shah” from `Priya Shah <priya@x.com>`, or the address. */
export function senderName(from: string): string {
  const name = from
    .replace(/<[^>]*>/, '')
    .replace(/"/g, '')
    .trim();
  return name || from.replace(/[<>]/g, '').trim();
}

export function inboxSummary(messages: readonly MailSummary[]): string {
  if (messages.length === 0) return 'Nothing new in your inbox today.';
  const unread = messages.filter((m) => m.unread).length;
  const n = messages.length;
  const head = `You have ${n} ${n === 1 ? 'email' : 'emails'} from today${unread ? `, ${unread} unread` : ''}:`;
  const lines = messages.map(
    (m) => `- “${m.subject || '(no subject)'}” from ${senderName(m.from)}${m.unread ? '' : ' (read)'}`,
  );
  return [head, '', ...lines, '', 'Want me to draft a reply to any of these?'].join('\n');
}

/** Start and end of tomorrow in the burrow's time zone. */
export function tomorrowBounds(now: Date, timeZone: string): { from: Date; to: Date } {
  const today = zonedParts(now, timeZone);
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const after = new Date(Date.UTC(today.year, today.month - 1, today.day + 2));
  const at = (d: Date) => zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timeZone);
  return { from: at(tomorrow), to: at(after) };
}

export function calendarSummary(events: readonly CalendarEvent[], timeZone: string): string {
  if (events.length === 0) return 'Nothing on your calendar tomorrow.';
  const lines = events.map((e) => {
    const when = e.allDay ? 'All day' : formatClock(e.start, timeZone);
    const n = e.guests.length;
    return `- ${when} · ${e.summary || '(no title)'}${n ? ` (with ${n} ${n === 1 ? 'guest' : 'guests'})` : ''}`;
  });
  const n = events.length;
  return [`Tomorrow you have ${n} ${n === 1 ? 'event' : 'events'}:`, '', ...lines].join('\n');
}

/** The reply after `mail_send`: where to approve, “Sent.”, or the refusal. */
export function sendReply(res: ToolAnswer): string {
  if (res.ok && res.body.status === 'pending_approval') return SEND_ASKED_REPLY;
  if (res.ok) return 'Sent.';
  return (res.body.error as { message?: string } | undefined)?.message ?? NOT_CONNECTED_REPLY;
}

/** The reply after `mail_search`. */
export function inboxReply(res: ToolAnswer): string {
  const messages = res.body.messages as MailSummary[] | undefined;
  return res.ok && messages ? inboxSummary(messages) : NOT_CONNECTED_REPLY;
}

/** The reply after `calendar_events`. */
export function calendarReply(res: ToolAnswer, timeZone: string): string {
  const events = res.body.events as CalendarEvent[] | undefined;
  return res.ok && events ? calendarSummary(events, timeZone) : NOT_CONNECTED_REPLY;
}
