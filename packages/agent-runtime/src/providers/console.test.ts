/**
 * The Claude sign-in console (CT-71, SUB-03) against a fake `claude` that behaves like Claude Code's
 * `auth login --claudeai` / `auth status` / `auth logout` in a real PTY. No real provider, no network, no credential
 * of this machine.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleSignInEvent } from '@whombat/core/contracts';
import { PROVIDER_CONSOLE_READ_MAX_BYTES } from '@whombat/core/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_CONFIG_SUBDIR,
  type ConsoleStartJob,
  claudeAuthStatus,
  ensureCredentialHome,
  homeLinkProblem,
  LocalSignInExecutor,
  type LocalSignInExecutorOptions,
  readCredentialMeta,
  writeCredentialMeta,
} from './index';

const FAKE_CLAUDE = fileURLToPath(new URL('./testing/fake-claude.mjs', import.meta.url));

/** What a runner started from a shared .env might carry: none of it may reach the console. */
const HOST_ENV = {
  PATH: process.env.PATH,
  HOME: '/home/operator',
  OPENAI_API_KEY: 'sk-operator',
  ANTHROPIC_API_KEY: 'sk-ant-operator',
  ANTHROPIC_AUTH_TOKEN: 'operator-token',
  ANTHROPIC_BASE_URL: 'https://proxy.invalid',
  CLAUDE_CODE_OAUTH_TOKEN: 'operator-oauth',
  CLAUDE_CONFIG_DIR: '/home/operator/.claude',
  CODEX_HOME: '/home/operator/.codex',
  GH_TOKEN: 'gho_operator',
  DATABASE_URL: 'postgres://x',
  WHOMBAT_MASTER_KEY: 'master',
  RUNNER_TOKEN: 'runner',
  LANG: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
};

/** Every variable the console's CLI may see (node-pty adds PWD). */
const ALLOWED_ENV = new Set(['PATH', 'LANG', 'LC_CTYPE', 'HOME', 'TERM', 'CLAUDE_CONFIG_DIR', 'PWD']);

const executors: LocalSignInExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((e) => e.close()));
});

function setup(options: Partial<LocalSignInExecutorOptions> = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'wb-console-'));
  const events: ConsoleSignInEvent[] = [];
  const executor = new LocalSignInExecutor({
    root,
    commands: { claude: FAKE_CLAUDE },
    hostEnv: HOST_ENV,
    onDeviceDone: () => {},
    onConsoleEvent: (e) => events.push(ConsoleSignInEvent.parse(e)),
    ...options,
  });
  executors.push(executor);
  const text = (consoleId: string) =>
    Buffer.concat(
      events
        .filter((e) => e.consoleId === consoleId && e.kind === 'output')
        .map((e) => Buffer.from((e as { data: string }).data, 'base64')),
    ).toString('utf8');
  const exitOf = (consoleId: string) =>
    events.find(
      (e): e is Extract<ConsoleSignInEvent, { kind: 'exit' }> =>
        e.consoleId === consoleId && e.kind === 'exit',
    );
  const until = async (what: () => unknown, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!what()) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const job = (consoleId: string, over: Partial<ConsoleStartJob> = {}): ConsoleStartJob => ({
    consoleId,
    provider: 'claude',
    authMode: 'subscription_cli',
    cols: 80,
    rows: 24,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...over,
  });
  // One home per provider, in the credentials root (OP-09); staging beside it.
  const ownerDir = root;
  const home = join(ownerDir, 'claude');
  const staged = () => readdirSync(ownerDir).filter((n) => n.startsWith('.staging-'));
  const calls = () =>
    readFileSync(join(ownerDir, '.fake-claude-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            argv: string[];
            envKeys: string[];
            HOME: string;
            CLAUDE_CONFIG_DIR: string | null;
            TERM: string | null;
            cwd: string;
            tty: boolean;
          },
      );
  /** Starts a console and waits for the CLI's prompt. */
  const started = async (consoleId: string, over: Partial<ConsoleStartJob> = {}) => {
    expect(await executor.consoleStart(job(consoleId, over))).toEqual({ ok: true });
    await until(() => text(consoleId).includes('Paste code here'));
  };
  return { root, executor, events, text, exitOf, until, job, home, ownerDir, staged, calls, started };
}

// Generous: a PTY and a Node CLI start slowly on a busy machine (the waits are `until`'s 10 s, not sleeps).
describe('Claude sign-in console (fake claude in a PTY)', { timeout: 30_000 }, () => {
  it('runs exactly `claude auth login --claudeai` with a clean environment and keeps a sign-in its status confirms', async () => {
    const s = setup();
    await s.started('pcn_console01');
    // Output: raw bytes in order, offsets from 0, base64 at the boundary.
    const outputs = s.events.filter((e) => e.kind === 'output');
    let next = 0;
    for (const e of outputs) {
      expect(e.offset).toBe(next);
      next += Buffer.from(e.data, 'base64').length;
    }
    expect(s.text('pcn_console01')).toContain('https://claude.ai/oauth/authorize');
    expect(s.text('pcn_console01')).toContain('Browser didn’t open?');

    expect(await s.executor.consoleResize('pcn_console01', 100, 30)).toEqual({ ok: true });
    // The CLI may read `size` before Node has handled the SIGWINCH, so ask again until the new size shows.
    for (let i = 0; i < 40 && !s.text('pcn_console01').includes('SIZE 100x30'); i++) {
      expect(await s.executor.consoleInput('pcn_console01', 'size\r')).toEqual({ ok: true });
      await s.until(() => s.text('pcn_console01').includes('SIZE 100x30'), 250).catch(() => {});
    }
    expect(s.text('pcn_console01')).toContain('SIZE 100x30');

    expect(await s.executor.consoleInput('pcn_console01', 'good\r')).toEqual({ ok: true });
    await s.until(() => s.exitOf('pcn_console01'));
    expect(s.exitOf('pcn_console01')).toEqual({
      kind: 'exit',
      consoleId: 'pcn_console01',
      exitCode: 0,
      state: 'completed',
      error: null,
    });
    // The exit is the console's last event.
    expect(s.events.at(-1)?.kind).toBe('exit');

    const meta = await readCredentialMeta(s.home);
    expect(meta).toMatchObject({
      provider: 'claude',
      authMode: 'subscription_cli',
      verified: 'valid',
      expiresAt: null,
      creatorAttested: false,
      login: null,
    });
    expect(existsSync(join(s.home, CLAUDE_CONFIG_SUBDIR, '.credentials.json'))).toBe(true);
    expect(s.staged()).toEqual([]);

    const [login, status] = s.calls();
    expect(login?.argv).toEqual(['auth', 'login', '--claudeai']);
    expect(login?.tty).toBe(true);
    expect(login?.TERM).toBe('xterm-256color');
    expect(login?.cwd).toBe(login?.HOME);
    expect(login?.HOME).toMatch(/\.staging-claude-/);
    expect(login?.CLAUDE_CONFIG_DIR).toBe(join(login?.HOME as string, 'config'));
    expect(status?.argv).toEqual(['auth', 'status']);
    expect(status?.CLAUDE_CONFIG_DIR).toBe(login?.CLAUDE_CONFIG_DIR);
    for (const call of s.calls()) {
      for (const key of call.envKeys) expect(ALLOWED_ENV.has(key), key).toBe(true);
      expect(call.HOME).not.toBe('/home/operator');
    }
  });

  it('splits output into pieces of at most 16 KiB with contiguous offsets', async () => {
    const s = setup();
    await s.started('pcn_console02');
    await s.executor.consoleInput('pcn_console02', 'big\r');
    await s.until(() => s.text('pcn_console02').includes('é'));
    const outputs = s.events.filter((e) => e.kind === 'output');
    let next = 0;
    for (const e of outputs) {
      const bytes = Buffer.from(e.data, 'base64');
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(PROVIDER_CONSOLE_READ_MAX_BYTES);
      expect(e.offset).toBe(next);
      next += bytes.length;
    }
    expect(next).toBeGreaterThan(40_000);
    expect(s.text('pcn_console02').split('x').length - 1).toBeGreaterThanOrEqual(39_998);
  });

  it('exit 0 without a sign-in fails with provider.login_missing and keeps nothing', async () => {
    const s = setup();
    await s.started('pcn_console03');
    await s.executor.consoleInput('pcn_console03', 'nosignin\r');
    await s.until(() => s.exitOf('pcn_console03'));
    expect(s.exitOf('pcn_console03')).toMatchObject({
      exitCode: 0,
      state: 'failed',
      error: { code: 'provider.login_missing' },
    });
    expect(existsSync(s.home)).toBe(false);
    expect(s.staged()).toEqual([]);
  });

  it('a non-zero exit fails with provider.login_failed', async () => {
    const s = setup();
    await s.started('pcn_console04');
    await s.executor.consoleInput('pcn_console04', 'wrong-code\r');
    await s.until(() => s.exitOf('pcn_console04'));
    expect(s.exitOf('pcn_console04')).toMatchObject({
      exitCode: 1,
      state: 'failed',
      error: { code: 'provider.login_failed' },
    });
    expect(s.text('pcn_console04')).toContain('Invalid code');
    expect(existsSync(s.home)).toBe(false);
    expect(s.staged()).toEqual([]);
    // Only the login ran: no status after a failed exit.
    expect(s.calls().map((c) => c.argv[1])).toEqual(['login']);
  });

  it('cancel stops the CLI, installs nothing and forgets the console', async () => {
    const s = setup();
    await s.started('pcn_console05');
    await s.executor.consoleStop('pcn_console05', 'cancelled');
    expect(s.exitOf('pcn_console05')).toMatchObject({
      state: 'cancelled',
      exitCode: null,
      error: { code: 'provider.login_cancelled' },
    });
    expect(s.events.filter((e) => e.kind === 'exit')).toHaveLength(1);
    expect(existsSync(s.home)).toBe(false);
    expect(s.staged()).toEqual([]);
    expect(await s.executor.consoleInput('pcn_console05', 'good\r')).toMatchObject({
      ok: false,
      code: 'provider.console_ended',
    });
  });

  it('stops itself at expiresAt (expired, provider.login_expired)', async () => {
    const s = setup();
    await s.started('pcn_console06', { expiresAt: new Date(Date.now() + 700).toISOString() });
    await s.until(() => s.exitOf('pcn_console06'));
    expect(s.exitOf('pcn_console06')).toMatchObject({
      state: 'expired',
      error: { code: 'provider.login_expired' },
    });
    expect(s.staged()).toEqual([]);
  });

  it('a second console for the same person cancels the first', async () => {
    const s = setup();
    await s.started('pcn_console07');
    await s.started('pcn_console08');
    expect(s.exitOf('pcn_console07')).toMatchObject({ state: 'cancelled' });
    expect(s.exitOf('pcn_console08')).toBeUndefined();
    await s.executor.consoleInput('pcn_console08', 'good\r');
    await s.until(() => s.exitOf('pcn_console08'));
    expect(s.exitOf('pcn_console08')).toMatchObject({ state: 'completed' });
    // Starting the same id again (a retried request) doesn't start a second CLI.
    expect(await s.executor.consoleStart(s.job('pcn_console08'))).toMatchObject({
      ok: false,
      code: 'provider.console_ended',
    });
    expect(s.calls().filter((c) => c.argv[1] === 'login')).toHaveLength(2);
  });

  it('an earlier sign-in survives a failed attempt and is replaced by a completed one', async () => {
    const s = setup();
    const home = await ensureCredentialHome(s.root, 'claude');
    await writeCredentialMeta(home, {
      v: 1,
      provider: 'claude',
      authMode: 'api_key',
      createdAt: '2026-09-25T10:00:00.000Z',
      expiresAt: null,
      verified: 'valid',
      verifiedAt: '2026-09-25T10:00:00.000Z',
      creatorAttested: false,
      login: null,
      signal: null,
    });
    await s.started('pcn_console09');
    await s.executor.consoleInput('pcn_console09', 'nope\r');
    await s.until(() => s.exitOf('pcn_console09'));
    expect((await readCredentialMeta(home))?.authMode).toBe('api_key');

    await s.started('pcn_console10');
    await s.executor.consoleInput('pcn_console10', 'good\r');
    await s.until(() => s.exitOf('pcn_console10'));
    expect((await readCredentialMeta(home))?.authMode).toBe('subscription_cli');
    expect(s.staged()).toEqual([]);
  });

  it('logout removes the home and never runs the CLI on it: a planted link’s target stays intact (review CON-2)', async () => {
    const s = setup();
    await s.started('pcn_console11');
    await s.executor.consoleInput('pcn_console11', 'good\r');
    await s.until(() => s.exitOf('pcn_console11'));
    // What a turn with write access to config/ could plant (the reviewer's repro-claude-json-symlink.sh).
    const victim = join(s.root, 'victim.sh');
    writeFileSync(victim, '#!/bin/sh\necho original\n');
    symlinkSync(victim, join(s.home, CLAUDE_CONFIG_SUBDIR, '.claude.json'));
    const before = s.calls().length;
    expect(await s.executor.logout('claude')).toEqual({ removed: true, authMode: 'subscription_cli' });
    expect(existsSync(s.home)).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('#!/bin/sh\necho original\n');
    expect(s.calls().slice(before)).toEqual([]);
  });

  it('won’t ask a CLI about a home with a link or a hard link in it (review CON-2)', async () => {
    const s = setup();
    const home = await ensureCredentialHome(s.root, 'claude');
    mkdirSync(join(home, CLAUDE_CONFIG_SUBDIR));
    const other = join(s.root, 'other.json');
    writeFileSync(other, '{}');
    symlinkSync(other, join(home, CLAUDE_CONFIG_SUBDIR, '.credentials.json'));
    expect(await homeLinkProblem(home)).toMatch(/is a link/);
    expect(await claudeAuthStatus(FAKE_CLAUDE, home, { hostEnv: HOST_ENV })).toEqual({
      loggedIn: false,
      ran: true,
    });
    rmSync(join(home, CLAUDE_CONFIG_SUBDIR, '.credentials.json'));
    linkSync(other, join(home, CLAUDE_CONFIG_SUBDIR, '.credentials.json'));
    expect(await homeLinkProblem(home)).toMatch(/hard link/);
    expect(await claudeAuthStatus(FAKE_CLAUDE, home, { hostEnv: HOST_ENV })).toEqual({
      loggedIn: false,
      ran: true,
    });
    // The CLI was never started on it.
    expect(existsSync(join(s.ownerDir, '.fake-claude-calls.jsonl'))).toBe(false);
    rmSync(join(home, CLAUDE_CONFIG_SUBDIR, '.credentials.json'));
    writeFileSync(join(home, CLAUDE_CONFIG_SUBDIR, '.credentials.json'), '{}');
    expect(await homeLinkProblem(home)).toBeNull();
    expect(await claudeAuthStatus(FAKE_CLAUDE, home, { hostEnv: HOST_ENV })).toEqual({
      loggedIn: true,
      ran: true,
    });
  });

  it('sweeps staging homes a crash left behind at start, and the provider’s on logout (review CON-5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-console-'));
    // A console killed after `claude auth login` wrote its credential, before it was moved into place.
    const left = join(root, '.staging-claude-0123456789ab', CLAUDE_CONFIG_SUBDIR);
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, '.credentials.json'), '{"claudeAiOauth":{}}');
    mkdirSync(join(root, 'codex'), { recursive: true });
    const s = setup({ root });
    await s.executor.ready();
    expect(readdirSync(root)).toEqual(['codex']);

    // Left behind while the executor runs (a staging home no console owns any more): logout removes it too.
    mkdirSync(join(root, '.staging-claude-ba9876543210'), { recursive: true });
    mkdirSync(join(root, '.staging-codex-ba9876543210'), { recursive: true });
    await s.executor.logout('claude');
    expect(readdirSync(root).sort()).toEqual(['.staging-codex-ba9876543210', 'codex']);
  });

  it('answers unknown consoles and a missing client', async () => {
    const s = setup();
    expect(await s.executor.consoleInput('pcn_missing1', 'x')).toMatchObject({
      ok: false,
      code: 'provider.console_not_found',
    });
    expect(await s.executor.consoleResize('pcn_missing1', 80, 24)).toMatchObject({
      ok: false,
      code: 'provider.console_not_found',
    });
    await expect(s.executor.consoleStop('pcn_missing1', 'cancelled')).resolves.toBeUndefined();

    for (const resolveClient of [() => null, () => '/nonexistent/claude']) {
      const t = setup({ commands: {}, resolveClient });
      expect(await t.executor.consoleStart(t.job('pcn_console12'))).toMatchObject({
        ok: false,
        code: 'client.not_installed',
      });
      expect(t.events).toEqual([]);
    }
    const u = setup({ commands: {}, resolveClient: (p) => (p === 'claude' ? FAKE_CLAUDE : null) });
    await u.started('pcn_console13');
  });
});
