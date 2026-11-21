/**
 * A fake Fusebox for the AI gateway's tests (docs/decisions/ai-gateway.md): over plain http on 127.0.0.1, with the
 * rules that matter here — the management API under `/api` behind the management key (`GET /api/accounts`,
 * `GET /api/faults`, `GET /api/overview`, and while set `GET /api/faults/dismissed`, `GET /api/clients/usage`,
 * `/api/usage/status` and `/api/usage/dashboard` (404 otherwise, as an older Fusebox), `GET`/`PATCH
 * /api/config/settings` with a revision that every save changes, 409 on a stale one,
 * 400 naming `named-clients` when it is “too old”), and the client API (`GET /v1/models`, `POST /v1/messages`,
 * `POST /v1/responses`) open while it has neither client keys nor named clients, else for those keys only. The
 * messages and responses endpoints stream server-sent events in a few chunks, with `x-fusebox-account`.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface FakeNamedClient {
  id: string;
  label: string;
  key: string;
  [extra: string]: unknown;
}

export interface FakeFuseboxRequest {
  method: string;
  path: string;
  /** The path with its query, as sent. */
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export class FakeFusebox {
  managementKey = 'fusebox-management-key';
  namedClients: FakeNamedClient[] = [{ id: 'laptop', label: 'Laptop', key: 'sk-laptop' }];
  apiKeys: string[] = ['sk-shared'];
  /** The next PATCHes answer 409 after the config “changed” (its revision moves). */
  conflictsLeft = 0;
  /** An older Fusebox: a PATCH of `named-clients` answers 400. */
  tooOld = false;
  /** `/v1/models` refuses even a known key (a Fusebox that doesn't take Whombat's key). */
  refuseModels = false;
  /** `GET /v1/fusebox/status` for client keys (0.14+); false answers 404, as an older Fusebox. */
  statusRoute = true;
  /** Every request's socket is closed without an answer while set. */
  down = false;
  accounts: unknown[] = [];
  faults: unknown[] = [];
  /** `/api/overview`, with the keys and paths a real one also answers (fusebox-page.md FP-12). */
  overview: unknown = {
    version: '0.7.0',
    started_at: '2026-10-20T08:00:00Z',
    uptime_secs: 7200,
    base_url: 'http://127.0.0.1:8318',
    client_keys: ['sk-shared'],
    routing: 'least-used',
    session_affinity: true,
    totals: { requests: 120, ok: 117, failed: 3, cancelled: 0 },
    models: 12,
    config_path: '/etc/fusebox/config.yaml',
    auth_dir: '/etc/fusebox/auth',
  };
  /** `/api/clients/usage`, `/api/usage/status`, `/api/usage/dashboard`; null: 404, as before Fusebox had them. */
  clientsUsage: unknown = null;
  /** `/api/faults/dismissed`, what someone dismissed in Fusebox's dashboard; null: 404, as an older Fusebox. */
  dismissedFaults: unknown = null;
  /** Called with each request's path before it is answered (to change what Fusebox has between two reads). */
  onRequest: ((path: string) => void) | null = null;
  usageStatus: unknown = null;
  usageDashboard: unknown = null;
  /** The account `x-fusebox-account` names. */
  answeringAccount = 'claude-work.json';
  /** Milliseconds between the streamed events. */
  streamGapMs = 30;
  readonly requests: FakeFuseboxRequest[] = [];
  #edits = 0;
  #server: Server | null = null;
  readonly #sockets = new Set<Socket>();
  url = '';
  port = 0;

  revision(): string {
    return createHash('sha256')
      .update(JSON.stringify([this.namedClients, this.apiKeys, this.#edits]))
      .digest('hex')
      .slice(0, 16);
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.on('connection', (s) => {
      this.#sockets.add(s);
      s.on('close', () => this.#sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', () => resolve()));
    const address = this.#server.address();
    if (address && typeof address === 'object') {
      this.port = address.port;
      this.url = `http://127.0.0.1:${address.port}`;
    }
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** The requests to a path. */
  to(path: string): FakeFuseboxRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  #json(res: ServerResponse, status: number, body: unknown) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  #bearer(req: IncomingMessage): string | null {
    const raw = req.headers.authorization;
    const m = raw ? /^Bearer\s+(.+)$/.exec(raw) : null;
    return m?.[1]?.trim() ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null);
  }

  #clientAllowed(req: IncomingMessage): boolean {
    if (!this.apiKeys.length && !this.namedClients.length) return true;
    const key = this.#bearer(req);
    return !!key && (this.apiKeys.includes(key) || this.namedClients.some((c) => c.key === key));
  }

  #settings() {
    return {
      values: { 'named-clients': this.namedClients, 'api-keys': this.apiKeys, port: this.port },
      defaults: {},
      revision: this.revision(),
      path: '/etc/fusebox/config.yaml',
    };
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    this.requests.push({
      method: req.method ?? 'GET',
      path,
      url: req.url ?? '/',
      headers: req.headers,
      body,
    });
    this.onRequest?.(path);
    if (this.down) {
      req.socket.destroy();
      return;
    }
    if (path.startsWith('/api/')) {
      if (this.#bearer(req) !== this.managementKey)
        return this.#json(res, 401, { error: 'management key required' });
      if (path === '/api/accounts' && req.method === 'GET') return this.#json(res, 200, this.accounts);
      if (path === '/api/faults' && req.method === 'GET') return this.#json(res, 200, this.faults);
      const optional: Record<string, unknown> = {
        '/api/overview': this.overview,
        '/api/faults/dismissed': this.dismissedFaults,
        '/api/clients/usage': this.clientsUsage,
        '/api/usage/status': this.usageStatus,
        '/api/usage/dashboard': this.usageDashboard,
      };
      if (path in optional && req.method === 'GET') {
        const body = optional[path];
        return body == null ? this.#json(res, 404, { error: 'not found' }) : this.#json(res, 200, body);
      }
      if (path === '/api/config/settings' && req.method === 'GET')
        return this.#json(res, 200, this.#settings());
      if (path === '/api/config/settings' && req.method === 'PATCH') {
        const patch = JSON.parse(body) as { revision: string; changes: Record<string, unknown> };
        if (this.conflictsLeft > 0) {
          this.conflictsLeft--;
          this.#edits++;
          return this.#json(res, 409, { error: 'The config changed since you opened it.' });
        }
        if (patch.revision !== this.revision())
          return this.#json(res, 409, { error: 'The config changed since you opened it.' });
        if (this.tooOld && 'named-clients' in patch.changes)
          return this.#json(res, 400, { error: 'unknown setting named-clients' });
        const list = patch.changes['named-clients'];
        if (Array.isArray(list)) this.namedClients = list as FakeNamedClient[];
        this.#edits++;
        return this.#json(res, 200, this.#settings());
      }
      return this.#json(res, 404, { error: 'not found' });
    }
    if (path === '/v1/fusebox/status' && !this.statusRoute)
      return this.#json(res, 404, { error: 'not found' });
    if (!this.#clientAllowed(req)) return this.#json(res, 401, { error: 'invalid or missing API key' });
    // The status read checks only the key (as Fusebox's `admit_status`), never a client's user agents.
    if (path === '/v1/fusebox/status' && req.method === 'GET') {
      if (this.refuseModels) return this.#json(res, 401, { error: 'invalid or missing API key' });
      return this.#json(res, 200, { ready: 1, accounts: 1 });
    }
    if (path === '/v1/models' && req.method === 'GET') {
      if (this.refuseModels) return this.#json(res, 401, { error: 'invalid or missing API key' });
      const client = this.namedClients.find((c) => c.key === this.#bearer(req));
      const agents = Array.isArray(client?.['user-agents']) ? (client['user-agents'] as string[]) : [];
      const agent = String(req.headers['user-agent'] ?? '');
      if (agents.length && !agents.some((p) => agent.startsWith(p.replace(/\*$/, ''))))
        return this.#json(res, 403, { error: `this key only works from ${agents.join(', ')}` });
      return this.#json(res, 200, { object: 'list', data: [{ id: 'claude-opus-6' }] });
    }
    if ((path === '/v1/messages' || path === '/v1/responses') && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-fusebox-account': this.answeringAccount,
      });
      const events = ['message_start', 'content_block_delta', 'message_stop'];
      for (const [i, type] of events.entries()) {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, i })}\n\n`);
        await new Promise((r) => setTimeout(r, this.streamGapMs));
      }
      res.end();
      return;
    }
    return this.#json(res, 404, { error: 'not found' });
  }
}
