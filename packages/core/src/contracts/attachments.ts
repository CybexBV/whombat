/**
 * Attachments and agent artifacts (Workstream A, docs/decisions/bp-attachments.md BP-A*). Owned by the
 * attachments workstream: other workstreams import from here and request changes instead of editing it.
 *
 * The flow: `uploads.create` reserves an attachment for one conversation → the client PUTs the raw bytes to
 * `uploadUrl` (`ATTACHMENT_TRANSFER.upload`) → the server hashes, sniffs and validates them and marks the
 * attachment `ready` → `messages.send` attaches ready uploads of the sender (once) → members read it at
 * `Attachment.url` (`ATTACHMENT_TRANSFER.download`), authorized on every request. Runners fetch the bytes of
 * a dispatch's attachments through `ATTACHMENT_TRANSFER.runnerFetch`. Bytes never travel as JSON except in
 * the bounded MCP `upload_file` tool.
 */
import { z } from 'zod';
import { Attachment, AttachmentKind } from '../domain/message.js';
import { AttachmentId, ConversationId, MessageId } from '../ids.js';
import { API_PREFIX, RUNNER_PREFIX } from './endpoint.js';

export { AttachmentKind };

/** At most this many files on one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Default largest upload (`WHOMBAT_UPLOAD_MAX_BYTES`): 250 MiB since 0.49 (Whombat files-space.md FS-13, CT-278). */
export const DEFAULT_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
/** No configuration may raise the per-file limit above this. */
export const UPLOAD_MAX_BYTES_CEILING = 1024 * 1024 * 1024;
/**
 * A thumbnail's longest side, in pixels (0.55, CT-298): PNG and JPEG images get one at upload completion
 * (`Attachment.thumbnailUrl`); 720 covers a 360-point tile at 2×.
 */
export const THUMBNAIL_MAX_EDGE = 720;
/** Largest artifact an agent may publish through `upload_file` (decoded bytes). */
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
/** Longest display name kept (characters). */
export const ATTACHMENT_NAME_MAX = 255;

/**
 * An attachment a dispatch may use: the server lists only attachments on messages the agent can read
 * in this dispatch (trigger, window, thread). The runner fetches the bytes through the runner protocol.
 */
export const AttachmentRef = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(ATTACHMENT_NAME_MAX),
  contentType: z.string().min(1).max(120),
  size: z.number().int().nonnegative(),
  kind: AttachmentKind,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  messageId: MessageId,
  conversationId: ConversationId,
  /** Pixel size of an image (models have size limits). */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** `uploads.create`: what the client knows before sending bytes. The server sanitizes the name. */
export const UploadReserveBody = z.object({
  conversationId: ConversationId,
  /** The file's own name; only its last path segment is kept, without control characters. */
  name: z.string().min(1).max(1000),
  /** What the client believes the type is. Only a hint: the stored type is sniffed from the bytes. */
  contentType: z.string().max(255).default(''),
  /** Exact byte count the PUT will carry. */
  size: z.number().int().positive().max(UPLOAD_MAX_BYTES_CEILING),
});
export type UploadReserveBody = z.infer<typeof UploadReserveBody>;

export const UploadReservation = z.object({
  attachment: Attachment,
  /** Relative API path: PUT the raw bytes here with the same credentials. */
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  /** This server's per-file limit, bytes. */
  maxBytes: z.number().int().positive(),
});
export type UploadReservation = z.infer<typeof UploadReservation>;

/** The PUT's answer: the attachment, now `ready`, with its sniffed type, kind and image size. */
export const UploadCompleteResponse = z.object({ attachment: Attachment });
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponse>;

/** `?download=1` on a download: always `Content-Disposition: attachment` (the image “Download” button). */
export const AttachmentDownloadQuery = z.object({
  download: z.enum(['0', '1']).optional(),
});

/** The lease on a runner fetch, as query parameters (a GET has no body). */
export const RunnerAttachmentQuery = z.object({
  runnerId: z.string().min(1).max(80).optional(),
  attempt: z.coerce.number().int().positive().optional(),
});

/**
 * Byte transfers. They are not JSON endpoints (`api`): the server registers them as raw routes
 * (apps/server/src/files/routes.ts) with their own body handling, and clients build the paths with these.
 */
export const ATTACHMENT_TRANSFER = {
  /** Raw bytes of a reserved upload (`Content-Type` ignored; `Content-Length` must equal the reserved size). */
  upload: {
    method: 'PUT',
    base: API_PREFIX,
    path: '/burrows/:burrow/uploads/:attachmentId/content',
    response: UploadCompleteResponse,
  },
  /** The file, for members of its message's conversation (or its uploader before it is sent). GET and HEAD. */
  download: {
    method: 'GET',
    base: API_PREFIX,
    path: '/burrows/:burrow/attachments/:attachmentId',
    query: AttachmentDownloadQuery,
  },
  /**
   * An image's thumbnail (0.55, CT-298): the `Attachment.thumbnailUrl` route, authorized exactly like `download` (members
   * of its message's conversation, or its uploader before it is sent); 404 when the attachment has none. GET and HEAD,
   * `Cache-Control: private, max-age=31536000, immutable` (a thumbnail never changes), the thumbnail's own type.
   */
  thumbnail: {
    method: 'GET',
    base: API_PREFIX,
    path: '/burrows/:burrow/attachments/:attachmentId/thumbnail',
  },
  /**
   * The runner's copy for one turn: runner token, the live lease, and the attachment must be one the
   * dispatch may use (re-checked on every fetch): one of `DispatchContext.attachments`, or since 0.49 a file in
   * the Files of the dispatch's conversation (`DispatchContext.files`, files-space.md FS-08, CT-276).
   * Headers: `X-Whombat-Sha256`, `Content-Length`.
   */
  runnerFetch: {
    method: 'GET',
    base: RUNNER_PREFIX,
    path: '/dispatches/:dispatchId/attachments/:attachmentId',
    query: RunnerAttachmentQuery,
  },
} as const;

/** Header carrying the sha256 (hex) of the bytes on downloads and runner fetches. */
export const SHA256_HEADER = 'x-whombat-sha256';

function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

/** `/api/v1/burrows/{slug}/attachments/{id}`: the stable `Attachment.url`. */
export function attachmentUrl(burrow: string, attachmentId: string): string {
  const t = ATTACHMENT_TRANSFER.download;
  return `${t.base}${fill(t.path, { burrow, attachmentId })}`;
}

/** `/api/v1/burrows/{slug}/attachments/{id}/thumbnail`: the stable `Attachment.thumbnailUrl` (0.55, CT-298). */
export function attachmentThumbnailUrl(burrow: string, attachmentId: string): string {
  const t = ATTACHMENT_TRANSFER.thumbnail;
  return `${t.base}${fill(t.path, { burrow, attachmentId })}`;
}

/** `/api/v1/burrows/{slug}/uploads/{id}/content`. */
export function uploadContentUrl(burrow: string, attachmentId: string): string {
  const t = ATTACHMENT_TRANSFER.upload;
  return `${t.base}${fill(t.path, { burrow, attachmentId })}`;
}

/** `/internal/runner/dispatches/{dispatch}/attachments/{id}`. */
export function runnerAttachmentPath(dispatchId: string, attachmentId: string): string {
  const t = ATTACHMENT_TRANSFER.runnerFetch;
  return `${t.base}${fill(t.path, { dispatchId, attachmentId })}`;
}

/** Control, bidi override/isolate and other invisible format characters (also the rule for Files folders, CT-274). */
export function unsafeNameChar(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff
  );
}

/**
 * A file name that is safe to show and to put in a `Content-Disposition` header: the last path segment
 * (`/` or `\`), no control, bidi or zero-width characters, whitespace collapsed, no leading dots, at most
 * 255 characters with the extension kept. Never empty (`file`).
 */
export function safeDisplayName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  let name = [...last.normalize('NFC')]
    .map((c) => (/\s/.test(c) ? ' ' : unsafeNameChar(c.codePointAt(0) ?? 0) ? '' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^\.+/, '').trim();
  if (!name) return 'file';
  const chars = [...name];
  if (chars.length <= ATTACHMENT_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? [...name.slice(dot)] : [];
  if (ext.length > 0 && ext.length <= 16) {
    return [...chars.slice(0, ATTACHMENT_NAME_MAX - ext.length), ...ext].join('').trim();
  }
  return chars.slice(0, ATTACHMENT_NAME_MAX).join('').trim();
}

/** “2.4 MB”, “812 KB”, “93 bytes”: sizes on chips (base 1024, one decimal under 10). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${units[unit]}`;
}

export const attachmentEndpoints = {};
