/**
 * Remote help between the box and control (0.120, CT-944…CT-949; Whombat remote-help.md RH-05, RH-06, RH-09, RH-11):
 * the status report's `support`, the device op `support.ticket`, and the operator's `supportOpen` and `supportTicket`.
 * The terms' new version is in `control.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS } from './common.js';
import { DEVICE_API_PATH, DEVICE_OPS, TicketResponse } from './device/ops.js';
import { SupportReport } from './device/status.js';
import { controlApi } from './index.js';
import {
  OPERATOR_PERMISSIONS,
  SshEd25519Certificate,
  SupportOpenBody,
  SupportOpenResponse,
  SupportPublicKey,
} from './operator.js';

const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINW5nEYpnLC/ggxoMZMtKIrMTB3zH3cpPnngDIgx6CrR';
const userKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHp4Lg42TaIUop4TXTEsJmlpT40pTvZzI55oBMIh+T5X';
const certificate =
  'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIH8P9wtxbs1FMsLvu4lz1w9dpCA6HoJDO31';
const ticket = {
  ticket: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ',
  expiresAt: 1_790_000_120,
  relay: {
    worker: 'relay-eu-1',
    url: 'wss://relay.dev.whombat.com/v1/connect',
    reassignAfter: 1_790_003_600,
  },
  channel: 'app',
};

describe('the status report (CT-944)', () => {
  it('says off, the level, time left, how many are connected, the code’s need and the host key', () => {
    const on = { state: 'fix', untilS: 3_600, connected: 2, helpCode: true, hostKey };
    expect(SupportReport.parse(on)).toEqual(on);
    expect(
      SupportReport.safeParse({ state: 'off', untilS: null, connected: 0, helpCode: false, hostKey: null })
        .success,
    ).toBe(true);
    // Metadata only: no names, no code (strict, like the whole report).
    expect(SupportReport.safeParse({ ...on, who: 'Claude' }).success).toBe(false);
    expect(DEVICE_OPS['status.report'].body.shape.support.safeParse(undefined).success).toBe(true);
  });
});

describe('the support route’s ticket (CT-945)', () => {
  it('is a device op with an empty body and the ticket answer', () => {
    const op = DEVICE_OPS['support.ticket'];
    expect(op.body.safeParse({}).success).toBe(true);
    expect(op.body.safeParse({ class: 'bulk' }).success).toBe(false);
    expect(op.response).toBe(TicketResponse);
    expect(DEVICE_API_PATH('support.ticket')).toBe('/device/support.ticket');
  });
});

describe('the operator’s remote help (CT-946, CT-947)', () => {
  it('needs the support permission and lives under the device', () => {
    expect(OPERATOR_PERMISSIONS).toContain('support');
    expect(controlApi.operator.supportOpen).toMatchObject({
      method: 'POST',
      path: '/operator/devices/:device/support',
      auth: 'operator',
    });
    expect(controlApi.operator.supportTicket).toMatchObject({
      method: 'POST',
      path: '/operator/devices/:device/support/ticket',
      auth: 'operator',
    });
    expect(controlApi.operator.supportTicket.response).toBe(TicketResponse);
    for (const code of ['device_not_found', 'remote_help_off', 'support_unavailable'])
      expect(CONTROL_REASONS, code).toHaveProperty(code);
  });

  it('certifies an Ed25519 key for a name the owner reads', () => {
    expect(SupportOpenBody.safeParse({ publicKey: userKey, name: 'Claude' }).success).toBe(true);
    expect(SupportOpenBody.safeParse({ publicKey: `${userKey} john@thetitan`, name: 'Claude' }).success).toBe(
      true,
    );
    for (const bad of [
      { publicKey: `ssh-rsa AAAAB3NzaC1yc2E${'A'.repeat(60)}`, name: 'Claude' },
      { publicKey: userKey, name: '' },
      { publicKey: userKey, name: 'x'.repeat(41) },
      { publicKey: userKey, name: 'Claude\nop_1' },
      { publicKey: userKey, name: 'Claude', level: 'fix' },
    ])
      expect(SupportOpenBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(SupportPublicKey.safeParse(`${userKey} ${'x'.repeat(101)}`).success).toBe(false);
  });

  it('answers the certificate, the pinned host key, the grant as reported and a client ticket', () => {
    const answer = {
      certificate,
      validBefore: '2026-10-21T18:00:00Z',
      principal: 'wb-7tq3-k2pd-m418',
      hostKey,
      level: 'look',
      untilS: null,
      helpCodeRequired: false,
      ticket,
    };
    expect(SupportOpenResponse.parse(answer)).toEqual(answer);
    expect(SupportOpenResponse.safeParse({ ...answer, hostKey: null }).success).toBe(false);
    expect(SshEd25519Certificate.safeParse(userKey).success).toBe(false);
    expect(SshEd25519Certificate.safeParse(`${certificate} comment`).success).toBe(false);
  });
});
