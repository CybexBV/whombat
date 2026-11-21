import { ALL_ENDPOINTS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { isApplianceLocalPath } from './lib/local-paths';
import { ROUTES } from './routes/index';
import { useTestServer } from './test/harness';

const t = useTestServer({ app: true });

describe('server', () => {
  it('runs against its own migrated throwaway database', async () => {
    const [row] = await t.services.sql<{ db: string }[]>`select current_database() as db`;
    expect(row?.db).toMatch(/^whombat_test_[0-9a-f]{12}$/);
    const [migrations] = await t.services.sql`select to_regclass('drizzle.__drizzle_migrations') as t`;
    expect(migrations?.t).not.toBeNull();
  });

  it('handles every endpoint of the contract but health; the loopback listener serves only the runner’s', async () => {
    const handled = new Set(ROUTES.filter((r) => r.stub === undefined).map((r) => r.endpoint.id));
    expect(ALL_ENDPOINTS.filter((ep) => !handled.has(ep.id)).map((ep) => ep.id)).toEqual(['health.get']);
    for (const ep of ALL_ENDPOINTS) {
      const path = `${ep.base}${ep.path}`;
      expect(t.app.hasRoute({ method: ep.method, url: path }), ep.id).toBe(isApplianceLocalPath(path));
    }
    // Uploads landed with Workstream A: validated, not 501.
    const res = await t.api.inject({ method: 'POST', url: '/api/v1/burrows/burrow-hq/uploads', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('answers unknown routes with a contract error body', async () => {
    const res = await t.api.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
