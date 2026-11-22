import { CARD_KINDS, type Message } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  OUTSIDERS_ACTIONS_LINE,
  OUTSIDERS_CARD_LINE,
  outsidersCardLine,
  outsidersMessage,
} from './outsiders-view';

// What the server read for the person: none of it may reach an outsiders' turn.
const SECRET = 'Acme Holding BV · administration 4242';

function message(extra: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    conversationId: 'cnv_1',
    authorId: 'prn_dusty',
    text: `Here is what I found: ${SECRET}`,
    createdAt: '2026-11-22T10:00:00.000Z',
    editedAt: null,
    mentions: [],
    card: null,
    suggestions: [{ label: SECRET }],
    more: { hint: SECRET, requestedById: null, requestedAt: null },
    attachments: [{ id: 'att_1', name: `${SECRET}.pdf` }],
    reactions: [],
    threadRootId: 'msg_root',
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...extra,
  } as unknown as Message;
}

/** A card of `kind` that carries the server-read words in every field a reader could show. */
function cardOf(kind: string): NonNullable<Message['card']> {
  return { kind, title: SECRET, text: SECRET, plan: { title: SECRET } } as unknown as NonNullable<
    Message['card']
  >;
}

describe('what an outsiders’ turn reads of a message', () => {
  it('reads every card but a report as one line that says only its kind', () => {
    for (const kind of CARD_KINDS) {
      if (kind === 'approval' || kind === 'report') continue;
      const read = outsidersMessage(message({ card: cardOf(kind) }), false);
      expect(read.text).toBe(outsidersCardLine(kind));
      expect(JSON.stringify(read)).not.toContain(SECRET);
      expect(read.card).toBeNull();
      expect(read.attachments).toEqual([]);
      expect(read).toMatchObject({ id: 'msg_1', authorId: 'prn_dusty', threadRootId: 'msg_root' });
    }
  });

  it('gives each kind its own line', () => {
    const kinds = CARD_KINDS.filter((k) => k !== 'approval' && k !== 'report');
    expect(new Set(kinds.map((k) => outsidersCardLine(k))).size).toBe(kinds.length);
  });

  it('reads a card kept from before it moved, one that moved on, and a job’s result as a line too', () => {
    const earlier = outsidersMessage(message({ earlierCard: cardOf('council') }), false);
    expect(earlier.text).toBe(outsidersCardLine('council'));
    const moved = outsidersMessage(message({ movedCard: { kind: 'delegation', id: 'dlg_1' } }), false);
    expect(moved.text).toBe(outsidersCardLine('delegation'));
    const job = outsidersMessage(message({ jobResult: { handoffId: SECRET } as never }), false);
    expect(job.text).toBe(outsidersCardLine('job_result'));
    for (const read of [earlier, moved, job]) {
      expect(JSON.stringify(read)).not.toContain(SECRET);
      expect(read.earlierCard ?? read.movedCard ?? read.jobResult ?? null).toBeNull();
    }
  });

  it('keeps an approval card’s answer and a step’s report as their own lines', () => {
    const approval = { kind: 'approval', approval: { state: 'approved', title: SECRET } } as never;
    expect(outsidersMessage(message({ card: approval }), false).text).toBe(OUTSIDERS_CARD_LINE.approved);
    expect(outsidersMessage(message({ earlierCard: approval }), false).text).toBe(
      OUTSIDERS_CARD_LINE.approved,
    );
    expect(outsidersMessage(message(), true).text).toBe(OUTSIDERS_ACTIONS_LINE);
  });

  it('keeps a Feedback report’s own card and a plain message as they are', () => {
    const report = message({ card: cardOf('report') });
    expect(outsidersMessage(report, false)).toBe(report);
    const plain = message();
    expect(outsidersMessage(plain, false)).toBe(plain);
  });
});
