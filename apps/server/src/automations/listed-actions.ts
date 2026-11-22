/**
 * What an outsiders' run may propose (a run started by an email, docs/decisions/automation-recipes.md): a short list of
 * create-only actions a mail automation needs, and nothing else. Each one names its connection kind, its tool (and for
 * `request`, its method and path), a strict schema for every argument (unknown keys refused, sizes bounded) and the
 * headers it may carry. The server writes the parts that keep it create-only itself — `If-None-Match: *` on a WebDAV
 * PUT, Dropbox's `mode: add`, `overwrite: false` — and sets `Content-Type`, so what the agent wrote can't replace,
 * move, delete or share anything, whatever it is called.
 */
import { AttachmentId, type CatalogEntry, REQUEST_TOOL_NAME } from '@whombat/core';
import { z } from 'zod';
import { ConnectionArgumentError, repeatedHeader } from '../connections/request';
import type { ConnectionToolRow } from '../connections/types';

type Args = Record<string, unknown>;
type Tool = Pick<ConnectionToolRow, 'name' | 'origin'>;

/** Whombat's words for a listed action: what a card asks and what the thread says once it ran. */
export interface ListedWords {
  ask: string;
  done: string;
}

interface ListedAction {
  catalogId: string;
  /** Whombat's own words, with `{label}` for the person's name of the connection. */
  ask: string;
  done: string;
  /** What it does, as the list of what a mail automation can do says it (“save a new file in Dropbox”). */
  can: string;
  /** How the agent proposes it: the tool and the arguments' shape. */
  how: string;
  tool: string;
  origin: 'request' | 'adapter';
  /** For `request`: the method and the path it takes. */
  method?: string;
  path?: RegExp;
  /** The arguments as they are sent, or why they can't be (strict: anything not listed is refused). */
  settle(args: Args, fields: Readonly<Record<string, unknown>>): Args;
}

/** Why a listed action's arguments can't be used, in words the agent can act on. */
class ListedArgumentError extends Error {}

/* Values ----------------------------------------------------------------------------------------- */

/** The longest text a value of a listed action holds: a note, a task's description, a text file. */
export const LISTED_TEXT_MAX = 10_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Text kept as written (a file's contents, a note): never trimmed, so what is sent is what the card shows. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => v.trim().length > 0, 'give some text');
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL.test(v), 'one line of text, without control characters');
const id = z.union([
  z.string().regex(/^\d{1,20}$/, 'an id: digits only'),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-22');
const decimal = z.union([
  z.string().regex(/^-?\d{1,12}([.,]\d{1,6})?$/, 'an amount like 420.00'),
  z.number().finite(),
]);
/** A file path from the root of the person's files: `/Invoices/2026/acme.pdf`. */
const filePath = z
  .string()
  .max(200)
  .regex(/^\/(?:[^/]+\/)*[^/]+$/, 'a file path from the root, like /Invoices/acme.pdf')
  .refine((p) => !CONTROL.test(p), 'a path without control characters')
  .refine((p) => !p.split('/').some((s) => s === '.' || s === '..'), 'a path without . or ..');

/** The words of a schema's first problem, with where it is: “body.purchase_invoice.reference: at most 255 characters”. */
function problemOf(error: z.ZodError, at: string): string {
  const issue = error.issues[0];
  if (!issue) return `${at || 'This action'}: not what this action takes.`;
  const where = [at, ...issue.path.map(String)].filter(Boolean).join('.');
  const of = where ? `${where}: ` : '';
  switch (issue.code) {
    case 'unrecognized_keys':
      return `${of}${issue.keys.map((k) => `“${k}”`).join(', ')} isn’t part of this action.`;
    case 'too_big':
      return issue.origin === 'string'
        ? `${of}at most ${issue.maximum} characters.`
        : `${of}at most ${issue.maximum}.`;
    case 'too_small':
      return issue.origin === 'string' ? `${of}give some text.` : `${of}at least ${issue.minimum}.`;
    case 'invalid_type':
      return issue.input === undefined ? `${of}required.` : `${of}not the right kind of value.`;
    case 'invalid_union': {
      // Say what the first kind it may be wants (“an id: digits only”), not that no kind matched.
      const inner = issue.errors.flat().find((e) => e.code !== 'invalid_type')?.message;
      return `${of}${(inner ?? 'not the right kind of value').replace(/\.$/, '')}.`;
    }
    default:
      return `${of}${issue.message.replace(/\.$/, '')}.`;
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, at: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ListedArgumentError(problemOf(result.error, at));
  return result.data;
}

/* Headers ---------------------------------------------------------------------------------------- */

/**
 * The headers a listed request sends: the ones it sets itself (`sets`, by their exact value; the agent may repeat one
 * with the same value, a Content-Type with the same media type) and the ones it lets the agent give (`allows`: its name
 * and how its value is read). Any other header, or a name given twice in different case, is refused.
 */
function settledHeaders(
  raw: unknown,
  sets: Readonly<Record<string, string>>,
  allows: Readonly<Record<string, (value: string) => string>> = {},
): Record<string, string> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
    throw new ListedArgumentError('headers: an object of header names and values.');
  const given = (raw ?? {}) as Record<string, unknown>;
  const repeated = repeatedHeader(given);
  if (repeated) throw new ListedArgumentError(`headers: ${repeated} is given more than once.`);
  const canonical = (lower: string, names: Readonly<Record<string, unknown>>) =>
    Object.keys(names).find((n) => n.toLowerCase() === lower);
  const out: Record<string, string> = { ...sets };
  // Every action may say what kind of answer it takes.
  const allowed: Record<string, (value: string) => string> = {
    Accept: (v) => parsed(line(100), v, 'headers.Accept'),
    ...allows,
  };
  for (const [name, value] of Object.entries(given)) {
    const lower = name.toLowerCase();
    if (typeof value !== 'string') throw new ListedArgumentError(`headers.${name}: text.`);
    const set = canonical(lower, sets);
    if (set) {
      const want = sets[set] as string;
      const same =
        lower === 'content-type'
          ? mediaType(value) === mediaType(want)
          : value.trim().toLowerCase() === want.toLowerCase();
      if (!same)
        throw new ListedArgumentError(`headers.${name}: Whombat sets it to “${want}” for this action.`);
      continue;
    }
    const allow = canonical(lower, allowed);
    if (!allow) throw new ListedArgumentError(`headers: ${name} can’t be sent with this action.`);
    out[allow] = (allowed[allow] as (v: string) => string)(value);
  }
  return out;
}

const mediaType = (value: string) => value.split(';')[0]?.trim().toLowerCase() ?? '';

const JSON_TYPE = { 'Content-Type': 'application/json' } as const;
const TEXT_TYPE = 'text/plain; charset=utf-8';

/* Request arguments ------------------------------------------------------------------------------ */

const REQUEST_KEYS = new Set(['method', 'path', 'base', 'query', 'headers', 'body', 'upload']);

/** The parts of a request's arguments a listed action reads; anything else is refused. */
function requestParts(
  args: Args,
  take: { body?: boolean; upload?: boolean; base?: string },
): { body: unknown; upload: unknown } {
  for (const key of Object.keys(args)) {
    if (!REQUEST_KEYS.has(key)) throw new ListedArgumentError(`“${key}” isn’t part of this action.`);
  }
  const query = args.query;
  if (
    query !== undefined &&
    query !== null &&
    !(typeof query === 'object' && !Array.isArray(query) && Object.keys(query).length === 0)
  )
    throw new ListedArgumentError('query: this action takes no query.');
  const base = args.base === undefined || args.base === null || args.base === '' ? undefined : args.base;
  if (base !== take.base && !(take.base && base === undefined))
    throw new ListedArgumentError(
      take.base ? `base: “${take.base}” for this action.` : 'base: none for this action.',
    );
  const body = args.body ?? undefined;
  const upload = args.upload ?? undefined;
  if (body !== undefined && !take.body) throw new ListedArgumentError('body: this action takes none.');
  if (upload !== undefined && !take.upload)
    throw new ListedArgumentError('upload: this action takes no file.');
  return { body, upload };
}

/** The file of the email a request sends: `{ attachmentId }`, sent as the request's body. */
const wholeFile = z.object({ attachmentId: AttachmentId }).strict();

/** A request's arguments as sent: method and path as matched, then what the action settled (no empty headers). */
function request(args: Args, parts: Args, base?: string): Args {
  const { headers, ...rest } = parts;
  const sent = headers && typeof headers === 'object' && Object.keys(headers).length ? { headers } : {};
  return { method: args.method, path: args.path, ...(base ? { base } : {}), ...sent, ...rest };
}

/* The list --------------------------------------------------------------------------------------- */

const paperlessFields = z
  .object({
    title: line(128).optional(),
    created: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'a date like 2026-11-22')
      .optional(),
    correspondent: id.optional(),
    document_type: id.optional(),
    tags: z.union([id, z.array(id).max(20)]).optional(),
  })
  .strict();

const moneybirdLines = z
  .array(
    z
      .object({
        description: text(2000).optional(),
        price: decimal.optional(),
        amount: line(32).optional(),
        tax_rate_id: id.optional(),
        ledger_account_id: id.optional(),
        period: line(40).optional(),
      })
      .strict(),
  )
  .max(50);

const moneybirdDocument = (due: boolean) =>
  z
    .object({
      contact_id: id.optional(),
      reference: line(255).optional(),
      date: date.optional(),
      ...(due ? { due_date: date.optional() } : {}),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/, 'a currency like EUR')
        .optional(),
      prices_are_incl_tax: z.boolean().optional(),
      details_attributes: moneybirdLines.optional(),
    })
    .strict();

function moneybird(kind: 'purchase_invoice' | 'receipt'): ListedAction['settle'] {
  const schema = z.object({ [kind]: moneybirdDocument(kind === 'purchase_invoice') }).strict();
  return (args) => {
    const { body } = requestParts(args, { body: true });
    return request(args, {
      headers: settledHeaders(args.headers, JSON_TYPE),
      body: parsed(schema, body, 'body'),
    });
  };
}

const dropboxArg = z
  .object({
    path: filePath,
    mode: z.union([z.literal('add'), z.object({ '.tag': z.literal('add') }).strict()]).optional(),
    autorename: z.boolean().optional(),
    mute: z.boolean().optional(),
  })
  .strict();

/** Dropbox's arguments in its header, written again with `mode: "add"`: an upload never replaces a file. */
function dropboxArgHeader(value: string): string {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new ListedArgumentError('headers.Dropbox-API-Arg: JSON like {"path": "/Invoices/acme.pdf"}.');
  }
  if (
    json &&
    typeof json === 'object' &&
    'mode' in json &&
    !dropboxArg.shape.mode.safeParse(json.mode).success
  )
    throw new ListedArgumentError(
      'headers.Dropbox-API-Arg.mode: only “add”: a mail automation saves new files and never replaces one.',
    );
  const arg = parsed(dropboxArg, json, 'headers.Dropbox-API-Arg');
  return JSON.stringify({
    path: arg.path,
    mode: 'add',
    autorename: arg.autorename ?? false,
    mute: arg.mute ?? false,
  });
}

/** A text file's contents, or the email's file: exactly one of them. */
function textOrFile(body: unknown, upload: unknown): Args {
  if ((body === undefined) === (upload === undefined))
    throw new ListedArgumentError('Give either “body” (the text) or “upload” (the email’s file), not both.');
  if (upload !== undefined) return { upload: parsed(wholeFile, upload, 'upload') };
  return { body: parsed(text(LISTED_TEXT_MAX), body, 'body') };
}

const NEXTCLOUD_FILES = /^\/remote\.php\/dav\/files\/([^/]+)\/(.+)$/;

/** A Nextcloud WebDAV path in the connection's own files, whose user is the connection's user when it is known. */
function nextcloudPath(path: string, fields: Readonly<Record<string, unknown>>, folder: boolean): void {
  const m = NEXTCLOUD_FILES.exec(path);
  const users = [fields.userId, fields.username].filter((u): u is string => typeof u === 'string' && !!u);
  const rest = m?.[2] ?? '';
  if (!m || (users.length > 0 && !users.includes(decodeURIComponentSafe(m[1] as string))))
    throw new ListedArgumentError(
      `path: under /remote.php/dav/files/${users[0] ?? '<user id>'}/, in the person’s own files.`,
    );
  const file = folder ? rest.replace(/\/$/, '') : rest;
  if (!filePath.safeParse(`/${file}`).success || path.length > 300)
    throw new ListedArgumentError('path: a file path of at most 200 characters, without . or ..');
}

function decodeURIComponentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const filesWrite = z
  .object({ path: filePath, content: text(LISTED_TEXT_MAX), overwrite: z.literal(false).optional() })
  .strict();

function settleFilesWrite(args: Args): Args {
  if (args.overwrite === true)
    throw new ListedArgumentError(
      'overwrite: a mail automation saves new files and never replaces one, so leave it out.',
    );
  const ok = parsed(filesWrite, args, '');
  return { path: ok.path, content: ok.content, overwrite: false };
}

const todoistTask = z
  .object({
    content: line(500),
    description: text(LISTED_TEXT_MAX).optional(),
    due: line(100).optional(),
    project: line(120).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    labels: z.array(line(60)).max(10).optional(),
  })
  .strict();

const todoistRequestTask = z
  .object({
    content: line(500),
    description: text(LISTED_TEXT_MAX).optional(),
    due_string: line(100).optional(),
    due_date: date.optional(),
    due_lang: z
      .string()
      .regex(/^[a-z]{2}$/, 'a language like en')
      .optional(),
    project_id: line(40).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    labels: z.array(line(60)).max(10).optional(),
  })
  .strict();

const haNotification = z.object({ message: text(2000), title: line(200).optional() }).strict();

const FILE_FROM_EMAIL = 'upload {attachmentId} (a file attached to this message)';

const LISTED: readonly ListedAction[] = [
  {
    catalogId: 'paperless',
    ask: 'Upload a document to {label}',
    done: 'uploaded a document to {label}',
    can: 'upload a file from the email to Paperless-ngx as a new document',
    how: 'tool request, POST /api/documents/post_document/, upload {field: "document", attachmentId, fields?: {title, created, correspondent, document_type, tags: [ids]}}',
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'POST',
    path: /^\/api\/documents\/post_document\/?$/,
    settle(args) {
      const { upload } = requestParts(args, { upload: true });
      const file = parsed(
        z
          .object({
            field: z.literal('document'),
            attachmentId: AttachmentId,
            fields: paperlessFields.optional(),
          })
          .strict(),
        upload,
        'upload',
      );
      // Form fields are text; a list of tags is the field repeated.
      const fields: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(file.fields ?? {})) {
        if (v === undefined) continue;
        fields[k] = Array.isArray(v) ? v.map(String) : String(v);
      }
      return request(args, {
        headers: settledHeaders(args.headers, {}),
        upload: {
          field: 'document',
          attachmentId: file.attachmentId,
          ...(Object.keys(fields).length ? { fields } : {}),
        },
      });
    },
  },
  {
    catalogId: 'moneybird',
    ask: 'Add a purchase invoice to {label}',
    done: 'added a purchase invoice to {label}',
    can: 'add a purchase invoice to Moneybird',
    how: 'tool request, POST /<administration>/documents/purchase_invoices.json, body {purchase_invoice: {contact_id, reference, date, due_date, currency, prices_are_incl_tax, details_attributes: [{description, price, amount, tax_rate_id, ledger_account_id, period}]}}',
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'POST',
    path: /^\/[^/]+\/documents\/purchase_invoices(\.json)?$/,
    settle: moneybird('purchase_invoice'),
  },
  {
    catalogId: 'moneybird',
    ask: 'Add a receipt to {label}',
    done: 'added a receipt to {label}',
    can: 'add a receipt to Moneybird',
    how: 'tool request, POST /<administration>/documents/receipts.json, body {receipt: {contact_id, reference, date, currency, prices_are_incl_tax, details_attributes: [{description, price, amount, tax_rate_id, ledger_account_id, period}]}}',
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'POST',
    path: /^\/[^/]+\/documents\/receipts(\.json)?$/,
    settle: moneybird('receipt'),
  },
  {
    catalogId: 'dropbox',
    ask: 'Save a new file in {label}',
    done: 'saved a new file in {label}',
    can: 'save a new file in Dropbox',
    how: `tool request, POST /2/files/upload, base "content", headers {"Dropbox-API-Arg": "{\\"path\\": \\"/Folder/name.pdf\\"}"}, and ${FILE_FROM_EMAIL} or body (text)`,
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'POST',
    path: /^\/2\/files\/upload$/,
    settle(args) {
      const { body, upload } = requestParts(args, { body: true, upload: true, base: 'content' });
      const headers = settledHeaders(
        args.headers,
        { 'Content-Type': 'application/octet-stream' },
        { 'Dropbox-API-Arg': dropboxArgHeader },
      );
      if (!headers['Dropbox-API-Arg'])
        throw new ListedArgumentError(
          'headers.Dropbox-API-Arg: say where the file goes: {"path": "/Folder/name.pdf"}.',
        );
      return request(args, { headers, ...textOrFile(body, upload) }, 'content');
    },
  },
  {
    catalogId: 'dropbox',
    ask: 'Save a new file in {label}',
    done: 'saved a new file in {label}',
    can: 'save a new file in Dropbox',
    how: 'tool files_write, {path, content} (a new text file)',
    tool: 'files_write',
    origin: 'adapter',
    settle: settleFilesWrite,
  },
  {
    catalogId: 'nextcloud',
    ask: 'Save a new file in {label}',
    done: 'saved a new file in {label}',
    can: 'save a new file in Nextcloud',
    how: `tool request, PUT /remote.php/dav/files/<user id>/<folder>/<name>, with ${FILE_FROM_EMAIL} or body (text)`,
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'PUT',
    path: NEXTCLOUD_FILES,
    settle(args, fields) {
      if (String(args.path).endsWith('/')) throw new ListedArgumentError('path: name a file, not a folder.');
      nextcloudPath(String(args.path), fields, false);
      const { body, upload } = requestParts(args, { body: true, upload: true });
      const content = textOrFile(body, upload);
      // Never over a file that is there already: the server refuses the PUT then (412).
      const sets: Record<string, string> = { 'If-None-Match': '*' };
      if (content.body !== undefined) sets['Content-Type'] = TEXT_TYPE;
      return request(args, { headers: settledHeaders(args.headers, sets), ...content });
    },
  },
  {
    catalogId: 'nextcloud',
    ask: 'Make a folder in {label}',
    done: 'made a folder in {label}',
    can: 'make a new folder in Nextcloud',
    how: 'tool request, MKCOL /remote.php/dav/files/<user id>/<folder>/',
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'MKCOL',
    path: NEXTCLOUD_FILES,
    settle(args, fields) {
      nextcloudPath(String(args.path), fields, true);
      requestParts(args, {});
      return request(args, { headers: settledHeaders(args.headers, {}) });
    },
  },
  {
    catalogId: 'nextcloud',
    ask: 'Save a new file in {label}',
    done: 'saved a new file in {label}',
    can: 'save a new file in Nextcloud',
    how: 'tool files_write, {path, content} (a new text file)',
    tool: 'files_write',
    origin: 'adapter',
    settle: settleFilesWrite,
  },
  {
    catalogId: 'todoist',
    ask: 'Add a task to {label}',
    done: 'added a task to {label}',
    can: 'add a task to Todoist',
    how: 'tool tasks_add, {content, description, due, project, priority, labels}',
    tool: 'tasks_add',
    origin: 'adapter',
    settle: (args) => {
      const ok = parsed(todoistTask, args, '');
      return Object.fromEntries(Object.entries(ok).filter(([, v]) => v !== undefined));
    },
  },
  {
    catalogId: 'todoist',
    ask: 'Add a task to {label}',
    done: 'added a task to {label}',
    can: 'add a task to Todoist',
    how: 'tool request, POST /api/v1/tasks, body {content, description, due_string, due_date, project_id, priority, labels}',
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'POST',
    path: /^\/api\/v1\/tasks\/?$/,
    settle(args) {
      const { body } = requestParts(args, { body: true });
      return request(args, {
        headers: settledHeaders(args.headers, JSON_TYPE),
        body: parsed(todoistRequestTask, body, 'body'),
      });
    },
  },
  {
    catalogId: 'homeassistant',
    ask: 'Show a notification in {label}',
    done: 'showed a notification in {label}',
    can: 'show a notification in Home Assistant',
    how: 'tool request, POST /api/services/persistent_notification/create, body {message, title}',
    tool: REQUEST_TOOL_NAME,
    origin: 'request',
    method: 'POST',
    path: /^\/api\/services\/persistent_notification\/create$/,
    settle(args) {
      const { body } = requestParts(args, { body: true });
      return request(args, {
        headers: settledHeaders(args.headers, JSON_TYPE),
        body: parsed(haNotification, body, 'body'),
      });
    },
  },
];

/* Reading the list ------------------------------------------------------------------------------- */

function listedFor(catalogId: string, tool: Tool, args: Readonly<Args>): ListedAction | null {
  return (
    LISTED.find(
      (a) =>
        a.catalogId === catalogId &&
        a.tool === tool.name &&
        a.origin === tool.origin &&
        (a.origin !== 'request' ||
          (String(args.method ?? '').toUpperCase() === a.method && !!a.path?.test(String(args.path ?? '')))),
    ) ?? null
  );
}

/** Whether an outsiders' run may propose anything on this kind of connection: it has listed actions. */
export function isProposableEntry(entry: Pick<CatalogEntry, 'id'>): boolean {
  return LISTED.some((a) => a.catalogId === entry.id);
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/** Everything a mail automation can do, in a sentence: “… add a task to Todoist or show a notification in …”. */
export function whatMailCanDo(catalogId?: string): string {
  const cans = [...new Set(LISTED.filter((a) => !catalogId || a.catalogId === catalogId).map((a) => a.can))];
  return `A mail automation can only ${joinOr(cans)}; for anything else, say in your reply what the person could do.`;
}

/** Whombat's words for a proposed action (its listed action's, else honest and general). */
export function listedWords(input: {
  catalogId: string;
  label: string;
  tool: Tool;
  args: Readonly<Args>;
}): ListedWords {
  const found = listedFor(input.catalogId, input.tool, input.args);
  const [ask, done] = found
    ? [found.ask, found.done]
    : input.tool.name === REQUEST_TOOL_NAME && String(input.args.method ?? '').toUpperCase() === 'POST'
      ? ['Send something to {label}', 'sent something to {label}']
      : ['Change something in {label}', 'changed something in {label}'];
  // A function, so a `$` in the person's label is never read as a replacement pattern.
  const named = (t: string) => t.replace('{label}', () => input.label);
  return { ask: named(ask), done: named(done) };
}

/** The listed actions a connection offers, as the agent proposes them: “upload … : tool request, POST …”. */
export function listedHowTo(catalogId: string, tools: readonly Tool[]): string[] {
  return LISTED.filter(
    (a) => a.catalogId === catalogId && tools.some((t) => t.name === a.tool && t.origin === a.origin),
  ).map((a) => `${a.can}: ${a.how}`);
}

/* Secrets ---------------------------------------------------------------------------------------- */

/** The words of a name, in lower case: `deleteFile`, `api_key`, `X-Api-Key`. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

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

/** The first key named like a secret anywhere in the arguments, JSON written as text included, or null. */
function secretKeyIn(value: unknown, depth = 0): string | null {
  if (depth > 16) return null;
  if (typeof value === 'string') {
    if (!/^\s*[[{]/.test(value)) return null;
    try {
      return secretKeyIn(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = secretKeyIn(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Args)) {
      if (isSecretKey(k)) return k;
      const found = secretKeyIn(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/* Deciding ----------------------------------------------------------------------------------------- */

/** The first key named like a secret anywhere in a call's arguments (JSON written as text included), or null. */
export function secretKeyOf(args: Readonly<Args>): string | null {
  return secretKeyIn(args);
}

/**
 * A call (its request arguments already normalised) as its listed action sends it, with the create-only parts set by
 * Whombat; `listed: false` when no listed action is this call, else why its arguments can't be used.
 */
export function settleListed(
  catalogId: string,
  tool: Tool,
  args: Readonly<Args>,
  fields: Readonly<Record<string, unknown>>,
): { ok: true; args: Args } | { ok: false; listed: boolean; reason: string } {
  const listed = listedFor(catalogId, tool, args);
  if (!listed) return { ok: false, listed: false, reason: whatMailCanDo(catalogId) };
  try {
    return { ok: true, args: listed.settle({ ...args }, fields) };
  } catch (err) {
    if (err instanceof ListedArgumentError || err instanceof ConnectionArgumentError)
      return { ok: false, listed: true, reason: err.message };
    throw err;
  }
}
