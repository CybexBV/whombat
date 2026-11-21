// A terminal on the host itself: its journal (read-only, `logs`) or a root
// shell (`shell`, admins with the host shell switched on; the hub asks for a
// recent sign-in). Same session lifecycle and xterm.js client as the guest
// consoles; the shell starts on request, never by opening the tab.

import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { HOST_GUEST_ID } from '../../api/client';
import { Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { t } from '../../lib/i18n';
import type { ScreenHandle } from '../console/clients/types';
import { closeReasonText, useConsoleSession } from '../console/useConsoleSession';

const TerminalScreen = lazy(() => import('../console/clients/TerminalScreen').then((m) => ({ default: m.TerminalScreen })));

interface Props {
  serverId: string;
  protocol: 'logs' | 'shell';
}

export function HostTerminal({ serverId, protocol }: Props) {
  const shell = protocol === 'shell';
  const [started, setStarted] = useState(!shell);
  const session = useConsoleSession({ serverId, guestId: HOST_GUEST_ID, protocol, enabled: started });
  const client = useRef<ScreenHandle | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const phase = session.phase;
  const transport = phase.kind === 'connecting' || phase.kind === 'connected' || phase.kind === 'lost' ? phase.transport : null;
  const onReady = useCallback(() => setReady(true), []);
  // A new session (Reconnect): wait for its client again.
  useEffect(() => setReady(false), [transport?.url]);
  const name = shell ? t('Root shell') : t('Journal');

  let screen: ReactNode;
  if (!started) {
    screen = (
      <div className="con-msg">
        <Icon name="terminal" className="con-msg-ic" />
        <div className="con-msg-text">{t('A root shell on {id}. Every session is audited.', { id: serverId })}</div>
        <button type="button" className="btn-primary btn-in-card" onClick={() => setStarted(true)}>
          {t('Open root shell')}
        </button>
      </div>
    );
  } else if (phase.kind === 'failed' || clientError) {
    screen = (
      <div className="con-msg">
        <Icon name="warning" className="con-msg-ic" />
        <div className="con-msg-text">{clientError ?? (phase.kind === 'failed' ? phase.error.message : '')}</div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setClientError(null);
            session.reconnect();
          }}
        >
          <Icon name="refresh" size={16} />
          {t('Try again')}
        </button>
      </div>
    );
  } else {
    screen = (
      <>
        {transport && (
          <Suspense fallback={null}>
            <TerminalScreen
              key={transport.url}
              ref={client}
              transport={transport}
              label={`${serverId} ${name.toLowerCase()}`}
              onSize={() => {}}
              onRelease={() => frame.current?.focus({ preventScroll: true })}
              onError={setClientError}
              onReady={onReady}
              readOnly={!shell}
              fontSize={13}
            />
          </Suspense>
        )}
        {(phase.kind !== 'connected' && phase.kind !== 'lost') || !ready ? (
          <div className="con-overlay">
            <div className="con-msg">
              <span className="spinner con-spinner" aria-hidden="true" />
              <div className="con-msg-text">{t('Connecting · {name}', { name })}</div>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  let status: ReactNode = null;
  if (phase.kind === 'connected' && ready) {
    status = (
      <span className="con-status-item">
        <Dot color="var(--good)" />
        {t('Connected · {name}', { name })}
        {shell ? '' : ` · ${t('the last lines, then new ones as they come')}`}
      </span>
    );
  } else if (phase.kind === 'lost') {
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
  }

  return (
    <div className="sys-term">
      <div
        ref={frame}
        className={`con-screen is-text${phase.kind === 'lost' ? ' is-lost' : ''}`}
        tabIndex={0}
        role="group"
        aria-roledescription="terminal"
        aria-label={`${serverId} ${name.toLowerCase()}`}
        onKeyDownCapture={(e) => {
          if (e.target === frame.current) {
            if (e.key === 'Enter' && shell) {
              e.preventDefault();
              client.current?.capture();
            }
            return;
          }
          if (e.ctrlKey && e.altKey && (e.key === 'Control' || e.key === 'Alt')) {
            e.preventDefault();
            client.current?.release();
            return;
          }
          transport?.activity();
        }}
        onClick={() => shell && client.current?.capture()}
      >
        {screen}
      </div>
      {status && (
        <div className="con-status">
          <div className="con-status-left" aria-live="polite">
            {status}
          </div>
          {shell && phase.kind === 'connected' && <span className="lbl">{t('Ctrl+Alt gives the keyboard back')}</span>}
        </div>
      )}
    </div>
  );
}
