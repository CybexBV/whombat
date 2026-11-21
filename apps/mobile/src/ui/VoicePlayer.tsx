/**
 * Listen's player on the phone (desk-display-android.md AP-3426): `useVoicePlayer()` gives the `play` that
 * `useDeskListen` takes and the element to render where the voices are — while a sample plays, a 1dp WebView nobody
 * sees and TalkBack skips, playing the page of `data/voicePlayer.ts`. Removing the WebView stops the sound (another
 * voice, pressing Listen again, leaving the page). A sample that doesn't start within 10 s, or that the WebView
 * can't play, is an error (“The voice couldn’t play. Try again.”).
 */
import { base64 } from '@whombat/client';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  VOICE_PLAYER_END_MS,
  VOICE_PLAYER_START_MS,
  VOICE_PLAYER_WEBVIEW_PROPS,
  type VoicePlayerEvent,
  voicePlayerEvent,
  voicePlayerHtml,
} from '../data/voicePlayer';

export interface VoicePlayer {
  /** Plays a WAV: settles once it ended, at once when `signal` aborts; rejects when it doesn't play. */
  play(wav: Uint8Array, signal: AbortSignal): Promise<void>;
  /** The player's WebView while a sample plays, else nothing. */
  element: ReactNode;
}

export function useVoicePlayer(): VoicePlayer {
  const [page, setPage] = useState<{ key: number; html: string } | null>(null);
  const turn = useRef(0);
  const current = useRef<{ key: number; on: (event: VoicePlayerEvent) => void } | null>(null);

  const play = useCallback(
    (wav: Uint8Array, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return resolve();
        turn.current += 1;
        const key = turn.current;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
          if (current.current?.key === key) {
            current.current = null;
            setPage(null);
          }
          if (error) reject(error);
          else resolve();
        };
        const stop = () => finish();
        signal.addEventListener('abort', stop, { once: true });
        timer = setTimeout(() => finish(new Error('The sample didn’t start.')), VOICE_PLAYER_START_MS);
        current.current = {
          key,
          on(event) {
            if (event === 'ended') return finish();
            if (event === 'error') return finish(new Error('The phone couldn’t play the sample.'));
            // Playing: it ends by itself; the guard only keeps “Playing…” from staying forever.
            clearTimeout(timer);
            timer = setTimeout(() => finish(), VOICE_PLAYER_END_MS);
          },
        };
        try {
          setPage({ key, html: voicePlayerHtml(base64(wav)) });
        } catch (error) {
          finish(error as Error);
        }
      }),
    [],
  );

  const element = page ? (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
    >
      <WebView
        key={page.key}
        {...VOICE_PLAYER_WEBVIEW_PROPS}
        source={{ html: page.html }}
        onMessage={(e) => {
          const event = voicePlayerEvent(e.nativeEvent.data);
          if (event && current.current?.key === page.key) current.current.on(event);
        }}
        onError={() => {
          if (current.current?.key === page.key) current.current.on('error');
        }}
        style={{ width: 1, height: 1, backgroundColor: 'transparent' }}
      />
    </View>
  ) : null;

  return { play, element };
}
