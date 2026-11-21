import { describe, expect, it } from 'vitest';
import { PROMPT_CACHE_LONG_TTL_MS, PROMPT_CACHE_TTL_MS, personPacedTrigger, promptCacheTtlMs } from './cache';

describe('prompt cache rules (prompt-efficiency.md PE-DR10, PE-12)', () => {
  it('a person-paced Claude turn’s cache lives an hour; everything else five minutes', () => {
    for (const trigger of ['mention', 'dm', 'expand', 'search']) {
      expect(personPacedTrigger(trigger)).toBe(true);
      expect(promptCacheTtlMs('claude', trigger)).toBe(PROMPT_CACHE_LONG_TTL_MS);
      // Codex 0.157 has no lifetime switch.
      expect(promptCacheTtlMs('codex', trigger)).toBe(PROMPT_CACHE_TTL_MS);
    }
    for (const trigger of ['schedule', 'reflect', 'retry', 'automation', null, undefined]) {
      expect(personPacedTrigger(trigger)).toBe(false);
      expect(promptCacheTtlMs('claude', trigger)).toBe(PROMPT_CACHE_TTL_MS);
    }
    expect(PROMPT_CACHE_LONG_TTL_MS).toBe(3_600_000);
    expect(PROMPT_CACHE_TTL_MS).toBe(300_000);
  });
});
