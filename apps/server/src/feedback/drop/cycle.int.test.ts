/**
 * The whole drop cycle over a real manager socket (docs/decisions/feedback-drop.md FD-06, FD-11, FD-21, FD-22): the
 * runtime's `ManagerSocketClient` talks HTTP over a unix socket to a fake manager whose control is in memory. With
 * the service's timers running, creating an integration publishes its card, a report sealed to that card and dropped
 * at control is pulled, filed and acknowledged, without any test driving the loop.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGER_PATHS,
  RuntimeFeedbackAckRequest,
  RuntimeFeedbackCardsRequest,
  RuntimeFeedbackPullRequest,
} from '@whombat/control-contracts/local';
import { feedbackReferenceFor, sealDropEnvelope, siteKeyFingerprint } from '@whombat/core/feedback/drop';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applianceState, feedbackReports } from '../../db/schema/index';
import { ManagerSocketClient } from '../../managed/manager-client';
import { FakeFeedbackControl } from '../../managed/testing';
import { createIntegration, SITE_ORIGIN, submission } from '../../test/feedback';
import { useManagedRuntime } from '../../test/managed';
import { FeedbackDropService } from './index';

const m = useManagedRuntime({ seed: true });
const dir = mkdtempSync(join(tmpdir(), 'wb-drop-'));
const socketPath = join(dir, 'manager.sock');
const control = new FakeFeedbackControl();
const seen: string[] = [];
let server: Server;
let service: FeedbackDropService;

/** The manager's three feedback paths: parse like the manager, answer control's body (or its LocalError). */
function managerServer(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      try {
        let answer: unknown;
        if (req.url === MANAGER_PATHS.feedbackCards)
          answer = control.sync(RuntimeFeedbackCardsRequest.parse(body));
        else if (req.url === MANAGER_PATHS.feedbackPull)
          answer = control.pull(RuntimeFeedbackPullRequest.parse(body));
        else if (req.url === MANAGER_PATHS.feedbackAck) {
          control.ack(RuntimeFeedbackAckRequest.parse(body));
          answer = { ok: true };
        } else {
          res.statusCode = 404;
          answer = { error: { code: 'not_found', message: 'no such path' } };
        }
        res.end(JSON.stringify(answer));
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        res.statusCode = status;
        res.end(
          JSON.stringify({ error: { code: status === 501 ? 'unsupported' : 'bad_request', message: 'x' } }),
        );
      }
    });
  });
}

async function until<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  server = managerServer();
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  await m.t.services.db
    .insert(applianceState)
    .values({ id: 1, claimConsumedAt: new Date() })
    .onConflictDoUpdate({ target: applianceState.id, set: { claimConsumedAt: new Date() } });
  // Control asks for a quick next pull so the loop is observable.
  control.nextPullS = 2;
  service = new FeedbackDropService(m.t.services, new ManagerSocketClient(socketPath), {
    claimed: async () => true,
    timings: { syncDebounceMs: 10, retryMinMs: 50, retryMaxMs: 200, recheckMs: 50 },
  });
  m.t.services.feedback.drop = service;
  service.start();
});

afterAll(async () => {
  await service?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

it('publishes the card, pulls the sealed report, files it and acknowledges it', async () => {
  // The start-up sync (no sites yet) tells the runtime the drop works.
  // The fake answers before the service reads the answer: wait for what it concluded, not for the request (TS-02).
  await until('the first sync', async () => control.syncs.length > 0 && service.support !== 'unknown');
  expect(service.support).toBe('supported');

  const integration = await createIntegration(m.t);
  const signed = await until('the card', async () => control.cards.get(integration.siteId));
  expect(siteKeyFingerprint(signed.card.signingKey)).toBe(await service.keys.fingerprint());

  const sub = submission({ description: 'Sent through the drop.' });
  const envelope = await sealDropEnvelope(
    signed.card,
    JSON.stringify({
      v: 1,
      submission: sub,
      frame: { bridgeOrigin: SITE_ORIGIN, ancestorOrigins: null, widget: '1.1.0', cardSeq: signed.card.seq },
    }),
  );
  // The embed origin is the hosted app's own when WHOMBAT_EMBED_URL isn't set (FD-31).
  const dropId = control.drop(integration.siteId, envelope, 'https://app.whombat.test');

  const report = await until('the filed report', async () => {
    const [row] = await m.t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.submissionId, sub.submissionId));
    return row;
  });
  expect(report.reference).toBe(feedbackReferenceFor(integration.siteId, sub.submissionId));
  expect(report.description).toBe('Sent through the drop.');
  await until('the ack', async () => control.acked.includes(dropId));
  expect(control.queue).toHaveLength(0);
  expect(seen).toEqual(
    expect.arrayContaining([
      MANAGER_PATHS.feedbackCards,
      MANAGER_PATHS.feedbackPull,
      MANAGER_PATHS.feedbackAck,
    ]),
  );
});
