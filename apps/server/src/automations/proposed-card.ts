/**
 * The approval card for what an outsiders' run proposes (an automation started by an email). The card is the only thing
 * between a stranger's email and the person's services, so it shows everything that decides what happens — the
 * connection, the method and path or the tool, the base, the email's file, every argument however deep, every header
 * — and hides nothing (an outsiders' run can't propose a value named like a password or key: `listed-actions.ts`). A
 * value too long for one line goes on as numbered parts; when the whole doesn't fit on one card the proposal is
 * refused. Nothing is ever cut.
 */
import { catalogEntry } from '@whombat/core';
import { asQuestion } from '../approvals/create';
import { ConnectionArgumentError, formatBytes } from '../connections/request';
import type { ConnectionToolRow } from '../connections/types';
import { listedWords } from './listed-actions';

/** The longest line a card shows (an approval's WHAT HAPPENS item, AR-D02). */
export const CARD_LINE_MAX = 280;
/**
 * The most lines one card shows, and the most characters all of them hold together: room for a ten-line invoice beside
 * an upload, or a long note, and still something a person reads before saying yes.
 */
export const CARD_LINES_MAX = 200;
export const CARD_TEXT_MAX = 30_000;
/** How deep inside the arguments a value may sit, and how many values they may hold, and still be read. */
const DEPTH_MAX = 12;
const VALUES_MAX = 500;
/** The longest title an approval has. */
const TITLE_MAX = 160;

/** What the agent hears when the proposal can't be shown in full. */
export const TOO_MUCH_FOR_ONE_CARD = `Too much to show on one card (at most ${CARD_LINES_MAX} lines): propose fewer or shorter actions.`;

/* Reading the arguments -------------------------------------------------------------------------- */

type Plain = string | number | boolean | null;

/** One value of a call's arguments and where it sits (`body.documents`, `headers.Dropbox-API-Arg.path`). */
interface ArgValue {
  path: string;
  /** The last key on its path (a list's items keep their list's key). */
  key: string;
  /** A plain value, a list of plain values, or an empty object or list. */
  value: unknown;
}

interface Reading {
  values: ArgValue[];
  /** The arguments went deeper, or held more, than the card reads. */
  overflow: boolean;
}

const isPlain = (v: unknown): v is Plain =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Control characters, bidirectional overrides, invisible spaces and line separators: they could disguise a value. */
function isHiddenChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x61c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

/** A text as written, with characters that could disguise it shown as escapes (a path, a method, a tool's name). */
export function visible(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += ch.length === 1 && isHiddenChar(code) ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

/** A text in quotes, with quotes, line breaks and characters that could disguise it escaped: plainly one value. */
export function quoted(text: string): string {
  return visible(JSON.stringify(text));
}

const SIMPLE_KEY = /^[A-Za-z0-9_$-]{1,64}$/;

function childPath(path: string, key: string): string {
  if (!SIMPLE_KEY.test(key)) return `${path}[${quoted(key)}]`;
  return path ? `${path}.${key}` : key;
}

function read(value: unknown, path: string, key: string, depth: number, out: Reading): void {
  if (value === undefined || out.overflow) return;
  if (depth > DEPTH_MAX || out.values.length >= VALUES_MAX) {
    out.overflow = true;
    return;
  }
  if (isPlain(value) || (Array.isArray(value) && value.every(isPlain))) {
    out.values.push({ path, key, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      read(item, `${path}[${i}]`, key, depth + 1, out);
    });
    return;
  }
  if (typeof value !== 'object') {
    // Nothing JSON holds besides these; shown as text rather than dropped.
    out.values.push({ path, key, value: String(value) });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) {
    out.values.push({ path, key, value });
    return;
  }
  for (const [k, v] of entries) read(v, childPath(path, k), k, depth + 1, out);
}

/** A raw text body sent as a form (`a=1&b=2`): every field, duplicates included. */
const FORM_TEXT = /^[^=&\s]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*$/;

function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  const found = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === name);
  return typeof found?.[1] === 'string' ? found[1] : '';
}

/** Whether a raw text body is read as JSON: its Content-Type says so, or there is none and it looks like JSON. */
function readsAsJson(body: string, contentType: string): boolean {
  if (contentType) return /json/i.test(contentType);
  return /^\s*[[{]/.test(body);
}

function parsedJson(text: string): object | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** A number JSON can't hold exactly (a Moneybird id written without quotes): shown and sent differently. */
function hasInexactNumber(value: unknown, depth = 0): boolean {
  if (depth > DEPTH_MAX) return false;
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some((v) => hasInexactNumber(v, depth + 1));
  return false;
}

/**
 * A proposed `request` call's arguments as they are shown and sent: a body written as JSON text becomes the JSON it
 * says (so what runs is exactly what the card shows, duplicate keys and all), and a header holding JSON (Dropbox's
 * `Dropbox-API-Arg`) is written out again the same way. Throws `ConnectionArgumentError` for a number too large to
 * send exactly.
 */
export function settledRequestArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const inexact = () =>
    new ConnectionArgumentError(
      'A number in this request is too large to send exactly: write it as text, in quotes.',
    );
  if (typeof args.body === 'string' && readsAsJson(args.body, headerValue(args.headers, 'content-type'))) {
    const parsed = parsedJson(args.body);
    if (parsed) {
      if (hasInexactNumber(parsed)) throw inexact();
      out.body = parsed;
    }
  } else if (hasInexactNumber(args.body)) throw inexact();
  if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    const headers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(args.headers as Record<string, unknown>)) {
      const parsed = typeof value === 'string' && /^\s*[[{]/.test(value) ? parsedJson(value) : null;
      if (parsed && hasInexactNumber(parsed)) throw inexact();
      headers[name] = parsed ? JSON.stringify(parsed) : value;
    }
    out.headers = headers;
  }
  return out;
}

const REQUEST_ARGS = new Set(['method', 'path', 'base', 'query', 'headers', 'body', 'upload']);

/** Every value of a call's arguments, raw text bodies and JSON headers read as what they hold. */
function readArgs(origin: ConnectionToolRow['origin'], args: Readonly<Record<string, unknown>>): Reading {
  const out: Reading = { values: [], overflow: false };
  if (origin !== 'request') {
    // The socket's method is on its own line; everything else is read as it is.
    for (const [k, v] of Object.entries(args)) {
      if (origin === 'socket' && k === 'method') continue;
      read(v, childPath('', k), k, 1, out);
    }
    return out;
  }
  read(args.query, 'query', 'query', 1, out);
  if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    for (const [name, value] of Object.entries(args.headers as Record<string, unknown>)) {
      const json = typeof value === 'string' && /^\s*[[{]/.test(value) ? parsedJson(value) : null;
      read(json ?? value, childPath('headers', name), name, 2, out);
    }
  } else read(args.headers, 'headers', 'headers', 1, out);
  const body = args.body;
  if (typeof body === 'string') {
    const type = headerValue(args.headers, 'content-type');
    const json = readsAsJson(body, type) ? parsedJson(body) : null;
    if (json) read(json, 'body', 'body', 1, out);
    else if (/x-www-form-urlencoded/i.test(type) || (!type && FORM_TEXT.test(body))) {
      for (const [k, v] of new URLSearchParams(body)) read(v, childPath('body', k), k, 2, out);
    } else read(body, 'body', 'body', 1, out);
  } else read(body, 'body', 'body', 1, out);
  const upload = args.upload;
  if (upload && typeof upload === 'object' && !Array.isArray(upload)) {
    for (const [k, v] of Object.entries(upload as Record<string, unknown>)) {
      // The file itself is its own line, by name.
      if (k === 'attachmentId' || k === 'field') continue;
      read(v, childPath('upload', k), k, 2, out);
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (REQUEST_ARGS.has(k)) continue;
    read(v, childPath('', k), k, 1, out);
  }
  return out;
}

/* The card ---------------------------------------------------------------------------------------- */

function shown(value: unknown): string {
  if (typeof value === 'string') return quoted(value);
  if (Array.isArray(value)) return `[${value.map(shown).join(', ')}]`;
  if (value && typeof value === 'object') return '{}';
  return String(value);
}

/**
 * A value as the card's lines: `where: value` on one line, else a list item by item, else a text in numbered parts
 * (`where (part 1 of 3): "…"`), each part quoted and whole, broken after a space where one is near.
 */
export function valueLines(where: string, value: unknown): string[] {
  const one = `${where}: ${shown(value)}`;
  if (one.length <= CARD_LINE_MAX) return [one];
  if (Array.isArray(value)) return value.flatMap((v, i) => valueLines(`${where}[${i}]`, v));
  if (typeof value !== 'string') return [one];
  // Room for a part's text once its label and quotes are on the line, whatever its number.
  const room = CARD_LINE_MAX - `${where} (part 9999 of 9999): ""`.length;
  if (room < 40) return [one];
  const parts: string[] = [];
  let part: string[] = [];
  let size = 0;
  let space = -1;
  for (const ch of value) {
    const width = quoted(ch).length - 2;
    if (size + width > room) {
      // Break after the last space when it isn't far back, so words stay whole.
      const cut = space >= 0 && space >= part.length - 40 ? space + 1 : part.length;
      parts.push(part.slice(0, cut).join(''));
      part = part.slice(cut);
      size = part.reduce((n, c) => n + quoted(c).length - 2, 0);
      space = -1;
      part.forEach((c, i) => {
        if (/\s/.test(c)) space = i;
      });
    }
    part.push(ch);
    size += width;
    if (/\s/.test(ch)) space = part.length - 1;
  }
  if (part.length) parts.push(part.join(''));
  return parts.map((p, i) => `${where} (part ${i + 1} of ${parts.length}): ${quoted(p)}`);
}

/** One proposed action as the card shows it. */
export interface DescribedAction {
  /** Whombat's own words for it (“Upload a document to Paperless-ngx”): a single action's title, the Chat line. */
  ask: string;
  /** What the thread says once it ran (“uploaded a document to Paperless-ngx”). */
  done: string;
  /** Every line the card shows for it, the words first. */
  lines: string[];
  /** Its arguments went deeper or held more than a card reads: it can't be shown in full. */
  overflow: boolean;
}

/** The email's file a call sends, as the card names it. */
export interface CardFile {
  name: string;
  contentType: string;
  size: number;
}

/** The lines for the email's file: its name, type and size, and how it is sent. */
function fileLines(file: CardFile | null | undefined, field: unknown): string[] {
  const how =
    typeof field === 'string' ? `sent as form field ${quoted(field)}` : 'sent as the whole request body';
  const kind = `${visible(file?.contentType || 'unknown type')}, ${formatBytes(file?.size ?? 0)}`;
  const one = `File from this email: ${quoted(file?.name ?? '')} (${kind}), ${how}`;
  if (one.length <= CARD_LINE_MAX) return [one];
  return [
    ...valueLines('File from this email', file?.name ?? ''),
    `File type and size: ${kind}`,
    `File ${how}`,
  ];
}

/**
 * One validated action as the card shows it: Whombat's words, then the method and path (or socket method, or tool),
 * the base, the email's file, every argument as `where: value`, and the agent's own note last. `uploadFile` is the
 * email's file the call sends; `summary` the agent's words, shown only as its note.
 */
export function describePlannedAction(input: {
  catalogId: string;
  label: string;
  tool: Pick<ConnectionToolRow, 'name' | 'origin'>;
  args: Readonly<Record<string, unknown>>;
  uploadFile?: CardFile | null;
  summary?: string;
}): DescribedAction {
  const { tool, args } = input;
  const label = input.label.replace(/\s+/g, ' ').trim() || 'the service';
  const words = listedWords({ catalogId: input.catalogId, label, tool, args });
  const lines = [words.ask];
  if (tool.origin === 'request') {
    lines.push(`Request: ${visible(String(args.method ?? ''))} ${visible(String(args.path ?? ''))}`);
    if (typeof args.base === 'string' && args.base) {
      const bases = catalogEntry(input.catalogId)?.request?.bases ?? {};
      const url = Object.hasOwn(bases, args.base) ? bases[args.base] : undefined;
      lines.push(`Base: ${quoted(args.base)}${url ? ` (${visible(url)})` : ''}`);
    }
    const upload = args.upload as { field?: unknown } | undefined;
    if (upload && typeof upload === 'object') lines.push(...fileLines(input.uploadFile, upload.field));
  } else if (tool.origin === 'socket') lines.push(`Method: ${visible(String(args.method ?? ''))}`);
  else lines.push(`Tool: ${visible(tool.name)}`);
  const reading = readArgs(tool.origin, args);
  for (const v of reading.values) lines.push(...valueLines(v.path, v.value));
  const note = (input.summary ?? '').replace(/\s+/g, ' ').trim();
  if (note) lines.push(...valueLines('Agent’s note', note));
  return { ask: words.ask, done: words.done, lines, overflow: reading.overflow };
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The approval card for a batch of described actions, or why it can't be one. */
export type ProposalCard =
  | {
      ok: true;
      title: string;
      /** Whombat's own question: never taken from anything the agent or the email wrote. */
      question: string;
      /** Every line, in order; the batch's full description. */
      whatHappens: string[];
      details: string;
      summary: string;
      cardText: string;
    }
  | { ok: false; reason: string };

/**
 * The card for a batch: every action's lines (“Action 1 of 2: …” before each one's words when there are several), all
 * of them or none — a line too long, too many lines or too much text refuses the batch with `TOO_MUCH_FOR_ONE_CARD`.
 */
export function proposalCard(actions: readonly (DescribedAction & { label: string })[]): ProposalCard {
  const n = actions.length;
  const whatHappens = actions.flatMap((a, i) =>
    n > 1 ? [`Action ${i + 1} of ${n}: ${a.lines[0]}`, ...a.lines.slice(1)] : a.lines,
  );
  const text = whatHappens.reduce((sum, line) => sum + line.length, 0);
  if (
    actions.some((a) => a.overflow) ||
    whatHappens.length > CARD_LINES_MAX ||
    text > CARD_TEXT_MAX ||
    whatHappens.some((line) => line.length > CARD_LINE_MAX || !line.trim())
  )
    return { ok: false, reason: TOO_MUCH_FOR_ONE_CARD };
  const labels = [...new Set(actions.map((a) => a.label.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const many = `Make ${n} changes in ${joinList(labels)}`;
  const title =
    n === 1
      ? (actions[0]?.ask ?? '')
      : many.length <= TITLE_MAX
        ? many
        : `Make ${n} changes in your connected services`;
  if (!title || title.length > TITLE_MAX) return { ok: false, reason: TOO_MUCH_FOR_ONE_CARD };
  const asks = actions.map((a) => a.ask);
  return {
    ok: true,
    title,
    question: asQuestion(title),
    whatHappens,
    details: whatHappens.join('\n'),
    summary: `${title}.`,
    cardText:
      n === 1
        ? `I need your yes before I ${lowerFirst(title)}.`
        : `I need your yes before I make these ${n} changes:\n${asks.map((a) => `• ${a}`).join('\n')}`,
  };
}

/** What the thread says once approved actions ran: “Done: uploaded a document to Paperless-ngx.” */
export function actionsDoneLine(actions: readonly { done: string; label: string }[]): string {
  if (actions.length === 0) return 'Done.';
  const line = `Done: ${joinList(actions.map((a) => a.done))}.`;
  if (line.length <= 1000) return line;
  const labels = [...new Set(actions.map((a) => a.label))];
  return `Done: made ${actions.length} changes in ${joinList(labels)}.`;
}
