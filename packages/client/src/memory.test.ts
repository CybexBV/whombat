import { MEMORY_ENTRY_SEPARATOR } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { ApiError } from './http/errors';
import {
  memoryEntryFits,
  memoryFileEntries,
  memoryUsage,
  memoryWithEdit,
  memoryWithEntry,
  memoryWithout,
  memoryWriteProblem,
} from './memory';

const view = {
  text: ['Prefers short answers.', 'Works on billing.'].join(MEMORY_ENTRY_SEPARATOR),
  used: 40,
  limit: 1375,
};

describe('memory entries as people change them (HE-39, CT-1201; AP-5209)', () => {
  it('adds, edits and removes one entry, keeping Hermes’s separator', () => {
    expect(memoryFileEntries({ text: memoryWithEntry(view, ' Lives in Utrecht. ') })).toEqual([
      'Prefers short answers.',
      'Works on billing.',
      'Lives in Utrecht.',
    ]);
    expect(memoryWithEdit(view, 1, 'Works on billing and the office.')).toContain(MEMORY_ENTRY_SEPARATOR);
    expect(memoryFileEntries({ text: memoryWithEdit(view, 0, '  ') })).toEqual(['Works on billing.']);
    expect(memoryFileEntries({ text: memoryWithout(view, 0) })).toEqual(['Works on billing.']);
  });

  it('says how full a file is, amber from 90 % and red over its limit', () => {
    expect(memoryUsage({ used: 1240, limit: 2200 })).toMatchObject({
      text: '1,240 of 2,200 characters',
      tone: 'ok',
    });
    expect(memoryUsage({ used: 2000, limit: 2200 }).tone).toBe('warn');
    expect(memoryUsage({ used: 2300, limit: 2200 })).toMatchObject({ tone: 'bad', fraction: 1 });
    expect(memoryEntryFits({ text: view.text, limit: 60 }, 'x'.repeat(40))).toBe(false);
  });

  it('words a refused write: the agent’s change, else the server’s sentence', () => {
    const conflict = new ApiError(409, 'conflict', 'Changed.', null, 'memory.write');
    const busy = new ApiError(
      409,
      'conflict',
      'Neo is working for you right now.',
      null,
      'memory.write',
      {},
      {
        reason: 'busy',
      },
    );
    expect(memoryWriteProblem(conflict, 'CHANGED')).toBe('CHANGED');
    expect(memoryWriteProblem(busy, 'CHANGED')).toContain('working');
    expect(memoryWriteProblem(new Error('x'), 'CHANGED')).toContain('Try again');
  });
});
