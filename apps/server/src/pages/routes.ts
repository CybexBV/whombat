/**
 * The runner's PUT of a page set's bytes (`PAGES_TRANSFER.upload`, docs/decisions/page-sets.md): only for a
 * `show_pages` that still waits for this dispatch, from the runner holding its lease. The body streams into the file
 * store's staging area (never into memory), its last bytes are kept to check it is a set as the runner writes it, and
 * the waiting tool gets it; anything else is discarded.
 */
import { DispatchId, PAGES_TRANSFER, PreviewRequest, RunnerAttachmentQuery } from '@whombat/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { previewsFor } from '../browser/previews';
import { TooManyBytes } from '../files/store';
import { ApiError, notFound } from '../lib/errors';
import { requireRunner } from '../runtime/routes';
import type { Services } from '../services';
import { checkPageSet, Tail, UPLOAD_TAIL_BYTES } from './set';

const Params = z.object({ dispatchId: DispatchId, previewId: PreviewRequest.shape.id });

async function receivePages(services: Services, req: FastifyRequest, reply: FastifyReply) {
  requireRunner(services, req);
  const params = Params.safeParse(req.params);
  if (!params.success) throw notFound('Page set');
  const lease = RunnerAttachmentQuery.parse(req.query ?? {});
  const dispatch = await services.runtime.liveDispatch(params.data.dispatchId, {
    ...(lease.runnerId ? { runnerId: lease.runnerId } : {}),
    ...(lease.attempt ? { attempt: lease.attempt } : {}),
  });
  const broker = previewsFor(services);
  const id = params.data.previewId;
  if (!broker.waitsForPages(dispatch.id, id)) throw notFound('Page set');
  const store = services.files.store;
  const tail = new Tail(UPLOAD_TAIL_BYTES);
  let staged: Awaited<ReturnType<typeof store.stage>>;
  try {
    staged = await store.stage(req.raw, {
      maxBytes: services.files.maxBytes,
      observe: (chunk) => tail.push(chunk),
    });
  } catch (err) {
    const words =
      err instanceof TooManyBytes
        ? 'These pages are larger than a file can be here: show a smaller folder.'
        : 'The pages didn’t arrive whole. Try again.';
    broker.fulfil(dispatch.id, id, { error: words });
    if (err instanceof TooManyBytes) throw new ApiError('too_large', words);
    throw err;
  }
  const checked = checkPageSet(tail.bytes(), staged.size);
  if ('error' in checked) {
    await store.discard(staged).catch(() => {});
    broker.fulfil(dispatch.id, id, { error: checked.error });
    return reply.send({ ok: true });
  }
  // Too late (the tool stopped waiting): nobody keeps it.
  if (!broker.fulfil(dispatch.id, id, { pages: { staged, manifest: checked.manifest } })) {
    await store.discard(staged).catch(() => {});
    throw notFound('Page set');
  }
  return reply.send({ ok: true });
}

/** The page set PUT; its body is read by the route itself (no parser). */
export function registerPagesRoutes(app: FastifyInstance, services: Services): void {
  const up = PAGES_TRANSFER.upload;
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    scope.put(`${up.base}${up.path}`, { logLevel: 'warn' }, (req, reply) =>
      receivePages(services, req, reply),
    );
  });
}
