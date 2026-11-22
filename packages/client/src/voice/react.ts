/**
 * Voice typing in React, the same on the web and the phone (docs/decisions/dictation.md DT-01, DT-06, DT-08, DT-11):
 * `voice.get` in the query cache under `voice.get` (so `voice.changed` and a resync of `me` refetch it,
 * `query/apply.ts`), the settings' changes that put the answer straight into it, and `useVoiceTyping`, a composer's mic:
 * the controller, the recording's clock and waveform, and a failure's words for a moment. The platform brings its
 * `VoiceApi` (`voiceApi(session)`) and its recorder.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { VoiceDownloadModel, VoiceTyping, VoiceTypingPatch } from '@whombat/core/domain';
import type { VoiceDutchInput } from '@whombat/protocol/session';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QUERY_ROOT } from '../query/keys';
import type { VoiceApi } from './api';
import {
  VOICE_TYPING_IDLE,
  type VoiceDraft,
  type VoiceRecorder,
  VoiceTypingController,
  type VoiceTypingProblem,
  type VoiceTypingState,
  voiceTypingBusy,
} from './controller';
import {
  pushVoiceLevel,
  VOICE_ERROR_SHOWN_MS,
  type VoiceMic,
  voiceMicOf,
  voiceProblemText,
  voiceTypingProblemOf,
} from './model';

/** Where `voice.get` is kept: an endpoint-shaped key, so `queryKeys.scope('voice.get')` finds it. */
export const VOICE_QUERY_KEY = [QUERY_ROOT, 'voice.get', {}, {}] as const;

/**
 * Voice typing as the box has it (`voice.get`), or no data where there is none to ask (`api` null), on a box without it
 * (`unknown_op`) or while `enabled` is false. Not retried: a refusal is an answer.
 */
export function useVoice(api: VoiceApi | null, enabled = true) {
  return useQuery({
    queryKey: VOICE_QUERY_KEY,
    queryFn: () => (api as VoiceApi).get(),
    enabled: api !== null && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export interface VoiceActions {
  /** Shown at once; put back as it was when refused. */
  update(patch: VoiceTypingPatch): Promise<VoiceTyping>;
  fetchModel(model: VoiceDownloadModel): Promise<VoiceTyping>;
  removeModel(model: VoiceDownloadModel): Promise<VoiceTyping>;
  setDutchVoice(input: VoiceDutchInput): Promise<VoiceTyping>;
}

/** The settings' changes, each keeping `voice.get`'s cache as the box answered. */
export function useVoiceActions(api: VoiceApi | null): VoiceActions {
  const qc = useQueryClient();
  return useMemo(() => {
    const need = (): VoiceApi => {
      if (!api) throw new Error('There is no voice typing here.');
      return api;
    };
    const read = () => qc.getQueryData<VoiceTyping>(VOICE_QUERY_KEY);
    const put = (voice: VoiceTyping) => {
      qc.setQueryData(VOICE_QUERY_KEY, voice);
      return voice;
    };
    return {
      async update(patch) {
        const before = read();
        if (before) put({ ...before, ...patch });
        try {
          return put(await need().update(patch));
        } catch (error) {
          if (before) put(before);
          throw error;
        }
      },
      fetchModel: async (model) => put(await need().fetchModel(model)),
      removeModel: async (model) => put(await need().removeModel(model)),
      setDutchVoice: async (input) => put(await need().setDutchVoice(input)),
    };
  }, [api, qc]);
}

/** `Date.now()`, ticking every `ms` while `on`. */
function useClock(on: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return on ? now : Date.now();
}

export interface VoiceTypingOptions {
  api: VoiceApi | null;
  /** The burrow the recording is sent for; null: no mic. */
  burrow: string | null;
  /** This device's microphone; null where it has none to offer. */
  recorder: VoiceRecorder | null;
  /** Which draft the composer holds (a conversation, a thread): a new one drops what goes on. */
  ownerKey: string;
  /** The draft's text now. */
  text: string;
  /** Where the cursor or selection is in the field now. */
  selection(): { start: number; end: number };
  /** Puts the text in the draft with the cursor after the new words. */
  commit(text: string, selection: { start: number; end: number }): void;
  /** The phone asks for the microphone before recording; the browser asks when it starts. */
  requestPermission?: () => Promise<{ granted: boolean; canAskAgain: boolean }>;
}

export interface VoiceTypingView {
  /** The composer's mic: none, one that records, or one that says the model is still downloading. */
  mic: VoiceMic;
  state: VoiceTypingState;
  /** Whole seconds recorded, while recording. */
  seconds: number;
  /** The recent loudnesses, 0…1, oldest first: the waveform. */
  levels: readonly number[];
  /** A failure's words, for a few seconds. */
  error: string | null;
  /** While it records or works: the composer's controls are the recording bar, and it doesn't send. */
  active: boolean;
  /** The mic: records, or says why it can't. */
  start(): void;
  /** Done. */
  stop(): void;
  /** Cancel, or clear a failure's words. */
  cancel(): void;
  /** The app went to the background (the phone): a recording stops and is dropped, and it says so. */
  interrupt(): void;
}

/** A composer's voice typing (DT-01, DT-08). */
export function useVoiceTyping(options: VoiceTypingOptions): VoiceTypingView {
  const voice = useVoice(options.api);
  const usable = options.api !== null && options.burrow !== null && options.recorder !== null;
  const mic: VoiceMic = usable ? voiceMicOf(voice.data) : 'hidden';
  const [state, setState] = useState<VoiceTypingState>(VOICE_TYPING_IDLE);
  const [levels, setLevels] = useState<readonly number[]>([]);
  const latest = useRef({ ...options, mic, maxSeconds: voice.data?.maxSeconds });
  latest.current = { ...options, mic, maxSeconds: voice.data?.maxSeconds };
  // Every change of the text counts, so a draft typed away and back is still a changed one.
  const revision = useRef(0);
  const lastText = useRef(options.text);
  if (lastText.current !== options.text) {
    lastText.current = options.text;
    revision.current += 1;
  }

  const controller = useRef<VoiceTypingController | null>(null);
  if (!controller.current)
    controller.current = new VoiceTypingController({
      get maxSeconds() {
        return latest.current.maxSeconds ?? 300;
      },
      recorder: {
        start: (o) => (latest.current.recorder as VoiceRecorder).start(o),
        stop: () => (latest.current.recorder as VoiceRecorder).stop(),
        cancel: async () => latest.current.recorder?.cancel(),
      },
      getTranscriber: () => {
        const { api, burrow } = latest.current;
        if (!api || !burrow) return null;
        return (wav, { signal }) => api.transcribe({ burrow, wav }, { signal });
      },
      check: (): VoiceTypingProblem | null => (latest.current.mic === 'not_ready' ? 'not_ready' : null),
      get requestPermission() {
        return latest.current.requestPermission;
      },
      readDraft: (): VoiceDraft => ({
        ownerKey: latest.current.ownerKey,
        text: latest.current.text,
        selection: latest.current.selection(),
        revision: revision.current,
      }),
      commitDraft: (text, selection) => latest.current.commit(text, selection),
      onStateChange: (next) => {
        setState(next);
        if (next.phase === 'preparing') setLevels([]);
      },
      onLevel: (level) => setLevels((all) => pushVoiceLevel(all, level)),
      problemOf: voiceTypingProblemOf,
    });
  const c = controller.current;

  // Another draft in this composer: what went on is dropped.
  const owner = useRef(options.ownerKey);
  useEffect(() => {
    if (owner.current === options.ownerKey) return;
    owner.current = options.ownerKey;
    c.ownerChanged();
  }, [options.ownerKey, c]);
  useEffect(() => () => c.dispose(), [c]);

  // A failure's words stay a moment, then the composer is quiet again.
  useEffect(() => {
    if (state.phase !== 'error') return;
    const t = setTimeout(() => c.cancel(), VOICE_ERROR_SHOWN_MS);
    return () => clearTimeout(t);
  }, [state, c]);

  const recording = state.phase === 'recording';
  const now = useClock(recording, 250);
  const seconds = recording && state.since !== null ? Math.max(0, Math.floor((now - state.since) / 1000)) : 0;

  const start = useCallback(() => void c.start(), [c]);
  const stop = useCallback(() => void c.stop(), [c]);
  const cancel = useCallback(() => c.cancel(), [c]);
  const interrupt = useCallback(() => c.movedToBackground(), [c]);
  return {
    mic,
    state,
    seconds,
    levels,
    error: state.phase === 'error' && state.problem ? voiceProblemText(state.problem) : null,
    active: voiceTypingBusy(state),
    start,
    stop,
    cancel,
    interrupt,
  };
}
