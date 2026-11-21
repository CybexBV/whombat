/**
 * `dev/licence` — the dev appliance's licence (LC-01…LC-10, IN-40): show what the box holds, change the org's
 * entitlement through control's operator API, ask for a renewal now, and set the development timings, so a lapse and a
 * restore can be shown on the dev instance without waiting (the maintainers' dev-instance runbook, “The licence”).
 *
 *   dev/licence [show] [--json]      the pinned key set, the manager's token and high-water mark, the runtime's state
 *   dev/licence set <state> [--plan p] [--devices n] [--connectors n|none]
 *                   [--self-install yes|no] [--org <org>]
 *                                    PUT /v1/operator/orgs/:org/entitlement (state: trialing | active | past_due |
 *                                    grace | cancelled; the org of the claimed dev box by default); then renew
 *   dev/licence renew                POST /v1/licence/renew on the manager socket (what “Check again” does)
 *   dev/licence timing [--ttl s] [--renew-after s] [--grace s] [--clock-offset s] [--clear]
 *                                    development overrides (control CL-41, runtime MR-60), then restarts control and
 *                                    the runtime to apply them
 *
 * `show` asks the runtime for its state with the same `POST /licence {token: null, highWater}` the manager sends with
 * every facts re-send (it changes nothing but the runtime's clock mark, which the runtime raises hourly anyway).
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  type LicenceClaims,
  LicenceKeySet,
  licenceStatus,
  verifyLicenceToken,
} from '@whombat/protocol/licence';
import { acquireEnvLock, releaseEnvLock } from '../lib/lock.ts';
import { controlApi } from '../scenario-kit/cloud.ts';
import { type EnvState, envPath, type LicenceOverrides, loadEnv, saveEnv } from './env.ts';
import { restartService } from './restart.ts';
import { unixJson } from './services.ts';

export const ENTITLEMENT_STATES = ['trialing', 'active', 'past_due', 'grace', 'cancelled'] as const;

/** Where the dev appliance's manager keeps `{v, token, highWater}` (the real one's `licence.stateFile`, or the stand-in's). */
export function managerLicenceFile(state: EnvState): string {
  return state.manager?.kind === 'real'
    ? envPath('manager', 'state', 'licence.json')
    : envPath('appliance', 'dev-manager.licence.json');
}

export interface HeldLicence {
  file: string;
  token: string | null;
  highWater: string | null;
  claims: LicenceClaims | null;
  verifies: string;
}

/** The manager's stored licence, verified against the pinned key set. */
export function heldLicence(state: EnvState): HeldLicence | null {
  const file = managerLicenceFile(state);
  if (!existsSync(file)) return null;
  const f = JSON.parse(readFileSync(file, 'utf8')) as { token: string | null; highWater?: string };
  const h: HeldLicence = {
    file,
    token: f.token,
    highWater: f.highWater ?? null,
    claims: null,
    verifies: 'no token',
  };
  if (f.token && state.licence && state.appliance) {
    const keySet = LicenceKeySet.parse(JSON.parse(readFileSync(state.licence.keysFile, 'utf8')));
    const hw = f.highWater ? Math.floor(Date.parse(f.highWater) / 1000) : 0;
    const v = verifyLicenceToken(f.token, {
      keySet,
      device: state.appliance.deviceId,
      now: Math.max(Math.floor(Date.now() / 1000), hw),
    });
    h.verifies = v.ok ? 'verifies against the pinned key set' : `does NOT verify: ${v.error}`;
    if (v.ok) h.claims = v.claims;
  }
  return h;
}

/** The runtime's view (`LocalLicenceStatus`), by the manager's own re-send; null when it can't be asked. */
export async function runtimeLicence(state: EnvState, highWater: string | null): Promise<unknown> {
  if (!state.appliance || !highWater || !existsSync(state.appliance.adminSocket)) return null;
  const r = await unixJson(state.appliance.adminSocket, 'POST', '/licence', { v: 1, token: null, highWater });
  if (r.status === 404) return 'the runtime has no POST /licence (before contracts 0.10.0)';
  return r.status === 200 ? (r.body as { licence: unknown }).licence : { status: r.status, body: r.body };
}

function operatorToken(state: EnvState): string {
  if (!state.control) throw new Error('no control in this environment');
  return readFileSync(state.control.operatorTokenFile, 'utf8').trim();
}

/** The org that claimed the dev appliance (control's directory). */
export async function applianceOrg(state: EnvState): Promise<string> {
  if (!state.control || !state.appliance) throw new Error('no dev appliance in this environment');
  const d = await controlApi<{ org: string | null; state?: string }>(
    state.control.adminUrl,
    'GET',
    `/v1/operator/devices/${state.appliance.deviceId}`,
    { token: operatorToken(state) },
  );
  if (!d.org)
    throw new Error(`the dev appliance ${state.appliance.deviceId} is not claimed yet: claim it first`);
  return d.org;
}

export interface EntitlementChange {
  state: (typeof ENTITLEMENT_STATES)[number];
  plan?: string;
  devicesAllowed?: number;
  /** Epoch seconds; for a manual trial its end (BL-13). */
  currentPeriodEnd?: number | null;
  /**
   * No agent count since contracts 0.123.0 (a Whombat has its one agent, Whombat one-agent.md OA-02) and no member
   * count since 3.0.0 (one person per Whombat, Whombat one-person.md OP-11): a licence limits devices and connectors.
   */
  limits?: { connectors?: number | null };
  selfInstall?: boolean;
}

/** `PUT /v1/operator/orgs/:org/entitlement` (CT-78: absent fields keep the org's current values). */
export function setEntitlement(state: EnvState, org: string, change: EntitlementChange): Promise<unknown> {
  if (!state.control) throw new Error('no control in this environment');
  return controlApi(state.control.adminUrl, 'PUT', `/v1/operator/orgs/${org}/entitlement`, {
    token: operatorToken(state),
    body: change,
  });
}

/** `POST /v1/licence/renew` on the dev appliance's manager socket (LC-08). */
export async function renewNow(state: EnvState): Promise<{ status: number; body: unknown }> {
  if (!state.appliance) throw new Error('no dev appliance in this environment');
  return unixJson(state.appliance.managerSocket, 'POST', '/v1/licence/renew', { v: 1 });
}

const iso = (s: number | null | undefined) =>
  s ? new Date(s * 1000).toISOString().replace('.000Z', 'Z') : '—';

async function show(state: EnvState, json: boolean): Promise<void> {
  const held = heldLicence(state);
  const runtime = await runtimeLicence(state, held?.highWater ?? null);
  const now = Math.floor(Date.now() / 1000);
  const managerView =
    held?.claims && held.highWater
      ? licenceStatus({
          claims: held.claims,
          now,
          highWater: Math.floor(Date.parse(held.highWater) / 1000),
          clockMark: 0,
          claimedAt: null,
        })
      : null;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ keySet: state.licence ?? null, manager: held, managerView, runtime }, null, 2)}\n`,
    );
    return;
  }
  const out: string[] = [];
  if (!state.licence)
    out.push('key set: none (control has no licence keyring, or the environment predates IN-39)');
  else
    out.push(
      `key set: ${state.licence.env} ${state.licence.kids.join(', ')} → ${state.licence.keysFile}`,
      ...(state.licence.overrides && Object.keys(state.licence.overrides).length
        ? [`overrides: ${JSON.stringify(state.licence.overrides)}`]
        : []),
    );
  if (!held)
    out.push(`manager: no licence yet (${managerLicenceFile(state)} missing: not claimed, or never renewed)`);
  else {
    const c = held.claims;
    out.push(
      `manager: ${held.file}`,
      `  token: ${held.verifies}`,
      ...(c
        ? [
            `  org ${c.org}, plan ${c.plan}, entitlement ${c.state}`,
            `  limits: devices ${c.limits.devices}, connectors ${c.limits.connectors ?? '∞'}`,
            `  issued ${iso(c.iat)}, expires ${iso(c.exp)}`,
          ]
        : []),
      `  highWater ${held.highWater ?? '—'}`,
      ...(managerView ? [`  by this clock: ${managerView.state} (${managerView.reason})`] : []),
    );
  }
  out.push(`runtime: ${typeof runtime === 'string' ? runtime : JSON.stringify(runtime)}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const limit = (v: string | undefined) =>
  v === undefined ? undefined : v === 'none' || v === 'null' || v === 'unlimited' ? null : Number(v);

/** Sets or clears development overrides and restarts what they apply to. */
export async function setOverrides(o: LicenceOverrides | null, log: (l: string) => void): Promise<void> {
  const state = loadEnv();
  if (!state?.licence)
    throw new Error('no licence in this environment (dev/up with a control that has CL-39)');
  const before = state.licence.overrides ?? {};
  state.licence.overrides = o ? { ...before, ...o } : {};
  saveEnv(state);
  const after = state.licence.overrides;
  const changed = (k: keyof LicenceOverrides) => before[k] !== after[k];
  if (changed('ttlS') || changed('renewAfterS')) await restartService('control', log);
  if (changed('graceS') || changed('clockOffsetS')) await restartService('runtime', log);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show';
  const state = loadEnv();
  if (!state) throw new Error('no environment: dev/up first');
  const log = (l: string) => process.stderr.write(`${l}\n`);
  switch (cmd) {
    case 'show':
      await show(state, argv.includes('--json'));
      break;
    case 'set': {
      const s = argv[1] as EntitlementChange['state'];
      if (!ENTITLEMENT_STATES.includes(s))
        throw new Error(`state must be one of ${ENTITLEMENT_STATES.join(', ')}`);
      const org = arg(argv, '--org') ?? (await applianceOrg(state));
      const limits = {
        ...(arg(argv, '--connectors') !== undefined ? { connectors: limit(arg(argv, '--connectors')) } : {}),
      };
      const si = arg(argv, '--self-install');
      const view = await setEntitlement(state, org, {
        state: s,
        ...(arg(argv, '--plan') ? { plan: arg(argv, '--plan') } : {}),
        ...(arg(argv, '--devices') ? { devicesAllowed: Number(arg(argv, '--devices')) } : {}),
        ...(Object.keys(limits).length ? { limits } : {}),
        ...(si !== undefined ? { selfInstall: si === 'yes' || si === 'true' } : {}),
      });
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      log(
        'The box learns it at its next renewal: dev/licence renew (or “Check again” in Settings → This Whombat).',
      );
      break;
    }
    case 'renew': {
      const r = await renewNow(state);
      process.stdout.write(`${JSON.stringify(r.body)}\n`);
      if (r.status === 200) await show(state, false);
      else process.exitCode = 1;
      break;
    }
    case 'timing': {
      acquireEnvLock('dev/licence timing');
      try {
        const num = (k: string) => (arg(argv, k) !== undefined ? Number(arg(argv, k)) : undefined);
        const o: LicenceOverrides = {};
        const set = <K extends keyof LicenceOverrides>(k: K, v: number | undefined) => {
          if (v !== undefined) o[k] = v;
        };
        set('ttlS', num('--ttl'));
        set('renewAfterS', num('--renew-after'));
        set('graceS', num('--grace'));
        set('clockOffsetS', num('--clock-offset'));
        await setOverrides(argv.includes('--clear') ? null : o, log);
      } finally {
        releaseEnvLock();
      }
      await show(loadEnv() ?? state, false);
      break;
    }
    default:
      throw new Error(`unknown command ${cmd} (show | set | renew | timing)`);
  }
}
