/**
 * A fake report tracker for the trackers' tests (docs/decisions/report-trackers.md), driven by the tests' driver
 * (`tracker-driver.ts`): three report routes (`GET /v1/integrations/reports[?before=]`, `GET …/{id}`, `POST …/{id}`)
 * over plain http on 127.0.0.1, with the rules a tracker's driver relies on: a Bearer token, 50 a page newest first
 * without the screenshot, `request_id` receipts checked before the revision (a replay answers the report), 409 on a
 * stale revision, unknown fields refused, the team as the author of its messages, and a revision bump on every change.
 * The organization's access: `POST`/`DELETE …/reports/{id}/assessment-access` (403 without the assess scope) and a few
 * organization routes only a live grant token reads. `GET /v1/health` (no token: what it runs, `environment` when set),
 * a `release` record with an update (`available` needs one), message ids that are the update's request id, and the
 * reporter writing back, confirming or reopening (`reporterWrites`).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeTrackerItem {
  title_pending: boolean;
  id: string;
  number: number;
  organization_id: string;
  organization_name: string;
  reporter_name: string;
  reporter_email: string;
  kind: 'bug' | 'feature';
  title: string;
  description: string;
  expected: string;
  context: Record<string, unknown> | null;
  attachment: { name: string; data_url: string } | null;
  app_version: string;
  audit: unknown[];
  status: string;
  priority: string;
  assessment: string | null;
  duplicate_of: string | null;
  release: { component: string; version: string; evidence: string } | null;
  messages: { id: string; author: string; body: string; at: string }[];
  notify_email: boolean;
  revision: number;
  unread: boolean;
  created_at: string;
  updated_at: string;
}

const UPDATE_FIELDS = new Set([
  'request_id',
  'revision',
  'message',
  'status',
  'priority',
  'assessment',
  'duplicate_of',
  'release',
  'notify_email',
]);

export interface FakeTrackerPost {
  id: string;
  body: Record<string, unknown>;
  /** The answer's HTTP status. */
  status: number;
}

export interface FakeTrackerGrant {
  token: string;
  reportId: string;
  organizationId: string;
  expiresAt: number;
  revoked: boolean;
}

/** The scopes the fake grants (the tracker's read scopes of an organization). */
export const FAKE_GRANT_SCOPES = [
  'devices:read',
  'blueprints:read',
  'policies:read',
  'rollouts:read',
  'nest:read',
  'audit:read',
];

/** What `GET /v1/health` answers (the tracker's `Health`; `environment` only once the tracker sends it). */
export interface FakeTrackerHealth {
  status: string;
  service: string;
  version: string;
  release: string;
  source_revision: string;
  source_dirty: boolean | null;
  environment?: 'development' | 'production';
  /** What it offers of the part released on its own (its devices' software), once the tracker says. */
  device_release_version?: string;
  device_source_revision?: string;
}

export class FakeTracker {
  /** What the installation runs. */
  health: FakeTrackerHealth = {
    status: 'ok',
    service: 'tracker',
    version: '0.1.174',
    release: '0.1.174',
    source_revision: '0'.repeat(40),
    source_dirty: false,
  };
  /** How many times `/v1/health` was read. */
  healthReads = 0;
  /** The integration token has `reports:assess` (else the grant answers 403). */
  assess = true;
  /** How long a grant lasts. */
  grantTtlMs = 60 * 60_000;
  readonly grants = new Map<string, FakeTrackerGrant>();
  /** Every `DELETE …/assessment-access`, by report id. */
  readonly revocations: string[] = [];
  /** Every organization read: its path and the token it came with. */
  readonly orgGets: { path: string; token: string }[] = [];
  readonly reports = new Map<string, FakeTrackerItem>();
  /** Diagnostics packages reports link (`GET …/reports/{id}/diagnostics/{package}`), by `<reportId>:<package>`. */
  readonly packages = new Map<string, unknown>();
  token = 'tracker-reports-token';
  pageSize = 50;
  /** The next POSTs answer 409 after bumping the revision (the tracker's title job got there first). */
  conflictsLeft = 0;
  /** Every POST answers 400 with this text while set. */
  refuse: string | null = null;
  /** Every answer is this status while set (a 5xx outage). */
  down: number | null = null;
  /** Every update (POST) answers this status while set; reads and health still work. */
  postsDown: number | null = null;
  readonly posts: FakeTrackerPost[] = [];
  readonly gets: string[] = [];
  readonly #receipts = new Set<string>();
  #number = 100;
  #server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', () => resolve()));
    const address = this.#server.address();
    if (address && typeof address === 'object') this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  /** A new report (newest number), `daysOld` days ago. */
  add(over: Partial<FakeTrackerItem> = {}, daysOld = 1): FakeTrackerItem {
    const at = new Date(Date.now() - daysOld * 86_400_000).toISOString();
    const report: FakeTrackerItem = {
      title_pending: false,
      id: randomUUID(),
      number: ++this.#number,
      organization_id: '00000000-0000-4000-8000-000000000001',
      organization_name: 'Acme Fleet',
      reporter_name: 'Rita Reporter',
      reporter_email: 'rita@acme.example',
      kind: 'bug',
      title: 'Blueprint won’t save',
      description: 'Saving a blueprint fails with an error.',
      expected: 'It saves.',
      context: {
        page: 'blueprints',
        browser: 'Firefox 131 · Linux',
        viewport: '1440x900',
        breadcrumbs: [
          {
            at,
            category: 'api',
            action: 'POST /v1/blueprints',
            status: 500,
            request_id: '11111111-1111-4111-8111-111111111111',
          },
        ],
        resources: [],
        diagnostics: { captured_at: at, origin: 'https://desk.acme.example', devices: [] },
      },
      attachment: null,
      app_version: '2026.10.1',
      audit: [],
      status: 'new',
      priority: 'normal',
      assessment: null,
      duplicate_of: null,
      release: null,
      messages: [],
      notify_email: true,
      revision: 1,
      unread: false,
      created_at: at,
      updated_at: at,
      ...over,
    };
    this.reports.set(report.id, report);
    return report;
  }

  /** A change made in the tracker (its team, its release tooling, the reporter): the revision moves. */
  change(id: string, edit: (r: FakeTrackerItem) => void): FakeTrackerItem {
    const r = this.reports.get(id);
    if (!r) throw new Error(`no report ${id}`);
    edit(r);
    r.revision++;
    r.updated_at = new Date().toISOString();
    return r;
  }

  /**
   * The reporter writes back in My reports (the tracker's own rules): a message as themselves, with “It works” (`confirmed`,
   * from available or closed) or “Still happening” (`new`) when `status` says so.
   */
  reporterWrites(id: string, message: string, status?: 'confirmed' | 'new'): FakeTrackerItem {
    return this.change(id, (r) => {
      if (status) r.status = status;
      if (status === 'new') {
        r.release = null;
        r.assessment = null;
      }
      r.messages.push({
        id: randomUUID(),
        author: r.reporter_name,
        body: message,
        at: new Date().toISOString(),
      });
    });
  }

  #send(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  #error(res: ServerResponse, status: number, error: string): void {
    this.#send(res, status, {
      error,
      error_code: 'x',
      diagnostic_code: null,
      retryable: false,
      retry_after_seconds: null,
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (this.down) return this.#error(res, this.down, 'down');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/v1/health' && req.method === 'GET') {
      this.healthReads++;
      return this.#send(res, 200, { ...this.health, background_reconcilers: 'enabled', capabilities: [] });
    }
    if (!url.pathname.startsWith('/v1/integrations/')) return this.#org(req, res, url);
    if (req.headers.authorization !== `Bearer ${this.token}`)
      return this.#error(res, 401, 'invalid API token');
    const access = /^\/v1\/integrations\/reports\/([0-9a-f-]{36})\/assessment-access$/.exec(url.pathname);
    if (access?.[1]) return this.#access(req, res, access[1]);
    const pkg = /^\/v1\/integrations\/reports\/([0-9a-f-]{36})\/diagnostics\/([A-Za-z0-9._-]+)$/.exec(
      url.pathname,
    );
    if (pkg?.[1] && pkg[2]) {
      const body = this.packages.get(`${pkg[1]}:${pkg[2]}`);
      return body === undefined ? this.#error(res, 404, 'package not found') : this.#send(res, 200, body);
    }
    const m = /^\/v1\/integrations\/reports(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
    if (!m) return this.#error(res, 404, 'not found');
    const id = m[1];
    if (req.method === 'GET' && !id) {
      const before = url.searchParams.has('before')
        ? Number(url.searchParams.get('before'))
        : Number.MAX_SAFE_INTEGER;
      const rows = [...this.reports.values()]
        .filter((r) => r.number < before)
        .sort((a, b) => b.number - a.number);
      const page = rows.slice(0, this.pageSize);
      const more = rows.length > this.pageSize;
      return this.#send(res, 200, {
        organization_id: '00000000-0000-4000-8000-000000000001',
        reports: page.map((r) => ({ ...r, attachment: null })),
        next_before: more ? (page[page.length - 1]?.number ?? null) : null,
      });
    }
    const report = id ? this.reports.get(id) : undefined;
    if (!report || !id) return this.#error(res, 404, 'report not found');
    if (req.method === 'GET') {
      this.gets.push(id);
      return this.#send(res, 200, report);
    }
    if (req.method !== 'POST') return this.#error(res, 405, 'method');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.#error(res, 400, 'invalid JSON');
    }
    const answer = (status: number) => this.posts.push({ id, body, status });
    if (this.postsDown) {
      answer(this.postsDown);
      return this.#error(res, this.postsDown, 'down');
    }
    if (Object.keys(body).some((k) => !UPDATE_FIELDS.has(k))) {
      answer(400);
      return this.#error(res, 400, 'unknown field');
    }
    if (body.notify_email !== undefined) {
      answer(403);
      return this.#error(res, 403, 'notify_email belongs to the reporter');
    }
    const receipt = `${id}:${String(body.request_id)}`;
    if (this.#receipts.has(receipt)) {
      answer(200);
      return this.#send(res, 200, report);
    }
    if (this.conflictsLeft > 0) {
      this.conflictsLeft--;
      this.change(id, () => {});
      answer(409);
      return this.#error(res, 409, 'report changed; refresh before updating');
    }
    if (body.revision !== report.revision) {
      answer(409);
      return this.#error(res, 409, 'report changed; refresh before updating');
    }
    if (this.refuse) {
      answer(400);
      return this.#error(res, 400, this.refuse);
    }
    const release = body.release as
      | { component?: unknown; version?: unknown; evidence?: unknown }
      | undefined;
    if (
      release !== undefined &&
      (!['manage', 'workstation', 'nest'].includes(String(release?.component)) ||
        typeof release?.version !== 'string' ||
        !release.version.trim() ||
        typeof release?.evidence !== 'string' ||
        !release.evidence.trim())
    ) {
      answer(400);
      return this.#error(res, 400, 'unsupported report value');
    }
    if (body.status === 'available' && !release && !report.release) {
      answer(400);
      return this.#error(res, 400, 'release evidence is required before notifying availability');
    }
    // The tracker's rule: a duplicate link needs the duplicate status, and an original of the same organization.
    if (body.duplicate_of !== undefined) {
      const original = this.reports.get(String(body.duplicate_of));
      if (
        body.status !== 'duplicate' ||
        !original ||
        original.organization_id !== report.organization_id ||
        original.duplicate_of
      ) {
        answer(400);
        return this.#error(res, 400, 'duplicates must link directly to an original in this organization');
      }
    }
    this.change(id, (r) => {
      if (typeof body.status === 'string') r.status = body.status;
      if (typeof body.duplicate_of === 'string') r.duplicate_of = body.duplicate_of;
      if (typeof body.priority === 'string') r.priority = body.priority;
      if (typeof body.assessment === 'string') r.assessment = body.assessment;
      if (release)
        r.release = {
          component: String(release.component),
          version: String(release.version),
          evidence: String(release.evidence),
        };
      // The tracker keeps the request id as the message's id.
      if (typeof body.message === 'string')
        r.messages.push({
          id: String(body.request_id),
          author: 'Acme team',
          body: body.message,
          at: new Date().toISOString(),
        });
    });
    this.#receipts.add(receipt);
    answer(200);
    return this.#send(res, 200, report);
  }

  /** `POST` mints a grant for the report's organization; `DELETE` revokes every grant of the report (204). */
  #access(req: IncomingMessage, res: ServerResponse, id: string) {
    const report = this.reports.get(id);
    if (!report) return this.#error(res, 404, 'report not found');
    if (req.method === 'DELETE') {
      this.revocations.push(id);
      for (const g of this.grants.values()) if (g.reportId === id) g.revoked = true;
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'POST') return this.#error(res, 405, 'method');
    if (!this.assess) return this.#error(res, 403, 'API token lacks reports:assess');
    const grant: FakeTrackerGrant = {
      token: `tgr_${randomUUID().replace(/-/g, '')}`,
      reportId: id,
      organizationId: report.organization_id,
      expiresAt: Date.now() + this.grantTtlMs,
      revoked: false,
    };
    this.grants.set(grant.token, grant);
    this.#send(res, 201, {
      token: grant.token,
      expires_at: new Date(grant.expiresAt).toISOString(),
      scopes: FAKE_GRANT_SCOPES,
      organization_id: report.organization_id,
      organization_name: report.organization_name,
    });
  }

  /** An organization route: only a live grant token reads it (the integration token lacks the scopes: 403). */
  #org(req: IncomingMessage, res: ServerResponse, url: URL) {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    this.orgGets.push({ path: `${url.pathname}${url.search}`, token: bearer });
    if (bearer === this.token) return this.#error(res, 403, 'API token lacks devices:read');
    const grant = this.grants.get(bearer);
    if (!grant || grant.revoked || grant.expiresAt <= Date.now())
      return this.#error(res, 401, 'invalid API token');
    if (req.method !== 'GET') return this.#error(res, 403, 'read-only access');
    const path = url.pathname;
    if (path === '/v1/devices')
      return this.#send(res, 200, {
        devices: [{ id: 'dev-1', name: 'Lab PC 1', status: 'online', organization_id: grant.organizationId }],
        total: 1,
      });
    const device = /^\/v1\/devices\/([\w-]+)$/.exec(path);
    if (device)
      return this.#send(res, 200, { id: device[1], name: 'Lab PC 1', blueprint: 'Standard Workstation' });
    if (path === '/v1/nest/status-summary') return this.#send(res, 200, { nodes: 1, healthy: 1 });
    if (path === '/v1/audit-events')
      return this.#send(res, 200, { events: [{ action: 'blueprint.save_failed' }] });
    if (path === '/v1/big') return this.#send(res, 200, { blob: 'x'.repeat(300 * 1024) });
    if (path === '/v1/text') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('plain words');
      return;
    }
    // A misbehaving route that echoes both tokens (the scrub must remove them).
    if (path === '/v1/leaky') return this.#send(res, 200, { seen: `${bearer} and ${this.token}` });
    return this.#error(res, 404, 'not found');
  }
}
