/**
 * A device as control sees it (MA-03): device-signed ops with an appliance's management key, and relay
 * appliance connections (control connection + data connections, MA-05). Used for **probe appliances**: extra
 * dev devices the harness provisions and registers with the real control, so relay/control/secure-channel
 * behaviour can be measured end to end without the runtime (IN-11). Probes never stand in for the runtime in a
 * product scenario.
 */
import { createPrivateKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_OPS, type DeviceOp, signDeviceRequest } from '@whombat/control-contracts/device';
import { parseRelayDownstream, RELAY_SUBPROTOCOL } from '@whombat/protocol/relay';
import { deserializeIdentity, type Identity } from '@whombat/secure-channel';
import WebSocket from 'ws';
import { ControlError } from './cloud.ts';

export interface DeviceKeys {
  deviceId: string;
  seedHex: string;
  content: Identity;
  peerId: string;
}

export function loadDeviceKeys(identityDir: string): DeviceKeys {
  const record = JSON.parse(readFileSync(join(identityDir, 'device.json'), 'utf8')) as {
    deviceId: string;
    contentPeerId: string;
  };
  const der = createPrivateKey(readFileSync(join(identityDir, 'management.key'), 'utf8')).export({
    format: 'der',
    type: 'pkcs8',
  });
  return {
    deviceId: record.deviceId,
    seedHex: Buffer.from(der.subarray(der.length - 32)).toString('hex'),
    content: deserializeIdentity(new Uint8Array(readFileSync(join(identityDir, 'content.key')))),
    peerId: record.contentPeerId,
  };
}

export async function deviceOp<Op extends DeviceOp>(
  controlUrl: string,
  keys: DeviceKeys,
  op: Op,
  body: unknown,
): Promise<unknown> {
  const envelope = signDeviceRequest(
    {
      aud: 'whombat-api:local',
      device: keys.deviceId,
      op,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString('hex'),
      body: body as never,
    },
    keys.seedHex,
  );
  const res = await fetch(`${controlUrl}/v1/device/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const text = await res.text();
  if (!res.ok) {
    // Control's own code and reason, so a refusal says why (`registration_invalid`, `rate_limited`, …).
    let said: { code?: string; message?: string; details?: { code?: string; reason?: string } } = {};
    try {
      said = (JSON.parse(text) as { error?: typeof said }).error ?? {};
    } catch {
      // not JSON
    }
    throw new ControlError(
      res.status,
      said.code ?? 'device_op_failed',
      said.details?.reason ??
        said.details?.code ??
        res.headers.get('x-whombat-reason') ??
        said.message ??
        null,
      text,
      `device ${op}`,
    );
  }
  return DEVICE_OPS[op].response.parse(JSON.parse(text));
}

export interface ApplianceTicket {
  ticket: string;
  url: string;
  expiresAt: number;
}

export async function applianceTicket(controlUrl: string, keys: DeviceKeys): Promise<ApplianceTicket> {
  const t = (await deviceOp(controlUrl, keys, 'ticket.issue', { class: 'interactive' })) as {
    ticket: string;
    expiresAt: number;
    relay: { url: string };
  };
  return { ticket: t.ticket, url: t.relay.url, expiresAt: t.expiresAt };
}

/** Opens a relay connection and resolves after `welcome` (and `ready` for data connections). */
export function dial(
  url: string,
  hello: Record<string, unknown>,
  options: { waitReady: boolean },
): Promise<{ ws: WebSocket; welcome: { conn: string; maxMessage: number } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, RELAY_SUBPROTOCOL, { maxPayload: 262_144 });
    let welcome: { conn: string; maxMessage: number } | null = null;
    const fail = (e: Error) => {
      ws.removeAllListeners('message');
      reject(e);
    };
    ws.once('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, ...hello })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return fail(new Error('binary before ready'));
      const m = parseRelayDownstream(data.toString());
      if (!m.ok) return fail(new Error(`bad relay message ${m.error}`));
      if (m.value.t === 'welcome') {
        welcome = { conn: m.value.conn, maxMessage: m.value.maxMessage };
        if (!options.waitReady) {
          ws.removeAllListeners('message');
          resolve({ ws, welcome });
        }
        return;
      }
      if (m.value.t === 'ready' && welcome) {
        ws.removeAllListeners('message');
        resolve({ ws, welcome });
      }
    });
    ws.once('close', (code, reason) =>
      reject(Object.assign(new Error(`relay closed ${code} ${reason.toString()}`), { code })),
    );
    ws.once('error', (e) => reject(e));
  });
}

export interface ApplianceAgent {
  /** Sessions spliced so far. */
  sessions: number;
  close(): void;
  /** Waits until the control connection is registered with the relay. */
  ready: Promise<void>;
}

/**
 * The appliance side of relay protocol v1: a control connection; for each `incoming{session}` a data connection
 * with the same ticket and `session`, handed to `onSession` once `ready`.
 */
export function applianceAgent(
  controlUrl: string,
  keys: DeviceKeys,
  onSession: (ws: WebSocket, cls: 'interactive' | 'bulk') => void,
): ApplianceAgent {
  let closed = false;
  let control: WebSocket | null = null;
  let ticket: ApplianceTicket | null = null;
  const agent: ApplianceAgent = {
    sessions: 0,
    close() {
      closed = true;
      control?.close(1000);
    },
    ready: Promise.resolve(),
  };
  const fresh = async () => {
    if (!ticket || ticket.expiresAt * 1000 - Date.now() < 60_000)
      ticket = await applianceTicket(controlUrl, keys);
    return ticket;
  };
  agent.ready = (async () => {
    const t = await fresh();
    const { ws } = await dial(t.url, { ticket: t.ticket, class: 'interactive' }, { waitReady: false });
    control = ws;
    ws.on('message', async (data, isBinary) => {
      if (isBinary || closed) return;
      const m = parseRelayDownstream(data.toString());
      if (!m.ok || m.value.t !== 'incoming') return;
      const { session, class: cls } = m.value;
      // This stand-in box declares no door classes (`accepts`), so a web or acme stream is never its to take.
      if (cls !== 'interactive' && cls !== 'bulk') return;
      try {
        const tt = await fresh();
        const { ws: dataWs } = await dial(
          tt.url,
          { ticket: tt.ticket, class: cls, session },
          { waitReady: true },
        );
        agent.sessions++;
        onSession(dataWs, cls);
      } catch {
        // the client went away or the ticket expired
      }
    });
  })();
  return agent;
}
