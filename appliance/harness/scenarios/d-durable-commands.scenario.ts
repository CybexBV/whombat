/**
 * (d) Durable commands and event cursors (assignment §14.5, MA-09): commit then lost acknowledgement → the same
 * request id resolves to the committed result, no duplicate; the same id with a different payload is refused
 * (`idempotency_mismatch`); a cursor older than the retention floor, or from before a runtime restart, gets
 * `snapshot_required` instead of a silent gap.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restartService } from '../src/dev/restart.ts';
import {
  type ApplianceSession,
  openSession,
  type RelaySocket,
  whenOpen,
  whenState,
} from '../src/scenario-kit/app-client.ts';
import { type HostileRelay, startHostileRelay } from '../src/scenario-kit/hostile-relay.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, identityOf, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api, collect, ensureWorkspace, type Workspace } from '../src/scenario-kit/work.ts';
import { env, persona, runtimeHealth, ticketSource } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let owner: ApplianceSession;
let w: Workspace;
let hostile: HostileRelay;

beforeAll(async () => {
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  w = await ensureWorkspace(owner, `Durable ${randomBytes(3).toString('hex')}`);
  hostile = await startHostileRelay(env().relay?.url ?? '');
});
afterAll(async () => {
  owner?.close('closed');
  await hostile?.close();
});

async function viaHostile(): Promise<ApplianceSession> {
  const p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
  const s = openSession({
    tickets: ticketSource(p, slice.deviceId, hostile.url),
    identity: identityOf(slice),
    appliance: { peerId: slice.peerId },
    channel: 'app',
    backoff: { baseMs: 100, maxMs: 500 },
    statusPollMs: 200,
  });
  await whenOpen(s);
  return s;
}

const listTexts = async (marker: string) => {
  const page = await api<{ messages: { id: string; text: string }[] }>(owner, 'messages.list', 'GET', {
    params: { burrow: w.slug, conversationId: w.conversationId },
    query: { limit: 50 },
  });
  return page.messages.filter((m) => m.text.includes(marker));
};

describe('d durable commands', () => {
  it('commit, then the acknowledgement is lost: the session resolves it by id, nothing is duplicated', async (ctx) => {
    const s = await viaHostile();
    const marker = `lost-ack-${randomBytes(4).toString('hex')}`;
    const requestId = `req_${randomBytes(12).toString('hex')}`;
    hostile.events.length = 0;
    hostile.armCut();
    const r = await s.call(
      { id: 'messages.send', method: 'POST' },
      { params: { burrow: w.slug, conversationId: w.conversationId }, query: {}, body: { text: marker } },
      { requestId, deadlineMs: 30_000 },
    );
    note(ctx, 'lost ack', { events: hostile.events, status: r.status, requestId });
    expect(hostile.events.some((e) => e.startsWith('cut after'))).toBe(true);
    expect([200, 201]).toContain(r.status);
    // A retry with the same id (e.g. after an app restart) replays the receipt.
    const again = await s.call(
      { id: 'messages.send', method: 'POST' },
      { params: { burrow: w.slug, conversationId: w.conversationId }, query: {}, body: { text: marker } },
      { requestId },
    );
    expect([200, 201]).toContain(again.status);
    expect((again.body as { message: { id: string } }).message.id).toBe(
      (r.body as { message: { id: string } }).message.id,
    );
    const found = await listTexts(marker);
    note(ctx, 'messages with the marker', { count: found.length });
    expect(found.length).toBe(1);
    s.close('closed');
  });

  it('same request id with a different payload is refused (idempotency_mismatch)', async (ctx) => {
    const requestId = `req_${randomBytes(12).toString('hex')}`;
    const params = { burrow: w.slug, conversationId: w.conversationId };
    const first = await owner.call(
      { id: 'messages.send', method: 'POST' },
      { params, query: {}, body: { text: 'one' } },
      { requestId },
    );
    expect([200, 201]).toContain(first.status);
    const second = await owner.call(
      { id: 'messages.send', method: 'POST' },
      { params, query: {}, body: { text: 'two' } },
      { requestId },
    );
    note(ctx, 'reuse with a different payload', { status: second.status, body: second.body });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain('idempotency_mismatch');
  });

  it('status of an unknown request id is not_found (it never committed: safe to resend)', async () => {
    const st = await owner.status(`req_${randomBytes(12).toString('hex')}`, {
      id: 'messages.send',
      method: 'POST',
    });
    expect(st.state).toBe('unknown');
  });

  it('a cursor from before a runtime restart gets snapshot_required, never a silent gap', async (ctx) => {
    const p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
    const s = openSession({
      tickets: ticketSource(p, slice.deviceId),
      identity: identityOf(slice),
      appliance: { peerId: slice.peerId },
      channel: 'app',
      backoff: { baseMs: 200, maxMs: 1000 },
    });
    await whenOpen(s);
    const events = collect(s, [`conv:${w.conversationId}`]);
    await api(s, 'messages.send', 'POST', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      body: { text: 'before restart' },
    });
    await events.waitFor((e) => !!e.cursor, 10_000, 'first durable event');
    await restartService('runtime');
    await whenState(s, (x) => x.status === 'reconnecting', 30_000).catch(() => null);
    await whenOpen(s, 60_000);
    await events.waitFor(
      () => events.snapshots.length > 0 || null,
      30_000,
      'snapshot_required after restart',
    );
    note(ctx, 'after runtime restart', {
      snapshots: events.snapshots,
      readies: events.readies,
      health: (await runtimeHealth()).ok,
    });
    expect(events.snapshots[0]?.reason).toBe('restart');
    events.close();
    s.close('closed');
  });

  it('a cursor below the retention floor gets snapshot_required{cursor_expired}', async (ctx) => {
    // dev/up runs the runtime with WHOMBAT_SESSION_EVENTS_MAX_COUNT=200 (IN-14); the sweep runs every 60 s.
    const max = 200;
    const p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
    let release: (() => void) | null = null;
    let offline = false;
    const sockets: RelaySocket[] = [];
    const tickets = ticketSource(p, slice.deviceId);
    const s = openSession({
      tickets: async (r) => {
        if (offline) await new Promise<void>((res) => (release = res));
        return tickets(r);
      },
      identity: identityOf(slice),
      appliance: { peerId: slice.peerId },
      channel: 'app',
      backoff: { baseMs: 200, maxMs: 1000 },
      onSocket: (x) => sockets.push(x),
    });
    await whenOpen(s);
    const events = collect(s, [`conv:${w.conversationId}`]);
    const params = { burrow: w.slug, conversationId: w.conversationId };
    const start = await api<{ message: { id: string } }>(s, 'messages.send', 'POST', {
      params,
      body: { text: 'retention start' },
    });
    await events.waitFor((e) => !!e.cursor, 10_000, 'first durable event');
    // The subscriber goes offline (no tickets) while the appliance writes more events than it keeps.
    offline = true;
    for (const x of sockets) if (x.readyState === 1) x.close(4000, 'harness: offline');
    await whenState(s, (x) => x.status === 'reconnecting', 10_000);
    // The events are edits of that one message: in the person's Chat every new message is a turn of the agent's, and
    // a few hundred of them would keep it busy long after this case (the later scenarios wait behind them).
    const n = max + 40;
    for (let i = 0; i < n; i += 20)
      await Promise.all(
        Array.from({ length: Math.min(20, n - i) }, (_, j) =>
          api(owner, 'messages.edit', 'PATCH', {
            params: { burrow: w.slug, messageId: start.message.id },
            body: { text: `retention start, edit ${i + j}` },
          }),
        ),
      );
    note(ctx, 'wrote events while the subscriber was offline; waiting for the retention sweep', {
      messages: n,
      maxCount: max,
    });
    await new Promise((r) => setTimeout(r, 65_000));
    offline = false;
    (release as (() => void) | null)?.();
    s.reconnectNow();
    await events.waitFor(
      () => events.snapshots.length > 0 || null,
      60_000,
      'snapshot_required after retention',
    );
    note(ctx, 'after retention', { snapshots: events.snapshots });
    expect(events.snapshots.some((x) => x.reason === 'cursor_expired')).toBe(true);
    events.close();
    s.close('closed');
  }, 240_000);
});
