/**
 * Voice typing's ops here (docs/decisions/dictation.md): the Whombat's `voice.*` and `dictation` upload through its
 * session, or the demo box's, whose speech service is `fixtures/voice.ts`. The rest is `@whombat/client/voice` and
 * `voice/react`, as on the web: `useVoice` keeps `voice.get` in the query cache, which `voice.changed` (and the demo
 * service's own changes) refetch.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useWhombat } from '@whombat/client/react';
import { type VoiceApi, voiceApi } from '@whombat/client/voice';
import { VOICE_QUERY_KEY } from '@whombat/client/voice/react';
import { useEffect, useMemo } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import { demoVoice } from '../fixtures/voice';
import { useManaged } from '../managed/context';

export function useVoiceApi(): VoiceApi | null {
  const managed = useManaged();
  const { mode } = useBurrowBase();
  const { client } = useWhombat();
  const demo = !managed && mode === 'fixtures';
  const session = managed?.session ?? (demo ? client.session : null);
  const api = useMemo(() => (session ? voiceApi(session) : null), [session]);
  const qc = useQueryClient();
  useEffect(
    () =>
      demo ? demoVoice().onChange(() => void qc.invalidateQueries({ queryKey: VOICE_QUERY_KEY })) : undefined,
    [demo, qc],
  );
  return api;
}
