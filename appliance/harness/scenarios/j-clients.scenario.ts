/**
 * (j) AI clients (SUB-09, contracts CT-72…CT-74, manager MG-33, IN-37) with the real whombat-manager and the dev TUF
 * repository: the channel publisher (`clientchannel`, the same code the latest tested job runs) signs bundles into
 * the delegated clients role; the manager installs, updates, rolls back, refuses a corrupted artifact and removes,
 * and pushes each change to the real runtime (`POST /clients`), which shows it in `clients.list`.
 *
 * The bundles are made-up executables (shell scripts): what is tested here is the install path; the real Claude Code
 * is what the latest tested job tests. Claude Code is the only client: ChatGPT runs on Hermes's own provider and the
 * channel no longer carries new Codex bundles (IN-432; the manager's package-layout install stays covered by its own
 * tests). Versions start at 90.x so they sort above anything real in the channel, and the scenario withdraws them at
 * the end.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envPath, loadEnv } from '../src/dev/env.ts';
import { unixJson } from '../src/dev/services.ts';
import { paths } from '../src/lib/paths.ts';
import { must, sleep } from '../src/lib/proc.ts';
import type { ApplianceSession } from '../src/scenario-kit/app-client.ts';
import { blocked, gap, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession } from '../src/scenario-kit/slice.ts';
import { tufDir } from '../src/scenario-kit/updates.ts';
import { api, CallFailed } from '../src/scenario-kit/work.ts';
import { env } from '../src/scenario-kit/world.ts';

type Provider = 'claude';
interface LocalClient {
  provider: Provider;
  state: string;
  installed: { version: string; executable: { path: string; sha256: string } } | null;
  latest: { version: string } | null;
  error: { code: string; message: string } | null;
}
interface Built {
  Bundle: {
    provider: Provider;
    version: string;
    artifact: { target: string; sha256: string };
    executable: { sha256: string };
  };
}

const run = Math.floor(Date.now() / 1000) % 1_000_000;
const v = (n: number) => `90.${run}.${n}`;
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const work = join(paths.bin, '..', 'clients-scenario', String(run));
const published: string[] = [];
let owner: ApplianceSession | null = null;
let why = '';

function managerBinDir(): string {
  const src = loadEnv()?.sources['appliance-manager'];
  return join(paths.bin, `appliance-manager@${src?.commit.slice(0, 12)}${src?.dirty ? '-dirty' : ''}`);
}
const clientchannel = () => join(managerBinDir(), 'clientchannel');

async function managerClients(): Promise<LocalClient[]> {
  const r = await unixJson(env().appliance?.managerSocket ?? '', 'GET', '/v1/clients');
  if (r.status !== 200) throw new Error(`GET /v1/clients: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { clients: LocalClient[] }).clients;
}

async function client(p: Provider): Promise<LocalClient> {
  const c = (await managerClients()).find((x) => x.provider === p);
  if (!c) throw new Error(`no ${p} in /v1/clients`);
  return c;
}

/** Waits (the manager refreshes TUF every 20 s in dev and checks the channel after each refresh). */
async function waitClient(p: Provider, ok: (c: LocalClient) => boolean, what: string): Promise<LocalClient> {
  const deadline = Date.now() + 150_000;
  let last: LocalClient | null = null;
  while (Date.now() < deadline) {
    last = await client(p);
    if (ok(last)) return last;
    await sleep(1000);
  }
  throw new Error(`${p}: ${what} not reached: ${JSON.stringify(last)}`);
}

const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A made-up client of version `ver` built into a bundle by the real publisher. */
async function bundle(p: Provider, ver: string): Promise<{ file: string; built: Built }> {
  const d = join(work, `${p}-${ver}`);
  mkdirSync(d, { recursive: true });
  const src = join(d, 'claude');
  writeFileSync(src, `#!/bin/sh\necho '${ver} (Claude Code)'\n`);
  chmodSync(src, 0o755);
  const fetched = join(d, 'fetched.json');
  writeFileSync(
    fetched,
    JSON.stringify({
      provider: p,
      version: ver,
      arch,
      publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
      url: `https://example.invalid/whombat-scenario/${p}/${ver}`,
      file: src,
      sha256: sha256(src),
      format: 'binary',
      pins: {},
    }),
  );
  const out = join(d, 'bundle.json');
  await must(
    clientchannel(),
    [
      'bundle',
      '--fetched',
      fetched,
      '--fixtures-digest',
      `sha256:${'0'.repeat(64)}`,
      '--adapter',
      '1',
      '--work',
      join(d, 'artifact'),
      '--out',
      out,
    ],
    { cwd: d },
  );
  return { file: out, built: JSON.parse(readFileSync(out, 'utf8')) as Built };
}

async function publish(add: string[], withdraw: string[] = []): Promise<void> {
  const args = ['publish', '--repo', tufDir(), '--keep', '64'];
  for (const b of add) args.push('--bundle', b);
  for (const w of withdraw) args.push('--withdraw', w);
  await must(clientchannel(), args, { cwd: work });
}

async function install(p: Provider): Promise<void> {
  // Through the runtime's own operation when it has it (owner + admin, CT-72), else the manager socket directly.
  if (owner) {
    try {
      await api(owner, 'clients.install', 'POST', { params: { provider: p } }, { expect: [200, 202] });
      return;
    } catch (e) {
      if (!(e instanceof CallFailed)) throw e;
    }
  }
  const r = await unixJson(env().appliance?.managerSocket ?? '', 'POST', '/v1/clients/install', {
    v: 1,
    provider: p,
  });
  if (r.status !== 202) throw new Error(`install ${p}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** The runtime's `ClientStatus` (CT-72): what the owner's UI sees, from the manager's pushes. */
interface ClientStatus {
  provider: Provider;
  state: string;
  installed: { version: string; source: string } | null;
}

async function runtimeView(p: Provider): Promise<ClientStatus | null> {
  if (!owner) return null;
  try {
    const r = await api<{ clients: ClientStatus[] }>(owner, 'clients.list', 'GET');
    return r.clients.find((c) => c.provider === p) ?? null;
  } catch {
    return null;
  }
}

/** Waits until the runtime shows what the manager pushed (pushes are asynchronous, at most one a second). null: the
 * runtime has no clients.list. */
async function runtimeSees(p: Provider, ok: (c: ClientStatus) => boolean): Promise<ClientStatus | null> {
  const deadline = Date.now() + 30_000;
  let c = await runtimeView(p);
  while (c && !ok(c) && Date.now() < deadline) {
    await sleep(500);
    c = await runtimeView(p);
  }
  return c;
}

beforeAll(async () => {
  const e = env();
  if (e.manager?.kind !== 'real') {
    why = 'dev/up ran the stand-in manager';
    return;
  }
  const cfg = envPath('manager', 'manager.json');
  if (!existsSync(cfg) || !(JSON.parse(readFileSync(cfg, 'utf8')) as { clients?: unknown }).clients) {
    why =
      'the manager has no clients configuration (a manager before MG-33, or no plain clients root: IN-37)';
    return;
  }
  if (!existsSync(clientchannel())) {
    why = 'the pinned appliance has no clientchannel publisher';
    return;
  }
  const facts = await unixJson(e.appliance?.adminSocket ?? '', 'GET', '/facts');
  if (!(facts.body as { clientAdapters?: unknown }).clientAdapters) {
    why = 'the runtime reports no clientAdapters (a runtime before contracts 0.9.0 installs nothing, CT-73)';
    return;
  }
  // The owner's session for clients.install/clients.list (CT-72); a runtime without them falls back to the socket.
  owner = (await ownerSession(await ensureSlice())).session;
}, 180_000);

afterAll(async () => {
  if (why) return;
  await unixJson(env().appliance?.managerSocket ?? '', 'POST', '/v1/clients/remove', {
    v: 1,
    provider: 'claude',
  });
  if (published.length) await publish([], published);
  owner?.close('closed');
}, 120_000);

describe('j AI clients from the signed client channel', () => {
  let claude1: Built;

  it('J1 install: the tested bundle is verified, unpacked read-only and pushed to the runtime', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/clients', why);
    const c1 = await bundle('claude', v(1));
    claude1 = c1.built;
    await publish([c1.file]);
    published.push(`claude/${v(1)}`);
    await waitClient('claude', (c) => c.latest?.version === v(1), 'the channel');
    await install('claude');
    const c = await waitClient(
      'claude',
      (x) => x.state === 'installed' && x.installed?.version === v(1),
      'installed',
    );
    const exe = c.installed?.executable.path ?? '';
    expect(exe.endsWith(`/claude/${v(1)}/claude`)).toBe(true);
    expect(sha256(exe)).toBe(claude1.Bundle.executable.sha256);
    expect(statSync(exe).mode & 0o777).toBe(0o555);
    const seen = await runtimeSees('claude', (c) => c.installed?.version === v(1));
    if (seen) {
      expect(seen.installed?.version).toBe(v(1));
      expect(seen.state).toBe('installed');
      note(ctx, 'the runtime lists the pushed install (clients.list)', { source: seen.installed?.source });
    } else
      gap(ctx, 'Whombat/runtime', 'clients.list is not available on this runtime; checked the manager only');
  }, 300_000);

  it('J2 update: a newer tested version installs next to the running one', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/clients', why);
    const c2 = await bundle('claude', v(2));
    await publish([c2.file]);
    published.push(`claude/${v(2)}`);
    const c = await waitClient(
      'claude',
      (x) => x.state === 'installed' && x.installed?.version === v(2),
      'the update',
    );
    expect(existsSync(join(c.installed?.executable.path ?? '', '..', '..', v(1), 'claude'))).toBe(true);
    const seen = await runtimeSees('claude', (x) => x.installed?.version === v(2));
    if (seen) expect(seen.installed?.version).toBe(v(2));
  }, 300_000);

  it('J3 rollback: a withdrawn version goes back to the previous one, which is still on disk', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/clients', why);
    await publish([], [`claude/${v(2)}`]);
    const c = await waitClient(
      'claude',
      (x) => x.state === 'installed' && x.installed?.version === v(1),
      'the rollback',
    );
    expect(sha256(c.installed?.executable.path ?? '')).toBe(claude1.Bundle.executable.sha256);
    const seen = await runtimeSees('claude', (x) => x.installed?.version === v(1));
    if (seen) expect(seen.installed?.version).toBe(v(1));
  }, 300_000);

  it('J4 digest mismatch: a corrupted artifact is refused and the installed version keeps running', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/clients', why);
    const c3 = await bundle('claude', v(3));
    await publish([c3.file]);
    published.push(`claude/${v(3)}`);
    const t = c3.built.Bundle.artifact;
    const dir = t.target.split('/').slice(0, -1).join('/');
    const base = t.target.split('/').at(-1);
    const f = join(tufDir(), 'targets', dir, `${t.sha256}.${base}`);
    const bytes = readFileSync(f);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
    writeFileSync(f, bytes);
    const c = await waitClient('claude', (x) => x.state === 'failed', 'the refusal');
    expect(c.error?.code).toBe('client.digest_mismatch');
    expect(c.installed?.version).toBe(v(1));
    expect(existsSync(join(c.installed?.executable.path ?? '', '..', '..', v(3)))).toBe(false);
    const seen = await runtimeSees('claude', (x) => x.state === 'failed');
    if (seen) expect([seen.state, seen.installed?.version]).toEqual(['failed', v(1)]);
  }, 300_000);

  it('J5 remove: every version goes, the runtime hears not_installed', async (ctx) => {
    if (why) blocked(ctx, 'whombat-appliance/clients', why);
    const before = await client('claude');
    const r = await unixJson(env().appliance?.managerSocket ?? '', 'POST', '/v1/clients/remove', {
      v: 1,
      provider: 'claude',
    });
    expect(r.status).toBe(200);
    expect((r.body as LocalClient).state).toBe('not_installed');
    expect(existsSync(join(before.installed?.executable.path ?? '', '..', '..'))).toBe(false);
    const seen = await runtimeSees('claude', (x) => x.state === 'not_installed');
    if (seen) expect(seen.state).toBe('not_installed');
  }, 120_000);
});
