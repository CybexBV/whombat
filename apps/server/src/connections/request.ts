/**
 * The generic `request` tool of a connection (docs/decisions/connections-catalog.md CX-33): one HTTP request under the
 * connection's base URL and the entry's path prefixes (`requestAllowed`), with the agent's headers limited to Accept,
 * Content-Type, a few conditional ones and the entry's own (`allowedHeaders`: WebDAV's Depth/Destination/Overwrite,
 * Dropbox's Dropbox-API-Arg). Reads are the entry's read methods and read paths (`isReadRequest`); everything else is a
 * write, under the tool's tier. Answers: JSON or text up to 64 KiB, binary as a note with its type and size; redirects
 * are never followed (the 3xx comes back, its Location filtered).
 *
 * Paths are canonical before anything decides on them: no `.`/`..`, `//`, encoded dots or slashes (the Vault's rule),
 * and percent-escapes of letters and digits decoded, so `/api/services/%6Cock/…` is the `lock` path the sensitive rules
 * see (CX-31).
 */
import { randomUUID } from 'node:crypto';
import {
  AttachmentId,
  type CatalogEntry,
  CONNECTION_OUTPUT_MAX,
  CONNECTOR_BINARY_MAX_BYTES,
  type ConnectionToolAccess,
  callAccess,
  filterVaultResponseHeaders,
  type JsonObject,
  REQUEST_TOOL_NAME,
  requestAllowed,
  resolveBaseUrl,
  resolveRequestPrefixes,
  vaultPathProblem,
  vaultRequestQuery,
} from '@whombat/core';
import type { OutboundResponse } from '../lib/outbound';
import type { Services } from '../services';
import { VAULT_REQUEST_BODY_MAX } from '../vault/limits';
import { signedConnectionFetch } from './http';
import type { CatalogConnectionRow } from './types';

/** What a connection tool call answers (`ConnectionCallOutput` ok). */
export interface CallOutput {
  content: string;
  structured?: JsonObject;
  isError: boolean;
  truncated: boolean;
  httpStatus?: number;
  /** Bytes of the service's answer (for the log: never its content). */
  bytes: number;
  /**
   * A picture the tool attaches (a Mac's screen, macos-servers.md): `connection_call` hands it to the agent as MCP image
   * content beside the text, as `browser_preview` does. Never logged or stored.
   */
  image?: { data: string; mimeType: 'image/png' | 'image/jpeg' };
}

/** Why a call's arguments can't be used (`invalid_arguments`), in words the agent can act on. */
export class ConnectionArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionArgumentError';
  }
}

/** A device command may have arrived, but its reply was lost. Never replay it automatically. */
export class ConnectionOutcomeUnknownError extends Error {}

/** Headers any request may carry (lowercase). */
const AGENT_HEADERS = ['accept', 'content-type', 'if-none-match', 'if-match', 'if-modified-since', 'prefer'];
/** Response headers an agent sees beyond the Vault's list (pagination). */
const EXTRA_RESPONSE_HEADERS = ['x-next-page', 'x-total', 'x-total-pages', 'dropbox-api-result'];
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const HEADER_VALUE_BAD = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** The `request` tool's definition on a connection (stored and hashed like any tool). */
export function requestToolDef(
  entry: CatalogEntry,
  row: Pick<CatalogConnectionRow, 'baseUrl' | 'fields'>,
): { name: string; description: string; inputSchema: JsonObject; access: ConnectionToolAccess } {
  const spec = entry.request;
  const prefixes = resolveRequestPrefixes(entry, row.fields);
  const reads = [
    ...(spec?.readMethods ?? []),
    ...(spec?.readPaths ?? []).map((r) => `${r.method} ${r.path.replace(/^\^|\$$/g, '')}`),
  ];
  const bases = Object.keys(spec?.bases ?? {});
  const description = [
    `One HTTP request to ${entry.name} at ${row.baseUrl}: the path is relative to it and starts with ${prefixes.join(' or ')}.`,
    reads.length ? `Reads (${reads.join(', ')}) run at once; other requests follow this tool’s setting.` : '',
    'JSON or text answers up to 64 KB; a binary answer is described, not returned. Redirects are not followed.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
  const allowed = [...AGENT_HEADERS, ...(spec?.allowedHeaders ?? []).map((h) => h.toLowerCase())];
  const inputSchema: JsonObject = {
    type: 'object',
    properties: {
      method: { type: 'string', enum: spec?.methods ?? ['GET'] },
      path: { type: 'string', description: `From the base, like ${prefixes[0] ?? '/'}…` },
      query: {
        type: 'object',
        description: 'Query parameters',
        additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      },
      body: { description: 'The request body: JSON (sent as application/json) or text' },
      headers: {
        type: 'object',
        description: `Only ${allowed.join(', ')}`,
        additionalProperties: { type: 'string' },
      },
      ...(bases.length
        ? { base: { type: 'string', enum: bases, description: 'Another base of the same service' } }
        : {}),
    },
    required: ['method', 'path'],
    additionalProperties: false,
  };
  return { name: REQUEST_TOOL_NAME, description, inputSchema, access: 'write' };
}

/** Percent-escapes of unreserved characters decoded, the rest upper-cased: one spelling per path. */
export function canonicalPath(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (m, hex: string) => {
    const c = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-_~]/.test(c) ? c : m.toUpperCase();
  });
}

/**
 * A file upload referencing an authorized Whombat attachment: sent as one field of a multipart form (`field`, with
 * `fields` beside it; a list is the field repeated: Paperless-ngx's tags), or without `field` as the request's whole
 * body (a WebDAV PUT, Dropbox's upload).
 */
export interface RequestUploadSpec {
  field?: string;
  attachmentId: string;
  fields?: Record<string, string | string[]>;
}

/** Resolved attachment bytes for a `request` upload. */
export type ResolveRequestUpload = (
  attachmentId: string,
) => Promise<{ name: string; contentType: string; bytes: Buffer } | null>;

const FORM_FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const FORM_VALUE_MAX = 2000;

/** Validates `args.upload` for `request`; returns null when omitted, or throws `ConnectionArgumentError`. */
export function parseRequestUpload(raw: unknown): RequestUploadSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new ConnectionArgumentError('upload: give { attachmentId, field?, fields? }.');
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'field' && key !== 'attachmentId' && key !== 'fields')
      throw new ConnectionArgumentError(`upload.${key}: not part of an upload.`);
  }
  if (rec.field !== undefined && (typeof rec.field !== 'string' || !FORM_FIELD_NAME.test(rec.field)))
    throw new ConnectionArgumentError('upload.field: give a form field name such as “document”.');
  const att = AttachmentId.safeParse(rec.attachmentId);
  if (!att.success) throw new ConnectionArgumentError('upload.attachmentId: give a valid attachment id.');
  let fields: Record<string, string | string[]> | undefined;
  if (rec.fields !== undefined && rec.fields !== null) {
    if (rec.field === undefined)
      throw new ConnectionArgumentError('upload.fields: only with a form field (upload.field).');
    if (typeof rec.fields !== 'object' || Array.isArray(rec.fields))
      throw new ConnectionArgumentError('upload.fields: an object of form field names and text values.');
    const entries = Object.entries(rec.fields as Record<string, unknown>);
    if (entries.length > 32) throw new ConnectionArgumentError('upload.fields: at most 32 form fields.');
    fields = {};
    const short = (v: unknown): v is string => typeof v === 'string' && v.length <= FORM_VALUE_MAX;
    for (const [k, v] of entries) {
      if (!FORM_FIELD_NAME.test(k) || !(short(v) || (Array.isArray(v) && v.length <= 32 && v.every(short))))
        throw new ConnectionArgumentError(
          `upload.fields.${k}: must be a short string value, or a list of them.`,
        );
      fields[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  return {
    ...(typeof rec.field === 'string' ? { field: rec.field } : {}),
    attachmentId: att.data,
    ...(fields ? { fields } : {}),
  };
}

function buildMultipartBody(
  spec: RequestUploadSpec & { field: string },
  file: { name: string; contentType: string; bytes: Buffer },
): { boundary: string; body: Buffer } {
  const boundary = `----WhombatForm${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const [k, value] of Object.entries(spec.fields ?? {})) {
    for (const v of Array.isArray(value) ? value : [value])
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'),
      );
  }
  const safeName = (file.name || 'attachment').replace(/["\r\n\\]/g, '_').slice(0, 200);
  const safeType = safeContentType(file.contentType);
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${spec.field}"; filename="${safeName}"\r\nContent-Type: ${safeType}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(file.bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

const safeContentType = (type: string) =>
  (type || 'application/octet-stream').replace(/[\r\n]/g, '').slice(0, 120);

/** A header name given twice in different case (`Content-Type` and `content-type`), or null. */
export function repeatedHeader(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return name;
    seen.add(lower);
  }
  return null;
}

/**
 * A `request` call's arguments as the server decides on them: method upper-cased, path canonical (refused when it
 * isn't a clean path). Throws `ConnectionArgumentError`.
 */
export function normaliseRequestArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (typeof args.method !== 'string' || !/^[A-Za-z]{3,10}$/.test(args.method))
    throw new ConnectionArgumentError('method: say which HTTP method, like GET or POST.');
  if (typeof args.path !== 'string' || args.path === '')
    throw new ConnectionArgumentError('path: give the path from the base, starting with /.');
  if (args.path.includes('?') || args.path.includes('#'))
    throw new ConnectionArgumentError('path: put the query in “query”, not in the path.');
  const problem = vaultPathProblem(args.path);
  if (problem) throw new ConnectionArgumentError(`path: ${problem}`);
  const upload = parseRequestUpload(args.upload);
  if (upload && args.body !== undefined && args.body !== null)
    throw new ConnectionArgumentError('Give either “body” or “upload”, not both.');
  // One value per header: two spellings of a name could be read one way and sent the other.
  const repeated = repeatedHeader(args.headers);
  if (repeated) throw new ConnectionArgumentError(`headers: ${repeated} is given more than once.`);
  return { ...args, method: args.method.toUpperCase(), path: canonicalPath(args.path) };
}

/** Whether a body reads as text. */
export function isTextBody(contentType: string | undefined, body: Buffer): boolean {
  const type = (contentType ?? '').toLowerCase();
  if (type)
    return /^text\/|[/+](json|xml|javascript|ecmascript|yaml|csv|x-www-form-urlencoded)\b|^application\/(graphql|problem\+json)/.test(
      type,
    );
  return !body.includes(0) && Buffer.from(body.toString('utf8'), 'utf8').equals(body);
}

/**
 * Docker's log stream as text (Portainer's Docker proxy, CT-313): `multiplexed-stream` is frames of an 8-byte header
 * (stream 0 stdin, 1 stdout, 2 stderr; three zero bytes; the size, big-endian) and the output; `raw-stream` is the
 * output as it is (a container with a TTY), or frames from an engine before API 1.42. Lines on stderr are marked
 * “stderr: ”. Null when the type isn't one of Docker's streams or its frames don't parse.
 */
export function dockerStreamText(contentType: string, body: Buffer): Buffer | null {
  const type = contentType.toLowerCase();
  if (!/^application\/vnd\.docker\.(multiplexed|raw)-stream\b/.test(type)) return null;
  const out: Buffer[] = [];
  let at = 0;
  while (at + 8 <= body.length) {
    const stream = body[at];
    if ((stream !== 0 && stream !== 1 && stream !== 2) || body[at + 1] || body[at + 2] || body[at + 3]) break;
    const end = Math.min(body.length, at + 8 + body.readUInt32BE(at + 4));
    const payload = body.subarray(at + 8, end);
    out.push(
      stream === 2 ? Buffer.from(payload.toString('utf8').replace(/^(?=.)/gm, 'stderr: '), 'utf8') : payload,
    );
    at = end;
  }
  if (at === 0) return type.includes('raw-stream') ? body : null;
  if (at < body.length) out.push(body.subarray(at));
  return Buffer.concat(out);
}

/** “1 234 567 bytes”. */
export function formatBytes(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} bytes`;
}

/** A body as the agent reads it: text cut at 64 KiB (marked), or a note for binary. */
export function renderBody(
  res: Pick<OutboundResponse, 'headers' | 'body' | 'truncated'>,
  size: number = res.body.length,
): { text: string; truncated: boolean } {
  const type = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined;
  const logs = type ? dockerStreamText(type, res.body) : null;
  if (logs)
    return renderBody(
      { headers: { 'content-type': 'text/plain' }, body: logs, truncated: res.truncated },
      logs.length,
    );
  // A cut answer may end inside a character: sniff without its last bytes.
  const sniffed = res.truncated ? res.body.subarray(0, Math.max(0, res.body.length - 4)) : res.body;
  if (!isTextBody(type, sniffed)) {
    const note = `[binary${type ? ` ${type.split(';')[0]}` : ''}, ${res.truncated ? 'more than ' : ''}${formatBytes(size)}; not shown]`;
    return { text: note, truncated: false };
  }
  let text = res.body.toString('utf8');
  let truncated = res.truncated === true;
  if (Buffer.byteLength(text) > CONNECTION_OUTPUT_MAX) {
    text = Buffer.from(text, 'utf8').subarray(0, CONNECTION_OUTPUT_MAX).toString('utf8').replace(/�$/, '');
    truncated = true;
  }
  return { text: truncated ? `${text}\n[answer cut at ${CONNECTION_OUTPUT_MAX} bytes]` : text, truncated };
}

/** The base a `request` goes to: the connection's, or one of the entry's other bases by name. */
function baseOf(entry: CatalogEntry, row: CatalogConnectionRow, base: unknown): string {
  if (base === undefined || base === null || base === '') return row.baseUrl;
  const other = typeof base === 'string' ? entry.request?.bases[base] : undefined;
  if (!other) throw new ConnectionArgumentError('base: not one of this connection’s bases.');
  return other.replace(/\/+$/, '');
}

function agentHeaders(
  entry: CatalogEntry,
  row: CatalogConnectionRow,
  raw: unknown,
  credentialHeader: string | null,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new ConnectionArgumentError('headers: an object of header names and values.');
  const allowed = new Set([
    ...AGENT_HEADERS,
    ...(entry.request?.allowedHeaders ?? []).map((h) => h.toLowerCase()),
  ]);
  const repeated = repeatedHeader(raw);
  if (repeated) throw new ConnectionArgumentError(`headers: ${repeated} is given more than once.`);
  const out: Record<string, string> = {};
  const refused: string[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9-]{1,64}$/.test(name) ||
      !allowed.has(lower) ||
      lower === credentialHeader ||
      HEADER_VALUE_BAD.test(value)
    ) {
      refused.push(name);
      continue;
    }
    if (lower === 'destination') {
      // WebDAV's MOVE/COPY target: on the same server, under the connection's prefixes.
      let dest: URL;
      try {
        dest = new URL(value, `${row.baseUrl}/`);
      } catch {
        refused.push(name);
        continue;
      }
      const base = new URL(`${row.baseUrl}/`);
      const rel = dest.pathname.startsWith(base.pathname)
        ? `/${dest.pathname.slice(base.pathname.length)}`
        : null;
      if (dest.origin !== base.origin || rel === null || !requestAllowed(entry, row.fields, 'GET', rel)) {
        refused.push(name);
        continue;
      }
      out.Destination = dest.toString();
      continue;
    }
    // Dropbox wants non-ASCII in its JSON header escaped as \uXXXX.
    out[name] =
      lower === 'dropbox-api-arg'
        ? value.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
        : value;
  }
  if (refused.length)
    throw new ConnectionArgumentError(
      `${refused.length === 1 ? 'This header' : 'These headers'} can’t be sent: ${refused.join(', ')}. Allowed: ${[...allowed].join(', ')}.`,
    );
  return out;
}

function bodyOf(raw: unknown, headers: Record<string, string>): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const hasType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
  if (typeof raw === 'string') {
    if (!hasType) headers['Content-Type'] = 'text/plain; charset=utf-8';
    return raw;
  }
  if (!hasType) headers['Content-Type'] = 'application/json';
  return JSON.stringify(raw);
}

/**
 * Sends a (normalised) `request` call as the connection. Throws `ConnectionArgumentError` for a call that may not be
 * sent; transport failures are summarised (`VaultCallError`).
 */
export async function runRequest(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  args: Readonly<Record<string, unknown>>,
  /** `target`: signed only while the stored connection still goes there and as whom (`signedConnectionFetch`). */
  options: { uploadAttachment?: ResolveRequestUpload; target?: string } = {},
): Promise<CallOutput> {
  if (!entry.request) throw new ConnectionArgumentError('This connection has no request tool.');
  const method = String(args.method);
  const path = String(args.path);
  if (!requestAllowed(entry, row.fields, method, path)) {
    const prefixes = resolveRequestPrefixes(entry, row.fields);
    throw new ConnectionArgumentError(
      entry.request.methods.includes(method)
        ? `path: requests go under ${prefixes.join(' or ')}.`
        : `method: ${method} isn’t allowed here (${entry.request.methods.join(', ')}).`,
    );
  }
  if (!resolveBaseUrl(entry, row.fields) && !row.baseUrl)
    throw new ConnectionArgumentError('This connection has no address.');
  const base = baseOf(entry, row, args.base);
  const credentialHeader = row.auth?.type === 'header' ? row.auth.name.toLowerCase() : 'authorization';
  if (args.query !== undefined && (typeof args.query !== 'object' || Array.isArray(args.query)))
    throw new ConnectionArgumentError('query: an object of parameter names and values.');
  const query = vaultRequestQuery(
    args.query as Record<string, string | string[]> | undefined,
    row.auth?.type === 'query' ? { type: 'query', name: row.auth.name } : null,
  );
  if (!query.ok) throw new ConnectionArgumentError(`query: ${query.message}`);
  const headers = { ...agentHeaders(entry, row, args.headers, credentialHeader) };
  for (const [name, value] of Object.entries(entry.request.headers)) headers[name] = value;
  const upload = parseRequestUpload(args.upload);
  let body: string | Buffer | undefined;
  let maxRequestBytes: number | undefined;
  if (upload) {
    if (args.body !== undefined && args.body !== null)
      throw new ConnectionArgumentError('Give either “body” or “upload”, not both.');
    if (!options.uploadAttachment)
      throw new ConnectionArgumentError(
        'upload: file uploads are only available for approved attachment uploads.',
      );
    const file = await options.uploadAttachment(upload.attachmentId);
    if (!file)
      throw new ConnectionArgumentError(
        'upload.attachmentId: that attachment is not available for this upload.',
      );
    const maxUpload = Math.min(CONNECTOR_BINARY_MAX_BYTES, services.files.maxBytes);
    if (file.bytes.length > maxUpload)
      throw new ConnectionArgumentError('upload: that attachment is too large to upload.');
    const given = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
    if (upload.field) {
      const built = buildMultipartBody({ ...upload, field: upload.field }, file);
      if (given) delete headers[given];
      headers['Content-Type'] = `multipart/form-data; boundary=${built.boundary}`;
      body = built.body;
    } else {
      // The file is the whole body, as the type the call says (Dropbox wants application/octet-stream), else its own.
      if (!given) headers['Content-Type'] = safeContentType(file.contentType);
      body = file.bytes;
    }
    maxRequestBytes = Math.max(VAULT_REQUEST_BODY_MAX, body.length + 1024);
  } else {
    body = bodyOf(args.body, headers);
    if (body !== undefined && Buffer.byteLength(body) > VAULT_REQUEST_BODY_MAX)
      throw new ConnectionArgumentError('body: larger than 256 KB.');
  }
  const res = await signedConnectionFetch(
    services,
    row,
    { method, url: `${base}${path}${query.search}`, headers, ...(body !== undefined ? { body } : {}) },
    {
      truncateAt: CONNECTION_OUTPUT_MAX + 1,
      ...(maxRequestBytes ? { maxRequestBytes } : {}),
      ...(options.target !== undefined ? { target: options.target } : {}),
    },
  );
  const shown = filterVaultResponseHeaders(res.headers as Record<string, string>, base, path);
  for (const name of EXTRA_RESPONSE_HEADERS) {
    const v = res.headers[name];
    if (typeof v === 'string')
      shown[name.replace(/(^|-)([a-z])/g, (_, d, c: string) => d + c.toUpperCase())] = v;
  }
  const rendered = renderBody(res);
  const head = [`HTTP ${res.status}`, ...Object.entries(shown).map(([k, v]) => `${k}: ${v}`)].join('\n');
  return {
    content: `${head}\n\n${rendered.text}`,
    isError:
      res.status >= 400 ||
      (callAccess(entry, REQUEST_TOOL_NAME, args, 'write') !== 'read' &&
        (res.status < 200 || res.status >= 300)),
    truncated: rendered.truncated,
    httpStatus: res.status,
    bytes: res.body.length,
  };
}
