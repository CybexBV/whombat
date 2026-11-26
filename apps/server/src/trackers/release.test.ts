import { describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../connections/types';
import type { trackerFixes } from '../db/schema/index';
import type { BoundDriver } from './drivers';
import {
  hasReleaseTargets,
  releaseBrief,
  releaseReporters,
  releasesForAll,
  releasesStraightAway,
} from './release';

type FixRow = typeof trackerFixes.$inferSelect;

function connection(releaseFor?: string): CatalogConnectionRow {
  return {
    id: 'con_prod',
    burrowId: 'bur_1',
    catalogId: 'tracker',
    label: 'Whombat Production',
    handle: 'whombat-prod',
    baseUrl: 'https://reports.example.com',
    fields: releaseFor === undefined ? {} : { releaseFor },
  } as unknown as CatalogConnectionRow;
}

function fix(overrides: Partial<FixRow> = {}): FixRow {
  return {
    id: 'tfx_1',
    burrowId: 'bur_1',
    connectionId: 'con_prod',
    reportId: 'rep_2',
    number: 2,
    runId: 'run_1',
    stepIdx: 5,
    automationId: 'aut_1',
    repo: 'acme/product',
    prNumber: 12,
    prUrl: 'https://github.com/acme/product/pull/12',
    kind: 'bug',
    language: 'en',
    signature: '',
    state: 'merged',
    mergeSha: 'abcdef123456',
    mergedAt: new Date('2026-11-26T10:00:00Z'),
    release: null,
    ...overrides,
  } as unknown as FixRow;
}

function fakeDriver(email: string | null): BoundDriver {
  return {
    item: vi.fn(async () => ({ reporter: { name: null, email } })),
  } as unknown as BoundDriver;
}

describe('tracker straight-to-production release matching and brief', () => {
  it('recognises "*" for all reporters alongside comma-separated emails', () => {
    expect(releasesForAll({ releaseFor: '*' })).toBe(true);
    expect(releasesForAll({ releaseFor: ' * ' })).toBe(true);
    expect(releasesForAll({ releaseFor: 'ann@example.com' })).toBe(false);
    expect(releasesForAll({})).toBe(false);

    expect(hasReleaseTargets({ releaseFor: '*' })).toBe(true);
    expect(hasReleaseTargets({ releaseFor: 'ann@example.com' })).toBe(true);
    expect(hasReleaseTargets({ releaseFor: '' })).toBe(false);
    expect(releaseReporters({ releaseFor: '*' })).toEqual([]);
  });

  it('releases bug fixes for "*" without needing a reporter email', async () => {
    const driver = fakeDriver(null);
    await expect(releasesStraightAway(driver, connection('*'), fix(), 'production')).resolves.toBe(true);
    // No tracker lookup is needed when `*` covers every bug report.
    expect(driver.item).not.toHaveBeenCalled();

    // Features and development trackers still do not auto-release.
    await expect(
      releasesStraightAway(driver, connection('*'), fix({ kind: 'feature' }), 'production'),
    ).resolves.toBe(false);
    await expect(releasesStraightAway(driver, connection('*'), fix(), 'development')).resolves.toBe(false);

    // Email lists still require a matching reporter email.
    await expect(
      releasesStraightAway(driver, connection('ann@example.com'), fix(), 'production'),
    ).resolves.toBe(false);
    expect(driver.item).toHaveBeenCalledTimes(1);
  });

  it('writes a clear brief both from development and straight from merge', () => {
    const fromDev = releaseBrief({
      repo: 'acme/product',
      revision: 'abcdef123456',
      product: 'Product',
      host: 'dev.example.com',
      version: '1.2.3',
      prUrl: 'https://github.com/acme/product/pull/12',
      prNumber: 12,
      mergeSha: 'abcdef123456',
    });
    expect(fromDev).toContain('abcdef123456');
    expect(fromDev).toContain('dev.example.com runs it');
    expect(fromDev).toContain('Released:');

    const fromMerge = releaseBrief({
      repo: 'acme/product',
      revision: 'abcdef123456',
      product: 'Product',
      host: 'beta.example.com',
      version: '1.2.2',
      prUrl: 'https://github.com/acme/product/pull/12',
      prNumber: 12,
      mergeSha: 'abcdef123456',
      allReporters: true,
      fromMerge: true,
    });
    expect(fromMerge).toContain('abcdef123456');
    expect(fromMerge).toContain('bug fixes for this tracker');
    expect(fromMerge).toContain('does not run this fix yet');
    expect(fromMerge).toContain('development or beta');
    expect(fromMerge).toContain('Released:');
  });
});
