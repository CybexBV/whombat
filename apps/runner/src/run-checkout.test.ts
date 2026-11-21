/**
 * A run turn whose checkout can't be made doesn't start the model (resourceful-agents.md RA-DS54): on John's box the
 * runner logged “could not check out …”, ran Dusty anyway in an empty folder (189 056 input tokens) and the run went on
 * failing. Now the turn is refused with what is missing and where a person fixes it, then Try again; the provider never
 * starts and the server gets a `workspace` failure with that refusal. Other turns with a checkout still go on without
 * one, as before (RC-09).
 */
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentProvider, BASIC_CAPABILITIES, type WhombatMcp } from '@whombat/agent-runtime';
import { type DispatchContext, TURN_FAILURE_REASON_MAX } from '@whombat/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type RunnerApi, RunnerApiError } from './api';
import { testContext } from './test-context';
import { testPolicy } from './test-sandbox';
import { runDispatch } from './turn';
import { prepareCwd, runCheckoutRefusal, TurnRefusal, thenTryAgain } from './workspace';

/** The server's words for an appliance where nobody connected GitHub (RA-DS50). */
const NOBODY =
  'Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it).';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-run-checkout-')));
});

const host = () => ({
  home: join(root, 'home'),
  whombatHome: join(root, 'whombat'),
  runnerTmp: join(root, 'runner-tmp'),
});

/** The git-credentials endpoint refusing as the server does (409, its message). */
const refusingApi = {
  gitCredentials: async () => {
    throw new RunnerApiError(409, { error: { code: 'conflict', message: NOBODY } }, NOBODY);
  },
} as unknown as RunnerApi;

const workspace: NonNullable<DispatchContext['workspace']> = {
  repo: 'acme/whombat-website',
  branch: 'feat/fb-nrzj-x1fz-house-rules-accents',
  baseBranch: 'main',
  defaultBranch: 'main',
  cloneUrl: 'https://github.com/acme/whombat-website.git',
  access: 'write',
  writeApproved: false,
};

/** Dusty's run turn on run #3 (RC-01's `run_control`), live on Codex. */
function runTurn(over: Partial<DispatchContext> = {}): DispatchContext {
  const base = testContext();
  return testContext({
    dispatch: { ...base.dispatch, trigger: 'run_control', mode: 'run', runId: 'run_3' },
    agent: { ...base.agent, runtime: { ...base.agent.runtime, provider: 'codex' } },
    run: { id: 'run_3', number: 3, repoId: 'repo_site' } as DispatchContext['run'],
    workspace,
    ...over,
  });
}

const options = (api: RunnerApi) => ({ root: join(root, 'workspaces'), api, checkout: true, host: host() });

describe('a run turn whose checkout can’t be made (RA-DS54)', () => {
  it('is refused with what is missing, where it is fixed, then Try again — one period, no scratch folder', async () => {
    const refused = await prepareCwd(runTurn(), options(refusingApi)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TurnRefusal);
    expect(refused).toMatchObject({
      code: 'checkout',
      // The run's number would make it longer than the failure card's sentence: the run card names the run.
      refusal:
        'I couldn’t check out acme/whombat-website. Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it), then choose Try again.',
    });
    expect((refused as TurnRefusal).refusal).not.toMatch(/\.\./);
    expect((refused as TurnRefusal).refusal.length).toBeLessThanOrEqual(TURN_FAILURE_REASON_MAX);
    // Nothing was prepared for a turn that doesn't run: no scratch folder, not even the runner's scratch space.
    expect(existsSync(join(root, 'runner-tmp'))).toBe(false);
  });

  it('without a checkout at all (its repository gone): refused too', async () => {
    const refused = await prepareCwd(runTurn({ workspace: null }), options(refusingApi)).catch(
      (e: unknown) => e,
    );
    expect(refused).toMatchObject({ code: 'checkout', refusal: expect.stringContaining('run #3') });
    expect((refused as { refusal: string }).refusal).toContain('still on GitHub, then choose Try again');
  });

  it('a turn that isn’t a run turn still goes on without its checkout, and says why (RC-09)', async () => {
    const base = testContext();
    const branchRoom = testContext({
      agent: { ...base.agent, runtime: { ...base.agent.runtime, provider: 'codex' } },
      workspace,
    });
    const prepared = await prepareCwd(branchRoom, options(refusingApi));
    try {
      expect(prepared.git).toBeNull();
      expect(prepared.problem).toBe(
        `could not check out acme/whombat-website@feat/fb-nrzj-x1fz-house-rules-accents: ${NOBODY}`,
      );
    } finally {
      await prepared.release();
    }
  });

  it('never starts the provider: the turn fails for good with the refusal, as a workspace failure', async () => {
    const completions: Record<string, unknown>[] = [];
    let started = false;
    const api = {
      ...refusingApi,
      progress: async () => ({ cancel: false, reason: null }),
      complete: async (_id: string, body: Record<string, unknown>) => {
        completions.push(body);
      },
    } as unknown as RunnerApi;
    const provider: AgentProvider = {
      kind: 'codex',
      available: async () => ({ ok: true, version: 'test' }),
      capabilities: () => BASIC_CAPABILITIES,
      // biome-ignore lint/correctness/useYield: it must never get this far
      async *runTurn() {
        started = true;
      },
    };
    const out = await runDispatch(
      runTurn(),
      {
        api,
        registry: { claims: () => ['codex'], for: () => provider, report: () => [] },
        serverUrl: 'http://whombat.test',
        workspacesRoot: join(root, 'workspaces'),
        host: host(),
        log: () => {},
        connectMcp: async () => ({}) as WhombatMcp,
        managed: testPolicy(),
      },
      new AbortController().signal,
    );
    expect(started).toBe(false);
    expect(out.outcome).toBe('failed');
    expect(completions).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        refusal: expect.stringMatching(/^I couldn’t check out acme\/whombat-website\. Nobody/),
        failure: { code: 'workspace' },
      }),
    ]);
    // No workspace report: the problem is the refusal itself, posted once (RA-DS55).
    expect(completions[0]).not.toHaveProperty('workspace');
  });
});

describe('thenTryAgain', () => {
  it('ends a reason with “then choose Try again” and never adds a second period', () => {
    expect(thenTryAgain('Connect it in Settings → Connections → GitHub.')).toBe(
      'Connect it in Settings → Connections → GitHub, then choose Try again.',
    );
    expect(thenTryAgain('fetch failed: connection refused')).toBe(
      'fetch failed: connection refused, then choose Try again.',
    );
    expect(thenTryAgain('Is it there?')).toBe('Is it there? Then choose Try again.');
    // With the run's number when it fits the failure card; a bare error after a colon.
    expect(runCheckoutRefusal(runTurn(), 'a/b', 'Gone.')).toBe(
      'I couldn’t check out a/b for run #3. Gone, then choose Try again.',
    );
    expect(runCheckoutRefusal(runTurn(), 'a/b', 'a/b is not connected to GitHub.')).toBe(
      'I couldn’t check out a/b for run #3: a/b is not connected to GitHub, then choose Try again.',
    );
  });
});
