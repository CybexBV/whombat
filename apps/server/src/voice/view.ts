/**
 * Voice typing as Settings and the composers see it (docs/decisions/dictation.md), worked out from
 * the settings, the desk's Talk switch, the speech service's health and the model fetcher's downloads. Pure: the service
 * (`service.ts`) gathers the facts.
 */
import type { VoiceModelState } from '@whombat/control-contracts/local';
import {
  DUTCH_VOICE_LICENCE_VERSION,
  VOICE_STT_MODELS,
  VOICE_TYPING_MAX_SECONDS,
  type VoiceDutchVoice,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceSttModel,
  type VoiceTyping,
  type VoiceTypingModel,
} from '@whombat/core/domain';
import { VOICE_REMOVING_MINOR } from '@whombat/protocol/session';
import type { VoiceAbility } from './speech';

/** The box's voice typing and Dutch voice settings (`voice_typing`). */
export interface VoiceTypingSettings {
  on: boolean;
  model: VoiceModelChoice;
  language: VoiceLanguage;
  dutchVoice: boolean;
  dutchVoiceAgreedBy: string | null;
  dutchVoiceAgreedAt: Date | null;
  dutchVoiceLicenceVersion: string | null;
}

/** Until the person changes them: voice typing on, Automatic and Automatic; Dutch voice off. */
export const DEFAULT_VOICE_TYPING: VoiceTypingSettings = {
  on: true,
  model: 'auto',
  language: 'auto',
  dutchVoice: false,
  dutchVoiceAgreedBy: null,
  dutchVoiceAgreedAt: null,
  dutchVoiceLicenceVersion: null,
};

/** Whether the person has opted into the Dutch voice under the current licence version. */
export function wantsDutchVoice(settings: VoiceTypingSettings): boolean {
  return settings.dutchVoice && settings.dutchVoiceLicenceVersion === DUTCH_VOICE_LICENCE_VERSION;
}

export interface VoiceFacts {
  settings: VoiceTypingSettings;
  /** The desk's Talk is on (a paired screen's `DeskSettings.voice`): it hears with the same models. */
  deskTalk: boolean;
  /** The speech service's health; null when the box has none or it doesn't answer. */
  health: VoiceAbility | null;
  /** The fetcher's models; null when the box has no fetcher or it doesn't answer. */
  fetched: readonly VoiceModelState[] | null;
  /** The box has a model fetcher (`WHOMBAT_VOICE_MODELS_SOCKET`): its speech service is one that takes recordings. */
  hasFetcher: boolean;
}

/**
 * The model a recording goes to, as the speech service picks it: Automatic is Whisper when it is there and the
 * box has a graphics chip for it, else Parakeet, else Whisper on the processor; a chosen model only when it is there.
 */
export function modelFor(
  choice: VoiceModelChoice,
  ready: ReadonlySet<VoiceSttModel>,
  gpu: boolean,
): VoiceSttModel | null {
  if (choice !== 'auto') return ready.has(choice) ? choice : null;
  if (gpu && ready.has('whisper')) return 'whisper';
  if (ready.has('parakeet')) return 'parakeet';
  return ready.has('whisper') ? 'whisper' : null;
}

/**
 * What the settings want downloaded: nothing while neither voice typing nor the desk's Talk hears anything;
 * then Parakeet, and Whisper when it is chosen or, in Automatic, on a box with a graphics chip.
 */
export function wantedModels(
  settings: VoiceTypingSettings,
  deskTalk: boolean,
  gpu: boolean,
): Set<VoiceSttModel> {
  const want = new Set<VoiceSttModel>();
  if (!settings.on && !deskTalk) return want;
  want.add('parakeet');
  if (settings.model === 'whisper' || (settings.model === 'auto' && gpu)) want.add('whisper');
  return want;
}

/**
 * The speech service can turn a voice typing recording into text: it answers, and it is one that takes recordings — the
 * box has a model fetcher beside it, or it names its models. Before its first model is downloaded it names none, and
 * Settings must still show that download.
 */
export function canTranscribe(health: VoiceAbility | null, hasFetcher: boolean): boolean {
  return health !== null && (hasFetcher || Array.isArray(health.models));
}

/** `VoiceTyping` (`voice.get`): what Settings shows and whether the composers' mic works. */
export function voiceTypingView(facts: VoiceFacts): VoiceTyping {
  const { settings, health } = facts;
  const available = canTranscribe(health, facts.hasFetcher);
  const gpu = available && health?.gpu ? { name: health.gpu.name } : null;
  const running = new Set(available ? (health?.models ?? []) : []);
  const uses = available ? modelFor(settings.model, running, gpu !== null) : null;
  // What the settings need now can't be removed: what they want downloaded, and the model recordings go to while
  // voice typing or the desk's Talk hears.
  const needed = wantedModels(settings, facts.deskTalk, gpu !== null);
  if (uses && (settings.on || facts.deskTalk)) needed.add(uses);
  // Without a fetcher (or while it doesn't answer) the models are the ones the service runs.
  const listed: readonly VoiceModelState[] =
    facts.fetched ?? [...running].map((id) => ({ id, state: 'ready' as const, size: 0, received: 0 }));
  const isSttModel = (m: VoiceModelState): m is VoiceModelState & { id: VoiceSttModel } =>
    (VOICE_STT_MODELS as readonly string[]).includes(m.id);
  const models: VoiceTypingModel[] = listed
    .filter(isSttModel)
    .sort((a, b) => VOICE_STT_MODELS.indexOf(a.id) - VOICE_STT_MODELS.indexOf(b.id))
    .map((m) => ({
      id: m.id,
      state: m.state,
      size: m.size,
      received: m.state === 'removing' ? m.received : Math.min(m.received, m.size),
      ...(m.problem && (m.state === 'waiting' || m.state === 'failed') ? { problem: m.problem } : {}),
      inUse: needed.has(m.id),
    }));
  const dutchEntry = available ? (facts.fetched?.find((m) => m.id === 'supertonic') ?? null) : null;
  let dutchVoice: VoiceDutchVoice | null = null;
  if (dutchEntry) {
    const dutchOn = wantsDutchVoice(settings);
    const dutchFilesLeft = !dutchOn && (dutchEntry.state !== 'absent' || dutchEntry.received > 0);
    const dutchState = dutchOn ? dutchEntry.state : dutchFilesLeft ? 'removing' : 'absent';
    dutchVoice = {
      on: dutchOn,
      state: dutchState,
      size: dutchEntry.size,
      received: dutchOn
        ? Math.min(dutchEntry.received, dutchEntry.size)
        : dutchFilesLeft
          ? dutchEntry.received
          : 0,
      ...(dutchOn && dutchEntry.problem && (dutchState === 'waiting' || dutchState === 'failed')
        ? { problem: dutchEntry.problem }
        : {}),
      agreedAt: dutchOn && settings.dutchVoiceAgreedAt ? settings.dutchVoiceAgreedAt.toISOString() : null,
      licenceVersion: dutchOn ? settings.dutchVoiceLicenceVersion : null,
    };
  }
  return {
    available,
    on: settings.on,
    model: settings.model,
    language: settings.language,
    ready: available && settings.on && uses !== null,
    uses,
    gpu,
    models,
    maxSeconds: VOICE_TYPING_MAX_SECONDS,
    dutchVoice,
  };
}

/**
 * Shapes `VoiceTyping` for an older app whose `VoiceModelState` predates `'removing'`
 * (below `VOICE_REMOVING_MINOR`): maps `'removing'` to `'absent'` with 0 bytes so its parser accepts the response.
 */
export function voiceTypingForMinor(view: VoiceTyping, minor: number | undefined): VoiceTyping {
  if (minor === undefined || minor >= VOICE_REMOVING_MINOR) return view;
  return {
    ...view,
    models: view.models.map((m) => (m.state === 'removing' ? { ...m, state: 'absent', received: 0 } : m)),
    dutchVoice:
      view.dutchVoice && view.dutchVoice.state === 'removing'
        ? { ...view.dutchVoice, state: 'absent', received: 0 }
        : view.dutchVoice,
  };
}
