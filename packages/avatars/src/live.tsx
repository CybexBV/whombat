/**
 * `<LiveFace>`: the agent's face that shows what it is doing (`@whombat/avatars/live`). It draws the still file first,
 * loads the live drawing and its engine (`puppet.ts`, about 130 KB with the poses) on its own, then takes over in place.
 * Under 25 px it is `<WhombatAvatar>`: the still small head, which never changes.
 *
 * How much it moves follows the device: the system's “reduce motion” and this device's “Face moves” switch both make it
 * change pose without moving (`useFaceMotionMode`). A screen passes `motion` itself only when it knows better (the box's
 * desk screen without a graphics chip says `calm`).
 */
import {
  type CSSProperties,
  type ReactElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type FaceMotionMode, type FaceState, faceAllowance, liveFaceCrop } from './faceMotion';
import { type AvatarFace, DEFAULT_AVATAR_SIZE } from './index';
import type { FacePuppet } from './puppet';
import { WhombatAvatar } from './react';
import { avatarUrl } from './urls';

export type { FaceMotionMode, FaceState } from './faceMotion';

export interface LiveFaceProps {
  face: AvatarFace;
  /** Rendered width and height, px. Default 40. */
  size?: number;
  /** What the agent is doing. Default `idle`. */
  state?: FaceState;
  /** The agent's name, the image's label. Without it the face is decorative. */
  label?: string;
  decorative?: boolean;
  /** Above the fold: load the still file now. */
  eager?: boolean;
  /** Overrides the device's choice (`useFaceMotionMode`). */
  motion?: FaceMotionMode;
  /** The voice's loudness now, 0–1, while speaking or listening. Keep it the same function between renders: a new one
   * restarts what the face does while the state lasts. */
  level?: (() => number) | null;
  /** A tap pokes it: a small surprise and its own gesture. For faces that are there to be looked at, 40 px and up. */
  pokeable?: boolean;
  /** Plays the face's own gesture whenever this value changes (a face just picked). */
  gestureKey?: string | number | null;
  className?: string;
  style?: CSSProperties;
}

let enginePromise: Promise<typeof import('./puppet')> | null = null;
function loadEngine() {
  enginePromise ??= import('./puppet');
  return enginePromise;
}

export function LiveFace({
  face,
  size = DEFAULT_AVATAR_SIZE,
  state = 'idle',
  label,
  decorative = false,
  eager = false,
  motion,
  level = null,
  pokeable = false,
  gestureKey = null,
  className,
  style,
}: LiveFaceProps): ReactElement {
  const mode = useFaceMotionMode(motion);
  const live = faceAllowance(size, mode).live;
  const stage = useRef<HTMLSpanElement>(null);
  const puppet = useRef<FacePuppet | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef({ face, size, state, mode, level, pokeable });
  latest.current = { face, size, state, mode, level, pokeable };

  useEffect(() => {
    if (!live) return;
    let gone = false;
    loadEngine()
      .then(({ FacePuppet }) => {
        if (gone || !stage.current) return;
        puppet.current = new FacePuppet(stage.current, latest.current);
        setReady(true);
      })
      .catch(() => {
        // The still file stays: a face that can't load its engine is still the face.
      });
    return () => {
      gone = true;
      puppet.current?.destroy();
      puppet.current = null;
      setReady(false);
    };
  }, [live]);

  useEffect(() => {
    puppet.current?.set({ face, size, state, mode, level, pokeable });
  }, [face, size, state, mode, level, pokeable]);

  const firstGesture = useRef(gestureKey);
  useEffect(() => {
    if (gestureKey === firstGesture.current) return;
    firstGesture.current = gestureKey;
    void puppet.current?.gesture();
  }, [gestureKey]);

  if (!live) {
    return (
      <WhombatAvatar
        face={face}
        size={size}
        label={label}
        decorative={decorative}
        eager={eager}
        className={className}
        style={style}
      />
    );
  }

  const named = Boolean(label) && !decorative;
  const a11y = named ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <span
      {...a11y}
      className={className}
      style={{ display: 'block', position: 'relative', flex: 'none', width: size, height: size, ...style }}
      data-avatar={face}
      data-live-face=""
      data-face-state={state}
    >
      {ready ? null : (
        <img
          src={avatarUrl(face, size, liveFaceCrop(size) === 'bust' ? 'bust' : 'head')}
          alt=""
          width={size}
          height={size}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          style={{ display: 'block', width: size, height: size }}
        />
      )}
      {/* The engine owns this element's children; React never renders into it. */}
      <span ref={stage} style={{ position: 'absolute', inset: 0, display: 'block' }} />
    </span>
  );
}

/** This device's “Face moves” switch (on unless turned off). */
export const FACE_MOTION_KEY = 'whombat.faceMotion';
const CHANGED = 'whombat-face-motion';
const REDUCE = '(prefers-reduced-motion: reduce)';

export function readFaceMotionSetting(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(FACE_MOTION_KEY);
    return stored === undefined || stored === null ? (unsaved ?? true) : stored !== 'off';
  } catch {
    return unsaved ?? true;
  }
}

export function writeFaceMotionSetting(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.removeItem(FACE_MOTION_KEY);
    else globalThis.localStorage?.setItem(FACE_MOTION_KEY, 'off');
    unsaved = null;
  } catch {
    // Storage refused (a private window): the switch lasts for this page.
    unsaved = on;
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}

let unsaved: boolean | null = null;

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia?.(REDUCE);
  media?.addEventListener?.('change', onChange);
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    media?.removeEventListener?.('change', onChange);
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function currentMode(): FaceMotionMode {
  const reduced = typeof window !== 'undefined' && Boolean(window.matchMedia?.(REDUCE).matches);
  const on = readFaceMotionSetting();
  return reduced || !on ? 'reduced' : 'full';
}

/** How much faces move on this device: `reduced` under the system's reduce motion or with “Face moves” off. */
export function useFaceMotionMode(override?: FaceMotionMode): FaceMotionMode {
  const mode = useSyncExternalStore(subscribe, currentMode, () => 'full' as const);
  return override ?? mode;
}

/** The “Face moves” switch, for a settings screen. */
export function useFaceMotionSetting(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readFaceMotionSetting, () => true);
  return [on, writeFaceMotionSetting];
}
