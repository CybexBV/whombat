/**
 * The sign-in executor's usage probe (docs/decisions/ui-improvements.md UI-R05…UI-R07): exactly the person's home —
 * for ChatGPT, Hermes's login in their profile (HN-03) — API keys never probed, never on a home with a link, one probe
 * per subscription at a time, and a managed runner's sandbox when it gives one.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeClaude as fakeLauncher } from '../claude/testing/fake-claude.mjs';
import { ensureCredentialHome, writeCredentialMeta } from './credential-home';
import { LocalSignInExecutor } from './signin-executor';

/** The fake CLI, executable like an installed client (the executor checks that before running it). */
const fakeClaude = (scenario: Parameters<typeof fakeLauncher>[0]) => {
  const path = fakeLauncher(scenario);
  chmodSync(path, 0o755);
  return path;
};

const FAKE_CHATGPT = fileURLToPath(new URL('./testing/fake-chatgpt-steps.mjs', import.meta.url));

const GET_USAGE = {
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 42, resets_at: '2100-01-01T00:00:00Z' } },
};

async function setup(authMode: string, provider: 'claude' | 'codex' = 'claude') {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-usage-root-'));
  const home = await ensureCredentialHome(root, provider);
  await writeCredentialMeta(home, {
    v: 1,
    provider,
    authMode,
    createdAt: '2026-09-29T00:00:00.000Z',
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login: null,
    signal: null,
  });
  // A ChatGPT login is Hermes's own, in the person's profile (HN-03; the Hermes root, OP-08): a stand-in there.
  const profile = join(root, 'hermes');
  if (provider === 'codex') {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'auth.json'), '{}');
  }
  const record = join(root, 'record.jsonl');
  return { root, home, record, profile };
}

const executor = (
  root: string,
  claude: string,
  extra: Partial<ConstructorParameters<typeof LocalSignInExecutor>[0]> = {},
) =>
  new LocalSignInExecutor({
    root,
    commands: { claude },
    onDeviceDone: () => {},
    now: () => new Date('2026-09-29T19:00:00.000Z'),
    ...extra,
  });

const recorded = (record: string) =>
  readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('the usage probe of a sign-in', () => {
  it('reads a subscription with exactly that person’s config dir', async () => {
    const { root, home, record } = await setup('subscription_cli');
    const ex = executor(root, fakeClaude({ record, usage: GET_USAGE }));
    const result = await ex.usageProbe('claude');
    expect(result).toMatchObject({
      ok: true,
      usage: {
        provider: 'claude',
        kind: 'subscription',
        plan: 'pro',
        windows: [{ kind: 'five_hour', usedPct: 42 }],
      },
    });
    const start = recorded(record).find((l) => l.kind === 'start');
    expect(start.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'config'));
  });

  it('a provider without a sign-in: not signed in, nothing run', async () => {
    const { root, record } = await setup('subscription_cli');
    const ex = executor(root, fakeClaude({ record, usage: GET_USAGE }));
    expect(await ex.usageProbe('codex')).toMatchObject({
      ok: false,
      code: 'provider.not_signed_in',
    });
    expect(() => readFileSync(record)).toThrow();
  });

  it('an API key is pay as you go: no CLI runs', async () => {
    const { root, record } = await setup('api_key');
    const ex = executor(root, fakeClaude({ record, usage: GET_USAGE }));
    expect(await ex.usageProbe('claude')).toEqual({
      ok: true,
      usage: {
        provider: 'claude',
        kind: 'api_key',
        plan: null,
        windows: [],
        observedAt: '2026-09-29T19:00:00.000Z',
        error: null,
      },
    });
    expect(() => readFileSync(record)).toThrow();
  });

  it('never runs the CLI on a home with a link in it (SUB-41)', async () => {
    const { root, home, record } = await setup('subscription_cli');
    mkdirSync(join(home, 'config'), { recursive: true });
    symlinkSync('/etc/passwd', join(home, 'config', '.claude.json'));
    const ex = executor(root, fakeClaude({ record, usage: GET_USAGE }));
    expect(await ex.usageProbe('claude')).toMatchObject({
      ok: false,
      code: 'provider.home_unsafe',
    });
    expect(() => readFileSync(record)).toThrow();
  });

  it('ChatGPT: Hermes reads the usage on the person’s own login in their profile, never through a link', async () => {
    const { root, profile } = await setup('chatgpt', 'codex');
    const chatgpt = (extra: Partial<ConstructorParameters<typeof LocalSignInExecutor>[0]> = {}) =>
      new LocalSignInExecutor({
        root,
        hermes: { root: join(root, 'hermes') },
        commands: { chatgpt: [process.execPath, FAKE_CHATGPT] },
        onDeviceDone: () => {},
        now: () => new Date('2026-10-25T10:00:00.000Z'),
        ...extra,
      });
    expect(await chatgpt().usageProbe('codex')).toMatchObject({
      ok: true,
      usage: {
        provider: 'codex',
        kind: 'subscription',
        plan: 'plus',
        windows: [{ kind: 'five_hour', usedPct: 12 }],
      },
    });
    // A managed runner opens its sandbox on the profile, with Hermes's install readable.
    const jobs: { home: string; installs?: readonly string[] }[] = [];
    const cwd = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-usage-host-'));
    const sandboxed = chatgpt({
      usageHost: async (job) => {
        jobs.push(job);
        return { cwd, close: async () => {} };
      },
    });
    expect((await sandboxed.usageProbe('codex')).ok).toBe(true);
    expect(jobs[0]?.home).toBe(profile);
    expect(jobs[0]?.installs?.length).toBeGreaterThan(0);
    // Hermes's lock file planted as a link: no step runs on the host.
    symlinkSync('/etc/passwd', join(profile, 'auth.lock'));
    expect(await chatgpt().usageProbe('codex')).toMatchObject({
      ok: false,
      code: 'provider.home_unsafe',
    });
  });

  it('one probe per subscription at a time', async () => {
    const { root, record } = await setup('subscription_cli');
    const ex = executor(root, fakeClaude({ record, usage: GET_USAGE }));
    const [a, b] = await Promise.all([ex.usageProbe('claude'), ex.usageProbe('claude')]);
    expect(a).toEqual(b);
    expect(recorded(record).filter((l) => l.kind === 'get_usage')).toHaveLength(1);
  });

  it('a managed runner’s host: the probe starts through its spawner, in its directory, and it is closed', async () => {
    const { root, home, record } = await setup('subscription_cli');
    const cwd = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-usage-host-'));
    const calls: string[] = [];
    let closed = false;
    const ex = executor(root, fakeClaude({ record, usage: GET_USAGE }), {
      usageHost: async (job) => {
        calls.push(`${job.provider}/${job.authMode}/${job.home === home}`);
        return {
          cwd,
          spawn: (command, args, options) => {
            calls.push('spawn');
            return spawn(command, [...args], { ...options, stdio: 'pipe' });
          },
          close: async () => {
            closed = true;
          },
        };
      },
    });
    const result = await ex.usageProbe('claude');
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['claude/subscription_cli/true', 'spawn']);
    expect(closed).toBe(true);
    expect(recorded(record).find((l) => l.kind === 'start').cwd).toBe(cwd);
  });
});
