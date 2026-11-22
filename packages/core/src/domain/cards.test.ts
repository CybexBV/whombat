import { describe, expect, it } from 'vitest';
import { CARD_KINDS, cardTitle } from './cards.js';

describe('cardTitle', () => {
  it('uses the card’s own title, else the words it leads with', () => {
    expect(cardTitle({ kind: 'guide', title: 'Your email' } as never)).toBe('Your email');
    expect(cardTitle({ kind: 'pill', text: '\nBackups ran.\nAll of them.' } as never)).toBe('Backups ran.');
    expect(cardTitle({ kind: 'device_skill', name: 'Hue lights' } as never)).toBe('Hue lights');
  });

  it('names every kind when the card says nothing itself', () => {
    for (const kind of CARD_KINDS) expect(cardTitle({ kind }).length).toBeGreaterThan(0);
    expect(cardTitle({ kind: 'guide', title: '  ' } as never)).toBe('Set up');
  });
});
