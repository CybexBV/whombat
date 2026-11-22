import { APPLIANCE_TERMS_VERSION } from '@whombat/control-contracts';
import { describe, expect, it } from 'vitest';
import text from './appliance-terms.md?raw';
import { LEGAL_PAGES } from './LegalPage';

describe('the Whombat Appliance Terms (LC-17, LC-20)', () => {
  it('are served and name the version a claim sends', () => {
    expect(LEGAL_PAGES['/legal/appliance-terms']).toBe(text);
    expect(APPLIANCE_TERMS_VERSION).toBe('2026-11-22');
    expect(text).toContain(`Version \`${APPLIANCE_TERMS_VERSION}\``);
  });

  it('say the software is AGPL-3.0 and the subscription pays for the service, from Cybex BV', () => {
    expect(text).toContain('**Cybex BV**');
    expect(text).toContain('GNU Affero General Public License');
    expect(text).toContain('**Nothing in these terms limits the rights the AGPL-3.0 gives you.**');
    expect(text).toContain('## 9. Using the service fairly');
    expect(text).toContain('(registration\npending)');
    for (const ban of [
      /reverse engineer/i,
      /decompile/i,
      /licensed, not sold/i,
      /copy the appliance software/i,
    ])
      expect(text).not.toMatch(ban);
  });

  it('say the Whombat works without Whombat Link, for people and businesses (ENV-13)', () => {
    expect(text).toContain('**works fully without Whombat Link**');
    expect(text).toContain('Tailscale or Headscale');
    expect(text).toContain('**Production**');
    expect(text).toContain('**Beta**');
    expect(text).toContain('**Ask before updating**');
    expect(text).toMatch(/consumer\s+law/);
    for (const gone of [/organization's/i, /licence\b.*14 days/i, /features .* pause/i, /can't postpone/i])
      expect(text).not.toMatch(gone);
  });

  it('say remote help is off unless you turn it on, recorded and stoppable (RH-11)', () => {
    expect(text).toContain('## 7. Remote help');
    expect(text).not.toContain('no remote access');
    expect(text).toContain('**no standing vendor login**');
    expect(text).toContain('**stop remote help at');
    expect(text).toContain('your consent to that visit');
  });

  it('are for one person’s device, with no member limit (CT-1563, AP-5679)', () => {
    expect(text).toContain("**one person's device**");
    expect(text).not.toMatch(/\bowners?\b|\bmembers?\b|\bteam\b/i);
  });

  it('name the seller, install Claude Code from Anthropic and list only the keys a Whombat has', () => {
    for (const fact of ['James Cookstraat 12G', 'KvK\n77711815', 'NL861104432B01'])
      expect(text).toContain(fact);
    expect(text).toContain('straight from Anthropic');
    expect(text).not.toContain('comes through the same update channel');
    expect(text).not.toContain('disk recovery key');
    expect(text).toContain('**passkey**');
    expect(text).toContain('**recovery kit**');
  });

  it('carry the Dutch voice’s use restrictions as Attachment A', () => {
    expect(text).toContain('## Attachment A.');
    expect(text).toContain('Open RAIL-M');
    for (const item of ['(a) ', '(g) ', '(m) ']) expect(text).toContain(item);
  });
});
