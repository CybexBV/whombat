import { describe, expect, it } from 'vitest';
import { LEGAL_PAGES } from './LegalPage';
import { parseLegal } from './legal';
import text from './privacy-policy.md?raw';

describe('the Whombat Privacy Policy (AP-165)', () => {
  it('is served and versioned', () => {
    expect(LEGAL_PAGES['/legal/privacy']).toBe(text);
    const blocks = parseLegal(text);
    expect(blocks[0]?.type).toBe('quote');
    expect(text).toMatch(/Version `\d{4}-\d{2}-\d{2}`/);
    expect(blocks.filter((b) => b.type === 'heading' && b.level === 1)).toHaveLength(1);
  });

  it('says what the Feedback widget keeps (AP-436)', () => {
    expect(text).toContain('pages the visitor opened on that website before reporting: at most 10');
    expect(text).toContain('keyed hash of it');
    expect(text).toContain('encrypted under the visitor');
    expect(text).toContain('never the text of');
    expect(text).toContain('sign-ins after 30 days');
    // Section 7 names both keys the widget uses.
    expect(text).toContain('`whombat-feedback:trail`');
    expect(text).toContain('`whombat-feedback:` followed by the site');
  });

  it('says a notification shows a preview, through our servers, and how to turn it off (AP-810)', () => {
    expect(text).toContain('The one exception is the short preview a notification shows');
    expect(text).toContain('We pass the preview on without storing or logging it.');
    expect(text).toContain('Settings → Notifications (“Show message text in notifications”)');
    expect(text).not.toContain('never contains your content');
  });

  it('is version 2026-11-23 and says remote help is there only while you allow it (RH-11, AP-5679)', () => {
    expect(text).toContain('Version `2026-11-23`');
    expect(text).not.toMatch(/\bowners?\b|\bmembers?\b|\broles?\b/i);
    expect(text).not.toContain('no remote access');
    expect(text).toContain('no standing vendor login');
    expect(text).toContain('**Look and fix**');
    expect(text).toContain('for 90 days');
    expect(text).toContain('stop it at any time');
  });

  it('names the controller and the services a Whombat talks to itself', () => {
    for (const fact of ['James Cookstraat 12G', 'KvK', '77711815', 'NL861104432B01'])
      expect(text).toContain(fact);
    for (const party of [
      '**GitHub**',
      '**Anthropic**',
      "**Let's Encrypt**",
      '**Certificate Transparency logs**',
      '**Cert Spotter**',
      '**Hugging Face**',
    ])
      expect(text).toContain(party);
  });

  it('says what control keeps for Whombat Link and how push reaches the phones (ENV-13)', () => {
    expect(text).toContain('**Whombat Link.**');
    expect(text).toContain('`<name>.whombat.app`');
    expect(text).toContain('16 February 2027');
    expect(text).toContain('whether you pay by the month or by the year');
    expect(text).toContain('a promotion code you');
    expect(text).toContain('Apple Push Notification service');
    expect(text).toContain('our door');
    expect(text).toContain('which Whombat you opened last');
    expect(text).not.toMatch(/your organization/i);
  });

  it('renders every link, since relative links would fall back to text', () => {
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toMatch(/^(https:\/\/|mailto:)/);
  });

  it('says where addresses are still seen or kept: Cloudflare, the network hashes, the server login log', () => {
    expect(text).toContain('**Cloudflare, Inc.**');
    expect(text).toContain("visitors' IP addresses");
    expect(text).toContain('keyed hash of the network you accepted them');
    expect(text).toContain('**Rate-limit counters:** 2 days');
    expect(text).toContain('login log');
    expect(text).toContain('up to 35 days');
  });
});
