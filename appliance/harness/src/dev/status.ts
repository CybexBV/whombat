/** `dev/status [--json]` — what runs, health of each service, the dev appliance and where the logs are. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ports } from '../lib/paths.ts';
import { alive, httpGet } from '../lib/proc.ts';
import { consoleSummary, readConsoleState } from './console.ts';
import { envPath, loadEnv } from './env.ts';
import { containerState } from './postgres.ts';
import { unixJson } from './services.ts';
import { readTimestamp, timestampState } from './tuf-refresh.ts';

async function probe(url: string): Promise<string> {
  try {
    const r = await httpGet(url, 2000);
    return r.ok ? 'healthy' : `HTTP ${r.status}`;
  } catch (err) {
    return `unreachable (${(err as Error).message})`;
  }
}

export async function status(): Promise<Record<string, unknown>> {
  const state = loadEnv();
  if (!state) return { running: false, note: 'no environment (dev/up)' };
  const out: Record<string, unknown> = { mode: state.mode, services: {} as Record<string, unknown> };
  const services = out.services as Record<string, unknown>;
  services.postgres = await containerState();
  for (const [name, s] of Object.entries(state.services)) {
    if (name === 'postgres' || !s) continue;
    const up = alive(s.pid);
    let health: string = up ? 'running' : s.status;
    if (up && name === 'control' && state.control) health = await probe(`${state.control.url}/v1/health`);
    if (up && name === 'relay' && state.relay) health = await probe(`${state.relay.adminUrl}/readyz`);
    if (up && name === 'runtime' && state.appliance)
      health = await unixJson(state.appliance.adminSocket, 'GET', '/health')
        .then((h) => (h.status === 200 ? 'healthy (admin socket)' : `degraded (${h.status})`))
        .catch(() => 'admin socket unreachable')
        .then((h) => (state.runtime?.direct ? `${h} · direct ${state.runtime.direct} (loopback)` : h));
    if (up && name === 'web' && state.web) health = await probe(`http://127.0.0.1:${ports.web}/`);
    if (up && name === 'embed' && state.embed)
      health = `${await probe(`${state.embed.local}/embed/v1/widget.js`)} (${state.embed.url})`;
    // The refresher (IN-224) with the timestamp the repository serves now, running or not.
    if (name === 'tuf-refresh')
      health = `${up ? 'running' : 'not running'} · timestamp ${timestampState(readTimestamp(envPath('manager', 'tuf')), Date.now())}`;
    if (up && name === 'restic')
      health = (await httpGet(`http://127.0.0.1:${state.ports.restic}/`).catch(() => null))?.status
        ? 'healthy (append-only)'
        : 'unreachable';
    services[name] = { pid: s.pid, health, log: s.log, ...(s.note ? { note: s.note } : {}) };
  }
  // Control's panel listener (BL-27, IN-69): without a cookie the session answers 401 (403: loopback isn't allowed).
  if (state.panel && alive(state.services.control?.pid)) {
    const p = state.panel;
    const r = await httpGet(`${p.local}/v1/operator/session`, 2000).catch(() => null);
    const health = !r
      ? 'unreachable'
      : r.status === 401
        ? 'healthy'
        : r.status === 403
          ? 'healthy (loopback is outside the allowlist)'
          : `HTTP ${r.status}`;
    services.panel = {
      pid: state.services.control?.pid ?? null,
      health: `${health} (${p.url}; users ${p.users.join(', ') || 'none'}; admin app ${state.admin?.dist ? 'built' : 'none'}; billing ${state.billing?.provider ?? '-'})`,
      log: state.services.control?.log ?? '',
    };
  }
  if (state.appliance) {
    const a = state.appliance;
    let adminHealth: unknown = 'admin socket absent';
    if (existsSync(a.adminSocket)) {
      try {
        adminHealth = (await unixJson(a.adminSocket, 'GET', '/health')).body;
      } catch (err) {
        adminHealth = `error: ${String(err)}`;
      }
    }
    const mgrStatus = envPath('appliance', 'dev-manager.status.json');
    out.appliance = {
      deviceId: a.deviceId,
      peerId: a.peerId,
      fingerprint: a.fingerprint,
      console: consoleSummary(readConsoleState()),
      claimCard: join(envPath('appliance'), 'claim-card.txt'),
      runtimeAdminHealth: adminHealth,
      manager: existsSync(mgrStatus) ? JSON.parse(readFileSync(mgrStatus, 'utf8')) : null,
    };
  }
  out.sources = Object.fromEntries(
    Object.values(state.sources).map((s) => [
      s.id,
      `${s.mode} ${s.commit.slice(0, 12)}${s.dirty ? ' (dirty)' : ''}${s.lockfileDrift ? ' (lockfile drift)' : ''} ${s.path}`,
    ]),
  );
  return out;
}

if (import.meta.main) {
  const s = await status();
  if (process.argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
  else {
    console.log(`mode: ${s.mode ?? '-'}`);
    for (const [n, v] of Object.entries((s.services as Record<string, unknown>) ?? {}))
      console.log(
        `  ${n.padEnd(9)} ${typeof v === 'string' ? v : `${(v as { health: string }).health}${(v as { note?: string }).note ? ` — ${(v as { note?: string }).note}` : ''}`}`,
      );
    if (s.appliance) console.log(`appliance: ${JSON.stringify(s.appliance, null, 2)}`);
    if (s.sources)
      for (const [id, v] of Object.entries(s.sources as Record<string, string>)) console.log(`  ${id}: ${v}`);
    if (s.note) console.log(s.note);
  }
}
