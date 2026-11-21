/**
 * A run whose goal waits on a person (docs/decisions/resourceful-agents.md RA-DS62): the agent's question becomes the
 * run's attention line, as the run card, run line, run page and Work show it after “Needs attention ·”.
 */
import { describe, expect, it } from 'vitest';
import { questionAttention } from './run-answers';

describe('questionAttention (RA-DS62)', () => {
  it('is the question on one line, without the mentions that open it', () => {
    expect(
      questionAttention(
        '@John To publish it I need the web server’s SSH key: add it in the Vault and give me a key to it;\nthen I’ll publish it — I’ll ask you first.',
      ),
    ).toBe(
      'To publish it I need the web server’s SSH key: add it in the Vault and give me a key to it; then I’ll publish it — I’ll ask you first.',
    );
    expect(questionAttention('@Mara, @Joris: which of the two servers is live?')).toBe(
      'which of the two servers is live?',
    );
    // A mention inside the question stays: it says who.
    expect(questionAttention('Should @Joris or I take the migration?')).toBe(
      'Should @Joris or I take the migration?',
    );
  });

  it('drops chat’s emphasis and link markup, which the line shows as plain text', () => {
    expect(
      questionAttention(
        'I need **Vault → Add → SSH key** for `web-1` ([setup](https://docs.example.com/ssh)) to deploy.',
      ),
    ).toBe('I need Vault → Add → SSH key for web-1 (setup) to deploy.');
  });

  it('fits the run’s 280 characters, cut at a word', () => {
    const long = `To publish it I need ${'the web server’s SSH key '.repeat(20)}in the Vault.`;
    const line = questionAttention(long);
    expect(line.length).toBeLessThanOrEqual(280);
    expect(line.endsWith('…')).toBe(true);
    expect(line.endsWith(' …')).toBe(false);
    expect(long.startsWith(line.slice(0, -1))).toBe(true);
  });
});
