/**
 * The runner's byte route for attachments (`ATTACHMENT_TRANSFER.runnerFetch` in core; docs/decisions/bp-attachments.md):
 * a dispatch's file, with Range. Not a JSON endpoint, so it lives outside `routes/define.ts`. People's uploads and
 * downloads go over their session's streams (`managed/resources.ts`).
 */
import { ATTACHMENT_TRANSFER, AttachmentId, DispatchId, RunnerAttachmentQuery } from '@whombat/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { WINDOW_SIZE } from '../runtime/context';
import { requireRunner } from '../runtime/routes';
import type { Services } from '../services';
import { dispatchReadableAttachment } from './access';
import { attachmentHeaders, notModified, parseRange } from './http';

const RunnerParams = z.object({ dispatchId: DispatchId, attachmentId: AttachmentId });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw notFound('File');
  return r.data;
}

/** Streams a blob (whole or one range) with the attachment headers, or answers 304 / 416. */
async function sendBlob(
  services: Services,
  req: FastifyRequest,
  reply: FastifyReply,
  row: {
    blobKey: string | null;
    sha256: string | null;
    size: number;
    contentType: string;
    kind: Parameters<typeof attachmentHeaders>[0]['kind'];
    name: string;
  },
  forceDownload: boolean,
) {
  if (!row.blobKey || !row.sha256) throw notFound('File');
  const size = await services.files.store.size(row.blobKey);
  if (size === null) {
    services.log.error({ blobKey: row.blobKey }, 'attachment bytes are missing from the file store');
    throw notFound('File');
  }
  reply.headers(
    attachmentHeaders({
      contentType: row.contentType,
      kind: row.kind,
      name: row.name,
      sha256: row.sha256,
      forceDownload,
    }),
  );
  if (notModified(req.headers['if-none-match'], row.sha256)) return reply.code(304).send();
  const range = parseRange(req.headers.range, size);
  if (range.kind === 'unsatisfiable') {
    reply.header('content-range', `bytes */${size}`);
    return reply.code(416).send();
  }
  const status = range.kind === 'range' ? 206 : 200;
  const length = range.kind === 'range' ? range.end - range.start + 1 : size;
  reply.header('content-length', String(length));
  if (range.kind === 'range') reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
  if (req.method === 'HEAD') {
    // Fastify would answer an empty HEAD body with `content-length: 0`: write the real headers ourselves.
    reply.hijack();
    reply.raw.writeHead(status, reply.getHeaders() as Record<string, string>);
    reply.raw.end();
    return reply;
  }
  const stream = await services.files.store.open(
    row.blobKey,
    range.kind === 'range' ? { start: range.start, end: range.end } : undefined,
  );
  if (!stream) throw notFound('File');
  return reply.code(status).send(stream);
}

async function runnerFetch(services: Services, req: FastifyRequest, reply: FastifyReply) {
  requireRunner(services, req);
  const params = parse(RunnerParams, req.params);
  const lease = RunnerAttachmentQuery.parse(req.query ?? {});
  const dispatch = await services.runtime.liveDispatch(params.dispatchId, {
    ...(lease.runnerId ? { runnerId: lease.runnerId } : {}),
    ...(lease.attempt ? { attempt: lease.attempt } : {}),
  });
  const row = await dispatchReadableAttachment(services.db, dispatch, WINDOW_SIZE, params.attachmentId);
  if (!row) throw notFound('File');
  return sendBlob(services, req, reply, row, true);
}

/** The runner's fetch of a dispatch's file (sessions download and upload over their own streams). */
export function registerFileRoutes(app: FastifyInstance, services: Services): void {
  const rf = ATTACHMENT_TRANSFER.runnerFetch;
  app.get(`${rf.base}${rf.path}`, { logLevel: 'warn' }, (req, reply) => runnerFetch(services, req, reply));
}
