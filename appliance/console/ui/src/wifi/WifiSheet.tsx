/**
 * The Wi-Fi sheet on the box's screen (HD-07, HD-09, HD-11; CG-104…CG-109): how the box is connected, the networks
 * around it, a password typed with the screen's keyboard, a network that doesn't show its name, Forget, and a join or
 * a forget followed until it ends. Whombat decides whether the screen may change the Wi-Fi now (`mayChange`); when it
 * may not, the sheet shows the same list read-only and says how to change it. The console server's `/api/network…`
 * ask the runtime (§2.6).
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import deskStyles from '../desk/desk.module.css';
import { useT } from '../i18n/react';
import type { Client } from '../lib/client';
import { deskErrorCode } from '../lib/desk';
import {
  changeRunning,
  connectedVia,
  mayForget,
  NETWORK_POLL_MS,
  type NetworkAnswer,
  type NetworkChange,
  needsPassword,
  parseChange,
  parseNetworkAnswer,
  parseScan,
  passphraseValid,
  SHEET_IDLE_MS,
  ssidValid,
  type WifiNetwork,
} from '../lib/network';
import { changeView, connectionLine, nameProblem, refusalText, wifiCopy } from '../lib/wifiCopy';
import { useHoldFocus, useLastInput, useNow } from '../ui/hooks';
import { Bars, Icon } from './icons';
import { type ListState, NetworkList, Outcome, SecurityChoice, TypedField } from './parts';
import styles from './wifi.module.css';

export type SheetStep =
  | { kind: 'list' }
  | { kind: 'password'; ssid: string; hidden: boolean }
  | { kind: 'other' }
  | { kind: 'forget'; ssid: string; secured: boolean }
  /** A join or a forget Whombat runs, followed by its id. */
  | { kind: 'change'; id: string; ssid: string; hidden: boolean };

/** Fixtures only: where the sheet starts. */
export interface SheetInitial {
  step?: SheetStep;
  password?: string;
  name?: string;
  shown?: boolean;
  error?: string;
}

const PASSWORD_MAX = 64;
const NAME_MAX = 32;

export function WifiSheet({
  client,
  onClose,
  initial,
}: {
  client: Client;
  onClose: () => void;
  initial?: SheetInitial;
}) {
  const t = useT();
  const WIFI = wifiCopy(t);

  const [answer, setAnswer] = useState<NetworkAnswer | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [scan, setScan] = useState<WifiNetwork[]>([]);
  const [listState, setListState] = useState<ListState>('looking');
  const [step, setStep] = useState<SheetStep>(initial?.step ?? { kind: 'list' });
  const [password, setPassword] = useState(initial?.password ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [security, setSecurity] = useState<'psk' | 'open'>('psk');
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const [busy, setBusy] = useState(false);
  const [followed, setFollowed] = useState<NetworkChange | null>(null);
  const card = useRef<HTMLElement>(null);
  useHoldFocus(card);

  const load = useCallback(async () => {
    const res = await client.get('/api/network').catch(() => null);
    const a = res?.status === 200 ? parseNetworkAnswer(res.body) : null;
    setUnreadable(!a);
    if (a) setAnswer(a);
    return a;
  }, [client]);

  const look = useCallback(async () => {
    setListState('looking');
    const res = await client.post('/api/network/wifi/scan', {}).catch(() => null);
    const s = res?.status === 200 ? parseScan(res.body) : null;
    if (s) setScan(s.networks);
    setListState(s ? 'ready' : 'failed');
  }, [client]);

  // The network every 2 s while the sheet is open (the console server keeps it as long); one scan on opening.
  useEffect(() => {
    void load();
    void look();
    const t = setInterval(() => void load(), NETWORK_POLL_MS);
    return () => clearInterval(t);
  }, [load, look]);

  // The change this sheet started, as Whombat reports it.
  const changeId = step.kind === 'change' ? step.id : null;
  useEffect(() => {
    const c = answer?.network.change;
    if (changeId && c?.id === changeId) setFollowed(c);
  }, [answer, changeId]);
  // A wrong password goes back to the password, saying so (the typed one stays, to fix a typo).
  useEffect(() => {
    if (step.kind !== 'change' || !followed || followed.id !== step.id) return;
    if (followed.phase === 'failed' && followed.failure === 'wrong_password') {
      setStep({ kind: 'password', ssid: step.ssid, hidden: step.hidden });
      setError(changeView(followed, t).line);
      setFollowed(null);
    }
  }, [followed, step, t]);

  // Untouched for 2 minutes the sheet closes, unless a change runs (CG-108).
  const now = useNow(1000);
  const lastInput = useLastInput();
  const running = step.kind === 'change' && (!followed || changeRunning(followed));
  useEffect(() => {
    if (!running && now - lastInput >= SHEET_IDLE_MS) onClose();
  }, [now, lastInput, running, onClose]);

  const may = answer?.mayChange ?? false;
  // Whombat said the screen may not change the Wi-Fi (or locked it meanwhile): back to the list, read-only.
  useEffect(() => {
    if (answer && !answer.mayChange && step.kind !== 'list' && step.kind !== 'change') {
      setStep({ kind: 'list' });
      setPassword('');
      setError(null);
    }
  }, [answer, step.kind]);

  const start = async (path: string, body: object, ssid: string, hidden: boolean) => {
    setBusy(true);
    setError(null);
    const res = await client.post(path, body).catch(() => null);
    setBusy(false);
    const c = res?.status === 200 ? parseChange((res.body as { change?: unknown } | null)?.change) : null;
    if (c) {
      setFollowed(c);
      setStep({ kind: 'change', id: c.id, ssid, hidden });
      void load();
      return;
    }
    const code = res ? deskErrorCode(res.body) : null;
    if (code === 'locked') {
      void load();
      setStep({ kind: 'list' });
      return;
    }
    setError(refusalText(code, t));
  };

  const join = (ssid: string, passphrase: string | null, hidden: boolean) =>
    void start(
      '/api/network/wifi/join',
      { ssid, ...(passphrase === null ? {} : { passphrase }), ...(hidden ? { hidden: true } : {}) },
      ssid,
      hidden,
    );

  const pick = (n: WifiNetwork) => {
    setError(null);
    if (needsPassword(n)) {
      setPassword('');
      setStep({ kind: 'password', ssid: n.ssid, hidden: false });
    } else join(n.ssid, null, false);
  };

  const back = () => {
    setError(null);
    setStep({ kind: 'list' });
  };

  const network = answer?.network ?? null;
  // A card that can't be used: the reason, Close.
  const missing = network && !network.wifi ? (network.wifiMissing ?? 'no_adapter') : null;

  let body: ReactNode;
  let buttons: ReactNode;
  const close = (
    <button type="button" className={deskStyles.btn} onClick={onClose}>
      {WIFI.close}
    </button>
  );

  if (step.kind === 'change') {
    const v = followed ? changeView(followed, t) : null;
    body = (
      <Outcome
        title={v?.title ?? (followed?.kind === 'forget' ? WIFI.forgetting : WIFI.joining)}
        line={v?.line ?? null}
        tone={v?.tone ?? 'mut'}
        running={v?.running ?? true}
      />
    );
    if (!v || v.running) buttons = close;
    else if (v.tone === 'ok')
      buttons = (
        <button
          type="button"
          className={`${deskStyles.btn} ${deskStyles.btnPrimary}`}
          autoFocus
          onClick={
            followed?.kind === 'forget'
              ? () => {
                  setStep({ kind: 'list' });
                  void look();
                }
              : onClose
          }
        >
          {WIFI.done}
        </button>
      );
    else
      buttons = (
        <>
          <button
            type="button"
            className={`${deskStyles.btn} ${deskStyles.btnPrimary}`}
            autoFocus
            onClick={() => {
              setStep({ kind: 'list' });
              void look();
            }}
          >
            {WIFI.tryAgain}
          </button>
          {close}
        </>
      );
  } else if (step.kind === 'password') {
    const problem = password && !passphraseValid(password) ? WIFI.problems.password : null;
    const ok = passphraseValid(password) && !busy;
    const submit = () => ok && join(step.ssid, password, step.hidden);
    body = (
      <>
        <Head kicker={WIFI.kicker} title={WIFI.joinTitle(step.ssid)} />
        <TypedField
          label={WIFI.password}
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          secret
          max={PASSWORD_MAX}
          error={error}
          disabled={busy}
          onEnter={submit}
          initiallyShown={initial?.shown}
        />
        {/* The guard undoes a join only when the box could reach Whombat before (HD-06). */}
        {(problem && password.length >= 8) || network?.online ? (
          <p className={styles.note}>{problem && password.length >= 8 ? problem : WIFI.guard}</p>
        ) : null}
      </>
    );
    buttons = (
      <>
        <button
          type="button"
          className={`${deskStyles.btn} ${deskStyles.btnPrimary}`}
          aria-disabled={!ok}
          data-busy={!ok || undefined}
          onClick={submit}
        >
          {busy ? WIFI.joining : WIFI.join}
        </button>
        <button type="button" className={deskStyles.btn} onClick={back}>
          {WIFI.back}
        </button>
      </>
    );
  } else if (step.kind === 'other') {
    const problem = name ? nameProblem(name, ssidValid, t) : null;
    const ok = name.trim() !== '' && !problem && !busy;
    const next = () => {
      if (!ok) return;
      if (security === 'psk') {
        setPassword('');
        setStep({ kind: 'password', ssid: name, hidden: true });
      } else join(name, null, true);
    };
    body = (
      <>
        <Head kicker={WIFI.kicker} title={WIFI.otherTitle} line={WIFI.otherLead} />
        <TypedField
          label={WIFI.name}
          value={name}
          onChange={(v) => {
            setName(v);
            setError(null);
          }}
          max={NAME_MAX}
          error={error ?? (problem && problem !== WIFI.problems.name ? problem : null)}
          disabled={busy}
          onEnter={next}
        />
        <SecurityChoice value={security} onChange={setSecurity} />
      </>
    );
    buttons = (
      <>
        <button
          type="button"
          className={`${deskStyles.btn} ${deskStyles.btnPrimary}`}
          aria-disabled={!ok}
          data-busy={!ok || undefined}
          onClick={next}
        >
          {security === 'psk' ? WIFI.password : busy ? WIFI.joining : WIFI.join}
        </button>
        <button type="button" className={deskStyles.btn} onClick={back}>
          {WIFI.back}
        </button>
      </>
    );
  } else if (step.kind === 'forget') {
    body = (
      <>
        <Head kicker={WIFI.kicker} title={WIFI.forgetTitle(step.ssid)} line={WIFI.forgetLead(step.secured)} />
        {error && <p className={styles.error}>{error}</p>}
      </>
    );
    buttons = (
      <>
        <button
          type="button"
          className={`${deskStyles.btn} ${deskStyles.btnPrimary}`}
          autoFocus
          aria-disabled={busy}
          data-busy={busy || undefined}
          onClick={() =>
            !busy && void start('/api/network/wifi/forget', { ssid: step.ssid }, step.ssid, false)
          }
        >
          {busy ? WIFI.forgetting : WIFI.forget}
        </button>
        <button type="button" className={deskStyles.btn} onClick={back}>
          {WIFI.cancel}
        </button>
      </>
    );
  } else {
    // The list: changeable, read-only (HD-07), or no card to use.
    const readOnly = network !== null && !may;
    body = (
      <>
        <Head
          kicker={WIFI.kicker}
          title={readOnly || missing ? WIFI.readOnlyTitle : WIFI.title}
          line={network ? connectionLine(network, t) : null}
          via={network ? network : null}
        />
        {unreadable && !network ? (
          <p className={styles.error}>{WIFI.unreadable}</p>
        ) : missing ? (
          <p className={styles.line}>{WIFI.missing[missing]}</p>
        ) : (
          <NetworkList
            networks={scan}
            state={listState}
            onPick={may && !busy ? pick : null}
            onForget={(n) => setStep({ kind: 'forget', ssid: n.ssid, secured: n.security !== 'open' })}
            mayForget={(n) => (network ? mayForget(network, n.ssid) : false)}
          />
        )}
        {error && <p className={styles.error}>{error}</p>}
        {readOnly && !missing && <p className={styles.note}>{WIFI.readOnly}</p>}
      </>
    );
    buttons = (
      <>
        {!missing && (
          <button
            type="button"
            className={deskStyles.btn}
            aria-disabled={listState === 'looking'}
            data-busy={listState === 'looking' || undefined}
            onClick={() => listState !== 'looking' && void look()}
          >
            <Icon name="again" />
            &nbsp;{WIFI.again}
          </button>
        )}
        {!missing && may && (
          <button
            type="button"
            className={deskStyles.btn}
            onClick={() => {
              setName('');
              setError(null);
              setStep({ kind: 'other' });
            }}
          >
            {WIFI.other}
          </button>
        )}
        <span className={styles.grow} />
        {close}
      </>
    );
  }

  return (
    // The sheet's own keys stay here: the desk's (Talk, the PIN pad) don't see them (CG-109).
    // biome-ignore lint/a11y/noStaticElementInteractions: catches bubbling keys and clicks, nothing of its own
    <div
      className={styles.layer}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={styles.scrim}
        aria-label={WIFI.close}
        tabIndex={-1}
        onClick={onClose}
      />
      <div className={styles.sheet}>
        <section
          ref={card}
          className={styles.card}
          role="dialog"
          aria-modal="true"
          aria-label={WIFI.readOnlyTitle}
          tabIndex={-1}
        >
          {body}
          <div className={styles.buttons}>{buttons}</div>
        </section>
      </div>
    </div>
  );
}

/** The sheet's head: the kicker, the title, the connection line with its icon. */
function Head({
  kicker,
  title,
  line,
  via,
}: {
  kicker: string;
  title: string;
  line?: string | null;
  via?: NetworkAnswer['network'] | null;
}) {
  const t = useT();
  const WIFI = wifiCopy(t);

  const icon = via ? viaIcon(via) : null;
  // Out of reach on a cable or a Wi-Fi network says so; with no network at all the line says it already.
  const offline = via !== null && via !== undefined && !via.online && connectedVia(via) !== 'none';
  return (
    <div className={styles.head}>
      <span className={styles.kicker}>{kicker}</span>
      <h2 className={styles.title}>{title}</h2>
      {line && (
        <p className={styles.line} data-tone={offline ? 'warn' : undefined}>
          {icon}
          {line}
          {offline && ` · ${WIFI.offline}`}
        </p>
      )}
    </div>
  );
}

function viaIcon(n: NetworkAnswer['network']) {
  if (n.wired.some((w) => w.connected)) return <Icon name="cable" />;
  if (n.wifi?.state === 'connected') return <Bars signal={n.wifi.signal ?? 4} />;
  return <Icon name="none" />;
}
