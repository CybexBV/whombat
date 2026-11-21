/**
 * The running local environment as the scenarios see it: `env.json`, the dev appliance's claim card, personas
 * signed in to control, and ticket sources for the real client.
 */
import { readFileSync } from 'node:fs';
import type { CloudSession } from '@whombat/control-contracts';
import { type EnvState, loadEnv } from '../dev/env.ts';
import { setEntitlement } from '../dev/licence.ts';
import type { ClaimCard } from '../dev/provision.ts';
import { unixJson } from '../dev/services.ts';
import { contractsAtLeast } from '../manifest/version.ts';
import type { Ticket } from './app-client.ts';
import { ControlError, clientTicket, ensureOrg, linkOrgOf, signIn } from './cloud.ts';

export function env(): EnvState {
  const e = loadEnv();
  if (!e?.control || !e.relay || !e.appliance) throw new Error('the local environment is not up (dev/up)');
  return e;
}

export function claimCard(e = env()): ClaimCard {
  return JSON.parse(readFileSync(e.appliance?.claimCardFile ?? '', 'utf8')) as ClaimCard;
}

export interface Persona {
  email: string;
  name: string;
  session: CloudSession;
  /**
   * The org the person's tickets are asked under: the account's Whombat Link org once it confirmed a box into its
   * Link (the hidden billing record that holds its boxes), until then the org made for it here.
   */
  org: string;
  via: 'magic-link' | 'cache';
}

/**
 * Signs a persona in (magic link through Mailpit unless cached) and makes sure it owns an org. A persona that linked
 * a box gets its Link org (`Persona.org`).
 */
export async function persona(
  key: string,
  name: string,
  options: { fresh?: boolean } = {},
): Promise<Persona> {
  const e = env();
  // Private scenario appliances share Mailpit. Namespace deterministic personas so they never take each other's links.
  const suffix = process.env.WB_MGD_PERSONA_SUFFIX ?? '';
  const email = `${key.endsWith(suffix) ? key : key + suffix}@harness.whombat.local`;
  const r = await signIn(e.control?.url ?? '', email, options);
  // From contracts 0.15.0 a new org starts a manual trial (the plan's limits, one Whombat, trial marks, BL-13, BL-17). The
  // personas' orgs keep the world the scenarios were written for: active, 1000 Whombats, no limits, self-install
  // (control's local defaults before 0.15.0). Scenario p-billing makes its own orgs to see the trial.
  const org = await ensureOrg(e.control?.url ?? '', r.session, `${name} org`, async (o) => {
    if (contractsAtLeast('0.15.0'))
      await setEntitlement(e, o, {
        state: 'active',
        devicesAllowed: 1000,
        currentPeriodEnd: null,
        limits: { connectors: null },
        selfInstall: true,
      });
  });
  const link = await linkOrgOf(e.control?.url ?? '', r.session.token);
  return { email, name, session: r.session, org: link ?? org, via: r.via };
}

/** A client ticket source bound to a persona, org and device (routing only; the appliance authenticates). */
export function ticketSource(p: Persona, device: string, relayUrlOverride?: string) {
  const e = env();
  return async (r: { channel: 'app' | 'enroll'; class: 'interactive' | 'bulk' }): Promise<Ticket> => {
    const t = await clientTicket(e.control?.url ?? '', p.session.token, p.org, device, r.channel, r.class);
    return { ticket: t.ticket, relayUrl: relayUrlOverride ?? t.relay.url };
  };
}

/** Is the runtime's session endpoint connected to the relay (admin socket `/health`)? */
/**
 * The stack's runtime's direct socket (Whombat HE-50, IN-419): `ws://127.0.0.1:<port>/v1/direct`, or null in an
 * environment from before the direct listener.
 */
export function directSocketUrl(e = env()): string | null {
  return e.runtime?.direct ? `ws://${e.runtime.direct}/v1/direct` : null;
}

export async function runtimeHealth(e = env()): Promise<{ ok: boolean; body: unknown }> {
  try {
    const h = await unixJson(e.appliance?.adminSocket ?? '', 'GET', '/health');
    return { ok: h.status === 200, body: h.body };
  } catch (err) {
    return { ok: false, body: String(err) };
  }
}

export function managerStatus(e = env()) {
  return unixJson(e.appliance?.managerSocket ?? '', 'GET', '/v1/dev/status');
}

export { ControlError };
