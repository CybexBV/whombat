/**
 * The icon at the start of a thread's row in Chat's and Feedback's lists (app chat-inbox-phone.md): what the thread is
 * about at a glance, and its state on the icon's corners. A repository's own icon on a rounded tile (its letter on an
 * avatar tone until the picture arrives, when it fails or when there is none), the thing a thread is about as the app
 * marks it elsewhere, else the assistant's face. Something new is a blue dot on the top corner; while the assistant
 * works a small turning ring sits on the bottom corner. Decorative for screen readers: the row's label says all of it.
 *
 * The corner marks sit over the icon, so they live here rather than in the row, which reads top to bottom.
 */
import { HUMAN_INITIALS_COLOR } from '@whombat/avatars';
import { agentFaceOf, type ThreadIconFields, thingGlyph, thingMark } from '@whombat/client';
import { useHomeOverview } from '@whombat/client/react';
import { thingId } from '@whombat/core';
import { useEffect, useState } from 'react';
import { Image, type ImageSourcePropType, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { WhombatAvatar } from '../avatars/Avatars';
import { usePhotoSource } from '../avatars/photo';
import { useBurrowBase } from '../data/BurrowProvider';
import { repoTone } from '../data/chatInbox';
import { DEMO_IMAGES } from '../data/demoImages';
import { useTheAgentHere } from '../data/useAgent';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ThingIcon } from './assistant';
import { useReducedMotion } from './chat';

/** The icon's size in the list. */
export const THREAD_ICON = 40;
/** One turn of the working ring. */
const TURN_MS = 900;

export type ThreadIconRow = ThreadIconFields;

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/** A thread's icon with its state: `fresh` (something new) and `working` (the assistant is at it). */
export function ThreadIcon({
  row,
  fresh = false,
  working = false,
  size = THREAD_ICON,
}: {
  row: ThreadIconRow;
  fresh?: boolean;
  working?: boolean;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <View {...hidden} style={{ width: size, height: size }}>
      {row.icon === 'repo' ? (
        <RepoTile
          name={row.repoName ?? ''}
          letter={row.repoLetter ?? '?'}
          url={row.repoIconUrl}
          size={size}
        />
      ) : row.icon === 'subject' && row.subjectKind && row.subjectId ? (
        <SubjectTile kind={row.subjectKind} id={row.subjectId} size={size} />
      ) : (
        <AgentFace size={size} />
      )}
      {fresh ? (
        <View
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: theme.colors.bg,
            backgroundColor: theme.chart.chart1,
          }}
        />
      ) : null}
      {working ? (
        <View
          style={{
            position: 'absolute',
            right: -6,
            bottom: -6,
            width: 22,
            height: 22,
            borderRadius: 11,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bg,
          }}
        >
          <TurningRing />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The repository's own picture, loaded as a person's photo is; its letter on a tone chosen from its name shows until
 * then, and stays when there is no picture or it fails.
 */
function RepoTile({
  name,
  letter,
  url,
  size,
}: {
  name: string;
  letter: string;
  url: string | null;
  size: number;
}) {
  const theme = useTheme();
  const demo = url ? DEMO_IMAGES[url] : undefined;
  const fetched = usePhotoSource(demo ? null : url);
  const src: ImageSourcePropType | null = demo ?? fetched;
  const key = src && typeof src === 'object' && 'uri' in src ? String(src.uri) : src ? String(src) : null;
  const [shown, setShown] = useState<{ key: string; ok: boolean } | null>(null);
  const loaded = key !== null && shown?.key === key && shown.ok;
  const failed = key !== null && shown?.key === key && !shown.ok;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: loaded ? theme.colors.sf2 : repoTone(name),
      }}
    >
      {loaded ? null : (
        <Text size={Math.round(size * 0.42)} weight={600} color={HUMAN_INITIALS_COLOR}>
          {letter}
        </Text>
      )}
      {src && key && !failed ? (
        <Image
          source={src}
          resizeMode="cover"
          onLoad={() => setShown({ key, ok: true })}
          onError={() => setShown({ key, ok: false })}
          style={{ position: 'absolute', top: 0, left: 0, width: size, height: size }}
        />
      ) : null}
    </View>
  );
}

/** The thing a thread is about, with the mark the app gives it elsewhere (Places, Overview), on a quiet tile. */
function SubjectTile({
  kind,
  id,
  size,
}: {
  kind: 'server' | 'connection' | 'device';
  id: string;
  size: number;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const home = useHomeOverview({ params: { burrow: slug } }, { retry: false });
  const thing = home.data?.things.find((t) => t.id === thingId(kind, id));
  const glyph = thing
    ? thingGlyph(thing)
    : kind === 'server'
      ? 'server'
      : kind === 'device'
        ? 'device'
        : 'plug';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.sf2,
      }}
    >
      <ThingIcon
        glyph={glyph}
        mark={thing ? thingMark(thing) : null}
        size={Math.round(size * 0.55)}
        color={theme.colors.ink2}
      />
    </View>
  );
}

/** The assistant's face, round on `sf2`, as its chats show it. */
function AgentFace({ size }: { size: number }) {
  const theme = useTheme();
  const agent = useTheAgentHere();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: theme.colors.sf2,
      }}
    >
      <WhombatAvatar face={agent ? agentFaceOf(agent) : undefined} size={size} crop="head" picture />
    </View>
  );
}

/** A 16dp ring with a third of it darker, turning once in 0.9 s; still when the system asks for less motion. */
function TurningRing() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    turn.value = 0;
    turn.value = withRepeat(withTiming(1, { duration: TURN_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [reduced, turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View style={[{ width: 16, height: 16 }, spin]}>
      <Svg width={16} height={16} viewBox="0 0 16 16">
        <Circle cx={8} cy={8} r={6} stroke={theme.colors.line2} strokeWidth={2.4} fill="none" />
        <Circle
          cx={8}
          cy={8}
          r={6}
          stroke={theme.colors.ink}
          strokeWidth={2.4}
          strokeDasharray="12 26"
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}
