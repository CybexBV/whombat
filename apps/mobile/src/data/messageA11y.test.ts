import { describe, expect, it } from 'vitest';
import { messageA11y, messageLinks } from './messageA11y';

const base = { author: 'Mara Okafor', time: '13:52', deleted: false, pinned: false };

describe('a message as one element for screen readers', () => {
  it('reads who, when and the words in one label, with the row’s actions', () => {
    const a = messageA11y(
      { ...base, text: 'Why is **pve-02** using so much memory?' },
      { reply: true, settle: 'settle', more: true },
    );
    expect(a.label).toBe('Mara Okafor, 13:52. Why is pve-02 using so much memory?');
    expect(a.actions.map((x) => x.name)).toEqual(['reply', 'settle', 'more', 'copy']);
  });

  it('offers Open again on a settled thread, nothing to copy on a deleted one, no Reply inside a thread', () => {
    const a = messageA11y(
      { ...base, deleted: true, text: 'This message was deleted' },
      { reply: false, settle: 'open_again', more: false },
    );
    expect(a.actions.map((x) => x.name)).toEqual(['open_again']);
  });

  it('keeps the links in its words reachable, each as an action named by its words', () => {
    const text = 'See [the run](https://example.com/runs/6) and https://example.org';
    expect(messageLinks(text).map((l) => l.href)).toContain('https://example.com/runs/6');
    const a = messageA11y(
      { ...base, author: null, time: null, text },
      { reply: false, settle: null, more: true },
    );
    expect(a.label.startsWith('See the run')).toBe(true);
    expect(a.actions.find((x) => x.name === 'link:0')?.label).toBe('Open the run');
    expect(a.links[0]).toBe('https://example.com/runs/6');
  });
});
