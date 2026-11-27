/**
 * The phone's composers' voice typing (docs/decisions/dictation.md DT-01): the mic, a 32dp round as the paperclip
 * beside it, and the recording bar that takes the pill's row while it records — Cancel · the waveform · “Recording 0:12”
 * · Done (filled, as Send) — then “Turning speech into text…” while the box works. Every target reaches 44dp with its
 * slop; TalkBack and VoiceOver hear the phase once, not every second. Every word is `VOICE_TEXT`'s.
 */
import { fillVoiceWords, formatRecordingTime, VOICE_LEVELS } from '@whombat/client/voice';
import type { VoiceTypingView } from '@whombat/client/voice/react';
import { voiceWords } from '@whombat/core/domain';
import { View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Check, Mic, X } from '../ui/icons';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';

/** The mic: records, or says why it can't. None while voice typing is off here. */
export function MicButton({ voice, disabled }: { voice: VoiceTypingView; disabled?: boolean }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const words = voiceWords(rawLocale);
  if (voice.mic === 'hidden') return null;
  return (
    <Touchable
      onPress={voice.start}
      disabled={disabled}
      accessibilityLabel={words.composer.dictate}
      accessibilityHint={voice.mic === 'not_ready' ? words.errors.not_ready : undefined}
      feedback="wash"
      ringRadius={16}
      hitSlop={hitSlopFor(32)}
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Mic size={18} color={theme.colors.ink2} strokeWidth={1.75} />
    </Touchable>
  );
}

/** The recording bar, in place of the pill's row. */
export function VoiceBar({ voice }: { voice: VoiceTypingView }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const { t } = useMobileT();
  const words = voiceWords(rawLocale);
  const phase = voice.state.phase;
  const said =
    phase === 'transcribing'
      ? words.composer.transcribing
      : phase === 'preparing'
        ? words.composer.preparing
        : t('voice.recordingNow');
  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
      <Touchable
        onPress={voice.cancel}
        accessibilityLabel={words.composer.cancel}
        feedback="wash"
        ringRadius={16}
        hitSlop={hitSlopFor(32)}
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={18} color={theme.colors.ink2} strokeWidth={1.75} />
      </Touchable>
      {/* The phase, read once (the clock beside it isn't read every second). */}
      <View
        accessible
        accessibilityLabel={said}
        accessibilityLiveRegion="polite"
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}
      >
        {phase === 'transcribing' ? (
          <Text size={14} color={theme.colors.mut} numberOfLines={1} style={{ flex: 1 }}>
            {words.composer.transcribing}
          </Text>
        ) : (
          <>
            <Waveform levels={voice.levels} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {phase === 'recording' ? (
                <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.colors.bad }} />
              ) : null}
              <Text size={13} color={theme.colors.mut} style={{ fontVariant: ['tabular-nums'] }}>
                {phase === 'recording'
                  ? fillVoiceWords(words.composer.recording, { time: formatRecordingTime(voice.seconds) })
                  : words.composer.preparing}
              </Text>
            </View>
          </>
        )}
      </View>
      {phase === 'transcribing' ? null : (
        <Touchable
          onPress={voice.stop}
          disabled={phase !== 'recording'}
          accessibilityLabel={words.composer.done}
          accessibilityState={{ disabled: phase !== 'recording' }}
          ringRadius={16}
          hitSlop={hitSlopFor(32)}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: theme.colors.btn,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: phase === 'recording' ? 1 : 0.45,
          }}
        >
          <Check size={18} color={theme.colors.btnfg} strokeWidth={2.25} />
        </Touchable>
      )}
    </View>
  );
}

/** The last loudnesses as thin bars, newest on the right; it shows as many as fit. */
function Waveform({ levels }: { levels: readonly number[] }) {
  const theme = useTheme();
  const quiet = Math.max(0, VOICE_LEVELS - levels.length);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        flex: 1,
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 3,
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: VOICE_LEVELS }, (_, i) => {
        const level = i < quiet ? 0 : (levels[i - quiet] ?? 0);
        return (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are places, not items
            key={i}
            style={{
              width: 2,
              height: Math.round(2 + level * 20),
              borderRadius: 1,
              backgroundColor: theme.colors.ink2,
              opacity: 0.3 + level * 0.7,
            }}
          />
        );
      })}
    </View>
  );
}
