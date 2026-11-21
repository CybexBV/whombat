/**
 * What the assistant says about a look it looked into (Whombat look-research.md LR-09; look-research-mobile.md AP-5922),
 * as the mock's cards draw it: its head, a spinner while it works on it, and its words (“I’m looking into it.”, its
 * summary, “I’m on it.”). Home's Needs you rows, their sheet and a thing's page share it. TalkBack reads it as one line,
 * the assistant's name first.
 */
import { agentFaceOf, type LookResearchView } from '@whombat/client';
import { ActivityIndicator, View } from 'react-native';
import { WhombatAvatar } from '../avatars/Avatars';
import { useTheAgentHere } from '../data/useAgent';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';

export function LookSays({
  view,
  size = 20,
  textSize = 13,
  lines,
  color,
}: {
  view: Pick<LookResearchView, 'text' | 'busy'>;
  /** The head's size in dp; the spinner and the words line up with it. */
  size?: number;
  textSize?: number;
  /** How many lines the words may take (the row's two); all of them without. */
  lines?: number;
  /** The words' colour; `ink2` by default. */
  color?: string;
}) {
  const theme = useTheme();
  const agent = useTheAgentHere();
  const name = agent?.name ?? null;
  return (
    <View
      accessible
      accessibilityLabel={name ? `${name}: ${view.text}` : view.text}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
    >
      <WhombatAvatar face={agentFaceOf(agent)} size={size} crop="head" />
      {view.busy ? (
        <View style={{ height: size, justifyContent: 'center' }}>
          <ActivityIndicator size="small" color={theme.colors.brand} />
        </View>
      ) : null}
      <Text
        size={textSize}
        lh={1.4}
        color={color ?? theme.colors.ink2}
        numberOfLines={lines}
        style={{ flex: 1, minWidth: 0, paddingTop: Math.max(0, (size - textSize * 1.4) / 2) }}
      >
        {view.text}
      </Text>
    </View>
  );
}
