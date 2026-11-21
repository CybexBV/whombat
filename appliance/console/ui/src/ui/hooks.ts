import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ServerState } from '../lib/api';
import type { Client } from '../lib/client';
import { type Connection, connectionStatus, POLL_MS } from '../lib/connection';
import { clockOffset } from '../lib/console';

export interface Server {
  state: ServerState | null;
  /** Server clock minus page clock (ms), from the console's `now`. */
  offset: number;
  connection: Connection;
  /** Poll now (after a POST), without waiting for the next tick. */
  refresh: () => void;
}

/**
 * Polls the server every second, one request at a time. A failed poll keeps the last good state on screen (an
 * unlocked desk in it shows locked meanwhile: `App`, CG-51); `connection` turns `lost` only after the server was away
 * for 10 s (connection.ts).
 */
export function useServer(client: Client): Server {
  const [state, setState] = useState<ServerState | null>(null);
  const [offset, setOffset] = useState(0);
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      clearTimeout(timer);
      try {
        const s = await client.state();
        if (stopped) return;
        setState(s);
        if (s.mode === 'console') setOffset(clockOffset(s.now, Date.now()));
        setFailingSince(null);
      } catch {
        if (stopped) return;
        setFailingSince((f) => f ?? Date.now());
      }
      setNow(Date.now());
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    wake.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client]);

  const refresh = useCallback(() => wake.current(), []);
  return { state, offset, connection: connectionStatus(failingSince, now), refresh };
}

/** The page clock, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * The last time (page clock, ms) something that isn't input woke the screen: the sign-in panel, every second while it
 * shows (`SignInLayer`, CG-152); 0 for never. `useLastInput` counts it as input, so whatever dims, drifts, darkens
 * or idles the screen keeps it awake while a code shows, and counts its time from the panel going.
 */
export const WakeContext = createContext(0);

/**
 * Time of the last key press (or pointer press) anywhere on the page, or of the last wake (`WakeContext`); `ago`
 * backdates the start (fixtures).
 */
export function useLastInput(ago = 0): number {
  const wake = useContext(WakeContext);
  const [last, setLast] = useState(() => Date.now() - ago);
  useEffect(() => {
    const on = () => setLast(Date.now());
    window.addEventListener('keydown', on, true);
    window.addEventListener('pointerdown', on, true);
    return () => {
      window.removeEventListener('keydown', on, true);
      window.removeEventListener('pointerdown', on, true);
    };
  }, []);
  return Math.max(last, wake);
}

/**
 * Keeps the focus inside a sheet (CG-212): after every render, a focus outside it — the body, once the chip that opened
 * it went inert or the focused button went with its step — moves to the sheet itself, so its keys never reach the desk
 * behind it (Space would start Talk there, CG-109).
 */
export function useHoldFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  });
}

function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

/**
 * The part of the window the page lays out in, when it isn't the whole window: the box's own output when a monitor
 * shares the window with it (lib/outputs.ts).
 */
export const ViewportContext = createContext<{ width: number; height: number } | null>(null);

/** The window in CSS px, as "w×h" (a stable snapshot for useSyncExternalStore). */
export function useWindowSize(): { width: number; height: number } {
  const snap = useSyncExternalStore(subscribeResize, () => `${window.innerWidth}x${window.innerHeight}`);
  const [w, h] = snap.split('x').map(Number);
  return { width: w || 1024, height: h || 768 };
}

/** The viewport in CSS px: the window, or the part of it `ViewportContext` gives. */
export function useViewport(): { width: number; height: number } {
  const own = useContext(ViewportContext);
  const win = useWindowSize();
  return own ?? win;
}
