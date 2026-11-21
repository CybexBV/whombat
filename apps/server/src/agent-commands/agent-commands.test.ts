/** The pure parts of the agent's commands on the server (agent-computer.md AC-DS01, AC-DS06, AC-DS08). */
import { VAULT_SCRUBBED } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { reachableAddresses } from './context';
import { scrubValue, scrubWith } from './secrets';

describe('reachableAddresses (AC-DS06)', () => {
  it('keeps public addresses and those on a home network, nothing else', () => {
    expect(
      reachableAddresses(
        [
          '93.184.216.34',
          '10.0.0.5',
          '192.168.1.20',
          '127.0.0.1',
          '169.254.169.254',
          '203.0.113.7',
          '93.184.216.34',
        ],
        ['192.168.1.0/24'],
      ),
    ).toEqual(['93.184.216.34', '192.168.1.20']);
    expect(reachableAddresses(['2606:2800:220:1::1', 'fd00::1'], ['fd00::/64'])).toEqual([
      '2606:2800:220:1::1',
      'fd00::1',
    ]);
  });
});

describe('scrubbing (AC-DS08)', () => {
  it('replaces every needle, longest first, in strings, arrays and plain objects', () => {
    const needles = ['token-abcdef-123', 'token-abcdef'];
    expect(scrubWith('a token-abcdef-123 b token-abcdef c', needles)).toBe(
      `a ${VAULT_SCRUBBED} b ${VAULT_SCRUBBED} c`,
    );
    const at = new Date(0);
    expect(
      scrubValue(
        { text: 'token-abcdef', list: ['x token-abcdef'], n: 3, at, nested: { k: 'token-abcdef-123' } },
        needles,
      ),
    ).toEqual({
      text: VAULT_SCRUBBED,
      list: [`x ${VAULT_SCRUBBED}`],
      n: 3,
      at,
      nested: { k: VAULT_SCRUBBED },
    });
    const same = { text: 'token-abcdef' };
    expect(scrubValue(same, [])).toBe(same);
  });
});
