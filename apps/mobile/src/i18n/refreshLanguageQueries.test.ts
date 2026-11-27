import { QueryClient, type QueryKey, QueryObserver } from '@tanstack/query-core';
import { queryKeys } from '@whombat/client/query';
import { api } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { refreshLanguageQueries } from './refreshLanguageQueries';

const params = { burrow: 'home' };

describe('changing the box language', () => {
  it('refetches active server reads and marks other server reads stale', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const active: QueryKey[] = [
      queryKeys.hosts.fleet({ params }),
      queryKeys.hosts.getServer({ params: { ...params, serverId: 'srv_test' } }),
      queryKeys.backups.list({ params }),
      ['whombat', 'backups.overview', params, {}],
      queryKeys.approvals.list({ params }),
      queryKeys.watch.list({ params }),
      queryKeys.looksAhead.get({ params }),
      queryKeys.conversations.list({ params }),
    ];
    const inactive = queryKeys.approvals.get({ params: { ...params, number: 1 } });
    const untouched: QueryKey[] = [
      queryKeys.me.getPreferences(),
      queryKeys.conversations.bootstrap({ params }),
      queryKeys.typing('cnv_test'),
    ];
    let language = 'en';
    const stop = [...active, ...untouched].map((key) => {
      qc.setQueryData(key, language);
      const observer = new QueryObserver(qc, { queryKey: key, queryFn: async () => language });
      return observer.subscribe(() => {});
    });
    qc.setQueryData<unknown>(inactive, language);

    try {
      language = 'nl';
      await refreshLanguageQueries(qc);
      for (const key of active) expect(qc.getQueryData(key), String(key[1])).toBe('nl');
      expect(qc.getQueryState(inactive)?.isInvalidated).toBe(true);
      for (const key of untouched) expect(qc.getQueryData(key), String(key[1])).toBe('en');
    } finally {
      for (const unsubscribe of stop) unsubscribe();
      qc.clear();
    }
  });

  it('invalidates cached server status read outside the endpoint cache', async () => {
    const qc = new QueryClient();
    const key = ['settings', 'appliance-status', 'box-1'];
    qc.setQueryData(key, { backup: 'Failed to back up.' });

    try {
      await refreshLanguageQueries(qc);
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
      qc.clear();
    }
  });

  it('drops saved search cursors and resets Home, Things and Inbox', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const first: QueryKey = queryKeys.endpoint(api.search.query, { params, query: { q: 'server' } });
    const reset: QueryKey[] = [
      queryKeys.endpoint(api.search.query, { params, query: { q: 'server', cursor: 'old' } }),
      queryKeys.home.overview({ params }),
      queryKeys.things.page({ params: { ...params, thing: 'test' } }),
      queryKeys.notifications.inbox({ params }),
    ];
    for (const key of [first, ...reset]) qc.setQueryData(key, 'en');
    const observer = new QueryObserver(qc, { queryKey: first, queryFn: async () => 'nl' });
    const unsubscribe = observer.subscribe(() => {});

    try {
      await refreshLanguageQueries(qc);
      expect(qc.getQueryData(first)).toBe('nl');
      for (const key of reset) expect(qc.getQueryData(key), String(key[1])).toBeUndefined();
    } finally {
      unsubscribe();
      qc.clear();
    }
  });
});
