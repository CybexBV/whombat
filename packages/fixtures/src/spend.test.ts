/** Spend in the mock world (Whombat spend.md): the fixtures parse, add up, and the fixture fetch serves them. */
import { api } from '@whombat/core/contracts';
import { formatTokenCount, SpendOverview, spendLine, spendTokens } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createFixtureFetch } from './fetch.js';
import { SPEND_TURNS, spendOverview, spendWeek } from './spend.js';

const BASE = 'http://fixtures.local/api/v1';

describe('spend fixtures', () => {
  const overview = spendOverview();

  it('parse, and count every turn (one person: no rows by person, CT-1513)', () => {
    expect(SpendOverview.parse(overview)).toEqual(overview);
    expect(overview).not.toHaveProperty('byPerson');
    expect(overview.totals.month.turns).toBe(SPEND_TURNS.length);
    expect(overview.totals.month.unreportedTurns).toBe(2);
    expect(overview.plans.map((p) => p.planId)).toEqual(['pln_invoice-pdf']);
  });

  it('have plausible numbers: millions of tokens a month, a few dollars a day', () => {
    expect(formatTokenCount(spendTokens(overview.totals.month))).toMatch(/^\d+(\.\d)?M$/);
    const week = spendWeek();
    expect(week.week).toEqual(overview.totals.week);
    expect(spendLine(week.week)).toMatch(/^This week: [\d.]+[kM] tokens · about \$[\d,]+\.\d\d$/);
  });

  it('are served by createFixtureFetch()', async () => {
    const f = createFixtureFetch();
    const res = await f(`${BASE}/burrows/burrow-hq/spend`);
    expect(res.status).toBe(200);
    expect(api.spend.overview.response.parse(await res.json()).totals.month.turns).toBe(SPEND_TURNS.length);
    const week = await f(`${BASE}/burrows/burrow-hq/spend/week`);
    expect(api.spend.week.response.parse(await week.json()).week.turns).toBeGreaterThan(0);
    const host = await f(`${BASE}/burrows/burrow-hq/host`);
    expect(api.host.info.response.parse(await host.json()).services.available).toBe(true);
    const services = await f(`${BASE}/burrows/burrow-hq/agent/services`);
    const list = api.services.list.response.parse(await services.json());
    expect(list.services.map((s) => [s.name, s.port, s.state])).toEqual([
      ['invoice-preview', 20_001, 'running'],
      ['grafana', 20_002, 'stopped'],
    ]);
    const stop = await f(`${BASE}/burrows/burrow-hq/agent/services/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: list.services[0]?.id }),
    });
    expect(api.services.stop.response.parse(await stop.json()).service.state).toBe('stopped');
  });
});
