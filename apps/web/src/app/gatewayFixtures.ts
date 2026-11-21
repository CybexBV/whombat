/**
 * The AI gateway in fixture mode (`VITE_FIXTURE_GATEWAY=fusebox|ai_gateway`, option `gateway`; Whombat ai-gateway.md
 * AIG-01…AIG-17; app docs/decisions/ai-gateway.md AP-1125): the burrow's Fusebox (or a company's AI gateway) as a shared
 * connection Mara made, Claude Code switched on and ChatGPT off. It serves the connection's page and Remove (Fusebox
 * “didn’t answer”, so the answer says to remove Whombat's client there, AIG-03), refuses a second gateway (AIG-01),
 * switches with `burrows.setAiGateway` (AIG-05), and puts `aiGateway` in the bootstrap and the pool in `usage.list`
 * (AIG-13): two Claude accounts — work@lumio.example.org on Max at 62 % of its 5-hour window, john@lumio.example.org used up until Monday
 * 09:00 — and two ChatGPT accounts, ops@lumio.example.org busy until 14:05 and an old Plus one that is off in Fusebox; read 1 min
 * before the mock world's moment (11:22 in Amsterdam). The generic gateway reports no accounts, only that it answers.
 * Outermost, so it decorates every other layer's answers; state lives in the closure, built to the contracts' schemas.
 */
import type { Burrow } from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import {
  type ConnectionView,
  catalogEntry,
  defaultConnectionLabel,
  type GatewayAccountUsage,
  type GatewayKind,
  type GatewayPool,
  gatewayClientId,
  gatewayClientLabel,
} from '@whombat/core/domain';
import { AI_GATEWAY_COPY } from '@whombat/core/text';
import { burrow, mara } from '@whombat/fixtures';

const API_BASE = '/api/v1';
export const GATEWAY_CONNECTION_ID = 'con_fixture_fusebox';
/** The mock world's moment is 09:22 UTC on Wednesday 23 September 2026. */
const at = (iso: string) => new Date(iso).toISOString();
const OBSERVED = at('2026-09-23T09:21:00Z');
/** Monday 28 September, 09:00 in Amsterdam. */
const MONDAY_0900 = at('2026-09-28T07:00:00Z');
/** 14:05 in Amsterdam today. */
const TODAY_1405 = at('2026-09-23T12:05:00Z');

export type GatewayFixtureKind = GatewayKind;

function window(
  kind: 'five_hour' | 'seven_day' | 'seven_day_opus',
  usedPct: number,
  resetsAt: string,
): GatewayAccountUsage['windows'][number] {
  const label = { five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus' }[kind];
  return {
    kind,
    label,
    usedPct,
    resetsAt,
    status: usedPct >= 100 ? 'limited' : usedPct >= 80 ? 'warning' : 'ok',
  };
}

const ACCOUNTS: GatewayAccountUsage[] = [
  {
    key: 'acct_claude_work',
    label: 'work@lumio.example.org',
    provider: 'claude',
    plan: 'max_5x',
    planName: 'Max',
    status: 'ok',
    until: null,
    windows: [
      window('five_hour', 62, at('2026-09-23T11:30:00Z')),
      window('seven_day', 41, at('2026-09-27T07:00:00Z')),
      window('seven_day_opus', 12, at('2026-09-27T07:00:00Z')),
    ],
  },
  {
    key: 'acct_claude_john',
    label: 'john@lumio.example.org',
    provider: 'claude',
    plan: 'max',
    status: 'used_up',
    until: MONDAY_0900,
    windows: [window('five_hour', 35, at('2026-09-23T12:40:00Z')), window('seven_day', 100, MONDAY_0900)],
  },
  {
    key: 'acct_codex_ops',
    label: 'ops@lumio.example.org',
    provider: 'codex',
    plan: 'pro',
    status: 'rate_limited',
    until: TODAY_1405,
    windows: [window('five_hour', 88, TODAY_1405), window('seven_day', 30, at('2026-09-29T07:00:00Z'))],
  },
  {
    key: 'acct_codex_old',
    label: 'old@lumio.example.org',
    provider: 'codex',
    plan: 'plus',
    status: 'off',
    until: null,
    windows: [],
  },
];

export function createGatewayFixtures({ kind }: { kind: GatewayFixtureKind }) {
  const entry = catalogEntry(kind);
  const fields: Record<string, string> =
    kind === 'fusebox'
      ? { url: 'https://10.100.0.235:8317', clientId: gatewayClientId(burrow.slug) }
      : { url: 'https://ai.lumio.example.org' };
  let connection: ConnectionView | null = {
    id: GATEWAY_CONNECTION_ID,
    catalogId: kind,
    label: entry ? defaultConnectionLabel(entry, fields) : 'Fusebox',
    handle: kind,
    connectedBy: { id: mara.id, name: mara.name },
    detail: null,
    signIn: 'token',
    transport: 'rest',
    fields,
    status: 'active',
    reauthReason: null,
    checks: [
      { id: 'credential', state: 'ok', message: null },
      { id: 'destination', state: 'ok', message: null },
    ],
    checkedAt: OBSERVED,
    toolCount: 0,
    access: 'manage',
    poller: null,
    createdAt: '2026-09-21T14:02:00.000Z',
    lastUsedAt: OBSERVED,
  };
  const switches = { claude: true, codex: false };
  let seq = 0;

  const aiGateway = (): Burrow['aiGateway'] =>
    connection
      ? {
          connectionId: connection.id,
          name: connection.label,
          kind,
          claude: switches.claude,
          codex: switches.codex,
        }
      : null;

  const pool = (): GatewayPool | null =>
    connection
      ? {
          connectionId: connection.id,
          name: connection.label,
          kind,
          claude: switches.claude,
          codex: switches.codex,
          reachable: true,
          observedAt: OBSERVED,
          error: null,
          accounts: kind === 'fusebox' ? ACCOUNTS : [],
        }
      : null;

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { id: ep.id, params };
    }
    return null;
  };

  const ours = (params: Record<string, string>) => !!connection && params.connectionId === connection.id;

  return {
    /** Its own answers: the switches, the connection's page, Recheck and Remove, and a second gateway's refusal. */
    async handle(req: Request, inner: (r: Request) => Promise<Response>): Promise<Response | null> {
      const m = match(req);
      if (!m) return null;
      switch (m.id) {
        case 'burrows.setAiGateway': {
          if (!connection)
            return json({ error: { code: 'not_found', message: 'This Whombat has no AI gateway.' } }, 404);
          const body = (await req.clone().json()) as { claude?: boolean; codex?: boolean };
          if (typeof body.claude === 'boolean') switches.claude = body.claude;
          if (typeof body.codex === 'boolean') switches.codex = body.codex;
          const boot = await inner(
            new Request(new URL(`${API_BASE}/burrows/${burrow.slug}/bootstrap`, 'http://fixtures.local')),
          );
          const data = (await boot.json()) as { burrow: Burrow };
          return json({
            burrow: { ...data.burrow, aiGateway: aiGateway() },
            eventId: `evt_gateway_${++seq}`,
          });
        }
        case 'connections.tools':
          return ours(m.params) ? json({ connection, tools: [], guide: '', truncated: false }) : null;
        case 'connections.recheck':
          return ours(m.params) ? json({ connection, eventId: `evt_gateway_${++seq}` }) : null;
        case 'connections.disconnect': {
          if (!ours(m.params) || !connection) return null;
          const label = connection.label;
          connection = null;
          // Fusebox didn't answer (AIG-03): Whombat's client stays there, so the answer says to remove it.
          return json({
            ok: true,
            eventId: `evt_gateway_${++seq}`,
            notice:
              kind === 'fusebox'
                ? AI_GATEWAY_COPY.removeByHand(label, gatewayClientLabel(burrow.name))
                : null,
          });
        }
        case 'connections.create': {
          const body = (await req.clone().json()) as { catalogId?: string };
          if (!connection || (body.catalogId !== 'fusebox' && body.catalogId !== 'ai_gateway')) return null;
          // One gateway per burrow (AIG-01).
          return json(
            {
              error: {
                code: 'conflict',
                message: AI_GATEWAY_COPY.exists(connection.label),
                details: { code: 'gateway_exists' },
              },
            },
            409,
          );
        }
        default:
          return null;
      }
    },

    /** Its parts of other answers: the bootstrap's and the burrow's `aiGateway`, the list's row, Usage's pool. */
    async decorate(req: Request, response: Response): Promise<Response> {
      if (req.method !== 'GET' || !response.ok) return response;
      const m = match(req);
      if (!m) return response;
      switch (m.id) {
        case 'conversations.bootstrap':
        case 'burrows.get': {
          const data = (await response.json()) as { burrow: Burrow };
          return json({ ...data, burrow: { ...data.burrow, aiGateway: aiGateway() } });
        }
        case 'connections.list': {
          const data = (await response.json()) as { connections: ConnectionView[] };
          return json({
            ...data,
            connections: connection ? [connection, ...data.connections] : data.connections,
          });
        }
        case 'usage.list': {
          const data = (await response.json()) as Record<string, unknown>;
          return json({ ...data, gateway: pool() });
        }
        default:
          return response;
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
