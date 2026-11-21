/**
 * (a) Vertical slice B (assignment §13): sign in (magic link), add the box to the account's Whombat Link with the code
 * on its screen, claim it on its own page with the letters on its screen, save and verify the recovery kit, connect, the Whombat's burrow with its one agent and the owner's Chat (Whombat one-agent.md
 * OA-01, OA-04), submit one task to the agent (the scripted Hermes), approve when asked, stream results, drop the
 * connection mid-stream and resume from the cursor without duplicates. Real control, relay, runtime, runner and
 * `@whombat/client`.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApplianceSession, RelaySocket } from '../src/scenario-kit/app-client.ts';
import { whenOpen, whenState } from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import { claimAppliance, loadSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import {
  api,
  collect,
  createApprovalAutomation,
  ensureWorkspace,
  eventType,
  type Workspace,
} from '../src/scenario-kit/work.ts';

let slice: SliceState;
let session: ApplianceSession;
let sockets: RelaySocket[] = [];
let w: Workspace;

describe('a vertical slice B', () => {
  beforeAll(() => {
    sockets = [];
  });

  it('1 Whombat Link confirmed, claimed on its own page, recovery kit saved and verified, app session as owner', async (ctx) => {
    let s = loadSlice();
    if (!s) {
      const r = await claimAppliance({
        ownerKey: `owner-${Date.now()}`,
        ownerName: 'Ada Owner',
        probeUnconfirmedKit: true,
        narrate: (step, d) => note(ctx, step, d ?? {}),
      });
      expect(r.claimInfo.channel).toBe('enroll');
      // No kit is asked at the claim (Whombat BX-01); the one made after it is saved and verified.
      expect(r.enrolled).not.toHaveProperty('recoveryKitRequired');
      expect(r.state.recovery.confirmedAt).toBeTruthy();
      s = r.state;
    } else
      note(ctx, 'appliance already claimed by this harness run; reusing its endpoint', {
        owner: s.owner.email,
      });
    slice = s;
    const o = await ownerSession(slice, {
      onSocket: (x) => sockets.push(x),
      backoff: { baseMs: 100, maxMs: 1000 },
    });
    session = o.session;
    expect(o.info.channel).toBe('app');
    expect(o.info.account?.id).toBe(slice.owner.accountId);
    const status = await (await import('../src/scenario-kit/app-client.ts')).sessionOps.applianceStatus(
      session,
    );
    note(ctx, 'appliance.status', { status });
    expect((status as { recoveryKit?: { state?: string } }).recoveryKit ?? status).toBeTruthy();
  });

  it('2 the Whombat’s burrow with its one agent and the owner’s Chat', async (ctx) => {
    w = await ensureWorkspace(session, `Harness ${randomBytes(3).toString('hex')}`);
    note(ctx, 'workspace', { ...w });
    expect(w.agent.id).toBeTruthy();
  });

  it('3 submit a task to the agent; results stream; a dropped connection resumes from the cursor without duplicates', async (ctx) => {
    const events = collect(session, [`burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
    await events
      .waitFor((e) => e.topic.startsWith('conv:') || e.topic.startsWith('burrow:'), 3000)
      .catch(() => null);
    const marker = `task-${randomBytes(4).toString('hex')}`;
    const sent = await api<{ message: { id: string }; dispatches: { dispatchId: string }[] }>(
      session,
      'messages.send',
      'POST',
      {
        params: { burrow: w.slug, conversationId: w.conversationId },
        body: { text: `@${w.agent.name} please look at ${marker}`, clientId: marker },
      },
    );
    expect(sent.dispatches).toHaveLength(1);
    // The agent is thinking: drop the connection now (kill the client WebSocket), while the reply is on its way.
    await events.waitFor(
      (e) => eventType(e) === 'typing' && (e.event as { principalId: string }).principalId === w.agent.id,
      15_000,
      'agent thinking',
    );
    const cursorsBefore = events.events.filter((e) => e.cursor).length;
    const open = sockets.filter((x) => x.readyState === 1);
    for (const x of open) x.close(4000, 'harness: drop mid-stream');
    await whenState(session, (st) => st.status === 'reconnecting', 10_000);
    await whenOpen(session, 30_000);
    const reply = await events.waitFor(
      (e) => {
        const m = (
          e.event as { type: string; message?: { author?: { id: string }; authorId?: string; text?: string } }
        ).message;
        return eventType(e) === 'message.created' && (m?.author?.id ?? m?.authorId) === w.agent.id ? m : null;
      },
      60_000,
      'agent reply',
    );
    note(ctx, 'streamed', {
      droppedSockets: open.length,
      cursorsBeforeDrop: cursorsBefore,
      events: events.events.map((e) => `${e.cursor ?? '-'} ${e.topic} ${eventType(e)}`),
      readies: events.readies,
      snapshots: events.snapshots,
      reply: (reply as { text?: string }).text,
    });
    expect(events.duplicateCursors()).toEqual([]);
    expect(events.duplicateMessages()).toEqual([]);
    // The owner's own message and the agent's reply, each exactly once.
    const mine = events.messages().filter((m) => m.id === sent.message.id);
    expect(mine.length).toBe(1);
    expect(events.readies.some((r) => r.resumed)).toBe(true);
    expect(events.snapshots).toEqual([]);
    // The message list agrees (snapshot view).
    const page = await api<{ messages: { id: string }[] }>(session, 'messages.list', 'GET', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      query: {},
    });
    const ids = page.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    events.close();
  });

  it('4 a task that needs approval: asked, approved, the result is posted', async (ctx) => {
    const events = collect(session, [`burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
    const marker = `approve-${randomBytes(4).toString('hex')}`;
    const automation = await createApprovalAutomation(session, w, marker);
    const run = await api<{ run: { id: string; number: number; status: string } }>(
      session,
      'automations.runNow',
      'POST',
      {
        params: { burrow: w.slug, id: automation.id },
        body: { test: false },
      },
    );
    note(ctx, 'automation run started', { run: run.run });
    const approval = await events.waitFor(
      (e) => {
        const a = (e.event as { type: string; approval?: { number: number; state: string; title?: string } })
          .approval;
        return eventType(e) === 'approval.updated' && a?.state === 'pending' ? a : null;
      },
      90_000,
      'approval requested',
    );
    const pending = await api<{ approvals: { number: number; state: string }[] }>(
      session,
      'approvals.list',
      'GET',
      {
        params: { burrow: w.slug },
        query: { state: 'pending' },
      },
    );
    expect(pending.approvals.map((a) => a.number)).toContain(approval.number);
    const decided = await api<{ approval: { state: string } }>(session, 'approvals.decide', 'POST', {
      params: { burrow: w.slug, number: approval.number },
      body: { decision: 'approve' },
    });
    note(ctx, 'approved', { approval: approval.number, state: decided.approval.state });
    const posted = await events.waitFor(
      (e) => {
        const m = (e.event as { message?: { text?: string } }).message;
        return eventType(e) === 'message.created' && m?.text?.includes(`Approved and published: ${marker}`)
          ? m
          : null;
      },
      90_000,
      'post after approval',
    );
    expect(posted).toBeTruthy();
    const agentReplies = events.messages().filter((m) => m.authorId === w.agent.id);
    note(ctx, 'run', { agentReplies: agentReplies.length, events: events.events.length });
    expect(agentReplies.length).toBeGreaterThanOrEqual(1);
    expect(events.duplicateCursors()).toEqual([]);
    expect(events.duplicateMessages()).toEqual([]);
    events.close();
  });
});
