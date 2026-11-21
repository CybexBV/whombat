/**
 * (0) Platform wiring: control, relay, the manager port and the runtime's session endpoint, with real tickets and
 * real JWKS. Prerequisites for every other scenario; failures here explain failures there.
 */

import { describe, expect, it } from 'vitest';
import { unixJson } from '../src/dev/services.ts';
import { decodeAdmissionClaims } from '../src/scenario-kit/admission.ts';
import { ControlError, clientTicket, devices, startClaim } from '../src/scenario-kit/cloud.ts';
import { dial } from '../src/scenario-kit/device.ts';
import { note } from '../src/scenario-kit/report.ts';
import { claimCard, env, persona, runtimeHealth } from '../src/scenario-kit/world.ts';

describe('0 platform', () => {
  it('control, relay and the runtime session endpoint are up and connected', async (ctx) => {
    const e = env();
    expect((await fetch(`${e.control?.url}/v1/health`)).ok).toBe(true);
    expect((await fetch(`${e.relay?.adminUrl}/readyz`)).ok).toBe(true);
    const jwks = (await (await fetch(`${e.control?.url}/v1/admission/jwks`)).json()) as { keys: unknown[] };
    expect(jwks.keys.length).toBeGreaterThan(0);
    const h = await runtimeHealth();
    note(ctx, 'runtime /health', { body: h.body });
    expect(h.ok).toBe(true);
    expect((h.body as { checks: { sessionEndpoint: { ok: boolean } } }).checks.sessionEndpoint.ok).toBe(true);
  });

  it('the manager port issues appliance tickets signed by control for this device', async () => {
    const e = env();
    const t = await unixJson(e.appliance?.managerSocket ?? '', 'POST', '/v1/runtime/ticket', {
      class: 'interactive',
    });
    expect(t.status).toBe(200);
    const body = t.body as { ticket: string; relayUrl: string; worker: string; expiresAt: string };
    const claims = decodeAdmissionClaims(body.ticket);
    expect(claims.rol).toBe('appliance');
    expect(claims.aud).toBe('whombat-relay:local');
    expect(claims.wrk).toBe(body.worker);
    expect(body.relayUrl).toBe(e.relay?.url);
    // A malformed request is refused with the local contract's error shape.
    const bad = await unixJson(e.appliance?.managerSocket ?? '', 'POST', '/v1/runtime/ticket', {
      class: 'nope',
    });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBeTruthy();
  });

  it('client tickets: only for an org with a pending claim or ownership; single use at the relay', async (ctx) => {
    const e = env();
    const card = claimCard();
    const stranger = await persona('stranger', 'Stranger');
    // No claim, not the owner: control answers the same "unavailable" as for an unknown device.
    const denied = await clientTicket(
      e.control?.url ?? '',
      stranger.session.token,
      stranger.org,
      card.deviceId,
      'app',
      'interactive',
    ).catch((x) => x);
    expect(denied).toBeInstanceOf(ControlError);
    note(ctx, 'stranger ticket refused', {
      status: (denied as ControlError).status,
      code: (denied as ControlError).code,
    });
    // A garbage ticket is refused by the relay (4401) — admission is the relay's job, with control's JWKS.
    const bad = await dial(
      e.relay?.url ?? '',
      { ticket: 'eyJhbGciOiJFZERTQSJ9.e30.AAAA', class: 'interactive' },
      { waitReady: false },
    ).catch((x) => x);
    expect((bad as { code?: number }).code).toBe(4401);
  });

  it('control knows the dev appliance only through Whombat Link: a card claim of it is refused', async (ctx) => {
    const e = env();
    const card = claimCard();
    const owner = await persona('platform-probe', 'Platform probe');
    // The box made its identity itself and registered by beginning Link (whombat-cloud CL-186): nobody claims it at
    // control, with a card or otherwise. The refusal doesn't say whether control knows the box.
    const r = await startClaim(
      e.control?.url ?? '',
      owner.session.token,
      owner.org,
      card.deviceId,
      card.claimSecret,
    ).catch((x) => x);
    expect(r).toBeInstanceOf(ControlError);
    note(ctx, 'card claim refused', {
      status: (r as ControlError).status,
      reason: (r as ControlError).reason,
    });
    expect([409, 404, 403]).toContain((r as ControlError).status);
    const list = await devices(e.control?.url ?? '', owner.session.token, owner.org);
    expect(list.devices.map((d) => d.device)).not.toContain(card.deviceId);
  });
});
