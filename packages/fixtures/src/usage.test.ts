/** Subscription usage in the mock world (contracts CT-153, CT-154): the fixtures parse and the fixture fetch serves them. */
import { api } from '@whombat/core/contracts';
import { SubscriptionUsage } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createFixtureFetch } from './fetch.js';
import { USAGE_SNAPSHOTS, usageList } from './usage.js';

const BASE = 'http://fixtures.local/api/v1';

describe('usage fixtures', () => {
  it('parse', () => {
    for (const s of USAGE_SNAPSHOTS) expect(SubscriptionUsage.parse(s)).toEqual(s);
    expect(usageList().mine).toHaveLength(USAGE_SNAPSHOTS.length);
  });

  it('are served by createFixtureFetch()', async () => {
    const f = createFixtureFetch();
    const res = await f(`${BASE}/burrows/burrow-hq/usage`);
    expect(res.status).toBe(200);
    const list = api.usage.list.response.parse(await res.json());
    expect(list.mine.map((s) => s.provider)).toEqual(['claude', 'codex']);
    expect(list).not.toHaveProperty('everyone');
    const refresh = await f(`${BASE}/burrows/burrow-hq/usage/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(api.usage.refresh.response.parse(await refresh.json()).usage.source).toBe('probe');
  });
});
