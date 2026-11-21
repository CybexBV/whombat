/**
 * A fake Home Assistant for scenario p (Whombat vault.md VT-80, VT-83): an MCP server over streamable HTTP at
 * `/api/mcp`, the way Home Assistant serves its MCP Server integration (stateless, JSON answers, a long-lived token as
 * the bearer). `HassTurnOn` and `GetLiveContext` behave like Home Assistant's (a result, a tool error for the device
 * `nowhere`, a JSON-RPC error for the area `nowhere`) and never repeat what they received. It records what it received
 * (method, JSON-RPC method, tool, whether the bearer was the expected token); the records stay in the harness's memory
 * and are never written to a report. (Its third tool, `EchoHeaders`, went with the Vault's relay that had to withhold
 * its answer: Hermes calls an MCP entry's server itself since contracts 0.125, IN-408.)
 *
 * It listens on a non-loopback private address of this host (`pickPrivateIpv4`): loopback is never a Vault
 * destination (VT-12), so the scenario lists the address's /32 and port on the home network list.
 */
import { createServer, type Server } from 'node:http';
import type { NetworkInterfaceInfo } from 'node:os';

export const FAKE_HA_PATH = '/api/mcp';

export const FAKE_HA_TOOLS = [
  {
    name: 'HassTurnOn',
    description: 'Turns on/opens/presses a device or entity.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        area: { type: 'string' },
        domain: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'GetLiveContext',
    description:
      'Provides real-time information about the CURRENT state, value, or mode of devices, sensors, entities, or areas.',
    inputSchema: { type: 'object', properties: { area: { type: 'string' } } },
  },
] as const;

/** What the fake received, one per HTTP request. */
export interface FakeHaRequest {
  at: number;
  httpMethod: string;
  path: string;
  /** JSON-RPC methods in the body (a batch has several). */
  rpc: string[];
  /** `tools/call` tool names. */
  tools: string[];
  /** The request carried `Authorization: Bearer <the expected token>`. */
  bearerOk: boolean;
  /** It carried any `Authorization` header. */
  hadAuthorization: boolean;
  status: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const text = (t: string) => ({ type: 'text', text: t });

/**
 * The JSON-RPC answer to one message (null for a notification). Pure: the scenario's unit test drives it without a
 * socket.
 */
export function fakeHaAnswer(msg: JsonRpcRequest): Record<string, unknown> | null {
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: typeof asked === 'string' ? asked : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'home-assistant', version: '2026.9.0' },
        instructions: 'Home Assistant (a fake for the Whombat integration harness).',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: FAKE_HA_TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === 'HassTurnOn') {
        const device = String(args.name ?? '');
        if (device === 'nowhere') return ok({ isError: true, content: [text('No device called nowhere.')] });
        return ok({
          content: [text(`Turned on ${device}.`)],
          structuredContent: { success: true, name: device },
        });
      }
      if (name === 'GetLiveContext') {
        if (args.area === 'nowhere') return fail(-32602, 'Unknown area nowhere');
        return ok({ content: [text('Live context: Kitchen light is on, 21.5 °C in the living room.')] });
      }
      return fail(-32602, `Unknown tool ${String(name)}`);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export interface FakeHomeAssistant {
  /** `http://<address>:<port>/api/mcp`. */
  url: string;
  address: string;
  port: number;
  requests: FakeHaRequest[];
  close(): Promise<void>;
}

/** Starts the fake on `address` (port 0: any free port). Every request must carry `Bearer <token>`, else 401. */
export async function startFakeHomeAssistant(address: string, token: string): Promise<FakeHomeAssistant> {
  const requests: FakeHaRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      const record: FakeHaRequest = {
        at: Date.now(),
        httpMethod: req.method ?? '',
        path: (req.url ?? '').split('?')[0] ?? '',
        rpc: [],
        tools: [],
        bearerOk: auth === `Bearer ${token}`,
        hadAuthorization: auth !== undefined,
        status: 0,
      };
      requests.push(record);
      const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
        record.status = status;
        const data = body === null ? '' : JSON.stringify(body);
        res.writeHead(status, {
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          'cache-control': 'no-store',
          ...extra,
        });
        res.end(data);
      };
      if (record.path !== FAKE_HA_PATH) return send(404, { message: 'Not found.' });
      if (!record.bearerOk) return send(401, { message: 'Unauthorized.' });
      // Stateless: no standalone SSE stream and no session to delete.
      if (req.method !== 'POST') return send(405, null, { allow: 'POST' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(parsed);
      const msgs = (batch ? parsed : [parsed]) as JsonRpcRequest[];
      for (const m of msgs) {
        record.rpc.push(String(m?.method ?? ''));
        if (m?.method === 'tools/call') record.tools.push(String(m.params?.name ?? ''));
      }
      const answers = msgs.map((m) => fakeHaAnswer(m)).filter((a) => a !== null);
      if (answers.length === 0) return send(202, null);
      send(200, batch ? answers : answers[0]);
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, address, () => ok());
  });
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    url: `http://${address}:${port}${FAKE_HA_PATH}`,
    address,
    port,
    requests,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const VIRTUAL =
  /^(docker|br-|veth|virbr|vnet|cni|flannel|cali|podman|lxc|lxd|vmnet|vboxnet|tailscale|wg|zt|tun|tap)/;

/** Whether an IPv4 address is in 10/8, 172.16/12 or 192.168/16 (RFC 1918). */
export function isRfc1918(address: string): boolean {
  const p = address.split('.').map((x) => Number.parseInt(x, 10));
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a = 0, b = 0] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * A non-loopback private IPv4 address of this host for the fake to listen on: RFC 1918 only (what a home network
 * uses), physical interfaces before bridges and tunnels, 192.168/16 before 10/8 before 172.16/12. Null when there is
 * none (the scenario then skips with a note).
 */
export function pickPrivateIpv4(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): { address: string; iface: string } | null {
  const rank = (address: string) => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
  const found: { address: string; iface: string; score: number }[] = [];
  for (const [iface, infos] of Object.entries(interfaces))
    for (const i of infos ?? [])
      if (i.family === 'IPv4' && !i.internal && isRfc1918(i.address))
        found.push({ address: i.address, iface, score: (VIRTUAL.test(iface) ? 10 : 0) + rank(i.address) });
  found.sort(
    (x, y) => x.score - y.score || x.iface.localeCompare(y.iface) || x.address.localeCompare(y.address),
  );
  const best = found[0];
  return best ? { address: best.address, iface: best.iface } : null;
}
