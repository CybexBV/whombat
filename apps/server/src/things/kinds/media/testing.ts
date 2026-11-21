/**
 * The media kinds' tests: recorded answers (`fixtures/`, trimmed from SABnzbd 5.1.3, NZBHydra2 9.1.1, Sonarr 4.0.20,
 * Radarr 6.4.4, Seerr 3.5.1 and Plex Media Server 1.43.5 in throwaway containers on 2026-10-21; Sonarr's and Radarr's
 * history and update, and NZBHydra2 9.2.0's week of grabs from a fake indexer, on 2026-11-04; no keys, no personal data), a connection row, and what a fake `signedConnectionFetch` was asked (the tests mock it).
 */
import { readFileSync } from 'node:fs';
import type { CatalogConnectionRow } from '../../../connections/types';

/** A recorded answer by file name (`sab-queue.json`). */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

/** A connection row of `catalogId` for pure tests. */
export function rowOf(catalogId: string, more: Partial<CatalogConnectionRow> = {}): CatalogConnectionRow {
  return {
    id: `con_${catalogId}_test`,
    catalogId,
    label: catalogId,
    baseUrl: 'http://192.0.2.10:8080',
    fields: { url: 'http://192.0.2.10:8080' },
    access: 'manage',
    status: 'active',
    scope: 'shared',
    credentialVersion: 1,
    updatedAt: new Date('2026-10-21T10:00:00Z'),
    ...more,
  } as unknown as CatalogConnectionRow;
}

/** What a fake connection fetch was asked, and how it answers. */
export interface FakeCall {
  method: string;
  url: URL;
  body: string | null;
}

/** A fake answer: status and JSON. */
export type FakeAnswer = { status?: number; json?: unknown; text?: string };
