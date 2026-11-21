import { describe, expect, it } from 'vitest';
import { createSkillLibraryWorld } from '../skillLibrary/fixtures';
import { enabledSkillsOf } from './skills';

describe('the skills the composer offers (SL-09; AP-5206, AP-5525)', () => {
  const library = createSkillLibraryWorld({
    agentName: 'Neo',
    now: Date.parse('2026-10-21T12:00:00Z'),
  }).library();
  const skills = enabledSkillsOf(library);
  const names = skills.map((s) => s.name);

  it('offers each name once, the learned ones too', () => {
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('menerga-heat-pump');
    expect(names).toContain('weekly-review-planning');
  });

  it('leaves out what is off or removed, and says what one needs', () => {
    expect(names).not.toContain('claude-code');
    expect(names).not.toContain('gif-search');
    expect(names).toContain('canvas');
    expect(skills.find((s) => s.name === 'notion')?.needs).toEqual(['Needs NOTION_API_KEY']);
  });
});
