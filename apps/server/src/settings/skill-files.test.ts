import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ASSISTANT_SETTINGS, assistantSettingsSkill } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';

const dir = resolve(
  import.meta.dirname,
  '../../../../packages/hermes-whombat/whombat_hermes/skills/settings',
);

function onDisk(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

describe('the whombat:settings skill', () => {
  it('is what the settings map writes (pnpm assistant-settings:gen)', () => {
    expect(onDisk(dir)).toEqual(assistantSettingsSkill(ASSISTANT_SETTINGS));
  });

  it('names the tools and the Wi-Fi way, and every page', () => {
    const files = assistantSettingsSkill(ASSISTANT_SETTINGS);
    const skill = files['SKILL.md'] ?? '';
    for (const fact of [
      'settings_find',
      'settings_change',
      'settings_open',
      'host.cable.set',
      'name: settings',
    ])
      expect(skill).toContain(fact);
    expect(Object.keys(files)).toContain('references/this-whombat.md');
    expect(files['references/this-whombat.md']).toContain('`host.cable.set`');
  });
});
