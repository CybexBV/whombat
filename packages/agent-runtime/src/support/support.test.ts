import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectAllDead, isAlive, readPids } from '../testing/pids';
import { AsyncQueue } from './async-queue';
import { providerEnv } from './env';
import { isRetryableMessage } from './errors';
import { killProcessTree, spawnGroup } from './process-group';

const FAMILY = fileURLToPath(new URL('../testing/family.mjs', import.meta.url));

describe.skipIf(process.platform === 'win32')('killProcessTree', () => {
  it('kills the leader, its group and descendants that escaped with setsid', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-pg-')), 'pids.json');
    const leader = spawnGroup(process.execPath, [FAMILY], {
      env: { ...process.env, FAMILY_PIDS_FILE: file },
    });
    const pids = await readPids(file);
    expect([pids.pid, pids.child, pids.escaped].every(isAlive)).toBe(true);
    await killProcessTree(leader, { graceMs: 1000 });
    await expectAllDead([pids.pid, pids.child, pids.escaped]);
  });

  it('escalates to SIGKILL when the family ignores SIGTERM', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-pg-')), 'pids.json');
    const leader = spawnGroup(process.execPath, [FAMILY, '--stubborn'], {
      env: { ...process.env, FAMILY_PIDS_FILE: file },
    });
    const pids = await readPids(file);
    const started = Date.now();
    await killProcessTree(leader, { graceMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await expectAllDead([pids.pid, pids.child, pids.escaped]);
  });
});

describe('AsyncQueue', () => {
  it('drains buffered bursts in order across compaction, refills and close', async () => {
    const q = new AsyncQueue<number>();
    const iterator = q[Symbol.asyncIterator]();
    for (let n = 0; n < 4096; n++) q.push(n);
    for (let n = 0; n < 3072; n++) expect(await iterator.next()).toEqual({ value: n, done: false });
    for (let n = 4096; n < 8192; n++) q.push(n);
    q.close();
    for (let n = 3072; n < 8192; n++) expect(await iterator.next()).toEqual({ value: n, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    q.push(8192);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('can queue undefined and refill after it drains', async () => {
    const q = new AsyncQueue<number | undefined>();
    const iterator = q[Symbol.asyncIterator]();
    q.push(undefined);
    q.push(1);
    expect(await iterator.next()).toEqual({ value: undefined, done: false });
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    q.push(2);
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    const waiting = iterator.next();
    q.push(3);
    expect(await waiting).toEqual({ value: 3, done: false });
    const closing = iterator.next();
    q.close();
    expect(await closing).toEqual({ value: undefined, done: true });
  });

  it('delivers buffered values before a failure and rejects pending consumers', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error('buffered failure'));
    const iterator = q[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    await expect(iterator.next()).rejects.toThrow('buffered failure');
    const waiting = new AsyncQueue<number>();
    const next = waiting[Symbol.asyncIterator]().next();
    waiting.fail(new Error('pending failure'));
    await expect(next).rejects.toThrow('pending failure');
  });

  it('rejects the consumer on fail', async () => {
    const q = new AsyncQueue<number>();
    setTimeout(() => q.fail(new Error('boom')), 5);
    await expect(
      (async () => {
        for await (const _ of q) {
          // drain
        }
      })(),
    ).rejects.toThrow('boom');
  });
});

describe('error classification', () => {
  it.each([
    ['429 Too Many Requests', true],
    ['Overloaded', true],
    ['socket hang up', true],
    ['Codex app-server exited unexpectedly (3)', true],
    ['something odd happened', true],
    ['401 Unauthorized', false],
    ['Invalid API key · Please run /login', false],
    ['Your credit balance is too low', false],
    ['prompt is too long: 250000 tokens', false],
    ['spawn codex ENOENT', false],
  ])('%s → retryable %s', (message, retryable) => {
    expect(isRetryableMessage(message)).toBe(retryable);
  });
});

describe('providerEnv', () => {
  /** A runner started from the repo's shared .env, on an operator's machine. */
  const runnerEnv = {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    USER: 'runner',
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    HTTPS_PROXY: 'http://proxy:3128',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/ca.pem',
    ANTHROPIC_API_KEY: 'sk-ant',
    RUNNER_TOKEN: 'runner-secret',
    WHOMBAT_RUNNER_TOKEN: 'runner-secret',
    WHOMBAT_MASTER_KEY: 'master',
    DATABASE_URL: 'postgres://',
    PGPASSWORD: 'pg',
    SMTP_URL: 'smtp://user:pass@mail',
    GITHUB_WEBHOOK_SECRET: 'whsec',
    GITHUB_CLIENT_SECRET: 'oauth',
    GITHUB_APP_PRIVATE_KEY: 'pem',
    GITHUB_TOKEN: 'ghp',
    GH_TOKEN: 'ghp',
    VAPID_PRIVATE_KEY: 'vapid',
    SSH_AUTH_SOCK: '/run/ssh-agent',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic x',
    GIT_ASKPASS: '/usr/bin/askpass',
    NODE_OPTIONS: '--require /tmp/x.js',
    AWS_SECRET_ACCESS_KEY: 'aws',
    STRIPE_SECRET_KEY: 'sk_live',
    MY_PROVIDER_KEY: 'mine',
  };
  const anthropic = (key: string) => key.startsWith('ANTHROPIC_');

  it('passes system variables and the provider’s login, and nothing else', () => {
    expect(providerEnv(runnerEnv, { login: anthropic })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      USER: 'runner',
      SHELL: '/bin/bash',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: '/tmp',
      HTTPS_PROXY: 'http://proxy:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/ca.pem',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
  });

  it('passes what the operator lists, but never the runner’s secrets', () => {
    const env = { ...runnerEnv, WHOMBAT_PROVIDER_ENV: 'MY_PROVIDER_KEY, RUNNER_TOKEN,GIT_CONFIG_VALUE_0' };
    const out = providerEnv(env);
    expect(out.MY_PROVIDER_KEY).toBe('mine');
    expect(out.RUNNER_TOKEN).toBeUndefined();
    expect(out.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(out.WHOMBAT_PROVIDER_ENV).toBeUndefined();
    expect(providerEnv(env, { pass: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] })).toMatchObject({
      STRIPE_SECRET_KEY: 'sk_live',
    });
    expect(providerEnv(env, { pass: ['DATABASE_URL'] }).DATABASE_URL).toBeUndefined();
  });
});
