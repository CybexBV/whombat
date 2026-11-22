/**
 * The approval card for what an outsiders' run proposes (an automation started by an email). The card is the only thing
 * between a stranger's email and the person's services, so it shows everything that decides what happens — the
 * connection, the method and path or the tool, the base, the uploaded file, every argument however deep, every header
 * — with only secrets masked, and when that doesn't fit on one card the proposal is refused. Nothing is ever cut.
 *
 * The same reading of the arguments finds what an outsiders' run may never propose: deleting, removing or emptying
 * anything, whatever the call is named or wherever in its arguments it says so.
 */
import { catalogEntry } from '@whombat/core';
import { asQuestion } from '../approvals/create';
import { ConnectionArgumentError } from '../connections/request';
import type { ConnectionToolRow } from '../connections/types';
import { actionWords } from './action-words';

/** The longest line a card shows (an approval's WHAT HAPPENS item). */
export const CARD_LINE_MAX = 280;
/** The most lines one card shows, and the most characters all of them hold together. */
export const CARD_LINES_MAX = 48;
export const CARD_TEXT_MAX = 6000;
/** How deep inside the arguments a value may sit, and how many values they may hold, and still be read. */
const DEPTH_MAX = 12;
const VALUES_MAX = 500;
/** The longest title an approval has. */
const TITLE_MAX = 160;

/** What the agent hears when the proposal can't be shown in full. */
export const TOO_MUCH_FOR_ONE_CARD = 'Too much to show on one card: propose fewer or smaller actions.';

/* Words ------------------------------------------------------------------------------------------ */

/** The words of a name or value, in lower case: `deleteFile`, `purge_cache`, `clients/delete`, `pool.dataset.delete`. */
export function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that mean deleting, removing or emptying something. */
const DELETING: ReadonlySet<string> = new Set([
  'delete',
  'deletes',
  'deletion',
  'del',
  'remove',
  'removes',
  'removal',
  'rm',
  'rmdir',
  'purge',
  'trash',
  'clear',
  'reset',
  'wipe',
  'destroy',
  'unlink',
  'erase',
  'drop',
  'empty',
  'flush',
  'truncate',
]);

/** Of those, the ones that switch deleting on wherever they sit in a key's name (`force_delete`, `hardDelete`). */
const DELETING_ANYWHERE: ReadonlySet<string> = new Set([
  'delete',
  'deletion',
  'purge',
  'wipe',
  'destroy',
  'erase',
  'trash',
  'unlink',
  'rm',
  'rmdir',
  'truncate',
]);

/** Words of a key that says what a call does: `method`, `action`, `op`, `bulkAction`, `operationType`, `api`. */
const DOING_KEYS: ReadonlySet<string> = new Set([
  'method',
  'action',
  'actions',
  'operation',
  'operations',
  'op',
  'ops',
  'command',
  'commands',
  'cmd',
  'type',
  'mode',
  'verb',
  'api',
  'intent',
]);

/** Keys whose value is code or a statement a service runs: read whole for deleting words. */
const CODE_KEYS: ReadonlySet<string> = new Set([
  'code',
  'script',
  'sql',
  'javascript',
  'js',
  'python',
  'shell',
  'bash',
  'mutation',
]);

/** Words of a key whose value is a secret: masked on the card. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'secret',
  'secrets',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'bearer',
  'apikey',
  'privatekey',
]);
const SECRET_JOINED = /apikey|privatekey|accesskey|secretkey|sessionid|clientsecret/;

/** Whether a key (an argument, a header) names a secret: a token, a password, an API key, an authorization header. */
export function isSecretKey(key: string): boolean {
  const words = wordsOf(key);
  return words.some((w) => SECRET_WORDS.has(w)) || SECRET_JOINED.test(words.join(''));
}

/* Reading the arguments -------------------------------------------------------------------------- */

type Plain = string | number | boolean | null;

/** One value of a call's arguments and where it sits (`body.documents`, `headers.Dropbox-API-Arg.path`). */
interface ArgValue {
  path: string;
  /** The last key on its path (a list's items keep their list's key). */
  key: string;
  /** A plain value, a list of plain values, or an empty object or list. */
  value: unknown;
  /** The secret key it sits under (shown masked as one line), or null. */
  secret: string | null;
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

function read(
  value: unknown,
  path: string,
  key: string,
  secret: string | null,
  depth: number,
  out: Reading,
): void {
  if (value === undefined || out.overflow) return;
  if (depth > DEPTH_MAX || out.values.length >= VALUES_MAX) {
    out.overflow = true;
    return;
  }
  if (isPlain(value) || (Array.isArray(value) && value.every(isPlain))) {
    out.values.push({ path, key, value, secret });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      read(item, `${path}[${i}]`, key, secret, depth + 1, out);
    });
    return;
  }
  if (typeof value !== 'object') {
    // Nothing JSON holds besides these; shown as text rather than dropped.
    out.values.push({ path, key, value: String(value), secret });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) {
    out.values.push({ path, key, value, secret });
    return;
  }
  for (const [k, v] of entries) {
    const at = childPath(path, k);
    read(v, at, k, secret ?? (isSecretKey(k) ? at : null), depth + 1, out);
  }
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
      read(v, childPath('', k), k, isSecretKey(k) ? childPath('', k) : null, 1, out);
    }
    return out;
  }
  read(args.query, 'query', 'query', null, 1, out);
  if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    for (const [name, value] of Object.entries(args.headers as Record<string, unknown>)) {
      const at = childPath('headers', name);
      const secret = isSecretKey(name) ? at : null;
      const json = typeof value === 'string' && /^\s*[[{]/.test(value) ? parsedJson(value) : null;
      read(json ?? value, at, name, secret, 2, out);
    }
  } else read(args.headers, 'headers', 'headers', null, 1, out);
  const body = args.body;
  if (typeof body === 'string') {
    const type = headerValue(args.headers, 'content-type');
    const json = readsAsJson(body, type) ? parsedJson(body) : null;
    if (json) read(json, 'body', 'body', null, 1, out);
    else if (/x-www-form-urlencoded/i.test(type) || (!type && FORM_TEXT.test(body))) {
      for (const [k, v] of new URLSearchParams(body)) {
        const at = childPath('body', k);
        read(v, at, k, isSecretKey(k) ? at : null, 2, out);
      }
    } else read(body, 'body', 'body', null, 1, out);
  } else read(body, 'body', 'body', null, 1, out);
  const upload = args.upload;
  if (upload && typeof upload === 'object' && !Array.isArray(upload)) {
    for (const [k, v] of Object.entries(upload as Record<string, unknown>)) {
      // The file itself is its own line, by name.
      if (k === 'attachmentId' || k === 'field') continue;
      read(v, childPath('upload', k), k, isSecretKey(k) ? childPath('upload', k) : null, 2, out);
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (REQUEST_ARGS.has(k)) continue;
    read(v, childPath('', k), k, isSecretKey(k) ? childPath('', k) : null, 1, out);
  }
  return out;
}

/* What an outsiders' run may never propose ------------------------------------------------------- */

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const truthy = (v: unknown) =>
  v === true || v === 1 || (typeof v === 'string' && TRUTHY.has(v.toLowerCase()));

function deletingIn(texts: readonly unknown[]): string | null {
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    const found = wordsOf(t).find((w) => DELETING.has(w));
    if (found) return found;
  }
  return null;
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The word that makes a call delete, remove or empty something, or null: in the tool's name, a path segment, the value
 * of a key that says what the call does (`method: "delete"`, `op: "remove"`, `api: "SYNO.FileStation.Delete"`), a key
 * that switches deleting on (`deleteFiles: true`, `delete_originals: "true"`), or code a service runs (a GraphQL
 * mutation, SQL) — in nested values, raw JSON or form bodies and JSON headers alike.
 */
export function deletingWord(
  tool: Pick<ConnectionToolRow, 'name' | 'origin'>,
  args: Readonly<Record<string, unknown>>,
): string | null {
  const named = deletingIn([tool.name]);
  if (named) return named;
  if (tool.origin === 'request' && typeof args.path === 'string') {
    const inPath = deletingIn(args.path.split('/').map(decoded));
    if (inPath) return inPath;
  }
  for (const v of readArgs(tool.origin, args).values) {
    const keyWords = wordsOf(v.key);
    const texts = Array.isArray(v.value) ? v.value : [v.value];
    if (keyWords.some((w) => DOING_KEYS.has(w))) {
      const found = deletingIn(texts);
      if (found) return found;
    }
    if (
      truthy(v.value) &&
      ((keyWords[0] && DELETING.has(keyWords[0])) || keyWords.some((w) => DELETING_ANYWHERE.has(w)))
    )
      return keyWords.find((w) => DELETING.has(w)) ?? null;
    const code =
      keyWords.some((w) => CODE_KEYS.has(w)) ||
      (v.key === 'query' && typeof v.value === 'string' && /^\s*mutation\b/i.test(v.value));
    if (code) {
      const found = deletingIn(texts);
      if (found) return found;
    }
  }
  // A socket's method is read apart from its arguments.
  if (tool.origin === 'socket' && typeof args.method === 'string') return deletingIn([args.method]);
  return null;
}

/* The card ---------------------------------------------------------------------------------------- */

function shown(value: unknown): string {
  if (typeof value === 'string') return quoted(value);
  if (Array.isArray(value)) return `[${value.map(shown).join(', ')}]`;
  if (value && typeof value === 'object') return '{}';
  return String(value);
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

/**
 * One validated action as the card shows it: Whombat's words, then the method and path (or socket method, or tool),
 * the base, the uploaded file, every argument as `where: value` (secrets masked), and the agent's own note last.
 * `uploadFileName` is the attachment's name; `summary` the agent's words, shown only as its note.
 */
export function describePlannedAction(input: {
  catalogId: string;
  label: string;
  tool: Pick<ConnectionToolRow, 'name' | 'origin'>;
  args: Readonly<Record<string, unknown>>;
  uploadFileName?: string | null;
  summary?: string;
}): DescribedAction {
  const { tool, args } = input;
  const label = input.label.replace(/\s+/g, ' ').trim() || 'the service';
  const words = actionWords({ catalogId: input.catalogId, label, tool: tool.name, args });
  const lines = [words.ask];
  if (tool.origin === 'request') {
    lines.push(`Request: ${visible(String(args.method ?? ''))} ${visible(String(args.path ?? ''))}`);
    if (typeof args.base === 'string' && args.base) {
      const bases = catalogEntry(input.catalogId)?.request?.bases ?? {};
      const url = Object.hasOwn(bases, args.base) ? bases[args.base] : undefined;
      lines.push(`Base: ${quoted(args.base)}${url ? ` (${visible(url)})` : ''}`);
    }
    const upload = args.upload as { field?: unknown } | undefined;
    if (upload && typeof upload === 'object')
      lines.push(
        `File from this email: ${quoted(input.uploadFileName ?? '')}, sent as form field ${quoted(String(upload.field ?? ''))}`,
      );
  } else if (tool.origin === 'socket') lines.push(`Method: ${visible(String(args.method ?? ''))}`);
  else lines.push(`Tool: ${visible(tool.name)}`);
  const reading = readArgs(tool.origin, args);
  const masked = new Set<string>();
  for (const v of reading.values) {
    if (v.secret) {
      if (!masked.has(v.secret)) lines.push(`${v.secret}: hidden (it looks like a password or key)`);
      masked.add(v.secret);
    } else lines.push(`${v.path}: ${shown(v.value)}`);
  }
  const note = (input.summary ?? '').replace(/\s+/g, ' ').trim();
  if (note) lines.push(`Agent’s note: ${quoted(note)}`);
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
