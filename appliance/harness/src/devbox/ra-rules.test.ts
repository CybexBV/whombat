import { describe, expect, it } from 'vitest';
import {
  dutchScore,
  invoiceFigures,
  questionsIn,
  raCheckTimeoutMs,
  selectedScenarios,
  spendCache,
  spendDelta,
} from './ra-rules.ts';

describe('dev/devbox ra-check’s judgements', () => {
  it('tells a Dutch answer from an English one', () => {
    expect(dutchScore('SSH gebruikt standaard poort 22.').isDutch).toBe(true);
    expect(dutchScore('Natuurlijk, vanaf nu antwoord ik je in het Nederlands.').isDutch).toBe(true);
    expect(dutchScore('SSH uses port 22 by default.').isDutch).toBe(false);
    expect(dutchScore('22').isDutch).toBe(false);
  });

  it('finds the questions outside code', () => {
    expect(questionsIn('Done. Which port should I use? I can also add TLS.')).toEqual([
      'Which port should I use?',
    ]);
    expect(questionsIn('Run `curl x?` and see:\n```\nwhy?\n```\nAll good.')).toEqual([]);
  });

  it('reads the invoice’s figures in either notation', () => {
    expect(invoiceFigures('Invoice 4711, total € 99,50')).toEqual({ number: true, total: true });
    expect(invoiceFigures('Factuurnummer 4711; totaal EUR 99.50')).toEqual({ number: true, total: true });
    expect(invoiceFigures('Invoice 47110, total 199,50')).toEqual({ number: false, total: false });
  });

  it('picks scenarios by name and times the run by them', () => {
    expect(selectedScenarios(undefined)).toHaveLength(7);
    // No scenario hands work to another agent or asks who runs what (Whombat one-agent.md OA-06).
    expect(() => selectedScenarios('handoff')).toThrow(/handoff/);
    // Nothing is published from an agent's computer any more (Whombat one-person.md OP-04, OP-19).
    expect(() => selectedScenarios('port')).toThrow(/port/);
    expect(selectedScenarios('ocr, learn')).toEqual(['learn', 'ocr']);
    expect(() => selectedScenarios('learn,dance')).toThrow(/dance/);
    expect(raCheckTimeoutMs({ WB_RA_ONLY: 'lan', WB_RA_SCENARIO_MINUTES: '10' })).toBe(30 * 60_000);
  });

  it('counts what a scenario used from two spend snapshots', () => {
    const before = {
      turns: 2,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: null,
    };
    const after = {
      turns: 4,
      inputTokens: 1100,
      outputTokens: 60,
      costUsd: null,
    };
    expect(spendDelta(before, after)).toEqual({
      turns: 2,
      inputTokens: 1000,
      outputTokens: 50,
      costUsd: null,
    });
    expect(Object.keys(spendDelta(before, after))).not.toContain('cacheReadTokens');
  });

  it('counts the prompt cache’s share once the runtime reports it (Whombat PE-04, PE-12)', () => {
    // Before: older turns only, no split in the window yet. After: a 0.44.1 runtime's turns with one.
    const before = {
      turns: 2,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: null,
    };
    const after = {
      turns: 5,
      inputTokens: 1100,
      outputTokens: 60,
      ...spendCache({
        cacheReadTokens: 700,
        cacheWriteTokens: 0,
        cacheResults: { hit: 1, expired: 0, miss: 0 },
      }),
      costUsd: null,
    };
    expect(spendDelta(before, after)).toEqual({
      turns: 3,
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 700,
      cacheWriteTokens: 0,
      uncachedInputTokens: 300,
      cacheResults: { hit: 1, expired: 0, miss: 0 },
      costUsd: null,
    });
    // Both windows with a split: only what was added between them.
    const later = {
      ...after,
      turns: 6,
      inputTokens: 1600,
      outputTokens: 70,
      ...spendCache({
        cacheReadTokens: 1100,
        cacheWriteTokens: 50,
        cacheResults: { hit: 1, expired: 1, miss: 0 },
      }),
    };
    expect(spendDelta(after, later)).toMatchObject({
      inputTokens: 500,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      uncachedInputTokens: 50,
      cacheResults: { hit: 0, expired: 1, miss: 0 },
    });
    expect(spendCache({})).toEqual({});
  });
});
