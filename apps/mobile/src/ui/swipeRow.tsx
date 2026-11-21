/**
 * A list row with swipe actions (chat-settle.md, the mock's phone; ios-native.md; native-feel.md): pulled sideways it
 * shows its actions under it — `trailing` at the right when pulled left (a thread's **Settle** and **More** in Chat,
 * Settled's ↶ **Open again** and **More**), `leading` at the left when pulled right (which an iPhone keeps for going
 * back), each a 96dp panel (`btnfg` on its tone), the first nearest the edge. The row follows the finger. Let go past
 * half its panels and they stay open to tap; pull on past most of the row's width (or flick it there) and the edge's
 * action runs without a tap, a tick saying when letting go will run it and again when it won't any more. A row the
 * action takes out of its list (`leaves`) folds away first, so the rows under it close up rather than jump. On a row
 * taller than the panels are wide the icon and word sit level with the finger, which is on the screen even when the
 * row's top or bottom isn't. A panel
 * that opens a menu (`menu`) only stays open: a menu can't open by itself. A tap on an open row, a scroll of its list
 * (`closeSwipeRows`) or another row opening closes it. Only a sideways drag takes the touch, so the list still scrolls
 * and a tap still opens the row; not one that starts on something scrolling sideways itself (`ui/sideways.tsx`).
 * Screen readers can't swipe: the row's own accessibility actions (or its menu) carry the same actions, and the panels
 * are hidden from them.
 *
 * The finger, the panels, the slide away and the fold run on the display thread (react-native-gesture-handler and
 * Reanimated), so a busy JavaScript thread — the list redrawing as a thread leaves it — doesn't make them stutter;
 * JavaScript only hears when an action runs, a row opens or closes, and the ticks.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import type { NativeMenuSpec } from '../data/nativeMenu';
import { fullSwipeAt, SWIPE_ACTION_WIDTH, swipeEnd } from '../data/swipe';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { useReducedMotion } from './chat';
import { haptic } from './haptics';
import type { LucideIcon } from './icons';
import { NativeMenu } from './nativeMenu';
import { SwipeGestureContext } from './sideways';

/** A drag this far sideways is a swipe; this far up or down first, it is the list's scroll. */
const SWIPE_SLOP = 10;
/** A row taller than this (a long message) shows its panels' icon and word level with the finger, in a box this tall. */
const FACE_MOST = 112;
/** How long a folded row's list has to take it out; one still there after it (put back at once) shows again. */
const GONE_MS = 400;
/** Settling to rest or open: quick, and never past it (T3 Code's spring). */
const SPRING = { damping: 26, mass: 0.7, stiffness: 330, overshootClamping: true };
const W = SWIPE_ACTION_WIDTH;

export interface SwipeAction {
  label: string;
  icon: LucideIcon;
  /**
   * The panel's colour: `ok` (default; Settle, Open again), `neutral` (More), `bad` (Delete), `new` (Mark as unread or
   * read: the blue that means “new” in Chat).
   */
  tone?: 'ok' | 'neutral' | 'bad' | 'new';
  /** What a tap on the panel does (and a full swipe, when it is the edge's and opens no menu). */
  run: () => void;
  /** Running it takes the row out of its list (Settle in Chat, Open again in Settled): a full swipe folds it first. */
  leaves?: boolean;
  /** On iPhone a tap on the panel opens this menu, as iOS's own ⋯ buttons do; elsewhere `run` opens the sheet. */
  menu?: { spec: NativeMenuSpec; onPick: (id: string) => void } | null;
}

/** The open row's way to close: one row is open at a time. */
let openRow: (() => void) | null = null;

/** Closes the row whose panels are open (its list scrolled). */
export function closeSwipeRows(): void {
  openRow?.();
}

/** What the display thread knows of one side's actions. */
interface Side {
  count: number;
  /** A full swipe runs the edge's action (it opens no menu). */
  runs: boolean;
  /** The edge's action takes the row out of its list. */
  leaves: boolean;
}

const sideOf = (actions: readonly SwipeAction[]): Side => ({
  count: actions.length,
  runs: !!actions[0] && !actions[0].menu,
  leaves: !!actions[0]?.leaves,
});

/**
 * One empty side for every row: a fresh `[]` default each render would rerun the effect that hands the sides to the
 * display thread on every render of every row.
 */
const NO_ACTIONS: readonly SwipeAction[] = [];

export function SwipeRow({
  leading = NO_ACTIONS,
  trailing = NO_ACTIONS,
  gutter = 0,
  gap = 0,
  children,
}: {
  leading?: readonly SwipeAction[];
  trailing?: readonly SwipeAction[];
  /** The list's side margin: the panels reach through it to the screen's edges, the row keeps it inside. */
  gutter?: number;
  /** The space between the list's rows: the panels cover half of it above and below the row. */
  gap?: number;
  children: ReactNode;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const x = useSharedValue(0);
  /** Where the row was when the finger took it. */
  const start = useSharedValue(0);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  /** Past the point where letting go runs the edge's action (or running it now): the edge's panel covers the others. */
  const armed = useSharedValue(false);
  /** The row's height while it folds away; −1 while it doesn't. */
  const fold = useSharedValue(-1);
  /** Where a tall row's panels show their icon and word: the top of a `FACE_MOST` box round the finger. */
  const faceAt = useSharedValue(0);
  const sides = useSharedValue({ leading: sideOf(leading), trailing: sideOf(trailing), reduced });
  // The panels are drawn from the first touch on, not for every row of a list that is only scrolled.
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  /** Starts the row afresh when one that folded away is still here (its action was put back at once). */
  const [round, setRound] = useState(0);
  const latest = useRef({ leading, trailing });
  latest.current = { leading, trailing };
  /** The action a tap on a panel runs; null: the edge's, as a full swipe. */
  const pending = useRef<SwipeAction | null>(null);
  const showAgain = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    sides.value = { leading: sideOf(leading), trailing: sideOf(trailing), reduced };
  }, [sides, leading, trailing, reduced]);

  // JavaScript's side: running actions, the open row, the ticks. Made once; it reads what changes through refs.
  const js = useMemo(() => {
    const setOpenRow = (on: boolean) => {
      setOpen(on);
      if (on) {
        if (openRow !== close) openRow?.();
        openRow = close;
      } else if (openRow === close) {
        openRow = null;
      }
    };
    const close = () => {
      x.value = withSpring(0, SPRING);
      armed.value = false;
      setOpenRow(false);
    };
    /** The row whole again, where it stays (the action was refused, or it moved within its list). */
    const whole = () => {
      cancelAnimation(x);
      x.value = 0;
      armed.value = false;
      setOpenRow(false);
    };
    const finish = (sign: number) => {
      const action = pending.current ?? (sign > 0 ? latest.current.leading : latest.current.trailing)[0];
      pending.current = null;
      action?.run();
      if (!action?.leaves) return whole();
      // Its list takes it out with its next render; one still here shows again.
      showAgain.current = setTimeout(() => {
        fold.value = -1;
        whole();
        setRound((r) => r + 1);
      }, GONE_MS);
    };
    const touched = () => {
      setReady(true);
      if (openRow && openRow !== close) openRow();
    };
    return { setOpenRow, close, finish, touched };
  }, [x, armed, fold]);
  const { setOpenRow, finish, touched } = js;

  /** Slides the row away towards `sign`, folds it when its action takes it out, then runs the action. */
  const goOut = (sign: number, leaves: boolean, still: boolean) => {
    'worklet';
    armed.value = true;
    if (still) {
      scheduleOnRN(finish, sign);
      return;
    }
    x.value = withTiming(sign * (width.value || 3 * W), { duration: 160 }, (done) => {
      if (!done) return;
      if (!leaves) {
        scheduleOnRN(finish, sign);
        return;
      }
      fold.value = height.value;
      fold.value = withTiming(0, { duration: 180 }, (folded) => {
        if (folded) scheduleOnRN(finish, sign);
      });
    });
  };

  const any = leading.length > 0 || trailing.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shared values and `js` are made once
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(any)
        // From rest only towards a side with actions (a pull to the right is the iPhone's way back); an open row
        // moves either way.
        .activeOffsetX([
          trailing.length || open ? -SWIPE_SLOP : -1e6,
          leading.length || open ? SWIPE_SLOP : 1e6,
        ])
        .failOffsetY([-SWIPE_SLOP, SWIPE_SLOP])
        .onBegin((e) => {
          faceAt.value = Math.min(Math.max(e.y - FACE_MOST / 2, 0), Math.max(0, height.value - FACE_MOST));
          scheduleOnRN(touched);
        })
        .onStart(() => {
          cancelAnimation(x);
          start.value = x.value;
        })
        .onUpdate((e) => {
          const s = sides.value;
          const most = width.value || 3 * W;
          const pos = Math.min(
            Math.max(start.value + e.translationX, s.trailing.count ? -most : 0),
            s.leading.count ? most : 0,
          );
          x.value = pos;
          const side = pos > 0 ? s.leading : s.trailing;
          const full =
            pos !== 0 && side.runs && Math.abs(pos) >= fullSwipeAt(side.count * W, width.value || 400);
          if (full !== armed.value) {
            armed.value = full;
            scheduleOnRN(haptic, 'threshold');
          }
        })
        .onEnd((e, success) => {
          const s = sides.value;
          const pos = x.value;
          const sign = pos > 0 ? 1 : -1;
          const side = pos > 0 ? s.leading : s.trailing;
          const panels = side.count * W;
          const end = success
            ? swipeEnd(Math.abs(pos), (e.velocityX / 1000) * sign, panels, width.value || 400, side.runs)
            : 'close';
          if (end === 'run' && side.count > 0) {
            goOut(sign, side.leaves, s.reduced);
            return;
          }
          armed.value = false;
          const to = end === 'open' ? sign * panels : 0;
          x.value = s.reduced ? to : withSpring(to, SPRING);
          scheduleOnRN(setOpenRow, to !== 0);
        }),
    [any, open, leading.length, trailing.length],
  );

  // A row that goes away while open isn't the open one any more.
  useEffect(
    () => () => {
      if (openRow === js.close) openRow = null;
      if (showAgain.current) clearTimeout(showAgain.current);
    },
    [js],
  );

  const toneOf = (a: SwipeAction | undefined) =>
    a?.tone === 'bad'
      ? theme.colors.bad
      : a?.tone === 'neutral'
        ? theme.colors.mut
        : a?.tone === 'new'
          ? theme.chart.chart1
          : theme.colors.ok;
  const leadTone = toneOf(leading[0]);
  const trailTone = toneOf(trailing[0]);
  // Pulled past its panels, the rest of the way is the edge's colour too; folding, the row's height closes.
  const boxStyle = useAnimatedStyle(() => {
    const backgroundColor = x.value > 0 ? leadTone : x.value < 0 ? trailTone : 'transparent';
    return fold.value >= 0 ? { backgroundColor, height: fold.value } : { backgroundColor };
  });
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const runPanel = (sign: number, action: SwipeAction) => {
    pending.current = action;
    scheduleOnUI(goOut, sign, !!action.leaves, reduced);
  };

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        key={round}
        onLayout={(e) => {
          if (fold.value >= 0) return;
          const layout = e.nativeEvent.layout;
          width.value = layout.width;
          height.value = layout.height;
          if (layout.height > FACE_MOST !== tall) setTall(layout.height > FACE_MOST);
        }}
        style={[{ overflow: 'hidden', marginHorizontal: -gutter, marginVertical: -gap / 2 }, boxStyle]}
      >
        {ready && leading.length > 0 ? (
          <Panels
            side={1}
            actions={leading}
            x={x}
            armed={armed}
            tall={tall}
            faceAt={faceAt}
            toneOf={toneOf}
            js={js}
            run={runPanel}
          />
        ) : null}
        {ready && trailing.length > 0 ? (
          <Panels
            side={-1}
            actions={trailing}
            x={x}
            armed={armed}
            tall={tall}
            faceAt={faceAt}
            toneOf={toneOf}
            js={js}
            run={runPanel}
          />
        ) : null}
        <Animated.View style={rowStyle}>
          <View
            style={{
              width: '100%',
              backgroundColor: theme.colors.bg,
              paddingHorizontal: gutter,
              paddingVertical: gap / 2,
            }}
          >
            <SwipeGestureContext.Provider value={pan}>{children}</SwipeGestureContext.Provider>
          </View>
          {open ? (
            // An open row's tap closes it rather than opening the row.
            <Pressable accessible={false} onPress={js.close} style={StyleSheet.absoluteFill} />
          ) : null}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * One side's panels under the row, the edge's first from the row's own side (the trailing ones listed from the right),
 * shown while the row is pulled that way. Pulled past them all, the inner ones move with the row and the edge's widens;
 * when letting go runs it, it covers the others.
 */
function Panels({
  side,
  actions,
  x,
  armed,
  tall,
  faceAt,
  toneOf,
  js,
  run,
}: {
  side: 1 | -1;
  actions: readonly SwipeAction[];
  x: SharedValue<number>;
  armed: SharedValue<boolean>;
  tall: boolean;
  faceAt: SharedValue<number>;
  toneOf: (a: SwipeAction | undefined) => string;
  js: { close: () => void };
  run: (sign: number, action: SwipeAction) => void;
}) {
  const shown = useAnimatedStyle(() => ({ opacity: side * x.value > 0 ? 1 : 0 }));
  const ordered = actions.map((a, i) => [a, i] as const);
  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        StyleSheet.absoluteFill,
        { flexDirection: 'row', justifyContent: side > 0 ? 'flex-start' : 'flex-end' },
        shown,
      ]}
    >
      {(side > 0 ? ordered : ordered.reverse()).map(([a, i]) => (
        <PanelSlot key={a.label} side={side} index={i} count={actions.length} x={x} armed={armed}>
          <SwipePanel
            action={a}
            color={toneOf(a)}
            tall={tall}
            faceAt={faceAt}
            onRun={() => run(side, a)}
            onClose={js.close}
          />
        </PanelSlot>
      ))}
    </Animated.View>
  );
}

function PanelSlot({
  side,
  index,
  count,
  x,
  armed,
  children,
}: {
  side: 1 | -1;
  index: number;
  count: number;
  x: SharedValue<number>;
  armed: SharedValue<boolean>;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const panels = count * W;
    const shift = index === 0 ? 0 : side > 0 ? Math.max(0, x.value - panels) : Math.min(0, x.value + panels);
    return { opacity: armed.value && index > 0 ? 0 : 1, transform: [{ translateX: shift }] };
  });
  return <Animated.View style={[{ width: W }, style]}>{children}</Animated.View>;
}

/**
 * One action's panel: its icon over its word, the whole panel a button; on a tall row the two sit level with the finger.
 * A menu's panel is iOS's own menu button on iPhone and opens the sheet elsewhere; the row closes behind either.
 */
function SwipePanel({
  action,
  color,
  tall,
  faceAt,
  onRun,
  onClose,
}: {
  action: SwipeAction;
  color: string;
  tall: boolean;
  faceAt: SharedValue<number>;
  onRun: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  // The blue keeps light words in both themes (`btnfg` is dark in the dark theme).
  const ink = action.tone === 'new' ? theme.colors.onSolid : theme.colors.btnfg;
  const level = useAnimatedStyle(() => ({ transform: [{ translateY: faceAt.value }] }));
  const face = (
    <View style={{ flex: 1, backgroundColor: color }}>
      <Animated.View
        style={[
          { alignItems: 'center', justifyContent: 'center', gap: 4 },
          tall ? [{ height: FACE_MOST }, level] : { flex: 1 },
        ]}
      >
        <action.icon size={18} color={ink} strokeWidth={1.7} />
        <Text size={12.5} weight={600} color={ink}>
          {action.label}
        </Text>
      </Animated.View>
    </View>
  );
  const menu = action.menu;
  if (menu)
    return (
      <NativeMenu
        spec={menu.spec}
        onPick={(id) => {
          onClose();
          menu.onPick(id);
        }}
        trigger="tap"
        label={action.label}
        style={{ flex: 1 }}
      >
        <Pressable
          // The row's own actions carry what the panels do for screen readers: these are never their elements.
          accessible={false}
          importantForAccessibility="no"
          onPress={() => {
            onClose();
            action.run();
          }}
          style={{ flex: 1 }}
        >
          {face}
        </Pressable>
      </NativeMenu>
    );
  return (
    <Pressable accessible={false} importantForAccessibility="no" onPress={onRun} style={{ flex: 1 }}>
      {face}
    </Pressable>
  );
}
