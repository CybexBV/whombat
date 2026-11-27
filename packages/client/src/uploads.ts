/**
 * Composer uploads for web and mobile (docs/decisions/bp-attachments.md BP-A12): a pure state machine for
 * the chips (uploading with progress → ready, or failed with a reason; cancel, retry, remove) and the
 * transfer itself — `uploads.create`, then the bytes through the client's session as resumable sha256-checked chunks
 * (AP-13).
 */
import { type Attachment, formatFileSize } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import type { WhombatClient } from './http/client';
import { ApiError, NetworkError } from './http/errors';
import { clientTree } from './i18n/catalog';
import { WORK_AREA_WORDS } from './i18n/messages/chatWork/work';
import { type ChunkSource, StreamError } from './session/types';

export type UploadState = 'uploading' | 'ready' | 'failed';

export interface UploadItem {
  /** Client id of the chip (stable across retries). */
  localId: string;
  name: string;
  size: number;
  /** What the picker said the type is (a hint; the server decides). */
  mediaType: string;
  state: UploadState;
  /** 0…1 while uploading. */
  progress: number;
  /** The server's attachment once ready. */
  attachment: Attachment | null;
  /** Why it failed, in words for people. */
  error: string | null;
}

export type UploadAction =
  | { type: 'add'; item: Pick<UploadItem, 'localId' | 'name' | 'size' | 'mediaType'> }
  | { type: 'progress'; localId: string; progress: number }
  | { type: 'ready'; localId: string; attachment: Attachment }
  | { type: 'failed'; localId: string; error: string }
  | { type: 'retry'; localId: string }
  | { type: 'remove'; localId: string }
  | { type: 'clear' };

export function uploadsReducer(items: readonly UploadItem[], action: UploadAction): UploadItem[] {
  const patch = (localId: string, change: Partial<UploadItem>) =>
    items.map((i) => (i.localId === localId ? { ...i, ...change } : i));
  switch (action.type) {
    case 'add':
      return [...items, { ...action.item, state: 'uploading', progress: 0, attachment: null, error: null }];
    case 'progress': {
      const item = items.find((i) => i.localId === action.localId);
      if (item?.state !== 'uploading') return [...items];
      return patch(action.localId, { progress: Math.max(0, Math.min(1, action.progress)) });
    }
    case 'ready':
      return patch(action.localId, {
        state: 'ready',
        progress: 1,
        attachment: action.attachment,
        error: null,
      });
    case 'failed':
      return patch(action.localId, { state: 'failed', error: action.error });
    case 'retry':
      return patch(action.localId, { state: 'uploading', progress: 0, error: null, attachment: null });
    case 'remove':
      return items.filter((i) => i.localId !== action.localId);
    case 'clear':
      return [];
  }
}

/** Ids to send with the message: ready uploads, in the order they were added. */
export function readyAttachmentIds(items: readonly UploadItem[]): string[] {
  return items.flatMap((i) => (i.state === 'ready' && i.attachment ? [i.attachment.id] : []));
}

/** A send waits while anything is still uploading. */
export function anyUploading(items: readonly UploadItem[]): boolean {
  return items.some((i) => i.state === 'uploading');
}

const words = (locale?: string | null) => clientTree(locale, WORK_AREA_WORDS).uploads;

/** An upload's own English words (`UploadError`) in a locale; anyone else's words as they are. */
function ownWords(message: string, locale?: string | null): string {
  if (!locale) return message;
  const en = words();
  const w = words(locale);
  if (message === en.tryAgain) return w.tryAgain;
  if (message === en.connection) return w.connection;
  if (message === en.cancelled) return w.cancelled;
  if (message === en.failed) return w.failed;
  return message;
}

/** “Uploading 42%” / “Ready · 2.4 MB” / the error: the chip's status line. */
export function uploadStatusText(item: UploadItem, locale?: string | null): string {
  const w = words(locale);
  if (item.state === 'uploading')
    return interpolate(w.uploading, { percent: Math.round(item.progress * 100) });
  if (item.state === 'failed') return item.error ? ownWords(item.error, locale) : w.failed;
  return formatFileSize(item.attachment?.size ?? item.size);
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

const CONNECTION = 'Upload failed. Check your connection and try again.';

/** Words for a failed upload (the server's own message for 4xx answers, which are written for people). */
export function uploadErrorText(error: unknown, locale?: string | null): string {
  if (error instanceof UploadError) return ownWords(error.message, locale);
  if (error instanceof ApiError && error.status < 500) return error.message;
  if (error instanceof NetworkError) return locale ? words(locale).connection : CONNECTION;
  return words(locale).tryAgain;
}

/** What the transfer needs from the platform's file. */
export interface UploadSource {
  name: string;
  /** Declared type, may be empty. */
  type: string;
  size: number;
  /** The whole body, read by offset when `read` isn't given: a `Blob` (web `File`) or raw bytes. */
  body?: Blob | ArrayBuffer;
  /**
   * Bytes by offset, for chunked session uploads (AP-13): the file is read one chunk at a time, never whole.
   * Web: `blobChunkSource(file)`; mobile: expo-file-system file handles.
   */
  read?: (offset: number, length: number) => Promise<Uint8Array>;
}

export interface UploadOptions {
  burrow: string;
  conversationId: string;
  file: UploadSource;
  onProgress?: (fraction: number) => void;
  /** Called with the reservation, so a cancel can discard it; `maxBytes` is this Whombat's per-file limit. */
  onReserved?: (attachmentId: string, maxBytes: number) => void;
  signal?: AbortSignal;
}

/** A `ChunkSource` over a `Blob` / `File` (web): `slice()` reads only the requested range. */
export function blobChunkSource(file: Blob & { name?: string }): ChunkSource & { body: () => Blob } {
  return {
    name: file.name ?? 'file',
    type: file.type,
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    body: () => file,
  };
}

/**
 * Reserves (`uploads.create`), sends the bytes through the client's session as resumable sha256-checked chunks and
 * resolves to the ready attachment; rejects with `UploadError` / `ApiError`.
 */
export async function uploadFile(client: WhombatClient, options: UploadOptions): Promise<Attachment> {
  const { file, signal } = options;
  if (signal?.aborted) throw new UploadError('Cancelled.', null, true);
  let reserved: Awaited<ReturnType<WhombatClient['uploads']['create']>>;
  try {
    reserved = await client.uploads.create({
      params: { burrow: options.burrow },
      body: {
        conversationId: options.conversationId,
        name: file.name,
        contentType: file.type,
        size: file.size,
      },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // Cancelled while reserving: `AbortError`, or `OutcomeUnknownError` once the reservation was sent (AP-576) — an
    // unused reservation the appliance's orphan sweep removes.
    if (signal?.aborted) throw new UploadError('Cancelled.', null, true);
    throw error;
  }
  if (reserved.status !== 'ok') throw new UploadError('Upload failed. Try again.', null);
  const { attachment, maxBytes } = reserved.data;
  options.onReserved?.(attachment.id, maxBytes);
  const session = client.session;
  if (!file.read && file.body === undefined) throw new UploadError('Upload failed. Try again.', null);
  const source: ChunkSource = {
    name: file.name,
    type: file.type,
    size: file.size,
    read:
      file.read ??
      (async (offset, length) => {
        if (file.body instanceof ArrayBuffer) return new Uint8Array(file.body, offset, length).slice();
        if (file.body) return new Uint8Array(await file.body.slice(offset, offset + length).arrayBuffer());
        throw new UploadError('Upload failed. Try again.', null);
      }),
  };
  let done: unknown;
  try {
    done = await session.upload({ burrow: options.burrow, attachmentId: attachment.id }, source, {
      ...(signal && { signal }),
      onProgress: (p) => {
        if (p.total > 0) options.onProgress?.(p.sent / p.total);
      },
    });
  } catch (error) {
    throw toUploadError(error);
  }
  const ready = (done as { attachment?: Attachment } | undefined)?.attachment;
  if (!ready) throw new UploadError('Upload failed. Try again.', null);
  return ready;
}

function toUploadError(error: unknown): unknown {
  if (error instanceof UploadError) return error;
  if (error instanceof StreamError && error.code === 'cancelled')
    return new UploadError('Cancelled.', null, true);
  if (error instanceof Error && error.name === 'AbortError') return new UploadError('Cancelled.', null, true);
  if (error instanceof StreamError && error.code === 'tooLarge')
    return new UploadError('That file is too big.', 413);
  if (error instanceof StreamError && (error.code === 'forbidden' || error.code === 'refused'))
    return new UploadError(error.message || 'Upload failed. Try again.', 403);
  if (error instanceof StreamError && error.code === 'lost') return new UploadError(CONNECTION, null);
  if (error instanceof StreamError && error.code === 'integrity')
    return new UploadError('The file changed or was damaged while uploading. Try again.', null);
  return error;
}
