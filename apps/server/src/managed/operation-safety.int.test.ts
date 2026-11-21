/**
 * The runtime's side of `OPERATION_SAFETY` (contracts CT-194, CT-195; docs/decisions/command-safety.md CS-08). Every
 * effect outside the database runs through `externalEffect`, which reports it with the session op whose command ran
 * it; every int test file checks what it drives (`test/effects-setup.ts`). This suite drives the ops that act — a merge
 * on GitHub, an origin on disk, the runner's sign-in steps, a Google revocation — plus
 * ordinary ones, and holds the contract to what it saw: an op observed acting (not idempotently) before its commit is
 * `never` or destructive, so no client resends it by itself; and the effects are still observed, so removing a
 * wrapper fails here instead of silently.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CredentialProvider, LocalSignInExecutor } from '@whombat/agent-runtime/providers';
import { googleScopesFor } from '@whombat/core';
import { operationSafety } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPr } from '../commands/agent-tools';
import { recordChecks, reviewPr } from '../commands/prs';
import { type ObservedEffect, observeExternalEffects } from '../commit/scope';
import { fakeAccessTokenFor } from '../connectors/oauth';
import { storeGoogleConnection } from '../connectors/store';
import { connections } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { fakeOf } from '../test/github';
import { useManagedRuntime } from '../test/managed';
import { type RequestAnswer, RequestControl } from './dispatcher';
import { providerLogins } from './providers/service';
import type { SessionPrincipal } from './trust';

const credentials = mkdtempSync(join(tmpdir(), 'wb-op-safety-cred-'));
const workspaces = mkdtempSync(join(tmpdir(), 'wb-op-safety-ws-'));
const FAKES = fileURLToPath(
  new URL('../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: credentials, WHOMBAT_WORKSPACES: workspaces },
});
const REPO = 'whombat/billing';

let mara: SessionPrincipal;
let maraAccount = '';
const seen: ObservedEffect[] = [];
let stopObserving = () => {};
let stopRunner = async () => {};

/** The runner's side of the sign-in bridge: the real executor with the fake CLIs, answering what the server asks. */
function startRunner(): () => Promise<void> {
  const bridge = providerLogins(m.t.services).bridge;
  if (!bridge) throw new Error('this runtime signs in through the runner');
  const executor = new LocalSignInExecutor({
    root: credentials,
    commands: {
      claude: join(FAKES, 'fake-claude.mjs'),
      gh: join(FAKES, 'fake-gh.mjs'),
    },
    fetch: async () => ({ status: 200 }) as Response,
    onDeviceDone: () => {},
  });
  const handle = (method: string, p: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'submitSecret':
        return executor.submitSecret(p as never);
      case 'logout':
        return executor.logout(p.provider as CredentialProvider);
      case 'list':
        return executor.list();
      case 'cancel':
        return executor.cancel(String(p.loginId)).then(() => null);
      default:
        return Promise.reject(new Error(`the test runner doesn't do ${method}`));
    }
  };
  let running = true;
  const loop = (async () => {
    while (running)
      for (const req of await bridge.poll(100))
        void handle(req.method, req.params as Record<string, unknown>).then(
          (result) => bridge.answer(req.id, { ok: true, result }),
          (err) => bridge.answer(req.id, { ok: false, error: String(err) }),
        );
  })();
  return async () => {
    running = false;
    await loop;
  };
}

beforeAll(async () => {
  const id = await m.enroll(IDS.mara);
  maraAccount = id.accountId;
  mara = await m.runtime.trust.identify(id.peerId, id.publicKey);
  stopObserving = observeExternalEffects((effect) => seen.push(effect));
  stopRunner = startRunner();
});

afterAll(async () => {
  stopObserving();
  await stopRunner();
});

async function run(op: string, input: unknown): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    mara,
    { id: `req_${randomUUID().replaceAll('-', '').slice(0, 20)}`, op, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

/** A PR whose checks passed and that a person approved. */
async function mergeablePr(branch: string): Promise<number> {
  const sha = randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  await fakeOf(m.t).simulatePush({ repo: REPO, branch, commits: [{ sha, message: branch }] });
  const opened = await m.t.commit(IDS.dusty, openPr, { repo: REPO, branch, title: branch, body: '' });
  if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
  const number = opened.result.number;
  const passed = { name: 'unit', state: 'passed' as const, note: '', durationMs: 1, tests: null, url: null };
  await m.t.commit(IDS.dusty, recordChecks, { prNumber: number, repo: REPO, checks: [passed] });
  await m.t.commit(IDS.dusty, reviewPr, {
    prNumber: number,
    repo: REPO,
    decision: 'approve',
    body: '',
    comments: [],
  });
  return number;
}

describe('OPERATION_SAFETY against what the runtime does (CS-08)', () => {
  it('drives the ops that act outside the database, and ordinary ones', async () => {
    const ok = { type: 'result' };
    // GitHub: a merge, inside its transaction.
    const number = await mergeablePr('feat/op-safety');
    expect(
      await run('prs.merge', {
        params: { burrow: 'burrow-hq', number },
        body: { repo: REPO, method: 'squash' },
      }),
    ).toMatchObject(ok);
    // Git on disk: a repository's origin, before its record.
    expect(
      await run('repos.create', {
        params: { burrow: 'burrow-hq' },
        body: { name: 'OpSafety', description: '' },
      }),
    ).toMatchObject(ok);
    // The runner: a key stored, then signed out again (a person's and an organization's).
    const started = await run('signins.loginStart', { body: { provider: 'codex', authMode: 'api_key' } });
    const loginId = (started as { output: { loginId: string } }).output.loginId;
    expect(
      await run('signins.loginSubmit', {
        params: { loginId },
        body: { secret: 'sk-test-op-safety-00000001' },
      }),
    ).toMatchObject(ok);
    expect(await run('signins.logout', { params: { provider: 'codex' } })).toMatchObject(ok);
    // Google: a disconnect revokes the grant before its record goes.
    await storeGoogleConnection(m.t.services, {
      accountId: maraAccount,
      requested: ['mail'],
      tokens: {
        accessToken: fakeAccessTokenFor('op-safety-refresh'),
        refreshToken: 'op-safety-refresh',
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: googleScopesFor(['mail']),
      },
      user: { sub: 'sub-op-safety', email: 'mara.op@gmail.com', name: 'Mara' },
    });
    const [connection] = await m.t.services.db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.accountId, maraAccount));
    expect(await run('connections.remove', { params: { connectionId: connection?.id ?? '' } })).toMatchObject(
      ok,
    );
    // Ordinary commands: nothing outside the database before the commit.
    expect(
      await run('messages.send', {
        params: { burrow: 'burrow-hq', conversationId: IDS.general },
        body: { text: 'op safety' },
      }),
    ).toMatchObject(ok);
    expect(
      await run('burrows.update', { params: { burrow: 'burrow-hq' }, body: { description: 'Op safety' } }),
    ).toMatchObject(ok);
  });

  it('every op seen acting before its commit is `never` or destructive in the contract', () => {
    const acting = seen.filter((e) => e.op !== null && e.beforeCommit && !e.idempotent);
    expect(acting.length).toBeGreaterThan(0);
    for (const e of acting) {
      const safety = operationSafety(e.op as string);
      expect(safety, `${e.op} is missing from OPERATION_SAFETY`).toBeDefined();
      expect(
        safety?.retry === 'never' || safety?.destructive === true,
        `${e.op} runs ${e.label} before its commit, but OPERATION_SAFETY lets a client resend it (${JSON.stringify(safety)})`,
      ).toBe(true);
    }
  });

  it('the effects are still observed where they happen (a wrapper removed fails here)', () => {
    const acted = new Set(
      seen.filter((e) => e.beforeCommit && !e.idempotent).map((e) => `${e.op} ${e.label}`),
    );
    for (const expected of [
      'repos.create git.origin',
      'signins.loginSubmit runner.submitSecret',
      'signins.logout runner.logout',
      'connections.remove google.revoke',
    ])
      expect(acted, expected).toContain(expected);
    expect(seen.filter((e) => e.op === 'prs.merge' && e.label === 'github.merge')).toEqual([
      expect.objectContaining({ beforeCommit: false, idempotent: false }),
    ]);
    // Ordinary commands act only after their commit, if at all.
    for (const op of ['messages.send', 'burrows.update'])
      expect(seen.filter((e) => e.op === op && e.beforeCommit && !e.idempotent)).toEqual([]);
  });
});
