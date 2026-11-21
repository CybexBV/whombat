import { SUBSCRIPTION_TERMS_VERSION } from '@whombat/control-contracts';
import { LINK_PRICE_TEXT, LINK_PRICE_YEAR_TEXT, LINK_TRIAL_BOXES_MAX } from '@whombat/protocol';
import { describe, expect, it } from 'vitest';
import { LEGAL_PAGES } from './LegalPage';
import { parseLegal } from './legal';
import text from './subscription-terms.md?raw';

describe('the Whombat Subscription Terms (BL-24, AP-128, ENV-13)', () => {
  it('are served and name the version the app sends', () => {
    expect(LEGAL_PAGES['/legal/subscription-terms']).toBe(text);
    const blocks = parseLegal(text);
    expect(blocks[0]?.type).toBe('quote');
    expect(SUBSCRIPTION_TERMS_VERSION).toBe('2026-11-19');
    expect(text).toContain(`Version \`${SUBSCRIPTION_TERMS_VERSION}\``);
    expect(blocks.find((b) => b.type === 'heading' && b.level === 1)).toBeTruthy();
  });

  it('sell Whombat Link at the contracts’ prices with VAT, to people and businesses', () => {
    expect(text).toContain(
      `**${LINK_PRICE_TEXT} or ${LINK_PRICE_YEAR_TEXT} for each Whombat**, VAT included`,
    );
    expect(text).toContain('**first month is free');
    expect(text).toContain(`${['one', 'two', 'three'][LINK_TRIAL_BOXES_MAX - 1]} Whombats`);
    expect(text).toContain('**cancel at any time**');
    expect(text).toContain('14 days of your first payment');
    expect(text).toContain('**one more week.**');
    expect(text).toContain('**Nothing is deleted.**');
    expect(text).toMatch(/consumer\s+law/);
    // The business plan went with Whombat Link.
    for (const gone of [
      /€49/,
      /reverse/i,
      /businesses only/i,
      /excluding VAT/i,
      /14 days\*\*/,
      /\borganization\b/i,
    ])
      expect(text).not.toMatch(gone);
    expect(text).not.toMatch(/\bowners?\b|\bmembers?\b/i);
  });

  it('change the price only from the next payment when a Whombat is added or removed: no prorating', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('the new price applies from your next payment');
    expect(flat).toContain('nothing is paid back for the month or year');
    expect(flat).not.toMatch(/prorat|the difference|comes off your next payment/i);
  });

  it('are with Cybex BV, pay for the service, and the software works without Link', () => {
    expect(text).toContain('**Cybex BV**');
    expect(text).toContain('AGPL-3.0');
    expect(text).toContain('Tailscale or Headscale');
  });

  it('renders every link, since relative links would fall back to text', () => {
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toMatch(/^(https:\/\/|mailto:)/);
  });
});
