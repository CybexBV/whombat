import { describe, expect, it } from 'vitest';
import { shareWarnings } from './warnings';

describe('what to look at before sharing', () => {
  it('finds addresses, email addresses and keys, once per message', () => {
    const w = shareWarnings([
      'The NAS is at 192.168.1.20:5000 and the-titan.lan.',
      'Mail me at john@example.com.',
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
      'Meet at 10:30, nothing else here.',
    ]);
    expect(w.map((x) => x.kind)).toEqual(['address', 'email', 'secret']);
    expect(w[0]).toMatchObject({ messages: 1, example: '192.168.1.20:5000' });
    expect(w[1]).toMatchObject({ messages: 1, example: 'john@example.com' });
    // A key is never shown whole.
    expect(w[2]?.example).not.toContain('abcdefgh');
  });

  it('counts the messages that have each and says nothing about ordinary words', () => {
    expect(shareWarnings(['Lisbon in May sounds lovely.', 'At 09:15 we leave.'])).toEqual([]);
    const w = shareWarnings(['fe80::1 is the router', 'password: hunter22', 'also 10.0.0.1']);
    expect(w.find((x) => x.kind === 'address')?.messages).toBe(2);
    expect(w.find((x) => x.kind === 'secret')?.messages).toBe(1);
  });
});
