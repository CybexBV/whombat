/**
 * Whombat Link at the account site (Whombat whombat-link.md LNK-13, LNK-32…LNK-35, LNK-06; one-environment.md;
 * link-account-site.md): `/link`, where a person enters the code their Whombat's screen shows, ticks the Subscription
 * Terms and confirms it into their account, and Your Whombats (`/account`, and `/billing` where Stripe sends the browser
 * back), with each Whombat's Open (its own address, the one this device opened last first; one Whombat leads with one
 * big Open), the Link subscription by the month or the year with its free time, and each Whombat's Link. Not in the
 * mocks: the sign-in frame (`AuthLayout`) with the managed screens' bordered-row cards, like the Whombats list. The
 * containers talk to control; the screens only show what they are given.
 */
import {
  BOX_SETUP_TEXT,
  billingRedirectUrl,
  COPY,
  type ControlApi,
  ControlError,
  type ControlSession,
  LINK_JOURNEY_STEPS,
  LINK_OPEN_FALLBACK_MS,
  type LinkAccount,
  type LinkAddressStage,
  type LinkCheckoutInput,
  type LinkCountryChoice,
  type LinkedBox,
  type LinkInterval,
  type LinkLookup,
  linkAccountErrorKey,
  linkAccountErrorText,
  linkBoxesInOrder,
  linkBoxLine,
  linkBoxOpenUrl,
  linkBoxTone,
  linkCheckoutBusyText,
  linkCheckoutInput,
  linkCountryGuess,
  linkCountryOptions,
  linkCountryReady,
  linkDiscountLine,
  linkNeedsBox,
  linkNotice,
  linkOpenPageInterval,
  linkPagePath,
  linkPlanAction,
  linkPlanActionText,
  linkPlanLine,
  linkPlanRuns,
  linkPlanTone,
  linkPriceLine,
  linkSubscribed,
  linkYearly,
  ownClaimPrefillHash,
  pollLinkAddress,
  pollLinkCheckout,
  SUBSCRIPTION_TERMS_VERSION,
  signInErrorText,
  WHOMBAT_LINK_TEXT as T,
} from '@whombat/client/managed';
import { normalizeLinkCode } from '@whombat/protocol';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { AuthLayout, type AuthStep } from '../app/auth/AuthLayout';
import { Button, ButtonLink } from '../components/Button';
import { Input } from '../components/Input';
import { SegmentedControl } from '../components/SegmentedControl';
import { StatusDot } from '../components/StatusDot';
import styles from './managed.module.css';
import { ErrorLine, Field, TermsCheck } from './screens';

/** As typed: upper case, the dash after four letters, nothing past eight. */
export function typedLinkCode(input: string): string {
  const letters = input
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label={T.code} hint={T.codeHint}>
      {(id) => (
        <Input
          id={id}
          size="lg"
          className={styles.codeInput}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-EFGH"
          value={value}
          onChange={(e) => onChange(typedLinkCode(e.target.value))}
        />
      )}
    </Field>
  );
}

/* `/link` signed out: the code and an email address, one form --------------------------------------------- */

export function LinkSignedOutScreen({
  initialCode,
  onSend,
}: {
  initialCode: string | null;
  /** Emails the sign-in link that comes back to `/link?code=…`. */
  onSend: (email: string, code: string | null) => Promise<void>;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    const typed = code ? normalizeLinkCode(code) : null;
    if (code && !typed) return setError(T.errors.badCode);
    setBusy(true);
    setError(null);
    try {
      await onSend(address, typed);
      setSent(address);
    } catch (err) {
      setError(signInErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <AuthLayout kicker={T.kicker} title={T.sentTitle} sub={T.sent(sent)} tip={T.tip}>
        <div className={styles.actions}>
          <Button variant="link" onClick={() => setSent(null)}>
            {T.again}
          </Button>
        </div>
      </AuthLayout>
    );
  return (
    <AuthLayout kicker={T.kicker} title={T.linkTitle} sub={T.signedOutSub} tip={T.tip}>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <CodeField value={code} onChange={setCode} />
        <Field label={T.email}>
          {(id) => (
            <Input
              id={id}
              type="email"
              size="lg"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {T.send}
          </Button>
        </div>
        <p className={styles.hint}>{T.trial}</p>
      </form>
    </AuthLayout>
  );
}

/* `/link` signed in: the code, which Whombat it is, confirm, what happens next ------------------------------ */

export type LinkStep =
  | { kind: 'enter' }
  | { kind: 'found'; lookup: LinkLookup; plan: LinkAccount['plan'] | null }
  | { kind: 'done'; box: LinkedBox; trial: boolean };

/**
 * After linking, the Whombat's own page: still waiting for its address or for its page to answer, waited long enough to
 * say so, or ready to open (`claim`: nobody has set it up yet, so its page opens by itself on the claim with the name and
 * email from here; `button`: the button shows, for a Whombat set up already or when the page didn't open by itself).
 */
export type LinkAddress =
  | { kind: 'waiting'; stage: LinkAddressStage }
  | { kind: 'slow' }
  | { kind: 'ready'; url: string; claim: boolean; button: boolean };

/**
 * While a new Whombat is linked, the link page is the setup's first step: the box's page that opens next carries on
 * this count (`done`: linked, waiting for that page).
 */
function linkJourney(done: boolean): { kicker: string; steps: AuthStep[] } {
  return {
    kicker: BOX_SETUP_TEXT.stepLabel(0, LINK_JOURNEY_STEPS.length),
    steps: LINK_JOURNEY_STEPS.map((s, i) => ({
      ...BOX_SETUP_TEXT.steps[s],
      state: i === 0 ? (done ? 'done' : 'current') : 'todo',
    })),
  };
}

/** The wait after linking, step by step, so the person sees it moving. */
function LinkProgress({ address }: { address: LinkAddress }) {
  const P = T.progress;
  const at = address.kind === 'ready' ? 3 : address.kind === 'waiting' && address.stage === 'page' ? 2 : 1;
  const items = [P.linked, P.address, P.page, P.open];
  return (
    <ol className={styles.progress} aria-label={T.addressWaiting} data-testid="link-progress">
      {items.map((text, i) => {
        const state = i < at ? 'done' : i === at && address.kind !== 'slow' ? 'current' : 'todo';
        return (
          <li key={text} className={styles.progressItem} data-state={state}>
            <span className={styles.progressMark} aria-hidden="true">
              {state === 'done' ? '✓' : null}
            </span>
            <span>{text}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface LinkCodeScreenProps {
  step: LinkStep;
  /** Where the linked Whombat's address stands (only once it is linked and its Link runs). */
  address?: LinkAddress | null;
  /** Waited long enough: ask control again. */
  onCheckAgain?: () => void;
  code: string;
  busy: boolean;
  error: string | null;
  /**
   * The box can't join without a card: the free month is full (`link_trial_boxes`, Add a card) or the plan has stopped
   * (`link_subscribe`, Subscribe). Both go to Checkout.
   */
  /** Checkout from here, for the country chosen beside the button (4.10). */
  onAddCard: { label: string; go: (country: string) => void } | null;
  onCode: (code: string) => void;
  onFind: () => void;
  /** `agreed`: the Subscription Terms were ticked (asked only when the lookup named a version). */
  onConfirm: (agreed: boolean) => void;
  onOtherCode: () => void;
  onAccount: () => void;
}

export function LinkCodeScreen(props: LinkCodeScreenProps) {
  const { step, code, busy, error, onCode, onFind, onConfirm, onOtherCode, onAccount, onAddCard } = props;
  const [agreed, setAgreed] = useState(false);
  const [country, setCountry] = useState<LinkCountryChoice>(guessCountry);
  const errorLine = (
    <>
      <ErrorLine text={error} />
      {onAddCard && (
        <>
          <div className={styles.card}>
            <CountryRow as="div" value={country} onChange={setCountry} />
          </div>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="lg"
              disabled={!linkCountryReady(country)}
              onClick={() => linkCountryReady(country) && onAddCard.go(country)}
            >
              {onAddCard.label}
            </Button>
          </div>
        </>
      )}
    </>
  );
  if (step.kind === 'done') {
    const name = step.box.name ?? T.yourWhombatTitle;
    const runs = linkedBoxRuns(step.box);
    const { address = null, onCheckAgain } = props;
    const ready = address?.kind === 'ready' ? address : null;
    const sub = !runs
      ? T.doneNeedsPlan
      : !address
        ? T.doneNext
        : address.kind === 'waiting'
          ? T.addressWaiting
          : address.kind === 'slow'
            ? T.addressSlow
            : address.claim
              ? T.addressOpening
              : T.addressOpen;
    // A new Whombat: this page was the setup's first step, and its own page carries on the count.
    const journey = runs && step.box.name === null ? linkJourney(true) : null;
    return (
      <AuthLayout
        kicker={journey?.kicker ?? T.kicker}
        title={T.doneTitle(name)}
        sub={<span role="status">{sub}</span>}
        tip={T.tip}
        {...(journey && { steps: journey.steps })}
      >
        {address && address.kind !== 'slow' && (ready === null || ready.claim) && (
          <LinkProgress address={address} />
        )}
        {step.trial && <p className={styles.status}>{T.trial}</p>}
        <div className={styles.actions}>
          {ready?.button && (
            <ButtonLink variant="primary" size="lg" href={ready.url} data-testid="link-claim-now">
              {ready.claim ? T.claimNow : T.openName(name)}
            </ButtonLink>
          )}
          {address?.kind === 'slow' && onCheckAgain && (
            <Button variant="secondary" size="lg" onClick={onCheckAgain}>
              {T.checkAgain}
            </Button>
          )}
          <Button variant={ready || address ? 'link' : 'primary'} size="lg" onClick={onAccount}>
            {T.toAccount}
          </Button>
        </div>
        {ready?.claim && ready.button && <p className={styles.hint}>{T.openNotYet}</p>}
      </AuthLayout>
    );
  }
  if (step.kind === 'found') {
    const { lookup, plan } = step;
    const name = lookup.name ?? T.yourWhombat;
    const runs = plan ? linkPlanRuns(plan) : false;
    const price = plan ? linkPriceLine(plan) : T.priceMonth;
    const after = lookup.trial ? T.trial : runs ? `${T.joins} ${price}` : `${T.needsPlan} ${price}`;
    // A control that asks for the terms names their version; an older one takes none.
    const askTerms = !lookup.linked && lookup.termsVersion !== undefined;
    // A Whombat nobody set up yet (it has no name): linking it is the setup's first step.
    const journey = !lookup.linked && lookup.name === null ? linkJourney(false) : null;
    return (
      <AuthLayout
        kicker={journey?.kicker ?? T.kicker}
        title={lookup.linked ? T.alreadyTitle(lookup.name ?? T.yourWhombatTitle) : T.confirmTitle(name)}
        sub={lookup.name || lookup.linked ? T.what : `${T.showing(lookup.code)} ${T.what}`}
        tip={T.tip}
        {...(journey && { steps: journey.steps })}
      >
        {!lookup.linked && (
          <div className={styles.notice} data-testid="link-terms">
            <p>{after}</p>
          </div>
        )}
        {askTerms && (
          <TermsCheck
            checked={agreed}
            onChange={setAgreed}
            agree={T.termsAgree}
            link={T.termsLink}
            href="/legal/subscription-terms"
          />
        )}
        {errorLine}
        <div className={styles.actions}>
          {lookup.linked ? (
            <Button variant="primary" size="lg" onClick={onAccount}>
              {T.toAccount}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              disabled={busy || (askTerms && !agreed)}
              onClick={() => onConfirm(askTerms && agreed)}
            >
              {busy ? T.confirming : T.confirm}
            </Button>
          )}
          <Button variant="link" onClick={onOtherCode}>
            {T.otherCode}
          </Button>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout kicker={T.kicker} title={T.linkTitle} sub={T.linkSub} tip={T.tip}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          onFind();
        }}
      >
        <CodeField value={code} onChange={onCode} />
        {errorLine}
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !code}>
            {busy ? T.finding : T.find}
          </Button>
          <Button variant="link" onClick={onAccount}>
            {T.toAccount}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/** Sends the browser to Stripe, and only there (AP-160); anything else is refused like a failed request. */
function goToStripe(url: string, alsoOrigins: readonly string[] | undefined) {
  const to = billingRedirectUrl(url, alsoOrigins);
  if (!to) throw new Error('not a Stripe page');
  window.location.assign(to);
}

/** The refusals a card at Checkout answers, with the button that goes there. */
const CARD_BUTTON: Partial<Record<string, string>> = {
  link_trial_boxes: T.addCard,
  link_subscribe: T.subscribe,
};

/**
 * Stripe's payment page for Link, the one way to start paying (`onPage` hears of it before the browser goes there). When
 * Stripe has the subscription already, Checkout answers `subscription_exists` and the portal opens instead.
 */
async function toCheckout(
  control: ControlApi,
  alsoOrigins: readonly string[] | undefined,
  input?: LinkCheckoutInput,
  onPage?: () => void,
) {
  if (!control.linkCheckout || !control.linkPortal) throw new ControlError('unavailable', 'No Link here.');
  try {
    const page = await control.linkCheckout(input);
    onPage?.();
    goToStripe(page.url, alsoOrigins);
  } catch (e) {
    if (!(e instanceof ControlError) || e.code !== 'subscription_exists') throw e;
    goToStripe((await control.linkPortal(input?.terms)).url, alsoOrigins);
  }
}

/** A linked Whombat whose Link runs gets its own address; an ended or switched-off one doesn't. */
function linkedBoxRuns(box: Pick<LinkedBox, 'state'>): boolean {
  return box.state !== 'ended' && box.state !== 'off';
}

/** Opens the Whombat's page in this tab. */
function openInThisTab(url: string) {
  window.location.assign(url);
}

/**
 * Once a Whombat is linked: waits for its own address (`pollLinkAddress`), and stops when the page closes or the step
 * changes. A Whombat nobody set up yet (an Easy box links before its setup asks for one) opens by itself on its claim:
 * its claim link when control has it, so only the four letters on its screen are left to type, with the account's name
 * and email in the fragment, which never reaches a server, and the mark that the setup's count goes on from here. The
 * button shows only if the page is still here a while later (the browser didn't go). A Whombat set up already isn't
 * opened unasked: its owner chooses.
 */
function useLinkAddress(
  control: ControlApi,
  step: LinkStep,
  session: ControlSession | undefined,
  open: (url: string) => void,
): { address: LinkAddress | null; checkAgain: () => void } {
  const [address, setAddress] = useState<LinkAddress | null>(null);
  const [run, setRun] = useState(0);
  const device = step.kind === 'done' && linkedBoxRuns(step.box) ? step.box.device : null;
  const name = session?.account.name ?? '';
  const email = session?.account.email ?? '';
  const opener = useRef(open);
  opener.current = open;
  useEffect(() => {
    const load = control.linkAccount;
    if (!device || !load || run < 0) return setAddress(null);
    let live = true;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    setAddress({ kind: 'waiting', stage: 'address' });
    const onStage = (stage: LinkAddressStage) =>
      setAddress((now) =>
        now?.kind === 'waiting' && now.stage === stage ? now : { kind: 'waiting', stage },
      );
    void pollLinkAddress({ device, load: () => load(), onStage, live: () => live }).then((out) => {
      if (!live || out === 'stopped') return;
      if (out === 'timeout') return setAddress({ kind: 'slow' });
      if (!out.claim) return setAddress({ kind: 'ready', url: out.url, claim: false, button: true });
      const url = `${out.url}${ownClaimPrefillHash({ name, email, fromLink: true })}`;
      setAddress({ kind: 'ready', url, claim: true, button: false });
      fallback = setTimeout(
        () => live && setAddress({ kind: 'ready', url, claim: true, button: true }),
        LINK_OPEN_FALLBACK_MS,
      );
      opener.current(url);
    });
    return () => {
      live = false;
      clearTimeout(fallback);
    };
  }, [control, device, run, name, email]);
  return { address, checkAgain: () => setRun((n) => n + 1) };
}

export function LinkCodeFlow({
  control,
  session,
  initialCode,
  billingRedirectOrigins,
  onAccount,
  openPage = openInThisTab,
}: {
  control: ControlApi;
  /** Who is signed in: their name and email go along to the claim on the Whombat's own page. */
  session?: ControlSession;
  initialCode: string | null;
  billingRedirectOrigins?: readonly string[];
  onAccount: () => void;
  /** Opens a new Whombat's page once it answers (this tab; tests pass their own). */
  openPage?: (url: string) => void;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [step, setStep] = useState<LinkStep>({ kind: 'enter' });
  const { address, checkAgain } = useLinkAddress(control, step, session, openPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCard, setNeedsCard] = useState<string | null>(null);
  // The terms ticked at the confirm go along to Checkout when a card is needed (an account may have none yet).
  const [agreedTerms, setAgreedTerms] = useState(false);
  const find = async (typed: string) => {
    const normal = normalizeLinkCode(typed);
    if (!normal) return setError(T.errors.badCode);
    if (!control.linkLookup) return setError(T.errors.unavailable);
    setBusy(true);
    setError(null);
    setNeedsCard(null);
    try {
      const [lookup, account] = await Promise.all([
        control.linkLookup(normal),
        control.linkAccount?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      setStep({ kind: 'found', lookup, plan: account?.plan ?? null });
    } catch (e) {
      setError(linkAccountErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  // A code in the address (the box's screen, or the sign-in link coming back): looked up at once.
  const looked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the code the page opened with
  useEffect(() => {
    if (looked.current || !initialCode) return;
    looked.current = true;
    void find(initialCode);
  }, [initialCode]);
  const confirm = async (agreed: boolean) => {
    if (step.kind !== 'found' || !control.linkConfirm) return;
    setBusy(true);
    setError(null);
    try {
      // The terms this site shows; control refuses another version (`terms_outdated`: reload the page).
      const terms = agreed ? { version: SUBSCRIPTION_TERMS_VERSION } : undefined;
      setAgreedTerms(agreed);
      const box = await control.linkConfirm(step.lookup.code, terms);
      setStep({ kind: 'done', box, trial: step.lookup.trial });
    } catch (e) {
      setError(linkAccountErrorText(e));
      setNeedsCard(e instanceof ControlError ? (CARD_BUTTON[e.code] ?? null) : null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <LinkCodeScreen
      step={step}
      address={address}
      onCheckAgain={checkAgain}
      code={code}
      busy={busy}
      error={error}
      onAddCard={
        needsCard
          ? {
              label: needsCard,
              go: (country: string) =>
                void toCheckout(
                  control,
                  billingRedirectOrigins,
                  {
                    ...(agreedTerms && { terms: { version: SUBSCRIPTION_TERMS_VERSION } }),
                    country,
                  },
                  () => keepOpenPage('month'),
                ).catch((e: unknown) => setError(linkAccountErrorText(e))),
            }
          : null
      }
      onCode={setCode}
      onFind={() => void find(code)}
      onConfirm={(agreed) => void confirm(agreed)}
      onOtherCode={() => {
        setStep({ kind: 'enter' });
        setCode('');
        setError(null);
        setNeedsCard(null);
        window.history.replaceState(null, '', linkPagePath(null));
      }}
      onAccount={onAccount}
    />
  );
}

/* Where the person lives, before the payment page ---------------------------------------------------------- */

/** The browser's own English names of countries; none where it has no `Intl.DisplayNames` (the code shows then). */
function countryNames(): (code: string) => string | undefined {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return (code) => names.of(code);
  } catch {
    return () => undefined;
  }
}

/** The country the choice starts on: this device's time zone's, when Link is sold there. */
function guessCountry(): LinkCountryChoice {
  try {
    return linkCountryGuess(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return '';
  }
}

/**
 * Where the person lives, asked before the payment page opens: Whombat Link is sold in EU countries only for now, so
 * “Another country” says so here instead of a refused payment. A business's VAT number goes on the payment page.
 */
function CountryRow({
  value,
  onChange,
  disabled,
  as: Tag = 'li',
}: {
  value: LinkCountryChoice;
  onChange: (country: LinkCountryChoice) => void;
  disabled?: boolean;
  as?: 'li' | 'div';
}) {
  const id = useId();
  const noteId = useId();
  const [options] = useState(() => linkCountryOptions(countryNames()));
  const outside = value === 'other';
  return (
    <Tag className={`${styles.row} ${styles.rowWrap}`} data-row="country">
      <span className={styles.countryLabel}>
        <label htmlFor={id}>{T.country}</label>
        <select
          id={id}
          className={styles.select}
          value={value}
          disabled={disabled}
          aria-describedby={noteId}
          onChange={(e) => onChange(e.target.value as LinkCountryChoice)}
        >
          <option value="" disabled>
            {T.countryChoose}
          </option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
          <option value="other">{T.countryOther}</option>
        </select>
      </span>
      {outside ? (
        <span className={styles.countryOutside} id={noteId} role="status">
          {T.countryOutside}
        </span>
      ) : (
        <span className={styles.hint} id={noteId}>
          {T.vatNumber}
        </span>
      )}
    </Tag>
  );
}

/* Your Whombats: the Link subscription and each Whombat's Link -------------------------------------------- */

/** What the plan's button sends: how to pay, a code typed here, and the terms once control asked for them. */
export interface LinkPlanChoice {
  /** Checkout (to start paying) or the portal (a subscription Stripe has, with a card on file). */
  via: 'checkout' | 'portal';
  interval: LinkInterval;
  terms?: { version: string };
  /** Where the person lives (Checkout only): a country Link is sold in. */
  country?: string;
}

export interface LinkAccountScreenProps {
  session: ControlSession;
  /** Null while loading; `error` when it couldn't be loaded. */
  account: LinkAccount | null | 'error';
  /** Back from Stripe Checkout: waiting for the subscription, waited a minute, or it shows. */
  checkout: 'waiting' | 'slow' | 'done' | null;
  onRetry: () => void;
  /** Resolve after the browser was sent on; reject with control's refusal. `interval`: what Checkout charges. */
  onPlan: (choice: LinkPlanChoice) => Promise<void>;
  /** The Whombat this device opened last (it comes first), and the one opened now. */
  lastOpened: string | null;
  /** The interval of a payment page this browser opened that may still be open (31 minutes), or null. */
  openPage?: LinkInterval | null;
  onOpen: (box: LinkedBox) => void;
  /** Resolves to why it failed, or null. */
  onRemove: (box: LinkedBox) => Promise<string | null>;
  onLink: () => void;
  /** The Whombats this site still opens (an organization made before Link). */
  onOpenHere?: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}

export function LinkAccountScreen(props: LinkAccountScreenProps) {
  const { session, account, checkout, onRetry, onLink, onOpenHere, onSignOut, onDeleteAccount } = props;
  const footer = (
    <div className={styles.actions}>
      <Button variant="primary" size="lg" onClick={onLink}>
        {T.linkEntry}
      </Button>
      {onOpenHere && (
        <Button variant="link" onClick={onOpenHere}>
          {T.openHere}
        </Button>
      )}
      <Button variant="link" onClick={onSignOut}>
        {COPY.appliances.signOut}
      </Button>
      <span className={styles.hint}>{session.account.email}</span>
      <Button variant="link" onClick={onDeleteAccount}>
        {COPY.account.deleteEntry}
      </Button>
    </div>
  );
  const frame = (children: React.ReactNode) => (
    <AuthLayout kicker={T.kicker} title={T.accountTitle} sub={T.accountSub} tip={T.tip}>
      {children}
    </AuthLayout>
  );
  if (checkout === 'waiting' || checkout === 'slow')
    return frame(
      <>
        <p className={styles.status} role="status">
          {checkout === 'waiting' ? T.settingUp : T.slow}
        </p>
        {checkout === 'slow' && (
          <div className={styles.actions}>
            <Button variant="primary" size="lg" onClick={onRetry}>
              {T.checkAgain}
            </Button>
          </div>
        )}
      </>,
    );
  if (account === 'error')
    return frame(
      <>
        <ErrorLine text={T.loadFailed} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" onClick={onRetry}>
            {T.retry}
          </Button>
        </div>
      </>,
    );
  if (!account) return frame(null);
  const notice = checkout === 'done' && linkSubscribed(account.plan) ? T.subscribed : linkNotice(account);
  // One Whombat with a working address: the page leads with opening it.
  const only = account.boxes.length === 1 ? account.boxes[0] : undefined;
  const onlyUrl = only ? linkBoxOpenUrl(only) : null;
  return frame(
    <>
      {notice && (
        <div className={styles.notice} role="status" data-testid="link-notice">
          <p>{notice}</p>
        </div>
      )}
      {only && onlyUrl && (
        <div className={styles.actions}>
          <ButtonLink
            variant="primary"
            size="xl"
            href={onlyUrl}
            className={styles.openOnly}
            data-testid="link-open-only"
            onClick={() => props.onOpen(only)}
          >
            {T.openName(only.name ?? T.yourWhombatTitle)}
          </ButtonLink>
        </div>
      )}
      <PlanCard {...props} account={account} />
      <BoxList {...props} account={account} />
      {footer}
    </>,
  );
}

function PlanCard({ account, onPlan, openPage }: LinkAccountScreenProps & { account: LinkAccount }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A payment page this browser opened may still be open: its interval first, so asking again answers that page.
  const [payBy, setPayBy] = useState<LinkInterval>(openPage ?? 'month');
  // `checkout_busy` for another interval while that page is open: the way back to it.
  const [backTo, setBackTo] = useState<LinkInterval | null>(null);
  const hintId = useId();
  // The Subscription Terms are asked for only once control says the account has accepted none (`terms_required`).
  const [askTerms, setAskTerms] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // The portal said Stripe has no subscription yet (`no_subscription`): the card offers Subscribe instead.
  const [noSubscription, setNoSubscription] = useState(false);
  const { plan } = account;
  const planAction = linkPlanAction(plan);
  const action = noSubscription && planAction === 'manage' ? 'subscribe' : planAction;
  const line = linkPlanLine(plan);
  const discount = linkDiscountLine(plan);
  const price = plan.state === 'comp' ? null : linkPriceLine(plan);
  // Nothing to pay for without a linked Whombat: no Subscribe, one line to link one (the free month starts then).
  const needsBox = linkNeedsBox(plan, action);
  // Paying starts on Stripe's page, by the month or the year chosen here, with Stripe's own field for a code; once
  // subscribed, the portal changes it.
  const toCheckout = action !== null && action !== 'manage' && !needsBox;
  const choose = toCheckout && linkYearly(plan);
  // Where the person lives, before Checkout: Link is sold in EU countries only (4.10).
  const [country, setCountry] = useState<LinkCountryChoice>(guessCountry);
  const go = async (interval: LinkInterval = payBy) => {
    setBusy(true);
    setError(null);
    setBackTo(null);
    try {
      await onPlan({
        via: action === 'manage' ? 'portal' : 'checkout',
        interval,
        ...(askTerms && agreed && { terms: { version: SUBSCRIPTION_TERMS_VERSION } }),
        ...(toCheckout && linkCountryReady(country) && { country }),
      });
    } catch (e) {
      const key = linkAccountErrorKey(e);
      if (key === 'terms_required') setAskTerms(true);
      if (key === 'no_subscription') setNoSubscription(true);
      if (key === 'checkout_busy') {
        // A page for the other interval is open until the time control names: only that interval gets it back.
        setError(linkCheckoutBusyText(e));
        if (openPage && openPage !== interval) setBackTo(openPage);
      } else setError(linkAccountErrorText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <ul className={styles.card} aria-label={T.plan}>
        <li className={`${styles.row} ${styles.rowWrap}`}>
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{T.plan}</span>
            <span className={styles.rowMeta}>
              <StatusDot tone={linkPlanTone(plan)} size={8} label={line} /> {line}
            </span>
            {discount && (
              <span className={styles.rowMeta} data-testid="link-discount">
                {discount}
              </span>
            )}
            {price && (
              <span className={styles.rowMeta} data-testid="link-price">
                {plan.state === 'none' && plan.trialAvailable ? `${T.trial} ${price}` : price}
              </span>
            )}
          </div>
          {action && !needsBox && (
            <Button
              variant={action === 'manage' ? 'secondary' : 'primary'}
              size="sm"
              disabled={busy || (askTerms && !agreed) || (toCheckout && !linkCountryReady(country))}
              onClick={() => void go()}
            >
              {busy ? T.opening : linkPlanActionText(action)}
            </Button>
          )}
        </li>
        {needsBox && (
          <li className={styles.row} data-row="needs-box">
            <span className={styles.rowMeta}>{plan.trialAvailable ? T.needsBox : T.needsBoxAgain}</span>
          </li>
        )}
        {choose && (
          <li className={`${styles.row} ${styles.rowWrap}`} data-row="interval">
            <SegmentedControl
              size="sm"
              label={T.interval}
              describedBy={hintId}
              disabled={busy}
              value={payBy}
              onChange={setPayBy}
              options={[
                { value: 'month', label: T.month },
                { value: 'year', label: T.year },
              ]}
            />
            <span className={styles.hint} id={hintId}>
              {T.haveCode}
            </span>
          </li>
        )}
        {toCheckout && <CountryRow value={country} onChange={setCountry} disabled={busy} />}
      </ul>
      {askTerms && (
        <TermsCheck
          checked={agreed}
          onChange={setAgreed}
          agree={T.termsAgree}
          link={T.termsLink}
          href="/legal/subscription-terms"
        />
      )}
      <ErrorLine text={error} />
      {backTo && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setPayBy(backTo);
              void go(backTo);
            }}
          >
            {T.backToPage(backTo === 'year' ? T.year : T.month)}
          </Button>
        </div>
      )}
    </>
  );
}

function BoxList({
  account,
  onRemove,
  lastOpened,
  onOpen,
}: LinkAccountScreenProps & { account: LinkAccount }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (account.boxes.length === 0) return <p className={styles.status}>{T.noBoxes}</p>;
  const remove = async (box: LinkedBox) => {
    setBusy(true);
    setError(null);
    const failed = await onRemove(box);
    setBusy(false);
    if (failed) setError(failed);
    else setRemoving(null);
  };
  return (
    <>
      <ul className={styles.card} aria-label={T.accountTitle}>
        {linkBoxesInOrder(account.boxes, lastOpened).map((box) => {
          const name = box.name ?? T.yourWhombatTitle;
          const line = linkBoxLine(box, account.plan);
          // With one Whombat the big Open above leads; the row doesn't repeat it.
          const open = account.boxes.length > 1 ? linkBoxOpenUrl(box) : null;
          if (removing === box.device)
            return (
              <li key={box.device} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowMeta}>{T.removeConfirm(name)}</span>
                </div>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void remove(box)}>
                  {busy ? T.removing : T.removeIt}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(null)}>
                  {T.cancel}
                </Button>
              </li>
            );
          return (
            <li key={box.device} className={`${styles.row} ${styles.rowWrap}`} data-link-state={box.state}>
              <StatusDot tone={linkBoxTone(box)} size={8} label={line} />
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>{name}</span>
                <span className={styles.rowMeta}>
                  {line}
                  {box.host && box.state !== 'ended' && ` · ${box.host}`}
                </span>
              </div>
              {open && (
                <ButtonLink
                  variant="primary"
                  size="sm"
                  href={open}
                  aria-label={T.openName(name)}
                  onClick={() => onOpen(box)}
                >
                  {T.open}
                </ButtonLink>
              )}
              {box.state !== 'off' && (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={T.removeLabel(name)}
                  onClick={() => {
                    setError(null);
                    setRemoving(box.device);
                  }}
                >
                  {T.remove}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorLine text={error} />
    </>
  );
}

/** Which Whombat this device opened last from here: this browser's own convenience, so a blocked store is no loss. */
const LAST_OPENED_KEY = 'whombat:link:last-opened';

function readLastOpened(): string | null {
  try {
    return window.localStorage.getItem(LAST_OPENED_KEY);
  } catch {
    return null;
  }
}

/** The payment page this browser opened last (its interval and when), so asking again for it answers that page. */
const OPEN_PAGE_KEY = 'whombat:link:payment-page';

function readOpenPage(): LinkInterval | null {
  try {
    return linkOpenPageInterval(JSON.parse(window.localStorage.getItem(OPEN_PAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function keepOpenPage(interval: LinkInterval) {
  try {
    window.localStorage.setItem(OPEN_PAGE_KEY, JSON.stringify({ interval, at: Date.now() }));
  } catch {
    // Private windows and blocked site data: control still answers the same interval with the same page.
  }
}

function writeLastOpened(device: string) {
  try {
    window.localStorage.setItem(LAST_OPENED_KEY, device);
  } catch {
    // Private windows and blocked site data: the list keeps control's order.
  }
}

/**
 * `/account` and `/billing`: loads the account's Link, sends the browser to Stripe, and back from Checkout
 * (`?checkout=done`) asks every 2 s for up to a minute until the subscription shows (webhooks can lag).
 */
export function LinkAccountFlow({
  control,
  session,
  billingRedirectOrigins,
  onLink,
  onOpenHere,
  onSignOut,
  onDeleteAccount,
}: {
  control: ControlApi;
  session: ControlSession;
  billingRedirectOrigins?: readonly string[];
  onLink: () => void;
  onOpenHere?: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}) {
  const [account, setAccount] = useState<LinkAccount | null | 'error'>(null);
  const [checkout, setCheckout] = useState<'waiting' | 'slow' | 'done' | null>(() =>
    new URLSearchParams(window.location.search).get('checkout') === 'done' ? 'waiting' : null,
  );
  const [run, setRun] = useState(0);
  const [lastOpened, setLastOpened] = useState<string | null>(readLastOpened);
  const [openPage] = useState<LinkInterval | null>(readOpenPage);
  const checkoutNow = useRef(checkout);
  checkoutNow.current = checkout;
  useEffect(() => {
    let live = true;
    const load = control.linkAccount;
    if (!load) {
      setAccount('error');
      return;
    }
    if (run >= 0 && (checkoutNow.current === 'waiting' || checkoutNow.current === 'slow')) {
      setCheckout('waiting');
      void pollLinkCheckout({ load: () => load(), onAccount: setAccount, live: () => live }).then((out) => {
        if (!live || out === 'stopped') return;
        if (out === 'timeout') return setCheckout('slow');
        setCheckout('done');
        // The address no longer says it came back from Checkout (a reload doesn't wait again).
        window.history.replaceState(null, '', window.location.pathname);
      });
    } else
      load().then(
        (a) => live && setAccount(a),
        () => live && setAccount('error'),
      );
    return () => {
      live = false;
    };
  }, [control, run]);
  const plan = async (choice: LinkPlanChoice) => {
    if (account === null || account === 'error') return;
    if (choice.via === 'portal') {
      if (!control.linkPortal) throw new ControlError('unavailable', 'No Link here.');
      goToStripe((await control.linkPortal(choice.terms)).url, billingRedirectOrigins);
    } else
      await toCheckout(control, billingRedirectOrigins, linkCheckoutInput(account.plan, choice), () =>
        keepOpenPage(choice.interval),
      );
  };
  return (
    <LinkAccountScreen
      session={session}
      account={account}
      checkout={checkout}
      onRetry={() => {
        if (checkout !== 'slow') setAccount(null);
        setRun((n) => n + 1);
      }}
      onPlan={plan}
      lastOpened={lastOpened}
      openPage={openPage}
      onOpen={(box) => {
        setLastOpened(box.device);
        writeLastOpened(box.device);
      }}
      onRemove={async (box) => {
        if (!control.linkRemove) return T.errors.unavailable;
        try {
          setAccount(await control.linkRemove(box.device));
          return null;
        } catch (e) {
          return linkAccountErrorText(e);
        }
      }}
      onLink={onLink}
      {...(onOpenHere && { onOpenHere })}
      onSignOut={onSignOut}
      onDeleteAccount={onDeleteAccount}
    />
  );
}
