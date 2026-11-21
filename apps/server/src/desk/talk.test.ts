/**
 * Talk at the desk screen (desk-display.md DK-06, DK-07; desk-display-talk.md DK-T01…DK-T13): the state machine with a
 * fake Chat, the fake voice and a clock the tests move; the reply watch on a real bus; the words (speech, whisper's
 * prompt and what it heard, the server named) and the turn's mark.
 */
import { DESK_TALK_TEXT_MAX, DeskTalkSession, deskTalkSessionValid } from '@whombat/control-contracts/local';
import type { DispatchSummary, Message, RealtimeEvent, TaskCard } from '@whombat/core';
import { TURN_MERGED_REASON, VAULT_ASK_TEXT, vaultAskCard } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeBus } from '../realtime/bus';
import { silentLogger } from '../services';
import { encodeWav, VoiceCallError } from '../voice/speech';
import { FAKE_TRANSCRIPT, FakeVoice, fakeRecording } from '../voice/testing/fake-voice';
import {
  type ConversationChange,
  type ConversationRead,
  conversationMessages,
  createDeskTalkWith,
  DESK_TALK_TIMINGS,
  type DeskAnswer,
  type DeskChat,
  type DeskQuestion,
  type DeskTalkError,
  type DeskTalkPlace,
  type DeskTalkTimers,
  type DeskThread,
  deskClientId,
  deskHeardText,
  deskTurnOf,
  firstNamed,
  fitSession,
  heardText,
  inConversation,
  ReplyWatch,
  SEE_IN_CHAT,
  sessionParagraphs,
  speechText,
  sttPrompt,
} from './talk';
import {
  deskReaderOf,
  deskScreenShowsTo,
  rememberTalkServer,
  setDeskScreen,
  talkServerOf,
} from './talk-mark';

/** A clock and timers the test moves by hand. */
class ManualTimers implements DeskTalkTimers {
  t = 1_000_000;
  #due: { at: number; fn: () => void }[] = [];
  now(): number {
    return this.t;
  }
  after(ms: number, fn: () => void): () => void {
    const entry = { at: this.t + ms, fn };
    this.#due.push(entry);
    return () => {
      this.#due = this.#due.filter((e) => e !== entry);
    };
  }
  /** Moves the clock, running what falls due on the way. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.#due.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.#due = this.#due.filter((e) => e !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

function server(name: string) {
  return { name, mark: 'proxmox', state: 'ok' as const, note: 'up 41 d' };
}

const PLACE: DeskTalkPlace = { burrowId: 'bur_home', personId: 'prn_mara' };

/** Chat as Talk sees it: questions recorded, answers when the test says. */
class FakeChat implements DeskChat {
  readonly asked: DeskQuestion[] = [];
  vocab = { assistant: 'Dusty', servers: ['pve-02', 'nas-1'], things: ['Plex'] };
  fail = false;
  #pending: ((a: DeskAnswer) => void)[] = [];
  answer: DeskAnswer | null = { kind: 'answered', text: '**pve-02** is fine, up 41 days.' };

  async ask(_place: DeskTalkPlace, q: DeskQuestion, posted: (t: DeskThread) => void): Promise<DeskAnswer> {
    this.asked.push(q);
    if (this.fail) throw new Error('could not post');
    posted(q.thread ?? { conversationId: 'cnv_chat', rootId: `msg_root${this.asked.length}` });
    if (this.answer) return this.answer;
    return new Promise((resolve) => this.#pending.push(resolve));
  }
  /** Answers the question that waits. */
  reply(answer: DeskAnswer): void {
    this.#pending.shift()?.(answer);
  }
  async vocabulary() {
    return this.vocab;
  }
  /** What the conversation holds (`read`), the listeners (`watch`), the follow talks' answers (`listen`). */
  stored: ConversationRead = { messages: [], agentId: 'prn_dusty', earlier: 0 };
  reads = 0;
  readonly #watchers: ((c: ConversationChange) => void)[] = [];
  readonly listened: DeskThread[] = [];
  #next: ((a: DeskAnswer) => void)[] = [];
  async listen(_place: DeskTalkPlace, thread: DeskThread) {
    this.listened.push(thread);
    return {
      wait: (signal: AbortSignal) =>
        new Promise<DeskAnswer>((resolve) => {
          this.#next.push(resolve);
          signal.addEventListener('abort', () => resolve({ kind: 'failed' }), { once: true });
        }),
      stop: () => {},
    };
  }
  /** The assistant's next words for a follow talk. */
  says(answer: DeskAnswer): void {
    this.#next.shift()?.(answer);
  }
  async read() {
    this.reads++;
    return this.stored;
  }
  watch(changed: (c: ConversationChange) => void) {
    this.#watchers.push(changed);
    return () => {};
  }
  /** A frame on the bus about a conversation. */
  change(c: ConversationChange): void {
    for (const w of this.#watchers) w(c);
  }
}

function setup() {
  const timers = new ManualTimers();
  const chat = new FakeChat();
  const voice = new FakeVoice();
  const host = {
    paired: PLACE as DeskTalkPlace | null,
    open: true,
    talkOn: true,
    chosen: null as string | null,
    place: () => host.paired,
    unlocked: () => host.open,
    voiceOn: () => host.talkOn,
    speechVoice: () => host.chosen,
    deskServerByName: (name: string) =>
      ['pve-02', 'nas-1'].includes(name.toLowerCase()) ? server(name.toLowerCase()) : null,
    uses: 0,
    used: () => {
      host.uses++;
    },
  };
  let hasVoice = true;
  const talks = createDeskTalkWith({
    host,
    chat,
    voice: () => (hasVoice ? voice : null),
    health: () => voice.health(),
    voiceSettings: async () => ({ model: 'whisper', language: 'nl' }),
    timers,
    timings: DESK_TALK_TIMINGS,
    log: silentLogger,
  });
  return {
    talks,
    chat,
    voice,
    host,
    timers,
    noVoice: () => {
      hasVoice = false;
    },
  };
}

type Setup = ReturnType<typeof setup>;

/** Waits until the talk got there (the talk runs on promises, not on the test's clock). */
async function reaches(s: Setup, id: string, state: string) {
  await vi.waitFor(() => expect(s.talks.get(id)?.state).toBe(state), { interval: 1, timeout: 2000 });
  return s.talks.get(id);
}

async function refusal(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (err: DeskTalkError) => `${err.code} ${err.status}`,
  );
}

describe('a typed question (DK-06)', () => {
  it('goes to Chat, then the screen has the answer made plain, spoken, with the server it is about', async () => {
    const s = setup();
    s.chat.answer = null;
    const { id } = await s.talks.start({ text: 'Is my Proxmox box okay?', continue: false });
    const thinking = await reaches(s, id, 'thinking');
    expect(thinking).toMatchObject({ question: 'Is my Proxmox box okay?', audio: false, thing: null });
    expect(s.chat.asked[0]).toMatchObject({
      text: 'Is my Proxmox box okay?',
      spoken: false,
      talkId: id,
      thread: null,
    });
    s.chat.reply({
      kind: 'answered',
      text: '**pve-02** is fine — up [41 days](https://x.test). See `uptime`.',
    });
    const done = await reaches(s, id, 'answered');
    expect(done?.answer).toBe('pve-02 is fine — up 41 days. See uptime.');
    expect(done?.thing?.name).toBe('pve-02');
    expect(done?.audio).toBe(true);
    expect(s.talks.audio(id)?.toString('latin1', 0, 4)).toBe('RIFF');
    expect(s.voice.calls).toContainEqual({ kind: 'tts', text: 'pve-02 is fine — up 41 days. See uptime.' });
    expect(s.talks.latest()?.id).toBe(id);
  });

  it('asked from a server’s screen, is about that server, and its turn is told which (DK-85)', async () => {
    const s = setup();
    s.chat.answer = null;
    const about = { ...server('pve-01'), id: 'pve-01' };
    const { id } = await s.talks.start({ text: 'why is it busy?', continue: false, about });
    expect(await reaches(s, id, 'thinking')).toMatchObject({ thing: { id: 'pve-01', name: 'pve-01' } });
    expect(s.chat.asked[0]).toMatchObject({
      text: 'why is it busy?',
      server: { id: 'pve-01', name: 'pve-01' },
    });
    // The answer names another server; the talk is still about the one on the screen.
    s.chat.reply({ kind: 'answered', text: 'It’s backing up to nas-1, done in ten minutes.' });
    expect((await reaches(s, id, 'answered'))?.thing).toMatchObject({ id: 'pve-01' });
    const plain = await s.talks.start({ text: 'and nas-1?', continue: true });
    expect(s.chat.asked[1]).not.toHaveProperty('server');
    s.chat.reply({ kind: 'answered', text: 'nas-1 is fine.' });
    expect((await reaches(s, plain.id, 'answered'))?.thing?.name).toBe('nas-1');
  });

  it('shows the server the question named when the answer names none', async () => {
    const s = setup();
    s.chat.answer = { kind: 'answered', text: 'It’s fine, nothing to do.' };
    const { id } = await s.talks.start({ text: 'is NAS 1 okay?', continue: false });
    expect((await reaches(s, id, 'answered'))?.thing?.name).toBe('nas-1');
  });

  it('says nothing aloud with Talk off in Settings, and nothing on a box without a speaker', async () => {
    const s = setup();
    s.host.talkOn = false;
    const a = await s.talks.start({ text: 'Is pve-02 okay?', continue: false });
    expect((await reaches(s, a.id, 'answered'))?.audio).toBe(false);
    s.host.talkOn = true;
    s.voice.ability = { ...s.voice.ability, speaker: false };
    const b = await s.talks.start({ text: 'And now?', continue: false });
    expect((await reaches(s, b.id, 'answered'))?.audio).toBe(false);
    expect(s.voice.calls.filter((c) => c.kind === 'tts')).toEqual([]);
  });

  it('is said in the voice the person chose when the box has it, else in the box’s own (DK-50, DK-S53)', async () => {
    const s = setup();
    const ask = async (text: string) => {
      const { id } = await s.talks.start({ text, continue: false });
      expect((await reaches(s, id, 'answered'))?.audio).toBe(true);
    };
    await ask('Is pve-02 okay?');
    s.host.chosen = 'george';
    await ask('And now?');
    s.voice.ability = { ...s.voice.ability, voices: ['heart', 'bella'] };
    await ask('And now?');
    // A voice service from before 0.105: no voices, so none is named.
    s.voice.ability = { stt: true, tts: true, microphone: true, speaker: true };
    await ask('And now?');
    const voices = s.voice.calls.map((c) => (c.kind === 'tts' ? (c.voice ?? 'default') : null));
    expect(voices).toEqual(['default', 'george', 'default', 'default']);
  });

  it('is said in Dutch, written out, when it is Dutch and the box speaks Dutch (DK-T22, DK-T23)', async () => {
    const s = setup();
    s.host.chosen = 'george';
    const ask = async (text: string) => {
      s.chat.answer = { kind: 'answered', text };
      const { id } = await s.talks.start({ text: 'Hoe gaat het?', continue: false });
      return reaches(s, id, 'answered');
    };
    const dutch = await ask('Ja, **pve-02** draait prima: de back-up was om 03:00 klaar.');
    // The screen shows the answer as written; the voice gets it as it is said.
    expect(dutch?.answer).toBe('Ja, pve-02 draait prima: de back-up was om 03:00 klaar.');
    expect(dutch?.audio).toBe(true);
    await ask('Yes, pve-02 is fine.');
    // A voice service from before 3.4 speaks English only: the Dutch answer goes as it is, without a language.
    s.voice.ability = { ...s.voice.ability, languages: undefined };
    await ask('Ja, alles draait.');
    const said = s.voice.calls.filter((c) => c.kind === 'tts');
    expect(said[0]).toMatchObject({ voice: 'george', language: 'nl' });
    expect(said[0]?.kind === 'tts' && said[0].text).toContain('P V E nul twee');
    expect(said[0]?.kind === 'tts' && said[0].text).toContain('drie uur');
    expect(said[1]).toEqual({ kind: 'tts', text: 'Yes, pve-02 is fine.', voice: 'george' });
    expect(said[2]).toEqual({ kind: 'tts', text: 'Ja, alles draait.', voice: 'george' });
  });

  it('is still working after 90 s (slow), or couldn’t be asked (failed)', async () => {
    const s = setup();
    s.chat.answer = { kind: 'slow' };
    const a = await s.talks.start({ text: 'Is pve-02 okay?', continue: false });
    expect(await reaches(s, a.id, 'failed')).toMatchObject({ reason: 'slow', question: 'Is pve-02 okay?' });
    s.chat.fail = true;
    const b = await s.talks.start({ text: 'Again?', continue: false });
    expect((await reaches(s, b.id, 'failed'))?.reason).toBe('failed');
  });
});

describe('a spoken question (DK-06, DK-07)', () => {
  it('heard by Talk’s mic and sent as text, is asked as spoken without hearing it again', async () => {
    const s = setup();
    const { id } = await s.talks.start({ text: 'Is nas-1 full?', continue: false, spoken: true });
    expect(s.talks.get(id)).toMatchObject({ state: 'thinking', question: 'Is nas-1 full?' });
    await vi.waitFor(() => expect(s.chat.asked[0]).toMatchObject({ text: 'Is nas-1 full?', spoken: true }));
    expect(s.voice.calls.filter((c) => c.kind === 'stt')).toEqual([]);
  });

  it('is transcribed with the names it may hold, then asked as spoken', async () => {
    const s = setup();
    s.voice.hold();
    const { id } = await s.talks.start({ audioWav: fakeRecording(2), continue: false });
    expect(await reaches(s, id, 'transcribing')).toMatchObject({ audio: false });
    expect(s.talks.get(id)?.question).toBeUndefined();
    s.voice.release();
    expect((await reaches(s, id, 'answered'))?.question).toBe(FAKE_TRANSCRIPT);
    const stt = s.voice.calls.find((c) => c.kind === 'stt');
    expect(stt?.kind === 'stt' && stt.prompt).toBe('Dusty, pve-02, nas-1, Plex.');
    expect(s.chat.asked[0]).toMatchObject({ text: FAKE_TRANSCRIPT, spoken: true });
  });

  it('is heard with voice typing’s model and language by a speech service that knows them', async () => {
    const s = setup();
    const a = await s.talks.start({ audioWav: fakeRecording(1), continue: false });
    await reaches(s, a.id, 'answered');
    // A service from before 3.1 (no models in its health) would refuse them.
    expect(s.voice.calls.find((c) => c.kind === 'stt')).not.toHaveProperty('model');
    s.voice.ability = { ...s.voice.ability, models: ['parakeet', 'whisper'] };
    const b = await s.talks.start({ audioWav: fakeRecording(1), continue: false });
    await reaches(s, b.id, 'answered');
    expect(s.voice.calls.filter((c) => c.kind === 'stt').at(-1)).toMatchObject({
      model: 'whisper',
      language: 'nl',
    });
  });

  it('hears nothing in silence (no transcribing at all) and in whisper’s notes about the sound', async () => {
    const s = setup();
    const a = await s.talks.start({ audioWav: fakeRecording(1, { silent: true }), continue: false });
    expect((await reaches(s, a.id, 'failed'))?.reason).toBe('not_heard');
    expect(s.voice.calls).toEqual([]);
    s.voice.transcripts.push(' [BLANK_AUDIO] ');
    const b = await s.talks.start({ audioWav: fakeRecording(), continue: false });
    expect((await reaches(s, b.id, 'failed'))?.reason).toBe('not_heard');
    expect(s.chat.asked).toEqual([]);
  });

  it('says the voice is unavailable when the service is busy or gone mid-way', async () => {
    const s = setup();
    s.voice.failNext.stt = new VoiceCallError('busy', 'one at a time');
    const { id } = await s.talks.start({ audioWav: fakeRecording(), continue: false });
    expect((await reaches(s, id, 'failed'))?.reason).toBe('voice_unavailable');
  });
});

describe('what Talk refuses', () => {
  it('an unpaired or locked screen, a second question while one runs, and a recording without voice', async () => {
    const s = setup();
    s.host.paired = null;
    expect(await refusal(s.talks.start({ text: 'hi', continue: false }))).toBe('not_paired 409');
    s.host.paired = PLACE;
    s.host.open = false;
    expect(await refusal(s.talks.start({ text: 'hi', continue: false }))).toBe('locked 409');
    expect(await refusal(s.talks.start({ audioWav: fakeRecording(), continue: false }))).toBe('locked 409');
    s.host.open = true;
    s.host.talkOn = false;
    expect(await refusal(s.talks.start({ audioWav: fakeRecording(), continue: false }))).toBe(
      'voice_unavailable 503',
    );
    s.host.talkOn = true;
    s.voice.ability = { ...s.voice.ability, stt: false };
    expect(await refusal(s.talks.start({ audioWav: fakeRecording(), continue: false }))).toBe(
      'voice_unavailable 503',
    );
    s.chat.answer = null;
    const first = await s.talks.start({ text: 'one', continue: false });
    expect(await refusal(s.talks.start({ text: 'two', continue: false }))).toBe('busy 409');
    s.chat.reply({ kind: 'answered', text: 'Done.' });
    await reaches(s, first.id, 'answered');
    expect(await refusal(s.talks.start({ text: 'three', continue: false }))).not.toBe('busy 409');
  });

  it('nothing to ask, both, too much, and a recording that isn’t the desk’s', async () => {
    const s = setup();
    expect(await refusal(s.talks.start({ text: '  ', continue: false }))).toBe('bad_request 400');
    expect(await refusal(s.talks.start({ text: 'a', audioWav: fakeRecording(), continue: false }))).toBe(
      'bad_request 400',
    );
    expect(await refusal(s.talks.start({ text: 'x'.repeat(1001), continue: false }))).toBe('bad_request 400');
    const stereo = encodeWav(new Int16Array(1600), 16_000);
    stereo.writeUInt16LE(2, 22);
    expect(await refusal(s.talks.start({ audioWav: stereo, continue: false }))).toBe('bad_audio 400');
    expect(
      await refusal(s.talks.start({ audioWav: encodeWav(new Int16Array(1600), 8000), continue: false })),
    ).toBe('bad_audio 400');
  });

  it('a recording when the box has no voice service', async () => {
    const s = setup();
    s.noVoice();
    expect(await refusal(s.talks.start({ audioWav: fakeRecording(), continue: false }))).toBe(
      'voice_unavailable 503',
    );
    // Typing still works.
    const { id } = await s.talks.start({ text: 'Is pve-02 okay?', continue: false });
    expect((await reaches(s, id, 'answered'))?.audio).toBe(false);
  });
});

describe('the open conversation (DK-64, DK-T14)', () => {
  it('goes on until it is closed or nothing was said in it for 30 minutes; a new one when not asked to go on', async () => {
    const s = setup();
    const a = await s.talks.start({ text: 'Is pve-02 okay?', continue: false });
    await reaches(s, a.id, 'answered');
    const first = { conversationId: 'cnv_chat', rootId: 'msg_root1' };
    expect(s.talks.open()).toMatchObject({ ...first, personId: PLACE.personId });
    s.timers.advance(29 * 60_000);
    const b = await s.talks.start({ text: 'And the nas?', continue: true });
    await reaches(s, b.id, 'answered');
    expect(s.chat.asked[1]?.thread).toEqual(first);
    const c = await s.talks.start({ text: 'Something else', continue: false });
    await reaches(s, c.id, 'answered');
    expect(s.chat.asked[2]?.thread).toBeNull();
    expect(s.talks.open()?.rootId).toBe('msg_root3');
    s.talks.end();
    expect(s.talks.open()).toBeNull();
    const d = await s.talks.start({ text: 'Still there?', continue: true });
    await reaches(s, d.id, 'answered');
    expect(s.chat.asked[3]?.thread).toBeNull();
    s.timers.advance(30 * 60_000 + 1);
    expect(s.talks.open()).toBeNull();
    const e = await s.talks.start({ text: 'Hello again', continue: true });
    await reaches(s, e.id, 'answered');
    expect(s.chat.asked[4]?.thread).toBeNull();
  });

  it('stays open while the assistant goes on in its thread, not for other threads in the room', async () => {
    const s = setup();
    const a = await s.talks.start({ text: 'Restart Plex', continue: false });
    await reaches(s, a.id, 'answered');
    s.timers.advance(25 * 60_000);
    s.chat.change({ conversationId: 'cnv_chat', posted: { id: 'msg_other', threadRootId: 'msg_elsewhere' } });
    s.timers.advance(6 * 60_000);
    expect(s.talks.open()).toBeNull();
    const b = await s.talks.start({ text: 'Restart Plex', continue: false });
    await reaches(s, b.id, 'answered');
    s.timers.advance(25 * 60_000);
    s.chat.change({ conversationId: 'cnv_chat', posted: { id: 'msg_done', threadRootId: 'msg_root2' } });
    s.timers.advance(25 * 60_000);
    expect(s.talks.open()?.rootId).toBe('msg_root2');
  });

  it('never continues another person’s thread', async () => {
    const s = setup();
    const a = await s.talks.start({ text: 'Is pve-02 okay?', continue: false });
    await reaches(s, a.id, 'answered');
    s.host.paired = { burrowId: 'bur_home', personId: 'prn_joris' };
    const b = await s.talks.start({ text: 'And the nas?', continue: true });
    await reaches(s, b.id, 'answered');
    expect(s.chat.asked[1]?.thread).toBeNull();
    // The last person's talk is gone from the screen.
    expect(s.talks.get(a.id)).toBeNull();
  });
});

describe('what stays in memory (DK-07)', () => {
  it('the answer’s audio for 10 minutes, at most five talks, nothing after forget', async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { id } = await s.talks.start({ text: `Question ${i}`, continue: false });
      await reaches(s, id, 'answered');
      ids.push(id);
    }
    expect(s.talks.get(ids[0] as string)).toBeNull();
    expect(s.talks.get(ids[1] as string)).not.toBeNull();
    const newest = ids[5] as string;
    s.timers.advance(10 * 60_000 - 1);
    expect(s.talks.audio(newest)).not.toBeNull();
    s.timers.advance(2);
    expect(s.talks.audio(newest)).toBeNull();
    expect(s.talks.get(newest)).toBeNull();
    const { id } = await s.talks.start({ text: 'One more', continue: false });
    await reaches(s, id, 'answered');
    s.talks.forget();
    expect(s.talks.latest()).toBeNull();
    expect(s.talks.audio(id)).toBeNull();
  });
});

/* The reply watch ------------------------------------------------------------------------------------------------ */

const AGENT = 'prn_dusty';
const ROOT = 'msg_root';

function message(over: Partial<Message> = {}): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    conversationId: 'cnv_chat',
    authorId: AGENT,
    createdAt: '2026-10-20T10:00:05.000Z',
    text: 'pve-02 is fine.',
    mentions: [],
    card: null,
    suggestions: [],
    attachments: [],
    reactions: [],
    threadRootId: ROOT,
    replyCount: 0,
    lastReplyAt: null,
    clientId: null,
    ...over,
  } as Message;
}

function turn(over: Partial<DispatchSummary> = {}): DispatchSummary {
  return {
    id: 'dsp_ours',
    agentId: AGENT,
    conversationId: 'cnv_chat',
    threadRootId: ROOT,
    trigger: 'dm',
    state: 'done',
    runId: null,
    createdAt: '2026-10-20T10:00:01.000Z',
    claimedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    reason: null,
    ...over,
  } as DispatchSummary;
}

function publish(bus: RealtimeBus, event: RealtimeEvent): void {
  bus.publish({
    topic: 'conv:cnv_chat',
    event,
    eventId: null,
    at: '',
    outboxId: null,
  });
}

const said = (m: Message): RealtimeEvent => ({ type: 'message.created', message: m });
const ended = (d: DispatchSummary): RealtimeEvent => ({ type: 'dispatch.updated', dispatch: d });

function watch(dispatchId: string | null = 'dsp_ours', untilWords = false) {
  const bus = new RealtimeBus();
  const timers = new ManualTimers();
  const w = new ReplyWatch(bus, AGENT, timers, { waitMaxMs: 1_800_000, settleMs: 15_000 }, untilWords);
  const want = { conversationId: 'cnv_chat', thread: ROOT, after: '2026-10-20T10:00:00.000Z', dispatchId };
  return { bus, timers, w, want };
}

describe('the reply watch (DK-T06)', () => {
  it('answers with the assistant’s last words in the thread when its turn ends', async () => {
    const { bus, w, want } = watch();
    const answer = w.wait(want);
    publish(bus, said(message({ authorId: 'prn_mara', text: 'Is pve-02 okay?' })));
    publish(bus, said(message({ threadRootId: 'msg_other', text: 'elsewhere' })));
    publish(bus, said(message({ createdAt: '2026-10-20T09:59:00.000Z', text: 'an older answer' })));
    publish(bus, said(message({ text: 'Let me look.' })));
    publish(bus, said(message({ id: 'msg_answer', text: 'pve-02 is fine, up 41 days.' })));
    publish(bus, ended(turn({ state: 'running' })));
    publish(bus, ended(turn()));
    expect(await answer).toEqual({
      kind: 'answered',
      text: 'pve-02 is fine, up 41 days.',
      messageId: 'msg_answer',
    });
  });

  it('keeps what came while the question was being posted', async () => {
    const { bus, w, want } = watch();
    publish(bus, said(message({ text: 'Quick one: fine.' })));
    publish(bus, ended(turn()));
    expect(await w.wait(want)).toMatchObject({ kind: 'answered', text: 'Quick one: fine.' });
  });

  it('doesn’t take a task card for the answer: the agent’s own words are (TF-12)', async () => {
    const { bus, w, want } = watch();
    const answer = w.wait(want);
    publish(
      bus,
      said(
        message({
          id: 'msg_card',
          text: 'Installing 23 updates on Home Assistant',
          card: { kind: 'task' } as never,
        }),
      ),
    );
    publish(bus, said(message({ id: 'msg_words', text: 'I’m installing them now.' })));
    publish(bus, ended(turn()));
    expect(await answer).toMatchObject({ kind: 'answered', messageId: 'msg_words' });
  });

  it('takes an answer when the turn goes on without saying more, and is slow when nothing came', async () => {
    const a = watch();
    const first = a.w.wait(a.want);
    publish(a.bus, said(message({ text: 'pve-02 is fine.' })));
    a.timers.advance(15_000);
    expect(await first).toMatchObject({ kind: 'answered', text: 'pve-02 is fine.' });
    // Nothing for 30 minutes (TF-16; the talk is `working` from 90 s): slow.
    const b = watch();
    const second = b.w.wait(b.want);
    b.timers.advance(90_000);
    publish(b.bus, said(message({ authorId: 'prn_someone' })));
    b.timers.advance(1_800_000 - 90_001);
    let done = false;
    void second.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    b.timers.advance(1);
    expect(await second).toEqual({ kind: 'slow' });
  });

  it('for a follow talk, waits past a turn that ended before it said anything (DK-T16)', async () => {
    const { bus, w, want } = watch(null, true);
    const answer = w.wait(want);
    publish(bus, ended(turn({ id: 'dsp_asked', state: 'done' })));
    publish(bus, said(message({ id: 'msg_done', text: 'Done, Plex is back.' })));
    publish(bus, ended(turn({ id: 'dsp_woken', state: 'done' })));
    expect(await answer).toEqual({ kind: 'answered', text: 'Done, Plex is back.', messageId: 'msg_done' });
  });

  it('follows a question merged into the running turn, and ignores other turns’ ends', async () => {
    const { bus, w, want } = watch();
    const answer = w.wait(want);
    publish(bus, ended(turn({ id: 'dsp_before', state: 'done' })));
    publish(bus, ended(turn({ state: 'cancelled', reason: TURN_MERGED_REASON })));
    publish(bus, said(message({ text: 'Both are fine.' })));
    publish(bus, ended(turn({ id: 'dsp_running', state: 'done' })));
    expect(await answer).toMatchObject({ kind: 'answered', text: 'Both are fine.' });
  });

  it('fails a turn that ended without a word to the person (a failed turn’s card is none)', async () => {
    const { bus, w, want } = watch(null);
    const answer = w.wait(want);
    publish(
      bus,
      said(
        message({
          text: '',
          card: {
            kind: 'turn_failed',
            dispatchId: 'dsp_ours',
            agentId: AGENT,
            code: 'provider',
            reason: 'The AI provider couldn’t run it',
            retriedAt: null,
            retryDispatchId: null,
          } as unknown as Message['card'],
        }),
      ),
    );
    publish(bus, ended(turn({ id: 'dsp_any', state: 'failed' })));
    expect(await answer).toEqual({ kind: 'failed' });
  });
});

/* Words ---------------------------------------------------------------------------------------------------------- */

describe('the answer as heard (DK-T07)', () => {
  it('is plain: no markers, mentions as names, list items as sentences, no code or tables', () => {
    expect(
      speechText('## Status\n- **pve-02**: fine\n- nas-1 is _busy_\n\n@Mara see ~~old~~ https://a.test'),
    ).toBe('Status. pve-02: fine. nas-1 is busy. Mara see.');
    expect(speechText('Done.\n```sh\nreboot\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('Done.');
  });

  it('ends a long answer at its last whole sentence within 600 characters', () => {
    const long = `${'All good here. '.repeat(50)}`;
    const out = speechText(long);
    expect([...out].length).toBeLessThanOrEqual(600);
    expect(out.endsWith('here.')).toBe(true);
  });
});

describe('what whisper hears and is told (DK-T03)', () => {
  it('gives Talk’s box what its mic heard: one line, cut after the last whole word that fits', () => {
    expect(deskHeardText('  Is pve-02\n okay? ')).toBe('Is pve-02 okay?');
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const cut = deskHeardText(words);
    expect([...cut].length).toBeLessThanOrEqual(DESK_TALK_TEXT_MAX);
    expect(words.startsWith(`${cut} `)).toBe(true);
    expect(deskHeardText('x'.repeat(DESK_TALK_TEXT_MAX + 5))).toHaveLength(DESK_TALK_TEXT_MAX);
  });

  it('drops its notes about the sound; nothing left is nothing heard', () => {
    expect(heardText(' [BLANK_AUDIO] ')).toBe('');
    expect(heardText('(silence) ...')).toBe('');
    expect(heardText('Is pve-02 okay? [Music]')).toBe('Is pve-02 okay?');
  });

  it('gets the assistant’s, servers’ and things’ names, at most 400 characters', () => {
    expect(sttPrompt({ assistant: 'Dusty', servers: ['pve-02', 'pve-02'], things: ['Plex'] })).toBe(
      'Dusty, pve-02, Plex.',
    );
    const many = sttPrompt({
      assistant: 'Dusty',
      servers: Array.from({ length: 80 }, (_, i) => `srv-${i}`),
      things: [],
    });
    expect(many.length).toBeLessThanOrEqual(400);
    expect(many.startsWith('Dusty, srv-0,')).toBe(true);
    expect(sttPrompt({ assistant: null, servers: [], things: [] })).toBe('');
  });
});

describe('the server an answer is about (DK-T08)', () => {
  const names = ['pve-02', 'pve-020', 'nas', 'nas-backup'];
  it('is the first named, whatever the case, separators or leading zeros', () => {
    expect(firstNamed('PVE 2 is fine, nas too', names)).toBe('pve-02');
    expect(firstNamed('the nas and pve02', names)).toBe('nas');
    expect(firstNamed('nas-backup is full', names)).toBe('nas-backup');
    expect(firstNamed('pve-020 is new', names)).toBe('pve-020');
    expect(firstNamed('nasa called', names)).toBeNull();
  });
});

describe('the turn’s mark (DK-T05)', () => {
  it('is on the person’s message from the screen: spoken or typed', () => {
    const v = deskClientId('dtk_abc123', true);
    expect(v.length).toBeLessThanOrEqual(64);
    expect(deskTurnOf({ trigger: 'dm' }, { clientId: v })).toEqual({ spoken: true });
    expect(deskTurnOf({ trigger: 'mention' }, { clientId: deskClientId('dtk_abc123', false) })).toEqual({
      spoken: false,
    });
    expect(deskTurnOf({ trigger: 'expand' }, { clientId: v })).toBeNull();
    expect(deskTurnOf({ trigger: 'dm' }, { clientId: 'undo:chg_1:abcdef12' })).toBeNull();
    expect(deskTurnOf({ trigger: 'dm' }, null)).toBeNull();
  });

  it('names the server a question was asked about, by its talk, and only the latest talks (DK-85, DK-S89)', () => {
    const services = {};
    rememberTalkServer(services, 'dtk_abc123', { id: 'pve-01', name: 'pve-01' });
    const v = deskClientId('dtk_abc123', true);
    expect(deskTurnOf({ trigger: 'dm' }, { clientId: v }, services)).toEqual({
      spoken: true,
      server: { id: 'pve-01', name: 'pve-01' },
    });
    // Another runtime's services, or no services: the turn goes on without it.
    expect(deskTurnOf({ trigger: 'dm' }, { clientId: v }, {})).toEqual({ spoken: true });
    expect(deskTurnOf({ trigger: 'dm' }, { clientId: v })).toEqual({ spoken: true });
    for (let i = 0; i < 50; i++) rememberTalkServer(services, `dtk_other${i}`, { id: 'nas', name: 'nas' });
    expect(talkServerOf(services, 'dtk_abc123')).toBeNull();
    expect(talkServerOf(services, 'dtk_other49')).toEqual({ id: 'nas', name: 'nas' });
  });
});

describe('no push while the person reads the desk screen (DK-T13)', () => {
  const question = { authorId: 'prn_mara', clientId: deskClientId('dtk_abc123', true) };

  function screen(paired: string | null, unlocked: boolean) {
    const services = {};
    const host = {
      place: () => (paired ? { burrowId: 'bur_home', personId: paired } : null),
      unlocked: () => unlocked,
    };
    setDeskScreen(services, host);
    return { services, host };
  }

  it('holds the assistant’s reply in the thread of the person’s own desk question while their screen is unlocked', async () => {
    const { services } = screen('prn_mara', true);
    expect(await deskReaderOf(services, { authorKind: 'agent', root: question })).toBe('prn_mara');
  });

  it('pushes as usual once the screen locks, for someone else’s screen, for people and for other threads', async () => {
    expect(
      await deskReaderOf(screen('prn_mara', false).services, { authorKind: 'agent', root: question }),
    ).toBeNull();
    expect(
      await deskReaderOf(screen('prn_joris', true).services, { authorKind: 'agent', root: question }),
    ).toBeNull();
    const { services, host } = screen('prn_mara', true);
    expect(await deskReaderOf(services, { authorKind: 'person', root: question })).toBeNull();
    expect(
      await deskReaderOf(services, {
        authorKind: 'agent',
        root: { authorId: 'prn_mara', clientId: 'web:1' },
      }),
    ).toBeNull();
    expect(await deskReaderOf(services, { authorKind: 'agent', root: null })).toBeNull();
    // A box without a desk screen, or after Talk closed: no screen to read.
    expect(await deskScreenShowsTo({}, 'prn_mara')).toBe(false);
    setDeskScreen(services, null, host);
    expect(await deskScreenShowsTo(services, 'prn_mara')).toBe(false);
  });

  it('says no when the screen can’t tell', async () => {
    const services = {};
    setDeskScreen(services, {
      place: () => Promise.reject(new Error('gone')),
      unlocked: () => true,
    });
    expect(await deskScreenShowsTo(services, 'prn_mara')).toBe(false);
  });
});

const msg = (over: Partial<Message> & Pick<Message, 'id' | 'authorId'>): Message =>
  ({
    conversationId: 'cnv_chat',
    createdAt: '2026-10-20T12:30:00.000Z',
    editedAt: null,
    text: '',
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: 'msg_root1',
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...over,
  }) as Message;

describe('the conversation as the screen shows it (DK-63, DK-T15)', () => {
  it('makes a message plain per block: paragraphs, list items with a dot, the rest only in Chat', () => {
    expect(sessionParagraphs('**Plex** is back.\n\n- 212 GB\n- all checks passed')).toEqual({
      paragraphs: ['Plex is back.', '• 212 GB', '• all checks passed'],
      more: false,
    });
    expect(sessionParagraphs('Here it is:\n\n```\ndf -h\n```').more).toBe(true);
    expect(sessionParagraphs('x'.repeat(700))).toMatchObject({ more: true });
    expect(sessionParagraphs('x'.repeat(700)).paragraphs[0]?.length).toBeLessThanOrEqual(600);
    const nine = Array.from({ length: 9 }, (_, i) => `Line ${i}.`).join('\n\n');
    expect(sessionParagraphs(nine)).toMatchObject({ more: true });
    expect(sessionParagraphs(nine).paragraphs).toHaveLength(8);
  });

  it('shows the person’s and the assistant’s messages, asks with what became of them, and the talks', () => {
    const approval = (state: string) =>
      ({
        kind: 'approval',
        approval: { number: 12, state, question: 'Restart Plex?', title: 'Restart Plex' },
      }) as never;
    const shown = conversationMessages(
      [
        msg({
          id: 'msg_root1',
          authorId: 'prn_mara',
          text: 'Restart Plex',
          clientId: deskClientId('dtk_a1', true),
        }),
        msg({ id: 'msg_card', authorId: 'prn_dusty', card: approval('declined') }),
        msg({ id: 'msg_ans1', authorId: 'prn_dusty', text: 'Okay, I left it.' }),
        msg({ id: 'msg_jo', authorId: 'prn_joris', text: 'Hi' }),
        msg({ id: 'msg_gone', authorId: 'prn_dusty', text: 'x', deletedAt: '2026-10-20T12:31:00.000Z' }),
        msg({ id: 'msg_fail', authorId: 'prn_dusty', card: { kind: 'turn_failed' } as never }),
        msg({ id: 'msg_pic', authorId: 'prn_dusty', attachments: [{ id: 'att_1' }] as never }),
      ],
      {
        personId: 'prn_mara',
        agentId: 'prn_dusty',
        talks: new Map([['msg_ans1', { talk: 'dtk_a1', audio: true, thing: server('pve-02') }]]),
      },
    );
    expect(shown.map((m) => [m.id, m.from])).toEqual([
      ['msg_root1', 'you'],
      ['msg_card', 'assistant'],
      ['msg_ans1', 'assistant'],
      ['msg_pic', 'assistant'],
    ]);
    expect(shown[0]).toMatchObject({ talk: 'dtk_a1', paragraphs: ['Restart Plex'] });
    expect(shown[1]).toMatchObject({ ask: { number: 12, state: 'denied' }, paragraphs: ['Restart Plex?'] });
    expect(shown[2]).toMatchObject({ talk: 'dtk_a1', audio: true, thing: { name: 'pve-02' } });
    expect(shown[3]?.paragraphs).toEqual([SEE_IN_CHAT]);
    expect(shown[3]).not.toHaveProperty('more');
  });

  it('shows a sign-in card as its title and where to answer it, never a field (VLT-41)', () => {
    const ask = {
      kind: 'server' as const,
      name: 'prod-1',
      url: null,
      username: 'root',
      description: '',
      entryId: null,
    };
    const card = vaultAskCard('Dusty', ask, null);
    const locked = {
      ...card,
      state: 'done',
      answer: {
        actionId: 'save',
        optionIds: null,
        label: 'Signed in to prod-1 · key added',
        at: '2026-10-20T12:31:00.000Z',
      },
    };
    const shown = conversationMessages(
      [
        msg({ id: 'msg_ask', authorId: 'prn_dusty', card }),
        msg({ id: 'msg_done', authorId: 'prn_dusty', card: locked as never }),
      ],
      { personId: 'prn_mara', agentId: 'prn_dusty', talks: new Map() },
    );
    expect(shown[0]).toEqual({
      id: 'msg_ask',
      from: 'assistant',
      at: expect.any(String),
      paragraphs: [card.title, VAULT_ASK_TEXT.desk],
    });
    expect(shown[1]?.paragraphs).toEqual([card.title, 'Signed in to prod-1 · key added']);
    expect(JSON.stringify(shown)).not.toMatch(/password|private_key/);
  });

  it('keeps the newest that fit, counting the rest', () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      conversationMessages(
        [msg({ id: `msg_${String(i).padStart(4, '0')}`, authorId: 'prn_mara', text: 'hi' })],
        {
          personId: 'prn_mara',
          agentId: null,
          talks: new Map(),
        },
      ),
    ).flat();
    const fit = fitSession(many, 3);
    expect(fit.messages).toHaveLength(40);
    expect(fit.earlier).toBe(8);
    expect(fit.messages[0]?.id).toBe('msg_0005');
    const small = fitSession(many.slice(0, 10), 0, 500);
    expect(small.messages.length).toBeLessThan(10);
    expect(small.earlier).toBe(10 - small.messages.length);
  });

  it('is read again after a change in its room, and is empty once closed', async () => {
    const s = setup();
    expect(await s.talks.session()).toEqual({ v: 1, open: false, messages: [], earlier: 0 });
    const a = await s.talks.start({ text: 'Restart Plex', continue: false });
    await reaches(s, a.id, 'answered');
    s.chat.stored = {
      agentId: 'prn_dusty',
      earlier: 0,
      messages: [msg({ id: 'msg_root1', authorId: PLACE.personId, text: 'Restart Plex' })],
    };
    const one = await s.talks.session();
    expect(one).toMatchObject({ open: true, messages: [{ id: 'msg_root1', from: 'you' }] });
    expect(Date.parse(one.until as string)).toBe(s.timers.now() + 30 * 60_000);
    const reads = s.chat.reads;
    await s.talks.session();
    expect(s.chat.reads).toBe(reads);
    s.chat.change({ conversationId: 'cnv_chat', posted: null });
    await s.talks.session();
    expect(s.chat.reads).toBe(reads + 1);
    s.talks.end();
    expect((await s.talks.session()).open).toBe(false);
  });

  it('knows which asks were made in it', () => {
    const c = { conversationId: 'cnv_chat', rootId: 'msg_root1' };
    expect(
      inConversation(c, { conversationId: 'cnv_chat', messageId: 'msg_card', threadRootId: 'msg_root1' }),
    ).toBe(true);
    expect(
      inConversation(c, { conversationId: 'cnv_chat', messageId: 'msg_root1', threadRootId: null }),
    ).toBe(true);
    expect(
      inConversation(c, { conversationId: 'cnv_chat', messageId: 'msg_x', threadRootId: 'msg_root9' }),
    ).toBe(false);
    expect(
      inConversation(c, { conversationId: 'cnv_dm', messageId: 'msg_card', threadRootId: 'msg_root1' }),
    ).toBe(false);
  });
});

describe('a follow talk (DK-63, DK-T16)', () => {
  it('says the assistant’s next words in the open conversation, as an answer', async () => {
    const s = setup();
    expect(await s.talks.follow()).toBeNull();
    const a = await s.talks.start({ text: 'Restart Plex on pve-02', continue: false });
    await reaches(s, a.id, 'answered');
    const f = await s.talks.follow();
    expect(f).not.toBeNull();
    expect(s.chat.listened).toEqual([{ conversationId: 'cnv_chat', rootId: 'msg_root1' }]);
    const id = f?.id as string;
    expect(s.talks.get(id)).toMatchObject({ state: 'thinking', thing: null });
    expect(s.talks.get(id)).not.toHaveProperty('question');
    // One talk at a time: a question waits for it.
    expect(await refusal(s.talks.start({ text: 'And now?', continue: true }))).toBe('busy 409');
    s.chat.says({ kind: 'answered', text: 'Done, **pve-02** has Plex back.', messageId: 'msg_done' });
    expect(await reaches(s, id, 'answered')).toMatchObject({
      answer: 'Done, pve-02 has Plex back.',
      audio: true,
      thing: { name: 'pve-02' },
    });
  });

  it('is dropped when the decision didn’t go through', async () => {
    const s = setup();
    const a = await s.talks.start({ text: 'Restart Plex', continue: false });
    await reaches(s, a.id, 'answered');
    const f = await s.talks.follow();
    f?.cancel();
    expect(s.talks.get(f?.id as string)).toBeNull();
    const b = await s.talks.start({ text: 'And now?', continue: true });
    expect(b.id).toMatch(/^dtk_/);
  });
});

describe('a slow answer isn’t the end (task-feedback.md TF-16, TF-18)', () => {
  it('is working after 90 s, keeps waiting and is answered when the words come', async () => {
    const s = setup();
    s.chat.answer = null;
    const { id } = await s.talks.start({ text: 'Update Home Assistant', continue: false });
    await reaches(s, id, 'thinking');
    s.timers.advance(89_999);
    expect(s.talks.get(id)?.state).toBe('thinking');
    const uses = s.host.uses;
    s.timers.advance(1);
    expect(s.talks.get(id)?.state).toBe('working');
    // The talk moving on is the screen in use.
    expect(s.host.uses).toBeGreaterThan(uses);
    s.chat.reply({ kind: 'answered', text: 'Home Assistant is up to date.' });
    expect(await reaches(s, id, 'answered')).toMatchObject({ answer: 'Home Assistant is up to date.' });
  });

  it('a new question ends a working wait (slow), not one in its first 90 s (DK-T18)', async () => {
    const s = setup();
    s.chat.answer = null;
    const a = await s.talks.start({ text: 'Update Home Assistant', continue: false });
    await reaches(s, a.id, 'thinking');
    expect(await refusal(s.talks.start({ text: 'And the NAS?', continue: true }))).toBe('busy 409');
    s.timers.advance(90_000);
    expect(s.talks.get(a.id)?.state).toBe('working');
    const b = await s.talks.start({ text: 'And the NAS?', continue: true });
    expect(s.talks.get(a.id)).toMatchObject({ state: 'failed', reason: 'slow' });
    // In the same conversation.
    expect(s.chat.asked[1]?.thread).toEqual({ conversationId: 'cnv_chat', rootId: 'msg_root1' });
    s.chat.reply({ kind: 'answered', text: 'gone' });
    s.chat.reply({ kind: 'answered', text: 'The NAS is fine.' });
    expect((await reaches(s, b.id, 'answered'))?.answer).toBe('The NAS is fine.');
    expect(s.talks.get(a.id)?.state).toBe('failed');
  });

  it('stays readable for its whole wait, and its usual keep after it ended', async () => {
    const s = setup();
    s.chat.answer = null;
    const { id } = await s.talks.start({ text: 'Update Home Assistant', continue: false });
    await reaches(s, id, 'thinking');
    s.timers.advance(29 * 60_000);
    expect(s.talks.get(id)?.state).toBe('working');
    s.chat.reply({ kind: 'answered', text: 'Done.' });
    await reaches(s, id, 'answered');
    s.timers.advance(9 * 60_000);
    expect(s.talks.get(id)?.id).toBe(id);
  });

  it('a follow talk is working after 90 s too', async () => {
    const s = setup();
    const a = await s.talks.start({ text: 'Restart Plex', continue: false });
    await reaches(s, a.id, 'answered');
    const id = (await s.talks.follow())?.id as string;
    s.timers.advance(90_000);
    expect(s.talks.get(id)?.state).toBe('working');
    s.chat.says({ kind: 'answered', text: 'Plex is back.', messageId: 'msg_done' });
    expect((await reaches(s, id, 'answered'))?.answer).toBe('Plex is back.');
  });
});

describe('work in the conversation (task-feedback.md TF-17, TF-18)', () => {
  const card = (over: Partial<TaskCard> = {}): TaskCard => ({
    kind: 'task',
    followedTaskId: 'ftk_install1',
    serverId: 'home-assistant',
    server: 'Home Assistant',
    title: 'Installing 23 updates on Home Assistant',
    state: 'running',
    startedAt: '2026-10-20T10:00:00.000Z',
    endedAt: null,
    result: null,
    ...over,
  });

  it('shows a task card as a live row, running and then how it went', () => {
    const shown = conversationMessages(
      [
        msg({ id: 'msg_task1', authorId: 'prn_dusty', text: '', card: card() }),
        msg({
          id: 'msg_task2',
          authorId: 'prn_dusty',
          text: '',
          card: card({
            state: 'ok',
            endedAt: '2026-10-20T10:04:00.000Z',
            result: 'Home Assistant is up to date: 23 updates installed. It needs a restart.',
          }),
        }),
      ],
      {
        personId: 'prn_mara',
        agentId: 'prn_dusty',
        talks: new Map(),
        now: Date.parse('2026-10-20T10:00:12.000Z'),
      },
    );
    // Its paragraph is the card's line as Chat shows it; `task` carries the live state.
    expect(shown[0]).toMatchObject({
      from: 'assistant',
      paragraphs: ['Installing 23 updates on Home Assistant · 12 s'],
      task: { title: 'Installing 23 updates on Home Assistant', state: 'running' },
    });
    expect(shown[0]?.task).not.toHaveProperty('endedAt');
    expect(shown[1]).toMatchObject({
      paragraphs: ['Home Assistant is up to date: 23 updates installed · 4 min'],
      task: { state: 'ok', endedAt: '2026-10-20T10:04:00.000Z' },
    });
    expect(shown[1]?.task?.result).toContain('restart');
    expect(shown.map((m) => m.paragraphs[0])).not.toContain(SEE_IN_CHAT);
    const session = {
      v: 1 as const,
      open: true,
      messages: shown,
      earlier: 0,
      until: '2026-10-20T10:30:00.000Z',
    };
    expect(deskTalkSessionValid(DeskTalkSession.parse(session))).toBe(true);
  });

  it('says the assistant is working there, and a card’s change or a turn there is use that keeps it open', async () => {
    const s = setup();
    const a = await s.talks.start({ text: 'Update Home Assistant', continue: false });
    await reaches(s, a.id, 'answered');
    s.chat.stored = {
      agentId: 'prn_dusty',
      earlier: 0,
      messages: [msg({ id: 'msg_task1', authorId: 'prn_dusty', text: '', card: card() })],
      working: { since: '2026-10-20T10:00:01.000Z', doing: 'Running a command' },
    };
    s.chat.change({ conversationId: 'cnv_chat', posted: null });
    const one = await s.talks.session();
    expect(one.working).toEqual({ since: '2026-10-20T10:00:01.000Z', doing: 'Running a command' });
    expect(one.messages[0]?.task?.state).toBe('running');
    s.timers.advance(20 * 60_000);
    const uses = s.host.uses;
    s.chat.change({
      conversationId: 'cnv_chat',
      posted: null,
      card: { id: 'msg_task1', threadRootId: 'msg_root1' },
    });
    expect(s.host.uses).toBe(uses + 1);
    // The card's change kept it open: 30 minutes from now.
    expect(Date.parse((await s.talks.session()).until as string)).toBe(s.timers.now() + 30 * 60_000);
    s.chat.change({ conversationId: 'cnv_chat', posted: null, turn: { threadRootId: 'msg_root1' } });
    expect(s.host.uses).toBe(uses + 2);
    // Another thread's turn isn't this conversation's.
    s.chat.change({ conversationId: 'cnv_chat', posted: null, turn: { threadRootId: 'msg_other' } });
    expect(s.host.uses).toBe(uses + 2);
    s.chat.stored = { ...s.chat.stored, working: null };
    s.chat.change({ conversationId: 'cnv_chat', posted: null });
    expect(await s.talks.session()).not.toHaveProperty('working');
  });
});
