/**
 * Talk as a conversation (Whombat DK-63, DK-64, TF-16, TF-17; appliance CG-196, CG-284, CG-285): the open conversation
 * as Whombat sends it (a server task's card as a live row), then what the page itself is in the middle of — the
 * question it sent, thinking or working, an answer Whombat hasn't put in the conversation yet — each once: a
 * message of the conversation with the talk's id takes the place of the page's own question or answer. While the
 * assistant works in the conversation one row at the bottom says so. Without a conversation from Whombat (a runtime
 * from before 0.108) only the page's own last question and answer show, as before. Pure.
 */
import type {
  DeskServer,
  DeskSession,
  DeskSessionAsk,
  DeskSessionMessage,
  DeskSessionTask,
  DeskTalk,
} from './desk';
import { DESK, DESK_WORDS, fill } from './deskCopy';
import { type TalkUi, talkId, talkView } from './talk';

export type RowTone = 'text' | 'thinking' | 'prompt' | 'error';

/** One row of the conversation as Talk draws it. */
export interface ConvoRow {
  key: string;
  from: 'you' | 'assistant';
  paragraphs: string[];
  tone: RowTone;
  /** “There’s more of this in Chat.” */
  more: boolean;
  ask: DeskSessionAsk | null;
  /** The talk whose answer a touch plays again. */
  replay: string | null;
  thing: DeskServer | null;
  /** A server task's card, drawn as a live row in place of its paragraphs (0.116, TF-17). */
  task: DeskSessionTask | null;
}

export interface Convo {
  /** Messages before the first row, only in Chat. */
  earlier: number;
  rows: ConvoRow[];
  /** Whombat holds an open conversation (Close conversation shows). */
  open: boolean;
}

const row = (r: Partial<ConvoRow> & Pick<ConvoRow, 'key' | 'from' | 'paragraphs'>): ConvoRow => ({
  tone: 'text',
  more: false,
  ask: null,
  replay: null,
  thing: null,
  task: null,
  ...r,
});

const fromMessage = (m: DeskSessionMessage): ConvoRow =>
  row({
    key: m.id,
    from: m.from,
    paragraphs: m.paragraphs,
    more: m.more,
    ask: m.ask,
    replay: m.from === 'assistant' && m.audio ? m.talk : null,
    thing: m.from === 'assistant' ? m.thing : null,
    task: m.task ?? null,
  });

/** The key of the row that says the assistant is working in the conversation (TF-17). */
export const WORKING_KEY = 'working';

/**
 * The rows Talk shows: the conversation (`session`, null when Whombat has none to give), then the page's own talk
 * (`s`, and `talk`, Whombat's view of the one it follows). The opening line (“What can I do for you?”) only on an
 * empty conversation; a failed talk's line goes once the assistant said something after the question, and a talk
 * without a question of its own (the words after a decision) has its line only until the assistant says something
 * newer (TF-16). While the assistant works in the conversation (`session.working`) one row at the bottom says so: what
 * it is doing (“Neo is working… · Installing updates”), else the talk's own line, else “Neo is working on it…”; a slow
 * talk's line gives way to it (CG-285).
 */
export function conversation(
  session: DeskSession | null,
  s: TalkUi,
  talk: DeskTalk | null,
  assistant: string,
  voice: boolean,
): Convo {
  const msgs = session?.open ? session.messages : [];
  const rows = msgs.map(fromMessage);
  const view = talkView(s, talk, assistant, voice);
  const id = talkId(s);
  const you = id === null ? -1 : msgs.findIndex((m) => m.from === 'you' && m.talk === id);
  const answered = id !== null && msgs.some((m) => m.from === 'assistant' && m.talk === id);
  // A talk without a question here, followed from `since` (after a decision): what came after that time.
  const since = (s.phase === 'waiting' || s.phase === 'done') && s.since !== undefined ? s.since : null;
  const follow = you < 0 && since !== null;
  const after = you >= 0 ? msgs.slice(you + 1) : follow ? msgs.filter((m) => Date.parse(m.at) > since) : [];
  const saidSince = after.some((m) => m.from === 'assistant');
  const tag = id ?? s.phase;
  const working = session?.open ? (session.working ?? null) : null;
  /** The talk's own thinking or working line, while it has one. */
  let busyLine: string | null = null;

  if (view.question && you < 0) {
    rows.push(row({ key: `you-${tag}`, from: 'you', paragraphs: [view.question] }));
  }
  const a = view.answer;
  if (a && s.phase === 'ready') {
    // The opening line, or that only typing works, on an empty conversation.
    if (rows.length === 0)
      rows.push(
        row({
          key: 'intro',
          from: 'assistant',
          paragraphs: [a.text],
          tone: a.kind === 'error' ? 'error' : 'prompt',
        }),
      );
  } else if (a?.kind === 'thinking') {
    if (!answered && !(follow && saidSince)) busyLine = a.text;
  } else if (a?.kind === 'error') {
    if (!answered && !saidSince && !(a.slow && working))
      rows.push(row({ key: `said-${tag}`, from: 'assistant', paragraphs: [a.text], tone: 'error' }));
  } else if (a?.kind === 'answer' && !answered && a.text) {
    rows.push(
      row({
        key: `said-${tag}`,
        from: 'assistant',
        paragraphs: [a.text],
        thing: view.thing,
        replay: view.audio ? id : null,
      }),
    );
  }
  if (working) {
    const text = working.doing
      ? fill(DESK.workingDoing, { assistant, doing: working.doing })
      : (busyLine ?? fill(DESK_WORDS.working, { assistant }));
    rows.push(row({ key: WORKING_KEY, from: 'assistant', paragraphs: [text], tone: 'thinking' }));
  } else if (busyLine !== null) {
    rows.push(row({ key: `said-${tag}`, from: 'assistant', paragraphs: [busyLine], tone: 'thinking' }));
  }
  return { earlier: session?.open ? session.earlier : 0, rows, open: session?.open ?? false };
}

/** What an inline ask says became of it (DK-63). */
export const ASK_STATE_WORDS: Record<DeskSessionAsk['state'], string> = {
  waiting: DESK.askWaiting,
  approved: DESK.askApproved,
  denied: DESK.askDenied,
};

/** The key of the newest row (the conversation scrolls to it, or says a new message came). */
export const lastKey = (c: Convo): string | null => c.rows.at(-1)?.key ?? null;

/**
 * What changes in the conversation when something happens in it (TF-18, CG-287): its messages and their words, an
 * ask's or a task's state, the working row. Two reads with the same signature: nothing new. Not the times a task row
 * ticks on the page.
 */
export function sessionSig(s: DeskSession): string {
  return JSON.stringify([
    s.open,
    s.earlier,
    s.messages.map((m) => [
      m.id,
      m.paragraphs.join('\n'),
      m.ask?.state ?? null,
      m.task ? [m.task.state, m.task.endedAt, m.task.result] : null,
    ]),
    s.working ? [s.working.since, s.working.doing] : null,
  ]);
}
