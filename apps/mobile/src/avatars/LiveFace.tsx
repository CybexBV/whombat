/**
 * `<LiveFace>`: the agent's face that shows what it is doing, on the phone (the web's `@whombat/avatars/live`, same
 * props). Under 25 px it is the still small head (`WhombatAvatar`). Above, the face's drawing for its pose is drawn with
 * react-native-svg from the app's own tree (`faceDrawing.ts`); each movable part is a group whose matrix Reanimated
 * sets on the display thread from the part's track (`facePuppet.ts`), so a blink or a gesture costs no React render.
 *
 * How much it moves follows the phone: the system's reduce motion and this phone's “Moving faces” switch both make it
 * change pose without moving (`useFaceMotionMode`). A screen passes `motion` only when it knows better.
 */
import { NavigationContext } from '@react-navigation/native';
import { type AvatarFace, DEFAULT_AVATAR_SIZE } from '@whombat/avatars';
import { type FaceMotionMode, type FaceState, faceAllowance } from '@whombat/avatars/motion';
import {
  type ComponentType,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import Animated, { type SharedValue, useAnimatedProps } from 'react-native-reanimated';
import Svg, {
  Circle,
  ClipPath,
  type ColumnMajorTransformMatrix,
  Defs,
  Ellipse,
  G,
  type GProps,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { useReducedMotion } from '../ui/chat';
import { WhombatAvatar } from './Avatars';
import { type Drawing, faceTreeFor, sameDrawing } from './faceDrawing';
import { type FaceNode, type FaceTag, IDENTITY, sampleAt } from './faceEngine';
import { useFaceMotionSetting } from './faceMotionSetting';
import { type FaceTracks, PhonePuppet, type Track } from './facePuppet';

export type { FaceMotionMode, FaceState } from '@whombat/avatars/motion';

export interface LiveFaceProps {
  face: AvatarFace;
  /** Width and height in dp. Default 40. */
  size?: number;
  /** What the agent is doing. Default `idle`. */
  state?: FaceState;
  /** The agent's name, the image's label. Without it the face is decorative. */
  label?: string;
  decorative?: boolean;
  /** Overrides the phone's choice (`useFaceMotionMode`). */
  motion?: FaceMotionMode;
  /**
   * The voice's loudness now, 0–1, while speaking or listening. Keep it the same function between renders: a new one
   * restarts what the face does while the state lasts.
   */
  level?: (() => number) | null;
  /** A tap pokes it: a small surprise and its own gesture. For faces that are there to be looked at, 40 dp and up. */
  pokeable?: boolean;
  /** Plays the face's own gesture whenever this value changes (a face just picked). */
  gestureKey?: string | number | null;
  style?: ViewStyle;
}

/** How much faces move on this phone: `reduced` under the system's reduce motion or with “Moving faces” off. */
export function useFaceMotionMode(override?: FaceMotionMode): FaceMotionMode {
  const reduced = useReducedMotion();
  const [on] = useFaceMotionSetting();
  return override ?? (reduced || !on ? 'reduced' : 'full');
}

export function LiveFace({
  face,
  size = DEFAULT_AVATAR_SIZE,
  label,
  decorative = false,
  ...rest
}: LiveFaceProps) {
  const mode = useFaceMotionMode(rest.motion);
  const named = Boolean(label) && !decorative;
  if (!faceAllowance(size, mode).live)
    return <WhombatAvatar face={face} size={size} label={named ? label : undefined} style={rest.style} />;
  return <MovingFace {...rest} face={face} size={size} mode={mode} label={named ? label : undefined} />;
}

/** Whether the screen this face is on is the one in view (always, outside a navigator). */
function useScreenInView(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (!navigation) return;
    setFocused(navigation.isFocused());
    const off = [
      navigation.addListener('focus', () => setFocused(true)),
      navigation.addListener('blur', () => setFocused(false)),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, [navigation]);
  return focused;
}

function MovingFace({
  face,
  size,
  state = 'idle',
  label,
  mode,
  level = null,
  pokeable = false,
  gestureKey = null,
  style,
}: Omit<LiveFaceProps, 'motion' | 'decorative' | 'size'> & { size: number; mode: FaceMotionMode }) {
  const inView = useScreenInView();
  const [puppet] = useState(() => new PhonePuppet({ face, size, state, mode, level, focused: inView }));
  const tracks = puppet.tracks;
  const [drawing, setDrawing] = useState<Drawing>(() => puppet.firstDrawing);
  // Resolved once the drawing asked for is on screen.
  const waiting = useRef<{ drawing: Drawing; done: () => void }[]>([]);
  const shown = useRef(drawing);
  shown.current = drawing;
  const show = useCallback((next: Drawing) => {
    if (sameDrawing(next, shown.current)) return Promise.resolve();
    return new Promise<void>((done) => {
      waiting.current.push({ drawing: next, done });
      setDrawing(next);
      // A screen that isn't drawing now (one behind another) mustn't keep the face waiting.
      setTimeout(done, 250);
    });
  }, []);
  useEffect(() => {
    // Once a drawing asked for is on screen, so is everything asked for before it (or it was passed over).
    const at = waiting.current.findLastIndex((w) => sameDrawing(w.drawing, drawing));
    if (at < 0) return;
    const ready = waiting.current.slice(0, at + 1);
    waiting.current = waiting.current.slice(at + 1);
    for (const w of ready) w.done();
  }, [drawing]);

  useEffect(() => {
    puppet.attach(show);
    return () => {
      puppet.detach();
      for (const w of waiting.current) w.done();
      waiting.current = [];
    };
  }, [puppet, show]);
  useEffect(() => {
    puppet.set({ face, size, state, mode, level, focused: inView });
  }, [puppet, face, size, state, mode, level, inView]);

  const firstGesture = useRef(gestureKey);
  useEffect(() => {
    if (gestureKey === firstGesture.current) return;
    firstGesture.current = gestureKey;
    void puppet.gesture();
  }, [puppet, gestureKey]);

  const tree = faceTreeFor(drawing);
  const content = useMemo(() => tree.nodes.map((n) => renderNode(n, tracks)), [tree, tracks]);
  const a11y = label
    ? ({ accessible: true, accessibilityRole: 'image', accessibilityLabel: label } as const)
    : ({ accessible: false, importantForAccessibility: 'no-hide-descendants' } as const);
  const picture = (
    <Svg width={size} height={size} viewBox={tree.viewBox}>
      {content}
    </Svg>
  );
  // A poke is play, not a button: nothing depends on it, so the face stays an image to a screen reader.
  return pokeable ? (
    <Pressable
      {...a11y}
      onPress={() => void puppet.poke()}
      hitSlop={Math.max(0, Math.ceil((44 - size) / 2))}
      style={[{ width: size, height: size }, style]}
    >
      {picture}
    </Pressable>
  ) : (
    <View {...a11y} style={[{ width: size, height: size }, style]}>
      {picture}
    </View>
  );
}

/* Drawing the tree ------------------------------------------------------------------------------------------------- */

// biome-ignore lint/suspicious/noExplicitAny: react-native-svg's elements each take their own props
const TAGS: Record<FaceTag, ComponentType<any>> = {
  g: G,
  defs: Defs,
  linearGradient: LinearGradient,
  radialGradient: RadialGradient,
  stop: Stop,
  clipPath: ClipPath,
  path: Path,
  circle: Circle,
  ellipse: Ellipse,
  rect: Rect,
};

function renderNode(node: FaceNode, tracks: FaceTracks): ReactNode {
  switch (node.kind) {
    case 'el': {
      const Tag = TAGS[node.tag];
      return (
        <Tag key={node.key} {...node.props}>
          {node.children.length ? node.children.map((c) => renderNode(c, tracks)) : undefined}
        </Tag>
      );
    }
    case 'part':
      return (
        <PartGroup key={node.key} track={tracks.channels[node.part]} fades={node.part === 'cue'}>
          {node.children.map((c) => renderNode(c, tracks))}
        </PartGroup>
      );
    case 'blend':
      return (
        <PartGroup
          key={node.key}
          track={tracks.channels[`b:${node.target}`]}
          fades={false}
          props={node.props}
        >
          {node.children.map((c) => renderNode(c, tracks))}
        </PartGroup>
      );
    case 'tick':
      return <TickPath key={node.key} track={tracks.channels.tick} length={node.length} props={node.props} />;
    case 'dot':
      return <ThoughtDot key={node.key} index={node.index} step={tracks.dot} props={node.props} />;
  }
}

/**
 * A group whose matrix Reanimated sets. react-native-svg's `G` turns a `transform` prop into the native `matrix`, but
 * drops a `matrix` prop: Reanimated sets `matrix` on the display thread, and when it hands a settled value back as a
 * prop, this passes it on as the transform, so a later render keeps it.
 */
function MatrixGroup({ matrix, ref, ...rest }: GProps & { matrix?: number[]; ref?: Ref<G<unknown>> }) {
  return <G ref={ref} {...rest} transform={(matrix ?? IDENTITY) as ColumnMajorTransformMatrix} />;
}
const AnimatedGroup = Animated.createAnimatedComponent(MatrixGroup);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function PartGroup({
  track,
  fades,
  props,
  children,
}: {
  track: Track;
  /** The symbol fades in on a new pose. */
  fades: boolean;
  props?: Record<string, unknown>;
  children: ReactNode;
}) {
  const animatedProps = useAnimatedProps(() => {
    const s = sampleAt(track.samples.value, track.progress.value);
    const matrix = s.slice(0, 6);
    return fades ? { matrix, opacity: s[6] as number } : { matrix };
  });
  return (
    <AnimatedGroup {...props} animatedProps={animatedProps}>
      {children}
    </AnimatedGroup>
  );
}

/** Hazel's tick, drawn by its dash: hidden until her gesture. */
function TickPath({
  track,
  length,
  props,
}: {
  track: Track;
  length: number;
  props: Record<string, unknown>;
}) {
  const animatedProps = useAnimatedProps(() => {
    const s = sampleAt(track.samples.value, track.progress.value);
    return { opacity: s[6] as number, strokeDashoffset: length * (1 - (s[7] as number)) };
  });
  return <AnimatedPath {...props} animatedProps={animatedProps} />;
}

/** A thought dot: lit in turn while the agent thinks, its own opacity otherwise. */
function ThoughtDot({
  index,
  step,
  props,
}: {
  index: number;
  step: SharedValue<number>;
  props: Record<string, unknown>;
}) {
  const own = typeof props.opacity === 'number' ? props.opacity : 1;
  const animatedProps = useAnimatedProps(() => ({
    opacity: step.value < 0 ? own : step.value === index ? 1 : 0.3,
  }));
  return <AnimatedCircle {...props} animatedProps={animatedProps} />;
}
