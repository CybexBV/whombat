/**
 * Dynamic type (README "Accessibility"): every piece of text renders through the shared `<Text>`
 * (`theme/Text.tsx`), which caps `maxFontSizeMultiplier` so a user's largest system font sizes scale
 * text without breaking layouts (`numberOfLines` truncates gracefully, containers use `flex`/percentage
 * widths rather than fixed heights around text). These are static regressions: a screen that imports RN's
 * own `Text` bypasses the cap, and rows that fix a pixel height around text will clip at larger sizes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../', import.meta.url);

/** Every `.tsx` under `src/`, except stories and tests. */
function allComponentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...allComponentFiles(`${rel}/`));
    else if (rel.endsWith('.tsx') && !rel.includes('.stories.') && !rel.includes('/test/')) out.push(rel);
  }
  return out;
}

describe('dynamic type', () => {
  it('caps how far the shared Text component scales with the system font size', () => {
    const source = readFileSync(new URL('theme/Text.tsx', SRC), 'utf8');
    const m = /maxFontSizeMultiplier=\{(\d+(?:\.\d+)?)\}/.exec(source);
    expect(m, 'theme/Text.tsx should set maxFontSizeMultiplier').not.toBeNull();
    const cap = Number(m?.[1]);
    // Large enough that Accessibility Settings' biggest sizes still grow text; capped so a doubled-plus
    // system size cannot break card/row layouts sized for the default scale.
    expect(cap).toBeGreaterThan(1);
    expect(cap).toBeLessThanOrEqual(2);
  });

  it('fixes no pixel height around text in the parity screens (MQ-01…MQ-06) and Settings → Agent: rows grow with the font', () => {
    const files = [
      'screens/ServicesSection.tsx',
      // The assistant's parts and Advanced's (AP-4961): schedules, notes, always-allowed commands, what it may do.
      'screens/agent/NotesSection.tsx',
      'screens/agent/KeysPart.tsx',
      'screens/agent/MayPart.tsx',
      'settings/AdvancedScreens.tsx',
      'screens/SpendScreen.tsx',
      'screens/AuditLogScreen.tsx',
      'ui/facts.tsx',
      'screens/CanvasScreen.tsx',
      'screens/DeploysPanel.tsx',
      'screens/DeploysScreen.tsx',
      // The shell (phone-shell-final.md): Places, the row above the tabs and Search grow with the text.
      'ui/places.tsx',
      'ui/topRow.tsx',
      'screens/SearchScreen.tsx',
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(file, SRC), 'utf8');
      // `height: n` sizes a box; `minHeight` lets it grow. Avatars and the picker's 24dp tick hold no text.
      for (const m of source.matchAll(/[^a-zA-Z]height:\s*(\d+)/g))
        if (Number(m[1]) > 24) offenders.push(`${file}: height ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never imports react-native’s own Text (it would skip the scaling cap)', () => {
    const offenders: string[] = [];
    for (const file of allComponentFiles('')) {
      if (file === 'theme/Text.tsx') continue;
      const source = readFileSync(new URL(file, SRC), 'utf8');
      const imports = /import\s*\{([^}]*)\}\s*from\s*'react-native'/.exec(source);
      if (!imports) continue;
      const names = imports[1]?.split(',').map((s) => s.trim().replace(/^type\s+/, ''));
      if (names?.includes('Text')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
