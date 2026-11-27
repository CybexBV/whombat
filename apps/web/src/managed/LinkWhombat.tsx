/**
 * “Link a Whombat” at app.whombat.com (Whombat own-address.md; design §7.1, §7.5): the person agrees to the Whombat terms, the account shows a one-time code with its countdown, and they type it
 * at their Whombat's own address, which asks “Link to <email>?” itself. The account passkey is offered alongside, with
 * the words that say it doesn't open the Whombat (this page is only ever about Whombats set up at their own address).
 */
import {
  APPLIANCE_TERMS_VERSION,
  type ControlApi,
  ControlError,
  createAccountPasskey,
  linkCodeTimeLeft,
  OWN_ADDRESS_TEXT,
  PasskeyCancelled,
  type PasskeyPlatform,
  PRIVACY_PAGE_PATH,
  passkeyErrorOf,
  type WhombatLinkCode,
} from '@whombat/client/managed';
import { useEffect, useState } from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { SectionLabel } from '../components/SectionLabel';
import { COPY } from '../i18n/managed';
import { browserLabel } from './keys';
import styles from './managed.module.css';
import { ErrorLine, TermsCheck } from './screens';

const T = OWN_ADDRESS_TEXT.hosted;

export function LinkWhombatScreen({
  control,
  orgId,
  platform,
  onBack,
  now = () => Date.now(),
}: {
  control: Pick<ControlApi, 'createWhombatLink' | 'passkeyRegisterOptions' | 'passkeyRegisterVerify'>;
  orgId: string;
  /** This browser's passkeys, or null where it has none. */
  platform: Pick<PasskeyPlatform, 'create'> | null;
  onBack: () => void;
  now?: () => number;
}) {
  const [agreed, setAgreed] = useState(false);
  const [link, setLink] = useState<WhombatLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  // The countdown, once a second while a code shows.
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [link]);

  const make = async () => {
    if (!control.createWhombatLink) return setError(T.errors.failed);
    setBusy(true);
    setError(null);
    try {
      setLink(await control.createWhombatLink(orgId, { version: APPLIANCE_TERMS_VERSION }));
    } catch (e) {
      const code = e instanceof ControlError ? e.code : null;
      setError(
        code === 'terms_required'
          ? T.errors.terms
          : code === 'rate_limited'
            ? T.errors.rateLimited
            : T.errors.failed,
      );
    } finally {
      setBusy(false);
    }
  };

  const left = link ? linkCodeTimeLeft(link.expiresAt, now()) : null;
  return (
    <AuthLayout
      kicker={COPY.appliances.kicker}
      title={T.linkTitle}
      sub={T.linkSub}
      tip={OWN_ADDRESS_TEXT.link.tip}
    >
      <div className={styles.form}>
        {link ? (
          <div data-link-code="">
            <SectionLabel>{OWN_ADDRESS_TEXT.link.label}</SectionLabel>
            <p className={styles.code} data-testid="whombat-link-code" aria-live="polite">
              {left ? link.code : '—'}
            </p>
            <p className={styles.hint} role="status">
              {left ? T.left(left) : T.over}
            </p>
          </div>
        ) : (
          <TermsCheck checked={agreed} onChange={setAgreed} />
        )}
        <ErrorLine text={error} />
        <div className={styles.actions}>
          {link && left ? (
            <Button variant="primary" size="lg" onClick={onBack}>
              {T.done}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              disabled={busy || (!link && !agreed)}
              onClick={() => void make()}
            >
              {busy ? T.making : link ? T.again : T.linkEntry}
            </Button>
          )}
          {link && left ? null : (
            <Button variant="link" onClick={onBack}>
              {COPY.connection.back}
            </Button>
          )}
        </div>
        {platform ? <AccountPasskey control={control} platform={platform} /> : null}
      </div>
    </AuthLayout>
  );
}

/** The account passkey, offered alongside the code (design §7.1), with its words (§7.5, verbatim). */
function AccountPasskey({
  control,
  platform,
}: {
  control: Pick<ControlApi, 'passkeyRegisterOptions' | 'passkeyRegisterVerify'>;
  platform: Pick<PasskeyPlatform, 'create'>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setNote(null);
    try {
      await createAccountPasskey({ control, platform, name: browserLabel() });
      setNote(T.accountPasskeyMade);
    } catch (e) {
      if (e instanceof PasskeyCancelled) return;
      setNote(passkeyErrorOf(e) === 'exists' ? T.accountPasskeyExists : T.errors.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.card} data-account-passkey="">
      <div className={styles.row}>
        <span className={styles.rowMain}>
          <span className={styles.rowMeta} data-own-words="">
            <span>
              {T.accountPasskeyWords}{' '}
              <a href={PRIVACY_PAGE_PATH} target="_blank" rel="noopener">
                {T.why}
              </a>
            </span>
          </span>
          {note ? (
            <span className={styles.rowMeta} role="status">
              {note}
            </span>
          ) : null}
        </span>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void make()}>
          {busy ? T.accountPasskeyMaking : T.accountPasskey}
        </Button>
      </div>
    </div>
  );
}
