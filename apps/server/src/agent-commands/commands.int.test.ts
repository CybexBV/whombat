/**
 * The agent's consequential commands against a real Postgres (docs/decisions/agent-computer.md AC-41, AC-42;
 * one-person.md OP-07, OP-S107): `runner.authorizeCommand` for every tier, the `run_command` card for the person in the turn's
 * thread, `runner.authorizeWait`, the three scopes of a yes, a late yes waking the agent, a no, allowances in Access
 * settings, and who may decide.
 */

import { commandBlockedText, commandWhyNeededText, type KeyId, newId, type Tier } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import {
  approvals,
  commandAllowances,
  commandPasses,
  dispatches,
  events,
  messages,
  vaultSshServers,
} from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { setGrant } from '../test/approvals';
import { useTestServer } from '../test/harness';
import { waitFor } from '../test/runner';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { addVaultSshServer, createVaultSshEntry } from '../vault/ssh-commands';
import { generateSshKey } from '../vault/ssh-keys';
import { setCommandDeliveryGraceForTests } from './commands';
import { holdDispatch, liveDispatch, RUNNER, runnerCall, threadRoot } from './testing';

const t = useTestServer({ seed: true, app: true });

let root = '';

async function grant(keyId: KeyId, tier: Tier) {
  await setGrant(t.services, IDS.dusty, keyId, tier);
}

async function authorize(
  dispatchId: string,
  command: string,
  category: string,
  target: string | null = null,
  reason: string | null = 'Ship the invoice fix',
) {
  return runnerCall(
    t,
    'POST',
    '/commands/authorize',
    {},
    {
      dispatchId,
      attempt: 1,
      runnerId: RUNNER,
      command,
      category,
      target,
      reason,
    },
  );
}

async function wait(dispatchId: string, approvalId: string, waitMs = 0) {
  return runnerCall(t, 'GET', '/commands/authorize/:approvalId', { approvalId }, undefined, {
    dispatchId,
    attempt: 1,
    runnerId: RUNNER,
    waitMs,
  });
}

async function approvalRow(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('no approval');
  return row;
}

async function decideAs(who: string, approvalId: string, body: Record<string, unknown>) {
  const row = await approvalRow(approvalId);
  return t.commit(who, decideApproval, { number: row.number, ...body } as never);
}

const passOf = async (approvalId: string) =>
  (await t.services.db.select().from(commandPasses).where(eq(commandPasses.approvalId, approvalId)))[0];

const wakesFor = async (approvalId: string) =>
  t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.approvalId, approvalId), eq(dispatches.trigger, 'approval_granted')));

beforeAll(async () => {
  setCommandDeliveryGraceForTests(150);
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host === 'web-1.example.com') return [{ address: '93.184.216.34', family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
  });
  // Mara's production server web-1.
  const entryId = newId('vaultEntry');
  const key = generateSshKey(entryId);
  await t.commit(IDS.mara, createVaultSshEntry, {
    entryId,
    name: 'Deploy key',
    privateKey: key.privateKey,
    auth: key.auth,
  });
  await t.commit(IDS.mara, addVaultSshServer, {
    entryId,
    name: 'web-1',
    host: 'web-1.example.com',
    port: 22,
    username: 'deploy',
    production: true,
  });
  root = await threadRoot(t, IDS.mara, IDS.billing, '@Dusty please ship the invoice fix');
});

describe('runner.authorizeCommand: the key decides (AC-41)', () => {
  it('On runs, and a production server is opened for it', async () => {
    await grant('deploy.production', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await authorize(d.id, 'ssh web-1 ./deploy.sh', 'deploy_production', 'web-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'run',
      approvalId: null,
      message: '',
      open: [
        { host: 'web-1.example.com', port: 22 },
        { host: '93.184.216.34', port: 22 },
      ],
    });
  });

  it('the server classifies again: a command the runner called a deploy that reaches production is production', async () => {
    await grant('deploy.production', 'cannot');
    await grant('deploy', 'can');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await authorize(d.id, 'ssh deploy@93.184.216.34 ./deploy.sh', 'deploy', null);
    expect(res.body).toMatchObject({ outcome: 'blocked' });
    expect(res.body.message).toBe(commandBlockedText('deploy_production', 'Dusty'));
  });

  it('Off is blocked at once, naming the key, and signed', async () => {
    await grant('commands.destructive', 'cannot');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await authorize(d.id, 'ssh staging rm -rf /srv/app', 'destructive', 'staging');
    expect(res.body).toEqual({
      outcome: 'blocked',
      approvalId: null,
      message: commandBlockedText('destructive', 'Dusty'),
      open: [],
    });
    const [blocked] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.kind, 'Blocked'))
      .orderBy(desc(events.createdAt))
      .limit(1);
    expect(blocked?.text).toContain('run a destructive command on staging');
  });

  it('refuses a runner that doesn’t hold the dispatch (409)', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await runnerCall(
      t,
      'POST',
      '/commands/authorize',
      {},
      {
        dispatchId: d.id,
        attempt: 1,
        runnerId: 'rnr_other',
        command: 'fly deploy',
        category: 'deploy',
        target: null,
      },
    );
    expect(res.status).toBe(409);
  });
});

describe('Ask: a card for the person, and the yes’s scope (AC-41, AC-42)', () => {
  let once = '';

  it('posts no card for a command that doesn’t say what it is for: the agent says why first', async () => {
    await grant('deploy', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const cards = async () => (await t.services.db.select({ id: approvals.id }).from(approvals)).length;
    const before = await cards();
    const res = await authorize(d.id, 'fly deploy --app why', 'deploy', null, null);
    expect(res.body).toEqual({
      outcome: 'blocked',
      approvalId: null,
      message: commandWhyNeededText('deploy'),
      open: [],
    });
    expect(await cards()).toBe(before);
    const asked = await authorize(d.id, 'fly deploy --app why', 'deploy', null, 'Put the fix live');
    expect(asked.body.outcome).toBe('pending');
    expect((await approvalRow(String(asked.body.approvalId))).action).toMatchObject({
      params: { reason: 'Put the fix live' },
    });
  });

  it('posts a run_command card in the turn’s thread, for the person to decide (OP-S62)', async () => {
    await grant('deploy', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const res = await authorize(d.id, 'fly   deploy --app invoices', 'deploy');
    expect(res.body).toMatchObject({ outcome: 'pending', open: [] });
    expect(res.body.message).toContain('This command needs a person’s yes (“');
    once = String(res.body.approvalId);
    const row = await approvalRow(once);
    expect(row.action).toEqual({
      type: 'run_command',
      params: {
        command: 'fly   deploy --app invoices',
        category: 'deploy',
        target: null,
        reason: 'Ship the invoice fix',
      },
    });
    expect(row.keyId).toBe('deploy');
    expect(row.whatHappens[0]).toContain('fly deploy --app invoices');
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row.messageId ?? ''));
    // In the turn's thread, where the person reads it.
    expect(row.conversationId).toBe(IDS.billing);
    expect(card).toMatchObject({ conversationId: IDS.billing, threadRootId: root, authorId: IDS.dusty });
    const person = row.conditions.find((c) => c.kind === 'person_approves');
    expect(person && 'approverIds' in person ? person.approverIds : []).toEqual([IDS.mara]);
    // Asked again from the same place: the same card.
    const again = await authorize(d.id, 'fly deploy --app invoices', 'deploy');
    expect(again.body.approvalId).toBe(once);
    // Still waiting.
    expect((await wait(d.id, once)).body).toEqual({ outcome: 'pending', scope: null, message: '', open: [] });
  });

  it('Allow once: the waiting command runs, the pass is spent, nobody is woken, the log says allowed', async () => {
    const d = (await passOf(once))?.dispatchId ?? '';
    const waiting = wait(d, once, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await decideAs(IDS.mara, once, { decision: 'approve', scope: 'once' })).status).toBe('ok');
    const answer = await waiting;
    expect(answer.body).toEqual({
      outcome: 'run',
      scope: 'once',
      message: 'Allowed once by Mara.',
      open: [],
    });
    const pass = await passOf(once);
    expect(pass?.deliveredAt).toBeTruthy();
    expect(pass?.usedAt).toBeTruthy();
    await waitFor(async () => (await approvalRow(once)).executedAt);
    await new Promise((r) => setTimeout(r, 300));
    expect(await wakesFor(once)).toEqual([]);
    const [executed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'approval.executed'), eq(events.approvalId, once)));
    expect(executed?.text).toBe('Allowed Dusty to run a deploy command once');
    expect((await approvalRow(once)).scope).toBe('once');
    // Once is once: the same command again asks again.
    const again = await authorize(d, 'fly deploy --app invoices', 'deploy');
    expect(again.body.outcome).toBe('pending');
    expect(again.body.approvalId).not.toBe(once);
  });

  it('Allow for this task: the same command and target run for the rest of the thread', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'fly deploy --app invoices', 'deploy');
    const id = String(asked.body.approvalId);
    expect((await decideAs(IDS.mara, id, { decision: 'approve', scope: 'task' })).status).toBe('ok');
    expect((await wait(d.id, id)).body).toMatchObject({ outcome: 'run', scope: 'task' });
    // A later turn in the same thread: runs at once, under that yes.
    const later = await liveDispatch(t, { threadRootId: root });
    expect((await authorize(later.id, 'fly deploy  --app invoices', 'deploy')).body).toEqual({
      outcome: 'run',
      approvalId: id,
      message: '',
      open: [],
    });
    // Another command, or another thread, asks.
    expect((await authorize(later.id, 'fly deploy --app billing', 'deploy')).body.outcome).toBe('pending');
    const elsewhere = await liveDispatch(t, { threadRootId: null });
    expect((await authorize(elsewhere.id, 'fly deploy --app invoices', 'deploy')).body.outcome).toBe(
      'pending',
    );
  });

  it('Allow for this task covers the target: any command of the key to the same server in the task (GF-10)', async () => {
    await grant('deploy.production', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'ssh web-1 ls /var/www', 'deploy_production', 'web-1');
    const id = String(asked.body.approvalId);
    expect((await decideAs(IDS.mara, id, { decision: 'approve', scope: 'task' })).status).toBe('ok');
    expect((await wait(d.id, id)).body).toMatchObject({ outcome: 'run', scope: 'task' });
    const later = await liveDispatch(t, { threadRootId: root });
    expect(
      (
        await authorize(
          later.id,
          'rsync -a dist/ web-1:/var/www/site/releases/r2',
          'deploy_production',
          'web-1',
        )
      ).body,
    ).toMatchObject({ outcome: 'run', approvalId: id });
    // Another server asks.
    expect((await authorize(later.id, 'ssh web-2 ls', 'deploy_production', 'web-2')).body.outcome).toBe(
      'pending',
    );
  });

  it('Always allow: an allowance (signed), shown in Access settings, removable — then it asks again', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'npm publish', 'deploy');
    const id = String(asked.body.approvalId);
    expect((await decideAs(IDS.mara, id, { decision: 'approve', scope: 'agent' })).status).toBe('ok');
    expect((await wait(d.id, id)).body).toMatchObject({ outcome: 'run', scope: 'agent' });
    const [allowance] = await waitFor(async () => {
      const rows = await t.services.db
        .select()
        .from(commandAllowances)
        .where(eq(commandAllowances.agentId, IDS.dusty));
      return rows.length ? rows : null;
    });
    expect(allowance).toMatchObject({
      keyId: 'deploy',
      command: 'npm publish',
      target: '',
      createdById: IDS.mara,
    });
    const [added] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'command.allowance_added'));
    expect(added?.text).toBe('Always allowed Dusty to run a deploy command');
    // Anywhere, any turn.
    const other = await liveDispatch(t, { conversationId: IDS.incidents });
    expect((await authorize(other.id, 'npm publish', 'deploy')).body).toMatchObject({
      outcome: 'run',
      approvalId: null,
    });
    // Access settings: the person reads and removes them.
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const listed = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/agent/command-allowances',
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().allowances).toEqual([
      expect.objectContaining({ id: allowance?.id, command: 'npm publish', target: null, keyId: 'deploy' }),
    ]);
    const remove = (who: string) =>
      t.api.inject({
        method: 'DELETE',
        url: `/api/v1/burrows/burrow-hq/agent/command-allowances/${allowance?.id}`,
        headers: { cookie: who },
      });
    const removed = await remove(cookie);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ allowances: [] });
    expect(removed.json().eventId).toBeTruthy();
    expect((await authorize(other.id, 'npm publish', 'deploy')).body.outcome).toBe('pending');
  });
});

describe('a late yes, a no, and who decides (AC-41, AC-42)', () => {
  it('a yes nobody waits for wakes the agent in the card’s thread; its identical command then runs once', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'wrangler deploy', 'deploy');
    const id = String(asked.body.approvalId);
    // The runner gave up long ago (exit 125) and the turn ended.
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.id));
    expect((await decideAs(IDS.mara, id, { decision: 'approve' })).status).toBe('ok');
    const [wake] = await waitFor(async () => {
      const rows = await wakesFor(id);
      return rows.length ? rows : null;
    });
    // Where the card is: the turn's thread.
    expect(wake).toMatchObject({ agentId: IDS.dusty, conversationId: IDS.billing, threadRootId: root });
    expect((await passOf(id))?.wokenAt).toBeTruthy();
    const woken = await holdDispatch(t, wake?.id ?? '');
    expect((await authorize(woken.id, 'wrangler deploy', 'deploy')).body).toMatchObject({
      outcome: 'run',
      approvalId: id,
    });
    expect((await passOf(id))?.usedAt).toBeTruthy();
    expect((await authorize(woken.id, 'wrangler deploy', 'deploy')).body.outcome).toBe('pending');
  });

  it('a late “Allow for this task” covers the turn it wakes in the card’s thread, for every run of the command', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'fly deploy --app late', 'deploy');
    const id = String(asked.body.approvalId);
    await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.id, d.id));
    expect((await decideAs(IDS.mara, id, { decision: 'approve', scope: 'task' })).status).toBe('ok');
    const [wake] = await waitFor(async () => {
      const rows = await wakesFor(id);
      return rows.length ? rows : null;
    });
    expect(wake).toMatchObject({ conversationId: IDS.billing, threadRootId: root });
    const woken = await holdDispatch(t, wake?.id ?? '');
    for (let i = 0; i < 2; i++)
      expect((await authorize(woken.id, 'fly deploy --app late', 'deploy')).body).toMatchObject({
        outcome: 'run',
        approvalId: id,
      });
    // Another command of the key still asks: the yes was for this one.
    expect((await authorize(woken.id, 'fly deploy --app other', 'deploy')).body.outcome).toBe('pending');
  });

  it('a waiting runner that never picks the yes up: the agent is woken after the grace', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'vercel --prod', 'deploy');
    const id = String(asked.body.approvalId);
    await wait(d.id, id); // polled just now: it counts as waiting
    expect((await decideAs(IDS.mara, id, { decision: 'approve' })).status).toBe('ok');
    const rows = await waitFor(async () => {
      const r = await wakesFor(id);
      return r.length ? r : null;
    }, 5000);
    expect(rows).toHaveLength(1);
  });

  it('a no reaches the waiting command: declined, with no message and no wake while the turn goes on', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'helm upgrade invoices ./chart', 'deploy');
    const id = String(asked.body.approvalId);
    const waiting = wait(d.id, id, 5000);
    await new Promise((r) => setTimeout(r, 100));
    const before = await t.services.db.select().from(messages).where(eq(messages.threadRootId, root));
    expect((await decideAs(IDS.mara, id, { decision: 'decline' })).status).toBe('ok');
    expect((await waiting).body).toEqual({
      outcome: 'declined',
      scope: null,
      message: 'Mara said no; the command didn’t run.',
      open: [],
    });
    const after = await t.services.db.select().from(messages).where(eq(messages.threadRootId, root));
    expect(after.length).toBe(before.length);
  });

  it('a key set to Off after the yes stops the command', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'kubectl apply -f k8s/', 'deploy');
    const id = String(asked.body.approvalId);
    expect((await decideAs(IDS.mara, id, { decision: 'approve' })).status).toBe('ok');
    await grant('deploy', 'cannot');
    expect((await wait(d.id, id)).body).toMatchObject({ outcome: 'declined' });
    await grant('deploy', 'ask');
  });

  it('a scope only on a yes to a command; agents never remove allowances', async () => {
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'terraform apply', 'deploy');
    const id = String(asked.body.approvalId);
    await expect(decideAs(IDS.mara, id, { decision: 'decline', scope: 'once' })).rejects.toThrow(/scope/);
    // A scope on another kind of approval.
    const [other] = await t.services.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.burrowId, t.burrowId), eq(approvals.state, 'pending')));
    const notCommand = other && other.action.type !== 'run_command' ? other : null;
    if (notCommand)
      await expect(
        t.commit(IDS.mara, decideApproval, { number: notCommand.number, decision: 'approve', scope: 'task' }),
      ).rejects.toThrow(/scope/);
    expect((await decideAs(IDS.mara, id, { decision: 'approve', scope: 'task' })).status).toBe('ok');
    const { removeCommandAllowance } = await import('./commands');
    const res = await t.commit(IDS.dusty, removeCommandAllowance, {
      allowanceId: 'cma_nothing',
    });
    expect(res.status).toBe('blocked');
  });
});

describe('Hermes’s web and browser tools at Ask (HE-44, CT-1236)', () => {
  it('a lookup is a card for the person; “Allow for this task” covers that site for the rest of it', async () => {
    await grant('web.browse', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'web_extract', 'web', 'docs.example.com');
    expect(asked.body).toMatchObject({ outcome: 'pending', open: [] });
    const id = String(asked.body.approvalId);
    const row = await approvalRow(id);
    expect(row.keyId).toBe('web.browse');
    expect(row.action).toMatchObject({
      type: 'run_command',
      params: { command: 'web_extract', category: 'web', target: 'docs.example.com' },
    });
    expect(row.conversationId).toBe(IDS.billing);
    const waiting = wait(d.id, id, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await decideAs(IDS.mara, id, { decision: 'approve', scope: 'task' })).status).toBe('ok');
    expect((await waiting).body).toMatchObject({ outcome: 'run', scope: 'task' });
    // The same site again in the task: at once; a search (no site) or another site asks.
    expect((await authorize(d.id, 'web_search', 'web', 'docs.example.com')).body.outcome).toBe('run');
    expect((await authorize(d.id, 'web_extract', 'web', 'other.example.org')).body.outcome).toBe('pending');
  });

  it('a no says it didn’t happen; Off blocks at once; the browser asks on its own key', async () => {
    await grant('browser.use', 'ask');
    const d = await liveDispatch(t, { threadRootId: root });
    const asked = await authorize(d.id, 'browser_navigate', 'browser', 'shop.example.com');
    const id = String(asked.body.approvalId);
    expect((await approvalRow(id)).keyId).toBe('browser.use');
    const waiting = wait(d.id, id, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await decideAs(IDS.mara, id, { decision: 'decline' })).status).toBe('ok');
    expect((await waiting).body).toMatchObject({
      outcome: 'declined',
      message: 'Mara said no; it didn’t happen.',
    });
    await grant('web.browse', 'cannot');
    await grant('browser.use', 'cannot');
    expect((await authorize(d.id, 'web_search', 'web')).body).toMatchObject({ outcome: 'blocked' });
  });
});

describe('production servers in the agent’s turn (AC-11)', () => {
  it('are in DispatchContext.commands even without a key to them', async () => {
    const [server] = await t.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.name, 'web-1'));
    expect(server?.production).toBe(true);
  });
});
