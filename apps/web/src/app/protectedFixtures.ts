/**
 * What's protected in fixture mode (Whombat backup-trust.md): `@whombat/client/protected/fake` over the REST contract,
 * and each pve-02 machine's page carrying its newest restore test. `tested` (`VITE_FIXTURE_PROTECTED=tested`, or
 * `localStorage['whombat:fixture-protected']` for the visual suite) starts with pve-02's tests on and three results;
 * without it the tests start off and the machines' pages stay as drawn.
 */
import {
  createFakeProtected,
  PROTECTED_FAKE_OPS,
  type ProtectedFakeKind,
} from '@whombat/client/protected/fake';
import type { HostGuestDetail } from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';

export type ProtectedFixtureKind = ProtectedFakeKind;

/** The visual suite's and a person's switch: `localStorage['whombat:fixture-protected']`. */
export const PROTECTED_FIXTURE_KEY = 'whombat:fixture-protected';

/** `option`, else `VITE_FIXTURE_PROTECTED`, else the switch in localStorage, else calm. */
export function protectedFixtureKind(option: ProtectedFixtureKind | undefined): ProtectedFixtureKind {
  if (option) return option;
  if (import.meta.env.VITE_FIXTURE_PROTECTED === 'tested') return 'tested';
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(PROTECTED_FIXTURE_KEY) === 'tested')
      return 'tested';
  } catch {
    // Storage may be shut: calm.
  }
  return 'calm';
}

const API_BASE = '/api/v1';
const OPS: ReadonlySet<string> = new Set(PROTECTED_FAKE_OPS);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface ProtectedFixtures {
  handle(req: Request): Promise<Response | null>;
  /** A pve-02 machine's page carries its newest result. */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createProtectedFixtures(kind: ProtectedFixtureKind, now = Date.now()): ProtectedFixtures {
  const fake = createFakeProtected({ kind, now });
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
  return {
    async handle(req) {
      const m = match(req);
      if (!m || !OPS.has(m.id)) return null;
      const body = req.method === 'GET' ? undefined : await req.clone().json();
      const answer = fake.call(m.id, { params: m.params, body });
      return answer ? json(answer.body, answer.status) : null;
    },

    async decorate(req, response) {
      if (!response.ok) return response;
      const m = match(req);
      if (m?.id !== 'hosts.getGuest') return response;
      const result = fake.guestResult(m.params.serverId ?? '', decodeURIComponent(m.params.guestId ?? ''));
      if (!result) return response;
      const guest = (await response.clone().json()) as HostGuestDetail;
      return json({ ...guest, restoreTest: result }, response.status);
    },
  };
}
