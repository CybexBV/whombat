/**
 * Talking to the assistant at the desk screen (docs/decisions/desk-display.md DK-06, DK-07; desk-display-talk.md
 * DK-T01…DK-T13). The person types, or speaks into Talk's mic, which is voice typing (docs/decisions/dictation.md:
 * the desk module's `hear` puts the words in the box first, and they come here as text with `spoken`); an older screen
 * sends the recording itself, which becomes text on the box (`voice.ts`). The question
 * goes into their Chat as a new thread, or as a reply in the last desk thread when they follow up within 2 minutes; the
 * assistant's turn knows it came from the screen (`DispatchContext.desk`, the runner's one line) and answers in a sentence
 * or two; the screen shows the answer, says it (Kokoro; a Dutch answer in the box's Dutch voice, `dutch-speech.ts`) and
 * shows the server it is about.
 *
 * **The host.** The desk module (the desk socket and the glance) owns the pairing, the lock and the glance, and gives
 * Talk a `DeskTalkHost`:
 *
 *   place()                 the paired person's place `{burrowId, personId}`, or null when nobody paired the screen;
 *   unlocked()              whether the screen is unlocked now: Talk never starts on a locked screen (DK-07);
 *   voiceOn()               “Talk to {assistant}” is on in Settings (`DeskSettings.voice`): off, no recording is taken
 *                           and nothing is spoken (typing still works);
 *   speechVoice()           the voice the person chose (`DeskSettings.speechVoice`, DK-50), optional: answers are said
 *                           in it when the voice service lists it, else in the service's default (DK-S53);
 *   deskServerByName(name)  the glance's `DeskServer` for a server by its name (case-insensitive), or null.
 *
 * Each may answer at once or with a promise. It calls `createDeskTalk(services, host)` once and, from the desk socket's
 * routes (§2.3), `start` (`POST /v1/desk/talk`; refusals are `DeskTalkError`s with the route's status and code),
 * `get` (`/talk/get`), `audio` (`/talk/audio`, 404 when null) and `latest` (`DeskState.talk`). It hides `latest()` while
 * the screen is locked (the question and answer are message words, DK-03) and calls `forget()` when the screen is unpaired
 * or paired to someone else. `createDeskTalk` also tells the notifications whom the screen is paired with and whether it
 * is unlocked: the assistant's replies in a desk thread don't push to a person reading them there (DK-T13, `talk-mark.ts`).
 *
 * **One talk.** `transcribing` (a recording) → `thinking` (the question is in Chat) → `working` after 90 s without an
 * answer (task-feedback.md TF-16; it keeps waiting for the turn to end, at most 30 minutes) → `answered` (with `audio`
 * when it was spoken) or `failed` with a reason: `not_heard` (silence or no words), `voice_unavailable` (the voice service
 * didn't answer), `slow` (no answer in the 30 minutes, or a new question ended the wait: it still lands in Chat) or
 * `failed`. One at a time (`busy`), but a new question ends a `working` wait (DK-T18). The recording is sent once and
 * dropped; the spoken answer stays in memory for a replay for 10 minutes, with at most five talks kept.
 *
 * **The conversation** (DK-63, DK-64; desk-display-talk.md DK-T14…DK-T16). The first question opens it (a new Chat
 * thread); each question with `continue` goes on in it until `end()` (*Close conversation*) or 30 minutes without a
 * word in it. `session()` is the conversation as the screen shows it (`talk/session`): its messages, its task cards as
 * live rows and the assistant working there now (TF-17); `follow()` waits for the assistant's next words after the
 * person answered one of its asks there, and says them as an answer. Every change in its thread is the screen's use
 * (`DeskTalkHost.used`, TF-18).
 */
import {
  DESK_ANSWER_MAX,
  DESK_QUESTION_MAX,
  DESK_SESSION_MAX_BYTES,
  DESK_SESSION_MESSAGES,
  DESK_SESSION_PARAGRAPHS,
  DESK_TALK_TEXT_MAX,
  type DeskServer as DeskServerSchema,
  type DeskSessionMessage,
  type DeskTalk,
  type DeskTalkReason as DeskTalkReasonSchema,
  type DeskTalkSession,
  VOICE_PROMPT_MAX,
} from '@whombat/control-contracts/local';
import {
  type Block,
  DESK_TALK_SESSION_IDLE_S,
  DESK_TALK_WAIT_MAX_S,
  DESK_TALK_WORKING_S,
  deskText,
  type Inline,
  type Message,
  parseMessage,
  randomIdBody,
  type TaskCard,
  TURN_MERGED_REASON,
  taskCardLine,
  VAULT_ASK_TEXT,
} from '@whombat/core';
import { and, count, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { startChat } from '../chats/commands';
import { threadedRoom } from '../chats/rooms';
import { sendMessage } from '../commands/messages';
import { activities, catalogConnections, dispatches, messages as messagesTable } from '../db/schema/index';
import { arr, obj } from '../hosts/map';
import { hostsFor } from '../hosts/service';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { loadAgentRow, loadPrincipalRow } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import type { Logger, Services } from '../services';
import {
  checkDeskWav,
  type VoiceAbility,
  VoiceCallError,
  type VoicePort,
  type VoiceSttSettings,
  voiceFor,
  voiceHealth,
  WavError,
  wavPeak,
} from '../voice/speech';
import { loadVoiceSettings } from '../voice/store';
import { wantsDutchVoice } from '../voice/view';
import { dutchSpeechText, speechLanguage } from './dutch-speech';
import {
  type DeskTalkServer,
  deskClientId,
  deskTalkIdOf,
  rememberTalkServer,
  setDeskScreen,
} from './talk-mark';

export { voiceHealth } from '../voice/speech';
export { deskClientId, deskContextPart, deskTurnOf } from './talk-mark';

type Awaitable<T> = T | Promise<T>;
type DeskServer = z.infer<typeof DeskServerSchema>;
type DeskTalkReason = z.infer<typeof DeskTalkReasonSchema>;

/** Where the screen is paired: the person's burrow and the person (a principal id). */
export interface DeskTalkPlace {
  burrowId: string;
  personId: string;
}

/** What Talk needs from the desk module (see the top of this file). */
export interface DeskTalkHost {
  place(): Awaitable<DeskTalkPlace | null>;
  unlocked(): Awaitable<boolean>;
  voiceOn(): Awaitable<boolean>;
  /** The voice the person chose (DK-50); absent or null: the voice service's default. */
  speechVoice?(): Awaitable<string | null>;
  deskServerByName(name: string): Awaitable<DeskServer | null>;
  /**
   * Something happened in the open conversation or its talk (a message, a card's change, the assistant working there, a
   * talk's new state): the screen is in use, as a touch would say (TF-18). Optional.
   */
  used?(): void;
}

/** `POST /v1/desk/talk` as the route has decoded it: one of `text` or `audioWav` (the WAV's bytes). */
export interface DeskTalkStart {
  text?: string;
  audioWav?: Buffer;
  continue: boolean;
  /** The text came from Talk's mic (`hear`): the turn hears it came by voice (DK-T05). */
  spoken?: boolean;
  /**
   * The server the person looks at on the screen (DK-85, DK-S89), as its card with its id: the talk is about it (its
   * `thing`), and the assistant's turn is told so (never the chat).
   */
  about?: DeskServer & { id: string };
}

export interface DeskTalks {
  start(input: DeskTalkStart): Promise<{ id: string }>;
  get(id: string): DeskTalk | null;
  audio(id: string): Buffer | null;
  /** The newest talk still kept, for `DeskState.talk` (a reloaded page picks it up). */
  latest(): DeskTalk | null;
  /**
   * Drops every talk, its audio and the thread a follow-up would continue, and stops waiting for the one that runs
   * (unpaired, paired to someone else).
   */
  forget(): void;
  /** Stops a talk that is waiting and its timers (shutdown, tests). */
  close(): void;
  /** The open conversation (DK-T14): its thread and whose it is; null when closed, timed out or never started. */
  open(): OpenConversation | null;
  /** `POST /v1/desk/talk/session`: the open conversation as the screen shows it (DK-T15). */
  session(): Promise<DeskTalkSession>;
  /** `POST /v1/desk/talk/close`: ends the open conversation; the thread stays in Chat (DK-T14). */
  end(): void;
  /**
   * A follow talk (DK-T16): listens for the assistant's next words in the open conversation and says them as an answer.
   * Resolves once it listens, so the caller decides after; `cancel` drops it (the decision didn't go through). Null when
   * there is no open conversation or a talk runs.
   */
  follow(): Promise<{ id: string; cancel(): void } | null>;
}

/** The conversation the screen has open (DK-T14). */
export interface OpenConversation extends DeskThread {
  burrowId: string;
  personId: string;
  /** When it started and when something was last said in it (ms). */
  startedAt: number;
  lastAt: number;
}

export type DeskTalkErrorCode =
  | 'not_paired'
  | 'locked'
  | 'busy'
  | 'voice_unavailable'
  | 'bad_request'
  | 'bad_audio';

const ERROR_STATUS: Record<DeskTalkErrorCode, number> = {
  not_paired: 409,
  locked: 409,
  busy: 409,
  voice_unavailable: 503,
  bad_request: 400,
  bad_audio: 400,
};

/** Why `start` refused: the desk socket answers `status` with `code`. */
export class DeskTalkError extends Error {
  readonly status: number;
  constructor(
    readonly code: DeskTalkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeskTalkError';
    this.status = ERROR_STATUS[code];
  }
}

export interface DeskTalkTimings {
  /** How long a talk waits for the assistant's answer before it is `working` (TF-16). */
  replyMs: number;
  /** How long it waits at most, from the question, before it is `slow` (TF-16). */
  waitMaxMs: number;
  /** An answer whose turn is still running counts once nothing more came for this long. */
  settleMs: number;
  /** The open conversation ends when nothing was said in it for this long (DK-64). */
  sessionIdleMs: number;
  /** The conversation as the screen shows it is read again at least this often (DK-T15). */
  sessionMaxAgeMs: number;
  /** Talks and their audio are kept this long… */
  keepMs: number;
  /** …and at most this many. */
  keep: number;
}

export const DESK_TALK_TIMINGS: DeskTalkTimings = {
  replyMs: DESK_TALK_WORKING_S * 1000,
  waitMaxMs: DESK_TALK_WAIT_MAX_S * 1000,
  settleMs: 15_000,
  sessionIdleMs: DESK_TALK_SESSION_IDLE_S * 1000,
  sessionMaxAgeMs: 10_000,
  keepMs: 10 * 60_000,
  keep: 5,
};

/** Time for Talk: now in ms, and a timer that can be cancelled (tests drive both). */
export interface DeskTalkTimers {
  now(): number;
  after(ms: number, fn: () => void): () => void;
}

/** Samples quieter than this (about −40 dBFS) are silence: nothing was said, so nothing is transcribed. */
export const SILENCE_PEAK = 330;

/* The question's way into Chat and the answer's way back ---------------------------------------------------------- */

/** Where a desk question went: the conversation, and the thread the assistant answers in (null: a flat room). */
export interface DeskThread {
  conversationId: string;
  rootId: string | null;
}

/** `messageId`: the assistant's message the answer is (the conversation marks it as the talk's, DK-T15). */
export type DeskAnswer =
  | { kind: 'answered'; text: string; messageId?: string }
  | { kind: 'slow' }
  | { kind: 'failed' };

export interface DeskQuestion {
  text: string;
  spoken: boolean;
  talkId: string;
  /** The thread to continue, or null for a new one. */
  thread: DeskThread | null;
  /** The server the person looks at on the screen (DK-85): its turn is told, by the question's talk (`talk-mark.ts`). */
  server?: DeskTalkServer;
}

/** The person's Chat as Talk uses it; `createDeskTalk` makes the real one, tests a fake. */
export interface DeskChat {
  /**
   * Posts the question as the person (a new thread, or a reply in `thread`), calls `posted` with where it went, and waits
   * for the assistant's answer there. Throws when it couldn't be posted.
   */
  ask(
    place: DeskTalkPlace,
    question: DeskQuestion,
    posted: (thread: DeskThread) => void,
    signal: AbortSignal,
  ): Promise<DeskAnswer>;
  /** The names the person may say: the assistant's, the servers' and the things'. */
  vocabulary(place: DeskTalkPlace): Promise<Vocabulary>;
  /**
   * Listens for the assistant's next words in `thread` (a follow talk, DK-T16): resolves once it listens; `wait` gives
   * them as an answer (a turn ending before it said anything doesn't count), `stop` stops listening.
   */
  listen(
    place: DeskTalkPlace,
    thread: DeskThread,
  ): Promise<{ wait(signal: AbortSignal): Promise<DeskAnswer>; stop(): void }>;
  /** The conversation's messages for the screen (DK-T15): the newest `limit`, oldest first, and how many came before. */
  read(place: DeskTalkPlace, conversation: OpenConversation, limit: number): Promise<ConversationRead>;
  /** Tells `changed` about every change in a conversation (the bus); returns what stops it. */
  watch(changed: (change: ConversationChange) => void): () => void;
}

/** What `DeskChat.read` found: the messages (the person's and the assistant's), who the assistant is, the rest's count. */
export interface ConversationRead {
  messages: Message[];
  agentId: string | null;
  earlier: number;
  /** One of the assistant's turns runs in the thread now (TF-17): since when, and what it is doing. */
  working?: { since: string; doing?: string } | null;
}

/**
 * A change on the bus in a conversation: `posted` with the new message's thread (its root's id for the root); `card`
 * a task card's change in place there (TF-17); `turn` the thread of an assistant's turn or activity that changed.
 */
export interface ConversationChange {
  conversationId: string;
  posted: { id: string; threadRootId: string | null } | null;
  card?: { id: string; threadRootId: string | null } | null;
  turn?: { threadRootId: string | null } | null;
}

/** The names a desk question may hold (servers by their names in Whombat). */
export interface Vocabulary {
  assistant: string | null;
  servers: string[];
  things: string[];
}

const NO_WORDS: Vocabulary = { assistant: null, servers: [], things: [] };

export interface DeskTalkDeps {
  host: DeskTalkHost;
  chat: DeskChat;
  voice(): VoicePort | null;
  health(): Promise<VoiceAbility>;
  /** Voice typing's speech model and language, which the desk hears with too (dictation.md). */
  voiceSettings?(): Promise<VoiceSttSettings>;
  /** Whether the saved opt-in Dutch voice setting is on (with the current licence agreement). */
  dutchVoiceOn?(): Promise<boolean>;
  timers: DeskTalkTimers;
  timings: DeskTalkTimings;
  log: Logger;
}

/** Talk for the desk module: the person's Chat through the commit pipeline and the bus, the voice service. */
export function createDeskTalk(
  services: Services,
  host: DeskTalkHost,
  options: { timings?: Partial<DeskTalkTimings>; timers?: DeskTalkTimers } = {},
): DeskTalks {
  const timings = { ...DESK_TALK_TIMINGS, ...options.timings };
  const timers = options.timers ?? systemTimers(services);
  const talks = createDeskTalkWith({
    host,
    chat: chatOf(services, timers, timings),
    voice: () => voiceFor(services),
    health: () => voiceHealth(services),
    voiceSettings: () => loadVoiceSettings(services.db),
    dutchVoiceOn: () => loadVoiceSettings(services.db).then(wantsDutchVoice),
    timers,
    timings,
    log: services.log,
  });
  // Notifications ask whether the person reads the screen now (DK-T13).
  setDeskScreen(services, host);
  return {
    ...talks,
    close() {
      talks.close();
      setDeskScreen(services, null, host);
    },
  };
}

function systemTimers(services: Pick<Services, 'clock'>): DeskTalkTimers {
  return {
    now: () => services.clock().getTime(),
    after(ms, fn) {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}

interface TalkRecord {
  talk: DeskTalk;
  personId: string;
  /** Last change (ms): what `keepMs` counts from. */
  at: number;
  audio: Buffer | null;
  dropAudio: (() => void) | null;
  /** The assistant's message the answer was (DK-T15). */
  messageId: string | null;
}

/** Talk on its parts (the state machine); `createDeskTalk` wires the real ones. */
export function createDeskTalkWith(deps: DeskTalkDeps): DeskTalks {
  const { host, timers, timings, log } = deps;
  const talks = new Map<string, TalkRecord>();
  let active: { id: string | null; abort: AbortController } | null = null;
  let conversation: OpenConversation | null = null;
  /** Counts the changes in the open conversation's room: the screen's view is read again after one (DK-T15). */
  let changes = 0;
  let view_: { key: string; changes: number; at: number; read: ConversationRead } | null = null;
  const inThread = (c: DeskThread, m: { id: string; threadRootId: string | null }) =>
    c.rootId === null || m.id === c.rootId || m.threadRootId === c.rootId;
  const offWatch = deps.chat.watch((change) => {
    const c = conversation;
    if (!c || change.conversationId !== c.conversationId) return;
    changes++;
    // Something said in its thread keeps it open (DK-64), a task card's change too (TF-17); both are the screen's use
    // (TF-18), as the assistant working there is.
    const said = (change.posted && inThread(c, change.posted)) || (change.card && inThread(c, change.card));
    if (said) c.lastAt = timers.now();
    if (said || (change.turn && (c.rootId === null || change.turn.threadRootId === c.rootId))) host.used?.();
  });

  const view = (r: TalkRecord): DeskTalk => ({ ...r.talk, thing: r.talk.thing ? { ...r.talk.thing } : null });

  function prune(): void {
    const now = timers.now();
    for (const [id, r] of talks) if (now - r.at > timings.keepMs && active?.id !== id) drop(id, r);
    const ids = [...talks.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - timings.keep))) {
      const r = talks.get(id);
      if (r && active?.id !== id) drop(id, r);
    }
  }

  function drop(id: string, r: TalkRecord): void {
    r.dropAudio?.();
    r.audio = null;
    talks.delete(id);
  }

  /** Changes a talk that is still kept; a forgotten one changes nowhere. Answered or failed, the next may start. */
  function update(id: string, change: Partial<DeskTalk>): TalkRecord | null {
    if ((change.state === 'answered' || change.state === 'failed') && active?.id === id) active = null;
    const r = talks.get(id);
    if (!r) return null;
    r.talk = { ...r.talk, ...change };
    r.at = timers.now();
    // A talk that moves on is the screen in use (TF-18).
    host.used?.();
    return r;
  }

  /**
   * After 90 s without an answer the talk is `working` (TF-16): it keeps waiting for the turn. Returns what stops the
   * timer (the answer came first).
   */
  function workingAfter(id: string): () => void {
    return timers.after(timings.replyMs, () => {
      if (talks.get(id)?.talk.state === 'thinking') update(id, { state: 'working' });
    });
  }

  function fail(id: string, reason: DeskTalkReason): void {
    update(id, { state: 'failed', reason });
  }

  /** The open conversation, closed when nothing was said in it for 30 minutes (DK-64). */
  function current(): OpenConversation | null {
    if (conversation && timers.now() - conversation.lastAt > timings.sessionIdleMs) endConversation();
    return conversation;
  }

  function endConversation(): void {
    conversation = null;
    view_ = null;
  }

  function continuable(place: DeskTalkPlace, wanted: boolean): DeskThread | null {
    const c = current();
    if (!wanted || !c) return null;
    if (c.burrowId !== place.burrowId || c.personId !== place.personId) return null;
    return { conversationId: c.conversationId, rootId: c.rootId };
  }

  /** Where the question went: the open conversation goes on, or this is a new one. */
  function noteThread(place: DeskTalkPlace, thread: DeskThread): void {
    const now = timers.now();
    const c = conversation;
    if (
      c &&
      c.personId === place.personId &&
      c.conversationId === thread.conversationId &&
      c.rootId === thread.rootId
    ) {
      c.lastAt = now;
    } else {
      conversation = {
        ...thread,
        burrowId: place.burrowId,
        personId: place.personId,
        startedAt: now,
        lastAt: now,
      };
      view_ = null;
    }
    changes++;
  }

  async function run(
    id: string,
    place: DeskTalkPlace,
    input: {
      text: string | null;
      audio: Buffer | null;
      continue: boolean;
      about: DeskTalkStart['about'];
      spoken: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> {
    let question = input.text;
    const about = input.about ?? null;
    let spoken = input.spoken;
    // The names the person may say, read once per talk: whisper's prompt, then the server the answer is about.
    let vocabulary: Promise<Vocabulary> | null = null;
    const words = () => {
      vocabulary ??= deps.chat.vocabulary(place).catch(() => NO_WORDS);
      return vocabulary;
    };
    if (input.audio) {
      spoken = true;
      const heard = await transcribe(input.audio, words);
      if (signal.aborted || !talks.has(id)) return;
      if (heard.kind !== 'ok') return fail(id, heard.reason);
      question = heard.text;
      update(id, { state: 'thinking', question: deskText(question, DESK_QUESTION_MAX) });
    }
    if (!question) return fail(id, 'not_heard');
    let answer: DeskAnswer;
    const stopWorking = workingAfter(id);
    try {
      answer = await deps.chat.ask(
        place,
        {
          text: question,
          spoken,
          talkId: id,
          thread: continuable(place, input.continue),
          ...(about ? { server: { id: about.id, name: about.name } } : {}),
        },
        (thread) => {
          if (talks.has(id)) noteThread(place, thread);
        },
        signal,
      );
    } catch (err) {
      log.warn({ err: errorCode(err) }, 'desk talk: the question could not be posted');
      return fail(id, 'failed');
    } finally {
      stopWorking();
    }
    if (signal.aborted || !talks.has(id)) return;
    await settle(id, answer, question, words, signal, about);
  }

  /** The answer on the screen, said when Talk is on and the box can say it (DK-06); `question` names a server too. */
  async function settle(
    id: string,
    answer: DeskAnswer,
    question: string | null,
    words: () => Promise<Vocabulary>,
    signal: AbortSignal,
    about: DeskServer | null = null,
  ): Promise<void> {
    if (answer.kind !== 'answered') return fail(id, answer.kind === 'slow' ? 'slow' : 'failed');
    const said = speechText(answer.text);
    if (!said) return fail(id, 'failed');
    // Asked about a server on its screen, the answer is about that one (DK-85); else the one it names.
    const thing = about ?? (await thingOf(said, question ?? '', (await words()).servers));
    const audio = (await host.voiceOn()) ? await speak(said) : null;
    if (signal.aborted) return;
    const r = update(id, { state: 'answered', answer: said, thing, audio: audio !== null });
    if (r) r.messageId = answer.messageId ?? null;
    if (r && audio) {
      r.audio = audio;
      r.dropAudio = timers.after(timings.keepMs, () => {
        r.audio = null;
        r.talk = { ...r.talk, audio: false };
      });
    }
  }

  /** A new talk record (the screen follows it by `id`). */
  function record(id: string, personId: string, talk: Omit<DeskTalk, 'id'>): void {
    talks.set(id, {
      talk: { id, ...talk },
      personId,
      at: timers.now(),
      audio: null,
      dropAudio: null,
      messageId: null,
    });
    prune();
  }

  /** What the conversation's messages carry of the talks still kept (DK-T15): the question's, the answer's. */
  function talkParts(): Map<string, { talk: string; audio: boolean; thing: DeskServer | null }> {
    const parts = new Map<string, { talk: string; audio: boolean; thing: DeskServer | null }>();
    for (const r of talks.values())
      if (r.messageId)
        parts.set(r.messageId, { talk: r.talk.id, audio: r.audio !== null, thing: r.talk.thing });
    return parts;
  }

  async function transcribe(
    audio: Buffer,
    words: () => Promise<Vocabulary>,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'failed'; reason: DeskTalkReason }> {
    // A recording of nothing is nothing heard (and whisper makes words up for silence).
    if (wavPeak(checkDeskWav(audio)) < SILENCE_PEAK) return { kind: 'failed', reason: 'not_heard' };
    const voice = deps.voice();
    if (!voice) return { kind: 'failed', reason: 'voice_unavailable' };
    const prompt = sttPrompt(await words());
    try {
      // Voice typing's model and language, to a speech service that knows them (3.1: its health names its models).
      const chosen = (await deps.health()).models
        ? await deps.voiceSettings?.().catch(() => undefined)
        : undefined;
      const settings = chosen ? { model: chosen.model, language: chosen.language } : undefined;
      const heard = heardText((await voice.stt(audio, prompt || undefined, settings)).text);
      return heard ? { kind: 'ok', text: heard } : { kind: 'failed', reason: 'not_heard' };
    } catch (err) {
      log.warn({ err: errorCode(err) }, 'desk talk: speech to text failed');
      const gone = err instanceof VoiceCallError && (err.code === 'unavailable' || err.code === 'busy');
      return { kind: 'failed', reason: gone ? 'voice_unavailable' : 'failed' };
    }
  }

  async function speak(text: string): Promise<Buffer | null> {
    const voice = deps.voice();
    if (!voice) return null;
    const can = await deps.health();
    if (!can.tts || !can.speaker) return null;
    try {
      // The person's voice when the service has it (DK-S53); a voice it doesn't list would be refused.
      const chosen = (await Promise.resolve(host.speechVoice?.()).catch(() => null)) ?? null;
      const named = chosen && can.voices?.includes(chosen) ? chosen : undefined;
      // A Dutch answer in the service's Dutch voice only while the saved setting is on (not merely when files exist),
      // falling back to English if Dutch speech isn't installed or stopped being available mid-flight.
      const dutchOn = (await deps.dutchVoiceOn?.().catch(() => false)) === true;
      if (dutchOn && can.languages?.includes('nl') && speechLanguage(text) === 'nl') {
        try {
          return await voice.tts(dutchSpeechText(text), named, 'nl');
        } catch (err) {
          log.warn({ err: errorCode(err) }, 'desk talk: Dutch speech failed, falling back to English');
        }
      }
      return await voice.tts(text, named);
    } catch (err) {
      log.warn({ err: errorCode(err) }, 'desk talk: text to speech failed');
      return null;
    }
  }

  async function thingOf(answer: string, question: string, names: string[]): Promise<DeskServer | null> {
    const name = firstNamed(answer, names) ?? firstNamed(question, names);
    if (!name) return null;
    return (await Promise.resolve(host.deskServerByName(name)).catch(() => null)) ?? null;
  }

  return {
    async start(input) {
      if (active) {
        // A talk still waiting after 90 s doesn't hold the next question (DK-T18): its wait ends (`slow`, its answer
        // still comes into the conversation); one in its first 90 s does.
        const waiting = active.id ? talks.get(active.id) : undefined;
        if (waiting?.talk.state !== 'working')
          throw new DeskTalkError('busy', 'Talk is busy with the last question.');
        const ended = active;
        update(waiting.talk.id, { state: 'failed', reason: 'slow' });
        ended.abort.abort();
        if (active === ended) active = null;
      }
      const abort = new AbortController();
      const claim = { id: null as string | null, abort };
      active = claim;
      try {
        const place = await host.place();
        if (!place) throw new DeskTalkError('not_paired', 'The screen isn’t paired.');
        if (!(await host.unlocked())) throw new DeskTalkError('locked', 'The screen is locked.');
        const text = input.text?.trim() ?? '';
        const audio = input.audioWav ?? null;
        if (Boolean(text) === Boolean(audio))
          throw new DeskTalkError('bad_request', 'Say or type one question.');
        if ([...text].length > DESK_TALK_TEXT_MAX) throw new DeskTalkError('bad_request', 'That’s too long.');
        if (audio) {
          try {
            checkDeskWav(audio);
          } catch (err) {
            throw new DeskTalkError('bad_audio', err instanceof WavError ? err.message : 'bad audio');
          }
          if (!(await host.voiceOn()) || !deps.voice() || !(await deps.health()).stt)
            throw new DeskTalkError('voice_unavailable', 'Talking isn’t available.');
        }
        // Someone else's talks never show for the person paired now.
        if ([...talks.values()].some((r) => r.personId !== place.personId)) reset();
        const id = `dtk_${randomIdBody(12)}`;
        claim.id = id;
        record(id, place.personId, {
          state: audio ? 'transcribing' : 'thinking',
          ...(text ? { question: deskText(text, DESK_QUESTION_MAX) } : {}),
          thing: input.about ? { ...input.about } : null,
          audio: false,
        });
        void run(
          id,
          place,
          {
            text: text || null,
            audio,
            continue: input.continue,
            about: input.about,
            spoken: input.spoken === true,
          },
          abort.signal,
        )
          .catch((err: unknown) => {
            log.warn({ err: errorCode(err) }, 'desk talk failed');
            fail(id, 'failed');
          })
          .finally(() => {
            if (active === claim) active = null;
          });
        return { id };
      } catch (err) {
        if (active === claim && claim.id === null) active = null;
        throw err;
      }
    },
    get(id) {
      prune();
      const r = talks.get(id);
      return r ? view(r) : null;
    },
    audio(id) {
      prune();
      return talks.get(id)?.audio ?? null;
    },
    latest() {
      prune();
      const ids = [...talks.keys()];
      const r = ids.length ? talks.get(ids[ids.length - 1] as string) : undefined;
      return r ? view(r) : null;
    },
    forget: stop,
    close() {
      stop();
      offWatch();
    },
    open: current,
    end: endConversation,
    async session() {
      const c = current();
      if (!c) return { v: 1, open: false, messages: [], earlier: 0 };
      const key = `${c.conversationId}:${c.rootId ?? ''}:${c.startedAt}`;
      const now = timers.now();
      let read = view_;
      if (!read || read.key !== key || read.changes !== changes || now - read.at > timings.sessionMaxAgeMs) {
        const seen = changes;
        const got = await deps.chat.read(
          { burrowId: c.burrowId, personId: c.personId },
          c,
          DESK_SESSION_MESSAGES,
        );
        read = { key, changes: seen, at: now, read: got };
        // A conversation closed or replaced meanwhile isn't kept.
        if (conversation === c) view_ = read;
      }
      const shown = conversationMessages(read.read.messages, {
        personId: c.personId,
        agentId: read.read.agentId,
        talks: talkParts(),
        now,
      });
      const fit = fitSession(shown, read.read.earlier);
      const working = read.read.working;
      return {
        v: 1,
        open: true,
        messages: fit.messages,
        earlier: fit.earlier,
        until: new Date(c.lastAt + timings.sessionIdleMs).toISOString(),
        // The assistant working in it now (TF-17).
        ...(working
          ? { working: { since: working.since, ...(working.doing ? { doing: working.doing } : {}) } }
          : {}),
      };
    },
    async follow() {
      const c = current();
      if (!c || active) return null;
      const abort = new AbortController();
      const claim = { id: null as string | null, abort };
      active = claim;
      const place = { burrowId: c.burrowId, personId: c.personId };
      let listening: Awaited<ReturnType<DeskChat['listen']>>;
      try {
        listening = await deps.chat.listen(place, { conversationId: c.conversationId, rootId: c.rootId });
      } catch (err) {
        if (active === claim) active = null;
        log.warn({ err: errorCode(err) }, 'desk talk: the assistant’s next words can’t be followed');
        return null;
      }
      const id = `dtk_${randomIdBody(12)}`;
      claim.id = id;
      record(id, place.personId, { state: 'thinking', thing: null, audio: false });
      let vocabulary: Promise<Vocabulary> | null = null;
      const words = () => {
        vocabulary ??= deps.chat.vocabulary(place).catch(() => NO_WORDS);
        return vocabulary;
      };
      // A follow talk is `working` after 90 s too, and waits for the next words as long (TF-16).
      const stopWorking = workingAfter(id);
      void listening
        .wait(abort.signal)
        .then(async (answer) => {
          stopWorking();
          if (abort.signal.aborted || !talks.has(id)) return;
          await settle(id, answer, null, words, abort.signal);
        })
        .catch((err: unknown) => {
          log.warn({ err: errorCode(err) }, 'desk talk: following the assistant failed');
          fail(id, 'failed');
        })
        .finally(() => {
          stopWorking();
          listening.stop();
          if (active === claim) active = null;
        });
      return {
        id,
        cancel() {
          abort.abort();
          if (active === claim) active = null;
          const r = talks.get(id);
          if (r) drop(id, r);
        },
      };
    },
  };

  /** Drops the talks and the conversation (the screen is someone else's now). */
  function reset(): void {
    for (const [id, r] of talks) drop(id, r);
    endConversation();
  }

  /** …and stops the one that runs: its answer still lands in Chat, the screen no longer waits for it. */
  function stop(): void {
    active?.abort.abort();
    active = null;
    reset();
  }
}

function errorCode(err: unknown): string {
  if (err instanceof ApiError || err instanceof VoiceCallError || err instanceof DeskTalkError)
    return err.code;
  return err instanceof Error ? err.name : 'error';
}

/* Words ----------------------------------------------------------------------------------------------------------- */

/**
 * What whisper heard, as a question: its notes about the sound (“[BLANK_AUDIO]”, “(silence)”, “*coughs*”) go, and
 * what has no letter or digit left is nothing.
 */
export function heardText(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? deskText(text, DESK_QUESTION_MAX) : '';
}

/**
 * What Talk's mic heard (`hear`), for the screen's box: one line of at most `DESK_TALK_TEXT_MAX`
 * code points, cut after the last whole word that fits (the person sees it before it is sent, so no ellipsis).
 */
export function deskHeardText(text: string): string {
  const clean = deskText(text, Number.MAX_SAFE_INTEGER);
  const points = [...clean];
  if (points.length <= DESK_TALK_TEXT_MAX) return clean;
  const cut = points.slice(0, DESK_TALK_TEXT_MAX + 1).join('');
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : [...cut].slice(0, DESK_TALK_TEXT_MAX).join('')).trimEnd();
}

/**
 * The prompt whisper gets (≤ 400 characters): the names it should spell the way Whombat does — the assistant's, then
 * the servers', then the things'.
 */
export function sttPrompt(v: Vocabulary): string {
  const names = [
    ...new Set([v.assistant ?? '', ...v.servers, ...v.things].map((n) => deskText(n, 60))),
  ].filter(Boolean);
  let out = '';
  for (const name of names) {
    const next = out ? `${out}, ${name}` : name;
    if (next.length + 1 > VOICE_PROMPT_MAX) break;
    out = next;
  }
  return out ? `${out}.` : '';
}

function inlineSpeech(nodes: readonly Inline[]): string {
  return nodes
    .map((n): string => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'mention':
          return n.text.replace(/^@/, '');
        case 'break':
          return ' ';
        case 'image':
        case 'strike':
          return '';
        case 'link': {
          const words = inlineSpeech(n.children).trim();
          return words === n.href || /^[a-z]+:\/\//i.test(words) ? '' : words;
        }
        default:
          return inlineSpeech(n.children);
      }
    })
    .join('');
}

/** A sentence ends with its mark; a heading or a list item without one gets a full stop. */
function sentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?…:;]$/.test(t) ? t : `${t}.`;
}

function blockSpeech(block: Block): string[] {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return [sentence(inlineSpeech(block.children))];
    case 'quote':
      return block.children.flatMap(blockSpeech);
    case 'list':
      return block.items.flatMap((item) => item.flatMap(blockSpeech));
    // Code, tables and rules aren't for hearing (the runner's desk line asks for none).
    default:
      return [];
  }
}

/**
 * The answer as the screen shows and says it (≤ 600 characters): the assistant's light Markdown made plain — bold and
 * italics as their words, mentions as names, links as their words (a bare address goes), lists as sentences; no code,
 * tables or images. A longer answer ends at its last whole sentence that fits.
 */
export function speechText(markdown: string): string {
  const text = parseMessage(markdown)
    .flatMap(blockSpeech)
    .filter(Boolean)
    .join(' ')
    .replace(/[\p{Cc}\p{Z}\s]+/gu, ' ')
    .trim();
  const flat = deskText(text, Number.MAX_SAFE_INTEGER);
  if ([...flat].length <= DESK_ANSWER_MAX) return flat;
  const cut = [...flat].slice(0, DESK_ANSWER_MAX).join('');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > DESK_ANSWER_MAX / 3 ? cut.slice(0, end + 1) : deskText(flat, DESK_ANSWER_MAX);
}

function nameRe(name: string): RegExp | null {
  const parts = name
    .trim()
    .split(/[-_.\s]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  const part = (p: string) =>
    /^\d+$/.test(p) ? `0*${String(Number(p))}` : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(part).join('[-_.\\s]?')}(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * The first of `names` the text names (“is pve-02 okay?”, “PVE 2”, “pve02”: case, separators and leading zeros don't
 * matter); at the same place the longer name wins.
 */
export function firstNamed(text: string, names: readonly string[]): string | null {
  let best: { name: string; at: number } | null = null;
  for (const name of names) {
    const at = nameRe(name)?.exec(text)?.index;
    if (at === undefined) continue;
    if (!best || at < best.at || (at === best.at && name.length > best.name.length)) best = { name, at };
  }
  return best?.name ?? null;
}

/* The conversation as the screen shows it (DK-T15) ------------------------------------------------------------------ */

/** The words for a message that has nothing to read on the screen (only a picture, a file, a card). */
export const SEE_IN_CHAT = 'There’s something to see in Chat.';

function inlineText(nodes: readonly Inline[]): string {
  return inlineSpeech(nodes).replace(/\s+/g, ' ').trim();
}

/**
 * A message made plain for the screen (DK-T15): paragraphs and headings one each, list items each with “• ”, quotes as
 * their paragraphs; at most `DESK_SESSION_PARAGRAPHS` of at most `DESK_ANSWER_MAX` code points. `more` when something is
 * only in Chat: code, a table, a rule, a picture, or anything cut.
 */
export function sessionParagraphs(markdown: string): { paragraphs: string[]; more: boolean } {
  const out: string[] = [];
  let more = false;
  const add = (text: string) => {
    const flat = text.replace(/[\p{Cc}\p{Z}\s]+/gu, ' ').trim();
    if (!flat) return;
    if (out.length >= DESK_SESSION_PARAGRAPHS) {
      more = true;
      return;
    }
    const fit = deskText(flat, DESK_ANSWER_MAX);
    if ([...fit].length < [...flat].length) more = true;
    if (fit) out.push(fit);
  };
  const walk = (block: Block) => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        if (block.children.some((n) => n.type === 'image')) more = true;
        add(inlineText(block.children));
        return;
      case 'quote':
        for (const child of block.children) walk(child);
        return;
      case 'list':
        for (const item of block.items) {
          const words = item
            .flatMap((b) => (b.type === 'paragraph' || b.type === 'heading' ? [inlineText(b.children)] : []))
            .filter(Boolean)
            .join(' ');
          if (item.some((b) => b.type !== 'paragraph' && b.type !== 'heading')) more = true;
          if (words) add(`• ${words}`);
        }
        return;
      default:
        more = true;
    }
  };
  for (const block of parseMessage(markdown)) walk(block);
  return { paragraphs: out, more };
}

const ASK_STATES = { pending: 'waiting', approved: 'approved', declined: 'denied' } as const;

/**
 * A task card as the conversation's live row (TF-17, DK-T20): its paragraph the card's one line as Chat shows it
 * (`taskCardLine` at `now`: “Installing 23 updates on Home Assistant · 12 s”, then how it went and how long it took), so
 * a screen that doesn't know `task` still says something useful; `task` the card's facts for the live row.
 */
export function deskTaskRow(card: TaskCard, now: number): Pick<DeskSessionMessage, 'paragraphs' | 'task'> {
  const result = card.state !== 'running' && card.result ? deskText(card.result, DESK_ANSWER_MAX) : '';
  const line = deskText(taskCardLine(card, now), DESK_ANSWER_MAX);
  return {
    paragraphs: [line || deskText(card.title, DESK_ANSWER_MAX) || SEE_IN_CHAT],
    task: {
      title: deskText(card.title, 120) || SEE_IN_CHAT,
      state: card.state,
      startedAt: card.startedAt,
      ...(card.state !== 'running' ? { endedAt: card.endedAt ?? card.startedAt } : {}),
      ...(result ? { result } : {}),
    },
  };
}

/**
 * The conversation's messages as the screen shows them (DK-T15): the person's (`you`) and the assistant's only, not
 * deleted; an approval's card as its `ask`, a task card as a live `task` row (TF-17), a sign-in card as its title and
 * “Answer on your phone or computer” (VLT-41), a failed turn's card left out, a message with nothing to read as
 * `SEE_IN_CHAT`; the talks still kept marked on their question (its client id) and
 * their answer (its message id).
 */
export function conversationMessages(
  messages: readonly Message[],
  ctx: {
    personId: string;
    agentId: string | null;
    talks: ReadonlyMap<string, { talk: string; audio: boolean; thing: DeskServer | null }>;
    /** Now (ms): a running task's line says how long it has run. Default: the clock. */
    now?: number;
  },
): DeskSessionMessage[] {
  const out: DeskSessionMessage[] = [];
  for (const m of messages) {
    if (m.deletedAt) continue;
    const from = m.authorId === ctx.personId ? 'you' : m.authorId === ctx.agentId ? 'assistant' : null;
    if (!from) continue;
    if (m.card?.kind === 'turn_failed' && !m.text.trim()) continue;
    if (m.card?.kind === 'task') {
      out.push({ id: m.id, from, at: m.createdAt, ...deskTaskRow(m.card, ctx.now ?? Date.now()) });
      continue;
    }
    // A sign-in card (`vault_ask`, vault-simplify.md VLT-41): its title and where to answer it, never a field; a shared
    // screen is no place to type a password. Once answered, its locked line (never a value).
    if (m.card?.kind === 'guide' && m.card.guide === 'secret') {
      const title = deskText(m.card.title, DESK_ANSWER_MAX);
      const line =
        m.card.state === 'open' ? VAULT_ASK_TEXT.desk : deskText(m.card.answer?.label ?? '', DESK_ANSWER_MAX);
      out.push({ id: m.id, from, at: m.createdAt, paragraphs: [title, line].filter(Boolean) });
      continue;
    }
    const { paragraphs, more } = sessionParagraphs(m.text);
    const approval = m.card?.kind === 'approval' ? m.card.approval : null;
    if (approval && paragraphs.length === 0) {
      const words = deskText(approval.question || approval.title, DESK_ANSWER_MAX);
      if (words) paragraphs.push(words);
    }
    const extra =
      more || m.attachments.length > 0 || (!!m.card && !approval && m.card.kind !== 'turn_failed');
    if (paragraphs.length === 0) paragraphs.push(SEE_IN_CHAT);
    const asked = from === 'you' ? deskTalkIdOf(m.clientId) : null;
    const answered = from === 'assistant' ? ctx.talks.get(m.id) : undefined;
    out.push({
      id: m.id,
      from,
      at: m.createdAt,
      paragraphs,
      ...(extra && paragraphs[0] !== SEE_IN_CHAT ? { more: true } : {}),
      ...(approval ? { ask: { number: approval.number, state: ASK_STATES[approval.state] } } : {}),
      ...(asked ? { talk: asked } : {}),
      ...(answered
        ? {
            talk: answered.talk,
            ...(answered.audio ? { audio: true } : {}),
            ...(answered.thing ? { thing: answered.thing } : {}),
          }
        : {}),
    });
  }
  return out;
}

/**
 * Whether a message is in the open conversation (DK-S62): the thread's root or a reply in it; in a flat room, anything
 * in the room.
 */
export function inConversation(
  c: DeskThread,
  at: { conversationId: string; messageId: string | null; threadRootId: string | null },
): boolean {
  if (at.conversationId !== c.conversationId) return false;
  return c.rootId === null || at.messageId === c.rootId || at.threadRootId === c.rootId;
}

/** The newest messages that fit `DESK_SESSION_MAX_BYTES` (with room for the rest of the answer); the others counted. */
export function fitSession(
  messages: DeskSessionMessage[],
  earlier: number,
  max = DESK_SESSION_MAX_BYTES - 1_024,
): { messages: DeskSessionMessage[]; earlier: number } {
  let kept = messages.slice(-DESK_SESSION_MESSAGES);
  let dropped = earlier + (messages.length - kept.length);
  const size = (m: DeskSessionMessage) => Buffer.byteLength(JSON.stringify(m)) + 1;
  let total = kept.reduce((n, m) => n + size(m), 0);
  while (kept.length > 0 && total > max) {
    total -= size(kept[0] as DeskSessionMessage);
    kept = kept.slice(1);
    dropped++;
  }
  return { messages: kept, earlier: dropped };
}

/* Chat ------------------------------------------------------------------------------------------------------------ */

/** What the reply watch waits for: the assistant's messages in this thread after the question, and its turn's end. */
export interface ReplyWant {
  conversationId: string;
  /** The thread the assistant answers in; null: top level of a flat room. */
  thread: string | null;
  /** The question's time (ISO): earlier messages are someone else's answer. */
  after: string;
  /** The turn the question woke, when one was queued for it; a merged one is followed into the running turn. */
  dispatchId: string | null;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
/** Frames kept while the question is being posted (the turn can't have said much before it knows the question). */
const BUFFER_MAX = 200;

/** What an assistant's message says, for the screen; '' when it says nothing to a person (a failed turn's card). */
function replyText(m: Message): string {
  // A task card says what Whombat is doing, not the answer: the agent's own words come in its turn (TF-12, DK-T20).
  if (m.card?.kind === 'turn_failed' || m.card?.kind === 'task') return '';
  const text = m.text.trim();
  if (text) return text;
  if (m.card?.kind === 'approval') return m.card.approval.question || m.card.approval.title;
  return '';
}

/**
 * Waits on the realtime bus for the assistant's answer to a desk question (DK-T06): the last of its messages in the
 * thread when its turn ends; or, when the turn goes on after it said something, that message once nothing more came for
 * `settleMs`. Nothing by `waitMaxMs` (30 minutes since TF-16; the talk is `working` meanwhile): `slow`. A turn that
 * ended without a word: `failed`. It listens from before the question is posted (so nothing is missed) and keeps the
 * assistant's frames until it knows where to look.
 */
export class ReplyWatch {
  #want: ReplyWant | null = null;
  #buffer: BusFrame[] = [];
  #replies: { text: string; id: string }[] = [];
  #resolve: ((answer: DeskAnswer) => void) | null = null;
  #cancel: (() => void)[] = [];
  #settle: (() => void) | null = null;
  #done = false;
  readonly #off: () => void;

  constructor(
    bus: { onFrame(listener: (frame: BusFrame) => void): () => void },
    private readonly agentId: string,
    private readonly timers: DeskTalkTimers,
    private readonly timings: Pick<DeskTalkTimings, 'waitMaxMs' | 'settleMs'>,
    /** A follow talk's (DK-T16): a turn that ends before the assistant said anything doesn't end the wait. */
    private readonly untilWords = false,
  ) {
    this.#off = bus.onFrame((frame) => this.#frame(frame));
  }

  wait(want: ReplyWant, signal?: AbortSignal): Promise<DeskAnswer> {
    return new Promise((resolve) => {
      this.#resolve = resolve;
      this.#want = want;
      this.#cancel.push(
        this.timers.after(this.timings.waitMaxMs, () => this.#finish(this.#answer() ?? { kind: 'slow' })),
      );
      if (signal) {
        if (signal.aborted) return this.#finish({ kind: 'failed' });
        signal.addEventListener('abort', () => this.#finish({ kind: 'failed' }), { once: true });
      }
      for (const frame of this.#buffer.splice(0)) this.#frame(frame);
    });
  }

  stop(): void {
    this.#off();
    this.#settle?.();
    for (const cancel of this.#cancel.splice(0)) cancel();
    this.#done = true;
  }

  #answer(): DeskAnswer | null {
    const last = this.#replies[this.#replies.length - 1];
    return last ? { kind: 'answered', text: last.text, messageId: last.id } : null;
  }

  #finish(answer: DeskAnswer): void {
    if (this.#done) return;
    this.stop();
    this.#resolve?.(answer);
  }

  #frame(frame: BusFrame): void {
    if (this.#done) return;
    const e = frame.event;
    const mine =
      (e.type === 'message.created' && e.message.authorId === this.agentId) ||
      (e.type === 'dispatch.updated' && e.dispatch.agentId === this.agentId);
    if (!mine) return;
    const want = this.#want;
    if (!want) {
      if (this.#buffer.length < BUFFER_MAX) this.#buffer.push(frame);
      return;
    }
    if (e.type === 'message.created') {
      const m = e.message;
      if (m.conversationId !== want.conversationId || (m.threadRootId ?? null) !== want.thread) return;
      if (m.createdAt < want.after) return;
      const text = replyText(m);
      if (!text) return;
      this.#replies.push({ text, id: m.id });
      this.#settle?.();
      this.#settle = this.timers.after(this.timings.settleMs, () =>
        this.#finish(this.#answer() ?? { kind: 'slow' }),
      );
      return;
    }
    if (e.type !== 'dispatch.updated') return;
    const d = e.dispatch;
    if (d.conversationId !== want.conversationId || (d.threadRootId ?? null) !== want.thread) return;
    if (!TERMINAL.has(d.state)) return;
    if (d.state === 'cancelled' && d.reason === TURN_MERGED_REASON) {
      // The question went into the turn that was running there: its end is the answer's.
      if (d.id === want.dispatchId) want.dispatchId = null;
      return;
    }
    if (want.dispatchId && d.id !== want.dispatchId) return;
    if (this.untilWords && this.#replies.length === 0) return;
    this.#finish(this.#answer() ?? { kind: 'failed' });
  }
}

/** The real `DeskChat`: `start_chat` / `send_message` as the person, the bus for the answer. */
function chatOf(services: Services, timers: DeskTalkTimers, timings: DeskTalkTimings): DeskChat {
  const { db } = services;

  async function people(place: DeskTalkPlace) {
    const person = await loadPrincipalRow(db, place.personId);
    if (person?.kind !== 'person' || person.burrowId !== place.burrowId)
      throw new DeskTalkError('not_paired', 'The paired person isn’t here.');
    const agent = await loadAgentRow(db, person.burrowId);
    return { person, agent: agent ?? null };
  }

  /**
   * The assistant's turn running in the conversation's thread (TF-17, DK-T19): since it was claimed, and what it is
   * doing now as Chat's activity says it (its newest row not yet finished).
   */
  async function workingIn(
    agentId: string,
    conversation: DeskThread,
  ): Promise<{ since: string; doing?: string } | null> {
    const [turn] = await db
      .select({ id: dispatches.id, claimedAt: dispatches.claimedAt, createdAt: dispatches.createdAt })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.agentId, agentId),
          eq(dispatches.conversationId, conversation.conversationId),
          conversation.rootId
            ? eq(dispatches.threadRootId, conversation.rootId)
            : isNull(dispatches.threadRootId),
          inArray(dispatches.state, ['claimed', 'running']),
        ),
      )
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    if (!turn) return null;
    const [now] = await db
      .select({ title: activities.title })
      .from(activities)
      .where(and(eq(activities.dispatchId, turn.id), isNull(activities.finishedAt)))
      .orderBy(desc(activities.updatedAt))
      .limit(1);
    const doing = now ? deskText(now.title, 120) : '';
    return { since: iso(turn.claimedAt ?? turn.createdAt), ...(doing ? { doing } : {}) };
  }

  async function commitOk<R>(promise: Promise<{ status: string; result?: R }>): Promise<R> {
    const res = await promise;
    if (res.status !== 'ok' || res.result === undefined) throw new Error(`desk talk: ${res.status}`);
    return res.result;
  }

  return {
    async ask(place, question, posted, signal) {
      const { agent } = await people(place);
      if (!agent) throw new Error('desk talk: no assistant');
      const watch = new ReplyWatch(services.bus, agent.id, timers, timings);
      try {
        const as = { burrowId: place.burrowId, actorId: place.personId };
        const clientId = deskClientId(question.talkId, question.spoken);
        // The turn the question wakes is told which server the person looks at (DK-85), by its talk.
        if (question.server) rememberTalkServer(services, question.talkId, question.server);
        const after = iso(services.clock());
        let where: DeskThread | null = null;
        let messageId: string | null = null;
        if (question.thread) {
          // A follow-up (DK-06): a reply in the last desk thread, as the person would type it in Chat.
          const thread = question.thread;
          try {
            const sent = await commitOk<{ id: string }>(
              services.pipeline.commit(
                sendMessage,
                {
                  conversationId: thread.conversationId,
                  text: question.text,
                  clientId,
                  ...(thread.rootId ? { threadRootId: thread.rootId } : {}),
                },
                as,
              ),
            );
            where = thread;
            messageId = sent.id;
          } catch (err) {
            // The thread can't take it (deleted, the room archived): the question starts a new one.
            if (!(err instanceof ApiError)) throw err;
          }
        }
        if (!where) {
          const started = await commitOk<{ conversationId: string; messageId: string }>(
            services.pipeline.commit(startChat, { text: question.text, clientId }, as),
          );
          const room = await loadConversationRow(db, started.conversationId);
          const threaded = room ? threadedRoom(room) : false;
          where = { conversationId: started.conversationId, rootId: threaded ? started.messageId : null };
          messageId = started.messageId;
        }
        posted(where);
        const [turn] = messageId
          ? await db
              .select({ id: dispatches.id })
              .from(dispatches)
              .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, agent.id)))
              .orderBy(desc(dispatches.createdAt))
              .limit(1)
          : [];
        return await watch.wait(
          { conversationId: where.conversationId, thread: where.rootId, after, dispatchId: turn?.id ?? null },
          signal,
        );
      } finally {
        watch.stop();
      }
    },

    async listen(place, thread) {
      const { agent } = await people(place);
      if (!agent) throw new Error('desk talk: no assistant');
      const watch = new ReplyWatch(services.bus, agent.id, timers, timings, true);
      const after = iso(services.clock());
      return {
        wait: (signal) =>
          watch.wait(
            { conversationId: thread.conversationId, thread: thread.rootId, after, dispatchId: null },
            signal,
          ),
        stop: () => watch.stop(),
      };
    },

    async read(place, conversation, limit) {
      const { agent } = await people(place);
      const m = messagesTable;
      const where = conversation.rootId
        ? and(
            eq(m.conversationId, conversation.conversationId),
            or(eq(m.id, conversation.rootId), eq(m.threadRootId, conversation.rootId)),
          )
        : and(
            eq(m.conversationId, conversation.conversationId),
            isNull(m.threadRootId),
            gte(m.createdAt, new Date(conversation.startedAt)),
          );
      const [rows, [total]] = await Promise.all([
        db.select().from(m).where(where).orderBy(desc(m.createdAt), desc(m.ord)).limit(limit),
        db.select({ n: count() }).from(m).where(where),
      ]);
      const loaded = await loadMessages(db, rows.reverse(), place.personId);
      return {
        messages: loaded,
        agentId: agent?.id ?? null,
        earlier: Math.max(0, Number(total?.n ?? 0) - rows.length),
        working: agent ? await workingIn(agent.id, conversation) : null,
      };
    },

    watch(changed) {
      return services.bus.onFrame((frame) => {
        const e = frame.event as {
          type: string;
          message?: Message;
          conversationId?: string;
          dispatch?: { conversationId: string; threadRootId: string | null };
          activity?: { conversationId: string; threadRootId: string | null };
        };
        const message = e.message;
        // A turn's state and its activity change what the conversation shows as working (TF-17).
        const turn =
          e.type === 'dispatch.updated' ? e.dispatch : e.type === 'activity.updated' ? e.activity : null;
        const conversationId = message?.conversationId ?? turn?.conversationId ?? e.conversationId;
        if (!conversationId) return;
        changed({
          conversationId,
          posted:
            e.type === 'message.created' && message
              ? { id: message.id, threadRootId: message.threadRootId ?? null }
              : null,
          card:
            e.type === 'message.updated' && message?.card?.kind === 'task'
              ? { id: message.id, threadRootId: message.threadRootId ?? null }
              : null,
          turn: turn ? { threadRootId: turn.threadRootId ?? null } : null,
        });
      });
    },

    async vocabulary(place) {
      const { agent } = await people(place);
      return namesToHear(services, place.burrowId, agent?.name ?? null);
    },
  };
}

/**
 * The names the person may say in a burrow: the assistant's, the servers' and the things'. Whisper is told
 * them when it hears the desk's questions and voice typing (dictation.md).
 */
export async function namesToHear(
  services: Services,
  burrowId: string,
  assistant: string | null,
): Promise<Vocabulary> {
  const hosts = hostsFor(services);
  const servers =
    hosts.present && (await hosts.serves(burrowId).catch(() => false))
      ? await hosts
          .fleetRaw()
          .then((fleet) => arr(fleet.servers).map((s) => String(obj(s).id ?? '')))
          .catch(() => [] as string[])
      : [];
  const things = await services.db
    .select({ label: catalogConnections.label })
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId))
    .limit(40);
  return { assistant, servers: servers.filter(Boolean), things: things.map((t) => t.label) };
}
