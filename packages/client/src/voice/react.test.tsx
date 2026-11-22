// @vitest-environment jsdom
/**
 * Voice typing's hooks (dictation.md DT-01, DT-06, DT-08): `voice.get` under its endpoint key, a setting shown at once
 * and put back when refused, and a composer's mic — hidden without voice typing, the words into the draft after Done,
 * the box's refusal in words.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { VoiceTyping } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../query/keys';
import { OperationError } from '../session/managed-ops';
import { StreamError } from '../session/types';
import type { VoiceApi } from './api';
import { resetVoiceTypingForTests, type VoiceRecorder } from './controller';
import { createFakeVoice, FAKE_TRANSCRIPT, type FakeVoice } from './fake';
import { VOICE_TEXT } from './model';
import { useVoice, useVoiceActions, useVoiceTyping, VOICE_QUERY_KEY } from './react';
import { encodeWav } from './wav';

/** The fake's ops as the session would answer them, without a session. */
function apiOf(voice: FakeVoice): VoiceApi {
  const call = async (op: string, input: unknown = {}) => {
    const r = voice.call(op, input);
    if (r.status < 300) return r.body as VoiceTyping;
    const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
    throw new OperationError(op, r.status, e.code, e.message, e.details);
  };
  return {
    get: () => call('voice.get'),
    update: (patch) => call('voice.update', patch),
    fetchModel: (model) => call('voice.fetchModel', { model }),
    removeModel: (model) => call('voice.removeModel', { model }),
    setDutchVoice: (input) => call('voice.setDutchVoice', input),
    transcribe: async ({ wav }) => {
      try {
        return await voice.dictate(wav);
      } catch (error) {
        const e = error as { code: string; message: string; details?: unknown };
        throw new StreamError(e.code, e.message, e.details);
      }
    },
  };
}

const recorder: VoiceRecorder = {
  start: async () => {},
  stop: async () => encodeWav(new Int16Array(16_000).fill(900)),
  cancel: async () => {},
};

function setup(voice = createFakeVoice({ transcribeMs: 0 })) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper, voice, api: apiOf(voice) };
}

/** A composer: its text and cursor, voice typing on top. */
function useComposer(api: VoiceApi | null, initial = 'Hello') {
  const [text, setText] = useState(initial);
  const voice = useVoiceTyping({
    api,
    burrow: 'home',
    recorder,
    ownerKey: 'chat',
    text,
    selection: () => ({ start: text.length, end: text.length }),
    commit: (next) => setText(next),
  });
  return { text, setText, voice };
}

beforeEach(() => resetVoiceTypingForTests());
afterEach(() => resetVoiceTypingForTests());

describe('voice hooks', () => {
  it('reads voice.get where `voice.changed` refetches it', async () => {
    const { qc, wrapper, api } = setup();
    const { result } = renderHook(() => useVoice(api), { wrapper });
    await waitFor(() => expect(result.current.data?.ready).toBe(true));
    expect(qc.getQueryCache().findAll({ queryKey: queryKeys.scope('voice.get') })).toHaveLength(1);
  });

  it('shows a setting at once and puts it back when refused', async () => {
    const { qc, wrapper, api } = setup();
    const { result } = renderHook(() => ({ voice: useVoice(api), actions: useVoiceActions(api) }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.voice.data).toBeDefined());
    await act(() => result.current.actions.update({ language: 'nl' }));
    expect(qc.getQueryData<VoiceTyping>(VOICE_QUERY_KEY)?.language).toBe('nl');
    const refusing = { ...api, update: () => Promise.reject(new Error('no')) };
    const { result: other } = renderHook(() => useVoiceActions(refusing), { wrapper });
    await act(() => expect(other.current.update({ language: 'en' })).rejects.toThrow());
    expect(qc.getQueryData<VoiceTyping>(VOICE_QUERY_KEY)?.language).toBe('nl');
  });

  it('puts what was said into the draft after Done, and never sends it', async () => {
    const { wrapper, api } = setup();
    const { result } = renderHook(() => useComposer(api), { wrapper });
    await waitFor(() => expect(result.current.voice.mic).toBe('ready'));
    act(() => result.current.voice.start());
    await waitFor(() => expect(result.current.voice.state.phase).toBe('recording'));
    expect(result.current.voice.active).toBe(true);
    act(() => result.current.voice.stop());
    await waitFor(() => expect(result.current.text).toBe(`Hello ${FAKE_TRANSCRIPT}`));
    expect(result.current.voice.state.phase).toBe('idle');
  });

  it('has no mic without voice typing, and says why when its model is still coming', async () => {
    const off = setup(createFakeVoice({ initial: { on: false } }));
    const { result: hidden } = renderHook(() => useComposer(off.api), { wrapper: off.wrapper });
    await waitFor(() => expect(off.qc.getQueryData(VOICE_QUERY_KEY)).toBeDefined());
    expect(hidden.current.voice.mic).toBe('hidden');
    const { result: nothing } = renderHook(() => useComposer(null), { wrapper: off.wrapper });
    expect(nothing.current.voice.mic).toBe('hidden');

    const coming = setup(
      createFakeVoice({
        initial: { models: { parakeet: { state: 'downloading', received: 1 } } },
        downloadMs: 1e9,
      }),
    );
    const { result } = renderHook(() => useComposer(coming.api), { wrapper: coming.wrapper });
    await waitFor(() => expect(result.current.voice.mic).toBe('not_ready'));
    act(() => result.current.voice.start());
    await waitFor(() => expect(result.current.voice.error).toBe(VOICE_TEXT.errors.not_ready));
    coming.voice.dispose();
  });

  it('says what the box refused', async () => {
    const { wrapper, api, voice } = setup();
    const { result } = renderHook(() => useComposer(api), { wrapper });
    await waitFor(() => expect(result.current.voice.mic).toBe('ready'));
    voice.refuseNext('busy');
    act(() => result.current.voice.start());
    await waitFor(() => expect(result.current.voice.state.phase).toBe('recording'));
    act(() => result.current.voice.stop());
    await waitFor(() => expect(result.current.voice.error).toBe(VOICE_TEXT.errors.busy));
    expect(result.current.text).toBe('Hello');
  });
});
