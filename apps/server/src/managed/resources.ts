/**
 * Streams over the session (MA-08; `@whombat/protocol` `open{stream, spec}`; docs/decisions/managed-runtime.md
 * MR-14): attachment downloads (whole or a byte range, credit-paced from the file store), chunked resumable
 * uploads (sha256 per chunk and for the whole file, into the existing `FileStore` staging and `complete_upload`), voice
 * typing recordings (the same chunks, in memory, turned into text; docs/decisions/dictation.md), exports (an allowlisted op's output as a file), canvas collaboration (y-protocols messages bridged to the
 * server's Hocuspocus document handling), and consoles (the hosts service's console relayed, contracts 0.80.1). Memory stays bounded: downloads pull one chunk at a time under credit,
 * uploads append each DATA frame to the partial file as it arrives.
 *
 * Authorization is REST's: `burrowAccess` and `readableAttachment` for downloads (a thing page's pictures as their
 * route, `things/image-route.ts`), the reservation's uploader for
 * uploads, the export op's own handler, and the canvas's burrow plus the collaboration service's checks for canvases
 * (the stream binds the session's account).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_FILE_CONTENT_TYPE, collabDocumentName, isPageSet } from '@whombat/core';
import {
  type DictationErrorCode,
  type DictationOutput,
  VOICE_TYPING_MAX_BYTES,
  VOICE_WORDS,
} from '@whombat/core/domain';
import { encodeCollabMessages } from '@whombat/protocol/collab';
import {
  type Chunk,
  type OperationSpec,
  REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE,
  type RemoteHelpTranscriptInput,
  type StreamMeta,
  type StreamSpec,
} from '@whombat/protocol/session';
import { and, eq } from 'drizzle-orm';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { z } from 'zod';
import { type BurrowAccess, burrowAccess } from '../auth/request';
import { backupsFor } from '../backups/service';
import { attachments, canvases, sessionUploads } from '../db/schema/index';
import { readableAttachment } from '../files/access';
import { completeUpload } from '../files/commands';
import { servedContentType } from '../files/http';
import { attachmentPreview } from '../files/previews';
import { filesDir, toAttachment } from '../files/service';
import { Sniffer } from '../files/sniff';
import { makeThumbnail } from '../files/thumbnails';
import { openConsoleStream } from '../hosts/console';
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { pageSetPreview } from '../pages/cover';
import type { Services } from '../services';
import { imageViewer, thingPicture } from '../things/image-route';
import { DictationError, voiceTypingFor } from '../voice/service';
import { SESSION_EXPORT_OPS, SESSION_EXPORT_READS, type SessionDispatcher } from './dispatcher';
import { STREAM_RESET } from './ports';
import { remoteHelpTranscript } from './remote-help';
import { BoundedCollabDecoder, CollabBudget } from './session/collab-decoder';
import { type SessionStream, StreamReset } from './session/streams';
import type { SessionPrincipal } from './trust';

/** What the connection needs to answer an `open`. */
export interface OpenedStream {
  meta: StreamMeta;
  /** Runs after `opened` was sent (pumps bytes); its failure resets the stream. */
  run?: () => Promise<void>;
  /** Upload streams: the next chunk's announcement. */
  onChunk?: (chunk: Chunk) => void;
}

export interface StreamContext {
  services: Services;
  principal: SessionPrincipal;
  stream: SessionStream;
  /** Sends a CONTROL message (`chunk_ack`, `stream_done`). */
  send(message: Record<string, unknown> & { t: string }): Promise<void>;
  /** The session's budget for partially received collaboration messages (MR-33). */
  collabBudget?: CollabBudget;
}

async function access(
  services: Services,
  principal: SessionPrincipal,
  burrow: string,
): Promise<BurrowAccess> {
  if (!principal.account) throw unauthorized();
  try {
    return await burrowAccess(services, { account: principal.account }, burrow);
  } catch (err) {
    if (err instanceof ApiError && err.code !== 'unauthorized') throw notFound('That');
    throw err;
  }
}

/** Streams bytes from an async source, then `stream_done{size, sha256}` and END. */
async function pump(
  ctx: StreamContext,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<void> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
    hash.update(bytes);
    size += bytes.length;
    await ctx.stream.write(bytes);
  }
  await ctx.send({ t: 'stream_done', stream: ctx.stream.id, size, sha256: hash.digest('hex') });
  await ctx.stream.end();
}

/* Downloads ----------------------------------------------------------------------------------------- */

export async function openDownload(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'download' }>,
): Promise<OpenedStream> {
  const { services, principal } = ctx;
  const resource = spec.resource;
  if (resource.type === 'backup-file') return openBackupDownload(ctx, spec, resource);
  if (resource.type === 'thing-image') return openThingImage(ctx, spec, resource);
  const { principal: person } = await access(services, principal, resource.burrow);
  const row = await readableAttachment(services.db, person.burrowId, person.id, resource.attachmentId);
  if (!row?.blobKey || !row.sha256) throw notFound('File');
  // A preview is a real derived image or nothing: never the original under another name (CT-21).
  if (resource.variant === 'preview')
    return openPreview(ctx, spec, { ...row, blobKey: row.blobKey, sha256: row.sha256 });
  const size = await services.files.store.size(row.blobKey);
  if (size === null) throw notFound('File');
  const start = spec.range?.start ?? 0;
  const end = Math.min(spec.range?.end ?? size, size);
  if (start > end || (start === size && size > 0)) throw badRequest('That range is outside the file.');
  const blobKey = row.blobKey;
  return {
    meta: {
      kind: 'download',
      size,
      range: { start, end },
      contentType: servedContentType(row.contentType, row.kind),
      name: row.name,
      sha256: row.sha256,
    },
    run: async () => {
      if (end === start) return pump(ctx, []);
      const readable = await services.files.store.open(blobKey, { start, end: end - 1 });
      if (!readable) return ctx.stream.reset(STREAM_RESET.notFound);
      try {
        // One chunk at a time; `write` waits for the client's credit and the connection budget.
        await pump(ctx, readable as AsyncIterable<Uint8Array>);
      } finally {
        readable.destroy();
      }
    },
  };
}

/**
 * A backup file the caller made (`DownloadResource {type: 'backup-file'}`, docs/decisions/backup-file.md BF-10): its
 * bytes from the staging directory, resumable by range. Gone or past its 24 hours: refused with `backup_file.expired`.
 */
async function openBackupDownload(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'download' }>,
  resource: { burrow: string; backupFileId: string },
): Promise<OpenedStream> {
  const { principal: person, burrow } = await access(ctx.services, ctx.principal, resource.burrow);
  const { row, path } = await backupsFor(ctx.services).downloadable(burrow.id, person, resource.backupFileId);
  const size = row.size as number;
  const start = spec.range?.start ?? 0;
  const end = Math.min(spec.range?.end ?? size, size);
  if (start > end || (start === size && size > 0)) throw badRequest('That range is outside the file.');
  return {
    meta: {
      kind: 'download',
      size,
      range: { start, end },
      contentType: BACKUP_FILE_CONTENT_TYPE,
      name: row.name,
      sha256: row.sha256 as string,
    },
    run: async () => {
      if (end === start) return pump(ctx, []);
      const readable = createReadStream(path, { start, end: end - 1 });
      try {
        await pump(ctx, readable as AsyncIterable<Uint8Array>);
      } finally {
        readable.destroy();
      }
    },
  };
}

/**
 * A picture on a thing's page (`DownloadResource {type: 'thing-image'}`, service-dashboards.md SD-06, SD-S03): the HTTP
 * route's checks and bytes (`things/image-route.ts`), streamed like a download. Anything wrong is the same `not_found`.
 */
async function openThingImage(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'download' }>,
  resource: { burrow: string; thing: string; ref: string },
): Promise<OpenedStream> {
  const { services, principal } = ctx;
  if (!principal.account) throw unauthorized();
  const inBurrow = await access(services, principal, resource.burrow);
  const picture = await thingPicture(
    services,
    imageViewer(principal.account.id, inBurrow),
    resource.thing,
    resource.ref,
  );
  const bytes = picture.bytes;
  const start = Math.min(spec.range?.start ?? 0, bytes.length);
  const end = Math.min(spec.range?.end ?? bytes.length, bytes.length);
  if (start > end) throw badRequest('That range is outside the picture.');
  return {
    meta: {
      kind: 'download',
      size: bytes.length,
      range: { start, end },
      contentType: picture.contentType,
      name: `picture.${picture.contentType.slice('image/'.length).replace('jpeg', 'jpg')}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    run: () => pump(ctx, [new Uint8Array(bytes.subarray(start, end))]),
  };
}

/** A PNG/JPEG attachment's bounded-size thumbnail (`files/previews.ts`), streamed like a download. */
async function openPreview(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'download' }>,
  row: {
    blobKey: string;
    sha256: string;
    contentType: string;
    width: number | null;
    height: number | null;
    size: number;
    name: string;
  },
): Promise<OpenedStream> {
  const { services } = ctx;
  // A page set's preview is the picture of its first page (docs/decisions/page-sets.md).
  const made = isPageSet(row)
    ? await pageSetPreview(services, row)
    : await attachmentPreview({
        filesRoot: filesDir(services.config),
        store: services.files.store,
        images: services.feedback.images,
        source: row,
      });
  if (!made.ok)
    throw new ApiError('not_found', 'There is no preview of this file.', {
      details: { code: 'variant_unavailable', reason: made.reason },
    });
  const bytes = made.preview.bytes;
  const start = Math.min(spec.range?.start ?? 0, bytes.length);
  const end = Math.min(spec.range?.end ?? bytes.length, bytes.length);
  if (start > end) throw badRequest('That range is outside the preview.');
  return {
    meta: {
      kind: 'download',
      size: bytes.length,
      range: { start, end },
      contentType: made.preview.contentType,
      name: `preview-${row.name}`.slice(0, 1000),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    run: () => pump(ctx, [new Uint8Array(bytes.subarray(start, end))]),
  };
}

/* Exports ------------------------------------------------------------------------------------------- */

/**
 * Ops that may be opened as an export stream: file outputs and reads (large lists, logs) — of the
 * session-native ones only the diagnostic bundle, a remote help visit's command line (RH-S07), `SESSION_EXPORT_OPS`
 * (*Listen*'s sample, DK-S54) and `SESSION_EXPORT_READS` (a screen's picture).
 */
export function exportable(spec: OperationSpec): boolean {
  return spec.transfer === 'export' || spec.exportable;
}

export async function openExport(
  ctx: StreamContext,
  dispatcher: SessionDispatcher,
  spec: Extract<StreamSpec, { kind: 'export' }>,
): Promise<OpenedStream> {
  const resolved = dispatcher.resolve(ctx.principal, spec.op);
  if (!resolved.ok) throw new ApiError('not_allowed', `${spec.op} can’t be exported.`);
  const op = resolved.spec;
  const diagnostics = op.op === 'diagnostics.download';
  const sessionRead =
    op.source === 'session' && (SESSION_EXPORT_OPS.has(op.op) || SESSION_EXPORT_READS.has(op.op));
  const transcript = op.op === 'remoteHelp.transcript';
  if (!exportable(op) || (op.source !== 'api' && !diagnostics && !sessionRead && !transcript))
    throw new ApiError('not_allowed', `${spec.op} can’t be exported.`);
  // A mutating export op is a command in all but receipt: it respects the drain gate like one
  // (review I-2, MR-35). It must stay free of side effects: it has no receipt, so a retry runs it again.
  if (op.mutating && !(await ctx.services.maintenance.opened()))
    throw new ApiError('conflict', 'The appliance is getting ready for an update. Try again in a moment.', {
      details: { code: 'unavailable' },
    });
  const parsed = op.input.safeParse(spec.input ?? {});
  if (!parsed.success) throw badRequest('The export input is not valid.');
  if (diagnostics) {
    // A diagnostic bundle (CT-52): exactly the stored document's canonical bytes; `stream_done.sha256` = the summary's.
    if (!dispatcher.diagnostics) throw new ApiError('not_implemented', 'Diagnostics aren’t available here.');
    const out = await dispatcher.diagnostics.download(ctx.principal, parsed.data as { bundleId: string });
    return {
      meta: { kind: 'export', contentType: 'application/json', name: out.name, size: out.bytes.length },
      run: () => pump(ctx, [out.bytes]),
    };
  }
  if (transcript) {
    // A remote help visit's command line (RH-07): the support service's text, cleaned on the way, streamed as it comes.
    const out = await remoteHelpTranscript(
      dispatcher.remoteHelp,
      ctx.principal,
      parsed.data as z.infer<typeof RemoteHelpTranscriptInput>,
    );
    return {
      meta: { kind: 'export', contentType: REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE, name: out.name },
      run: () => pump(ctx, out.stream),
    };
  }
  if (sessionRead) {
    // A session-native read (desk.voiceSample, a screen's picture): its output as UTF-8 JSON; a refusal refuses the
    // stream (CT-21).
    const bytes = new TextEncoder().encode(
      JSON.stringify(await dispatcher.runSession(op, ctx.principal, parsed.data)),
    );
    return {
      meta: { kind: 'export', contentType: 'application/json', size: bytes.length },
      run: () => pump(ctx, [bytes]),
    };
  }
  const out = await dispatcher.runApi(op, ctx.principal, parsed.data as { params: unknown });
  let bytes: Uint8Array;
  let contentType = 'application/json';
  let name: string | undefined;
  if (out.raw) {
    bytes = new TextEncoder().encode(String(out.raw.body));
    contentType = out.raw.headers['content-type'] ?? 'text/plain; charset=utf-8';
    name = /filename="([^"]+)"/.exec(out.raw.headers['content-disposition'] ?? '')?.[1];
  } else {
    bytes = new TextEncoder().encode(JSON.stringify(out.body));
  }
  return {
    meta: { kind: 'export', contentType, ...(name ? { name } : {}), size: bytes.length },
    run: () => pump(ctx, [bytes]),
  };
}

/**
 * Chunks announced and not yet acknowledged, at most: the credit window (≤ 16 MiB) over the smallest chunk
 * (64 KiB) — a client can't have more in flight than its credit lets it send.
 */
export const MAX_PIPELINED_CHUNKS = 256;

/**
 * Whether an announced chunk may come next (session protocol, orchestrator decision for 0.5.0): a client may announce
 * the next chunk before the previous one is acknowledged, bounded by credit, but announcements are strictly contiguous,
 * whole chunks except the last, and inside the file.
 */
function chunkMayFollow(
  chunk: Chunk,
  upload: { next: number; size: number; chunkSize: number; queued: number },
): boolean {
  const last = chunk.offset + chunk.size === upload.size;
  return (
    upload.queued < MAX_PIPELINED_CHUNKS &&
    chunk.offset === upload.next &&
    chunk.index === upload.next / upload.chunkSize &&
    chunk.size <= upload.chunkSize &&
    (last || chunk.size === upload.chunkSize) &&
    chunk.offset + chunk.size <= upload.size
  );
}

/* Uploads ------------------------------------------------------------------------------------------- */

/**
 * Chunked, resumable uploads into a reservation made by `uploads.create`: `open{upload}` answers the bytes already
 * durably received (a whole number of chunks); each `chunk{index, offset, size, sha256}` is followed by its DATA,
 * appended to the partial file as it arrives and acknowledged (`chunk_ack`) only once its sha256 matched; the
 * client's END finishes the file: its sha256 is checked, it is staged through the file store with the same
 * sniffing as the REST upload, and `complete_upload` commits it (`stream_done{output: {attachment}}`). A voice typing
 * recording (`dictation`) has no reservation and never touches the disk (`receiveDictation`).
 */
export class SessionUploads {
  private readonly busy = new Set<string>();
  /** Voice typing recordings held in memory now. */
  private dictating = 0;

  constructor(private readonly services: Services) {}

  private partialPath(attachmentId: string): string {
    return join(filesDir(this.services.config), 'partial', attachmentId);
  }

  /** The upload's target: an attachment reserved with `uploads.create`, or a backup file staged to restore. */
  private async target(
    ctx: StreamContext,
    spec: Extract<StreamSpec, { kind: 'upload' }>,
  ): Promise<{
    key: string;
    size: number;
    path?: string;
    complete: (sha256: string | undefined) => Promise<unknown>;
  }> {
    const { services, principal } = ctx;
    const target = spec.target;
    const { principal: person, burrow } = await access(services, principal, target.burrow);
    // A backup file to restore (docs/decisions/backup-file.md BF-10): its bytes go straight into the staged upload; its
    // sha256 may be left out (the box hashes the whole file once it is here, backup-options.md CT-1695).
    if (target.type === 'backup-file')
      return backupsFor(services).sessionTarget(burrow.id, person, target.stagedBackupId, {
        size: spec.size,
        ...(spec.sha256 ? { sha256: spec.sha256 } : {}),
      });
    // A voice typing recording has no reservation (`open` takes it apart).
    if (target.type !== 'attachment') throw badRequest('That upload has no reservation.');
    const sha256 = spec.sha256;
    if (!sha256) throw badRequest('An attachment’s upload names the whole file’s sha256.');
    const [row] = await services.db.select().from(attachments).where(eq(attachments.id, target.attachmentId));
    if (!row || row.burrowId !== person.burrowId || row.uploadedById !== person.id) throw notFound('Upload');
    if (row.state !== 'reserved') throw conflict('That file is already uploaded.');
    if (row.size !== spec.size) throw badRequest('The file’s size doesn’t match what was reserved.');
    return {
      key: row.id,
      size: row.size,
      complete: () => this.complete(principal, person, row.id, sha256),
    };
  }

  async open(ctx: StreamContext, spec: Extract<StreamSpec, { kind: 'upload' }>): Promise<OpenedStream> {
    if (spec.target.type === 'dictation') {
      if (!spec.sha256) throw badRequest('A recording’s upload names its sha256.');
      return this.openDictation(ctx, spec, spec.target.burrow);
    }
    const target = await this.target(ctx, spec);
    if (this.busy.has(target.key)) throw conflict('That file is uploading already.');
    // Reserve before any file setup can yield: another stream must not truncate the same partial file.
    this.busy.add(target.key);
    try {
      return await this.openFile(ctx, spec, target);
    } catch (err) {
      this.busy.delete(target.key);
      throw err;
    }
  }

  private async openFile(
    ctx: StreamContext,
    spec: Extract<StreamSpec, { kind: 'upload' }>,
    target: Awaited<ReturnType<SessionUploads['target']>>,
  ): Promise<OpenedStream> {
    const { services, principal, stream } = ctx;
    const row = { id: target.key, size: target.size };
    const accountId = principal.account?.id as string;
    const path = target.path ?? this.partialPath(row.id);
    await mkdir(join(filesDir(services.config), 'partial'), { recursive: true, mode: 0o700 });
    const [existing] = await services.db
      .select()
      .from(sessionUploads)
      .where(eq(sessionUploads.attachmentId, row.id));
    let received = 0;
    // A backup file sent without its sha256 resumes as one sent without it.
    const announced = spec.sha256 ?? UNANNOUNCED;
    if (existing && existing.accountId === accountId && existing.sha256 === announced) {
      const onDisk = await stat(path).then(
        (s) => s.size,
        () => 0,
      );
      received = Math.min(onDisk, existing.receivedBytes);
      received -= received % spec.chunkSize;
    } else {
      await services.db.delete(sessionUploads).where(eq(sessionUploads.attachmentId, row.id));
      await services.db
        .insert(sessionUploads)
        .values({ attachmentId: row.id, accountId, sha256: announced, receivedBytes: 0 })
        .onConflictDoNothing();
    }
    // Whatever lies past the last acknowledged chunk is dropped (the file is made when missing).
    const partial = await open(path, 'a', 0o600);
    try {
      await partial.truncate(received);
    } finally {
      await partial.close();
    }
    await services.db
      .update(sessionUploads)
      .set({ receivedBytes: received, updatedAt: services.clock() })
      .where(eq(sessionUploads.attachmentId, row.id));

    // Pipelined chunks (session protocol, orchestrator decision for 0.5.0): a client may announce the next chunk
    // before the previous one is acknowledged, bounded by credit. Announcements must be strictly contiguous; they
    // queue here and are filled, checked, stored and acknowledged in order.
    type Pending = { chunk: Chunk; got: number; hash: ReturnType<typeof createHash> };
    const queue: Pending[] = [];
    /** Where the next announced chunk must start. */
    let announcedUpTo = received;
    let fh: FileHandle | null = await open(path, 'r+');
    let active = Promise.resolve();
    let releasing: Promise<void> | null = null;
    const release = () => {
      releasing ??= (async () => {
        // A reset can arrive while a write or completion is still using the file and its resume record.
        await active.catch(() => {});
        const handle = fh;
        fh = null;
        await handle?.close().catch(() => {});
        this.busy.delete(row.id);
      })();
      return releasing;
    };
    stream.onReset(() => void release());
    const receive = async (data: Uint8Array) => {
      let bytes = data;
      while (bytes.length > 0) {
        const current = queue[0];
        if (!current) throw new StreamReset(STREAM_RESET.protocolError, 'DATA before its chunk');
        // A backup checkpoint's write barrier (drain scope `writes`) holds file writes too (MR-15).
        await services.maintenance.writeBarrier();
        if (stream.resetCode !== null) return;
        const take = Math.min(bytes.length, current.chunk.size - current.got);
        const part = bytes.subarray(0, take);
        bytes = bytes.subarray(take);
        await fh?.write(part, 0, part.length, current.chunk.offset + current.got);
        current.got += part.length;
        current.hash.update(part);
        if (current.got < current.chunk.size) continue;
        queue.shift();
        if (current.hash.digest('hex') !== current.chunk.sha256) {
          await fh?.truncate(received);
          await ctx
            .send({
              t: 'error',
              stream: stream.id,
              code: 'bad_request',
              message: 'That chunk doesn’t match its sha256; send it again.',
              retryable: false,
              details: { code: 'upload_integrity', index: current.chunk.index },
            })
            .catch(() => {});
          throw new StreamReset(STREAM_RESET.integrity, 'chunk sha256 mismatch');
        }
        await fh?.sync();
        received = current.chunk.offset + current.chunk.size;
        await services.db
          .update(sessionUploads)
          .set({ receivedBytes: received, updatedAt: services.clock() })
          .where(eq(sessionUploads.attachmentId, row.id));
        await ctx.send({ t: 'chunk_ack', stream: stream.id, index: current.chunk.index, received });
      }
    };
    stream.onData((data) => {
      active = receive(data);
      return active;
    });
    stream.onEnd(() => {
      active = (async () => {
        try {
          if (stream.resetCode !== null) return;
          if (queue.length > 0 || received !== row.size) {
            await stream.reset(STREAM_RESET.protocolError);
            return;
          }
          await fh?.close();
          fh = null;
          await services.maintenance.writeBarrier();
          const output = await target.complete(spec.sha256);
          // Unannounced, the whole file's sha256 is the one the box worked out (a backup file's output carries it).
          const whole = spec.sha256 ?? (output as { sha256?: string } | null)?.sha256 ?? '';
          await ctx.send({
            t: 'stream_done',
            stream: stream.id,
            size: row.size,
            sha256: whole,
            output,
          });
          await stream.end();
        } catch (err) {
          services.log.warn({ err: String(err) }, 'session upload could not be completed');
          // Say why on the control stream (`error{stream}` with the app code), then reset the stream.
          const integrity =
            err instanceof ApiError &&
            (err.extra.details as { code?: string } | undefined)?.code === 'upload_integrity';
          if (err instanceof ApiError)
            await ctx
              .send({
                t: 'error',
                stream: stream.id,
                code: err.code,
                message: err.message,
                retryable: false,
                ...(err.extra.details !== undefined ? { details: err.extra.details } : {}),
              })
              .catch(() => {});
          await stream.reset(integrity ? STREAM_RESET.integrity : STREAM_RESET.internal);
        }
      })();
      void active.finally(release);
    });
    return {
      meta: { kind: 'upload', received, chunkSize: spec.chunkSize },
      onChunk: (chunk) => {
        const upload = {
          next: announcedUpTo,
          size: row.size,
          chunkSize: spec.chunkSize,
          queued: queue.length,
        };
        if (!chunkMayFollow(chunk, upload)) {
          void stream.reset(STREAM_RESET.protocolError);
          return;
        }
        queue.push({ chunk, got: 0, hash: createHash('sha256') });
        announcedUpTo = chunk.offset + chunk.size;
      },
    };
  }

  /**
   * A voice typing recording (docs/decisions/dictation.md): the person's, in their burrow; at most five minutes
   * of audio, and at most `DICTATIONS_AT_ONCE` held at once on the box.
   */
  private async openDictation(
    ctx: StreamContext,
    spec: Extract<StreamSpec, { kind: 'upload' }>,
    burrowSlug: string,
  ): Promise<OpenedStream> {
    const { burrow } = await access(ctx.services, ctx.principal, burrowSlug);
    if (spec.size > VOICE_TYPING_MAX_BYTES)
      throw new ApiError('bad_request', VOICE_WORDS.errors.too_long, { details: { code: 'too_long' } });
    if (this.dictating >= DICTATIONS_AT_ONCE)
      throw new ApiError('unavailable', VOICE_WORDS.errors.busy, { details: { code: 'busy' } });
    this.dictating++;
    const voice = voiceTypingFor(ctx.services);
    return receiveDictation(
      ctx,
      spec,
      (audio, signal) => voice.dictate(audio, burrow.id, signal),
      () => this.dictating--,
    );
  }

  private async complete(
    principal: SessionPrincipal,
    person: BurrowAccess['principal'],
    attachmentId: string,
    sha256: string,
  ): Promise<{ attachment: unknown }> {
    if (!principal.account) throw notFound('Upload');
    const services = this.services;
    const done = async () => {
      await services.db.delete(sessionUploads).where(eq(sessionUploads.attachmentId, attachmentId));
      await rm(this.partialPath(attachmentId), { force: true });
    };
    try {
      const out = await completeAttachmentUpload(
        services,
        person,
        attachmentId,
        createReadStream(this.partialPath(attachmentId)),
        sha256,
      );
      await done();
      return out;
    } catch (err) {
      // A file that doesn't match its sha256 starts over; anything else may be finished again.
      if (
        err instanceof ApiError &&
        (err.extra.details as { code?: unknown } | undefined)?.code === 'upload_integrity'
      )
        await done();
      throw err;
    }
  }
}

/** What a session upload's row keeps when the client didn't announce the file's sha256 (a backup file, CT-1695). */
const UNANNOUNCED = 'unannounced';

/** Voice typing recordings held in memory at once on the box (up to 9.6 MB each); one more is refused as `busy`. */
export const DICTATIONS_AT_ONCE = 4;

/** The session's error code a voice typing refusal travels under; the reason is `details.code`. */
const DICTATION_SESSION_CODES: Record<DictationErrorCode, ApiError['code']> = {
  dictation_off: 'conflict',
  not_ready: 'unavailable',
  busy: 'unavailable',
  bad_audio: 'bad_request',
  too_long: 'too_large',
  failed: 'internal',
};

/**
 * A voice typing recording's bytes: kept in memory only (never on disk, never logged) and never resumed
 * (`opened.meta.received` is 0); each chunk and the whole recording checked against their sha256 as for every upload.
 * END hands the recording to `dictate` and answers `stream_done{output: DictationOutput}`, or
 * `error{stream, code, details: {code}}` with why not. The stream has no timer of its own, so a recording that takes
 * minutes to turn into text waits as long as the speech service may take; a stream that goes stops the wait (`signal`).
 * `release` runs once when the recording is let go.
 */
export function receiveDictation(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'upload' }>,
  dictate: (audio: Buffer, signal: AbortSignal) => Promise<DictationOutput>,
  release: () => void = () => {},
): OpenedStream {
  const { stream } = ctx;
  const audio = Buffer.alloc(spec.size);
  type Pending = { chunk: Chunk; got: number; hash: ReturnType<typeof createHash> };
  const queue: Pending[] = [];
  let announcedUpTo = 0;
  let received = 0;
  const gone = new AbortController();
  let held = true;
  const letGo = () => {
    if (held) release();
    held = false;
  };
  stream.onReset(() => {
    gone.abort();
    letGo();
  });
  stream.onData(async (data) => {
    let bytes = data;
    while (bytes.length > 0) {
      const current = queue[0];
      if (!current) throw new StreamReset(STREAM_RESET.protocolError, 'DATA before its chunk');
      const part = bytes.subarray(0, Math.min(bytes.length, current.chunk.size - current.got));
      bytes = bytes.subarray(part.length);
      audio.set(part, current.chunk.offset + current.got);
      current.got += part.length;
      current.hash.update(part);
      if (current.got < current.chunk.size) continue;
      queue.shift();
      if (current.hash.digest('hex') !== current.chunk.sha256) {
        await ctx
          .send({
            t: 'error',
            stream: stream.id,
            code: 'bad_request',
            message: 'That chunk doesn’t match its sha256; send it again.',
            retryable: false,
            details: { code: 'upload_integrity', index: current.chunk.index },
          })
          .catch(() => {});
        throw new StreamReset(STREAM_RESET.integrity, 'chunk sha256 mismatch');
      }
      received = current.chunk.offset + current.chunk.size;
      await ctx.send({ t: 'chunk_ack', stream: stream.id, index: current.chunk.index, received });
    }
  });
  stream.onEnd(() => {
    void (async () => {
      try {
        if (queue.length > 0 || received !== spec.size) {
          await stream.reset(STREAM_RESET.protocolError);
          return;
        }
        if (createHash('sha256').update(audio).digest('hex') !== spec.sha256) {
          await ctx
            .send({
              t: 'error',
              stream: stream.id,
              code: 'bad_request',
              message: 'The recording doesn’t match its sha256.',
              retryable: false,
              details: { code: 'upload_integrity' },
            })
            .catch(() => {});
          await stream.reset(STREAM_RESET.integrity);
          return;
        }
        const output = await dictate(audio, gone.signal);
        await ctx.send({
          t: 'stream_done',
          stream: stream.id,
          size: spec.size,
          sha256: spec.sha256 ?? '',
          output,
        });
        await stream.end();
      } catch (err) {
        // Nobody waits for the text any more.
        if (gone.signal.aborted) return;
        const code: DictationErrorCode = err instanceof DictationError ? err.code : 'failed';
        if (!(err instanceof DictationError))
          ctx.services.log.warn({ err: String(err) }, 'voice typing: the recording failed');
        await ctx
          .send({
            t: 'error',
            stream: stream.id,
            code: DICTATION_SESSION_CODES[code],
            message: VOICE_WORDS.errors[code],
            retryable: code === 'busy',
            details: { code },
          })
          .catch(() => {});
        await stream.reset(STREAM_RESET.internal);
      } finally {
        letGo();
      }
    })();
  });
  return {
    meta: { kind: 'upload', received: 0, chunkSize: spec.chunkSize },
    onChunk: (chunk) => {
      const upload = {
        next: announcedUpTo,
        size: spec.size,
        chunkSize: spec.chunkSize,
        queued: queue.length,
      };
      if (!chunkMayFollow(chunk, upload)) {
        void stream.reset(STREAM_RESET.protocolError);
        return;
      }
      queue.push({ chunk, got: 0, hash: createHash('sha256') });
      announcedUpTo = chunk.offset + chunk.size;
    },
  };
}

/**
 * Stages `source` as a reserved attachment's bytes, sniffed like every upload, checks it against `sha256`, commits
 * `complete_upload` as `person` and makes an image's thumbnail before answering (review-features.md RF-04). The
 * session's upload stream reads its partial file through it; tests hand it the bytes in one piece.
 */
export async function completeAttachmentUpload(
  services: Services,
  person: BurrowAccess['principal'],
  attachmentId: string,
  source: NodeJS.ReadableStream & AsyncIterable<Uint8Array>,
  sha256: string,
): Promise<{ attachment: unknown }> {
  const [row] = await services.db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!row) throw notFound('Upload');
  const sniffer = new Sniffer();
  const staged = await services.files.store.stage(source as never, {
    maxBytes: row.size,
    observe: (chunk) => sniffer.observe(chunk),
  });
  let keep = false;
  try {
    if (staged.sha256 !== sha256 || staged.size !== row.size)
      throw new ApiError('bad_request', 'The file doesn’t match its sha256. Upload it again.', {
        details: { code: 'upload_integrity' },
      });
    const sniffed = sniffer.result(row.name);
    if (!sniffed.ok)
      throw badRequest(
        sniffed.reason === 'image_too_large'
          ? 'That image is too large to show. Try a smaller one.'
          : 'That image is damaged, or isn’t an image we can show.',
      );
    const result = await services.pipeline.commit(
      completeUpload,
      {
        attachmentId,
        staged: { token: staged.token, size: staged.size, sha256: staged.sha256 },
        sniffed: sniffed.value,
      },
      { burrowId: person.burrowId, actorId: person.id },
    );
    keep = true;
    if (result.status !== 'ok') throw conflict('The upload could not be completed.');
    return { attachment: toAttachment(await makeThumbnail(services, result.result)) };
  } finally {
    if (!keep) await services.files.store.discard(staged).catch(() => {});
  }
}

/* Collaboration ------------------------------------------------------------------------------------- */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;
const MSG_SYNC_REPLY = 4;
const MSG_CLOSE = 7;
const AUTH_TOKEN = 0;
const AUTH_DENIED = 1;

/**
 * A server's or a guest's console (contracts 0.80.1, CT-350; one-whombat-consoles.md ONE-DC01…): the session's person in
 * the burrow, then the hosts service's console through `openConsoleStream` (the WebSocket proxy's rule and upstream).
 */
export async function openConsole(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'console' }>,
): Promise<OpenedStream> {
  const { principal: person, burrow } = await access(ctx.services, ctx.principal, spec.burrow);
  return openConsoleStream(ctx, spec, person, burrow.id);
}

/**
 * A canvas collaboration stream: DATA carries y-protocols messages (varuint type 0 sync / 1 awareness + body), each
 * length-prefixed (`[u32 len][bytes]`, ≤ 16 MiB, contracts 0.4.0) so a large update may span DATA frames. The
 * appliance bridges them to its Hocuspocus document handling (the same persistence, awareness
 * stamping and agent edits as `/collab`): it names the document on the way in, authenticates the stream as the
 * session's principal with a collaboration token it issues itself, and strips Hocuspocus' framing on the way out.
 */
export async function openCollab(
  ctx: StreamContext,
  spec: Extract<StreamSpec, { kind: 'collab' }>,
): Promise<OpenedStream> {
  const { services, principal, stream } = ctx;
  if (!principal.account) throw unauthorized();
  const { principal: person, burrow } = await access(services, principal, spec.burrow);
  const [canvas] = await services.db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, spec.canvasId), eq(canvases.burrowId, burrow.id)));
  if (!canvas) throw notFound('Canvas');
  const documentName = collabDocumentName(canvas.id);
  const { token } = services.collab.issueToken({
    canvasId: canvas.id,
    burrowId: burrow.id,
    principalId: person.id,
    dispatchId: null,
  });
  let open = true;
  const socket = {
    readyState: 1,
    send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
      if (!open || typeof data === 'string') return;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const decoder = decoding.createDecoder(bytes);
      decoding.readVarString(decoder);
      const type = decoding.readVarUint(decoder);
      const body = bytes.subarray(decoder.pos);
      if (type === MSG_AUTH) {
        if (decoding.readVarUint(decoder) === AUTH_DENIED) void stream.reset(STREAM_RESET.forbidden);
        return;
      }
      if (type === MSG_CLOSE) {
        socket.close();
        return;
      }
      if (type !== MSG_SYNC && type !== MSG_SYNC_REPLY && type !== MSG_AWARENESS) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, type === MSG_AWARENESS ? MSG_AWARENESS : MSG_SYNC);
      encoding.writeUint8Array(encoder, body);
      stream.write(encodeCollabMessages([encoding.toUint8Array(encoder)])).catch(() => {});
    },
    close() {
      if (!open) return;
      open = false;
      socket.readyState = 3;
      void stream.end();
    },
  };
  const client = services.collab.handleStream(socket, principal.account.id);
  const named = (message: Uint8Array) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, documentName);
    encoding.writeUint8Array(encoder, message);
    return encoding.toUint8Array(encoder);
  };
  const auth = encoding.createEncoder();
  encoding.writeVarString(auth, documentName);
  encoding.writeVarUint(auth, MSG_AUTH);
  encoding.writeVarUint(auth, AUTH_TOKEN);
  encoding.writeVarString(auth, token);
  client.handleMessage(encoding.toUint8Array(auth));
  // Incremental, within the session's budget (review L-7): never a 16 MiB buffer on a 4-byte promise.
  const decoder = new BoundedCollabDecoder(ctx.collabBudget ?? new CollabBudget());
  stream.onData((bytes) => {
    if (!open) return;
    let messages: Uint8Array[];
    try {
      messages = decoder.push(bytes);
    } catch {
      throw new StreamReset(STREAM_RESET.protocolError, 'bad collab framing');
    }
    for (const message of messages) {
      const type = decoding.readVarUint(decoding.createDecoder(message));
      if (type !== MSG_SYNC && type !== MSG_AWARENESS)
        throw new StreamReset(STREAM_RESET.protocolError, 'not a y-protocols message');
      client.handleMessage(named(message));
    }
  });
  const closed = () => {
    decoder.fail();
    if (!open) return;
    open = false;
    socket.readyState = 3;
    client.handleClose({ code: 1000, reason: 'stream closed' });
  };
  stream.onEnd(closed);
  stream.onReset(closed);
  return { meta: { kind: 'collab', documentName, readOnly: false } };
}
