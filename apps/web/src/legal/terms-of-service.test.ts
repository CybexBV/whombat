import { describe, expect, it } from 'vitest';
import { LEGAL_PAGES } from './LegalPage';
import { parseLegal } from './legal';
import text from './terms-of-service.md?raw';

describe('the Whombat Terms of Service (AP-166)', () => {
  it('are served and versioned', () => {
    expect(LEGAL_PAGES['/legal/terms']).toBe(text);
    const blocks = parseLegal(text);
    expect(blocks[0]?.type).toBe('quote');
    expect(text).toMatch(/Version `\d{4}-\d{2}-\d{2}`/);
    expect(blocks.filter((b) => b.type === 'heading' && b.level === 1)).toHaveLength(1);
  });

  it('says you decide on remote help, and there is no standing vendor login (RH-11, AP-5679)', () => {
    expect(text).toContain('Version `2026-11-19`');
    expect(text).not.toMatch(/\bowners?\b|\bmembers?\b|\bteam\b/i);
    expect(text).toContain('There is no standing vendor login.');
    expect(text).toContain('(remote help)');
  });

  it('are for people and businesses, with Whombat Link the only thing to pay for (ENV-13)', () => {
    expect(text).toContain('**people and businesses**');
    expect(text).toContain('Whombat Link is the only part of the service you pay for.');
    expect(text).toContain('Prices include VAT.');
    expect(text).toMatch(/consumer\s+law/);
    for (const gone of [/not for consumers/i, /exclude VAT/i, /your organization/i])
      expect(text).not.toMatch(gone);
  });

  it('say the software is AGPL-3.0, and limit only the use of the service', () => {
    expect(text).toContain('## 8. Open source and our rights');
    expect(text).toContain('**nothing in these terms limits the rights it gives you.**');
    expect(text).not.toMatch(/licence check|technical protection/);
  });

  it('no legal page is marked draft or says it awaits review', () => {
    for (const page of Object.values(LEGAL_PAGES)) {
      expect(page).not.toMatch(/DRAFT|-draft|lawyer|legal review|John Pals/);
      expect(page).toMatch(/^> Version `\d{4}-\d{2}-\d{2}`\./);
    }
  });

  it('renders every link, since relative links would fall back to text', () => {
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toMatch(/^(https:\/\/|mailto:)/);
  });
});
