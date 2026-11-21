import { type ControlApi, parsePhoneSignInLink, platformName } from '@whombat/client/managed';
import { Check, CircleAlert, CircleCheck } from 'lucide-react';
import { type ReactNode, useCallback, useMemo } from 'react';
import { AuthLayout } from '../../app/auth/AuthLayout';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import { SectionLabel } from '../../components/SectionLabel';
import { MOBILE_TEXT, signInErrorText } from './copy';
import {
  type AndroidDownloadQuery,
  DownloadCard,
  type DownloadLoader,
  type DownloadState,
  useAndroidDownload,
} from './DownloadCard';
import { FingerprintConfirm, useFocusOnMount } from './FingerprintConfirm';
import styles from './mobile.module.css';
import { appLink } from './PhoneLinkPage';
import { countdown, type PhoneSignInState } from './phoneSignIn';
import { phoneSignInDeps } from './sources';
import { type PhoneSignInDeps, usePhoneSignIn } from './usePhoneSignIn';

export interface MobilePageProps {
  /** Signing a phone in by QR code (managed mode, signed in); null where the app signs in with email (self-hosted). */
  signIn: PhoneSignInDeps | null;
  /** The open Whombat's name, as the copy names it (“Burrow HQ”); null without one. */
  whombatName: string | null;
  loadDownload: DownloadLoader;
  /** The way back: into the burrow, or to the list of Whombats. */
  back: ReactNode;
  /** Once a phone is in: the way to Settings → Devices, where a phone is removed (only with a Whombat open). */
  devices?: ReactNode;
}

/**
 * `/mobile` where no Whombat is open (signed out, or signed in without one; AP-521): sign a phone in by scanning a QR
 * code and get the app, in the sign-in frame. With a Whombat open the same body is Settings → Phone app, inside the app
 * (`PhoneAppPanel`; settings-phone-link.md SPL-23). The page asks for the Android download once, so the steps can say
 * when there is none.
 */
export function MobilePage({ signIn, whombatName, loadDownload, back, devices }: MobilePageProps) {
  const t = MOBILE_TEXT;
  const download = useAndroidDownload(loadDownload);
  return (
    <AuthLayout
      kicker={t.kicker}
      title={t.title}
      sub={<PhoneAppSub qr={signIn !== null} />}
      tip={signIn ? t.tip : t.tipSelfHosted}
    >
      <PhoneAppBody signIn={signIn} whombatName={whombatName} download={download} devices={devices}>
        <div className={styles.back}>{back}</div>
      </PhoneAppBody>
    </AuthLayout>
  );
}

/** The line under the page's title: what the app is for, and on a phone's own screen getting it there first. */
export function PhoneAppSub({ qr }: { qr: boolean }) {
  const t = MOBILE_TEXT;
  if (!qr) return <>{t.subSelfHosted}</>;
  return (
    <>
      <span className={styles.wideOnly}>{t.sub}</span>
      <span className={styles.narrowOnly}>{t.subPhone}</span>
    </>
  );
}

/** The page's body, wherever it shows: the code and its steps (or the self-hosted note), then Get the app. */
export function PhoneAppBody({
  signIn,
  whombatName,
  download,
  devices,
  children,
}: {
  signIn: PhoneSignInDeps | null;
  whombatName: string | null;
  download: AndroidDownloadQuery;
  devices?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.stack}>
      {signIn ? (
        <PhoneSignIn deps={signIn} whombatName={whombatName} download={download.state} devices={devices} />
      ) : (
        <p className={styles.note}>{MOBILE_TEXT.selfHosted}</p>
      )}
      <DownloadCard download={download} className={styles.downloadFirst} />
      {children}
    </div>
  );
}

/**
 * `/mobile` signed in with no Whombat open (ManagedRoot, AP-521): the code names no Whombat, so it only signs the phone
 * in; the phone then asks a Whombat to let it in the usual way.
 */
export function AccountMobilePage({ control, onBack }: { control: ControlApi; onBack: () => void }) {
  const signIn = useMemo(() => phoneSignInDeps(control, null, null), [control]);
  const loadDownload = useCallback(() => control.androidDownload(), [control]);
  return (
    <MobilePage
      signIn={signIn}
      whombatName={null}
      loadDownload={loadDownload}
      back={
        <button type="button" onClick={onBack}>
          {MOBILE_TEXT.backToWhombats}
        </button>
      }
    />
  );
}

/**
 * The QR code and what happens after a phone scans it (`phoneSignIn.ts`). A fresh code's reason (a refused or declined
 * phone, a code that ran out) heads the card; an error takes the whole card, with no steps that need a code.
 */
export function PhoneSignIn({
  deps,
  whombatName,
  download = 'loading',
  devices,
}: {
  deps: PhoneSignInDeps;
  whombatName: string | null;
  download?: DownloadState;
  devices?: ReactNode;
}) {
  const { state, now, dispatch } = usePhoneSignIn(deps);
  const t = MOBILE_TEXT.signIn;
  const whombat = whombatName ?? 'your Whombat';
  const named = deps.appliance !== null;
  const notice =
    (state.step === 'starting' || state.step === 'waiting') && state.notice ? state.notice : null;
  const busy = state.step === 'scanned' || state.step === 'lookingUp';

  return (
    <section className={styles.section} aria-label={t.label}>
      <SectionLabel as="h2">{t.label}</SectionLabel>
      <p className={styles.srOnly} aria-live="polite" data-testid="phone-signin-live">
        {announcement(state, whombat)}
      </p>
      {state.step === 'waiting' && <OpenHere link={state.code.link} />}
      {state.step === 'confirm' ? (
        <FingerprintConfirm
          label={t.confirmLabel}
          title={t.confirmTitle(state.phone.label)}
          platform={platformName(state.phone.platform)}
          meta={t.confirmInto(whombat)}
          fingerprintLine={t.sameOnPhone}
          fingerprint={state.phone.fingerprint}
          hint={t.compare}
          note={state.note ? (t.decideNote[state.note] ?? null) : null}
          busy={state.busy !== null}
          approveLabel={state.busy === 'approve' ? t.lettingIn : t.letIn}
          declineLabel={t.notMine}
          onApprove={() => dispatch({ type: 'approve' })}
          onDecline={() => dispatch({ type: 'decline' })}
          testId="phone-confirm"
          fingerprintTestId="phone-confirm-fingerprint"
          platformTestId="phone-confirm-platform"
        />
      ) : state.step === 'success' ? (
        <Success
          state={state}
          whombat={named ? whombat : null}
          devices={named ? devices : undefined}
          onAgain={() => dispatch({ type: 'restart' })}
        />
      ) : state.step === 'error' ? (
        <div
          className={cx(styles.card, styles.signInArea, styles.errorCard)}
          data-testid="phone-signin"
          data-step="error"
          role="alert"
        >
          <span className={styles.errorIcon} aria-hidden="true">
            <Icon icon={CircleAlert} size={28} />
          </span>
          <h3 className={styles.confirmTitle}>{t.errorTitle}</h3>
          <p className={styles.successBody}>{signInErrorText(state.error)}</p>
          <Button variant="secondary" size="lg" onClick={() => dispatch({ type: 'restart' })}>
            {t.tryAgain}
          </Button>
        </div>
      ) : (
        <div className={cx(styles.card, styles.signInArea)} data-testid="phone-signin" data-step={state.step}>
          {notice && (
            <p className={cx(styles.cardNotice, notice === 'refused' && styles.cardNoticeBad)}>
              {notice === 'refused' && (
                <Icon icon={CircleAlert} size={16} className={styles.cardNoticeIcon} />
              )}
              <span>{t.notice[notice]}</span>
            </p>
          )}
          <div className={styles.signIn}>
            <div className={styles.qrColumn}>
              <QrSlot state={state} whombat={named ? whombat : null} />
              {state.step === 'waiting' && (
                <span className={styles.countdown} data-testid="phone-qr-countdown">
                  {t.refreshesIn(countdown(state.code.expiresAt, now))}
                </span>
              )}
            </div>
            <div className={styles.steps}>
              <h3 className={styles.cardTitle}>
                {busy ? (
                  t.titleBusy
                ) : (
                  <>
                    <span className={styles.wideOnly}>{t.title}</span>
                    <span className={styles.narrowOnly}>{t.titleOther}</span>
                  </>
                )}
              </h3>
              <ol className={styles.stepList}>
                {t.steps.map((s, i) => {
                  // Scanned: installing and scanning are done (their lines go, the code has); the last step becomes
                  // what is still to come, letting it in here.
                  const last = i === t.steps.length - 1;
                  const done = busy && !last;
                  const step = busy && last ? t.stepLetIn : s;
                  const body = done ? null : i === 0 && download === null ? t.installNone : step.body;
                  return (
                    <li key={s.title} className={cx(styles.step, done && styles.stepDone)}>
                      <span className={styles.stepDot} aria-hidden="true">
                        {done ? <Icon icon={Check} size={14} /> : i + 1}
                      </span>
                      <span className={styles.stepText}>
                        <span className={styles.stepTitle}>{step.title}</span>
                        {body && <span className={styles.stepBody}>{body}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p className={styles.into}>{named ? t.into(whombat) : t.intoNone}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * On a phone's own screen (narrow viewports): the same code opens the app on this phone, where there is nothing to
 * scan (AP-524). It comes before the code, which is for another phone. Hidden on wider screens by CSS.
 */
function OpenHere({ link }: { link: string }) {
  const parsed = parsePhoneSignInLink(link, [new URL(link).origin]);
  if (!parsed) return null;
  return (
    <div className={styles.openHere}>
      <span className={styles.openHereText}>{MOBILE_TEXT.signIn.onThisPhone}</span>
      <ButtonLink variant="secondary" size="xl" href={appLink(parsed)}>
        {MOBILE_TEXT.landing.open}
      </ButtonLink>
    </div>
  );
}

/** Where the QR code sits: the code, or what's happening instead of it (same place, same size). */
function QrSlot({
  state,
  whombat,
}: {
  state: Exclude<PhoneSignInState, { step: 'confirm' | 'success' | 'error' }>;
  whombat: string | null;
}) {
  const t = MOBILE_TEXT.signIn;
  if (state.step === 'waiting')
    return (
      <div className={styles.plate} data-testid="phone-qr" {...fakeLink(state.code.link)}>
        <QrCode value={state.code.link} size={QR_SIZE} label={t.qrLabel} />
      </div>
    );
  if (state.step === 'starting')
    return (
      <div className={styles.slot}>
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.slotMeta}>{t.making}</p>
      </div>
    );
  // Scanned, or checking the phone with the Whombat.
  return (
    <div className={cx(styles.slot, styles.slotScanned)}>
      <span className={styles.scannedIcon} aria-hidden="true">
        <Icon icon={CircleCheck} size={30} />
      </span>
      <p className={styles.slotTitle}>{t.scannedTitle}</p>
      <p className={styles.slotMeta}>
        <span className={styles.spinnerInline} aria-hidden="true" />
        {state.step === 'lookingUp' ? t.lookingUp : whombat ? t.scannedWaiting(whombat) : t.scannedSigningIn}
      </p>
    </div>
  );
}

function Success({
  state,
  whombat,
  devices,
  onAgain,
}: {
  state: Extract<PhoneSignInState, { step: 'success' }>;
  whombat: string | null;
  devices?: ReactNode;
  onAgain: () => void;
}) {
  const t = MOBILE_TEXT.signIn;
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className={cx(styles.card, styles.signInArea, styles.success)} data-testid="phone-success">
      <span className={styles.successIcon} aria-hidden="true">
        <Icon icon={Check} size={26} />
      </span>
      <div className={styles.successText}>
        <h3 className={styles.confirmTitle} ref={heading} tabIndex={-1}>
          {state.phone ? t.successTitle(state.phone.label) : t.doneTitle}
        </h3>
        <p className={styles.successBody}>
          {state.phone ? (
            <>
              <span className={styles.wideOnly}>{t.successBody(whombat ?? 'your Whombat')}</span>
              <span className={styles.narrowOnly}>{t.successBodyHere(whombat ?? 'your Whombat')}</span>
            </>
          ) : (
            t.doneBody(whombat)
          )}
        </p>
        <div className={cx(styles.actions, styles.successActions)}>
          {devices}
          <Button variant="secondary" size="lg" onClick={onAgain}>
            {t.another}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The largest the QR code gets (its modules snap to whole pixels below this). */
const QR_SIZE = 272;

/** What a screen reader hears when the state changes (the page's one live region). */
function announcement(state: PhoneSignInState, whombat: string): string {
  const t = MOBILE_TEXT.signIn;
  switch (state.step) {
    case 'waiting':
      return state.notice ? t.notice[state.notice] : '';
    case 'scanned':
      return `${t.scannedTitle}. ${t.scannedWaiting(whombat)}`;
    case 'lookingUp':
      return t.lookingUp;
    case 'confirm':
      return `${t.confirmTitle(state.phone.label)} ${t.sameOnPhone} ${state.phone.fingerprint}`;
    case 'success':
      return state.phone ? t.successTitle(state.phone.label) : t.doneTitle;
    default:
      return '';
  }
}

/**
 * Development and e2e only (the fake world, AP-527): the shown link on the QR code's element, so the fake phone can
 * “scan” it. Production builds never set it.
 */
function fakeLink(link: string): Record<string, string> {
  return import.meta.env.VITE_WHOMBAT_FAKE === '1' ? { 'data-phone-link': link } : {};
}
