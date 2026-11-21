/**
 * The tests' tracker driver (docs/decisions/report-trackers.md): a `TrackerDriver` that speaks to `FakeTracker` (an
 * HTTP fake with the shapes of the first tracker Whombat followed), with the semantics a real driver owns — paging to
 * the cursor, the request id as a message's id, one retry on a conflict, only the values that differ, the release
 * record of `available`, its own path rules for the organization's reads, its pull request line. Tests only: the real
 * drivers are plugins outside this repository.
 */
import { z } from 'zod';
import type { Services } from '../services';
import {
  TRACKER_DRIVER_API,
  type TrackerConnection,
  type TrackerDriver,
  TrackerFailure,
  type TrackerItem,
  type TrackerItemFull,
} from '../trackers/driver';
import type { FakeTracker } from './tracker';

/** The driver id test connections name (`fields.driver`). */
export const FAKE_DRIVER = 'fake-tracker';
/** What the fake tracker is called. */
export const FAKE_WORDS = { product: 'Acme Desk', team: 'Acme team' } as const;
/** The fake's team author (how the integration's replies arrive). */
const TEAM = 'Acme team';
const MAX_PAGES = 5;
const MAX_CATCH_UP_PAGES = 200;
const LINE_PREFIX = 'Tracker report:';

const Raw = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  organization_id: z.string().nullable().optional().catch(null),
  organization_name: z.string().nullable().optional().catch(null),
  reporter_name: z.string().nullable().optional().catch(null),
  reporter_email: z.string().nullable().optional().catch(null),
  kind: z.string().catch('bug'),
  title: z.string().nullable().optional().catch(null),
  description: z.string().catch('').optional(),
  expected: z.string().catch('').optional(),
  context: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
  attachment: z.object({ data_url: z.string() }).nullable().optional().catch(null),
  app_version: z.string().nullable().optional().catch(null),
  audit: z.array(z.unknown()).catch([]).optional(),
  status: z.string().min(1),
  duplicate_of: z.string().nullable().optional().catch(null),
  priority: z.string().nullable().optional().catch(null),
  assessment: z.string().nullable().optional().catch(null),
  release: z
    .object({ component: z.string(), version: z.string(), evidence: z.string().optional() })
    .nullable()
    .optional()
    .catch(null),
  messages: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        author: z.string(),
        body: z.string(),
        at: z.string().nullable(),
      }),
    )
    .catch([])
    .optional(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
type Raw = z.infer<typeof Raw>;

function fail(code: TrackerFailure['code'], message: string): never {
  throw new TrackerFailure(code, message);
}

function environmentOf(r: Raw): 'production' | 'development' | null {
  const origin = ((r.context?.diagnostics as { origin?: unknown } | undefined)?.origin ?? '') as string;
  try {
    const host = new URL(origin).hostname;
    if (host === 'desk.acme.example') return 'production';
    if (host.startsWith('dev.') || host === 'localhost') return 'development';
  } catch {}
  return null;
}

function itemOf(r: Raw): TrackerItem {
  const c = (r.context ?? {}) as {
    page?: unknown;
    browser?: unknown;
    breadcrumbs?: unknown[];
    resources?: unknown[];
  };
  return {
    id: r.id,
    number: r.number,
    kind: r.kind === 'feature' ? 'feature' : 'bug',
    title: r.title ?? null,
    description: (r.description ?? '').slice(0, 100_000),
    expected: (r.expected ?? '').slice(0, 100_000),
    organization: { id: r.organization_id ?? null, name: r.organization_name ?? null },
    environment: environmentOf(r),
    version: r.app_version ?? null,
    page: typeof c.page === 'string' ? c.page.slice(0, 160) : null,
    browser: typeof c.browser === 'string' ? c.browser.slice(0, 120) : null,
    status: r.status,
    priority: r.priority ?? null,
    assessment: r.assessment ?? null,
    duplicateOf: r.duplicate_of ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messages: (r.messages ?? []).map((m) => ({
      id: m.id ?? null,
      author: m.author.trim() === TEAM ? ('team' as const) : ('reporter' as const),
      body: m.body,
      at: m.at,
    })),
    hasScreenshot: !!r.attachment?.data_url,
    hasDiagnostics:
      (c.breadcrumbs?.length ?? 0) > 0 || (c.resources?.length ?? 0) > 0 || (r.audit?.length ?? 0) > 0,
    release: r.release ? { ...r.release, evidence: r.release.evidence ?? '' } : null,
  };
}

function fullOf(r: Raw): TrackerItemFull {
  const crumbs = ((r.context?.breadcrumbs as { action?: string; status?: number }[] | undefined) ?? []).map(
    (b) =>
      `- ${[b.action, typeof b.status === 'number' ? `HTTP ${b.status}` : null].filter(Boolean).join(' · ')}`,
  );
  return {
    ...itemOf(r),
    reporter: { name: r.reporter_name ?? null, email: r.reporter_email ?? null },
    screenshot: r.attachment?.data_url ?? null,
    evidence: crumbs.length ? `Recent actions and requests (oldest first):\n${crumbs.join('\n')}` : '',
  };
}

/**
 * A driver of these fakes: a connection's requests go to the fake on its address's port (so a home-network name needs
 * no resolving), else to the first.
 */
export function fakeTrackerDriver(fakes: readonly FakeTracker[]): TrackerDriver {
  const fakeOf = (conn: TrackerConnection): FakeTracker => {
    let port = '';
    try {
      port = new URL(conn.baseUrl).port;
    } catch {}
    return fakes.find((f) => f.url && new URL(f.url).port === port) ?? (fakes[0] as FakeTracker);
  };
  const request = async (
    conn: TrackerConnection,
    method: string,
    path: string,
    body?: unknown,
    token = conn.token,
  ): Promise<{ status: number; json: unknown; text: string }> => {
    let res: Response;
    try {
      res = await fetch(`${fakeOf(conn).url}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail('unreachable', `${conn.label} didn’t answer.`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const errorText = (json: unknown) =>
    ((json as { error?: unknown } | null)?.error as string | undefined) ?? null;
  const send = async (conn: TrackerConnection, method: string, path: string, body?: unknown) => {
    const res = await request(conn, method, path, body);
    if (res.status === 401 || res.status === 403)
      fail(
        'refused',
        `Acme Desk refused the API token (HTTP ${res.status}). Set a token with reports:read and reports:write.`,
      );
    if (res.status >= 500 || res.status === 429)
      fail('unreachable', `Acme Desk answered HTTP ${res.status}; trying again soon.`);
    return res;
  };
  const get = async (conn: TrackerConnection, id: string): Promise<Raw> => {
    const res = await send(conn, 'GET', `/v1/integrations/reports/${encodeURIComponent(id)}`);
    if (res.status === 404) fail('not_found', `Acme Desk has no report ${id}.`);
    const raw = Raw.safeParse(res.json);
    if (!raw.success)
      fail('invalid_answer', 'Acme Desk’s answer for the report wasn’t what this Whombat understands.');
    return raw.data;
  };
  const update = async (conn: TrackerConnection, id: string, body: Record<string, unknown>) => {
    const res = await send(conn, 'POST', `/v1/integrations/reports/${encodeURIComponent(id)}`, body);
    if (res.status === 409) fail('conflict', errorText(res.json) ?? 'The report changed in Acme Desk.');
    if (res.status === 404) fail('not_found', `Acme Desk has no report ${id}.`);
    if (res.status >= 400)
      fail('rejected', errorText(res.json) ?? `Acme Desk refused the change (HTTP ${res.status}).`);
  };
  const list = async (conn: TrackerConnection, before: number | null) => {
    const res = await send(
      conn,
      'GET',
      `/v1/integrations/reports${before !== null ? `?before=${before}` : ''}`,
    );
    const page = res.json as { reports?: unknown[]; next_before?: number | null } | null;
    if (res.status !== 200 || !Array.isArray(page?.reports))
      fail('invalid_answer', 'Acme Desk’s report list wasn’t understood.');
    return { reports: page.reports, next: page.next_before ?? null };
  };
  const sort = (raws: unknown[]) => {
    const items: TrackerItem[] = [];
    const unreadable: { id: string | null; number: number | null }[] = [];
    for (const r of raws) {
      const p = Raw.safeParse(r);
      if (p.success) items.push(itemOf(p.data));
      else {
        const x = r as { id?: unknown; number?: unknown } | null;
        unreadable.push({
          id: typeof x?.id === 'string' ? x.id : null,
          number: typeof x?.number === 'number' ? x.number : null,
        });
      }
    }
    return { items, unreadable };
  };
  return {
    info: {
      api: TRACKER_DRIVER_API,
      id: FAKE_DRIVER,
      version: '1.0.0',
      words: { ...FAKE_WORDS },
      guidance: {
        source: 'A signed-in Acme Desk customer sent the report below through its own Feedback',
        access: 'its devices, deployments and audit',
      },
      releasedSeparately: ['agent/'],
      reachesNoCustomer: ['ops/checks/'],
      separateNow: {
        en: 'Press ‘Update now’ on your hub to get it right away.',
        nl: 'Klik bij je hub op ‘Nu bijwerken’ om het meteen te krijgen.',
      },
      prPrefix: LINE_PREFIX,
    },
    async check(conn) {
      const res = await request(conn, 'GET', '/v1/integrations/reports');
      return {
        ok: res.status === 200,
        refused: res.status === 401 || res.status === 403,
        status: res.status,
        message: res.status === 200 ? null : (errorText(res.json) ?? `HTTP ${res.status}`),
      };
    },
    async health(conn) {
      const res = await send(conn, 'GET', '/v1/health');
      const h = res.json as {
        version?: string;
        release?: string;
        source_revision?: string;
        source_dirty?: boolean | null;
        environment?: string;
        device_release_version?: string;
        device_source_revision?: string;
      } | null;
      const rev = (h?.source_revision ?? '').toLowerCase();
      const device = (h?.device_source_revision ?? '').toLowerCase();
      return {
        environment:
          h?.environment === 'development' || h?.environment === 'production' ? h.environment : null,
        version: (h?.version || h?.release || '').trim() || null,
        revision: h?.source_dirty === false && /^[0-9a-f]{40}$/.test(rev) ? rev : null,
        separate: /^[0-9a-f]{40}$/.test(device)
          ? { version: h?.device_release_version?.trim() || null, revision: device }
          : null,
      };
    },
    async poll(conn, { after, watch, pages }) {
      if (after === null) {
        const out: unknown[] = [];
        let before: number | null = null;
        for (let p = 0; p < (pages ?? 1); p++) {
          const page = await list(conn, before);
          out.push(...page.reports);
          if (!page.next) break;
          before = page.next;
        }
        return { ...sort(out), backlog: false };
      }
      const lowest = watch.length ? Math.min(...watch) : null;
      const raw: unknown[] = [];
      let before: number | null = null;
      let reached = false;
      let reachedWatched = lowest === null;
      let exhausted = false;
      for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
        const read = await list(conn, before);
        raw.push(...read.reports);
        const numbers = read.reports
          .map((r) => (r as { number?: unknown } | null)?.number)
          .filter((n): n is number => typeof n === 'number');
        reached ||= numbers.some((n) => n <= after);
        reachedWatched ||= lowest !== null && numbers.some((n) => n <= lowest);
        if (!read.next) exhausted = true;
        if (!read.next || (reached && (reachedWatched || page + 1 >= MAX_PAGES))) break;
        before = read.next;
      }
      return { ...sort(raw), backlog: !reached && !exhausted };
    },
    async item(conn, id) {
      return fullOf(await get(conn, id));
    },
    async diagnostics(conn, id, pkg, maxBytes) {
      const res = await send(
        conn,
        'GET',
        `/v1/integrations/reports/${encodeURIComponent(id)}/diagnostics/${encodeURIComponent(pkg)}`,
      );
      if (res.status === 404) fail('not_found', `The report doesn’t link a package called ${pkg}.`);
      if (res.status !== 200)
        fail('rejected', errorText(res.json) ?? `Acme Desk answered HTTP ${res.status} for the package.`);
      return { text: res.text.slice(0, maxBytes), cut: res.text.length > maxBytes };
    },
    async write(conn, id, input) {
      for (let attempt = 0; ; attempt++) {
        const now = await get(conn, id);
        const sent = {
          assessment: input.assessment && input.assessment !== now.assessment ? input.assessment : null,
          priority: input.priority && input.priority !== now.priority ? input.priority : null,
        };
        if (!sent.assessment && !sent.priority)
          return input.resend
            ? { sent: { assessment: input.assessment, priority: input.priority } }
            : { unchanged: true as const };
        try {
          await update(conn, id, {
            request_id: input.requestId,
            revision: now.revision,
            ...(sent.assessment ? { assessment: sent.assessment } : {}),
            ...(sent.priority ? { priority: sent.priority } : {}),
          });
          return { sent };
        } catch (err) {
          if (err instanceof TrackerFailure && err.code === 'conflict' && attempt === 0) continue;
          throw err;
        }
      }
    },
    async send(conn, id, input) {
      for (let attempt = 0; ; attempt++) {
        const now = await get(conn, id);
        if ((now.messages ?? []).some((m) => m.id === input.requestId))
          return { sent: true as const, status: null, already: true, now: now.status };
        const decided = input.status(now.status);
        if (decided && typeof decided === 'object') return { skipped: decided.skip, now: now.status };
        try {
          await update(conn, id, {
            request_id: input.requestId,
            revision: now.revision,
            ...(input.message ? { message: input.message } : {}),
            ...(decided ? { status: decided } : {}),
            ...(decided === 'duplicate' && input.duplicateOf ? { duplicate_of: input.duplicateOf } : {}),
            ...(decided === 'available' && input.release
              ? {
                  release: {
                    component: 'manage',
                    version: input.release.version,
                    evidence: input.release.evidence,
                  },
                }
              : {}),
          });
          return { sent: true as const, status: decided, already: false, now: now.status };
        } catch (err) {
          if (err instanceof TrackerFailure && err.code === 'conflict' && attempt === 0) continue;
          throw err;
        }
      }
    },
    async grant(conn, id) {
      const res = await request(
        conn,
        'POST',
        `/v1/integrations/reports/${encodeURIComponent(id)}/assessment-access`,
        {},
      );
      if (res.status === 403)
        fail(
          'access_refused',
          `The Acme Desk token lacks reports:assess (Acme Desk: ${errorText(res.json) ?? 'forbidden'}).`,
        );
      if (res.status !== 200 && res.status !== 201)
        fail('access_refused', `Acme Desk refused the access (HTTP ${res.status}).`);
      const g = res.json as {
        token: string;
        expires_at: string;
        scopes?: string[];
        organization_id?: string | null;
      };
      return {
        token: g.token,
        expiresAt: g.expires_at,
        scopes: g.scopes ?? [],
        organizationId: g.organization_id ?? null,
      };
    },
    async read(conn, grant, path, maxBytes) {
      const norm =
        path
          .split('?')[0]
          ?.replace(/\/{2,}/g, '/')
          .toLowerCase() ?? '';
      if (!norm.startsWith('/v1/')) fail('rejected', 'Give an API path starting with /v1/.');
      if (norm.split('/').some((s) => s === '.' || s === '..'))
        fail('rejected', 'Give the path without . or .. segments.');
      for (const prefix of ['/v1/integrations', '/v1/auth', '/v1/account', '/v1/platform'])
        if (norm === prefix || norm.startsWith(`${prefix}/`))
          fail('rejected', `Whombat doesn’t read ${prefix} paths with this access.`);
      const res = await request(conn, 'GET', path, undefined, grant.token);
      return { status: res.status, body: res.text.slice(0, maxBytes), cut: res.text.length > maxBytes };
    },
    async revoke(conn, id) {
      const res = await request(
        conn,
        'DELETE',
        `/v1/integrations/reports/${encodeURIComponent(id)}/assessment-access`,
      );
      return res.status === 204 || res.status === 200 || res.status === 404;
    },
    prLine(conn, number) {
      return `${LINE_PREFIX} ${new URL(conn.baseUrl).hostname.toLowerCase()} #${number}`;
    },
    prMatch(body) {
      return [...body.matchAll(/^\s*Tracker report:\s*(\S+)\s+#(\d+)\s*$/gim)].map((m) => ({
        host: (m[1] ?? '').toLowerCase(),
        number: Number(m[2]),
      }));
    },
  };
}

/** The fake trackers' driver, installed on these services as `FAKE_DRIVER` (test connections name it). */
export function useFakeTrackerDriver(services: Services, ...fakes: FakeTracker[]): TrackerDriver {
  const driver = fakeTrackerDriver(fakes);
  services.tracker.drivers.register(driver);
  return driver;
}
