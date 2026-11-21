// Remote console inside the guests card (SCREENS 5, PRODUCT-SPEC C2-C7,
// REMOTE-CONSOLE 12): header (back, name, state, type and uptime chips,
// Fullscreen, connection type), toolbar, 16:10 screen, status line, hint and
// the side list of the host's guests. The session lifecycle is in
// useConsoleSession; the clients (xterm.js, noVNC, spice-html5) in ./clients.

import { lazy, type ReactNode, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import { useAuthState } from '../../api/queries';
import type { ConsoleProtocol, Guest } from '../../api/types';
import { Chip, Dot, SegmentedControl } from '../../components/controls';
import { Icon, type IconName } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { t, tn, tx } from '../../lib/i18n';
import { agentPath } from '../../lib/urlState';
import type { ScreenHandle, ScreenProps } from './clients/types';
import { PasteDialog, type PasteDialogState, PowerConfirmDialog } from './ConsoleDialogs';
import { ACTIONS, type ActionSpec, actionText, hintFor, isTextProtocol, protocolLabel, toolbarActions, typeChip, uptimeChip } from './labels';
import { analyzePaste, formatBytes, PASTE_LIMIT_BYTES } from './paste';
import { usePowerAction } from './powerActions';
import type { ConsolePanelProps } from './types';
import { guestStateInfo } from '../guests/guestActions';
import { Menu } from '../../components/Menu';
import { useNow } from '../../lib/clock';
import { KEY_COMBOS, TERMINAL_KEYS } from './keyCombos';
import { closeReasonText, type SessionPhase, useConsoleSession } from './useConsoleSession';

// The clients load on demand (xterm.js, noVNC and spice-html5 stay out of the main bundle).
const TerminalScreen = lazy(() => import('./clients/TerminalScreen').then((m) => ({ default: m.TerminalScreen })));
const VncScreen = lazy(() => import('./clients/VncScreen').then((m) => ({ default: m.VncScreen })));
const SpiceScreen = lazy(() => import('./clients/SpiceScreen').then((m) => ({ default: m.SpiceScreen })));

const PROTOCOLS: ConsoleProtocol[] = ['vnc', 'spice', 'serial', 'shell', 'tty', 'logs'];

function isProtocol(v: string | null): v is ConsoleProtocol {
  return !!v && (PROTOCOLS as string[]).includes(v);
}

/** Effective permissions for this user and server (CONTRACT 1; missing = allowed, fixtures). */
function permissions(p: ConsolePanelProps) {
  const rc = p.server.server.remote_control;
  return {
    console: rc?.console ?? true,
    power: rc?.power ?? true,
    consoleReason: rc?.console_reason ?? t('Remote control is turned off for this server'),
    powerReason: rc?.power_reason ?? t('Power actions are turned off for this server'),
    hubConsoleOff: rc ? rc.agent_console !== false && !rc.console : false,
  };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface ToolButtonProps {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled (tooltip and accessible description). */
  reason?: string;
  serious?: boolean;
  first?: boolean;
}

function ToolButton({ icon, label, onClick, disabled, reason, serious, first }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`btn-ghost con-tool${serious ? ' is-serious' : ''}${first ? ' con-tool-right' : ''}`}
      aria-disabled={disabled || undefined}
      title={disabled ? reason : undefined}
      onClick={() => !disabled && onClick()}
    >
      <Icon name={icon} size={16} />
      {label}
      {disabled && reason && <span className="sr-only">: {reason}</span>}
    </button>
  );
}

/** A line a minute before the hub closes an idle console, with a way to stay. */
function IdleWarning({ lastInput, timeoutS, onStay }: { lastInput: { current: number }; timeoutS: number; onStay: () => void }) {
  const now = useNow();
  if (!timeoutS) return null;
  // The hub hears about input at most every 30 s: warn 90 s ahead.
  const left = Math.round((lastInput.current + timeoutS * 1000 - now) / 1000);
  if (left > 90) return null;
  return (
    <div className="con-idle" role="status">
      <Icon name="clock" size={15} />
      {left > 0
        ? left > 60
          ? t('No input for a while: the console closes in a minute.')
          : t('No input for a while: the console closes in {n} s.', { n: left })
        : t('The console is about to close for inactivity.')}
      <button type="button" className="btn-text" onClick={onStay}>
        {t('Stay connected')}
      </button>
    </div>
  );
}

function ScreenMessage({ icon, children, spinner }: { icon?: IconName; children: ReactNode; spinner?: boolean }) {
  return (
    <div className="con-msg">
      {spinner ? <span className="spinner con-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} className="con-msg-ic" /> : null}
      {children}
    </div>
  );
}

export function ConsolePanel(props: ConsolePanelProps) {
  const { server, guest, guests, listTitle, onClose, onSelectGuest, onProtocolChange, compact } = props;
  const serverId = server.server.id;
  const perms = permissions(props);
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  const running = guest.state !== 'stopped';
  const protocols = guest.console.protocols ?? [];
  const unavailable = guest.console.unavailable ?? {};
  // A stopped container's logs stay readable (Docker).
  const logsOnly = !running && protocols.includes('logs');
  const requested = logsOnly ? 'logs' : isProtocol(props.protocol) && protocols.includes(props.protocol) ? props.protocol : null;
  const enabled = (running || logsOnly) && perms.console && guest.console.available !== false && protocols.length > 0;
  const session = useConsoleSession({ serverId, guestId: guest.id, protocol: requested, enabled });
  const protocol: ConsoleProtocol | null = requested ?? session.protocol ?? guest.console.default_protocol ?? protocols[0] ?? null;
  const label = protocol ? protocolLabel(guest, protocol) : '';
  const power = usePowerAction(serverId, guest.id);

  const screenRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<ScreenHandle | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<ActionSpec | null>(null);
  const [pasteState, setPasteState] = useState<PasteDialogState | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState<'paste' | 'screenshot' | null>(null);
  // The transport can be connected before the lazily loaded client is up.
  const [clientReady, setClientReady] = useState(false);
  const captureWhenReady = useRef(false);
  const hintId = useId();
  const keysId = useId();

  const phase: SessionPhase = session.phase;
  const transport = phase.kind === 'connecting' || phase.kind === 'connected' || phase.kind === 'lost' ? phase.transport : null;
  const sessionKey = transport?.url ?? 'none';
  const connected = phase.kind === 'connected' && clientReady && !clientError;

  // A new guest or session: forget the previous size, readiness and client errors.
  useEffect(() => {
    setSize(null);
    setClientError(null);
    setClientReady(false);
    captureWhenReady.current = false;
  }, [guest.id, sessionKey]);

  const onClientReady = useCallback(() => {
    setClientReady(true);
    if (captureWhenReady.current) {
      captureWhenReady.current = false;
      requestAnimationFrame(() => clientRef.current?.capture());
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === screenRef.current && !!screenRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ---------------------------------------------------------------- idle tracking

  // The hub closes a console after idle_timeout_s without input; the panel
  // warns a minute before (IdleWarning) and "Stay connected" counts as input.
  const lastInput = useRef(Date.now());
  const markInput = useCallback(() => {
    lastInput.current = Date.now();
    transport?.activity();
  }, [transport]);
  const sessionId = phase.kind === 'connected' ? phase.session.session_id : null;
  useEffect(() => {
    lastInput.current = Date.now();
  }, [sessionId]);
  const [wide, setWide] = useState(false);

  // ---------------------------------------------------------------- keyboard capture

  const release = useCallback(() => {
    screenRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target === screenRef.current) return;
    // Ctrl+Alt (not AltGr) gives the keyboard back to the page.
    const altGr = e.key === 'AltGraph' || e.nativeEvent.getModifierState?.('AltGraph');
    if (e.ctrlKey && e.altKey && !altGr && (e.key === 'Control' || e.key === 'Alt')) {
      e.preventDefault();
      e.stopPropagation();
      clientRef.current?.release();
      release();
      return;
    }
    markInput();
  };

  const capture = () => {
    if (connected) clientRef.current?.capture();
    else if (transport) captureWhenReady.current = true;
  };

  const onFrameKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== screenRef.current) return;
    if (e.key === 'Enter' && transport) {
      e.preventDefault();
      capture();
    }
  };

  const onPointer = () => markInput();

  // ---------------------------------------------------------------- toolbar actions

  const toggleFullscreen = async () => {
    const el = screenRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      toast(t('Fullscreen is not available in this browser.'), 'error');
    }
  };

  const sendPaste = async (text: string, raw: boolean) => {
    setPasteState(null);
    const c = clientRef.current;
    if (!c || !connected) return;
    setBusy('paste');
    try {
      await c.paste(text, { raw });
      // Give the keyboard back to the guest: now (no dialog was open, so the
      // next key goes to the guest, not to the Paste button), and again once
      // a dialog has closed.
      clientRef.current?.capture();
      requestAnimationFrame(() => clientRef.current?.capture());
      setNotice({ text: `${tn(text.length, 'Pasted {n} character', 'Pasted {n} characters', { n: text.length.toLocaleString('en-US') })}${raw ? ` ${t('(raw)')}` : ''}`, tone: 'ok' });
    } finally {
      setBusy(null);
    }
  };

  const handleText = (text: string) => {
    const a = analyzePaste(text);
    if (!a.normalized) {
      toast(t('The clipboard has no text to paste.'), 'info');
      return;
    }
    if (a.tooLarge) {
      toast(t('The clipboard text is {size}; the paste limit is {limit}. Nothing was sent.', { size: formatBytes(a.bytes), limit: formatBytes(PASTE_LIMIT_BYTES) }), 'error');
      return;
    }
    if (a.controlCount > 0) {
      setPasteState({ mode: 'control', analysis: a });
      return;
    }
    void sendPaste(a.sanitized, false);
  };

  // The clipboard is read only here, in the click handler of the Paste button (a user gesture).
  const onPaste = async () => {
    let text: string | null = null;
    try {
      text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : null;
    } catch {
      text = null;
    }
    if (text === null) setPasteState({ mode: 'input' });
    else handleText(text);
  };

  const onCopy = async () => {
    const out = clientRef.current?.copyText?.();
    if (!out || !out.text) {
      setNotice({ text: t('Nothing to copy yet'), tone: 'error' });
      return;
    }
    try {
      await navigator.clipboard.writeText(out.text);
      setNotice({ text: out.selection ? t('Copied the selection') : tn(out.lines, 'Copied {n} line', 'Copied {n} lines'), tone: 'ok' });
    } catch {
      setNotice({ text: t('The browser blocked clipboard access'), tone: 'error' });
    }
  };

  const onScreenshot = async () => {
    setBusy('screenshot');
    try {
      const blob = await api.screenshot(serverId, guest.id);
      download(blob, `${guest.name}-${stamp()}.png`);
      setNotice({ text: t('Screenshot saved'), tone: 'ok' });
    } catch (err) {
      setNotice({ text: err instanceof Error ? t('Screenshot failed: {error}', { error: err.message }) : t('Screenshot failed'), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const onCombo = (id: string) => {
    const combo = KEY_COMBOS.find((c) => c.id === id);
    if (!combo) return;
    markInput();
    if (combo.id === 'ctrl-alt-del' && clientRef.current?.ctrlAltDel) clientRef.current.ctrlAltDel();
    else clientRef.current?.sendCombo?.(combo.keys);
    setNotice({ text: t('Sent {keys}', { keys: combo.label }), tone: 'ok' });
  };

  const confirmAction = () => {
    const spec = confirm;
    setConfirm(null);
    if (spec) void power.run(spec.action);
  };

  // ---------------------------------------------------------------- render pieces

  const vm = guest.kind === 'vm';
  const pending = power.pending;
  const consoleReady = connected;
  const notConnectedReason = !running ? t('The guest is powered off') : !perms.console ? perms.consoleReason : t('The console is not connected');
  const powerBlocked = !perms.power ? perms.powerReason : pending ? t('{action} is in progress', { action: actionText(pending.action).pending.replace('…', '') }) : null;
  const readOnly = protocol === 'logs';

  const leftTools: ReactNode[] = vm
    ? [
        <Menu
          key="keys"
          label={t('Send keys')}
          align="start"
          buttonClassName="btn-ghost con-tool"
          disabled={!consoleReady || isTextProtocol(protocol)}
          items={KEY_COMBOS.map((c) => ({ label: c.label, onSelect: () => onCombo(c.id) }))}
        >
          <Icon name="keyboard" size={16} />
          {t('Keys')}
        </Menu>,
        <ToolButton key="paste" icon="clipboard" label={t('Paste')} onClick={() => void onPaste()} disabled={!consoleReady || busy === 'paste'} reason={notConnectedReason} />,
        <ToolButton
          key="shot"
          icon="camera"
          label={t('Screenshot')}
          onClick={() => void onScreenshot()}
          disabled={!running || !perms.console || busy === 'screenshot'}
          reason={!running ? t('The guest is powered off') : perms.consoleReason}
        />,
      ]
    : [
        ...(readOnly
          ? []
          : [<ToolButton key="paste" icon="clipboard" label={t('Paste')} onClick={() => void onPaste()} disabled={!consoleReady || busy === 'paste'} reason={notConnectedReason} />]),
        <ToolButton key="copy" icon="copy" label={t('Copy output')} onClick={() => void onCopy()} disabled={!transport} reason={notConnectedReason} />,
      ];

  const rightTools = toolbarActions(guest).map((spec, i) => (
    <ToolButton
      key={spec.action}
      icon={spec.icon}
      label={spec.label}
      serious={spec.serious}
      first={i === 0}
      onClick={() => setConfirm(spec)}
      disabled={!running || !!powerBlocked}
      reason={!running ? t('The guest is powered off') : (powerBlocked ?? undefined)}
    />
  ));

  const screenProps: ScreenProps | null = transport
    ? {
        transport,
        label: t('{name} {type} console', { name: guest.name, type: label }),
        onSize: setSize,
        onRelease: release,
        onError: setClientError,
        onReady: onClientReady,
        readOnly,
      }
    : null;

  let screen: ReactNode;
  if (!running && !logsOnly) {
    const startSpec = ACTIONS.start;
    screen = (
      <ScreenMessage icon="power">
        <div className="con-msg-text">
          {tx('{name} is powered off', { name: <span className="mono">{guest.name}</span> })}
        </div>
        {perms.power ? (
          <button type="button" className="btn-primary btn-in-card" aria-disabled={!!pending || undefined} onClick={() => !pending && void power.run('start')}>
            <Icon name="play" size={16} className="ic-bold" />
            {pending?.action === 'start' ? startSpec.pending : vm ? t('Start VM') : t('Start container')}
          </button>
        ) : (
          <div className="lbl">{perms.powerReason}</div>
        )}
      </ScreenMessage>
    );
  } else if (!perms.console) {
    screen = (
      <ScreenMessage icon="shield">
        <div className="con-msg-text">{perms.consoleReason}</div>
        {isAdmin && perms.hubConsoleOff && (
          <Link to={agentPath(serverId)} className="con-msg-link">
            {t('Turn on remote control in the server’s settings')}
          </Link>
        )}
      </ScreenMessage>
    );
  } else if (protocols.length === 0 || guest.console.available === false) {
    screen = (
      <ScreenMessage icon="monitor">
        <div className="con-msg-text">{t('This guest has no console.')}</div>
      </ScreenMessage>
    );
  } else if (phase.kind === 'failed' || clientError) {
    const msg = clientError ?? (phase.kind === 'failed' ? phase.error.message : '');
    screen = (
      <ScreenMessage icon="warning">
        <div className="con-msg-text">{msg}</div>
        <button type="button" className="btn-ghost" onClick={session.reconnect}>
          <Icon name="refresh" size={16} />
          {t('Try again')}
        </button>
      </ScreenMessage>
    );
  } else {
    const Client = protocol === 'vnc' ? VncScreen : protocol === 'spice' ? SpiceScreen : TerminalScreen;
    screen = (
      <>
        {screenProps && (
          <Suspense fallback={null}>
            <Client key={sessionKey} ref={clientRef} {...screenProps} />
          </Suspense>
        )}
        {(phase.kind === 'requesting' || phase.kind === 'connecting' || phase.kind === 'idle' || (phase.kind === 'connected' && !clientReady)) && (
          <div className="con-overlay">
            <ScreenMessage spinner>
              <div className="con-msg-text">{t('Connecting · {type}', { type: label })}</div>
            </ScreenMessage>
          </div>
        )}
      </>
    );
  }

  // Status line.
  const encrypted = typeof window !== 'undefined' && window.isSecureContext;
  let status: ReactNode;
  let right: string | null = null;
  if (!running && !logsOnly) {
    status = (
      <span className="con-status-item">
        <Dot color="var(--muted)" />
        {t('Not connected · the guest is powered off')}
      </span>
    );
  } else if (!perms.console) {
    status = (
      <span className="con-status-item">
        <Dot color="var(--muted)" />
        {t('Not connected · remote control is off')}
      </span>
    );
  } else if (clientError || phase.kind === 'failed') {
    status = (
      <span className="con-status-item">
        <Dot color="var(--critical)" />
        {t('Not connected')}
      </span>
    );
  } else if (phase.kind === 'lost') {
    // The shell exited (logout, Ctrl+D): not a failure, but the same Reconnect.
    const ended = phase.reason === 'ended';
    const why = ended ? '' : closeReasonText(phase.reason) || phase.error?.message || '';
    status = (
      <span className="con-status-item con-lost">
        <Dot color={ended ? 'var(--muted)' : 'var(--critical)'} />
        <span>
          {ended ? t('Session ended') : t('Connection lost')}
          {why ? ` · ${why}` : ''}
          {' · '}
        </span>
        <button type="button" className="btn-text con-reconnect" onClick={session.reconnect}>
          {t('Reconnect')}
        </button>
      </span>
    );
  } else if (phase.kind === 'connected' && clientReady) {
    status = (
      <span className="con-status-item">
        <Dot color="var(--good)" />
        {encrypted ? t('Connected · {type} · encrypted', { type: label }) : t('Connected · {type} · not encrypted (plain HTTP)', { type: label })}
      </span>
    );
    const res = size ?? session.status?.resolution?.replace('x', '×') ?? null;
    right = readOnly ? null : t('{resolution} · {latency} latency', { resolution: res ?? '—', latency: session.latencyMs == null ? '— ms' : `${session.latencyMs} ms` });
  } else {
    status = (
      <span className="con-status-item">
        <span className="spinner spinner-sm" aria-hidden="true" />
        {t('Connecting · {type}', { type: label })}
      </span>
    );
  }

  const pendingChip = pending ? (
    <Chip className="con-chip">
      <span className="spinner spinner-sm" aria-hidden="true" />
      {actionText(pending.action).pending}
    </Chip>
  ) : power.result ? (
    <Chip className="con-chip" dot={power.result.ok ? 'var(--good)' : 'var(--critical)'}>
      {power.result.ok ? power.result.message : t('{action} failed: {error}', { action: actionText(power.result.action).label, error: power.result.message })}
    </Chip>
  ) : notice ? (
    <Chip className="con-chip" dot={notice.tone === 'ok' ? 'var(--good)' : 'var(--critical)'}>
      {notice.text}
    </Chip>
  ) : null;

  const options = [
    ...protocols.map((p) => ({
      value: p,
      label: protocolLabel(guest, p),
      ...(logsOnly && p !== 'logs' ? { disabled: true, title: t('The container is stopped') } : {}),
    })),
    ...Object.entries(unavailable)
      .filter(([p]) => !protocols.includes(p as ConsoleProtocol))
      .map(([p, why]) => ({ value: p as ConsoleProtocol, label: protocolLabel(guest, p), disabled: true, title: why || t('Not available') })),
  ];

  return (
    <div className={compact ? `card con is-compact${wide ? ' is-wide' : ''}` : 'con'} role="region" aria-label={vm ? t('Console for {name}', { name: guest.name }) : t('Shell for {name}', { name: guest.name })}>
      <div className="con-head">
        <button type="button" className="btn-ghost" onClick={onClose} aria-label={compact ? (vm ? t('Close the console of {name}', { name: guest.name }) : t('Close the shell of {name}', { name: guest.name })) : undefined}>
          <Icon name={compact ? 'close' : 'arrowLeft'} size={15} />
          {compact ? t('Close') : t('Guests')}
        </button>
        <h3 className="con-name mono">{guest.name}</h3>
        <span className="state con-state">
          <Dot color={guestStateInfo(guest.state).color} />
          {guestStateInfo(guest.state).label}
        </span>
        <Chip>{typeChip(guest)}</Chip>
        <Chip>{uptimeChip(guest)}</Chip>
        {compact && (
          <button type="button" className="btn-ghost con-wide" onClick={() => setWide((w) => !w)} aria-pressed={wide} title={wide ? t('Show the guest list again') : t('Use the full width (hides the guest list)')}>
            <Icon name="swap" size={16} />
            {wide ? t('Narrower') : t('Wider')}
          </button>
        )}
        <button type="button" className="btn-ghost con-fs" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen}>
          <Icon name="fullscreen" size={16} />
          {fullscreen ? t('Exit fullscreen') : t('Fullscreen')}
        </button>
        {options.length > 0 && protocol && (
          <SegmentedControl<ConsoleProtocol> label={t('Connection type')} value={protocol} onChange={(p) => onProtocolChange(p)} options={options} />
        )}
      </div>

      <div className="con-body">
        <div className="con-main">
          <div className="con-toolbar" role="toolbar" aria-label={t('{name} actions', { name: guest.name })}>
            {leftTools}
            {rightTools}
          </div>
          <div
            ref={screenRef}
            className={`con-screen${isTextProtocol(protocol) || !vm ? ' is-text' : ''}${phase.kind === 'lost' ? ' is-lost' : ''}`}
            tabIndex={0}
            role="group"
            aria-roledescription={t('console screen')}
            aria-label={t('{name} screen', { name: guest.name })}
            aria-describedby={`${hintId} ${keysId}`}
            onKeyDownCapture={onKeyDownCapture}
            onKeyDown={onFrameKeyDown}
            onPointerDown={onPointer}
            onPointerMove={onPointer}
            onWheel={onPointer}
            onClick={() => {
              // Click to capture: focus the client unless it already has the keyboard.
              const active = document.activeElement;
              if (active === screenRef.current || !screenRef.current?.contains(active)) capture();
            }}
          >
            {screen}
          </div>
          {connected && isTextProtocol(protocol) && !readOnly && (
            <div className="con-keys" role="toolbar" aria-label={t('Keys a phone keyboard lacks')}>
              {TERMINAL_KEYS.map((k) => (
                <button
                  key={k.label}
                  type="button"
                  className="btn-ghost row-action"
                  title={k.title}
                  aria-label={k.title}
                  onPointerDown={(e) => e.preventDefault() /* keep the terminal focused */}
                  onClick={() => {
                    markInput();
                    clientRef.current?.sendRaw?.(k.data);
                  }}
                >
                  {k.label}
                </button>
              ))}
            </div>
          )}
          {phase.kind === 'connected' && <IdleWarning lastInput={lastInput} timeoutS={phase.session.idle_timeout_s} onStay={markInput} />}
          <span id={keysId} className="sr-only">
            {connected ? t('Press Enter or click to capture the keyboard. Press Ctrl+Alt to release it.') : ''}
          </span>
          <div className="con-status">
            <div className="con-status-left" aria-live="polite">
              {status}
              {pendingChip}
            </div>
            {right && <span className="mono con-meta">{right}</span>}
          </div>
          <div className="lbl" id={hintId}>
            {hintFor(guest, protocol)}
          </div>
        </div>

        {!compact && (
        <nav className="con-side" aria-label={listTitle}>
          <div className="lbl">{listTitle}</div>
          <ul className="con-rail">
            {guests.map((g: Guest) => {
              const current = g.id === guest.id;
              const stopped = g.state === 'stopped';
              return (
                <li key={g.id}>
                  <button
                    type="button"
                    className={`rail${current ? ' is-current' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => !current && onSelectGuest(g.id)}
                  >
                    <Dot color={guestStateInfo(g.state).color} />
                    <span className="mono rail-name">{g.name}</span>
                    {stopped && <span className="sr-only">, {t('stopped')}</span>}
                    <span className="lbl rail-kind">{g.kind === 'vm' ? 'VM' : t('Container')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        )}
      </div>

      <PowerConfirmDialog spec={confirm} guestName={guest.name} onCancel={() => setConfirm(null)} onConfirm={confirmAction} />
      <PasteDialog state={pasteState} guestName={guest.name} onCancel={() => setPasteState(null)} onSend={(t, raw) => void sendPaste(t, raw)} />
    </div>
  );
}
