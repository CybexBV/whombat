/**
 * A tablet or a computer by a monitor as a screen (Whombat desk-display.md DK-146; desk-display-web.md AP-5960…): *Use
 * as a screen* shows six letters for ten minutes (the mockups' tablet in `f-add`) and waits for the person to type them
 * in Settings → Screens → Add a screen; then the device draws its screen full-window from `screen.state` (every 10 s,
 * sooner after a touch), with *Online* and the lock in the top bar, *Unlock* with the PIN on a PIN pad, a full screen
 * button and the screen kept awake. Its modal says to answer on the phone or at the box: a screen elsewhere never
 * answers (DK-138). Removed in Settings, it shows *Use as a screen* again.
 */
import {
  DESK_SCREEN_CODE_TTL_S,
  type DeskGrid,
  type DisplayEnrolApi,
  fillDeskWords,
  type ScreenApi,
  type ScreenLock,
  type ScreenState,
} from '@whombat/client/desk';
import { useDeskClock } from '@whombat/client/desk/react';
import { formatClock } from '@whombat/core/text';
import { ChipIcon, Screen, ScreenChip } from '@whombat/screen/react';
import { Lock, LockOpen, Maximize, Minimize } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { useWebI18n } from '../../../i18n/provider';
import { NO_ATTENTION, useScreenModeImages } from '../drawing';
import {
  assistantOf,
  deviceKind,
  lettersShown,
  pollDelay,
  relockDue,
  STATUS_POLL_MS,
  screenRemoved,
  SCREEN_MODE_TEXT as T,
} from './model';
import m from './ScreenMode.module.css';

/** What this device keeps about being a screen, per Whombat: its screen's id and name. */
export interface ScreenRecord {
  id: string;
  name: string;
}

/** How the screen page reaches its Whombat: the six letters' session, then the screen's own. */
export interface ScreenModeDeps {
  /** An unenrolled session with this device's screen key. */
  enrol(): { api: DisplayEnrolApi; close(): void };
  /** The screen's session, once it's a screen. */
  screen(): { api: ScreenApi; close(): void };
  load(): ScreenRecord | null;
  save(record: ScreenRecord | null): void;
  /** “iPad · Safari”: how it shows in Settings → Screens. */
  label: string;
  /** Leave screen mode: the page's other ways in. */
  onLeave(): void;
  /** Removed in Settings: its key was revoked, so becoming a screen again needs a new one. */
  onRemoved?(): void;
  /** The time zone the screen draws in when its Whombat doesn't say the person's (an older box). */
  timeZone?: string;
}

export function ScreenModePage({ deps }: { deps: ScreenModeDeps }) {
  const [record, setRecord] = useState<ScreenRecord | null>(() => deps.load());
  if (!record)
    return (
      <Letters
        deps={deps}
        onAdded={(r) => {
          deps.save(r);
          setRecord(r);
        }}
      />
    );
  return (
    <LiveScreen
      deps={deps}
      onRemoved={() => {
        deps.save(null);
        setRecord(null);
        deps.onRemoved?.();
      }}
    />
  );
}

/* The six letters -------------------------------------------------------------------------------------------------- */

function Letters({ deps, onAdded }: { deps: ScreenModeDeps; onAdded: (record: ScreenRecord) => void }) {
  const [code, setCode] = useState<{ code: string; requestId: string } | null>(null);
  const [state, setState] = useState<'asking' | 'waiting' | 'expired' | 'failed'>('asking');
  const [round, setRound] = useState(0);
  const added = useRef(onAdded);
  added.current = onAdded;
  const kind = deviceKind(navigator.userAgent, navigator.maxTouchPoints > 1);

  useEffect(() => {
    void round;
    const { api, close } = deps.enrol();
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (requestId: string) => {
      timer = setTimeout(async () => {
        if (!live) return;
        try {
          const s = await api.status(requestId);
          if (!live) return;
          if (s.state === 'added' && s.screen) return added.current({ id: s.screen.id, name: s.screen.name });
          if (s.state === 'expired') return setState('expired');
          poll(requestId);
        } catch {
          if (live) poll(requestId);
        }
      }, STATUS_POLL_MS);
    };
    (async () => {
      try {
        const r = await api.request({ label: deps.label, platform: 'web' });
        if (!live) return;
        setCode({ code: r.code, requestId: r.requestId });
        setState('waiting');
        poll(r.requestId);
      } catch {
        if (live) setState('failed');
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
      close();
    };
  }, [deps, round]);

  return (
    <div data-theme="dark" className={m.lettersPage} data-screen-mode="letters">
      <div className={m.lettersCard}>
        <p className={m.on}>{fillDeskWords(T.on, { device: kind })}</p>
        <h1 className={m.lettersTitle}>{T.title}</h1>
        <p className={m.steps}>{T.steps}</p>
        {state === 'waiting' && code ? (
          <>
            <p className={m.code}>
              <span aria-hidden="true">{lettersShown(code.code)}</span>
              <span className={m.srOnly}>{code.code.split('').join(' ')}</span>
            </p>
            <p className={m.works}>
              {fillDeskWords(T.works, { minutes: Math.round(DESK_SCREEN_CODE_TTL_S / 60) })}
            </p>
          </>
        ) : state === 'expired' || state === 'failed' ? (
          <>
            <p className={m.works}>{state === 'expired' ? T.expired : T.failed}</p>
            <button type="button" className={m.button} onClick={() => setRound((n) => n + 1)}>
              {T.again}
            </button>
          </>
        ) : (
          <p className={m.code} aria-hidden="true">
            ···
          </p>
        )}
        <button type="button" className={m.link} onClick={deps.onLeave}>
          {T.back}
        </button>
      </div>
    </div>
  );
}

/* The screen ------------------------------------------------------------------------------------------------------- */

/** The window in logical pixels, as `screen.state` says it (200 at least, as the contract takes). */
const windowSize = () => ({
  width: Math.max(200, Math.round(window.innerWidth)),
  height: Math.max(200, Math.round(window.innerHeight)),
});

function useWindowSize() {
  const read = windowSize;
  const [size, setSize] = useState(read);
  useEffect(() => {
    const on = () => setSize(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** Keeps the screen awake while it shows (the Screen Wake Lock API where the browser has it). */
function useWakeLock() {
  useEffect(() => {
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
    };
    if (!nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let live = true;
    const take = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock
        ?.request('screen')
        .then((l) => {
          if (live) lock = l;
          else void l.release();
        })
        .catch(() => {});
    };
    take();
    // A wake lock ends when the page is hidden: taken again when it shows.
    document.addEventListener('visibilitychange', take);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', take);
      void lock?.release().catch(() => {});
    };
  }, []);
}

function LiveScreen({ deps, onRemoved }: { deps: ScreenModeDeps; onRemoved: () => void }) {
  const { tag: uiLocale } = useWebI18n();
  const size = useWindowSize();
  const [state, setState] = useState<ScreenState | null>(null);
  const [online, setOnline] = useState(true);
  const [pinPad, setPinPad] = useState(false);
  const now = useDeskClock(true, 1000);
  const touchedAt = useRef<number | null>(null);
  const [kick, setKick] = useState(0);
  const apiRef = useRef<ScreenApi | null>(null);
  const removed = useRef(onRemoved);
  removed.current = onRemoved;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useWakeLock();
  const loadImage = useScreenModeImages(useCallback(() => apiRef.current, []));

  // `screen.state` every 10 s, every 3 s for two minutes after a touch; `known` keeps unchanged answers small.
  useEffect(() => {
    void kick;
    const { api, close } = deps.screen();
    apiRef.current = api;
    let live = true;
    let etag: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (!live) return;
      try {
        const r = await api.state({ size: sizeRef.current, ...(etag ? { known: etag } : {}) });
        if (!live) return;
        setOnline(true);
        if (!('same' in r)) {
          etag = r.etag;
          setState(r);
        }
      } catch (error) {
        if (!live) return;
        if (screenRemoved(error)) return removed.current();
        setOnline(false);
      }
      timer = setTimeout(ask, pollDelay(Date.now(), touchedAt.current));
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
      apiRef.current = null;
      close();
    };
  }, [deps, kick]);

  const touch = useCallback(() => {
    const first = touchedAt.current === null || Date.now() - touchedAt.current > 3000;
    touchedAt.current = Date.now();
    // A touch after a while asks at once: it may be unlocked now, or someone wants to see what's new.
    if (first) setKick((n) => n + 1);
  }, []);

  // Unlocked, it locks itself two minutes after the last touch (DK-138): the runtime counts every ask as use.
  const unlockedAt = useRef<number | null>(null);
  const isUnlocked = state?.lock.state === 'unlocked';
  useEffect(() => {
    unlockedAt.current = isUnlocked ? (unlockedAt.current ?? Date.now()) : null;
  }, [isUnlocked]);
  useEffect(() => {
    if (!relockDue(now, touchedAt.current, unlockedAt.current)) return;
    unlockedAt.current = null;
    void apiRef.current
      ?.lock()
      .then(() => setKick((n) => n + 1))
      .catch(() => {});
  }, [now]);

  if (!state) return <div data-theme="dark" className={m.screenPage} data-screen-mode="screen" />;
  const lock = state.lock;
  const unlocked = lock.state === 'unlocked';
  const chips = (
    <>
      <ScreenChip icon={<ChipIcon name="online" />} {...(online ? {} : { tone: 'warn' as const })}>
        {online ? T.online : T.offline}
      </ScreenChip>
      <button
        type="button"
        className={m.chipButton}
        onClick={() => {
          if (unlocked) void apiRef.current?.lock().then(() => setKick((n) => n + 1));
          else setPinPad(true);
        }}
      >
        <Icon icon={unlocked ? LockOpen : Lock} size={16} />
        {unlocked ? T.unlocked : T.locked}
      </button>
      <FullscreenChip />
    </>
  );
  // *Only the time* (DK-138): the runtime sends no grid; the screen draws its clock alone.
  const grid: DeskGrid = state.grid ?? {
    screen: state.screen.id,
    layout: {
      pages: [{ id: 'p_time', name: ' ', layouts: { '1x1': [] }, last: '1x1' }],
      turn: 'touch',
      size: 'normal',
    },
    views: [],
    attention: NO_ATTENTION,
    popups: state.screen.popups,
  };
  return (
    <div data-theme="dark" className={m.screenPage} data-screen-mode="screen">
      <Screen
        width={size.width}
        height={size.height}
        grid={grid}
        calm={state.calm}
        name={state.whombat}
        assistant={assistantOf(state)}
        timeZone={state.timeZone ?? deps.timeZone}
        locale={uiLocale}
        now={now}
        chips={chips}
        onlyTime={state.grid === null}
        loadImage={loadImage}
        onTouch={touch}
        onUnlock={() => setPinPad(true)}
        answerElsewhere
        locked={!unlocked}
      />
      {pinPad ? (
        <PinPad
          lock={lock}
          onClose={() => setPinPad(false)}
          onPin={async (pin) => {
            const api = apiRef.current;
            if (!api) return null;
            const next = await api.unlock(pin);
            if (next.state === 'unlocked') {
              setPinPad(false);
              setKick((n) => n + 1);
            }
            return next;
          }}
        />
      ) : null}
    </div>
  );
}

function FullscreenChip() {
  const [full, setFull] = useState(
    () => typeof document !== 'undefined' && document.fullscreenElement !== null,
  );
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null;
  return (
    <button
      type="button"
      className={m.chipButton}
      aria-label={full ? T.exitFullscreen : T.fullscreen}
      onClick={() =>
        void (full ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})
      }
    >
      <Icon icon={full ? Minimize : Maximize} size={16} />
    </button>
  );
}

/** *Unlock* with the PIN (DK-138): a PIN pad, the tries left, the wait after too many. */
function PinPad({
  lock,
  onClose,
  onPin,
}: {
  lock: ScreenLock;
  onClose: () => void;
  onPin: (pin: string) => Promise<ScreenLock | null>;
}) {
  const [pin, setPin] = useState('');
  const [answer, setAnswer] = useState<ScreenLock>(lock);
  const [busy, setBusy] = useState(false);
  const message = useMemo(() => {
    if (!answer.hasPin) return T.noPin;
    if (answer.state === 'backoff' && answer.retryAt)
      return fillDeskWords(T.pinWait, {
        time: formatClock(answer.retryAt, Intl.DateTimeFormat().resolvedOptions().timeZone),
      });
    if (answer.triesLeft !== undefined && answer.triesLeft < 5)
      return fillDeskWords(T.pinWrong, { n: answer.triesLeft });
    return null;
  }, [answer]);
  const send = async (value: string) => {
    setBusy(true);
    try {
      const next = await onPin(value);
      if (next) setAnswer(next);
    } finally {
      setBusy(false);
      setPin('');
    }
  };
  const press = (digit: string) => {
    if (busy || !answer.hasPin || answer.state === 'backoff') return;
    const next = `${pin}${digit}`.slice(0, 6);
    setPin(next);
  };
  return (
    <div className={m.overlay}>
      <div className={m.pinPad} role="dialog" aria-modal="true" aria-labelledby="screen-pin-title">
        <h2 className={m.pinTitle} id="screen-pin-title">
          {T.pin}
        </h2>
        <p className={m.pinDots}>
          <span className={m.srOnly} aria-live="polite">{`${pin.length} digits`}</span>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the dots are places
            <i key={i} className={cx(m.pinDot, i < pin.length && m.pinDotOn)} />
          ))}
        </p>
        {message ? <p className={m.pinMessage}>{message}</p> : null}
        <div className={m.keys}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" className={m.key} onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button type="button" className={cx(m.key, m.keyWord)} onClick={onClose}>
            {T.cancel}
          </button>
          <button type="button" className={m.key} onClick={() => press('0')}>
            0
          </button>
          {pin.length >= 4 ? (
            <button
              type="button"
              className={cx(m.key, m.keyWord, m.keyGo)}
              disabled={busy}
              onClick={() => void send(pin)}
            >
              {T.unlock}
            </button>
          ) : (
            <button
              type="button"
              className={cx(m.key, m.keyWord)}
              disabled={!pin}
              onClick={() => setPin((p) => p.slice(0, -1))}
            >
              {T.delete}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
