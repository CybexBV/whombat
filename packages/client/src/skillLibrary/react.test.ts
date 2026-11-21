import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { endpointKey } from '../query/keys';
import { skillLibraryEndpoints as E, type SkillLibrary } from './contract';
import { createSkillLibraryWorld } from './fixtures';
import { applySkillItem } from './react';

const NOW = Date.parse('2026-10-24T12:00:00Z');

function cached() {
  const qc = new QueryClient();
  const world = createSkillLibraryWorld({ agentName: 'Neo', now: NOW });
  const key = endpointKey(E.library, { params: { burrow: 'b' } });
  qc.setQueryData(key, world.library());
  const library = () => qc.getQueryData(key) as SkillLibrary;
  return { qc, world, library };
}

describe('the cached library by name (CT-1571, AP-5658)', () => {
  it('has one row per name', () => {
    const names = cached()
      .library()
      .items.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('puts a write’s row in the place of the row of that name, and adds a new one', () => {
    const { qc, library } = cached();
    const xlsx = library().items.find((i) => i.name === 'xlsx');
    if (!xlsx) throw new Error('missing xlsx');
    applySkillItem(qc, 'b', { ...xlsx, changed: true });
    expect(library().items.filter((i) => i.name === 'xlsx')).toHaveLength(1);
    expect(library().items.find((i) => i.name === 'xlsx')?.changed).toBe(true);
    applySkillItem(qc, 'b', { ...xlsx, name: 'xlsx-copy' });
    expect(library().items.some((i) => i.name === 'xlsx-copy')).toBe(true);
  });
});
