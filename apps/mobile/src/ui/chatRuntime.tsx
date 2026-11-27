/**
 * What answers in Chat, drawn (Whombat chat-runtime.md CR-01, CR-07, CR-08; chat-runtime-android.md AP-2715…AP-2749;
 * the mockup's section 4): the composer's icon in the pill (the provider's mark, a bolt on it with fast replies on;
 * chat-runtime-icon.md AP-2962), and on an assistant's reply in Chat the provider's mark and name after the time (a tap says the
 * whole line, “Claude · Opus · High effort · Fast”), the quiet divider when it ran on something else than the reply
 * before, and the quiet lines under it when fast replies or the model asked for didn't happen. Words come in from
 * `@whombat/client`'s `chat/runtime.ts` and `data/chatRuntime.ts`.
 */

import type { ChatProvider } from '@whombat/core';
import { View } from 'react-native';
import { switchedParts } from '../data/chatRuntime';
import { useMobileT } from '../i18n';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { haptic } from './haptics';
import { CircleDashed, Server, Zap } from './icons';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/**
 * A provider's mark: Claude's in its own orange, OpenAI's in the text colour (`muted`: `mut`, the mockup's
 * `openai-mut.svg` after a reply's time and on the switch's other half); Local's a server in the text colour (no company
 * makes it; hermes-engine-app.md AP-5123). Decorative: the provider is named beside it.
 */
export function ProviderMark({
  provider,
  size,
  muted = false,
}: {
  provider: ChatProvider;
  size: number;
  muted?: boolean;
}) {
  const theme = useTheme();
  if (provider === 'local')
    return (
      <Server
        size={size}
        color={muted ? theme.colors.mut : theme.colors.ink}
        strokeWidth={1.75}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    );
  return (
    <BrandMark
      mark={provider === 'claude' ? 'claude' : 'openai'}
      size={size}
      {...(muted ? { color: theme.colors.mut } : {})}
    />
  );
}

/** The bolt of fast replies, filled in `warn` (the mockup's `--fast`). */
export function FastBolt({ size, color }: { size: number; color?: string }) {
  const theme = useTheme();
  const c = color ?? theme.colors.warn;
  return <Zap size={size} color={c} fill={c} strokeWidth={0} />;
}

/**
 * After a reply's time (CR-07, AP-2726): the provider's mark (12dp, muted) and its name in the time's mono. A tap says
 * the whole line (“Claude · Opus · High effort · Fast”), which is also what TalkBack reads; the long press on the
 * message shows it at the top of its menu.
 */
export function RanOnMark({
  provider,
  label,
  text,
}: {
  provider: ChatProvider;
  label: string;
  text: string;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Touchable
      onPress={() => showNotice(text)}
      feedback="fade"
      ringRadius={6}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint={tMobile('ui.says-what-answered')}
      hitSlop={hitSlopFor(20)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 20 }}
    >
      <ProviderMark provider={provider} size={12} muted />
      <Text size={11.5} mono color={theme.colors.mut}>
        {label}
      </Text>
    </Touchable>
  );
}

/**
 * The quiet divider above a reply that ran on something else than the thread's reply before it (CR-07, AP-2727; the
 * mockup's `.switch`): hairlines either side, the new provider's mark, “Switched to **ChatGPT** · High effort”.
 */
export function RunSwitchDivider({ provider, text }: { provider: ChatProvider; text: string }) {
  const theme = useTheme();
  const parts = switchedParts(text);
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: -4, marginBottom: -6 }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.line }} />
      <ProviderMark provider={provider} size={13} />
      <Text size={12.5} color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
        {parts.lead}
        {parts.bold ? (
          <Text size={12.5} weight={600} color={theme.colors.ink2}>
            {parts.bold}
          </Text>
        ) : null}
        {parts.rest}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.line }} />
    </View>
  );
}

/**
 * A quiet line under a reply (CR-08, AP-2728; the mockup's `.quiet`): fast replies that didn't happen with the bolt's
 * outline, a model that wasn't available without.
 */
export function RanOnNote({ text, fast }: { text: string; fast: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      {fast ? (
        <View style={{ paddingTop: 2 }}>
          <Zap size={13} color={theme.colors.mut} strokeWidth={1.7} />
        </View>
      ) : null}
      <Text size={13} lh={1.4} color={theme.colors.mut} style={{ flexShrink: 1 }}>
        {text}
      </Text>
    </View>
  );
}

/**
 * The composer's icon while no AI is signed in: a dashed circle in the text colour, no provider's mark. A tap opens
 * Settings → AI; a long press says “No AI yet”.
 */
export function NoAiIcon({ label, line, onPress }: { label: string; line: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      onLongPress={() => {
        haptic('menu');
        showNotice(line);
      }}
      feedback="wash"
      ringRadius={16}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={hitSlopFor(32)}
      style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}
    >
      <CircleDashed
        size={18}
        color={theme.colors.ink2}
        strokeWidth={1.75}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </Touchable>
  );
}

/**
 * The composer's icon in the pill, before the paperclip (CR-01, AP-2715; chat-runtime-icon.md AP-2962, AP-2963): a 32dp
 * round like the paperclip, the provider's mark (18dp), and with fast replies on a 15dp disc of the pill's surface with
 * the bolt on the mark's lower right. A tap opens the sheet; a long press says “Opus · Automatic · For this thread”.
 * TalkBack: “Choose how Neo answers”, then what it is on now and where it applies.
 */
export function ChatRuntimeIcon({
  provider,
  providerLabel,
  model,
  effort,
  fast,
  label,
  line,
  scope,
  onPress,
  disabled = false,
}: {
  provider: ChatProvider;
  providerLabel: string;
  model: string;
  effort: string;
  fast: boolean;
  /** “Choose how Neo answers”. */
  label: string;
  /** What a long press says: “Opus · Automatic · For this thread” (`chatRuntimeLine`). */
  line: string;
  /** “For this thread”, “For your next question”. */
  scope: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      onLongPress={() => {
        haptic('menu');
        showNotice(line);
      }}
      disabled={disabled}
      feedback="wash"
      ringRadius={16}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{
        text: `${[providerLabel, model, effort].filter(Boolean).join(', ')}${fast ? ', fast replies' : ''}. ${scope}`,
      }}
      hitSlop={hitSlopFor(32)}
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* The disc overlaps the mark by its own margins (no absolute layout, so TalkBack's order stays the tree's). */}
      <View style={fast ? { marginLeft: 7 } : null}>
        <ProviderMark provider={provider} size={18} />
      </View>
      {fast ? (
        <View
          style={{
            width: 15,
            height: 15,
            marginLeft: -8,
            marginTop: 13,
            borderRadius: 8,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.sf,
          }}
        >
          <FastBolt size={10} />
        </View>
      ) : null}
    </Touchable>
  );
}
