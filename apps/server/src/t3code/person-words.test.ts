/** The person's own words in a hand-over to T3 Code: which turns carry them, and a message with them after it. */
import { describe, expect, it } from 'vitest';
import {
  PERSON_WORDS_MARK,
  PERSON_WORDS_MAX,
  personWordsOf,
  personWordsOfTurn,
  type WordsMessage,
  type WordsTurn,
  withPersonWords,
} from './person-words';

const ASKED = 'The Settle button does nothing in the Feedback room.  Can you fix it?\nIt worked last week.';

const turn = (over: Partial<WordsTurn> = {}): WordsTurn => ({
  trigger: 'mention',
  mode: 'reply',
  onBehalfOfAccountId: 'acc_mara',
  reportTurn: false,
  ...over,
});

const message = (over: Partial<WordsMessage> = {}): WordsMessage => ({
  text: ASKED,
  authorKind: 'person',
  authorAccountId: 'acc_mara',
  provenance: null,
  briefed: false,
  deleted: false,
  ...over,
});

describe('a message to T3 Code with the person’s words', () => {
  it('adds them after the agent’s brief, unchanged, in a labelled fence', () => {
    const out = withPersonWords('Fix Settle in the Feedback room of Whombat.  ', ASKED);
    expect(out.startsWith('Fix Settle in the Feedback room of Whombat.\n\n')).toBe(true);
    expect(out.endsWith(`${PERSON_WORDS_MARK}\n<<<\n${ASKED}\n>>>`)).toBe(true);
  });

  it('never adds them twice', () => {
    const once = withPersonWords('Fix it.', ASKED);
    expect(withPersonWords(once, ASKED)).toBe(once);
    expect(withPersonWords(once, 'Something else the person wrote later.')).toBe(once);
  });

  it('leaves a brief that already has the person’s words as it is, however they are spaced', () => {
    const quoting = `The person asked: “${ASKED.replace(/\s+/g, ' ')}” Look at useSettle first.`;
    expect(withPersonWords(quoting, ASKED)).toBe(quoting);
  });

  it('adds nothing without words or without a brief', () => {
    expect(withPersonWords('Fix it.', null)).toBe('Fix it.');
    expect(withPersonWords('Fix it.', '   ')).toBe('Fix it.');
    expect(withPersonWords('  ', ASKED)).toBe('  ');
  });

  it('cuts long words from their end', () => {
    const long = `Start of it. ${'word '.repeat(2000)}The very end.`;
    const cut = personWordsOf(long) as string;
    expect(cut.length).toBeLessThanOrEqual(PERSON_WORDS_MAX);
    expect(cut.startsWith('Start of it.')).toBe(true);
    expect(cut.endsWith('…')).toBe(true);
    expect(withPersonWords('Fix it.', long)).not.toContain('The very end.');
  });
});

describe('the turns that carry the person’s words', () => {
  it('are the ones their own message started', () => {
    expect(personWordsOfTurn(turn(), message())).toBe(ASKED);
    expect(personWordsOfTurn(turn({ trigger: 'dm' }), message())).toBe(ASKED);
    expect(personWordsOfTurn(turn({ trigger: 'retry' }), message())).toBe(ASKED);
  });

  it('never a wake, a schedule, an automation’s step or a search answer', () => {
    for (const trigger of [
      't3_thread',
      'schedule',
      'automation',
      'council',
      'delegation',
      'notify',
      'feedback',
    ])
      expect(personWordsOfTurn(turn({ trigger }), message()), trigger).toBeNull();
    expect(personWordsOfTurn(turn({ mode: 'answer' }), message())).toBeNull();
    expect(personWordsOfTurn(turn(), null)).toBeNull();
  });

  it('never a stranger’s text: an outsiders’ turn, a turn on a report, or someone else’s message', () => {
    expect(
      personWordsOfTurn(turn({ onBehalfOfAccountId: null }), message({ authorAccountId: null })),
    ).toBeNull();
    expect(personWordsOfTurn(turn({ reportTurn: true }), message())).toBeNull();
    expect(personWordsOfTurn(turn(), message({ authorKind: 'system', authorAccountId: null }))).toBeNull();
    expect(personWordsOfTurn(turn(), message({ authorKind: 'agent' }))).toBeNull();
    expect(personWordsOfTurn(turn(), message({ authorAccountId: 'acc_someone_else' }))).toBeNull();
    // An approved report posted in the person's name is still a stranger's text.
    expect(personWordsOfTurn(turn(), message({ provenance: 'feedback_handoff' }))).toBeNull();
    expect(personWordsOfTurn(turn(), message({ deleted: true }))).toBeNull();
    // A line a button posted for them (a saved prompt): its own instructions say what the thread gets.
    expect(personWordsOfTurn(turn(), message({ briefed: true }))).toBeNull();
  });
});
