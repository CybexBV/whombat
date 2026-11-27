/**
 * The installer's reach step (Whombat LNK-12, ONE-12): how the owner will reach this Whombat, Easy (Whombat Link,
 * recommended, chosen at the start, with what it gives) or Expert (Tailscale or Headscale, with an optional login
 * server of their own and what it lacks). The words are Settings → This Whombat → Reach's. It comes before the checks,
 * so they try what the chosen way needs; Continue sends the choice with the checks (`POST /api/preflight`). Mouse and
 * keyboard: the arrow keys move between the two, Enter continues.
 */

import { type KeyboardEvent, useId, useState } from 'react';
import { useT } from '../i18n/react';
import type { InstallerState } from '../lib/api';
import type { Client } from '../lib/client';
import { installerCopy } from '../lib/copy';

import {
  loginServerValid,
  preflightRequest,
  type ReachWay,
  reachChoice,
  type Wizard,
} from '../lib/installer';
import { Button } from '../ui/Button';
import { Frame } from './Frame';
import styles from './installer.module.css';

export function ReachStep({
  state,
  client,
  refresh,
  kicker,
  meta,
  wizard,
  onChange,
  onBack,
  onNext,
}: {
  state: InstallerState;
  client: Client;
  refresh: () => void;
  kicker: string;
  meta: string;
  wizard: Wizard;
  onChange: (w: Partial<Pick<Wizard, 'reach' | 'loginServer'>>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useT();
  const T = installerCopy(t);

  const id = useId();
  // The address's problem shows once the person leaves the field or tries to continue, not while they type.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const ok = reachChoice(wizard) !== null;
  const bad = touched && !loginServerValid(wizard.loginServer);

  const next = async () => {
    setTouched(true);
    if (!ok || busy) return;
    setBusy(true);
    // The checks run again for this choice; a refusal (an install already running) leaves them as they were.
    await client.post('/api/preflight', preflightRequest(state, wizard)).catch(() => null);
    refresh();
    onNext();
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void next();
    }
  };
  const pick = (reach: ReachWay) => onChange({ reach });

  return (
    <Frame
      kicker={kicker}
      title={T.reachTitle}
      sub={T.reachSub}
      guide={{ say: T.reachSay }}
      meta={meta}
      actions={
        <>
          <Button kind="quiet" onClick={onBack}>
            {T.back}
          </Button>
          <span className={styles.grow} />
          <Button onClick={() => void next()} disabled={busy || (touched && !ok)}>
            {T.continue}
          </Button>
        </>
      }
    >
      <form
        className={styles.reach}
        onSubmit={(e) => {
          e.preventDefault();
          void next();
        }}
      >
        <fieldset>
          <legend className="visually-hidden">{T.reachTitle}</legend>
          <label className={styles.way}>
            <input
              type="radio"
              name="reach"
              value="link"
              checked={wizard.reach === 'link'}
              autoFocus={wizard.reach === 'link'}
              aria-labelledby={`${id}-link-level ${id}-link`}
              aria-describedby={`${id}-link-price ${id}-link-points`}
              onChange={() => pick('link')}
              onKeyDown={enter}
            />
            <span className={styles.wayHead}>
              <span id={`${id}-link-level`} className={styles.wayLevel}>
                {T.reachEasy}
              </span>
              <span id={`${id}-link`} className={styles.wayName}>
                {T.reachLink}
              </span>
            </span>
            <span className={`${styles.wayTag} ${styles.recommended}`}>{T.reachRecommended}</span>
            <span id={`${id}-link-price`} className={styles.wayLine}>
              {T.reachLinkPrice}
            </span>
            <span id={`${id}-link-points`} className={styles.wayPoints}>
              {T.reachLinkPoints.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </span>
          </label>
          <label className={styles.way}>
            <input
              type="radio"
              name="reach"
              value="tailscale"
              checked={wizard.reach === 'tailscale'}
              autoFocus={wizard.reach === 'tailscale'}
              aria-labelledby={`${id}-tailscale-level ${id}-tailscale`}
              aria-describedby={`${id}-tailscale-note ${id}-tailscale-points`}
              onChange={() => pick('tailscale')}
              onKeyDown={enter}
            />
            <span className={styles.wayHead}>
              <span id={`${id}-tailscale-level`} className={styles.wayLevel}>
                {T.reachExpert}
              </span>
              <span id={`${id}-tailscale`} className={styles.wayName}>
                {T.reachTailscale}
              </span>
            </span>
            <span className={styles.wayTag}>{T.reachFree}</span>
            <span id={`${id}-tailscale-note`} className={styles.wayLine}>
              {T.reachTailscaleNote}
            </span>
            <span id={`${id}-tailscale-points`} className={`${styles.wayPoints} ${styles.lacks}`}>
              {T.reachTailscalePoints.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </span>
          </label>
        </fieldset>
        {wizard.reach === 'tailscale' && (
          <div className={styles.loginServer}>
            <label htmlFor={`${id}-login`} className={styles.label}>
              {T.reachLoginServer}
            </label>
            <input
              id={`${id}-login`}
              className={styles.loginInput}
              value={wizard.loginServer}
              onChange={(e) => onChange({ loginServer: e.target.value.slice(0, 300) })}
              onBlur={() => setTouched(wizard.loginServer.trim() !== '')}
              onKeyDown={enter}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="https://"
              aria-invalid={bad || undefined}
              aria-describedby={`${id}-login-hint`}
              disabled={busy}
            />
            <p
              id={`${id}-login-hint`}
              className={`${styles.hint} ${bad ? styles.warn : ''}`}
              role={bad ? 'alert' : undefined}
            >
              {bad ? T.reachLoginServerBad : T.reachLoginServerHint}
            </p>
          </div>
        )}
      </form>
    </Frame>
  );
}
