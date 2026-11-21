/**
 * The composers' voice typing on the web (docs/decisions/dictation.md DT-01): the mic, and the recording bar that takes
 * the composer's row while it records — Cancel · the waveform · “Recording 0:12” · Done — then “Turning speech into
 * text…” while the box works. Screen readers hear the phase once (not every second); Escape cancels. Every word is
 * `VOICE_TEXT`'s.
 */
import { recordingLabel, VOICE_LEVELS, VOICE_TEXT } from '@whombat/client/voice';
import type { VoiceTypingView } from '@whombat/client/voice/react';
import { Check, Mic, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import styles from './Voice.module.css';

export type VoiceSize = 'chat' | 'reply' | 'ask';

const ICON: Record<VoiceSize, number> = { chat: 16, reply: 15, ask: 18 };

/** The mic: records, or says why it can't (its model still downloading). None while voice typing is off. */
export function MicButton({
  voice,
  size,
  className,
}: {
  voice: VoiceTypingView;
  size: VoiceSize;
  className?: string;
}) {
  if (voice.mic === 'hidden') return null;
  return (
    <button
      type="button"
      className={cx(styles.mic, styles[size], size === 'ask' && styles.ringed, className)}
      aria-label={VOICE_TEXT.composer.dictate}
      title={voice.mic === 'not_ready' ? VOICE_TEXT.errors.not_ready : VOICE_TEXT.composer.dictate}
      data-voice-mic={voice.mic}
      onClick={voice.start}
    >
      <Icon icon={Mic} size={ICON[size]} />
    </button>
  );
}

/** Whether the composer's row is the recording bar now. */
export function voiceBarShown(voice: VoiceTypingView | null): voice is VoiceTypingView {
  return voice?.active === true;
}

/** The recording bar, in place of the composer's row. */
export function VoiceBar({ voice, size }: { voice: VoiceTypingView; size: VoiceSize }) {
  const phase = voice.state.phase;
  const done = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // The field is hidden while it records: the focus goes to Done (Cancel while the box works).
  useEffect(() => {
    if (phase === 'recording') done.current?.focus();
    if (phase === 'transcribing') cancel.current?.focus();
  }, [phase]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    voice.cancel();
  };
  const said =
    phase === 'transcribing'
      ? VOICE_TEXT.composer.transcribing
      : phase === 'preparing'
        ? VOICE_TEXT.composer.preparing
        : VOICE_TEXT.recordingNow;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape here cancels; the buttons inside are the controls
    <div className={cx(styles.bar, styles[size])} data-voice-bar={phase} onKeyDown={onKeyDown}>
      <span className={styles.srOnly} aria-live="polite">
        {said}
      </span>
      <button
        ref={cancel}
        type="button"
        className={styles.cancel}
        aria-label={VOICE_TEXT.composer.cancel}
        title={VOICE_TEXT.composer.cancel}
        onClick={voice.cancel}
      >
        <Icon icon={X} size={ICON[size]} />
      </button>
      {phase === 'transcribing' ? (
        <span className={cx(styles.status, styles.working)} aria-hidden="true">
          {VOICE_TEXT.composer.transcribing}
        </span>
      ) : (
        <>
          <Waveform levels={voice.levels} />
          <span className={styles.status} aria-hidden="true">
            {phase === 'recording' ? (
              <>
                <span className={styles.dot} />
                {recordingLabel(voice.seconds)}
              </>
            ) : (
              VOICE_TEXT.composer.preparing
            )}
          </span>
          <button
            ref={done}
            type="button"
            className={styles.done}
            aria-label={VOICE_TEXT.composer.done}
            title={VOICE_TEXT.composer.done}
            disabled={phase !== 'recording'}
            onClick={voice.stop}
          >
            <Icon icon={Check} size={ICON[size]} />
          </button>
        </>
      )}
    </div>
  );
}

/** The last loudnesses as thin bars, newest on the right; the rest of the width stays quiet. */
function Waveform({ levels }: { levels: readonly number[] }) {
  const quiet = Math.max(0, VOICE_LEVELS - levels.length);
  return (
    <span className={styles.wave} aria-hidden="true">
      {Array.from({ length: VOICE_LEVELS }, (_, i) => {
        const level = i < quiet ? 0 : (levels[i - quiet] ?? 0);
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are places, not items
            key={i}
            className={styles.waveBar}
            style={{ height: `${Math.round(2 + level * 20)}px`, opacity: 0.3 + level * 0.7 }}
          />
        );
      })}
    </span>
  );
}
