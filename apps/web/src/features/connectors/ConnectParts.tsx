/**
 * Pieces both connect forms share (AP-756, AP-843): what a Custom MCP server's probe found (CX-61), the wait for
 * Nextcloud's login in another tab (CX-11), also used by Reconnect on a connection's page, and the wait for a sign-in on
 * the service's own page (Plex's; Whombat connection-signin.md SG-01, SG-05; AP-3911), also used by Sign in again.
 */
import {
  connectProblem,
  minutesLeftText,
  NEXTCLOUD_WAIT_TEXT,
  nextcloudEnds,
  nextcloudPollStep,
  probeNote,
  SERVICE_LOGIN_WAIT_TEXT,
  serviceLoginCode,
  serviceLoginEnds,
  serviceLoginPollStep,
} from '@whombat/client/connections';
import { useConnectionWrite } from '@whombat/client/react';
import {
  api,
  type ProbeConnectionResponse,
  type StartNextcloudLoginResponse,
  type StartServiceLoginBody,
  type StartServiceLoginResponse,
} from '@whombat/core/contracts';
import type { CatalogEntry, ConnectionAccessLevel, ConnectionView } from '@whombat/core/domain';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { useToast } from '../../components/Toast';
import k from './Catalog.module.css';
import { ExternalLink } from './CatalogParts';
import c from './Connectors.module.css';
import { useOpenConnection } from './useOpenConnection';

/** What the Custom MCP probe found (CX-61): the sign-in it picked, or why it couldn't tell. */
export function ProbeNote({ probed }: { probed: ProbeConnectionResponse }) {
  const note = probeNote(probed);
  return (
    <p className={k.probe} data-tone={note.tone} role="status">
      {note.text}
    </p>
  );
}

/**
 * Waiting for Nextcloud (CX-11): the login is open in another tab; Whombat asks every `pollEveryMs` until Nextcloud hands
 * over the app password, the flow expires (at most 10 minutes) or fails.
 */
export function NextcloudWait({
  burrow,
  entry,
  login,
  access = 'manage',
  onConnected,
  onCancel,
  onFailed,
}: {
  burrow: string;
  entry: CatalogEntry;
  login: StartNextcloudLoginResponse;
  /** The level asked on the connect form (CT-314): the login connects at Manage, then is set to Look only. */
  access?: ConnectionAccessLevel;
  /** Connected: by default the toast and the connection's page. */
  onConnected?: (connection: Pick<ConnectionView, 'id' | 'label'>) => void;
  onCancel: () => void;
  onFailed: (message: string) => void;
}) {
  const toast = useToast();
  const poll = useConnectionWrite(api.connections.pollNextcloud, burrow);
  const update = useConnectionWrite(api.connections.update, burrow);
  const setLevel = useRef(update.mutateAsync);
  setLevel.current = update.mutateAsync;
  const level = useRef(access);
  level.current = access;
  const [now, setNow] = useState(() => Date.now());
  const ends = nextcloudEnds(login, Date.now());
  const mutate = useRef(poll.mutateAsync);
  mutate.current = poll.mutateAsync;
  const open = useOpenConnection();
  const done = useRef({ onFailed, onConnected, toast, open });
  done.current = { onFailed, onConnected, toast, open };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      setNow(Date.now());
      if (Date.now() >= ends) {
        done.current.onFailed(NEXTCLOUD_WAIT_TEXT.tooLong);
        return;
      }
      try {
        const result = await mutate.current({ params: { flowId: login.flowId } });
        if (stopped || result.status !== 'ok') return;
        const step = nextcloudPollStep(result.data);
        if (step.kind === 'connected') {
          const c = step.connection;
          if (level.current === 'read' && c.access !== 'read')
            await setLevel
              .current({ params: { burrow, connectionId: c.id }, body: { access: 'read' } })
              .catch(() => undefined);
          if (done.current.onConnected) done.current.onConnected(c);
          else {
            done.current.toast.show(`${c.label} connected.`);
            done.current.open(entry.id, c.id);
          }
          return;
        }
        if (step.kind === 'failed') return done.current.onFailed(step.message);
      } catch (err) {
        if (!stopped) return done.current.onFailed(connectProblem(err).message ?? NEXTCLOUD_WAIT_TEXT.failed);
      }
      timer = setTimeout(() => void tick(), login.pollEveryMs);
    };
    timer = setTimeout(() => void tick(), login.pollEveryMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [login, ends, entry.id, burrow]);

  return (
    <div className={c.block} role="status" aria-live="polite">
      <div className={c.head}>
        <span className={k.spinner} aria-hidden="true" />
        <span className={c.main}>
          <span className={c.name}>{NEXTCLOUD_WAIT_TEXT.title}</span>
          <span className={c.meta}>
            {NEXTCLOUD_WAIT_TEXT.web} · {minutesLeftText(ends, now)}
          </span>
        </span>
      </div>
      <div className={c.formActions}>
        <ExternalLink href={login.loginUrl}>{NEXTCLOUD_WAIT_TEXT.open}</ExternalLink>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {NEXTCLOUD_WAIT_TEXT.cancel}
        </Button>
      </div>
    </div>
  );
}

/** A sign-in on the service's own page that started: what the start answered, and the tab it opened (when it could). */
export interface ServiceLoginStarted {
  login: StartServiceLoginResponse;
  tab: Window | null;
}

/**
 * Opens a tab while the click still counts (a tab opened after an await is blocked), so it can be pointed at the service
 * once the start answers; the tab doesn't keep a hold on this page (`opener` null).
 */
export function openLoginTab(): Window | null {
  return window.open('about:blank', '_blank');
}

/** Points the tab opened in the click at the service's page; null when the browser blocked it (the wait links there). */
export function pointLoginTab(tab: Window | null, url: string): Window | null {
  if (!tab) return null;
  try {
    tab.opener = null;
    tab.location.href = url;
    return tab;
  } catch {
    return null;
  }
}

/** How long after the last change to the form a sign-in is started again. */
const PREPARE_AFTER_MS = 500;
/** A sign-in started ahead is started again this long before it runs out, at most `PREPARE_RENEWALS` times. */
const PREPARE_RENEW_BEFORE_MS = 60_000;
const PREPARE_RENEWALS = 5;
/** One that runs out sooner than this isn't handed over: the click starts a fresh one. */
const PREPARE_LEFT_MIN_MS = 30_000;

/**
 * A sign-in on the service's own page, started before the click (Whombat docs/decisions/connection-signin.md): the
 * click then opens the service's page itself, which every browser does, a Whombat installed as an app too, where a tab
 * opened first and sent to the page later can stay blank. `body` is what the start takes, null while the form isn't
 * ready for it; when it changes the sign-in is started again a moment after the last change, and again before it runs
 * out. A start that fails says nothing here: the click then starts it the usual way and shows why.
 */
export function usePreparedServiceLogin(burrow: string, body: StartServiceLoginBody | null) {
  const start = useConnectionWrite(api.connections.startServiceLogin, burrow);
  const key = body ? JSON.stringify(body) : null;
  const [prepared, setPrepared] = useState<{ key: string; login: StartServiceLoginResponse } | null>(null);
  const mutate = useRef(start.mutateAsync);
  mutate.current = start.mutateAsync;

  useEffect(() => {
    if (!key) return;
    let stopped = false;
    let renewals = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (stopped) return;
      try {
        const result = await mutate.current({ params: { burrow }, body: JSON.parse(key) });
        if (stopped || result.status !== 'ok') return;
        setPrepared({ key, login: result.data });
        const renewIn = Date.parse(result.data.expiresAt) - Date.now() - PREPARE_RENEW_BEFORE_MS;
        if (renewals++ < PREPARE_RENEWALS && renewIn > 0) timer = setTimeout(() => void run(), renewIn);
      } catch {
        // The click starts it then and says what is wrong.
      }
    };
    timer = setTimeout(() => void run(), PREPARE_AFTER_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [burrow, key]);

  /** The sign-in started for exactly `current`, handed over once; null when there is none. */
  function take(current: StartServiceLoginBody): StartServiceLoginResponse | null {
    if (!prepared || prepared.key !== JSON.stringify(current)) return null;
    if (Date.parse(prepared.login.expiresAt) - Date.now() < PREPARE_LEFT_MIN_MS) return null;
    setPrepared(null);
    return prepared.login;
  }
  return { take };
}

/** Opens the service's page in the click itself, not holding on to it. */
export function openLoginPage(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/** Closes the service's tab once Whombat holds the token (SG-04: no `forwardUrl`, the form closes it itself). */
export function closeLoginTab(tab: Window | null) {
  try {
    if (tab && !tab.closed) tab.close();
  } catch {
    // A tab the page can no longer reach stays open; the person closes it.
  }
}

/**
 * Waiting for the service's own page (SG-01, SG-05; AP-3911): the sign-in is open in another tab; Whombat asks every
 * `pollEveryMs` until the service hands over the token (the server checks it and saves it at the level asked), the flow
 * expires (at most 10 minutes) or fails. Connected, it closes that tab. Words and look are Nextcloud's, with the code to
 * type there when the service gives one (`userCode`).
 */
export function ServiceLoginWait({
  burrow,
  entry,
  started,
  onConnected,
  onCancel,
  onFailed,
}: {
  burrow: string;
  entry: CatalogEntry;
  started: ServiceLoginStarted;
  /** Connected: by default the toast and the connection's page. */
  onConnected?: (connection: Pick<ConnectionView, 'id' | 'label'>) => void;
  onCancel: () => void;
  onFailed: (message: string) => void;
}) {
  const toast = useToast();
  const poll = useConnectionWrite(api.connections.pollServiceLogin, burrow);
  const { login, tab } = started;
  const [now, setNow] = useState(() => Date.now());
  const ends = serviceLoginEnds(login, Date.now());
  const mutate = useRef(poll.mutateAsync);
  mutate.current = poll.mutateAsync;
  const open = useOpenConnection();
  const done = useRef({ onFailed, onConnected, toast, open });
  done.current = { onFailed, onConnected, toast, open };
  const code = serviceLoginCode(login);
  const name = entry.name;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      setNow(Date.now());
      if (Date.now() >= ends) {
        done.current.onFailed(SERVICE_LOGIN_WAIT_TEXT.tooLong);
        return;
      }
      try {
        const result = await mutate.current({ params: { flowId: login.flowId } });
        if (stopped || result.status !== 'ok') return;
        const step = serviceLoginPollStep(result.data, name);
        if (step.kind === 'connected') {
          closeLoginTab(tab);
          const c = step.connection;
          if (done.current.onConnected) done.current.onConnected(c);
          else {
            done.current.toast.show(`${c.label} connected.`);
            done.current.open(entry.id, c.id);
          }
          return;
        }
        if (step.kind === 'failed') return done.current.onFailed(step.message);
      } catch (err) {
        if (!stopped)
          return done.current.onFailed(connectProblem(err).message ?? SERVICE_LOGIN_WAIT_TEXT.failed(name));
      }
      timer = setTimeout(() => void tick(), login.pollEveryMs);
    };
    timer = setTimeout(() => void tick(), login.pollEveryMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [login, tab, ends, entry.id, name]);

  return (
    <div className={c.block} role="status" aria-live="polite">
      <div className={c.head}>
        <span className={k.spinner} aria-hidden="true" />
        <span className={c.main}>
          <span className={c.name}>{SERVICE_LOGIN_WAIT_TEXT.title(name)}</span>
          <span className={c.meta}>
            {SERVICE_LOGIN_WAIT_TEXT.web} · {minutesLeftText(ends, now)}
          </span>
        </span>
      </div>
      {code && <p className={c.stepText}>{SERVICE_LOGIN_WAIT_TEXT.userCode(name)}</p>}
      {code && (
        <dl className={c.copyList}>
          <dt>{SERVICE_LOGIN_WAIT_TEXT.codeLabel}</dt>
          <dd>{code}</dd>
          <CopyButton text={code} copied={SERVICE_LOGIN_WAIT_TEXT.codeCopied} className={c.copyButton}>
            Copy<span className={c.srOnly}> code</span>
          </CopyButton>
        </dl>
      )}
      <div className={c.formActions}>
        <ExternalLink href={login.loginUrl}>{SERVICE_LOGIN_WAIT_TEXT.open(name)}</ExternalLink>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            closeLoginTab(tab);
            onCancel();
          }}
        >
          {SERVICE_LOGIN_WAIT_TEXT.cancel}
        </Button>
      </div>
    </div>
  );
}
