/**
 * A console in the browser (ONE-13; ported from Rackoon's `ConsolePanel`): the server's own shell (`?console=host`) or
 * a guest's screen or shell (`?console=<guest id>`), in a wide dialog over the page. The session comes from
 * `hosts.createConsole` (`useConsoleSession`); text consoles run in xterm.js, VM screens in noVNC (`screens.tsx`).
 * SPICE is not offered (ONE-13). On the appliance session (boxes reached through the relay) the console runs on the
 * session's console stream; only a runtime without `stream.console` still gets “Consoles open on the local network for
 * now.” (AP-1316). Closing the dialog ends the session.
 *
 * Around the screen (PX-01, AP-1475…AP-1484): **Send keys**, **Paste** (typed into a screen at a safe pace, asked first
 * for a long or many-line paste into a shell), **Copy** of a shell's text, **Screenshot** of a screen, **Full screen**,
 * **Maximize** (the console fills the browser window, and stays so for the next one), the **key row** on narrow
 * screens, the **“Stay connected”** warning a minute before an idle close, **Start** (or Resume) when the guest is off,
 * then connect, and the **side list** of the server's guests to switch consoles (hidden until asked for).
 *
 * The keyboard: the screen's frame is the Tab stop; a click or Enter gives the keys to the console, Ctrl+Alt gives them
 * back. While the console has them nothing else takes any (Esc included: the dialog stays open); the tools act only when
 * the console isn't focused, and give the keys back to it afterwards.
 */
import {
  actionAcceptedText,
  detailGuests,
  GUEST_STATE_WORDS,
  guestKindText,
  guestStateTone,
  isMacServer,
  MAC_KIND_WORD,
  macScreenView,
  manageablePlatform,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { CAPABILITIES } from '@whombat/client/session';
import { api } from '@whombat/core/contracts';
import type { HostConsoleProtocol, HostGuest, HostServerDetail } from '@whombat/core/domain';
import { formatBytes } from '@whombat/core/text';
import {
  Camera,
  ClipboardPaste,
  Copy,
  Expand,
  Maximize2,
  Minimize2,
  PanelRight,
  Play,
  Shrink,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useOptionalAppServices } from '../../../app/providers';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Modal, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { currentLocale } from '../../../i18n/provider';
import { saveBlob } from '../../../lib/saveBlob';
import { GuestPower } from '../guest/GuestPower';
import { Badge, Dot, useChangeRunner } from '../parts';
import { useThingSearch } from '../search';
import things from '../Things.module.css';
import styles from './Console.module.css';
import { GuestList, IdleWarning, KeyRow, type PasteAsk, PasteDialog, SendKeysMenu } from './ConsoleTools';
import {
  type KeyCombo,
  type Modifiers,
  modifierWords,
  NO_MODIFIERS,
  type RowKey,
  type ShellKey,
  screenRowKeys,
  shellRowBytes,
} from './keyCombos';
import { formatCount, PASTE_LIMIT_BYTES, planPaste } from './paste';
import { type ScreenHandle, TerminalScreen, VncScreen } from './screens';
import type { ConsoleTransport } from './transport';
import { useConsoleSession } from './useConsoleSession';

const PROTOCOL_WORDS: Partial<Record<HostConsoleProtocol, string>> = {
  vnc: 'Screen',
  serial: 'Serial',
  shell: 'Shell',
  tty: 'Console',
  logs: 'Logs',
};

/** The warning shows this long before the idle close. */
const IDLE_WARN_MS = 60_000;

/** Whether the console fills the window is this browser's own preference, kept for the next console. */
const MAXIMIZED_KEY = 'whombat.console.maximized';

function readMaximized(): boolean {
  try {
    return window.localStorage.getItem(MAXIMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMaximized(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(MAXIMIZED_KEY, '1');
    else window.localStorage.removeItem(MAXIMIZED_KEY);
  } catch {
    // Without storage it is only forgotten.
  }
}

export function ConsoleDialog({
  burrow,
  serverId,
  detail,
  target,
  onClose,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  /** `host` or a guest id. */
  target: string;
  onClose: () => void;
}) {
  // A console of the server itself: its shell (`host`), or a Mac's screen (`screen`, macos-servers.md).
  const [, setSearch] = useThingSearch();
  // The element the console's client lives in: while it has the keyboard, Esc is the guest's.
  const clientHost = useRef<HTMLDivElement | null>(null);
  // The guests stay out of the way until asked for; the screen gets the room.
  const [listOpen, setListOpen] = useState(false);
  const [maximized, setMaximized] = useState(() => typeof window !== 'undefined' && readMaximized());
  const onMaximize = (on: boolean) => {
    setMaximized(on);
    writeMaximized(on);
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      width="console"
      padded
      className={cx(styles.dialog, maximized && styles.maximized)}
      onEscapeKeyDown={(e) => {
        const t = e.target instanceof Node ? e.target : null;
        const inClient = !!t && !!clientHost.current?.contains(t);
        // An open menu (Send keys, Power) closes itself first.
        const menu = t instanceof Element && !!t.closest('[role="dialog"]')?.querySelector('[role="menu"]');
        if (inClient || menu) e.preventDefault();
      }}
    >
      <ConsoleView
        key={target}
        burrow={burrow}
        serverId={serverId}
        detail={detail}
        target={target}
        clientHost={clientHost}
        listOpen={listOpen}
        onList={setListOpen}
        maximized={maximized}
        onMaximize={onMaximize}
        onSelect={(next) => setSearch({ console: next }, { replace: true })}
        onClose={onClose}
      />
    </Modal>
  );
}

type Notice = { text: string; tone: 'ok' | 'bad' };

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The clipboard, or the old way where the page isn't a secure context (a box opened over plain HTTP). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the old way.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = styles.offscreen ?? '';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

interface KeyboardLock {
  lock?: (keys?: string[]) => Promise<void>;
  unlock?: () => void;
}

function ConsoleView({
  burrow,
  serverId,
  detail,
  target,
  clientHost,
  listOpen,
  onList,
  maximized,
  onMaximize,
  onSelect,
  onClose,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  target: string;
  clientHost: RefObject<HTMLDivElement | null>;
  listOpen: boolean;
  onList: (open: boolean) => void;
  maximized: boolean;
  onMaximize: (on: boolean) => void;
  onSelect: (target: string) => void;
  onClose: () => void;
}) {
  const services = useOptionalAppServices();
  // Consoles run on the session; one whose runtime can't yet keeps them local.
  const managed = !!services;
  const localOnly = managed && !!services && !services.session.supports(CAPABILITIES.console);
  const rc = detail.server.remoteControl;
  const guests = detailGuests(detail);
  const ofServer = target === 'host' || target === 'screen';
  const guest = ofServer ? null : (guests.find((g) => g.id === target) ?? null);
  const missing = !ofServer && !guest;
  const name = guest?.name ?? serverId;
  // A Mac's own console is its screen (MAC-20), its shell beside it; the screen needs Screen Sharing and its password.
  const mac = !guest && isMacServer(detail);
  const macScreen = mac
    ? (macScreenView(detail, { name: serverId, owner: true, now: Date.parse(detail.asOf) })?.screen ?? null)
    : null;
  const screenBlocked = target === 'screen' && macScreen && !macScreen.can ? macScreen.why : null;
  const protocols = (
    guest ? (guest.console.protocols ?? []) : macScreen?.can ? ['vnc', 'shell'] : ['shell']
  ).filter((p) => p !== 'spice') as HostConsoleProtocol[];
  const [protocol, setProtocol] = useState<HostConsoleProtocol | null>(
    guest?.console.defaultProtocol && guest.console.defaultProtocol !== 'spice'
      ? guest.console.defaultProtocol
      : target === 'screen' && protocols.includes('vnc')
        ? 'vnc'
        : !guest && protocols.includes('shell')
          ? 'shell'
          : (protocols[0] ?? null),
  );
  const title = guest
    ? `${guest.name} on ${serverId}`
    : protocol === 'vnc'
      ? `${serverId}’s screen`
      : `Shell on ${serverId}`;
  const off = guest?.state === 'stopped';
  const paused = guest?.state === 'paused';
  // A guest's console goes with the consoles' switch; the host's own shell and a Mac's screen with the host-shell
  // switch only, as the hosts service asks.
  const consoleOn = guest ? rc.console !== false : rc.hostShell !== false;
  const hasConsole = guest ? guest.console.available !== false && protocols.length > 0 : true;
  const enabled = !localOnly && !missing && !off && !paused && consoleOn && hasConsole && !screenBlocked;
  const session = useConsoleSession({ burrow, serverId, guestId: guest?.id, protocol, enabled });
  const phase = session.phase;
  const live = phase.kind === 'connecting' || phase.kind === 'connected' ? phase : null;
  const transport = live?.transport ?? null;
  const kind: 'screen' | 'shell' = (live?.session.protocol ?? protocol) === 'vnc' ? 'screen' : 'shell';
  const readOnly = (live?.session.protocol ?? protocol) === 'logs';

  const clientRef = useRef<ScreenHandle | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sticky, setSticky] = useState<Modifiers>(NO_MODIFIERS);
  const [pasteAsk, setPasteAsk] = useState<PasteAsk | null>(null);
  const [typing, setTyping] = useState<{ typed: number; total: number } | null>(null);
  const typingOn = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [keysLocked, setKeysLocked] = useState(false);
  const hintId = useId();
  const listId = useId();
  const connected = phase.kind === 'connected' && clientReady && !clientError;

  // A new session: forget the old client's state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the transport changes
  useEffect(() => {
    setClientReady(false);
    setClientError(null);
    setSize(null);
    setSticky(NO_MODIFIERS);
    typingOn.current = false;
    setTyping(null);
  }, [transport]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onFs = () => {
      const on = !!stageRef.current && document.fullscreenElement === stageRef.current;
      setFullscreen(on);
      if (!on) {
        (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard?.unlock?.();
        setKeysLocked(false);
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  /* The keyboard ------------------------------------------------------------------------------------ */

  const capture = useCallback(() => clientRef.current?.capture(), []);
  /** After a tool: the keys go back to the console (now, and once a dialog that had them has closed). */
  const recapture = useCallback(() => {
    clientRef.current?.capture();
    requestAnimationFrame(() => clientRef.current?.capture());
  }, []);
  const release = useCallback(() => frameRef.current?.focus({ preventScroll: true }), []);
  const input = useCallback(() => transport?.activity(), [transport]);
  const onReady = useCallback(() => {
    setClientReady(true);
    // A console that opens takes the keys, as a terminal window does.
    requestAnimationFrame(() => clientRef.current?.capture());
  }, []);

  const onFrameKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === frameRef.current) return;
    // Ctrl+Alt (not AltGr) gives the keyboard back to the page.
    const altGr = e.key === 'AltGraph' || e.nativeEvent.getModifierState?.('AltGraph');
    if (e.ctrlKey && e.altKey && !altGr && (e.key === 'Control' || e.key === 'Alt')) {
      e.preventDefault();
      e.stopPropagation();
      clientRef.current?.release();
      release();
    }
  };
  const onFrameKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === frameRef.current && e.key === 'Enter' && connected) {
      e.preventDefault();
      capture();
    }
  };

  /* Tools ------------------------------------------------------------------------------------------- */

  const onCombo = (c: KeyCombo) => {
    clientRef.current?.sendKeys?.(c.keys);
    setNotice({ text: `Sent ${c.label}.`, tone: 'ok' });
    recapture();
  };
  const onShellKey = (k: ShellKey) => {
    clientRef.current?.sendBytes?.(k.data);
    setNotice({ text: `Sent ${k.label}.`, tone: 'ok' });
    recapture();
  };
  const onRowKey = (k: RowKey) => {
    const c = clientRef.current;
    if (kind === 'screen') c?.sendKeys?.(screenRowKeys(k, sticky));
    else c?.sendBytes?.(shellRowBytes(k, sticky));
    setSticky(NO_MODIFIERS);
  };

  const sendText = async (text: string) => {
    setPasteAsk(null);
    const c = clientRef.current;
    if (!c || !connected) return;
    if (kind === 'screen') {
      typingOn.current = true;
      const total = Array.from(text).length;
      setTyping({ typed: 0, total });
      const typed = await c.paste(text, {
        alive: () => typingOn.current,
        onProgress: (n, of) => setTyping({ typed: n, total: of }),
      });
      typingOn.current = false;
      setTyping(null);
      setNotice({
        text:
          typed < total
            ? `Stopped after ${plural(typed, 'character')}.`
            : `Typed ${plural(typed, 'character')}.`,
        tone: 'ok',
      });
    } else {
      const sent = await c.paste(text);
      const lines = text.replace(/\n$/, '').split('\n').length;
      setNotice({
        text: lines > 1 ? `Pasted ${plural(lines, 'line')}.` : `Pasted ${plural(sent, 'character')}.`,
        tone: 'ok',
      });
    }
    recapture();
  };

  const pasteText = (text: string) => {
    const plan = planPaste(text, kind);
    if (plan.kind === 'empty') setNotice({ text: 'There’s no text on the clipboard.', tone: 'bad' });
    else if (plan.kind === 'too_large')
      setNotice({
        text: `That’s ${formatBytes(plan.bytes, currentLocale())}; up to ${formatBytes(PASTE_LIMIT_BYTES, currentLocale())} can be pasted.`,
        tone: 'bad',
      });
    else if (plan.kind === 'ask') setPasteAsk({ mode: 'confirm', analysis: plan.analysis });
    else void sendText(plan.text);
  };

  // The clipboard is read only here, in the Paste button's click (a user gesture).
  const onPaste = async () => {
    let text: string | null = null;
    try {
      text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : null;
    } catch {
      text = null;
    }
    if (text === null) setPasteAsk({ mode: 'input' });
    else pasteText(text);
  };

  const onCopy = async () => {
    const out = clientRef.current?.copyText?.();
    if (!out?.text) {
      setNotice({ text: 'There’s nothing to copy yet.', tone: 'bad' });
      return;
    }
    const ok = await writeClipboard(out.text);
    setNotice(
      ok
        ? {
            text: out.selection ? 'Copied the selection.' : `Copied ${plural(out.lines, 'line')}.`,
            tone: 'ok',
          }
        : { text: 'The browser didn’t allow copying.', tone: 'bad' },
    );
    recapture();
  };

  const onScreenshot = async () => {
    const blob = await clientRef.current?.screenshot?.();
    if (!blob) {
      setNotice({ text: 'There’s no picture to save yet.', tone: 'bad' });
      return;
    }
    saveBlob(blob, `${name}-${stamp()}.png`);
    setNotice({ text: 'Saved the screenshot.', tone: 'ok' });
    recapture();
  };

  const onFullscreen = async () => {
    const el = stageRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await el.requestFullscreen();
      // In full screen a VM's screen may take the keys the browser keeps (Alt+Tab, Esc …; Chrome's Keyboard Lock).
      const kb = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
      if (kind === 'screen' && kb?.lock) {
        await kb.lock().then(
          () => setKeysLocked(true),
          () => setKeysLocked(false),
        );
      }
      recapture();
    } catch {
      setNotice({ text: 'This browser can’t show the console full screen.', tone: 'bad' });
    }
  };

  /* Start ------------------------------------------------------------------------------------------- */

  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  const [waking, setWaking] = useState(false);
  const wake = async (g: HostGuest, action: 'start' | 'resume') => {
    setWaking(true);
    const out = await run(
      () => change.mutateAsync({ params: { burrow, serverId, guestId: g.id }, body: { action } }),
      (d) => actionAcceptedText(action, g.name, d.noop),
    );
    if (!out.ok) setWaking(false);
  };
  useEffect(() => {
    if (guest?.state === 'running' || guest?.state === 'unhealthy') setWaking(false);
  }, [guest?.state]);

  /* The screen -------------------------------------------------------------------------------------- */

  let screen: ReactNode;
  if (localOnly) {
    screen = (
      <Note>
        <p>
          Consoles open on the local network for now. Open Whombat at this box’s local address to use one;
          everything else about {name} works from here.
        </p>
      </Note>
    );
  } else if (missing) {
    screen = (
      <Note>
        <p>That guest isn’t on {serverId} any more.</p>
      </Note>
    );
  } else if (screenBlocked) {
    screen = (
      <Note>
        <p>{screenBlocked}</p>
        <p className={styles.noteSub}>The Screen tab says what to do.</p>
      </Note>
    );
  } else if (guest && (off || paused)) {
    const powerOn = rc.power !== false;
    const action = off ? 'start' : 'resume';
    screen = (
      <Note>
        <p>{off ? `${guest.name} is switched off.` : `${guest.name} is paused.`}</p>
        {powerOn ? (
          <Button
            variant="primary"
            iconStart={<Icon icon={Play} size={15} />}
            disabled={waking || busy}
            aria-busy={waking || undefined}
            onClick={() => void wake(guest, action)}
          >
            {waking
              ? off
                ? `Starting ${guest.name}…`
                : `Resuming ${guest.name}…`
              : off
                ? `Start ${guest.name}`
                : `Resume ${guest.name}`}
          </Button>
        ) : (
          <p className={styles.noteSub}>
            {rc.powerReason ?? 'Starting guests is switched off for this server.'}
          </p>
        )}
        {powerOn ? <p className={styles.noteSub}>The console opens once it’s running.</p> : null}
      </Note>
    );
  } else if (!consoleOn) {
    screen = (
      <Note>
        <p>
          {guest
            ? (rc.consoleReason ?? 'Consoles are switched off for this server.')
            : (rc.hostShellReason ?? 'The shell is switched off for this server.')}
        </p>
      </Note>
    );
  } else if (!hasConsole) {
    screen = (
      <Note>
        <p>{name} has no console Whombat can open.</p>
      </Note>
    );
  } else if (phase.kind === 'ended' || clientError) {
    screen = (
      <Note>
        <p>{clientError ?? (phase.kind === 'ended' ? phase.message : '')}</p>
        <Button size="sm" onClick={session.reconnect}>
          Connect again
        </Button>
      </Note>
    );
  } else if (!live) {
    screen = (
      <Note>
        <p>Connecting…</p>
      </Note>
    );
  } else {
    const props = {
      ref: clientRef,
      transport: live.transport,
      label: title,
      readOnly,
      onReady,
      onSize: setSize,
      onRelease: release,
      onError: setClientError,
      onInput: input,
      sticky,
      onStickyUsed: () => setSticky(NO_MODIFIERS),
      onPasteText: pasteText,
      // A Mac's session needs nothing from the browser: its agent signs in to Screen Sharing (MAC-04).
      ...(mac
        ? {
            credentialsText: `${serverId}’s screen asked the browser for a password, which Whombat doesn’t give it. Check the Mac’s password on the Screen tab.`,
          }
        : {}),
    };
    screen = (
      <>
        <div ref={clientHost} className={styles.client}>
          {live.session.protocol === 'vnc' ? <VncScreen {...props} /> : <TerminalScreen {...props} />}
        </div>
        {!connected ? (
          <div className={styles.overlay}>
            <Note>
              <p>Connecting…</p>
            </Note>
          </div>
        ) : null}
      </>
    );
  }

  /* The status line --------------------------------------------------------------------------------- */

  const statusWords = connected
    ? 'Connected'
    : live || phase.kind === 'starting'
      ? 'Connecting…'
      : 'Not connected';
  const meta = connected
    ? [size ?? session.resolution, session.latencyMs != null ? `${session.latencyMs} ms` : null]
        .filter(Boolean)
        .join(' · ')
    : '';
  const tools = connected && !readOnly;
  const showPower =
    !!guest &&
    !off &&
    (manageablePlatform(guest) || guest.platform === 'docker' || guest.platform === 'libvirt');
  const hint = readOnly
    ? 'The latest lines, then new ones as they come · read only'
    : kind === 'screen'
      ? 'Click the screen to use it · Ctrl+Alt gives the keyboard back'
      : 'Click the shell to type · Ctrl+Alt gives the keyboard back';

  return (
    <>
      <div className={styles.head}>
        <ModalTitle className={cx(things.dialogTitle, styles.title)}>{title}</ModalTitle>
        {guest ? (
          <Badge tone={guestStateTone(guest.state)} dot>
            {GUEST_STATE_WORDS[guest.state]}
          </Badge>
        ) : null}
        <span className={styles.kind}>{guest ? guestKindText(guest) : mac ? MAC_KIND_WORD : 'Server'}</span>
        <div className={styles.headEnd}>
          {protocols.length > 1 && enabled ? (
            <SegmentedControl
              options={protocols.map((p) => ({ value: p, label: PROTOCOL_WORDS[p] ?? p }))}
              value={protocol ?? protocols[0] ?? 'shell'}
              onChange={setProtocol}
              label="Console"
              size="sm"
              variant="soft"
            />
          ) : null}
          {showPower && guest ? (
            <GuestPower
              burrow={burrow}
              serverId={serverId}
              guest={guest}
              allowed={rc.power !== false}
              reason={rc.powerReason}
              size="sm"
            />
          ) : null}
        </div>
      </div>

      <div className={cx(styles.body, listOpen && styles.bodyWithList)}>
        <div ref={stageRef} className={styles.stage}>
          <div className={styles.toolbar} role="toolbar" aria-label={`Tools for ${name}`}>
            {!readOnly ? (
              <SendKeysMenu kind={kind} disabled={!tools} onCombo={onCombo} onShellKey={onShellKey} />
            ) : null}
            {!readOnly ? (
              <Button
                size="sm"
                iconStart={<Icon icon={ClipboardPaste} size={15} />}
                disabled={!tools || !!typing}
                onClick={() => void onPaste()}
              >
                Paste
              </Button>
            ) : null}
            {kind === 'shell' ? (
              <Button
                size="sm"
                iconStart={<Icon icon={Copy} size={15} />}
                disabled={!connected}
                onClick={() => void onCopy()}
                title="The selection, or everything when nothing is selected"
              >
                Copy
              </Button>
            ) : (
              <Button
                size="sm"
                iconStart={<Icon icon={Camera} size={15} />}
                disabled={!connected}
                onClick={() => void onScreenshot()}
              >
                Screenshot
              </Button>
            )}
            <Button
              size="sm"
              iconStart={<Icon icon={fullscreen ? Minimize2 : Maximize2} size={15} />}
              aria-pressed={fullscreen}
              onClick={() => void onFullscreen()}
            >
              {fullscreen ? 'Leave full screen' : 'Full screen'}
            </Button>
            {!fullscreen ? (
              <Button
                size="sm"
                className={styles.maximize}
                iconStart={<Icon icon={maximized ? Shrink : Expand} size={15} />}
                aria-pressed={maximized}
                title={maximized ? undefined : 'Fill this window'}
                onClick={() => {
                  onMaximize(!maximized);
                  recapture();
                }}
              >
                {maximized ? 'Restore' : 'Maximize'}
              </Button>
            ) : null}
            {/* A Mac has nothing else to switch to but its own shell, which the switch above has. */}
            {!fullscreen && !(mac && guests.length === 0) ? (
              <Button
                size="sm"
                variant="ghost"
                className={styles.listToggle}
                iconStart={<Icon icon={PanelRight} size={15} />}
                aria-expanded={listOpen}
                aria-controls={listOpen ? listId : undefined}
                onClick={() => onList(!listOpen)}
              >
                {listOpen ? 'Hide guests' : 'Guests'}
              </Button>
            ) : null}
          </div>

          {/* The console's Tab stop: Enter or a click gives it the keys; a remote screen takes every key, as an
              application does. */}
          <div
            ref={frameRef}
            className={cx(styles.frame, phase.kind === 'ended' && styles.frameEnded)}
            {...(live
              ? {
                  role: 'application',
                  'aria-label': title,
                  'aria-describedby': hintId,
                  tabIndex: 0,
                  onKeyDownCapture: onFrameKeyDownCapture,
                  onKeyDown: onFrameKeyDown,
                  // A click gives the console the keys (unless it has them already).
                  onClick: () => {
                    if (!clientHost.current?.contains(document.activeElement)) capture();
                  },
                }
              : {})}
          >
            {screen}
          </div>

          {tools ? (
            <KeyRow
              name={name}
              sticky={sticky}
              onSticky={(m) => {
                setSticky(m);
                capture();
              }}
              onKey={onRowKey}
            />
          ) : null}

          {phase.kind === 'connected' ? (
            <IdleWatch
              transport={phase.transport}
              timeoutS={phase.session.idleTimeoutS}
              onStay={() => {
                phase.transport.stayConnected();
                recapture();
              }}
            />
          ) : null}

          <div className={styles.status}>
            <span className={styles.statusLeft}>
              <Dot tone={connected ? 'ok' : phase.kind === 'ended' && !phase.ended ? 'bad' : 'mut'} />
              <span>{statusWords}</span>
              {sticky.ctrl || sticky.alt ? (
                <span className={styles.notice}>{modifierWords(sticky)} held for the next key</span>
              ) : null}
              {typing ? (
                <span className={styles.notice}>
                  Typing {formatCount(typing.typed)} of {plural(typing.total, 'character')}…{' '}
                  <button
                    type="button"
                    className={styles.textBtn}
                    onClick={() => {
                      typingOn.current = false;
                    }}
                  >
                    Stop
                  </button>
                </span>
              ) : null}
              <span
                className={cx(styles.notice, notice?.tone === 'bad' && styles.noticeBad)}
                aria-live="polite"
              >
                {notice?.text ?? ''}
              </span>
              {fullscreen && keysLocked ? (
                <span className={styles.notice}>Hold Esc to leave full screen.</span>
              ) : null}
            </span>
            {meta ? <span className={styles.meta}>{meta}</span> : null}
          </div>
        </div>

        {listOpen && !fullscreen ? (
          <GuestList
            id={listId}
            serverId={serverId}
            guests={guests}
            current={target}
            hostShell={rc.hostShell !== false}
            onSelect={onSelect}
          />
        ) : null}
      </div>

      <div className={styles.foot}>
        <p id={hintId} className={styles.hint}>
          {enabled ? hint : ''}
        </p>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>

      <PasteDialog
        ask={pasteAsk}
        name={name}
        onCancel={() => {
          setPasteAsk(null);
          recapture();
        }}
        onSend={(text) => void sendText(text)}
      />
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className={styles.note} role="status">
      {children}
    </div>
  );
}

/** Ticks once a second while connected; shows the warning in the last minute before the idle close. */
function IdleWatch({
  transport,
  timeoutS,
  onStay,
}: {
  transport: ConsoleTransport;
  timeoutS: number;
  onStay: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = transport.idleLeftMs(timeoutS);
  if (left === null || left > IDLE_WARN_MS) return null;
  return <IdleWarning leftMs={left} onStay={onStay} />;
}
