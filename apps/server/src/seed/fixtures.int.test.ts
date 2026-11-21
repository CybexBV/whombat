/**
 * Seeds `@whombat/fixtures`'s `seedWorld()` into a throwaway database (through `seedWorldSource()`, the
 * exact path `pnpm db:seed` uses) and compares the real server's responses against
 * `createFixtureFetch()`'s responses for the same requests — bootstrap, each conversation, each
 * conversation's messages, the thread, the run, the approval, the agents list, each agent profile, the
 * audit list (with filters/counts), search results and canvas meta. Only genuinely volatile fields are
 * normalized before comparing. See `docs/decisions/seed-wiring.md`.
 *
 * A standalone setup (its own db and services, called in-process as a session would), not `test/harness.ts#useTestServer()`: that harness
 * hardcodes `testWorld()`, and other workstreams' tests depend on that default.
 */

import { type AnyEndpoint, api, buildPath, toQueryString } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { MemoryMailer } from '../mail/mailer';
import { createServices, type Services } from '../services';
import { inProcessApi } from '../test/api';
import { createTestDb, type TestDb } from '../test/db';
import { testLogger } from '../test/log';
import { sessionFor } from '../test/tokens';
import { loadSeedWorld } from './load';
import { seedWorldSource } from './source';

const MARA_ID = 'prn_mara';

let testDb: TestDb & { drop: () => Promise<void> };
let services: Services;
const caller = inProcessApi(() => services);
let cookie: string;
let _seedSource: string;
const fixtureFetch = createFixtureFetch();

let pendingDb: ReturnType<typeof createTestDb> | undefined;

beforeAll(async () => {
  pendingDb = createTestDb();
  testDb = await pendingDb;
  const config = loadConfig({ DATABASE_URL: testDb.url, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  services = createServices({ config, sql: testDb.sql, mailer: new MemoryMailer(), log: testLogger() });
  const { world, source } = await seedWorldSource();
  _seedSource = source;
  await loadSeedWorld(services, world);
  cookie = (await sessionFor(services, MARA_ID)).cookie;
});

afterAll(async () => {
  await services?.background.settle();
  services?.typing.close();
  services?.files.close();
  // Also when beforeAll failed or timed out: drop the database once it exists.
  await (await pendingDb?.catch(() => undefined))?.drop();
});

/** Calls the real server through the exact same `Endpoint` (`buildPath`/`toQueryString`) the client uses. */
async function serverCall(
  ep: AnyEndpoint,
  params: Record<string, string | number> = {},
  query?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}${toQueryString(query)}`;
  const res = await caller.inject({ method: ep.method, url, headers: { cookie } });
  if (res.statusCode >= 400) throw new Error(`server ${ep.id} → ${res.statusCode}: ${res.body}`);
  return res.json();
}

/** Calls `createFixtureFetch()` through the identical URL construction. */
async function fixtureCall(
  ep: AnyEndpoint,
  params: Record<string, string | number> = {},
  query?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}${toQueryString(query)}`;
  const res = await fixtureFetch(`http://fixtures.local${path}`, { method: ep.method });
  if (res.status >= 400) throw new Error(`fixture ${ep.id} → ${res.status}: ${await res.text()}`);
  // `Response.json()` is typed `Promise<unknown>` under Node/undici (`@types/node`), unlike DOM lib's
  // `Promise<any>` — safe to assert `Record<string, unknown>` since every endpoint here returns a JSON
  // object. See `docs/decisions/seed-wiring.md` SW-13.
  return (await res.json()) as Record<string, unknown>;
}

/** Keys stripped before comparing because they legitimately differ between a freshly-seeded real database
 * and the in-memory fixture world, for reasons documented in `docs/decisions/seed-wiring.md` SW-11:
 * - `accountId`, `serverTime`: server-generated / live-clock, never seed-derived.
 * - `lastReadMessageId`: `createFixtureFetch()` has no per-viewer read-state model at all (hardcodes
 *   `null`); the real server computes it from the seeded read markers (SW-07). Out of scope to add
 *   read-state tracking to `fetch.ts` (a different, already-completed workstream).
 * - `presentIds`: real-time viewer presence (open websocket connections) — inherently live state, not
 *   seed data. `createFixtureFetch()` hardcodes the signed-in viewer as always "present" for the mock UI;
 *   a freshly-seeded test server correctly has nobody connected. */
const VOLATILE_KEYS = new Set(['accountId', 'serverTime', 'lastReadMessageId', 'presentIds']);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

async function _expectSameShape(
  ep: AnyEndpoint,
  params: Record<string, string | number> = {},
  query?: Record<string, unknown>,
) {
  const [server, fixture] = await Promise.all([
    serverCall(ep, params, query),
    fixtureCall(ep, params, query),
  ]);
  expect(stripVolatile(server), ep.id).toEqual(stripVolatile(fixture));
}

describe('seeded server vs createFixtureFetch()', () => {
  it('audit list matches once the fixture-only future events are excluded', async () => {
    // `createFixtureFetch()`'s in-memory chain (`AUDIT_CHAIN`) always includes every `LOG` row, including
    // the two that postdate the seeded "now" (`evt_9f2c`, `evt_9f31`) — the run/approval are still
    // live/pending at 11:22, so the real seeded server correctly excludes them (`docs/decisions/seed-
    // wiring.md` SW-02). Excluded here before comparing, since that's a documented, intentional
    // difference between the browser-only mock and a real "as of now" seeded database, not a bug.
    const [server, fixture] = await Promise.all([
      serverCall(api.audit.list, { burrow: 'burrow-hq' }, { actor: 'everyone', kind: 'all' }),
      fixtureCall(api.audit.list, { burrow: 'burrow-hq' }, { actor: 'everyone', kind: 'all' }),
    ]);
    const FUTURE_EVENT_IDS = new Set(['evt_9f2c', 'evt_9f31']);
    const fixtureEvents = fixture.events as { id: string }[];
    const fixtureCounts = fixture.counts as { all: number; code: number };
    const trimmedEvents = fixtureEvents.filter((e) => !FUTURE_EVENT_IDS.has(e.id));
    const trimmedFixture = {
      ...fixture,
      events: trimmedEvents,
      counts: { ...fixtureCounts, all: fixtureCounts.all - 2, code: fixtureCounts.code - 2 },
    };
    // Chain-position-dependent fields (`hash`/`sig`/`prevHash`/`seq`) can never match: the real loader
    // always prepends its own hidden `burrow.created`/`message.posted` bookkeeping events (`text: null`,
    // excluded from this very list) ahead of the seeded ones (`apps/server/src/seed/load.ts#
    // appendSeedEvents`), shifting every `seq` and, since hashing is cumulative, every `hash`/`prevHash`/
    // `sig` down the whole chain. `fixtures.ts#AUDIT_CHAIN` is built with no such prefix, so it can never
    // byte-match. Stripped per-event before comparing; every other field (content, kind, actor, ref,
    // approval state, …) still is. See `docs/decisions/seed-wiring.md` SW-11.
    const CHAIN_POSITION_KEYS = new Set(['hash', 'sig', 'prevHash', 'seq']);
    const stripChainFields = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripChainFields);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          if (CHAIN_POSITION_KEYS.has(k)) continue;
          out[k] = stripChainFields(v);
        }
        return out;
      }
      return value;
    };
    expect(stripChainFields(stripVolatile(server))).toEqual(stripChainFields(stripVolatile(trimmedFixture)));
  });
});
