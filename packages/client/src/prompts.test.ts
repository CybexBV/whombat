import { describe, expect, it } from 'vitest';
import { promptPreview, promptProjectRows, promptRanWord, promptSlug, promptsFor } from './prompts';

const prompts = [{ title: 'Find what’s broken' }, { title: 'Prune the tests' }, { title: 'Hunt for bugs' }];

describe('prompts after /', () => {
  it('offers every prompt for nothing typed, and by a word of the title otherwise', () => {
    expect(promptsFor(prompts)).toHaveLength(3);
    expect(promptsFor(prompts, 'te').map((p) => p.title)).toEqual(['Prune the tests']);
    expect(promptsFor(prompts, 'find-wh').map((p) => p.title)).toEqual(['Find what’s broken']);
    expect(promptsFor(prompts, 'zzz')).toEqual([]);
  });

  it('reads a title as a slug without its apostrophe', () => {
    expect(promptSlug('Find what’s broken')).toBe('find-whats-broken');
  });

  it('cuts a preview to the first line', () => {
    expect(promptPreview('One line.\n\nMore.')).toBe('One line.');
    expect(promptPreview('x'.repeat(200), 20)).toHaveLength(20);
  });
});

describe('the projects a prompt can run on', () => {
  const projects = [
    { id: 'p1', title: 'Whombat', folder: '/home/j/Code/Whombat' },
    { id: 'p2', title: 'fusebox', folder: null },
    { id: 'p3', title: 'Kiwi', folder: null },
  ];
  const prompt = {
    runs: [
      { projectId: 'p3', title: 'Kiwi', at: '2026-11-12T09:00:00.000Z' },
      { projectId: 'p1', title: 'Whombat', at: '2026-11-10T09:00:00.000Z' },
    ],
  };

  it('puts those it ran on first, the latest at the top, then the rest by title', () => {
    expect(promptProjectRows(prompt, projects).map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    expect(promptProjectRows(null, projects).map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
  });

  it('searches titles and folders', () => {
    expect(promptProjectRows(prompt, projects, 'FUSE').map((p) => p.id)).toEqual(['p2']);
    expect(promptProjectRows(prompt, projects, 'code/whom').map((p) => p.id)).toEqual(['p1']);
  });

  it('says how long ago it ran', () => {
    const now = new Date(2026, 10, 12, 15, 0);
    expect(promptRanWord(new Date(2026, 10, 12, 8, 0).toISOString(), now)).toBe('Ran today');
    expect(promptRanWord(new Date(2026, 10, 11, 23, 0).toISOString(), now)).toBe('Ran yesterday');
    expect(promptRanWord(new Date(2026, 10, 9, 8, 0).toISOString(), now)).toBe('Ran 3 days ago');
    expect(promptRanWord(new Date(2026, 9, 3, 8, 0).toISOString(), now)).toBe('Ran on 3 Oct');
  });
});
