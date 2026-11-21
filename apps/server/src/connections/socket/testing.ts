/**
 * Tests only: in-process WebSocket servers playing a TrueNAS (JSON-RPC 2.0 at `/api/current`, 25.04 and later) and
 * ESPHome's Device Builder (`/ws`, its `docs/API.md` protocol), over http or https (the self-signed home-network
 * certificate), and a destination policy that puts them behind a home-network address. Every message a client sent is
 * kept for the assertions.
 */
import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { OutboundError, type OutboundPolicy } from '../../lib/outbound';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../../test/self-signed';

/** The SHA-256 fingerprint of the fakes' https certificate, as a person pastes it. */
export const FAKE_CERT_SHA256 = new X509Certificate(SELF_SIGNED_CERT_A).fingerprint256;

export interface FakeSocketServer {
  url: string;
  port: number;
  /** Every JSON message the clients sent, in order. */
  received: Record<string, unknown>[];
  /** Sockets opened so far (one per call: no pool). */
  connections: number;
  /** Sockets open now. */
  open(): number;
  close(): Promise<void>;
}

type Reply = (client: WebSocket, message: Record<string, unknown>) => void;

async function serve(
  path: string,
  options: { tls?: boolean; missing?: boolean; status?: number },
  onOpen: (client: WebSocket) => void,
  onMessage: Reply,
): Promise<FakeSocketServer> {
  const handler: http.RequestListener = (_req, res) => {
    // An older service: the path is a web page or nothing at all.
    res.writeHead(options.status ?? 404, { 'content-type': 'text/html' });
    res.end('<html></html>');
  };
  const server = options.tls
    ? https.createServer({ cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A }, handler)
    : http.createServer(handler);
  const received: Record<string, unknown>[] = [];
  let connections = 0;
  const wss = options.missing ? null : new WebSocketServer({ server, path });
  wss?.on('connection', (client) => {
    connections++;
    client.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      received.push(message);
      onMessage(client, message);
    });
    onOpen(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    received,
    get connections() {
      return connections;
    },
    open: () => wss?.clients.size ?? 0,
    close: async () => {
      for (const client of wss?.clients ?? []) client.terminate();
      wss?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const send = (client: WebSocket, message: unknown) => client.send(JSON.stringify(message));

/* TrueNAS ----------------------------------------------------------------------------------------------------------- */

export interface FakeTrueNasOptions {
  apiKey: string;
  tls?: boolean;
  /** `system.info`'s version. */
  version?: string;
  /** An older TrueNAS: no socket at `/api/current`. */
  missing?: boolean;
  /** Extra methods: an answer, or `{ error }` for a JSON-RPC error. */
  methods?: Record<string, (params: unknown) => unknown>;
}

/** What a method answers as a JSON-RPC error. */
export interface FakeRpcError {
  error: { code: number; message: string; data?: Record<string, unknown> };
}

const isRpcError = (v: unknown): v is FakeRpcError =>
  !!v && typeof v === 'object' && 'error' in v && typeof (v as FakeRpcError).error?.code === 'number';

export function fakeTrueNas(options: FakeTrueNasOptions): Promise<FakeSocketServer> {
  return serve(
    '/api/current',
    { ...(options.tls ? { tls: true } : {}), ...(options.missing ? { missing: true } : {}) },
    () => {},
    (() => {
      const signedIn = new WeakSet<WebSocket>();
      return (client, m) => {
        const id = m.id;
        const answer = (result: unknown) => send(client, { jsonrpc: '2.0', id, result });
        const fail = (code: number, message: string, data?: Record<string, unknown>) =>
          send(client, { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
        const method = String(m.method);
        const params = m.params;
        if (method === 'auth.login_with_api_key') {
          const ok = Array.isArray(params) && params[0] === options.apiKey;
          if (ok) signedIn.add(client);
          answer(ok);
          // A notification nobody asked for, as TrueNAS sends them.
          if (ok)
            send(client, {
              jsonrpc: '2.0',
              method: 'collection_update',
              params: { msg: 'changed', collection: 'alert.list', id: 1 },
            });
          return;
        }
        if (!signedIn.has(client))
          return fail(-32001, 'Method call error', {
            error: 13,
            errname: 'EACCES',
            reason: 'Not authenticated',
          });
        if (method === 'system.info')
          return answer({
            version: options.version ?? 'TrueNAS-25.10.1',
            hostname: 'nas',
            uptime: '15 days',
          });
        const own = options.methods?.[method];
        if (own) {
          void Promise.resolve(own(params)).then((out) =>
            isRpcError(out) ? fail(out.error.code, out.error.message, out.error.data) : answer(out),
          );
          return;
        }
        fail(-32601, 'Method not found', {
          errname: 'ENOMETHOD',
          reason: `Method ${method} not found`,
          trace: { class: 'CallError', frames: [], formatted: 'Traceback (most recent call last): …' },
        });
      };
    })(),
  );
}

/* ESPHome's Device Builder ------------------------------------------------------------------------------------------ */

export interface FakeBuilderOptions {
  version?: string;
  /** The Builder was started with a username and password. */
  login?: { username: string; password: string };
  /** It paused sign-ins (ten wrong ones in five minutes). */
  rateLimited?: boolean;
  /** An older dashboard: the socket opens but sends no server info. */
  noServerInfo?: boolean;
  /** No socket at `/ws` at all. */
  missing?: boolean;
  /** The token `auth/login` answers. */
  token?: string;
  /** Extra commands: a result, or `{ error_code, details }`. */
  commands?: Record<string, (args: unknown) => unknown>;
}

export function fakeDeviceBuilder(options: FakeBuilderOptions = {}): Promise<FakeSocketServer> {
  const authed = new WeakSet<WebSocket>();
  const timers = new Set<NodeJS.Timeout>();
  return serve(
    '/ws',
    options.missing ? { missing: true } : {},
    (client) => {
      if (options.noServerInfo) {
        send(client, { event: 'initial_state', data: [] });
        return;
      }
      send(client, {
        server_version: '1.1.0',
        esphome_version: options.version ?? '2026.6.5',
        port: 6052,
        ha_addon: false,
        friendly_name: '',
        ha_ingress: false,
        requires_auth: options.login !== undefined,
        desktop_version: '',
        desktop_update_capable: false,
      });
      client.on('close', () => {
        for (const t of timers) clearInterval(t);
      });
    },
    (client, m) => {
      const id = m.message_id;
      const command = String(m.command);
      const args = (m.args ?? {}) as Record<string, unknown>;
      const result = (value: unknown) => send(client, { message_id: id, result: value });
      const error = (code: string, details: string) =>
        send(client, { message_id: id, error_code: code, details });
      if (command === 'auth/login' || command === 'auth') {
        if (options.rateLimited) return error('rate_limited', 'Too many failed logins');
        const login = options.login;
        if (!login || args.username !== login.username || args.password !== login.password)
          return error('not_authenticated', 'Invalid username or password');
        authed.add(client);
        return result({ token: options.token ?? 'builder-session-token-0f3e', expires_at: 1_800_000_000 });
      }
      if (options.login && !authed.has(client)) return error('not_authenticated', 'Log in first');
      // Someone else's broadcast, between the answers.
      send(client, { message_id: 'b-7', event: 'device_updated', data: { name: 'porch' } });
      if (command === 'config/version') return result({ version: options.version ?? '2026.6.5' });
      if (command === 'devices/list')
        return result({ configured: [{ name: 'porch', configuration: 'porch.yaml' }], importable: [] });
      if (command === 'devices/validate') {
        send(client, { message_id: id, event: 'output', data: 'INFO Reading configuration porch.yaml...\n' });
        send(client, { message_id: id, event: 'output', data: 'INFO Configuration is valid!\n' });
        return send(client, { message_id: id, event: 'result', data: { success: true, code: 0 } });
      }
      if (command === 'devices/logs') {
        let n = 0;
        const timer = setInterval(() => {
          n++;
          send(client, {
            message_id: id,
            event: 'output',
            data: `[D][sensor:${n}] porch temperature 21.${n}\n`,
          });
        }, 20);
        timers.add(timer);
        return;
      }
      const own = options.commands?.[command];
      if (own) {
        const out = own(args) as Record<string, unknown> | null;
        if (out && typeof out.error_code === 'string')
          return error(out.error_code, String(out.details ?? ''));
        return result(out);
      }
      error('unknown_command', `Unknown command: ${command}`);
    },
  ).then((server) => {
    const close = server.close;
    server.close = async () => {
      for (const t of timers) clearInterval(t);
      await close();
    };
    return server;
  });
}

/* Where they stand -------------------------------------------------------------------------------------------------- */

/**
 * A destination policy as the connections' one would be for a home-network host: `host` resolves to `address` (a
 * private one), every resolved address must be it, and the socket really dials 127.0.0.1 (where the fake is).
 */
export function fakeHomePolicy(
  host: string,
  address: string,
  extra: Partial<OutboundPolicy> = {},
): OutboundPolicy {
  return {
    destination: {
      schemes: ['http:', 'https:'],
      check: (_hostname, addresses) => {
        if (addresses.some((a) => a !== address)) throw new OutboundError('destination', 'Not allowed.');
      },
    },
    resolve: async (name) => {
      if (name !== host)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return [{ address, family: 4 }];
    },
    dialAddress: (a) => (a === address ? '127.0.0.1' : a),
    ...extra,
  };
}

/** The fake's URL with its host name in place of 127.0.0.1. */
export function behind(server: Pick<FakeSocketServer, 'url'>, host: string): string {
  return server.url.replace('127.0.0.1', host);
}
