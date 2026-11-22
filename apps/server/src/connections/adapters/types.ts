/**
 * The typed tools a server adapter gives a connection (docs/decisions/connections-catalog.md CX-33, CX-34): the neutral
 * `files_*` (Dropbox, Nextcloud) and `tasks_*` / `projects_list` (Todoist). An adapter builds the service's requests
 * and reads its answers; sending (destination rule, credential, refresh, echo check) is the caller's `send`, so the
 * adapters are tested with stub senders.
 */
import type { OutboundResponse } from '../../lib/outbound';
import type { Services } from '../../services';
import type { ConnectionRequest } from '../http';
import { type CallOutput, ConnectionArgumentError, renderBody } from '../request';

export interface AdapterContext {
  /** The connection's base URL (no trailing slash). */
  baseUrl: string;
  /** The connection's field values (Nextcloud's `username`). */
  fields: Readonly<Record<string, string>>;
  /** The entry's other bases by name (Dropbox's `content`). */
  bases: Readonly<Record<string, string>>;
  send(req: ConnectionRequest, options?: { truncateAt?: number }): Promise<OutboundResponse>;
  /**
   * One UDP datagram to `port` on the connection's host under its destination policy, and the first answer, or null
   * when none came (a console's discovery). Absent where the caller has no network (tests).
   */
  datagram?(port: number, payload: Buffer): Promise<Buffer | null>;
  /** One bounded TCP command to this host under its destination rule; writes must be non-idempotent. */
  line?(port: number, command: string, idempotent: boolean): Promise<string>;
  /** The call itself, for provisioned builtins that act as the agent (the Servers tools, devices). */
  call?: AdapterCall;
}

/** Who makes a call and where (provisioned builtins, `CALLABLE_BUILTINS`). */
export interface AdapterCall {
  services: Services;
  burrowId: string;
  agentId: string;
  connectionId: string;
  callId: string;
  /** The conversation the call was made in (where its change is shown). */
  conversationId: string | null;
  /**
   * The thread of that conversation where what follows the call is said (task-feedback.md TF-04): the turn's thread,
   * or after a yes the approval card's. Null or absent: none (a flat conversation).
   */
  threadRootId?: string | null;
  /** The person the call is for, when the turn says. */
  personId: string | null;
  /** The approval whose yes runs the call; absent or null: it didn't ask (task-feedback.md TF-10). */
  approvalId?: string | null;
  /** Where the call goes and as whom (`callTarget` of the connection it runs on): a change it records keeps it. */
  target?: string;
  /**
   * Where each other connection the call acts through goes and as whom, by id (`callReaches`): the call signs as each
   * only there, and a change it records keeps them.
   */
  others?: Readonly<Record<string, string>>;
}

export type AdapterTool = (
  ctx: AdapterContext,
  args: Readonly<Record<string, unknown>>,
) => Promise<CallOutput>;
export type Adapter = Readonly<Record<string, AdapterTool>>;

/** A required string argument. */
export function str(args: Readonly<Record<string, unknown>>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.trim() === '') throw new ConnectionArgumentError(`${name}: required.`);
  return v;
}

/** An optional string argument (null when absent or empty). */
export function optStr(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const v = args[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ConnectionArgumentError(`${name}: a string.`);
  return v;
}

/**
 * A file path from the root of the account's files: starts with `/`, no `.`/`..` segments, no backslashes or control
 * characters. Trailing slashes dropped (the root stays `/`).
 */
export function filePath(args: Readonly<Record<string, unknown>>, name: string, fallback?: string): string {
  const raw = args[name] ?? fallback;
  if (typeof raw !== 'string' || raw === '') throw new ConnectionArgumentError(`${name}: required.`);
  const p = raw.startsWith('/') ? raw : `/${raw}`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\\\u0000-\u001f]/.test(p)) throw new ConnectionArgumentError(`${name}: not a usable path.`);
  if (p.split('/').some((s) => s === '.' || s === '..'))
    throw new ConnectionArgumentError(`${name}: “.” and “..” aren’t allowed.`);
  const trimmed = p.replace(/\/+/g, '/').replace(/\/$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** A JSON answer as the agent reads it (compact), cut at the output cap. */
export function jsonOutput(value: unknown, res: Pick<OutboundResponse, 'status' | 'body'>): CallOutput {
  const text = JSON.stringify(value);
  const rendered = renderBody({ headers: { 'content-type': 'application/json' }, body: Buffer.from(text) });
  return {
    content: rendered.text,
    isError: false,
    truncated: rendered.truncated,
    httpStatus: res.status,
    bytes: res.body.length,
  };
}

/** A service's error answer: its status and (cut) body, as data. */
export function errorOutput(
  service: string,
  res: Pick<OutboundResponse, 'status' | 'body' | 'headers'>,
): CallOutput {
  const rendered = renderBody({ ...res, body: res.body.subarray(0, 2048) }, res.body.length);
  return {
    content: `${service} answered ${res.status}.${rendered.text ? `\n${rendered.text}` : ''}`,
    isError: true,
    truncated: res.body.length > 2048,
    httpStatus: res.status,
    bytes: res.body.length,
  };
}

/** Parses a JSON answer, or null. */
export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** A file's bytes as `files_read` answers them: text up to 64 KiB, else a note. */
export function fileOutput(
  path: string,
  res: Pick<OutboundResponse, 'status' | 'headers' | 'body' | 'truncated'>,
  size: number | null,
): CallOutput {
  // Services answer files as application/octet-stream whatever they hold: then the bytes decide.
  const type = res.headers['content-type'];
  const sniff = typeof type !== 'string' || /^application\/octet-stream/i.test(type);
  const rendered = renderBody(
    sniff ? { ...res, headers: { ...res.headers, 'content-type': undefined } } : res,
    size ?? res.body.length,
  );
  return {
    content: rendered.text,
    structured: { path, ...(size !== null ? { size } : {}) },
    isError: false,
    truncated: rendered.truncated,
    httpStatus: res.status,
    bytes: res.body.length,
  };
}
