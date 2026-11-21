/**
 * `/billing` (BL-13, BL-15…BL-18, AP-129): the plan cards while the organization waits for a plan, the subscription
 * once there is one, and a plan Whombat manages (the org's one account acts on it, CT-1561). Not in the
 * mocks: the sign-in frame (`AuthLayout`) with the managed screens' bordered-row cards, the onboarding choice cards
 * for the plans. Presentational: the container talks to control and passes what happened in.
 */
import {
  BILLING_WHOMBATS_MAX,
  BILLING_WHOMBATS_MIN,
  type BillingView,
  billingErrorText,
  billingPageOf,
  billingStateLine,
  billingTone,
  COPY,
  canClaimMore,
  clampWhombats,
  planCardText,
  planTotalText,
  type SignupInfo,
} from '@whombat/client/managed';
import { type FormEvent, useId, useState } from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { StatusDot } from '../components/StatusDot';
import styles from './managed.module.css';
import { ErrorLine } from './screens';

const T = COPY.billing;

export interface BillingScreenProps {
  /** Null while loading; `error` when it couldn't be loaded. */
  view: BillingView | null | 'error';
  /** The public plans and the trial length (`signup.info`). */
  info: SignupInfo | null;
  /** Back from Stripe Checkout (`?checkout=done`): waiting for the subscription, or waited a minute. */
  checkout: 'waiting' | 'slow' | null;
  onRetry: () => void;
  /** Resolve after the browser was sent on; reject with control's refusal. */
  onCheckout: (plan: string, whombats: number) => Promise<void>;
  onPortal: () => Promise<void>;
  onAddWhombat: (count: number) => Promise<void>;
  onClaim: () => void;
  onBack: () => void;
}

export function BillingScreen(props: BillingScreenProps) {
  const { view, checkout, onRetry, onBack } = props;
  const back = (
    <Button variant="link" onClick={onBack}>
      {T.back}
    </Button>
  );
  if (checkout)
    return (
      <AuthLayout kicker={T.kicker} title={T.title} tip={T.tip}>
        {checkout === 'waiting' ? (
          <p className={styles.status} role="status">
            {T.settingUp}
          </p>
        ) : (
          <>
            <p className={styles.status} role="status">
              {T.slow}
            </p>
            <div className={styles.actions}>
              <Button variant="primary" size="lg" onClick={onRetry}>
                {T.checkAgain}
              </Button>
              {back}
            </div>
          </>
        )}
      </AuthLayout>
    );
  if (view === 'error')
    return (
      <AuthLayout kicker={T.kicker} title={T.title} tip={T.tip}>
        <ErrorLine text={T.loadFailed} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" onClick={onRetry}>
            {T.retry}
          </Button>
          {back}
        </div>
      </AuthLayout>
    );
  if (!view) return <AuthLayout kicker={T.kicker} title={T.title} tip={T.tip} />;
  const page = billingPageOf(view);
  if (page === 'choose') return <ChoosePlan {...props} view={view} />;
  return (
    <AuthLayout kicker={T.kicker} title={T.title} sub={page === 'manual' ? T.managed : undefined} tip={T.tip}>
      {view.plan && <Summary view={view} onAddWhombat={page === 'subscribed' ? props.onAddWhombat : null} />}
      {page === 'subscribed' ? (
        <Subscribed {...props} view={view} />
      ) : (
        <div className={styles.actions}>{back}</div>
      )}
    </AuthLayout>
  );
}

/** Plan, state and Whombats as bordered rows; “Add a Whombat” confirms the charge inline. */
function Summary({
  view,
  onAddWhombat,
}: {
  view: BillingView;
  onAddWhombat: ((count: number) => Promise<void>) | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone = billingTone(view);
  const state = billingStateLine(view);
  const next = view.whombats.paid + 1;
  const add = async () => {
    if (!onAddWhombat) return;
    setBusy(true);
    setError(null);
    try {
      await onAddWhombat(next);
      setConfirming(false);
    } catch (e) {
      setError(billingErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ul className={styles.card} aria-label={T.title}>
        <li className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{view.plan?.name}</span>
            <span className={styles.rowMeta}>
              <StatusDot tone={tone} size={8} label={state} />
              {state}
            </span>
          </div>
        </li>
        <li className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{T.whombats}</span>
            <span className={styles.rowMeta}>{T.whombatsOf(view.whombats.claimed, view.whombats.paid)}</span>
          </div>
          {onAddWhombat && !confirming && (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              {T.addWhombat}
            </Button>
          )}
        </li>
        {confirming && (
          <li className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.rowMeta}>{T.addConfirm(next)}</span>
            </div>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void add()}>
              {busy ? T.adding : T.add}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              {T.cancel}
            </Button>
          </li>
        )}
      </ul>
      <ErrorLine text={error} />
    </>
  );
}

/** A Stripe subscription: Manage billing (the portal), and Claim a Whombat while there is room for one. */
function Subscribed({ view, onPortal, onClaim, onBack }: BillingScreenProps & { view: BillingView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const room = canClaimMore(view);
  const portal = async () => {
    setBusy(true);
    setError(null);
    try {
      await onPortal();
    } catch (e) {
      setError(billingErrorText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <ErrorLine text={error} />
      <div className={styles.actions}>
        {room && (
          <Button variant="primary" size="lg" onClick={onClaim}>
            {T.claim}
          </Button>
        )}
        <Button
          variant={room ? 'secondary' : 'primary'}
          size="lg"
          disabled={busy}
          onClick={() => void portal()}
        >
          {busy ? T.opening : T.manage}
        </Button>
        <Button variant="link" onClick={onBack}>
          {T.back}
        </Button>
      </div>
    </>
  );
}

/**
 * Waiting for a plan, or a subscription that ended: the public plans as choice cards (from `signup.info`, never
 * hard-coded), the Whombats stepper (1…50), the total, and the trial or Subscribe button, which goes to Stripe.
 */
function ChoosePlan({ view, info, onCheckout, onBack }: BillingScreenProps & { view: BillingView }) {
  const plans = info?.plans ?? [];
  const [plan, setPlan] = useState(() => plans[0]?.id ?? '');
  const [count, setCount] = useState(() => clampWhombats(Math.max(1, view.whombats.claimed)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const chosen = plans.find((p) => p.id === plan) ?? null;
  const days = info?.trialDays ?? 14;
  const trial = view.trialAvailable;
  const ended = !view.setupRequired && view.state === 'cancelled';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await onCheckout(chosen.id, count);
    } catch (err) {
      setError(billingErrorText(err));
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      kicker={T.kicker}
      title={ended ? T.endedTitle : T.chooseTitle}
      sub={ended ? T.endedSub : trial ? T.chooseSub(days) : T.chooseSubNoTrial}
      tip={T.tip}
    >
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <fieldset className={styles.plans}>
          <legend className={styles.visuallyHidden}>{T.plans}</legend>
          {plans.map((p) => {
            const text = planCardText(p);
            return (
              <label key={p.id} className={styles.plan} data-selected={p.id === plan}>
                <input
                  type="radio"
                  name={name}
                  value={p.id}
                  className={styles.planRadio}
                  checked={p.id === plan}
                  onChange={() => setPlan(p.id)}
                />
                <span className={styles.planName}>{text.name}</span>
                <span className={styles.planPrice}>{text.price}</span>
                <span className={styles.planMeta}>{text.extras}</span>
              </label>
            );
          })}
        </fieldset>
        <fieldset className={styles.bareSet}>
          <legend className={styles.label}>{T.whombats}</legend>
          <div className={styles.stepper}>
            <Button
              variant="secondary"
              size="md"
              className={styles.stepButton}
              aria-label={T.fewer}
              disabled={count <= BILLING_WHOMBATS_MIN}
              onClick={() => setCount((n) => clampWhombats(n - 1))}
            >
              −
            </Button>
            <output className={styles.stepperValue} aria-live="polite">
              {count}
            </output>
            <Button
              variant="secondary"
              size="md"
              className={styles.stepButton}
              aria-label={T.more}
              disabled={count >= BILLING_WHOMBATS_MAX}
              onClick={() => setCount((n) => clampWhombats(n + 1))}
            >
              +
            </Button>
            {chosen && <span className={styles.total}>{planTotalText(chosen, count)}</span>}
          </div>
        </fieldset>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !chosen}>
            {busy ? T.toCheckout : trial ? T.startTrial(days) : T.subscribe}
          </Button>
          <Button variant="link" onClick={onBack}>
            {T.back}
          </Button>
        </div>
        <p className={styles.hint}>{trial ? T.finePrintTrial : T.finePrint}</p>
      </form>
    </AuthLayout>
  );
}
