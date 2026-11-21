/**
 * Probe appliances (IN-11): extra dev devices registered with the real control (same provisioning path as the dev
 * appliance) with a harness-side relay agent. They measure relay/control/secure-channel behaviour (encrypted echo
 * latency, reconnect storms) and exercise control-side claim rules on a device without a runtime. They are never
 * counted as the runtime in a product scenario.
 */
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceRegistrationResponse, signRegistration } from '@whombat/control-contracts/device';
import { acceptResponder, generateIdentity, type SecureConnection } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import type WebSocket from 'ws';
import { envPath } from '../dev/env.ts';
import { type ProvisionResult, provisionDevAppliance } from '../dev/provision.ts';
import { ports } from '../lib/paths.ts';
import { linkConfirm, linkOrgOf } from './cloud.ts';
import { type ApplianceAgent, applianceAgent, type DeviceKeys, deviceOp, loadDeviceKeys } from './device.ts';
import { env, type Persona } from './world.ts';

export async function probeDevice(name: string): Promise<{ prov: ProvisionResult; keys: DeviceKeys }> {
  const e = env();
  const dir = envPath('probes', name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prov = await provisionDevAppliance({
    dir,
    controlUrl: e.control?.url ?? '',
    provisioningToken: readFileSync(e.control?.provisioningTokenFile ?? '', 'utf8').trim(),
    claimUrlBase: `http://localhost:${ports.web}/claim`,
  });
  return { prov, keys: loadDeviceKeys(prov.identityDir) };
}

/**
 * A probe that is in an account's Whombat Link, as a box is (Whombat whombat-link.md LNK-03, LNK-13): it made its
 * identity itself, begins Link with its signed registration (`link.begin`, which is what registers it at control), and
 * `owner` confirms the code its screen would show. Control then gives it appliance tickets and its owner client
 * tickets, under the owner's Link org (`owner.org` from here on). The free month takes two boxes an account.
 */
export async function linkedProbe(
  name: string,
  owner: Persona,
): Promise<{ prov: ProvisionResult; keys: DeviceKeys }> {
  const e = env();
  const url = e.control?.url ?? '';
  const dir = envPath('probes', name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prov = await provisionDevAppliance({
    dir,
    controlUrl: url,
    provisioningToken: '',
    claimUrlBase: `http://localhost:${ports.web}/claim`,
    registrar: 'local',
  });
  const keys = loadDeviceKeys(prov.identityDir);
  const registration = JSON.parse(readFileSync(join(prov.identityDir, 'registration.json'), 'utf8'));
  const begun = (await deviceOp(url, keys, 'link.begin', { registration })) as {
    link: { state: string; pending?: { code: string } };
  };
  const code = begun.link.pending?.code;
  if (!code) throw new Error(`probe ${name}: link.begin gave no code (${JSON.stringify(begun.link)})`);
  const linked = await linkConfirm(url, owner.session.token, code);
  if (linked.device !== keys.deviceId || linked.state !== 'on')
    throw new Error(`probe ${name}: not linked (${JSON.stringify(linked)})`);
  const org = await linkOrgOf(url, owner.session.token);
  if (!org) throw new Error(`probe ${name}: ${owner.email} has no Whombat Link org after the confirm`);
  owner.org = org;
  return { prov, keys };
}

/** Completes a pending claim on control the way an appliance does (`claim.claimed`, device-signed). */
export async function reportClaimed(keys: DeviceKeys, claimId: string): Promise<void> {
  await deviceOp(env().control?.url ?? '', keys, 'claim.claimed', {
    claimId,
    claimedAt: Math.floor(Date.now() / 1000),
  });
}

export interface EchoProbe {
  agent: ApplianceAgent;
  connections: SecureConnection[];
  close(): void;
}

/** A Noise responder that echoes every message (content identity of the probe device), behind the real relay. */
export function echoProbe(keys: DeviceKeys): EchoProbe {
  const connections: SecureConnection[] = [];
  const agent = applianceAgent(env().control?.url ?? '', keys, (ws: WebSocket) => {
    const stream = nodeWebSocketByteStream(ws as unknown as Parameters<typeof nodeWebSocketByteStream>[0]);
    void (async () => {
      try {
        const conn = await acceptResponder({ stream, identity: keys.content });
        connections.push(conn);
        for (;;) {
          const m = await conn.receive();
          if (m === null) break;
          await conn.send(m);
        }
      } catch {
        // closed
      }
    })();
  });
  return {
    agent,
    connections,
    close() {
      agent.close();
      for (const c of connections) c.abort();
    },
  };
}

/**
 * A self-installed device (the ISO, CC-10): registered through `devices.selfRegister` (no credential; control must run
 * with `SELF_REGISTRATION=1`) with both key proofs and `model: "self-installed"`, so control records `origin: "self"`.
 * No claim verifier: only a code claim of a box nearby can claim it. Keys in `env/probes/<name>/`.
 */
export async function selfRegisteredProbe(name: string): Promise<DeviceKeys> {
  const e = env();
  const dir = envPath('probes', name, 'identity');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mgmt = generateKeyPairSync('ed25519');
  const mgmtPem = mgmt.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const der = createPrivateKey(mgmtPem).export({ format: 'der', type: 'pkcs8' });
  const mgmtSeed = Buffer.from(der.subarray(der.length - 32));
  const mgmtPub = Buffer.from(mgmt.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32);
  const content = await generateIdentity();
  const contentSeed = Buffer.from((content.privateKey as unknown as { raw: Uint8Array }).raw.subarray(0, 32));
  const registration = signRegistration(
    {
      env: 'local',
      hardwareSerial: `SELF-${randomBytes(6).toString('hex').toUpperCase()}`,
      model: 'self-installed',
      managementPublicKey: mgmtPub.toString('hex'),
      contentPeerId: content.peerId,
      contentPublicKey: Buffer.from(content.publicKey).toString('hex'),
      provisionedAt: Math.floor(Date.now() / 1000),
    },
    { managementSecretKeyHex: mgmtSeed.toString('hex'), contentSecretKeyHex: contentSeed.toString('hex') },
  );
  const res = await fetch(`${e.control?.url ?? ''}/v1/devices/self-register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registration),
  });
  const text = await res.text();
  if (res.status !== 201 && res.status !== 200)
    throw new Error(`control refused the self-registration: ${res.status} ${text}`);
  const reg = DeviceRegistrationResponse.parse(JSON.parse(text));
  writeFileSync(join(dir, 'management.key'), mgmtPem, { mode: 0o600 });
  return { deviceId: reg.device, seedHex: mgmtSeed.toString('hex'), content, peerId: content.peerId };
}
