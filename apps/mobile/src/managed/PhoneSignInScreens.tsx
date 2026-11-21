/**
 * The screens of signing in by the computer's QR code (AP-530…AP-539): the hero of the sign-in screen, the scan
 * button, the scanner set up for sign-in codes, and the progress screen (“Signing you in” → “Asking your Whombat to
 * let this phone in” → “Confirm on your computer”). Thin: what happens and when is `phoneSignIn.ts`.
 */

import { SYMBOL_SMALL_PATH, SYMBOL_TRANSFORM } from '@whombat/brand';
import {
  type LocalLinkParts,
  type PhoneSignInLink,
  parsePhoneSignInLink,
  readLocalLink,
} from '@whombat/client/managed';
import ScanQrCode from 'lucide-react-native/icons/scan-qr-code';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, View } from 'react-native';
import Svg, { G, Path, Rect } from 'react-native-svg';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Check, X } from '../ui/icons';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { UI_ORIGINS } from './config';
import { COPY } from './copy';
import {
  PHONE_STAGES,
  type PhoneAction,
  type PhoneSignInView,
  type PhoneStage,
  phoneErrorActions,
} from './phoneSignIn';
import { QrScanner } from './QrScanner';
import { ErrorLine, Frame } from './ui';

const T = COPY.phone;

/* The hero: a computer showing the code, and this phone scanning it --------------------------------------------- */

/** A QR-looking pattern (21 × 21, three finder squares, a quiet middle for the mark). Decorative, fixed. */
const QR_PATH = (() => {
  const n = 21;
  const dark = (x: number, y: number): boolean => {
    for (const [fx, fy] of [
      [0, 0],
      [14, 0],
      [0, 14],
    ] as const) {
      const dx = x - fx;
      const dy = y - fy;
      if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
        const ring = Math.min(dx, dy, 6 - dx, 6 - dy);
        return ring !== 1;
      }
    }
    if (x >= 7 && x <= 13 && y >= 7 && y <= 13) return false;
    if (x === 6 || y === 6) return (x + y) % 2 === 0;
    // A fixed scatter (an LCG over the position), dense enough to read as a code.
    const h = (Math.imul(x * 31 + y * 17 + 7, 1103515245) + 12345) >>> 0;
    return (h >>> 16) % 7 < 3;
  };
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (dark(x, y)) d += `M${x} ${y}h1v1h-1z`;
  return d;
})();

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReduced(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** The sign-in screen's picture: the computer's “Mobile app” page with its code, and this phone in front. */
export function PhoneHero() {
  const theme = useTheme();
  const c = theme.colors;
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(sweep, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, sweep]);
  // The phone's viewfinder: 40 × 40 at (226, 92).
  const lineY = sweep.interpolate({ inputRange: [0, 1], outputRange: [96, 128] });
  const qr = { x: 104, y: 44, size: 63 };
  const mark = 20 / 114;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ borderRadius: 24, backgroundColor: c.sf2, overflow: 'hidden' }}
    >
      <Svg width="100%" height={188} viewBox="0 0 320 188" preserveAspectRatio="xMidYMid meet">
        {/* The computer */}
        <Rect x={50} y={24} width={170} height={116} rx={12} fill={c.sf} stroke={c.line2} strokeWidth={1.5} />
        <Rect x={58} y={32} width={154} height={100} rx={6} fill={c.bg} />
        <Rect x={66} y={42} width={30} height={4} rx={2} fill={c.line2} />
        <Rect x={66} y={52} width={22} height={4} rx={2} fill={c.line} />
        <Rect x={66} y={60} width={26} height={4} rx={2} fill={c.line} />
        <Rect x={66} y={68} width={18} height={4} rx={2} fill={c.line} />
        <Rect x={qr.x - 5} y={qr.y - 5} width={qr.size + 10} height={qr.size + 10} rx={6} fill={c.sf} />
        <G transform={`translate(${qr.x} ${qr.y}) scale(${qr.size / 21})`}>
          <Path d={QR_PATH} fill={c.ink} />
        </G>
        <G transform={`translate(${qr.x + qr.size / 2 - 10} ${qr.y + qr.size / 2 - 8}) scale(${mark})`}>
          <G transform={SYMBOL_TRANSFORM}>
            <Path d={SYMBOL_SMALL_PATH} fill={c.logo} />
          </G>
        </G>
        <Path d="M36 146 H234 L226 154 H44 Z" fill={c.line2} />
        <Rect x={32} y={140} width={206} height={7} rx={3.5} fill={c.sf} stroke={c.line2} strokeWidth={1.5} />
        {/* This phone */}
        <Rect x={206} y={50} width={80} height={130} rx={16} fill={c.btn} />
        <Rect x={211} y={55} width={70} height={120} rx={12} fill={c.bg} />
        <Rect x={236} y={61} width={20} height={4} rx={2} fill={c.btn} />
        <Path
          d="M226 100 V96 Q226 92 230 92 H234 M258 92 H262 Q266 92 266 96 V100 M266 124 V128 Q266 132 262 132 H258 M234 132 H230 Q226 132 226 128 V124"
          fill="none"
          stroke={c.brand}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <G transform="translate(232.7 98.7) scale(1.27)">
          <Path d={QR_PATH} fill={c.ink2} opacity={0.35} />
        </G>
        <AnimatedRect x={229} y={reduced ? 111 : lineY} width={34} height={2} rx={1} fill={c.brand} />
        <Rect x={232} y={164} width={28} height={3} rx={1.5} fill={c.line2} />
      </Svg>
    </View>
  );
}

/* The scan button --------------------------------------------------------------------------------------------- */

/** The primary action with the scan icon (52dp, the `lg` button). */
export function ScanButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={14}
      accessibilityLabel={label}
      style={{
        minHeight: 52,
        borderRadius: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: 16,
        backgroundColor: theme.colors.btn,
      }}
    >
      <ScanQrCode size={20} color={theme.colors.btnfg} strokeWidth={2} />
      <Text
        size={16}
        weight={600}
        color={theme.colors.btnfg}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={{ flexShrink: 1 }}
      >
        {label}
      </Text>
    </Touchable>
  );
}

/** The camera, reading sign-in codes only; anything else says what it isn't and keeps looking. */
export function PhoneScanner({
  visible,
  onClose,
  onDenied,
  onLink,
  escapeLabel,
  onEscape,
  onLocalLink,
}: {
  visible: boolean;
  onClose: () => void;
  onDenied: () => void;
  onLink: (link: PhoneSignInLink) => void;
  escapeLabel: string;
  onEscape: () => void;
  /** A community box's own link scanned here instead (AP-5471): joined without a cloud account. */
  onLocalLink?: (link: LocalLinkParts) => void;
}) {
  return (
    <QrScanner
      visible={visible}
      onClose={onClose}
      onDenied={onDenied}
      title={T.scanTitle}
      closeLabel={T.scanClose}
      escapeLabel={escapeLabel}
      onEscape={onEscape}
      onScanned={(text) => {
        const local = onLocalLink ? readLocalLink(text) : null;
        if (local && onLocalLink) {
          onLocalLink(local);
          return null;
        }
        const link = parsePhoneSignInLink(text, UI_ORIGINS);
        if (!link) return T.scanWrong;
        onLink(link);
        return null;
      }}
    />
  );
}

/* Progress ---------------------------------------------------------------------------------------------------- */

type StepState = 'done' | 'active' | 'todo' | 'failed';

function stepStates(view: PhoneSignInView): Record<PhoneStage, StepState> {
  const at: PhoneStage =
    view.kind === 'working' ? view.stage : view.kind === 'confirm' ? 'confirm' : view.stage;
  const index = PHONE_STAGES.indexOf(at);
  const out = {} as Record<PhoneStage, StepState>;
  PHONE_STAGES.forEach((stage, i) => {
    out[stage] = i < index ? 'done' : i > index ? 'todo' : view.kind === 'failed' ? 'failed' : 'active';
  });
  return out;
}

function StepMark({ state, n }: { state: StepState; n: number }) {
  const theme = useTheme();
  const c = theme.colors;
  const box = {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  if (state === 'done')
    return (
      <View style={[box, { backgroundColor: c.ok }]}>
        <Check size={16} color={c.onSolid} strokeWidth={2.5} />
      </View>
    );
  if (state === 'failed')
    return (
      <View style={[box, { backgroundColor: c.bad }]}>
        <X size={16} color={c.onSolid} strokeWidth={2.5} />
      </View>
    );
  if (state === 'active')
    return (
      <View style={[box, { backgroundColor: c.sf2 }]}>
        <ActivityIndicator size="small" color={c.brand} />
      </View>
    );
  return (
    <View style={[box, { borderWidth: 1.5, borderColor: c.line2 }]}>
      <Text size={12} mono weight={500} color={c.mut}>
        {String(n)}
      </Text>
    </View>
  );
}

function Steps({ view }: { view: PhoneSignInView }) {
  const theme = useTheme();
  const states = stepStates(view);
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingVertical: 6,
      }}
    >
      {PHONE_STAGES.map((stage, i) => {
        const state = states[stage];
        const label = T.stages[stage];
        return (
          <View
            key={stage}
            accessible
            accessibilityLabel={`${i + 1}. ${label}: ${T.stageState[state]}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              minHeight: 52,
              paddingHorizontal: 16,
            }}
          >
            <StepMark state={state} n={i + 1} />
            <Text
              size={15}
              weight={state === 'active' || state === 'failed' ? 600 : 500}
              lh={1.35}
              color={state === 'todo' ? theme.colors.mut : theme.colors.ink}
              style={{ flex: 1 }}
            >
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** “OR SHOW A CODE” between two hairlines: the pairing screen's other way in. */
export function OrDivider({ label }: { label: string }) {
  const theme = useTheme();
  const line = { flex: 1, height: 1, backgroundColor: theme.colors.line2 };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 8 }}>
      <View style={line} />
      <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
        {label}
      </Text>
      <View style={line} />
    </View>
  );
}

/** This phone's name and its fingerprint, large, for the person to compare with the computer. */
function Fingerprint({ label, fingerprint }: { label: string; fingerprint: string }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1.5,
        borderColor: c.brand,
        backgroundColor: c.sf,
        paddingVertical: 18,
        paddingHorizontal: 18,
        gap: 4,
      }}
    >
      <Text size={11} weight={500} mono tracking={0.05} color={c.mut}>
        {T.thisPhone}
      </Text>
      <Text size={17} weight={600} lh={1.35} numberOfLines={2}>
        {label}
      </Text>
      <View style={{ height: 1, backgroundColor: c.line, marginVertical: 12 }} />
      <Text size={11} weight={500} mono tracking={0.05} color={c.mut}>
        {T.fingerprint}
      </Text>
      <Text
        size={28}
        mono
        weight={500}
        tracking={0.04}
        lh={1.3}
        adjustsFontSizeToFit
        numberOfLines={1}
        accessibilityLabel={`${T.fingerprint}: ${fingerprint.split('').join(' ')}`}
        testID="phone-fingerprint"
      >
        {fingerprint}
      </Text>
      <Text size={14} lh={1.45} color={c.ink2} style={{ paddingTop: 6 }}>
        {T.same}
      </Text>
    </View>
  );
}

function Waiting({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 28 }}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator size="small" color={theme.colors.mut} />
      <Text size={14} color={theme.colors.mut}>
        {text}
      </Text>
    </View>
  );
}

/**
 * The progress screen, from the scan until the computer confirmed (or something went wrong). `signedIn`: whether back
 * goes to the list or to the sign-in screen. “Scan again” opens the camera here; a scanned code starts over.
 */
export function PhoneProgressScreen({
  view,
  signedIn,
  onAction,
  onLink,
  onCancel,
}: {
  view: PhoneSignInView;
  signedIn: boolean;
  onAction: (action: Exclude<PhoneAction, 'scan'>) => void;
  onLink: (link: PhoneSignInLink) => void;
  /** Stops waiting (not offered while the token is being exchanged, which is quick and can't be undone). */
  onCancel?: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const failed = view.kind === 'failed' ? T.errors[view.error] : null;
  const title = failed
    ? failed.title
    : view.kind === 'confirm'
      ? T.confirmTitle
      : view.stage === 'asking'
        ? T.askingTitle
        : T.workingTitle;
  const sub = failed ? failed.text : view.kind === 'confirm' ? T.confirmSub : T.workingSub;
  const labels: Record<PhoneAction, string> = {
    scan: T.scanAgain,
    retry: T.tryAgain,
    back: signedIn ? T.backToList : T.backToSignIn,
    email: T.withEmail,
  };
  const actions = view.kind === 'failed' ? phoneErrorActions(view.error, signedIn) : [];
  const run = (a: PhoneAction) => {
    if (a === 'scan') {
      setScanError(null);
      setScanning(true);
    } else onAction(a);
  };
  return (
    <Frame kicker={T.kicker} title={title} sub={sub}>
      <Steps view={view} />
      {view.kind === 'confirm' ? (
        <>
          <Fingerprint label={view.label} fingerprint={view.fingerprint} />
          <Waiting text={T.waiting} />
        </>
      ) : null}
      <ErrorLine text={scanError} />
      {actions.map((a, i) => (
        <Button
          key={a}
          label={labels[a]}
          variant={i === 0 ? 'primary' : a === 'email' ? 'quiet' : 'secondary'}
          size={i === 0 ? 'lg' : 'md'}
          onPress={() => run(a)}
        />
      ))}
      {view.kind !== 'failed' && onCancel ? (
        <Button label={T.cancel} variant="quiet" onPress={onCancel} />
      ) : null}
      <PhoneScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onDenied={() => {
          setScanning(false);
          setScanError(signedIn ? T.scanDeniedSignedIn : T.scanDenied);
        }}
        onLink={(link) => {
          setScanning(false);
          onLink(link);
        }}
        escapeLabel={signedIn ? T.backToList : T.withEmail}
        onEscape={() => {
          setScanning(false);
          onAction(signedIn ? 'back' : 'email');
        }}
      />
    </Frame>
  );
}
