import { describe, expect, it } from 'vitest';
import { fitHeaderButtons } from './headerFit';

const BUTTONS = [
  { id: 'feedback', label: 'Feedback', badge: true },
  { id: 'settled', label: 'Done threads' },
  { id: 'files', label: 'Files' },
];

describe('header buttons on a narrow page', () => {
  it('shows them all where they fit beside the title', () => {
    expect(fitHeaderButtons(600, 'Chat', BUTTONS).more).toEqual([]);
  });

  it('moves the last ones into ⋯ first, keeping the first', () => {
    const { shown, more } = fitHeaderButtons(330, 'Chat', BUTTONS);
    expect(shown.map((b) => b.id)).toEqual(['feedback']);
    expect(more.map((b) => b.id)).toEqual(['settled', 'files']);
  });

  it('moves more of them with larger text', () => {
    const normal = fitHeaderButtons(420, 'Chat', BUTTONS, 1).more.length;
    const large = fitHeaderButtons(420, 'Chat', BUTTONS, 1.4).more.length;
    expect(large).toBeGreaterThan(normal);
  });
});
