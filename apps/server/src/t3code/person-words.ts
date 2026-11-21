/**
 * The person's own words in a hand-over to T3 Code (docs/decisions/t3code.md): the agent writes the brief, and Whombat
 * adds what the person wrote, unchanged, so the coding agents read the request as it was asked and the agent has no
 * need to retell it. Pure: which turns carry the person's words, and a message with them after it.
 */

/** The words before the person's own: a message that has them gets no second copy. */
export const PERSON_WORDS_MARK = 'What the person wrote, word for word:';
/** The person's words are cut from their end at this length. */
export const PERSON_WORDS_MAX = 4000;

const squeezed = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The person's words as they are handed over: whole, or their start when they are longer than `PERSON_WORDS_MAX`. */
export function personWordsOf(text: string | null | undefined): string | null {
  const words = text?.trim();
  if (!words) return null;
  return words.length > PERSON_WORDS_MAX ? `${words.slice(0, PERSON_WORDS_MAX - 1).trimEnd()}…` : words;
}

/**
 * The agent's message to a T3 Code thread with the person's words after it, fenced and labelled. Unchanged when there
 * are no words, the message is empty (a thread started idle), it has them already (the mark), or the agent quoted them
 * in full itself.
 */
export function withPersonWords(message: string, text: string | null | undefined): string {
  const words = personWordsOf(text);
  if (!words || !message.trim() || message.includes(PERSON_WORDS_MARK)) return message;
  if (squeezed(message).includes(squeezed(words))) return message;
  return `${message.trimEnd()}\n\n${PERSON_WORDS_MARK}\n<<<\n${words}\n>>>`;
}

/** The parts of a turn and the message that started it which say whose words that message is. */
export interface WordsTurn {
  trigger: string;
  mode: string;
  /** The account the turn is for; null in an outsiders' turn. */
  onBehalfOfAccountId: string | null;
  /** A turn on a customer's report: a stranger's text never reaches a thread with full access. */
  reportTurn: boolean;
}

export interface WordsMessage {
  text: string;
  /** Who wrote it: a person, and the account they sign in with. */
  authorKind: string;
  authorAccountId: string | null;
  /** Set when the text isn't simply the author's own (an assessment, an approved report). */
  provenance: string | null;
  /** Whombat posted it for them with instructions of its own for the agent (a saved prompt, a button). */
  briefed: boolean;
  deleted: boolean;
}

/** The triggers a person's own message starts: what they wrote to the agent, and that turn tried again. */
const PERSON_TRIGGERS: readonly string[] = ['mention', 'dm', 'retry'];

/**
 * The words a turn's hand-overs carry: the message that started it, when the person the turn is for wrote it
 * themself. Null for everything else: a wake, a schedule, an automation's step, a search answer, an outsiders' turn or
 * one on a report, and a message that someone else or Whombat wrote (a line a button posted for them comes with
 * Whombat's own instructions for the agent, which say what the thread gets).
 */
export function personWordsOfTurn(turn: WordsTurn, message: WordsMessage | null): string | null {
  if (!message || turn.reportTurn || !turn.onBehalfOfAccountId) return null;
  if (turn.mode !== 'reply' || !PERSON_TRIGGERS.includes(turn.trigger)) return null;
  if (message.authorKind !== 'person' || message.authorAccountId !== turn.onBehalfOfAccountId) return null;
  if (message.provenance || message.briefed || message.deleted) return null;
  return personWordsOf(message.text);
}
