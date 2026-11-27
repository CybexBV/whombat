/**
 * The installer's Wi-Fi step (HD-08; CG-120…CG-124): after the checks, on a machine whose cable has no address — the
 * same list, password and keyboard as the box's screen (wifi/parts.tsx), joined to prove the password works; the
 * checks then run again over it, and the install copies the network into the system. *Skip* stays possible.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/react';
import type { InstallerState } from '../lib/api';
import type { Client } from '../lib/client';
import { installerCopy } from '../lib/copy';
import { deskErrorCode } from '../lib/desk';
import {
  type InstallerWifi,
  needsPassword,
  parseInstallerWifi,
  passphraseValid,
  ssidValid,
  type WifiNetwork,
} from '../lib/network';
import { failureText, nameProblem, refusalText, wifiCopy } from '../lib/wifiCopy';
import { Button } from '../ui/Button';
import { Bars, Icon } from '../wifi/icons';
import { type ListState, NetworkList, SecurityChoice, TypedField } from '../wifi/parts';
import type { SheetInitial } from '../wifi/WifiSheet';
import wifiStyles from '../wifi/wifi.module.css';
import { Frame } from './Frame';
import styles from './installer.module.css';

type Sub = { kind: 'list' } | { kind: 'password'; ssid: string; hidden: boolean } | { kind: 'other' };

export function WifiStep({
  state,
  client,
  refresh,
  kicker,
  meta,
  onBack,
  onNext,
  initial,
}: {
  state: InstallerState;
  client: Client;
  refresh: () => void;
  kicker: string;
  meta: string;
  onBack: () => void;
  onNext: () => void;
  initial?: SheetInitial;
}) {
  const t = useT();
  const WIFI = wifiCopy(t);
  const W = WIFI.installer;

  const T = installerCopy(t);

  const [wifi, setWifi] = useState<InstallerWifi | null>(null);
  const [listState, setListState] = useState<ListState>('looking');
  const first = initial?.step;
  const [sub, setSub] = useState<Sub>(
    first?.kind === 'password' || first?.kind === 'other' ? first : { kind: 'list' },
  );
  const [password, setPassword] = useState(initial?.password ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [security, setSecurity] = useState<'psk' | 'open'>('psk');
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  const [joining, setJoining] = useState(false);

  const look = useCallback(async () => {
    setListState('looking');
    const res = await client.post('/api/wifi/scan', {}).catch(() => null);
    const v = res?.status === 200 ? parseInstallerWifi(res.body) : null;
    if (v) setWifi(v);
    setListState(v ? 'ready' : 'failed');
  }, [client]);

  useEffect(() => {
    void (async () => {
      const res = await client.get('/api/wifi').catch(() => null);
      const v = res?.status === 200 ? parseInstallerWifi(res.body) : null;
      if (v) setWifi(v);
      if (v?.adapter) void look();
      else setListState('ready');
    })();
  }, [client, look]);

  const join = async (ssid: string, passphrase: string | null, hidden: boolean) => {
    setJoining(true);
    setError(null);
    const res = await client
      .post('/api/wifi/join', {
        ssid,
        ...(passphrase === null ? {} : { passphrase }),
        ...(hidden ? { hidden: true } : {}),
      })
      .catch(() => null);
    setJoining(false);
    const b = (res?.body ?? null) as { connected?: unknown; failure?: unknown } | null;
    if (res?.status === 200 && b?.connected === true) {
      setWifi((w) => (w ? { ...w, connected: ssid } : w));
      setSub({ kind: 'list' });
      setPassword('');
      refresh();
      void look();
      return;
    }
    if (res?.status === 200 && typeof b?.failure === 'string') {
      const f = b.failure as Parameters<typeof failureText>[0];
      setError(failureText(f, ssid, t));
      if (f !== 'wrong_password') setSub({ kind: 'list' });
      return;
    }
    setError(refusalText(res ? deskErrorCode(res.body) : null, t));
  };

  const pick = (n: WifiNetwork) => {
    setError(null);
    if (needsPassword(n)) {
      setPassword('');
      setSub({ kind: 'password', ssid: n.ssid, hidden: false });
    } else void join(n.ssid, null, false);
  };

  const connected = wifi?.connected ?? null;
  const checking = state.preflight.status === 'running';
  const missing = wifi && !wifi.adapter ? (wifi.wifiMissing ?? 'no_adapter') : null;

  let body: ReactNode;
  let actions: ReactNode;
  if (sub.kind === 'password') {
    const ok = passphraseValid(password) && !joining;
    const submit = () => ok && void join(sub.ssid, password, sub.hidden);
    body = (
      <div className={wifiStyles.step}>
        <p className={wifiStyles.chosen}>
          <Bars signal={wifi?.networks.find((n) => n.ssid === sub.ssid)?.signal ?? 4} />
          {WIFI.joinTitle(sub.ssid)}
        </p>
        <TypedField
          label={WIFI.password}
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          secret
          max={64}
          error={error}
          disabled={joining}
          onEnter={submit}
          initiallyShown={initial?.shown}
        />
      </div>
    );
    actions = (
      <>
        <Button
          kind="quiet"
          onClick={() => {
            setSub({ kind: 'list' });
            setError(null);
          }}
        >
          {T.back}
        </Button>
        <span className={styles.grow} />
        <Button onClick={submit} disabled={!ok}>
          {joining ? WIFI.joining : WIFI.join}
        </Button>
      </>
    );
  } else if (sub.kind === 'other') {
    const problem = name ? nameProblem(name, ssidValid, t) : null;
    const ok = name.trim() !== '' && !problem && !joining;
    const next = () => {
      if (!ok) return;
      if (security === 'psk') {
        setPassword('');
        setSub({ kind: 'password', ssid: name, hidden: true });
      } else void join(name, null, true);
    };
    body = (
      <div className={wifiStyles.step}>
        <p className={wifiStyles.note}>{WIFI.otherLead}</p>
        <TypedField
          label={WIFI.name}
          value={name}
          onChange={(v) => {
            setName(v);
            setError(null);
          }}
          max={32}
          error={error ?? (problem && problem !== WIFI.problems.name ? problem : null)}
          disabled={joining}
          onEnter={next}
        />
        <SecurityChoice value={security} onChange={setSecurity} />
      </div>
    );
    actions = (
      <>
        <Button
          kind="quiet"
          onClick={() => {
            setSub({ kind: 'list' });
            setError(null);
          }}
        >
          {T.back}
        </Button>
        <span className={styles.grow} />
        <Button onClick={next} disabled={!ok}>
          {security === 'psk' ? WIFI.password : joining ? WIFI.joining : WIFI.join}
        </Button>
      </>
    );
  } else {
    body = (
      <div className={wifiStyles.step}>
        {missing ? (
          <p className={`${styles.summary} ${styles.warn}`}>{W.missing[missing]}</p>
        ) : (
          <>
            {connected && (
              <p className={wifiStyles.joined} role="status">
                <Icon name="check" />
                {W.joined(connected)}
              </p>
            )}
            <div className={wifiStyles.listHead}>
              <span className={wifiStyles.kicker}>{WIFI.nearby}</span>
              <Button kind="quiet" onClick={() => void look()} disabled={listState === 'looking' || joining}>
                {WIFI.again}
              </Button>
            </div>
            <NetworkList
              networks={wifi?.networks ?? []}
              state={listState}
              onPick={joining ? null : pick}
              tall
            />
          </>
        )}
        {error && (
          <p className={`${styles.summary} ${styles.fail}`} role="alert">
            {error}
          </p>
        )}
      </div>
    );
    actions = (
      <>
        <Button kind="quiet" onClick={onBack}>
          {T.back}
        </Button>
        {(joining || (connected && checking)) && (
          <p className={styles.summary} role="status">
            {joining ? WIFI.joining : W.checking}
          </p>
        )}
        <span className={styles.grow} />
        {!missing && (
          <Button
            kind="secondary"
            onClick={() => {
              setName('');
              setError(null);
              setSub({ kind: 'other' });
            }}
            disabled={joining}
          >
            {WIFI.other}
          </Button>
        )}
        <Button autoFocus onClick={onNext} disabled={joining || (connected !== null && checking)}>
          {connected ? T.continue : W.skip}
        </Button>
      </>
    );
  }

  return (
    <Frame
      kicker={kicker}
      title={W.title}
      sub={W.sub}
      guide={{ say: connected ? W.joinedSay : W.say }}
      meta={meta}
      actions={actions}
    >
      {body}
    </Frame>
  );
}
