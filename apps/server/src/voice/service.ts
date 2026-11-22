/**
 * Voice typing on the box (docs/decisions/dictation.md): the person's settings, the speech models the box downloads for
 * them, and a recording turned into text.
 *
 * - **The view** (`voice.get`, `view.ts`) comes from the settings, the desk's Talk switch, the speech service's health
 *   and the model fetcher's downloads.
 * - **What is downloaded**: at the start (again every while until the fetcher and the speech service answered),
 *   after every change of the settings and of the desk's settings (`desk.changed`), the fetcher is asked for the wanted
 *   models that aren't there; one that failed is asked again by itself once per start, after that only on *Try again*.
 *   Nothing is removed by itself.
 * - **While a model downloads or waits** the fetcher is asked every 2 s and `voice.changed` (topic `me`) says what moved,
 *   at most every 2 s; a change of the settings or of a model by the person says it at once. A model that
 *   arrives or goes makes the speech service's health be asked again.
 * - **A recording** (`dictate`, the `dictation` upload) goes to the speech service with the settings' model and
 *   language and, for Whisper, the names the person may say. Neither the audio nor the text is kept or logged.
 */
import type { VoiceModelState } from '@whombat/control-contracts/local';
import { topics } from '@whombat/core';
import {
  type DictationErrorCode,
  type DictationOutput,
  VOICE_TYPING_MAX_SECONDS,
  VOICE_TYPING_TEXT_MAX,
  VOICE_WORDS,
  type VoiceDownloadModel,
  type VoiceTyping,
  type VoiceTypingPatch,
} from '@whombat/core/domain';
import type { VoiceDutchInput } from '@whombat/protocol/session';
import { asc } from 'drizzle-orm';
import { externalEffect, outsideCommandScope } from '../commit/scope';
import { burrows } from '../db/schema/index';
import { loadDeskRow } from '../desk/store';
import { namesToHear, SILENCE_PEAK, sttPrompt } from '../desk/talk';
import { thePerson } from '../domain/the-person';
import { ApiError, forbidden } from '../lib/errors';
import { requirePerson, type SessionPrincipal } from '../managed/trust';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { VoiceModelsCallError, voiceModelsFor } from './models';
import {
  answeringVoiceHealth,
  checkDictationWav,
  forgetVoiceHealth,
  VoiceCallError,
  voiceFor,
  WavError,
  wavPeak,
} from './speech';
import { loadVoiceSettings, setDutchVoice, updateVoiceTyping } from './store';
import { type VoiceFacts, voiceTypingView, wantedModels, wantsDutchVoice } from './view';

export interface VoiceTypingTimings {
  /** How often the fetcher is asked while a model downloads or waits. */
  pollMs: number;
  /** `voice.changed` for a download's progress at most this often. */
  announceMs: number;
  /** How soon the start's check runs again while the fetcher or the speech service doesn't answer yet. */
  startRetryMs: number;
}

export const VOICE_TYPING_TIMINGS: VoiceTypingTimings = {
  pollMs: 2_000,
  announceMs: 2_000,
  startRetryMs: 15_000,
};

/** Why a recording wasn't turned into text (`error.details.code` of the upload stream). */
export class DictationError extends Error {
  constructor(readonly code: DictationErrorCode) {
    super(VOICE_WORDS.errors[code]);
    this.name = 'DictationError';
  }
}

/**
 * What was said, as it goes into a draft: the speech service's notes about the sound (“[BLANK_AUDIO]”, “(music)”,
 * “*coughs*”) go, and what has no letter or digit left is nothing; at most `VOICE_TYPING_TEXT_MAX` characters.
 */
export function dictatedText(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  if (text.length <= VOICE_TYPING_TEXT_MAX) return text;
  // Cut between characters, never inside one.
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > VOICE_TYPING_TEXT_MAX) break;
    out += ch;
  }
  return out.trimEnd();
}

type Announce = 'now' | 'changed';

/** The longest wait between the start's checks while the fetcher or the speech service doesn't answer. */
const START_RETRY_MAX_MS = 5 * 60_000;

/** The fetcher didn't answer or refused: the person can try again in a moment. */
function fetcherDown(err: unknown): never {
  if (err instanceof VoiceModelsCallError)
    throw new ApiError('unavailable', 'This Whombat can’t reach its speech model downloads right now.');
  throw err;
}

/** Whether the fetcher still holds any complete, partial or removing files for the opt-in Dutch voice model. */
function dutchHasFiles(fetched: readonly VoiceModelState[] | null): boolean {
  const m = fetched?.find((x) => x.id === 'supertonic');
  return m !== undefined && (m.state !== 'absent' || m.received > 0);
}

/** Whether any model still has leftover files being removed on disk (wanted or not). */
function hasRemovingModels(facts: VoiceFacts): boolean {
  return (facts.fetched ?? []).some((m) => m.state === 'removing');
}

export class VoiceTypingService {
  readonly #services: Services;
  readonly #timings: VoiceTypingTimings;
  /** Failed downloads asked for again by themselves since this start: once each. */
  readonly #retried = new Set<VoiceDownloadModel>();
  /** Checks and the person's changes run one at a time. */
  #tail: Promise<unknown> = Promise.resolve();
  /** The models the fetcher had ready when last asked (null: not asked yet). */
  #readyKey: string | null = null;
  /** What `voice.changed` last told (the view as JSON; null: nothing yet). */
  #told: string | null = null;
  #toldAt = 0;
  #tellTimer: NodeJS.Timeout | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #startTimer: NodeJS.Timeout | null = null;
  #removeTimer: NodeJS.Timeout | null = null;
  /** Set when Dutch voice was turned off but removal has not yet succeeded at the fetcher. */
  #dutchRemovePending = false;
  /** Next wait before retrying a failed Dutch voice removal (pollMs, doubled up to five minutes). */
  #dutchRemoveWait = 0;
  /** The start's next check: `startRetryMs`, doubled each time up to five minutes. */
  #startWait = 0;
  #offBus: (() => void) | null = null;
  #started = false;
  #closed = false;

  constructor(services: Services, timings: Partial<VoiceTypingTimings> = {}) {
    this.#services = services;
    this.#timings = { ...VOICE_TYPING_TIMINGS, ...timings };
  }

  /**
   * Starts asking for the models the settings want: now, again every while until the fetcher and the speech service
   * answered, and after every change of the desk's settings (its Talk switch wants Parakeet too).
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#offBus = this.#services.bus.onFrame((frame) => {
      if (frame.event.type !== 'desk.changed') return;
      outsideCommandScope(
        () =>
          void this.settingsChanged().catch((err) =>
            this.#services.log.warn({ err: String(err) }, 'voice typing: the desk’s change wasn’t followed'),
          ),
      );
    });
    outsideCommandScope(() => void this.#startCheck());
  }

  close(): void {
    this.#closed = true;
    this.#offBus?.();
    this.#offBus = null;
    for (const timer of [this.#tellTimer, this.#pollTimer, this.#startTimer, this.#removeTimer])
      if (timer) clearTimeout(timer);
    this.#tellTimer = this.#pollTimer = this.#startTimer = this.#removeTimer = null;
  }

  /** `voice.get`. */
  async view(): Promise<VoiceTyping> {
    return voiceTypingView(await this.#facts());
  }

  /** The settings, or the desk's, changed: ask for what they want now and tell what changed. */
  settingsChanged(): Promise<VoiceTyping> {
    return this.#serial(() => this.#check('changed'));
  }

  /** `voice.update`: the person's settings in one commit, then what they want downloaded. */
  async update(principal: SessionPrincipal, patch: VoiceTypingPatch): Promise<VoiceTyping> {
    requirePerson(principal);
    const changes = Object.keys(patch).length > 0;
    return this.#serial(async () => {
      const person = await this.#person(principal);
      if (changes) {
        const res = await this.#services.pipeline.commit(updateVoiceTyping, patch, {
          burrowId: person.burrowId,
          actorId: person.id,
        });
        if (res.status !== 'ok') throw new ApiError('forbidden', res.message);
      }
      return this.#check(changes ? 'now' : 'changed');
    });
  }

  /** `voice.setDutchVoice`: record the person's agreement and start downloading, or turn off and remove the files. */
  async setDutchVoice(principal: SessionPrincipal, input: VoiceDutchInput): Promise<VoiceTyping> {
    requirePerson(principal);
    return this.#serial(async () => {
      const person = await this.#person(principal);
      // Turning on requires the model fetcher so we never record consent for a download the box can't run.
      const fetcher = input.on ? this.#fetcher() : voiceModelsFor(this.#services);
      const res = await this.#services.pipeline.commit(setDutchVoice, input, {
        burrowId: person.burrowId,
        actorId: person.id,
      });
      if (res.status !== 'ok') throw new ApiError('forbidden', res.message);
      if (input.on) {
        this.#dutchRemovePending = false;
        await externalEffect(
          'voice.fetch_model',
          () => (fetcher as NonNullable<typeof fetcher>).fetch('supertonic'),
          {
            idempotent: true,
          },
        ).catch(fetcherDown);
      } else if (fetcher) {
        try {
          await externalEffect('voice.remove_model', () => fetcher.remove('supertonic'));
          this.#dutchRemovePending = false;
          forgetVoiceHealth(this.#services);
        } catch (err: unknown) {
          this.#dutchRemovePending = true;
          this.#services.log.warn(
            { err: String(err) },
            'voice: Dutch voice files weren’t removed yet; will retry until removal succeeds',
          );
        }
      }
      return this.#check('now', { ensure: false });
    });
  }

  /** `voice.fetchModel`: *Download* and *Try again*. */
  async fetchModel(principal: SessionPrincipal, model: VoiceDownloadModel): Promise<VoiceTyping> {
    requirePerson(principal);
    return this.#serial(async () => {
      await this.#person(principal);
      if (model === 'supertonic') {
        const settings = await loadVoiceSettings(this.#services.db);
        if (!wantsDutchVoice(settings))
          throw forbidden('Agree to the Dutch voice licence before downloading it.');
      }
      const fetcher = this.#fetcher();
      // A download asked twice is one download (the fetcher leaves one on its way as it is).
      await externalEffect('voice.fetch_model', () => fetcher.fetch(model), { idempotent: true }).catch(
        fetcherDown,
      );
      return this.#check('now', { ensure: false });
    });
  }

  /** `voice.removeModel`: *Remove*, only for a model the settings don't need. */
  async removeModel(principal: SessionPrincipal, model: VoiceDownloadModel): Promise<VoiceTyping> {
    requirePerson(principal);
    return this.#serial(async () => {
      await this.#person(principal);
      const fetcher = this.#fetcher();
      const facts = await this.#facts();
      if (model === 'supertonic') {
        if (wantsDutchVoice(facts.settings))
          throw new ApiError('conflict', 'Turn Dutch voice off to remove it.', {
            details: { code: 'in_use' },
          });
      } else {
        const view = voiceTypingView(facts);
        if (view.models.find((m) => m.id === model)?.inUse)
          throw new ApiError('conflict', 'Voice typing needs this speech model now.', {
            details: { code: 'in_use' },
          });
      }
      try {
        await externalEffect('voice.remove_model', () => fetcher.remove(model));
      } catch (err: unknown) {
        const after = await this.#facts();
        this.#follow(after);
        this.#tell(voiceTypingView(after), 'now');
        fetcherDown(err);
      }
      forgetVoiceHealth(this.#services);
      return this.#check('now', { ensure: false });
    });
  }

  /**
   * A recording to text: voice typing must be on and have a model; the WAV 16 kHz mono 16-bit of at most five
   * minutes. `burrowId` is the person's burrow (whose names Whisper is told); `signal` stops waiting for the speech
   * service once nobody waits for the text. `desk`: the desk's Talk asks, which its own switch
   * already allowed, so voice typing's switch doesn't matter; the model and language are voice typing's all the same.
   */
  async dictate(
    audio: Buffer,
    burrowId: string,
    signal?: AbortSignal,
    options: { desk?: boolean } = {},
  ): Promise<DictationOutput> {
    const services = this.#services;
    const facts = await this.#facts({ fetcher: false });
    const view = voiceTypingView(facts);
    if (!view.on && !options.desk) throw new DictationError('dictation_off');
    const voice = voiceFor(services);
    if (!voice || !view.uses) throw new DictationError('not_ready');
    let seconds: number;
    let silent: boolean;
    try {
      const wav = checkDictationWav(audio);
      seconds = wav.seconds;
      silent = wavPeak(wav) < SILENCE_PEAK;
    } catch (err) {
      throw new DictationError(err instanceof WavError && err.tooLong ? 'too_long' : 'bad_audio');
    }
    const whole = Math.min(VOICE_TYPING_MAX_SECONDS, Math.round(seconds));
    // A recording of nothing is nothing heard (and Whisper makes words up for silence).
    if (silent) return { text: '', seconds: whole, model: view.uses };
    const prompt = view.uses === 'whisper' ? await this.#names(burrowId) : '';
    const started = Date.now();
    try {
      const heard = await voice.transcribe(audio, {
        model: facts.settings.model,
        language: facts.settings.language,
        ...(prompt ? { prompt } : {}),
        seconds,
        ...(signal ? { signal } : {}),
      });
      const text = dictatedText(heard.text);
      services.log.info(
        { bytes: audio.length, seconds: whole, ms: Date.now() - started, model: heard.model, gpu: heard.gpu },
        'voice typing: a recording turned into text',
      );
      return { text, seconds: Math.min(VOICE_TYPING_MAX_SECONDS, heard.seconds), model: heard.model };
    } catch (err) {
      // Nobody waits for the text any more.
      if (signal?.aborted) throw new DictationError('failed');
      const code = err instanceof VoiceCallError ? err.code : 'error';
      services.log.warn(
        { bytes: audio.length, seconds: whole, ms: Date.now() - started, code },
        'voice typing: the recording wasn’t turned into text',
      );
      throw new DictationError(await this.#dictationCode(code));
    }
  }

  /** The speech service's refusal as the person hears it. */
  async #dictationCode(code: VoiceCallError['code']): Promise<DictationErrorCode> {
    if (code === 'busy') return 'busy';
    if (code === 'bad_audio') return 'bad_audio';
    if (code === 'too_large') return 'too_long';
    if (code !== 'unavailable') return 'failed';
    // The model may have gone, or the service may not answer: not ready when no model can hear it now.
    forgetVoiceHealth(this.#services);
    const view = voiceTypingView(await this.#facts({ fetcher: false }));
    return view.uses ? 'failed' : 'not_ready';
  }

  /* The checks -------------------------------------------------------------------------------------------------- */

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => {});
    return run;
  }

  /** The start's check, again every while until the fetcher and the speech service answered. */
  async #startCheck(): Promise<void> {
    this.#startTimer = null;
    if (this.#closed) return;
    let answered = false;
    try {
      const facts = await this.#serial(async () => {
        let facts = await this.#facts();
        const asked = await this.#ask(facts);
        if (asked) facts = await this.#facts();
        this.#follow(facts);
        this.#tell(voiceTypingView(facts), asked ? 'now' : 'changed');
        return facts;
      });
      answered =
        (facts.fetched !== null || voiceModelsFor(this.#services) === null) &&
        (facts.health !== null || voiceFor(this.#services) === null);
    } catch (err) {
      this.#services.log.debug({ err: String(err) }, 'voice typing: the start’s check failed');
    }
    if (answered || this.#closed) return;
    this.#startWait = Math.min(
      START_RETRY_MAX_MS,
      this.#startWait ? this.#startWait * 2 : this.#timings.startRetryMs,
    );
    this.#startTimer = setTimeout(() => outsideCommandScope(() => void this.#startCheck()), this.#startWait);
    this.#startTimer.unref?.();
  }

  /**
   * Asks for what the settings want (unless `ensure` is false; a failed one again only when `retry` isn't false),
   * follows downloads, and tells what changed.
   */
  async #check(
    announce: Announce,
    options: { ensure?: boolean; retry?: boolean } = {},
  ): Promise<VoiceTyping> {
    let facts = await this.#facts();
    if (options.ensure !== false && (await this.#ask(facts, options.retry !== false)))
      facts = await this.#facts();
    this.#follow(facts);
    const view = voiceTypingView(facts);
    this.#tell(view, announce);
    return view;
  }

  /**
   * Asks the fetcher for the wanted models that aren't there, and (with `retry`) once per start for a failed one; also
   * finishes removing the opt-in Dutch voice model while off and any non-wanted model left in `removing`. True when the
   * fetcher state may have changed.
   */
  async #ask(facts: VoiceFacts, retry = true): Promise<boolean> {
    const fetcher = voiceModelsFor(this.#services);
    if (!fetcher || !facts.fetched) return false;
    const gpu = voiceTypingView(facts).gpu !== null;
    const want = new Set<VoiceDownloadModel>(wantedModels(facts.settings, facts.deskTalk, gpu));
    const dutchWanted = wantsDutchVoice(facts.settings);
    if (dutchWanted) want.add('supertonic');
    let asked = false;
    for (const model of facts.fetched) {
      if (model.id === 'supertonic' && !dutchWanted) {
        // Turning Dutch voice off removes all files, including leftover removing or partial files,
        // and retries until removal succeeds.
        if (model.state !== 'absent' || model.received > 0 || this.#dutchRemovePending) {
          try {
            await externalEffect('voice.remove_model', () => fetcher.remove('supertonic'));
            this.#dutchRemovePending = false;
            forgetVoiceHealth(this.#services);
            this.#services.log.info({ model: model.id }, 'voice: removed disabled Dutch voice model');
            asked = true;
          } catch (err) {
            this.#dutchRemovePending = true;
            if (!(err instanceof VoiceModelsCallError && err.status === 0)) asked = true;
            this.#services.log.warn(
              { err: String(err), model: model.id },
              'voice: disabled Dutch voice model wasn’t removed; will retry',
            );
          }
        }
        continue;
      }
      if (!want.has(model.id)) {
        if (model.state === 'removing') {
          try {
            await externalEffect('voice.remove_model', () => fetcher.remove(model.id));
            forgetVoiceHealth(this.#services);
            this.#services.log.info({ model: model.id }, 'voice: finished removing leftover speech model');
            asked = true;
          } catch (err) {
            if (!(err instanceof VoiceModelsCallError && err.status === 0)) asked = true;
            this.#services.log.warn(
              { err: String(err), model: model.id },
              'voice: leftover speech model files weren’t removed; will retry',
            );
          }
        }
        continue;
      }
      const again = retry && model.state === 'failed' && !this.#retried.has(model.id);
      if (model.state !== 'absent' && model.state !== 'removing' && !again) continue;
      if (again) this.#retried.add(model.id);
      try {
        await externalEffect('voice.fetch_model', () => fetcher.fetch(model.id), { idempotent: true });
        this.#services.log.info({ model: model.id, again }, 'voice typing: asked for a speech model');
        asked = true;
      } catch (err) {
        if (!(err instanceof VoiceModelsCallError && err.status === 0)) asked = true;
        this.#services.log.warn(
          { err: String(err), model: model.id },
          'voice typing: a download wasn’t asked for',
        );
      }
    }
    return asked;
  }

  /**
   * While a model downloads or waits, the fetcher is asked again in a while, and what the settings want and isn't there
   * is asked for: a model that arrives refreshes the speech service's health, which may name the chip Most accurate
   * needs. A failed download isn't tried again here (once per start, at the next check, then *Try again*).
   */
  #follow(facts: VoiceFacts): void {
    const moving = (facts.fetched ?? []).some((m) => m.state === 'downloading' || m.state === 'waiting');
    if (moving && !this.#pollTimer && !this.#closed) {
      this.#pollTimer = setTimeout(
        () =>
          outsideCommandScope(() => {
            this.#pollTimer = null;
            void this.#serial(() => this.#check('changed', { retry: false })).catch((err) =>
              this.#services.log.debug({ err: String(err) }, 'voice typing: the downloads weren’t read'),
            );
          }),
        this.#timings.pollMs,
      );
      this.#pollTimer.unref?.();
    }
    const needsDutchRemove =
      !wantsDutchVoice(facts.settings) && (this.#dutchRemovePending || dutchHasFiles(facts.fetched));
    const needsRemove =
      voiceModelsFor(this.#services) !== null && (needsDutchRemove || hasRemovingModels(facts));
    if (!needsRemove) {
      this.#clearDutchRemovalRetry();
      return;
    }
    if (this.#removeTimer || this.#closed) return;
    this.#dutchRemoveWait = Math.min(
      START_RETRY_MAX_MS,
      this.#dutchRemoveWait ? this.#dutchRemoveWait * 2 : this.#timings.pollMs,
    );
    this.#removeTimer = setTimeout(
      () =>
        outsideCommandScope(() => {
          this.#removeTimer = null;
          void this.#serial(() => this.#check('changed', { retry: false })).catch((err) =>
            this.#services.log.debug({ err: String(err) }, 'voice: model removal retry failed'),
          );
        }),
      this.#dutchRemoveWait,
    );
    this.#removeTimer.unref?.();
  }

  #clearDutchRemovalRetry(): void {
    this.#dutchRemovePending = false;
    this.#dutchRemoveWait = 0;
    if (this.#removeTimer) {
      clearTimeout(this.#removeTimer);
      this.#removeTimer = null;
    }
  }

  /**
   * `voice.changed` to the person: `now` at once, `changed` only when the view changed and at most every
   * `announceMs`. The first view since the start is only remembered (nobody is connected yet).
   */
  #tell(view: VoiceTyping, announce: Announce): void {
    const told = JSON.stringify(view);
    const first = this.#told === null;
    if (announce === 'changed' && (first || told === this.#told)) {
      this.#told ??= told;
      return;
    }
    this.#told = told;
    const wait = announce === 'now' ? 0 : this.#toldAt + this.#timings.announceMs - Date.now();
    if (wait <= 0) {
      this.#publish();
      return;
    }
    if (this.#tellTimer || this.#closed) return;
    this.#tellTimer = setTimeout(
      () => outsideCommandScope(() => this.#publish()),
      Math.min(wait, this.#timings.announceMs),
    );
    this.#tellTimer.unref?.();
  }

  #publish(): void {
    if (this.#tellTimer) clearTimeout(this.#tellTimer);
    this.#tellTimer = null;
    this.#toldAt = Date.now();
    const services = this.#services;
    void this.#people()
      .then((people) => {
        const at = services.clock().toISOString();
        for (const id of people)
          services.bus.publish({
            topic: topics.me(id),
            event: { type: 'voice.changed' },
            eventId: null,
            at,
            outboxId: null,
          });
      })
      .catch((err) => services.log.warn({ err: String(err) }, 'voice typing: the change wasn’t told'));
  }

  /* Facts ------------------------------------------------------------------------------------------------------- */

  /** The settings, the desk's Talk, the speech service's health and (unless `fetcher` is false) the downloads. */
  async #facts(options: { fetcher?: boolean } = {}): Promise<VoiceFacts> {
    const db = this.#services.db;
    // The downloads first: a model that arrived or went makes the health be asked again.
    const fetched = options.fetcher === false ? null : await this.#downloads();
    const [settings, desk, health] = await Promise.all([
      loadVoiceSettings(db),
      loadDeskRow(db),
      answeringVoiceHealth(this.#services),
    ]);
    return {
      settings,
      deskTalk: desk?.voice ?? false,
      health,
      fetched,
      hasFetcher: voiceModelsFor(this.#services) !== null,
    };
  }

  async #downloads(): Promise<VoiceModelState[] | null> {
    const fetcher = voiceModelsFor(this.#services);
    if (!fetcher) return null;
    const state = await fetcher.state().catch((err: unknown) => {
      this.#services.log.debug({ err: String(err) }, 'voice typing: the model fetcher doesn’t answer');
      return null;
    });
    if (!state) return null;
    const ready = state.models
      .filter((m) => m.state === 'ready')
      .map((m) => m.id)
      .sort()
      .join(',');
    if (ready !== this.#readyKey) forgetVoiceHealth(this.#services);
    this.#readyKey = ready;
    return state.models;
  }

  #fetcher() {
    const fetcher = voiceModelsFor(this.#services);
    if (!fetcher) throw new ApiError('not_implemented', 'This Whombat doesn’t download speech models.');
    return fetcher;
  }

  /** The person's principal and burrow for a session of theirs (a Whombat is one person's). */
  async #person(principal: SessionPrincipal): Promise<{ id: string; burrowId: string }> {
    const { account } = requirePerson(principal);
    const db = this.#services.db;
    const rows = await db
      .select({ id: burrows.id })
      .from(burrows)
      .orderBy(asc(burrows.createdAt), asc(burrows.id));
    for (const { id } of rows) {
      const person = await thePerson(db, id);
      if (person?.accountId === account.id) return { id: person.id, burrowId: id };
    }
    throw forbidden('Only the person whose Whombat this is can change voice typing.');
  }

  /** Every burrow's person: who hears `voice.changed`. */
  async #people(): Promise<string[]> {
    const db = this.#services.db;
    const rows = await db.select({ id: burrows.id }).from(burrows);
    const people = await Promise.all(rows.map((r) => thePerson(db, r.id)));
    return people.flatMap((p) => (p ? [p.id] : []));
  }

  /** The names Whisper is told: the assistant's, the servers' and the things'. */
  async #names(burrowId: string): Promise<string> {
    try {
      const agent = await loadAgentRow(this.#services.db, burrowId);
      return sttPrompt(await namesToHear(this.#services, burrowId, agent?.name ?? null));
    } catch {
      return '';
    }
  }
}

const instances = new WeakMap<Services, VoiceTypingService>();

/** Stops the process's voice typing, if it has one (closing never makes one). */
export function closeVoiceTyping(services: Services): void {
  instances.get(services)?.close();
}

/** The process's voice typing (one per `Services`). */
export function voiceTypingFor(services: Services): VoiceTypingService {
  let service = instances.get(services);
  if (!service) {
    service = new VoiceTypingService(services);
    instances.set(services, service);
  }
  return service;
}

/** Tests: voice typing with these timings for these services (the one before is closed). */
export function setVoiceTypingFor(services: Services, service: VoiceTypingService): void {
  instances.get(services)?.close();
  instances.set(services, service);
}
