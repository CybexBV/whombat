/**
 * The managed journeys outside an appliance (AP-22): cloud sign-in, the appliance list, claim (the letters on the
 * screen of a Whombat on this network, or its card; AP-47, AP-50), the recovery kit (save → confirm), pairing, the
 * box's own screen (BX-02, signin-at-box-web.md AP-3508) and recovery. Not in the mocks: they
 * follow the sign-in frame (`AuthLayout`, onboarding's language) with settings' bordered-row cards.
 */
import {
  type ApplianceSummary,
  accountOf,
  agoText,
  appliancesEmptyText,
  BACKUP_OPTIONS_TEXT,
  type ClaimCard,
  type ClaimRequest,
  COPY,
  type ControlApi,
  type ControlSession,
  type CreateOrgInput,
  confirmationSignature,
  createOrgErrorKey,
  createOrgForm,
  formatScreenLettersInput,
  isKitBackupGap,
  isRetired,
  KIT_BACKUP_TEXT,
  type KitBackup,
  type KitBackupGap,
  kitText,
  lettersRequestOf,
  listedAppliances,
  loadKitBackup,
  lockKitWithPasskey,
  modelLabel,
  type NearbyAppliance,
  newRecoveryKit,
  OWN_ADDRESS_TEXT,
  PASSKEY_COPY,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  parseClaimQr,
  passkeyErrorText,
  passkeyName,
  type RecoveryKit,
  readKitFile,
  recoverySecretFromKey,
  rotationSignature,
  type SavedKit,
  type ScreenSignInAsking,
  type ScreenSignInDeps,
  type ScreenSignInStep,
  SIGN_IN_NEW_TEXT,
  type SignupInfo,
  screenSignInRequest,
  screenSignInStart,
  screenSignInSubmit,
  setUpOnePasskey,
  signInErrorText,
  type WaitlistInput,
  WHOMBAT_LINK_TEXT,
  waitlistErrorText,
  whombatNameError,
} from '@whombat/client/managed';
import { type ApplianceSession, OperationError, sessionOps } from '@whombat/client/session';
import { formatSignupCode, normaliseSignupCode, type SignupMode } from '@whombat/control-contracts';
import { normalizeClaimSecret } from '@whombat/protocol/session';
import { ArrowRight } from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { Input } from '../components/Input';
import { SectionLabel } from '../components/SectionLabel';
import { StatusDot } from '../components/StatusDot';
import { SCREEN_MODE_TEXT } from '../features/screens/screenMode/model';
import { saveBlob } from '../lib/saveBlob';
import { KeepWayBack, type KitChoices, KitPrintSheet, startingKitChoices } from './KitScreen';
import { browserLabel } from './keys';
import { noteKitSaved } from './kitRecord';
import { LettersInput } from './LettersInput';
import styles from './managed.module.css';

export function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p className={styles.error} role="alert">
      {text}
    </p>
  ) : null;
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

/* Sign in ------------------------------------------------------------------------------------------------ */

/** A passkey sign-in (PK-04, passkeys.md AP-792): the page runs it; the screen only starts it and says what failed. */
export interface PasskeySignIn {
  /** Control's options made ready, so a click goes straight to the browser's prompt (Safari wants the gesture). */
  prepare(): void;
  /** The whole sign-in; rejects with what went wrong (`PasskeyCancelled`: say nothing). */
  signIn(request?: { conditional?: boolean; signal?: AbortSignal }): Promise<void>;
  /** The email field can offer passkeys in its autofill (conditional mediation). */
  conditional(): Promise<boolean>;
}

/** A failure of a passkey ceremony, said in the screen's error line; null when the person just closed the prompt. */
function passkeyFailureText(error: unknown): string | null {
  return error instanceof PasskeyCancelled ? null : passkeyErrorText(error);
}

export function SignInScreen({
  onSend,
  note,
  mode = 'open',
  held = false,
  onWaitlist,
  passkey,
  onLookAround,
  onAdd,
}: {
  onSend: (email: string) => Promise<void>;
  /** A line under the form (`/signup` with an invite code: it is kept, AP-125). */
  note?: string | null;
  /** The signup mode (`GET /v1/signup`): outside `open` only invited addresses get a link (BL-33). */
  mode?: SignupMode;
  /** An invite code is held and sent along: no invite-only notice. */
  held?: boolean;
  onWaitlist?: () => void;
  /** “Sign in with a passkey” and the email field's passkey autofill; absent where the browser has no WebAuthn. */
  passkey?: PasskeySignIn;
  /** “Look around without a Whombat”: the demo world (docs/app/decisions/look-around.md). */
  onLookAround?: () => void;
  /** Someone new starts with the code on their Whombat's screen; the account is made on the way. */
  onAdd?: () => void;
}) {
  const gated = mode !== 'open';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The autofill's pending request: a click on the button ends it first (one ceremony at a time). */
  const autofill = useRef<AbortController | null>(null);
  const passkeyRef = useRef(passkey);
  passkeyRef.current = passkey;
  const offered = !!passkey && !sent;
  useEffect(() => {
    const p = passkeyRef.current;
    if (!offered || !p) return;
    p.prepare();
    const abort = new AbortController();
    autofill.current = abort;
    void p.conditional().then((ok) => {
      if (!ok || abort.signal.aborted) return;
      p.signIn({ conditional: true, signal: abort.signal }).catch((e: unknown) => {
        if (!abort.signal.aborted) setError(passkeyFailureText(e));
      });
    });
    return () => abort.abort();
  }, [offered]);
  const withPasskey = async () => {
    if (!passkey) return;
    autofill.current?.abort();
    setError(null);
    setBusy(true);
    try {
      await passkey.signIn();
    } catch (e) {
      setError(passkeyFailureText(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(address);
      setSent(address);
    } catch (err) {
      setError(signInErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <AuthLayout
        kicker={COPY.signIn.kicker}
        title={COPY.signIn.sentTitle}
        sub={gated ? COPY.signIn.sentGated(sent) : COPY.signIn.sent(sent)}
        tip={COPY.signIn.tip}
      >
        <div className={styles.actions}>
          <Button variant="link" onClick={() => setSent(null)}>
            {COPY.signIn.again}
          </Button>
        </div>
      </AuthLayout>
    );
  return (
    <AuthLayout
      kicker={COPY.signIn.kicker}
      title={COPY.signIn.title}
      sub={
        !gated || held
          ? COPY.signIn.sub
          : mode === 'invite'
            ? COPY.signIn.inviteOnlySub
            : COPY.signIn.waitlistSub
      }
      tip={COPY.signIn.tip}
    >
      <form className={styles.form} onSubmit={submit}>
        <Field label={COPY.signIn.email}>
          {(id) => (
            <Input
              id={id}
              type="email"
              size="lg"
              // Passkeys in the field's autofill (conditional mediation) need the `webauthn` token, last.
              autoComplete={passkey ? 'username webauthn' : 'email'}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {COPY.signIn.send}
          </Button>
          {passkey && (
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              iconStart={<Icon name="key" size={16} />}
              onClick={() => void withPasskey()}
            >
              {PASSKEY_COPY.signIn}
            </Button>
          )}
          {mode === 'waitlist' && !held && onWaitlist && (
            <Button variant="link" onClick={onWaitlist}>
              {COPY.signIn.joinWaitlist}
            </Button>
          )}
        </div>
        {passkey && <p className={styles.hint}>{PASSKEY_COPY.signInHint}</p>}
        {note && <p className={styles.hint}>{note}</p>}
      </form>
      {onAdd && (
        <>
          <p className={styles.divider}>{SIGN_IN_NEW_TEXT.divider}</p>
          <div className={styles.newRow}>
            <span className={styles.newLine}>{SIGN_IN_NEW_TEXT.line}</span>
            <Button variant="link" onClick={onAdd} iconEnd={<Icon icon={ArrowRight} size={15} />}>
              {SIGN_IN_NEW_TEXT.add}
            </Button>
          </div>
        </>
      )}
      {onLookAround && (
        <div className={styles.actions}>
          <Button variant="link" onClick={onLookAround}>
            {COPY.lookAround.open}
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}

/** While a passkey signs in and opens the Whombat (PK-04): the sign-in frame, nothing to do. */
export function PasskeyProgressScreen({ opening }: { opening: { name: string | null } | null }) {
  return (
    <AuthLayout
      kicker={COPY.signIn.kicker}
      title={opening ? PASSKEY_COPY.opening(opening.name) : COPY.signIn.verifying}
      sub={opening ? PASSKEY_COPY.openingText : undefined}
      tip={COPY.signIn.tip}
    />
  );
}

/**
 * A passkey signed in but didn't let this device in (PK-04, PK-11): the Whombat needs an update or refused it. The
 * Whombat is pinned from the passkey, so setting this device up another way (pairing) can follow at once.
 */
export function PasskeyStopScreen({
  text,
  onOtherWay,
  onBack,
}: {
  text: string;
  onOtherWay: () => void;
  onBack: () => void;
}) {
  return (
    <ConnectionGate
      title={COPY.setup.title}
      text={text}
      actions={
        <>
          <Button variant="primary" size="lg" onClick={onOtherWay}>
            {PASSKEY_COPY.otherWay}
          </Button>
          <Button variant="secondary" size="lg" onClick={onBack}>
            {COPY.connection.back}
          </Button>
        </>
      }
    />
  );
}

export function VerifyScreen({ error }: { error: string | null }) {
  return (
    <AuthLayout
      kicker={COPY.signIn.kicker}
      title={error ? COPY.signIn.title : COPY.signIn.verifying}
      sub={error ?? undefined}
      tip={COPY.signIn.tip}
    />
  );
}

/**
 * An emailed invitation's link, signed out: one tap signs the invited address in. A tap rather than on
 * opening, so a mail scanner that opens links doesn't use the one-time link up. `onContinue` rejects only when control
 * couldn't be reached; a link control refuses goes back to the email sign-in.
 */
export function InvitationScreen({
  email,
  onContinue,
}: {
  email: string | null;
  onContinue: () => Promise<void>;
}) {
  const t = COPY.invite;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setError(null);
    onContinue().catch(() => {
      setBusy(false);
      setError(COPY.signIn.unreachable);
    });
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={COPY.signIn.tip}>
      <div className={styles.form}>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" disabled={busy} onClick={go}>
            {busy ? COPY.signIn.verifying : email ? t.continueAs(email) : t.continue}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

/** The invitation's link opened while someone else is signed in here: whose account to carry on with. */
export function InvitationOtherAccountScreen({
  invited,
  current,
  onSwitch,
  onStay,
}: {
  invited: string;
  current: string;
  onSwitch: () => Promise<void>;
  onStay: () => void;
}) {
  const t = COPY.invite;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setError(null);
    onSwitch().catch(() => {
      setBusy(false);
      setError(COPY.signIn.unreachable);
    });
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.otherTitle} sub={t.other(invited, current)} tip={COPY.signIn.tip}>
      <div className={styles.form}>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" disabled={busy} onClick={go}>
            {busy ? COPY.signIn.verifying : t.continueAs(invited)}
          </Button>
          <Button variant="secondary" size="lg" disabled={busy} onClick={onStay}>
            {t.stayAs(current)}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

/* First run: the organization (BL-21, AP-124) ------------------------------------------------------------------ */

/** A textarea in the inputs' language (`Input size="lg"`). */
function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(styles.textarea, props.className)} />;
}

/** The invite code as it's typed (BL-22): upper case, any spacing; normalised only when sent. */
function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={COPY.org.code} hint={COPY.org.codeHint}>
      {(id) => (
        <Input
          id={id}
          size="lg"
          className={cx(styles.mono, styles.codeInput)}
          placeholder={COPY.org.codePlaceholder}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
      )}
    </Field>
  );
}

/**
 * The organization, created by its account (BL-21): “Company name”, the unticked “I agree to the Whombat Subscription
 * Terms”, and the invite code when the signup mode needs one (prefilled from a `/signup#code=` link). In `waitlist`
 * mode without a code it is the waitlist, with “I have an invite code”; in `invite` mode it says so.
 */
export function CreateOrgScreen({
  info,
  heldCode,
  email,
  onCreate,
  onWaitlist,
}: {
  /** `signup.info`; null when this control has none (the plain form). */
  info: SignupInfo | null;
  /** The code a `/signup#code=` link brought, held since. */
  heldCode: string | null;
  /** The signed-in account's email (the waitlist uses it). */
  email: string;
  onCreate: (input: Omit<CreateOrgInput, 'terms'>) => Promise<void>;
  onWaitlist: (input: WaitlistInput) => Promise<void>;
}) {
  const t = COPY.org;
  const [name, setName] = useState('');
  const [code, setCode] = useState(() => (heldCode ? (formatSignupCode(heldCode) ?? heldCode) : ''));
  const [agreed, setAgreed] = useState(false);
  const [wantsCode, setWantsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = createOrgForm(info, { heldCode: heldCode !== null, wantsCode });
  if (form.waitlist)
    return (
      <WaitlistScreen
        info={info}
        email={email}
        onJoin={onWaitlist}
        onHaveCode={() => {
          setError(null);
          setWantsCode(true);
        }}
      />
    );
  const typedCode = form.showCode ? code.trim() : '';
  const ready = agreed && !!name.trim() && (!form.codeRequired || !!typedCode);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value || !ready) return;
    // Not a code at all (BL-22's alphabet): said here, without a try at control.
    if (typedCode && normaliseSignupCode(typedCode) === null) {
      setError(t.errors.signup_code_invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: value, code: typedCode ? formatSignupCode(typedCode) : null });
    } catch (err) {
      setError(t.errors[createOrgErrorKey(err)]);
      setBusy(false);
    }
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={form.inviteOnly ? t.inviteOnly : t.sub} tip={t.tip}>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <Field label={t.name}>
          {(id) => (
            <Input
              id={id}
              size="lg"
              required
              maxLength={80}
              autoComplete="organization"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {form.showCode && <CodeField value={code} onChange={setCode} />}
        <TermsCheck
          checked={agreed}
          onChange={setAgreed}
          agree={t.termsAgree}
          link={t.termsLink}
          href="/legal/subscription-terms"
        />
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !ready}>
            {busy ? t.creating : t.create}
          </Button>
          {info?.mode === 'waitlist' && wantsCode && heldCode === null && (
            <Button
              variant="link"
              onClick={() => {
                setError(null);
                setWantsCode(false);
              }}
            >
              {t.noCode}
            </Button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * The waitlist (BL-23, AP-127): on the create-org screen in `waitlist` mode, and public at `/waitlist`. Signed in, the
 * account's email is used; signed out, it's asked. Outside `waitlist` mode `/waitlist` says how to get in instead.
 */
export function WaitlistScreen({
  info,
  email,
  onJoin,
  onHaveCode,
  onStart,
}: {
  info: SignupInfo | null;
  /** The signed-in account's email; null asks for one. */
  email: string | null;
  onJoin: (input: WaitlistInput) => Promise<void>;
  /** “I have an invite code”. */
  onHaveCode?: () => void;
  /** “Get started” (to `/signup`) when there's no waitlist. */
  onStart?: () => void;
}) {
  const t = COPY.waitlist;
  const [typed, setTyped] = useState('');
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  if (info && info.mode !== 'waitlist' && !joined)
    return (
      <AuthLayout
        kicker={t.kicker}
        title={info.mode === 'open' ? t.openTitle : t.inviteTitle}
        sub={info.mode === 'open' ? t.open : t.invite}
        tip={t.tip}
      >
        {onStart && (
          <div className={styles.actions}>
            <Button variant="primary" size="lg" onClick={onStart}>
              {t.start}
            </Button>
          </div>
        )}
      </AuthLayout>
    );
  if (joined) return <AuthLayout kicker={t.kicker} title={t.doneTitle} sub={t.done(joined)} tip={t.tip} />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = (email ?? typed).trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await onJoin({ email: address, company, note });
      setJoined(address);
    } catch (err) {
      setError(waitlistErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        {email === null ? (
          <Field label={t.email}>
            {(id) => (
              <Input
                id={id}
                type="email"
                size="lg"
                autoComplete="email"
                required
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </Field>
        ) : (
          <Field label={t.email}>
            {(id) => <Input id={id} type="email" size="lg" readOnly value={email} />}
          </Field>
        )}
        <Field label={t.company} hint={t.optional}>
          {(id) => (
            <Input
              id={id}
              size="lg"
              autoComplete="organization"
              maxLength={120}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          )}
        </Field>
        <Field label={t.note} hint={t.optional}>
          {(id) => (
            <TextArea
              id={id}
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {busy ? t.joining : t.join}
          </Button>
          {onHaveCode && (
            <Button variant="link" onClick={onHaveCode}>
              {COPY.org.haveCode}
            </Button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}

/* Appliance list ------------------------------------------------------------------------------------------ */

export function AppliancesScreen({
  session,
  appliances,
  error,
  notice = null,
  onOpen,
  onPrepare,
  onClaim,
  onSignOut,
  canRecover,
  onRecover,
  remembers = () => false,
  onForget,
  onDeleteAccount,
  onBilling,
  planNeeded = false,
  onRename,
  onLinkWhombat,
  onLinkAccount,
}: {
  session: ControlSession;
  /** The organization's directory (retired Whombats included); null while it loads. */
  appliances: ApplianceSummary[] | null;
  error: string | null;
  /** Why the list opened in place of a Whombat (AP-694): “Burrow HQ was retired. …”. */
  notice?: string | null;
  onOpen: (a: ApplianceSummary) => void;
  /** Prepare a trusted connection when the Open button is pointed at or focused. */
  onPrepare?: (a: ApplianceSummary) => void;
  onClaim: () => void;
  onSignOut: () => void;
  /** Billing (AP-133): only when control has it. */
  onBilling?: () => void;
  /** The organization waits for a plan and this person can choose one (BL-13): that comes before claiming. */
  planNeeded?: boolean;
  /** This device isn't (or no longer) let in there: offer the recovery kit (AP-41). */
  canRecover?: (a: ApplianceSummary) => boolean;
  onRecover?: (a: ApplianceSummary) => void;
  /** This device still remembers a retired Whombat (AP-695): it is listed as Retired, to forget. */
  remembers?: (device: string) => boolean;
  /** Forget a retired Whombat on this device. */
  onForget?: (a: ApplianceSummary) => void;
  /** Delete the cloud account (CT-78, AP-73). */
  onDeleteAccount?: () => void;
  /** Name a Whombat in the directory (AP-3086); resolves to why it failed, or null. */
  onRename?: (a: ApplianceSummary, name: string) => Promise<string | null>;
  /** “Link a Whombat”: the code its screen shows (Whombat Link, LNK-13). */
  onLinkWhombat?: () => void;
  /** “Whombat Link”: Your Whombats with the Link subscription (LNK-35). */
  onLinkAccount?: () => void;
}) {
  const now = Date.now();
  const rows = appliances ? listedAppliances(appliances, remembers) : [];
  // No Whombat in use (none, or every one retired): the claim is what's left (AP-75, AP-695).
  const empty = appliances ? appliancesEmptyText(appliances) : null;
  const [naming, setNaming] = useState<string | null>(null);
  return (
    <AuthLayout
      kicker={COPY.appliances.kicker}
      title={COPY.appliances.title}
      sub={COPY.appliances.sub}
      tip={COPY.appliances.tip}
    >
      {notice && (
        <div className={styles.notice} role="status" data-testid="appliances-notice">
          <p>{notice}</p>
        </div>
      )}
      <ErrorLine text={error} />
      {rows.length > 0 && (
        <ul className={styles.card} aria-label="Whombats">
          {rows.map((a) => {
            const name = a.name ?? a.device;
            if (isRetired(a))
              return (
                <li key={a.device} className={cx(styles.row, styles.rowRetired)} data-state="retired">
                  <StatusDot tone="mut" size={8} label={COPY.appliances.retired} />
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{name}</span>
                    <span className={styles.rowMeta}>{COPY.appliances.retired}</span>
                  </div>
                  {onForget && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onForget(a)}
                      aria-label={COPY.appliances.forgetLabel(name)}
                    >
                      {COPY.appliances.forget}
                    </Button>
                  )}
                </li>
              );
            // Set up at its own address: its name only, never its address, and nothing to open here.
            if (a.ownAddress)
              return (
                <li key={a.device} className={styles.row} data-own-address="">
                  <StatusDot tone="mut" size={8} label={null} />
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{name}</span>
                    <span className={styles.rowMeta}>{OWN_ADDRESS_TEXT.hosted.addressElsewhere}</span>
                  </div>
                </li>
              );
            const online = a.lastSeenAt !== null && now / 1000 - a.lastSeenAt < 120;
            if (onRename && naming === a.device)
              return (
                <li key={a.device} className={styles.row}>
                  <NameEditor
                    appliance={a}
                    onSave={(typed) => onRename(a, typed)}
                    onDone={() => setNaming(null)}
                  />
                </li>
              );
            return (
              <li key={a.device} className={styles.row}>
                <StatusDot
                  tone={online ? 'ok' : 'mut'}
                  size={8}
                  label={online ? COPY.appliances.online : 'Offline'}
                />
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{name}</span>
                  <span className={styles.rowMeta}>
                    {online
                      ? COPY.appliances.online
                      : a.lastSeenAt
                        ? COPY.appliances.offline(agoText(a.lastSeenAt, now))
                        : COPY.appliances.neverSeen}
                    {a.revocationsPending > 0 && (
                      <span className={styles.warn}>
                        {' '}
                        · {COPY.appliances.pendingRevocations(a.revocationsPending)}
                      </span>
                    )}
                  </span>
                  {((onRecover && canRecover?.(a)) || onRename) && (
                    <span className={styles.rowLinks}>
                      {onRecover && canRecover?.(a) && (
                        <Button
                          variant="link"
                          onClick={() => onRecover(a)}
                          aria-label={`${COPY.recover.lost} · ${name}`}
                        >
                          {COPY.recover.lost}
                        </Button>
                      )}
                      {onRename && (
                        <Button
                          variant="link"
                          onClick={() => setNaming(a.device)}
                          aria-label={COPY.appliances.renameLabel(name)}
                        >
                          {COPY.appliances.rename}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onPointerEnter={() => onPrepare?.(a)}
                  onFocus={() => onPrepare?.(a)}
                  onClick={() => onOpen(a)}
                  aria-label={`Open ${name}`}
                >
                  {COPY.appliances.open}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {empty && !planNeeded && <p className={styles.status}>{empty}</p>}
      {planNeeded && <p className={styles.status}>{COPY.billing.setupNeeded}</p>}
      <div className={styles.actions}>
        {planNeeded && onBilling ? (
          <Button variant="primary" size="lg" onClick={onBilling}>
            {COPY.billing.choosePlan}
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onClaim}>
            {COPY.appliances.claim}
          </Button>
        )}
        {onLinkWhombat && (
          <Button variant="link" onClick={onLinkWhombat}>
            {WHOMBAT_LINK_TEXT.linkEntry}
          </Button>
        )}
        {onLinkAccount && (
          <Button variant="link" onClick={onLinkAccount}>
            {WHOMBAT_LINK_TEXT.entry}
          </Button>
        )}
        {onBilling && (
          <Button variant="link" onClick={onBilling}>
            {COPY.billing.entry}
          </Button>
        )}
        <Button variant="link" onClick={onSignOut}>
          {COPY.appliances.signOut}
        </Button>
        <span className={styles.hint}>{session.account.email}</span>
        {onDeleteAccount && (
          <Button variant="link" onClick={onDeleteAccount}>
            {COPY.account.deleteEntry}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}

/** A Whombat's name being typed on the list (AP-3086): Save sends it to the directory, Cancel or Esc leaves it. */
function NameEditor({
  appliance,
  onSave,
  onDone,
}: {
  appliance: ApplianceSummary;
  onSave: (name: string) => Promise<string | null>;
  onDone: () => void;
}) {
  const [value, setValue] = useState(appliance.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const invalid = whombatNameError(value);
    if (invalid) return setError(invalid);
    setBusy(true);
    const failed = await onSave(value.trim());
    setBusy(false);
    if (failed) setError(failed);
    else onDone();
  };
  return (
    <form
      className={styles.nameForm}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
    >
      <div className={styles.rowMain}>
        <Input
          autoFocus
          aria-label={COPY.appliances.nameLabel(appliance.device)}
          placeholder={COPY.appliances.namePlaceholder}
          invalid={error !== null}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <span className={styles.hint}>{appliance.device}</span>
        <ErrorLine text={error} />
      </div>
      <Button variant="primary" size="sm" type="submit" disabled={busy}>
        {busy ? COPY.appliances.saving : COPY.appliances.save}
      </Button>
      <Button variant="link" onClick={onDone}>
        {COPY.appliances.cancel}
      </Button>
    </form>
  );
}

/* Claim (CC-09, AP-47) ---------------------------------------------------------------------------------- */

export {
  type ClaimCard,
  type ClaimRequest,
  claimErrorKey,
  parseClaimQr,
} from '@whombat/client/managed';

/** The person's name on the Whombat, asked only when the cloud account has none. */
function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={COPY.claim.nameLabel}>
      {(id) => (
        <Input
          id={id}
          size="lg"
          required
          autoComplete="name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * “I agree to the Whombat Appliance Terms” (LC-18) or “… Subscription Terms” (BL-24): a real checkbox, unticked, before
 * the button, which stays disabled until it's ticked. The link opens the terms in a new tab.
 */
export function TermsCheck({
  checked,
  onChange,
  agree = COPY.claim.termsAgree,
  link = COPY.claim.termsLink,
  href = '/legal/appliance-terms',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  agree?: string;
  link?: string;
  href?: string;
}) {
  const id = useId();
  return (
    <div className={styles.check}>
      <input
        id={id}
        type="checkbox"
        className={styles.checkBox}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} className={styles.checkLabel}>
        {agree}{' '}
        <a href={href} target="_blank" rel="noopener">
          {link}
        </a>
      </label>
    </div>
  );
}

export interface ClaimScreenProps {
  /** The cloud account has no name: ask for the one this Whombat shows. */
  askName: boolean;
  busy: boolean;
  error: string | null;
  /** A refusal with a way out (AP-132), shown instead of `error`. */
  notice?: ReactNode;
  onClaim: (request: ClaimRequest, name: string) => void;
}

/**
 * A claim refusal with its action (BL-13, BL-17, BL-18; AP-132): “This Whombat already had a free trial…” with
 * Start subscription now, “Your plan covers 2 Whombats.” with Add a Whombat. The action claims again when it's done.
 */
export function ClaimRefusalNotice({
  text,
  note,
  action,
  busyLabel,
  error,
  onAction,
}: {
  text: string;
  note?: string | null;
  action?: string | null;
  busyLabel?: string;
  error?: string | null;
  onAction?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.notice} role="alert">
      <p>{text}</p>
      {note && <p className={styles.hint}>{note}</p>}
      <ErrorLine text={error ?? null} />
      {action && onAction && (
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onAction().finally(() => setBusy(false));
            }}
          >
            {busy && busyLabel ? busyLabel : action}
          </Button>
        </div>
      )}
    </div>
  );
}

/** `claims.nearby` is on its way. */
export function ClaimLookingScreen() {
  return (
    <AuthLayout kicker={COPY.claim.kicker} title={COPY.claim.title} tip={COPY.claim.tip}>
      <p className={styles.status} role="status">
        {COPY.claim.looking}
      </p>
    </AuthLayout>
  );
}

/** One box on this network: its four letters are enough (CC-09). */
export function ClaimFoundScreen({
  box,
  askName,
  busy,
  error,
  notice,
  onClaim,
  onNotThisOne,
  onCard,
}: ClaimScreenProps & { box: NearbyAppliance; onNotThisOne: () => void; onCard?: () => void }) {
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  const [bad, setBad] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!agreed) return;
    // Only the four letters: a code claim works only for a box found on this network (CC-13).
    const request = lettersRequestOf(box.device, typed);
    setBad(!request);
    if (request) onClaim(request, name.trim());
  };
  return (
    <AuthLayout
      kicker={COPY.claim.kicker}
      title={COPY.claim.foundTitle}
      sub={COPY.claim.foundSub}
      tip={COPY.claim.tip}
    >
      <ul className={styles.card} aria-label="Whombat on your network">
        <li className={styles.row}>
          <StatusDot tone="ok" size={8} label={COPY.appliances.online} />
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{modelLabel(box.model)}</span>
            <span className={cx(styles.rowMeta, styles.mono)}>{box.device}</span>
          </div>
        </li>
      </ul>
      <form className={styles.form} onSubmit={submit}>
        <Field label={COPY.claim.letters} hint={COPY.claim.lettersHint}>
          {(id) => (
            <LettersInput
              id={id}
              value={typed}
              onChange={setTyped}
              placeholder={COPY.claim.lettersPlaceholder}
            />
          )}
        </Field>
        {askName && <NameField value={name} onChange={setName} />}
        <TermsCheck checked={agreed} onChange={setAgreed} />
        {notice && !bad ? notice : <ErrorLine text={bad ? COPY.claim.malformed : error} />}
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !agreed}>
            {busy ? COPY.claim.claiming : COPY.claim.claim}
          </Button>
          <Button variant="link" onClick={onNotThisOne}>
            {COPY.claim.notThisOne}
          </Button>
        </div>
      </form>
      <div className={styles.actions}>
        {onCard && (
          <Button variant="link" onClick={onCard}>
            {COPY.claim.withCard}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}

/** Several boxes on this network: pick one first (CC-09). */
export function ClaimPickScreen({
  boxes,
  onPick,
  onNone,
  onCard,
}: {
  boxes: NearbyAppliance[];
  onPick: (box: NearbyAppliance) => void;
  onNone: () => void;
  /** The card's claim, where it is still offered (gone from the hosted flow with Whombat Link). */
  onCard?: () => void;
}) {
  return (
    <AuthLayout
      kicker={COPY.claim.kicker}
      title={COPY.claim.severalTitle(boxes.length)}
      sub={COPY.claim.severalSub}
      tip={COPY.claim.tip}
    >
      <ul className={styles.card} aria-label="Whombats on your network">
        {boxes.map((b) => (
          <li key={b.device} className={styles.row}>
            <StatusDot tone="ok" size={8} label={COPY.appliances.online} />
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>{modelLabel(b.model)}</span>
              <span className={cx(styles.rowMeta, styles.mono)}>{b.device}</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPick(b)}
              aria-label={COPY.claim.pickLabel(modelLabel(b.model), b.device)}
            >
              {COPY.claim.pick}
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button variant="link" onClick={onNone}>
          {COPY.claim.noneOfThese}
        </Button>
        {onCard && (
          <Button variant="link" onClick={onCard}>
            {COPY.claim.withCard}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}

/**
 * No box found on this network, or not this one (CC-13): the phone or computer has to be on the Whombat's network.
 * “Look again” asks `claims.nearby` again; the card stays the way for a box without a screen.
 */
export function ClaimNoneScreen({ onLookAgain, onCard }: { onLookAgain: () => void; onCard?: () => void }) {
  return (
    <AuthLayout
      kicker={COPY.claim.kicker}
      title={COPY.claim.noneTitle}
      sub={COPY.claim.noneSub}
      tip={COPY.claim.tip}
    >
      <div className={styles.actions}>
        <Button variant="primary" size="lg" onClick={onLookAgain}>
          {COPY.claim.lookAgain}
        </Button>
      </div>
      <div className={styles.actions}>
        {onCard && (
          <Button variant="link" onClick={onCard}>
            {COPY.claim.withCard}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}

/** The factory card, for a box without a screen (CC-02): typed, or the text of its QR code. */
export function ClaimCardScreen({
  initial,
  askName,
  busy,
  error,
  notice,
  onClaim,
  onCode,
}: ClaimScreenProps & { initial?: ClaimCard | null; onCode: () => void }) {
  const [device, setDevice] = useState(initial?.device ?? '');
  const [secret, setSecret] = useState(initial?.secret ?? '');
  const [qr, setQr] = useState('');
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const onQr = (text: string) => {
    setQr(text);
    const card = parseClaimQr(text);
    if (card) {
      setDevice(card.device);
      setSecret(card.secret);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!agreed) return;
    onClaim({ method: 'card', device: device.trim(), secret: normalizeClaimSecret(secret) }, name.trim());
  };
  return (
    <AuthLayout
      kicker={COPY.claim.kicker}
      title={COPY.claim.cardTitle}
      sub={COPY.claim.cardSub}
      tip={COPY.claim.cardTip}
    >
      <form className={styles.form} onSubmit={submit}>
        <Field label={COPY.claim.device}>
          {(id) => (
            <Input
              id={id}
              size="lg"
              className={styles.mono}
              placeholder={COPY.claim.devicePlaceholder}
              required
              value={device}
              onChange={(e) => setDevice(e.target.value)}
            />
          )}
        </Field>
        <Field label={COPY.claim.secret}>
          {(id) => (
            <Input
              id={id}
              size="lg"
              className={styles.mono}
              placeholder={COPY.claim.secretPlaceholder}
              required
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
        </Field>
        <Field label={COPY.claim.paste}>
          {(id) => (
            <Input id={id} className={styles.mono} value={qr} onChange={(e) => onQr(e.target.value)} />
          )}
        </Field>
        {askName && <NameField value={name} onChange={setName} />}
        <TermsCheck checked={agreed} onChange={setAgreed} />
        {notice ?? <ErrorLine text={error} />}
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !agreed}>
            {busy ? COPY.claim.claiming : COPY.claim.claim}
          </Button>
        </div>
      </form>
      <div className={styles.actions}>
        <Button variant="link" onClick={onCode}>
          {COPY.claim.withCode}
        </Button>
      </div>
    </AuthLayout>
  );
}

/* Recovery kit -------------------------------------------------------------------------------------------- */

/**
 * Saving the recovery kit (BX-01; “Keep a way back in”, backup-options.md AP-6820…): a new kit is registered with the
 * box (or, with one saved already, signed by the current one's key), kept the ways the person ticks, then confirmed.
 * `control` and `platform` offer the passkey where the browser can lock the kit with one.
 */
export function RecoveryKitScreen({
  session,
  applianceName,
  device,
  appliancePeerId,
  control,
  platform,
  onDone,
}: {
  session: ApplianceSession;
  applianceName: string;
  device: string;
  appliancePeerId: string;
  control?: ControlApi | null;
  platform?: PasskeyPlatform | null;
  onDone: () => void;
}) {
  const [kit] = useState<RecoveryKit>(() => newRecoveryKit({ applianceName, device, appliancePeerId }));
  const [registered, setRegistered] = useState<{ kitId: string; challenge: string } | null>(null);
  /** The kit's backup section: undefined while it's asked for (the kit waits for it), null: none set up (AP-265). */
  const [backup, setBackup] = useState<KitBackup | KitBackupGap | null | undefined>(undefined);
  const passkeyOffered = !!platform?.prf && !!control;
  const [choices, setChoices] = useState<KitChoices>(() => startingKitChoices(passkeyOffered));
  /** This Whombat's passkeys of this account at control (credential ids); null while asked. */
  const [passkeyIds, setPasskeyIds] = useState<string[] | null>(null);
  /** The backup service's kit generation (what the envelope and this browser's note are for). */
  const [kitGeneration, setKitGeneration] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A kit exists already: the current key must sign the new one (`recovery.kit.rotate`, CT-45). */
  const [rotate, setRotate] = useState(false);
  const [current, setCurrent] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // With backups set up, the kit also carries what restoring them needs (none yet is fine). What this
    // app can't write whole is left out and said so (AP-265).
    void loadKitBackup(session).then(setBackup);
    const register = () =>
      sessionOps
        .recoveryKitRegister(session, kit.publicKeyHex)
        .then((r) => setRegistered({ kitId: r.kitId, challenge: r.challenge }))
        .catch((e: unknown) => {
          if (e instanceof OperationError && e.code === 'recovery_key_exists') setRotate(true);
          else setError(COPY.claim.errors.failed);
        });
    sessionOps.applianceStatus(session).then(
      (s) => (s.recovery.enrolled && s.recovery.kitVerified ? setRotate(true) : void register()),
      () => void register(),
    );
    sessionOps.backupStatus(session).then(
      (r) => setKitGeneration(r.status?.kitGeneration ?? null),
      () => {},
    );
  }, [session, kit]);
  useEffect(() => {
    if (!control || !passkeyOffered) return;
    let live = true;
    control.passkeys().then(
      (list) =>
        live &&
        setPasskeyIds(
          list
            .filter((p) =>
              p.owner ? p.owner.appliances.includes(appliancePeerId) : p.appliance === appliancePeerId,
            )
            .map((p) => p.id),
        ),
      () => live && setPasskeyIds([]),
    );
    return () => {
      live = false;
    };
  }, [control, passkeyOffered, appliancePeerId]);

  const rotateKit = async (e: FormEvent) => {
    e.preventDefault();
    const secret = recoverySecretFromKey(current);
    if (!secret) {
      setError(COPY.claim.errors.recovery_rotation_invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await sessionOps.recoveryKitRotate(session, {
        newRecoveryPublicKey: kit.publicKeyHex,
        currentKeySignature: rotationSignature({
          currentSecretKeyHex: secret,
          appliancePeerId,
          newRecoveryPublicKey: kit.publicKeyHex,
        }),
      });
      setCurrent('');
      setRotate(false);
      setRegistered({ kitId: r.kitId, challenge: r.challenge });
    } catch (err) {
      setError(
        err instanceof OperationError && err.code === 'recovery_rotation_invalid'
          ? COPY.claim.errors.recovery_rotation_invalid
          : COPY.claim.errors.failed,
      );
    } finally {
      setBusy(false);
    }
  };

  if (rotate && !registered)
    return (
      <AuthLayout
        kicker={COPY.kit.kicker}
        title={COPY.kit.rotateTitle}
        sub={COPY.kit.rotateSub}
        tip={COPY.kit.tip}
      >
        <form className={styles.form} onSubmit={(e) => void rotateKit(e)}>
          <Field label={COPY.kit.currentKey}>
            {(id) => (
              <Input
                id={id}
                size="lg"
                className={styles.mono}
                autoComplete="off"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </Field>
          <ErrorLine text={error} />
          <div className={styles.actions}>
            <Button variant="primary" size="lg" type="submit" disabled={busy}>
              {COPY.kit.rotate}
            </Button>
          </div>
        </form>
      </AuthLayout>
    );

  const text = backup === undefined ? null : kitText(kit, backup, accountOf(session));
  const generation = () => (backup && !isKitBackupGap(backup) ? backup.generation : 0);

  const download = () => {
    if (!text) return;
    saveBlob(new Blob([text], { type: 'text/plain' }), `whombat-recovery-kit-${device}.txt`);
    noteKitSaved(device, kitGeneration ?? generation(), 'file');
  };

  const print = () => {
    // The print sheet is in the page already; paper shows only it.
    window.print();
    noteKitSaved(device, kitGeneration ?? generation(), 'print');
  };

  /** The ways ticked, then the box is told the kit is saved (`recovery.kit.confirm`). */
  const save = async () => {
    if (!registered || !text) return;
    setBusy(true);
    setError(null);
    try {
      if (choices.passkey && platform && control) {
        const added = await setUpOnePasskey({
          session,
          control,
          platform,
          appliance: appliancePeerId,
          me: accountOf(session),
          name: passkeyName(browserLabel()),
        });
        const ids = [added.credentialId];
        setPasskeyIds(ids);
        await lockKitWithPasskey({
          platform,
          control,
          appliance: appliancePeerId,
          credentialIds: ids,
          kitText: text,
          generation: kitGeneration ?? generation(),
        });
      }
      if (choices.file) download();
      if (choices.print) print();
      await sessionOps.recoveryKitConfirm(session, {
        kitId: registered.kitId,
        signature: confirmationSignature(kit, registered.kitId, registered.challenge),
      });
      setSaved(true);
    } catch (e) {
      if (e instanceof PasskeyCancelled) return;
      if (e instanceof PasskeyError && e.code === 'unsupported') setError(BACKUP_OPTIONS_TEXT.kit.noPrf);
      else setError(passkeyErrorText(e) ?? COPY.claim.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <KeepWayBack
        name={applianceName}
        passkeyOffered={passkeyOffered}
        noPasskeyYet={passkeyIds !== null && passkeyIds.length === 0}
        choices={choices}
        onChoices={setChoices}
        ready={!!registered && text !== null}
        busy={busy}
        saved={saved}
        error={error}
        notice={isKitBackupGap(backup) ? KIT_BACKUP_TEXT[backup.gap] : null}
        onSave={() => void save()}
        onPrint={print}
        onDownload={download}
        onDone={onDone}
      />
      {text ? <KitPrintSheet name={applianceName} kitText={text} /> : null}
    </>
  );
}

/* Pairing ------------------------------------------------------------------------------------------------- */

/** What a box that takes no code pairing says instead (own-address.md): a device link from one of the person's devices. */
const PAIRING_OFF_TEXT =
  'This Whombat doesn’t take a code from here. Open a link from one of your devices: there, Settings → Devices → Show QR code.';

export function PairScreen({
  session,
  label,
  fingerprint,
  onApproved,
  onRecover,
  onPasskey,
  onScreen,
  onUseAsScreen,
}: {
  session: ApplianceSession;
  label: string;
  /** This browser's pairing fingerprint (`pairingFingerprint(own PeerId)`, CT-46): the approver sees the same. */
  fingerprint: string;
  onApproved: (accountId: string | null) => void;
  /** Lost every signed-in device: the recovery kit instead (AP-41). */
  onRecover?: () => void;
  /**
   * A passkey made for this Whombat on another device (AP-806): this device is pinned but not let in yet (say a
   * passkey sign-in stopped halfway), so the passkey stays a way in here. Rejects with the failure.
   */
  onPasskey?: () => Promise<void>;
  /** “Use its screen” (BX-02): the box shows a code on its own screen for this device. */
  onScreen?: () => void;
  /** *Use as a screen* (desk-display-web.md AP-5961): this device shows the Whombat for everyone instead. */
  onUseAsScreen?: () => void;
}) {
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const withPasskey = async () => {
    if (!onPasskey) return;
    setError(null);
    setPasskeyBusy(true);
    try {
      await onPasskey();
    } catch (e) {
      setError(passkeyFailureText(e));
    } finally {
      setPasskeyBusy(false);
    }
  };
  const [request, setRequest] = useState<{ pairingId: string; code: string } | null>(null);
  const [state, setState] = useState<'pending' | 'denied' | 'expired' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    let live = true;
    const poll = async () => {
      if (!live) return;
      try {
        const s = await sessionOps.pairStatus(session, request.pairingId);
        if (!live) return;
        if (s.state === 'approved') {
          onApproved(s.enrolled?.accountId ?? null);
          return;
        }
        setState(s.state);
        if (s.state === 'pending') setTimeout(poll, 1500);
      } catch {
        if (live) setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      live = false;
    };
  }, [request, session, onApproved]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      // The box is one person's: no email to name the account (CT-1509; one-person.md AP-5675).
      const r = await sessionOps.pairRequest(session, { endpoint: { label, platform: 'web' } });
      setRequest({ pairingId: r.pairingId, code: r.code });
      setState('pending');
    } catch (e) {
      // A box that takes no code pairing (one set up at its own address): the ways that work instead.
      const code =
        e instanceof OperationError ? ((e.details as { code?: unknown } | undefined)?.code ?? e.code) : null;
      setError(code === 'pairing_off' ? PAIRING_OFF_TEXT : COPY.claim.errors.failed);
    }
  };

  return (
    <AuthLayout kicker={COPY.pair.kicker} title={COPY.pair.title} sub={COPY.pair.sub} tip={COPY.pair.tip}>
      {request && state === 'pending' ? (
        <div className={styles.form}>
          <SectionLabel>{COPY.pair.code}</SectionLabel>
          <p className={styles.code} data-testid="pairing-code">
            {request.code}
          </p>
          <div className={styles.fingerprint}>
            <SectionLabel>{COPY.pair.fingerprint}</SectionLabel>
            <p className={styles.groups} data-testid="pairing-fingerprint">
              {fingerprint}
            </p>
            <span className={styles.hint}>{COPY.pair.fingerprintHelp}</span>
          </div>
          <p className={styles.status} role="status">
            <StatusDot status="waiting" size={8} />
            {COPY.pair.waiting}
          </p>
        </div>
      ) : (
        <form className={styles.form} onSubmit={start}>
          {(onPasskey || onScreen || onUseAsScreen) && (
            <ul className={styles.card} aria-label={COPY.pair.title}>
              {onPasskey && (
                <li className={styles.row}>
                  <span className={styles.rowMain}>{PASSKEY_COPY.setupWay}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={passkeyBusy}
                    iconStart={<Icon name="key" size={14} />}
                    onClick={() => void withPasskey()}
                  >
                    {PASSKEY_COPY.setupUse}
                  </Button>
                </li>
              )}
              {onScreen && (
                <li className={styles.row}>
                  <span className={styles.rowMain}>{COPY.screen.way}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconStart={<Icon name="screen" size={14} />}
                    onClick={onScreen}
                  >
                    {COPY.screen.use}
                  </Button>
                </li>
              )}
              {onUseAsScreen && (
                <li className={styles.row}>
                  <span className={styles.rowMain}>{SCREEN_MODE_TEXT.way}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconStart={<Icon name="screen" size={14} />}
                    onClick={onUseAsScreen}
                  >
                    {SCREEN_MODE_TEXT.use}
                  </Button>
                </li>
              )}
            </ul>
          )}
          <ErrorLine
            text={
              error ??
              (state === 'denied' ? COPY.pair.denied : state === 'expired' ? COPY.pair.expired : null)
            }
          />
          <div className={styles.actions}>
            <Button variant="primary" size="lg" type="submit">
              {COPY.pair.start}
            </Button>
            {onRecover && (
              <Button variant="link" onClick={onRecover}>
                {COPY.pair.recover}
              </Button>
            )}
          </div>
          <p className={styles.hint}>{COPY.pair.noDevice}</p>
        </form>
      )}
    </AuthLayout>
  );
}

/* Recovery with the kit (AP-41, AP-65) ---------------------------------------------------------------------- */

/** What the person gave: the kit file (it may name the Whombat's identity) or the typed recovery key. */
export interface KitInput {
  secretKeyHex: string;
  accountId: string;
  kit: SavedKit | null;
}

export function RecoverScreen({
  device,
  knownAccountId,
  onSubmit,
  onBack,
}: {
  /** The Whombat's code a kit file must name; null on the box's own page, which checks the kit's identity instead. */
  device: string | null;
  /** The account this device had there, if it remembers (a kit file names it too). */
  knownAccountId: string | null;
  /**
   * Checks the kit against this device's pin and the directory, then lets this device in over an enrollment session
   * opened only now (AP-65). Answers the words of a refusal, or null (done, or the flow shows a hard stop).
   */
  onSubmit: (input: KitInput) => Promise<string | null>;
  onBack: () => void;
}) {
  const [file, setFile] = useState<{ name: string; kit: SavedKit } | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (picked: File | undefined) => {
    setError(null);
    setFile(null);
    if (!picked) return;
    const read = readKitFile(await picked.slice(0, 64 * 1024).text());
    if (!read.ok) return setError(read.reason === 'damaged' ? COPY.recover.damaged : COPY.recover.notAKit);
    if (device && read.kit.device && read.kit.device !== device) return setError(COPY.recover.otherWhombat);
    setFile({ name: picked.name, kit: read.kit });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const secretKeyHex = file?.kit.secretKeyHex ?? recoverySecretFromKey(typed);
    if (!secretKeyHex) return setError(COPY.recover.badKey);
    const accountId = file?.kit.accountId ?? knownAccountId;
    if (!accountId) return setError(COPY.recover.whoUnknown);
    setBusy(true);
    const refused = await onSubmit({ secretKeyHex, accountId, kit: file?.kit ?? null });
    if (refused) {
      setError(refused);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      kicker={COPY.recover.kicker}
      title={COPY.recover.title}
      sub={COPY.recover.sub}
      tip={COPY.recover.tip}
    >
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <Field label={COPY.recover.openFile} {...(file ? { hint: COPY.recover.opened(file.name) } : {})}>
          {(id) => (
            <input
              id={id}
              type="file"
              accept=".txt,text/plain"
              onChange={(e) => void open(e.target.files?.[0])}
            />
          )}
        </Field>
        {!file && (
          <Field label={COPY.recover.key}>
            {(id) => (
              <Input
                id={id}
                className={styles.mono}
                autoComplete="off"
                spellCheck={false}
                placeholder={COPY.recover.keyPlaceholder}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </Field>
        )}
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || (!file && !typed.trim())}>
            {busy ? COPY.recover.working : COPY.recover.go}
          </Button>
          <Button variant="link" onClick={onBack}>
            {COPY.recover.back}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/* Setting up a device that doesn't know this Whombat yet (AP-64) ------------------------------------------ */

export function SetupScreen({
  onLink,
  onKit,
  onBack,
  onPasskey,
  onScreen,
}: {
  /** A pasted link to set up with (add-a-device); false when it isn't one. */
  onLink: (text: string) => boolean;
  onKit: () => void;
  onBack: () => void;
  /** A passkey made for this Whombat on another device (PK-04); absent without WebAuthn. Rejects with the failure. */
  onPasskey?: () => Promise<void>;
  /** “Use its screen” (BX-02): the box shows a code on its own screen for this device. */
  onScreen?: () => void;
  /** *Use as a screen* (desk-display-web.md AP-5961): this device shows the Whombat for everyone instead. */
  onUseAsScreen?: () => void;
}) {
  const t = COPY.setup;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ways = [
    ...(onPasskey ? [PASSKEY_COPY.setupWay] : []),
    ...(onScreen ? [COPY.screen.way] : []),
    ...t.ways,
  ];
  const withPasskey = async () => {
    if (!onPasskey) return;
    setError(null);
    setBusy(true);
    try {
      await onPasskey();
    } catch (e) {
      setError(passkeyFailureText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      <ul className={styles.card} aria-label={t.title}>
        {ways.map((way) => (
          <li key={way} className={styles.row}>
            <span className={styles.rowMain}>{way}</span>
            {way === PASSKEY_COPY.setupWay && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                iconStart={<Icon name="key" size={14} />}
                onClick={() => void withPasskey()}
              >
                {PASSKEY_COPY.setupUse}
              </Button>
            )}
            {way === COPY.screen.way && onScreen && (
              <Button
                variant="secondary"
                size="sm"
                iconStart={<Icon name="screen" size={14} />}
                onClick={onScreen}
              >
                {COPY.screen.use}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          setError(onLink(text) ? null : t.badLink);
        }}
      >
        <Field label={t.paste} hint={t.pasteHint}>
          {(id) => (
            <Input
              id={id}
              autoComplete="off"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={!text.trim()}>
            {t.go}
          </Button>
          <Button variant="secondary" size="lg" onClick={onKit}>
            {t.kit}
          </Button>
          <Button variant="link" onClick={onBack}>
            {COPY.connection.back}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/* Signing in at the box's screen (BX-02…BX-05, AP-3508…AP-3512) -------------------------------------------- */

/**
 * “Show a code” (no email: the box is one person's, CT-1509; AP-5675), then the six letters the box's screen shows; the
 * client's step machine
 * runs each step (`screenSignInRequest`, `screenSignInSubmit`) and says what went wrong. `onDone` once the box's tag
 * matched (`enrolled`) or this device's key was let in already (`already`): the flow pins and opens.
 */
export function ScreenSignInScreen({
  deps,
  onDone,
  onBack,
}: {
  /** The enrollment session and the identities it connected with (`screenSignInPeer`). */
  deps: ScreenSignInDeps;
  onDone: (step: Extract<ScreenSignInStep, { kind: 'enrolled' | 'already' }>) => void;
  onBack: () => void;
}) {
  const t = COPY.screen;
  const [step, setStep] = useState<ScreenSignInStep>(() => screenSignInStart());
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (step.kind === 'enrolled' || step.kind === 'already') done.current(step);
  }, [step]);
  const take = async (next: Promise<ScreenSignInStep>) => {
    setBusy(true);
    const s = await next;
    // A new code, or a wrong guess (the box shows new letters): type them afresh.
    if (s.kind === 'letters' && (s.error || step.kind === 'start')) setTyped('');
    setStep(s);
    setBusy(false);
  };
  const ask = (from: ScreenSignInAsking) => void take(screenSignInRequest(deps, from));
  // Back to where it was opened from (“Let this device in” or “Set up this device”), as the kit's screen does.
  const back = (
    <Button variant="link" onClick={onBack}>
      {COPY.recover.back}
    </Button>
  );

  if (step.kind === 'letters')
    return (
      <AuthLayout kicker={t.kicker} title={t.typeTitle} sub={t.typeSub} tip={t.tip}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void take(screenSignInSubmit(deps, step, typed));
          }}
        >
          <Field label={t.letters}>
            {(id) => (
              <Input
                id={id}
                size="display"
                className={cx(styles.mono, styles.codeInput)}
                placeholder={t.lettersPlaceholder}
                required
                autoFocus
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                invalid={!!step.error}
                value={typed}
                onChange={(e) => setTyped(formatScreenLettersInput(e.target.value))}
              />
            )}
          </Field>
          <ErrorLine text={step.error} />
          <div className={styles.actions}>
            <Button variant="primary" size="lg" type="submit" disabled={busy || !typed.trim()}>
              {busy ? COPY.recover.working : t.go}
            </Button>
            <Button variant="link" disabled={busy} onClick={() => ask(step)}>
              {t.newCode}
            </Button>
          </div>
        </form>
      </AuthLayout>
    );
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      {step.kind === 'stopped' ? (
        <div className={styles.form}>
          <ErrorLine text={step.error} />
          <div className={styles.actions}>{back}</div>
        </div>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (step.kind === 'start') ask(step);
          }}
        >
          <ErrorLine text={step.kind === 'start' ? step.error : null} />
          <div className={styles.actions}>
            <Button variant="primary" size="lg" type="submit" disabled={busy}>
              {t.show}
            </Button>
            {back}
          </div>
        </form>
      )}
    </AuthLayout>
  );
}

/* The hard stop (AP-64): the identity this device pinned, a link or a kit disagrees with the directory ---------- */

export type IdentityStop = 'changed' | 'link' | 'kit';

export function IdentityStopScreen({
  stop,
  onBack,
  onForget,
}: {
  stop: IdentityStop;
  onBack: () => void;
  /** Removes this device's record of the Whombat (only offered when there is one). */
  onForget?: () => void;
}) {
  const t = COPY.identity;
  const [title, text] =
    stop === 'changed'
      ? [t.changedTitle, t.changed]
      : stop === 'link'
        ? [t.linkTitle, t.link]
        : [t.kitTitle, t.kit];
  return (
    <ConnectionGate
      title={title}
      text={text}
      actions={
        <>
          <Button variant="primary" size="lg" onClick={onBack}>
            {COPY.connection.back}
          </Button>
          {onForget && (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                if (window.confirm(t.forgetConfirm)) onForget();
              }}
            >
              {t.forget}
            </Button>
          )}
        </>
      }
    />
  );
}

/* Deleting the cloud account (CT-78, AP-73) --------------------------------------------------------------- */

export function DeleteAccountScreen({
  email,
  onDelete,
  onBack,
}: {
  /** The account's email: typing it confirms. */
  email: string;
  /** Deletes the account; answers the words of a refusal, or null once it's gone. */
  onDelete: (typed: string) => Promise<string | null>;
  onBack: () => void;
}) {
  const t = COPY.account;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    const refused = await onDelete(typed.trim());
    if (refused) {
      setError(refused);
      setBusy(false);
    }
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      <section className={styles.field} aria-label={t.deleted}>
        <SectionLabel as="h2">{t.deleted}</SectionLabel>
        <ul className={styles.card}>
          {t.deletedItems.map((item) => (
            <li key={item} className={styles.row}>
              <span className={styles.rowMain}>{item}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.field} aria-label={t.kept}>
        <SectionLabel as="h2">{t.kept}</SectionLabel>
        <ul className={styles.card}>
          {t.keptItems.map((item) => (
            <li key={item} className={styles.row}>
              <span className={styles.rowMain}>{item}</span>
            </li>
          ))}
        </ul>
      </section>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <Field label={t.email} hint={email}>
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          )}
        </Field>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !matches}>
            {busy ? t.deleting : t.go}
          </Button>
          <Button variant="link" onClick={onBack}>
            {t.back}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/* Connection gate (terminal states) ----------------------------------------------------------------------- */

export function ConnectionGate({
  title,
  text,
  actions,
}: {
  title: string;
  text: string;
  actions: ReactNode;
}) {
  return (
    <main className={styles.gate}>
      <div className={styles.gateCard} role="alert">
        <h1 className={styles.gateTitle}>{title}</h1>
        <p className={styles.gateText}>{text}</p>
        <div className={styles.actions}>{actions}</div>
      </div>
    </main>
  );
}
