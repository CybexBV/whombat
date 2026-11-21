import type { Message } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { earlierCardLine, earlierCardText, MOVED_CARD_WORDS, movedCardLink } from './movedCard';

type Row = Pick<Message, 'id' | 'card' | 'movedCard'>;
const council = (id: string) => ({ kind: 'council', councilId: id }) as unknown as Message['card'];
const tasks = (id: string) => ({ kind: 'delegation', delegationId: id }) as unknown as Message['card'];

describe('movedCardLink', () => {
  const intro: Row = { id: 'm1', card: null, movedCard: { kind: 'delegation', id: 'dlg_a' } };

  it('points at the newest message that holds the card now', () => {
    const thread: Row[] = [
      intro,
      { id: 'm2', card: council('cnl_a'), movedCard: null },
      { id: 'm3', card: null, movedCard: null },
      { id: 'm4', card: tasks('dlg_a'), movedCard: null },
    ];
    expect(movedCardLink(intro, thread)).toEqual({ label: MOVED_CARD_WORDS.link.delegation, targetId: 'm4' });
  });

  it('names a council’s card by its own words', () => {
    const left: Row = { id: 'm1', card: null, movedCard: { kind: 'council', id: 'cnl_a' } };
    const link = movedCardLink(left, [left, { id: 'm2', card: council('cnl_a'), movedCard: null }]);
    expect(link?.targetId).toBe('m2');
    expect(link?.label).toBe(MOVED_CARD_WORDS.link.council);
  });

  it('shows nothing when the card isn’t in the thread or the message held none', () => {
    expect(movedCardLink(intro, [intro, { id: 'm2', card: tasks('dlg_b'), movedCard: null }])).toBeNull();
    expect(movedCardLink({ id: 'm5', movedCard: null }, [{ id: 'm2', card: tasks('dlg_a') }])).toBeNull();
  });
});

describe('earlierCardLine', () => {
  const offered = (n: number) =>
    ({
      kind: 'delegation',
      delegationId: 'dlg_a',
      stage: 'offer',
      tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, state: 'offered' })),
    }) as unknown as Message['card'];

  it('names the card, says it is an earlier version and what it held', () => {
    expect(earlierCardLine({ earlierCard: offered(5) })).toBe('Tasks · earlier version · 5 tasks');
    const live = {
      kind: 'council',
      councilId: 'cnl_a',
      live: true,
      members: [
        { role: 'member', state: 'done' },
        { role: 'member', state: 'working' },
        { role: 'member', state: 'done' },
      ],
    } as unknown as Message['card'];
    expect(earlierCardLine({ earlierCard: live })).toBe('Council · earlier version · 2 of 3 answered');
  });

  it('names the council when the thread holds more than one', () => {
    const copy = {
      kind: 'council',
      councilId: 'cnl_b',
      title: 'Review the new Inbox tasks',
      live: true,
      members: [{ role: 'member', state: 'done' }],
    } as unknown as Message['card'];
    const other = { kind: 'council', councilId: 'cnl_a' } as unknown as Message['card'];
    expect(earlierCardLine({ earlierCard: copy }, [{ card: copy, earlierCard: null }])).toBe(
      'Council · earlier version · 1 of 1 answered',
    );
    expect(
      earlierCardLine({ earlierCard: copy }, [
        { card: other, earlierCard: null },
        { card: copy, earlierCard: null },
      ]),
    ).toBe('Council · Review the new Inbox tasks · earlier version · 1 of 1 answered');
  });

  it('is null when the message keeps no earlier card', () => {
    expect(earlierCardLine({ earlierCard: null })).toBeNull();
    expect(earlierCardLine({})).toBeNull();
  });
});

describe('earlierCardText', () => {
  it('reads the copy out: its title, then each task or member', () => {
    const tasks = {
      kind: 'delegation',
      title: 'Calm down the Inbox',
      stage: 'offer',
      tasks: [
        { n: 1, title: 'Taller rows', state: 'offered', picked: true },
        { n: 2, title: 'A search box', state: 'offered', picked: false },
      ],
    } as unknown as Message['card'];
    expect(earlierCardText({ earlierCard: tasks })).toBe(
      'Calm down the Inbox, as it was: 1, Taller rows; 2, A search box, not ticked.',
    );
    const handed = {
      kind: 'delegation',
      title: 'Calm down the Inbox',
      stage: 'working',
      live: true,
      startedAt: '2026-11-09T07:00:00Z',
      tasks: [
        { id: 't1', n: 1, title: 'Taller rows', state: 'done', pending: null, merge: null, checks: null },
        {
          id: 't2',
          n: 2,
          title: 'One line per item',
          state: 'working',
          pending: null,
          merge: null,
          checks: null,
        },
        { id: 't3', n: 3, title: 'Plainer words', state: 'failed', pending: null, merge: null, checks: null },
      ],
    } as unknown as Message['card'];
    const read = earlierCardText({ earlierCard: handed }) ?? '';
    // Each task says its state then, so a screen reader hears what the copy shows.
    expect(read.split('; ')).toHaveLength(3);
    expect(new Set(read.split('; ').map((part) => part.split(', ').at(-1))).size).toBe(3);
    const council = {
      kind: 'council',
      title: 'Review the Inbox',
      members: [
        { role: 'member', name: 'Claude Opus 5.5', state: 'done', score: 6 },
        { role: 'member', name: 'Muse Wonder', state: 'working', score: null },
      ],
    } as unknown as Message['card'];
    expect(earlierCardText({ earlierCard: council })).toBe(
      'Review the Inbox, as it was: Claude Opus 5.5, 6/10; Muse Wonder, working.',
    );
    expect(earlierCardText({ earlierCard: null })).toBeNull();
  });
});
