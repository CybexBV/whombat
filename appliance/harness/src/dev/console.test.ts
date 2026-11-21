import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { consoleSummary, readConsoleState } from './console.ts';
import { type ClaimCard, claimCardText } from './provision.ts';

describe('dev console (CC-11, IN-33)', () => {
  const dir = mkdtempSync(join(TMP_DIR, 'wb-console-'));
  const file = (name: string, body: string) => {
    const f = join(dir, name);
    writeFileSync(f, body);
    return f;
  };

  it('reads the state file leniently and summarizes it', () => {
    expect(readConsoleState(join(dir, 'missing.json'))).toBeNull();
    expect(readConsoleState(file('bad.json', 'nope'))).toBeNull();
    expect(readConsoleState(file('v2.json', '{"v":2,"state":"waiting","url":"x"}'))).toBeNull();
    const s = readConsoleState(
      file('ok.json', '{"v":1,"state":"claimable","code":"KXQM","url":"http://localhost:5190/claim"}'),
    );
    expect(consoleSummary(s)).toBe('KXQM — open localhost:5190/claim and enter it (dev/console)');
    expect(consoleSummary(null)).toMatch(/^no state yet/);
    expect(consoleSummary({ v: 1, state: 'waiting', url: 'x' })).toMatch(/^waiting for control/);
    expect(consoleSummary({ v: 1, state: 'backoff', url: 'x', retryAt: 1790424270 })).toBe(
      'too many wrong codes, again at 2026-09-26T12:04:30.000Z',
    );
    expect(consoleSummary({ v: 1, state: 'claimed', url: 'x' })).toBe('claimed');
  });

  it('says Whombat Link’s code first while Link starts, then the claim letters', () => {
    const starting = {
      v: 1 as const,
      state: 'claimable' as const,
      code: 'KXQM',
      url: 'http://localhost:4621/',
      reach: { link: { state: 'starting', code: 'ABCD-EFGH', url: 'https://localhost:5190/link' } },
    };
    expect(consoleSummary(starting)).toBe(
      'Whombat Link code ABCD-EFGH — open localhost:5190/link and enter it (dev/console)',
    );
    expect(consoleSummary({ ...starting, reach: { link: { state: 'on' } } })).toBe(
      'KXQM — open localhost:4621/ and enter it (dev/console)',
    );
  });

  it('claim card text: the printed card’s words, no fingerprint (CC-02)', () => {
    const card: ClaimCard = {
      v: 1,
      deviceId: 'wb-1',
      peerId: '12D3KooWx',
      fingerprint: 'AAAAA-BBBBB',
      claimSecret: 'ABCDEFGH',
      claimSecretDisplay: 'ABCD-EFGH',
      claimUrl: 'http://localhost:5190/claim#v=1&d=wb-1&p=12D3KooWx&s=ABCDEFGH',
      environment: 'local',
    };
    const t = claimCardText(card, 'http://localhost:5190/claim');
    expect(t).toContain('Scan the code, or open localhost:5190/claim and choose “Claim with a card”:');
    expect(t).toContain('Appliance ID   wb-1');
    expect(t).toContain('Claim code     ABCD-EFGH');
    expect(t).toContain(
      'Keep this card private. Anyone with the claim code can claim this appliance until you do.',
    );
    expect(t).not.toMatch(/fingerprint|AAAAA-BBBBB/i);
  });
});
