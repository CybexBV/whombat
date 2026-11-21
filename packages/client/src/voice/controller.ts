/**
 * The composer's voice typing (docs/decisions/dictation.md DT-01, DT-08): a port of T3 Code's voice input controller
 * (MIT, Copyright (c) 2026 T3 Tools Inc.; `packages/client-runtime/src/voice-input/controller.ts`), with the box doing
 * the hearing. Its rules:
 *
 * - When recording starts it keeps the draft's owner (which composer), text, selection and revision. A transcript that
 *   comes back to a changed draft is dropped, never written over what the person typed meanwhile.
 * - The text goes in at the cursor (or over the selection) with a space where the words need one, as English and Dutch
 *   are written.
 * - One recording at a time across every composer of the app; a second waits for the first to let go.
 * - It never sends: the text lands in the draft and the person sends it.
 *
 * The platform brings the recorder (the browser's microphone or the phone's) and the transcriber (the box, through the
 * `dictation` upload). Pure apart from them.
 */
import type { DictationOutput } from '@whombat/core/domain';

export type VoiceTypingPhase = 'idle' | 'preparing' | 'recording' | 'transcribing' | 'error';

/**
 * Why voice typing stopped, in `VOICE_TEXT.errors`' terms: the box's own refusals (`DictationErrorCode`), and the
 * microphone refused, nothing heard, no connection, the draft changed, another recording going on, the recording cut off.
 */
export type VoiceTypingProblem =
  | 'dictation_off'
  | 'not_ready'
  | 'busy'
  | 'bad_audio'
  | 'too_long'
  | 'failed'
  | 'microphone'
  | 'nothing'
  | 'offline'
  | 'changed'
  | 'elsewhere'
  | 'interrupted';

export interface VoiceTypingState {
  readonly phase: VoiceTypingPhase;
  /** Set in `error`. */
  readonly problem: VoiceTypingProblem | null;
  /** When recording began (epoch ms), for the clock beside the waveform; null unless `recording`. */
  readonly since: number | null;
}

export const VOICE_TYPING_IDLE: VoiceTypingState = { phase: 'idle', problem: null, since: null };

/** While voice typing works, the composer doesn't send: the words aren't in the draft yet. */
export function voiceTypingBusy(state: VoiceTypingState): boolean {
  return state.phase === 'preparing' || state.phase === 'recording' || state.phase === 'transcribing';
}

/** A composer's draft as it was or is: which composer (`ownerKey`), its text, its selection and its edit count. */
export interface VoiceDraft {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
}

/** The microphone. `start` resolves once it records; `stop` answers the WAV (16 kHz mono 16-bit). */
export interface VoiceRecorder {
  start(options: {
    readonly maxSeconds: number;
    /** The loudness now, 0…1, a few times a second. */
    readonly onLevel?: (level: number) => void;
    /** It stopped by itself: the time is up (`limit`; the WAV is still there), or the microphone went (`error`). */
    readonly onEnd?: (reason: 'limit' | 'error') => void;
  }): Promise<void>;
  stop(): Promise<Uint8Array>;
  /** Stops and drops what was recorded. */
  cancel(): Promise<void>;
}

/** The microphone was refused or there is none: `VOICE_TEXT.errors.microphone`. */
export class MicrophoneError extends Error {
  override name = 'MicrophoneError';
  /** False when asking again shows nothing (the person must allow it in the system's settings). */
  constructor(readonly canAskAgain = true) {
    super('The microphone isn’t allowed.');
  }
}

/** A recording to text: the box's answer, or a refusal (`OperationError`/`StreamError` with `details.code`). */
export type VoiceTranscribe = (wav: Uint8Array, options: { signal: AbortSignal }) => Promise<DictationOutput>;

export interface VoiceTypingDependencies {
  readonly recorder: VoiceRecorder;
  /** What turns a recording into text here; null: nothing can. Read once per recording. */
  readonly getTranscriber: () => VoiceTranscribe | null;
  /** Why not now (voice typing off, its model still downloading); null: go. Read when the mic is pressed. */
  readonly check?: () => VoiceTypingProblem | null;
  /** The phone asks for the microphone here; the browser asks when the recorder starts. */
  readonly requestPermission?: () => Promise<{ readonly granted: boolean; readonly canAskAgain: boolean }>;
  readonly readDraft: () => VoiceDraft | null;
  readonly commitDraft: (text: string, selection: { readonly start: number; readonly end: number }) => void;
  readonly onStateChange: (state: VoiceTypingState) => void;
  readonly onLevel?: (level: number) => void;
  /** What a failure was, in `VoiceTypingProblem` terms (`voiceTypingProblemOf`). */
  readonly problemOf?: (error: unknown) => VoiceTypingProblem;
  readonly maxSeconds: number;
  readonly now?: () => number;
}

type CommitResult =
  | { readonly kind: 'commit'; readonly text: string; readonly selection: { start: number; end: number } }
  | { readonly kind: 'stale' }
  | { readonly kind: 'empty' };

/** Letters, digits and what ends a word or sentence: after one, a word needs a space before it. */
const ENDS_WORD = /[\p{L}\p{N}.!?,:;)\]}'"’”…]/u;
/** Letters, digits and what opens one: before one, a word needs a space after it. */
const STARTS_WORD = /[\p{L}\p{N}([{'"‘“]/u;

/**
 * Where a transcript goes in the draft it was spoken into: over the selection kept when recording started, with a
 * space on either side where the words around it need one. `stale` when the draft is another's or changed since,
 * `empty` when nothing was heard.
 */
export function resolveTranscriptCommit(
  captured: VoiceDraft,
  current: VoiceDraft | null,
  transcript: string,
): CommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  )
    return { kind: 'stale' };
  const words = transcript.trim();
  if (!words) return { kind: 'empty' };
  const text = captured.text;
  const start = Math.max(0, Math.min(text.length, captured.selection.start));
  const end = Math.max(start, Math.min(text.length, captured.selection.end));
  let insertion = words;
  // At a cursor (not over a selection) the words get a space from a word before or after them, never inside one.
  if (start === end) {
    const left = text[start - 1];
    const right = text[start];
    const blank = (c: string | undefined) => c === undefined || /\s/.test(c);
    const before = left !== undefined && ENDS_WORD.test(left) && blank(right);
    const after = right !== undefined && STARTS_WORD.test(right) && blank(left);
    insertion = `${before ? ' ' : ''}${words}${after ? ' ' : ''}`;
  }
  const cursor = start + insertion.length;
  return {
    kind: 'commit',
    text: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    selection: { start: cursor, end: cursor },
  };
}

/* One recording at a time across the app ---------------------------------------------------------------------------- */

interface VoiceTypingSession {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
}

let activeSession: VoiceTypingSession | null = null;

function acquireSession(): VoiceTypingSession | null {
  if (activeSession) return null;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const token: VoiceTypingSession = { abandoned: false, released, release };
  activeSession = token;
  return token;
}

function releaseSession(token: VoiceTypingSession | null): void {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
}

/** For tests: forget a recording another test left going. */
export function resetVoiceTypingForTests(): void {
  activeSession = null;
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

/**
 * One composer's voice typing. `start` (the mic) → `preparing` → `recording`; `stop` (Done) → `transcribing` → the text
 * in the draft and `idle`, or `error` with the problem; `cancel` drops it at any point. `ownerChanged` and `dispose`
 * cancel what goes on.
 */
export class VoiceTypingController {
  private readonly deps: VoiceTypingDependencies;
  private state: VoiceTypingState = VOICE_TYPING_IDLE;
  private operation = 0;
  private session: VoiceTypingSession | null = null;
  private transcribe: VoiceTranscribe | null = null;
  private abort: AbortController | null = null;
  private captured: VoiceDraft | null = null;
  private recording = false;
  private finishing = false;

  constructor(dependencies: VoiceTypingDependencies) {
    this.deps = dependencies;
  }

  get currentState(): VoiceTypingState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') return;
    const blocked = this.deps.check?.() ?? null;
    if (blocked) return this.fail(blocked);
    const initiating = this.deps.readDraft();
    if (!initiating) return this.fail('changed');
    const operation = ++this.operation;
    let session: VoiceTypingSession | null = null;
    this.set({ phase: 'preparing', problem: null, since: null });
    try {
      // A recording given up elsewhere lets go of the microphone first.
      for (let previous = activeSession; previous?.abandoned; previous = activeSession) {
        await previous.released;
        if (!this.isCurrent(operation)) return;
      }
      session = acquireSession();
      if (!session) return this.fail('elsewhere');
      this.session = session;
      const abort = new AbortController();
      this.abort = abort;

      const transcribe = this.deps.getTranscriber();
      if (!transcribe) return this.fail('not_ready');
      this.transcribe = transcribe;

      if (this.deps.requestPermission) {
        const permission = await this.deps.requestPermission();
        if (!this.isCurrent(operation)) return;
        if (!permission.granted) return this.fail('microphone');
      }

      const captured = this.deps.readDraft();
      if (!captured || captured.ownerKey !== initiating.ownerKey) return this.fail('changed');
      this.captured = captured;
      this.recording = true;
      await this.deps.recorder.start({
        maxSeconds: this.deps.maxSeconds,
        onLevel: (level) => {
          if (this.isCurrent(operation) && this.state.phase === 'recording') this.deps.onLevel?.(level);
        },
        onEnd: (reason) => {
          if (!this.isCurrent(operation) || this.state.phase !== 'recording') return;
          if (reason === 'limit') void this.finish();
          else void this.discard('interrupted');
        },
      });
      if (!this.isCurrent(operation)) return;
      this.set({ phase: 'recording', problem: null, since: (this.deps.now ?? Date.now)() });
    } catch (error) {
      if (this.isCurrent(operation)) this.fail(error instanceof MicrophoneError ? 'microphone' : 'failed');
    } finally {
      if (session && this.session === session) {
        const failed = this.isCurrent(operation) && this.state.phase === 'error';
        const left = !this.isCurrent(operation) && !this.finishing;
        if (failed || left) await this.release();
      }
    }
  }

  /** Done: the recording goes to the box and its text into the draft. */
  stop(): Promise<void> {
    if (this.state.phase !== 'recording') return Promise.resolve();
    return this.finish();
  }

  /** Cancel: nothing goes into the draft. From `error`, it clears the message. */
  cancel(): void {
    switch (this.state.phase) {
      case 'idle':
        return;
      case 'error':
        this.set(VOICE_TYPING_IDLE);
        return;
      case 'recording':
        void this.discard(null);
        return;
      case 'preparing':
      case 'transcribing':
        this.invalidate();
        this.set(VOICE_TYPING_IDLE);
        return;
    }
  }

  /** The composer now holds another draft (another thread, another chat): what went on is dropped. */
  ownerChanged(): void {
    if (this.state.phase !== 'idle') this.cancel();
  }

  /** The composer went away. */
  dispose(): void {
    if (this.state.phase === 'recording') {
      void this.discard(null);
      return;
    }
    if (this.state.phase === 'preparing' || this.state.phase === 'transcribing') {
      this.invalidate();
      this.set(VOICE_TYPING_IDLE);
    }
  }

  /** The app went to the background (the phone): a recording stops and is dropped. */
  movedToBackground(): void {
    if (this.state.phase === 'preparing') {
      this.invalidate();
      this.fail('interrupted');
      return;
    }
    if (this.state.phase === 'recording') void this.discard('interrupted');
  }

  private async finish(): Promise<void> {
    if (this.finishing || this.state.phase !== 'recording') return;
    this.finishing = true;
    const operation = this.operation;
    this.set({ phase: 'transcribing', problem: null, since: null });
    try {
      const wav = await this.deps.recorder.stop();
      this.recording = false;
      if (!this.isCurrent(operation)) return;
      const transcribe = this.transcribe;
      const abort = this.abort;
      const captured = this.captured;
      if (!transcribe || !abort || !captured) return this.fail('failed');
      let output: DictationOutput;
      try {
        output = await transcribe(wav, { signal: abort.signal });
      } catch (error) {
        if (this.isCurrent(operation) && !isAbort(error)) this.fail(this.deps.problemOf?.(error) ?? 'failed');
        return;
      }
      if (!this.isCurrent(operation)) return;
      const result = resolveTranscriptCommit(captured, this.deps.readDraft(), output.text);
      if (result.kind === 'stale') return this.fail('changed');
      if (result.kind === 'empty') return this.fail('nothing');
      this.deps.commitDraft(result.text, result.selection);
      this.set(VOICE_TYPING_IDLE);
    } catch {
      if (this.isCurrent(operation)) this.fail('failed');
    } finally {
      this.finishing = false;
      await this.release();
    }
  }

  private async discard(problem: VoiceTypingProblem | null): Promise<void> {
    this.invalidate();
    this.set(problem ? { phase: 'error', problem, since: null } : VOICE_TYPING_IDLE);
    await this.release();
  }

  /** Lets go of the microphone and of the one-recording lock. */
  private async release(): Promise<void> {
    if (this.recording) {
      this.recording = false;
      try {
        await this.deps.recorder.cancel();
      } catch {
        // Already stopped.
      }
    }
    releaseSession(this.session);
    this.session = null;
    this.captured = null;
    this.transcribe = null;
    this.abort = null;
  }

  private invalidate(): void {
    this.operation += 1;
    if (this.session) this.session.abandoned = true;
    this.abort?.abort();
  }

  private isCurrent(operation: number): boolean {
    return operation === this.operation;
  }

  private fail(problem: VoiceTypingProblem): void {
    this.set({ phase: 'error', problem, since: null });
  }

  private set(state: VoiceTypingState): void {
    this.state = state;
    this.deps.onStateChange(state);
  }
}
