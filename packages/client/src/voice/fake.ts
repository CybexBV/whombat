/**
 * Voice typing without a speech service (docs/decisions/dictation.md DT-03, DT-05, DT-06, DT-11, DT-12): the `voice.*`
 * ops and `dictation` recordings as the runtime answers them, in memory, for the web's fixture mode, the phone's demo
 * world and tests. Its downloads take a few seconds and move as a real one does (`downloading` with what arrived, then
 * `ready`), and a recording comes back as a fixed sentence (nothing for less than a moment of sound). `withFakeVoice`
 * puts it on a fake box (`createFakeAppliance`, `createFakeSession`), so the app's own `voiceApi` and its upload run
 * against it. The clock and the timers are injectable.
 */
import {
  type DictationErrorCode,
  type DictationOutput,
  DUTCH_VOICE_LICENCE_VERSION,
  VOICE_DOWNLOAD_MODELS,
  VOICE_LANGUAGES,
  VOICE_MODEL_CHOICES,
  VOICE_SAMPLE_RATE,
  VOICE_STT_MODELS,
  VOICE_TYPING_MAX_SECONDS,
  type VoiceDownloadModel,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceModelProblem,
  type VoiceModelState,
  type VoiceSttModel,
  type VoiceTyping,
} from '@whombat/core/domain';
import { type FakeApplianceOptions, type FakeHandler, FakeUploadRefusal } from '../session/fake';
import { readWavHeader } from './wav';

/** The models' downloads (Parakeet `q8_0`, Whisper turbo `q5_0`, Supertonic 3 int8). */
export const FAKE_VOICE_SIZES: Record<VoiceDownloadModel, number> = {
  parakeet: 669_000_000,
  whisper: 574_000_000,
  supertonic: 145_310_775,
};

/** What a recording becomes in the fake: a question one might ask one's Whombat. */
export const FAKE_TRANSCRIPT = 'Can you check why pve-02 is running hot tonight?';

interface FakeModel {
  state: VoiceModelState;
  received: number;
  problem?: VoiceModelProblem;
}

export interface FakeVoiceSnapshot {
  available: boolean;
  on: boolean;
  model: VoiceModelChoice;
  language: VoiceLanguage;
  gpu: { name: string } | null;
  dutchVoice: {
    on: boolean;
    agreedAt: string | null;
    licenceVersion: string | null;
  };
  models: Record<VoiceDownloadModel, FakeModel>;
}

export interface FakeVoiceOptions {
  initial?: Partial<Omit<FakeVoiceSnapshot, 'models' | 'dutchVoice'>> & {
    dutchVoice?: Partial<FakeVoiceSnapshot['dutchVoice']>;
    models?: Partial<Record<VoiceDownloadModel, Partial<FakeModel>>>;
  };
  /** How long a whole download takes (default 8 s). */
  downloadMs?: number;
  /** How long the box takes to hear a recording (default 0.7 s). */
  transcribeMs?: number;
  /** What a recording becomes (default `FAKE_TRANSCRIPT`). */
  transcript?: (seconds: number) => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FakeVoice {
  /** One `voice.*` op as the runtime answers it. */
  call(op: string, input: unknown): { status: number; body: unknown };
  /** A recording's bytes to text, or a `FakeUploadRefusal` with the box's reason. */
  dictate(bytes: Uint8Array): Promise<DictationOutput>;
  /** What `voice.get` answers now. */
  state(): VoiceTyping;
  /** After every change (the runtime's `voice.changed`). */
  onChange(listener: () => void): () => void;
  /** The next recording is refused with `code`. */
  refuseNext(code: DictationErrorCode): void;
  /** Recordings it was sent, newest last (their seconds). */
  heard(): readonly number[];
  /** Stops the downloads' timers. */
  dispose(): void;
}

const ok = (body: unknown) => ({ status: 200, body });
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
const invalid = () => err(400, 'validation_failed', 'The request input is not valid.');

/** A dictation refusal as the box sends it: the session's code, the reason in `details.code`. */
const REFUSALS: Record<DictationErrorCode, string> = {
  dictation_off: 'conflict',
  not_ready: 'conflict',
  busy: 'rate_limited',
  bad_audio: 'validation_failed',
  too_long: 'too_large',
  failed: 'internal',
};
const refusal = (code: DictationErrorCode) =>
  new FakeUploadRefusal(REFUSALS[code], 'The recording wasn’t turned into text.', { code });

const isDownloadModel = (v: unknown): v is VoiceDownloadModel =>
  typeof v === 'string' && (VOICE_DOWNLOAD_MODELS as readonly string[]).includes(v);

const TICK_MS = 500;

export function createFakeVoice(options: FakeVoiceOptions = {}): FakeVoice {
  const downloadMs = options.downloadMs ?? 8_000;
  const transcribeMs = options.transcribeMs ?? 700;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const initial = options.initial ?? {};
  const s: FakeVoiceSnapshot = {
    available: initial.available ?? true,
    on: initial.on ?? true,
    model: initial.model ?? 'auto',
    language: initial.language ?? 'auto',
    gpu: initial.gpu ?? null,
    dutchVoice: {
      on: false,
      agreedAt: null,
      licenceVersion: null,
      ...initial.dutchVoice,
    },
    models: {
      parakeet: { state: 'ready', received: FAKE_VOICE_SIZES.parakeet, ...initial.models?.parakeet },
      whisper: { state: 'absent', received: 0, ...initial.models?.whisper },
      supertonic: { state: 'absent', received: 0, ...initial.models?.supertonic },
    },
  };
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  let refuse: DictationErrorCode | null = null;
  const heard: number[] = [];
  let timer: unknown = null;

  const ready = (m: VoiceDownloadModel) => s.models[m].state === 'ready';
  /** What the settings need (DT-05): Parakeet while voice typing is on; Whisper when chosen, or Automatic with a chip. */
  const needs = (m: VoiceSttModel) =>
    m === 'parakeet' ? s.on : s.model === 'whisper' || (s.model === 'auto' && s.gpu !== null);
  /** Where a recording goes now (DT-03). */
  const uses = (): VoiceSttModel | null => {
    if (!s.on) return null;
    if (s.model !== 'auto') return ready(s.model) ? s.model : null;
    if (s.gpu && ready('whisper')) return 'whisper';
    if (ready('parakeet')) return 'parakeet';
    return ready('whisper') ? 'whisper' : null;
  };

  function state(): VoiceTyping {
    const now = uses();
    const dutchModel = s.models.supertonic;
    const dutchOn = s.dutchVoice.on;
    const dutchState = dutchOn ? dutchModel.state : 'absent';
    return {
      available: s.available,
      on: s.on,
      model: s.model,
      language: s.language,
      ready: s.on && now !== null,
      uses: now,
      gpu: s.gpu,
      models: VOICE_STT_MODELS.map((id) => {
        const m = s.models[id];
        return {
          id,
          state: m.state,
          size: FAKE_VOICE_SIZES[id],
          received: m.state === 'ready' ? FAKE_VOICE_SIZES[id] : m.received,
          ...(m.problem && (m.state === 'waiting' || m.state === 'failed') ? { problem: m.problem } : {}),
          inUse: needs(id),
        };
      }),
      maxSeconds: VOICE_TYPING_MAX_SECONDS,
      dutchVoice: {
        on: dutchOn,
        state: dutchState,
        size: FAKE_VOICE_SIZES.supertonic,
        received: dutchOn ? (dutchState === 'ready' ? FAKE_VOICE_SIZES.supertonic : dutchModel.received) : 0,
        ...(dutchOn && dutchModel.problem && (dutchState === 'waiting' || dutchState === 'failed')
          ? { problem: dutchModel.problem }
          : {}),
        agreedAt: dutchOn ? s.dutchVoice.agreedAt : null,
        licenceVersion: dutchOn ? s.dutchVoice.licenceVersion : null,
      },
    };
  }

  /** Moves the downloads on, one tick at a time, while any runs. */
  function tick() {
    timer = null;
    let any = false;
    for (const id of VOICE_DOWNLOAD_MODELS) {
      const m = s.models[id];
      if (m.state !== 'downloading') continue;
      m.received = Math.min(FAKE_VOICE_SIZES[id], m.received + (FAKE_VOICE_SIZES[id] * TICK_MS) / downloadMs);
      if (m.received >= FAKE_VOICE_SIZES[id]) {
        m.state = 'ready';
        m.received = FAKE_VOICE_SIZES[id];
      } else any = true;
    }
    if (any) timer = setTimer(tick, TICK_MS);
    changed();
  }

  function download(id: VoiceDownloadModel) {
    const m = s.models[id];
    if (m.state === 'ready' || m.state === 'downloading') return;
    s.models[id] = { state: 'downloading', received: 0 };
    if (timer === null) timer = setTimer(tick, TICK_MS);
  }

  /** What the settings need and isn't there starts downloading (DT-05). */
  function fetchNeeded() {
    for (const id of VOICE_STT_MODELS) if (needs(id) && s.models[id].state === 'absent') download(id);
  }

  // A world that starts with a download under way moves it on.
  if (VOICE_DOWNLOAD_MODELS.some((id) => s.models[id].state === 'downloading'))
    timer = setTimer(tick, TICK_MS);

  function call(op: string, raw: unknown) {
    if (!s.available) return err(404, 'unknown_op', `No operation ${op}`);
    const input = (raw ?? {}) as Record<string, unknown>;
    switch (op) {
      case 'voice.get':
        return ok(state());
      case 'voice.update': {
        const keys = Object.keys(input);
        if (keys.some((k) => !['on', 'model', 'language'].includes(k))) return invalid();
        if ('on' in input && typeof input.on !== 'boolean') return invalid();
        if ('model' in input && !(VOICE_MODEL_CHOICES as readonly unknown[]).includes(input.model))
          return invalid();
        if ('language' in input && !(VOICE_LANGUAGES as readonly unknown[]).includes(input.language))
          return invalid();
        Object.assign(s, input);
        fetchNeeded();
        changed();
        return ok(state());
      }
      case 'voice.setDutchVoice': {
        const keys = Object.keys(input);
        if (input.on === true) {
          if (
            keys.some((k) => !['on', 'licenceVersion'].includes(k)) ||
            input.licenceVersion !== DUTCH_VOICE_LICENCE_VERSION
          )
            return invalid();
          s.dutchVoice = {
            on: true,
            agreedAt: new Date().toISOString(),
            licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
          };
          download('supertonic');
          changed();
          return ok(state());
        }
        if (input.on === false && keys.every((k) => k === 'on')) {
          s.dutchVoice = { on: false, agreedAt: null, licenceVersion: null };
          s.models.supertonic = { state: 'absent', received: 0 };
          changed();
          return ok(state());
        }
        return invalid();
      }
      case 'voice.fetchModel': {
        if (!isDownloadModel(input.model)) return invalid();
        if (input.model === 'supertonic' && !s.dutchVoice.on)
          return err(403, 'forbidden', 'Agree to the Dutch voice licence before downloading it.');
        download(input.model);
        changed();
        return ok(state());
      }
      case 'voice.removeModel': {
        if (!isDownloadModel(input.model)) return invalid();
        if (input.model === 'supertonic' ? s.dutchVoice.on : needs(input.model))
          return err(409, 'conflict', 'The settings use this model.', { code: 'in_use' });
        s.models[input.model] = { state: 'absent', received: 0 };
        changed();
        return ok(state());
      }
      default:
        return err(404, 'unknown_op', `No operation ${op}`);
    }
  }

  async function dictate(bytes: Uint8Array): Promise<DictationOutput> {
    const header = readWavHeader(bytes);
    const seconds = header?.seconds ?? 0;
    heard.push(seconds);
    await new Promise<void>((resolve) => setTimer(resolve, transcribeMs));
    if (refuse) {
      const code = refuse;
      refuse = null;
      throw refusal(code);
    }
    if (!s.on) throw refusal('dictation_off');
    const model = uses();
    if (!model) throw refusal('not_ready');
    if (!header || header.rate !== VOICE_SAMPLE_RATE || header.channels !== 1 || header.bits !== 16)
      throw refusal('bad_audio');
    if (seconds > VOICE_TYPING_MAX_SECONDS) throw refusal('too_long');
    const text = seconds < 0.3 ? '' : (options.transcript?.(seconds) ?? FAKE_TRANSCRIPT);
    return { text, seconds: Math.round(seconds), model };
  }

  return {
    call,
    dictate,
    state,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refuseNext(code) {
      refuse = code;
    },
    heard: () => heard,
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * A fake box's operations and uploads with voice typing: `voice.*` and `dictation` recordings go to `voice`, the rest
 * to what the box answered before.
 */
export function withFakeVoice(
  options: Pick<FakeApplianceOptions, 'handle' | 'completeUpload'>,
  voice: FakeVoice,
): Pick<FakeApplianceOptions, 'handle' | 'completeUpload'> {
  const handle: FakeHandler = async (op, input, context) =>
    op.startsWith('voice.') ? voice.call(op, input) : options.handle(op, input, context);
  return {
    handle,
    completeUpload: async (upload) => {
      if (upload.target.type === 'dictation') return voice.dictate(upload.bytes);
      return options.completeUpload ? options.completeUpload(upload) : { attachmentId: upload.attachmentId };
    },
  };
}

/**
 * The fixture worlds' voice typing: `ready` (Fast downloaded, no graphics chip; the start of most boxes), `gpu` (both
 * models on a Radeon 8050S, Automatic using Most accurate), `downloading` (Fast at 40 %, the mic says it is still
 * coming), `failed` (no room for Most accurate, chosen on a box without a chip: slow), `off`.
 */
export const FAKE_VOICE_WORLDS = ['ready', 'gpu', 'downloading', 'failed', 'off'] as const;
export type FakeVoiceWorld = (typeof FAKE_VOICE_WORLDS)[number];

export function fakeVoiceSeed(world: FakeVoiceWorld): FakeVoiceOptions['initial'] {
  switch (world) {
    case 'ready':
      return {};
    case 'gpu':
      return {
        gpu: { name: 'AMD Radeon 8050S' },
        models: { whisper: { state: 'ready', received: FAKE_VOICE_SIZES.whisper } },
      };
    case 'downloading':
      return {
        models: { parakeet: { state: 'downloading', received: Math.round(FAKE_VOICE_SIZES.parakeet * 0.4) } },
      };
    case 'failed':
      return {
        model: 'whisper',
        language: 'nl',
        models: { whisper: { state: 'failed', received: 0, problem: 'no_room' } },
      };
    case 'off':
      return { on: false };
  }
}
