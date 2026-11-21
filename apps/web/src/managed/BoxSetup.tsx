/**
 * The one setup on a box's own page (Whombat docs/decisions/whombat-link.md LNK-40; it replaces the community and the
 * own-address setups): nobody claimed this box yet, so the page that opened it claims it. In onboarding's frame (the
 * aside with the numbered steps and the agent's tip, the kicker, the title, the footer's buttons):
 *
 * 1. **Claim your Whombat** — the four letters on its screen; at its own address with the claim link's secret from
 *    `/c/<secret>` (`runLocalClaim`: CPace bound to both Noise keys, the box's tag checked). A wrong guess comes back
 *    here, with the new letters the box shows.
 * 2. **Who are you?** — name and email, kept on the box; Claim it runs the claim.
 * 3. At the box's own address, **Make its passkey** (two touches; the passkey is that address's). Elsewhere (its
 *    Tailscale page, a developer's machine) **Reach it from anywhere**: Tailscale on, with the advice to turn off key
 *    expiry for the box (LNK-14), and Whombat Link offered once as a card, never as a gate.
 * 4. **Protect your Whombat** — where backups go, “Let {assistant} set it up” for a NAS it found (`ProtectPlaces`).
 * 5.–7. **Name your Whombat**, **Set up your AI**, **Meet your agent** — the app's own setup (onboarding), which opens
 *    next and carries on this count (`boxSetupSteps`).
 */
import { WhombatAvatar } from '@whombat/avatars/react';
import { WhombatLogo } from '@whombat/brand/react';
import {
  type HostTailscaleOutput,
  readLoginServer,
  TAILSCALE_TEXT,
  tailscaleAnswer,
  tailscaleApi,
  tailscaleErrorText,
  tailscaleView,
} from '@whombat/client';
import {
  BACKUP_SETUP_TEXT,
  BOX_APP_STEPS,
  BOX_SETUP_TEXT,
  type BoxPasskeyMade,
  type BoxSetupStep,
  boxPasskeyOutcome,
  boxSetupSteps,
  COMMUNITY_TEXT,
  createBoxPasskey,
  type KnownAppliance,
  linkRowView,
  localClaimAccountProblem,
  localClaimLettersReady,
  localClaimNext,
  OWN_ADDRESS_TEXT,
  ownClaimProbeOf,
  PasskeyCancelled,
  type PasskeySetupStep,
  PRIVACY_PAGE_URL,
  passkeyErrorText,
  REACH_CHOICE_TEXT,
  REACH_TEXT,
  runLocalClaim,
} from '@whombat/client/managed';
import { type ApplianceSession, createSecureSession, sessionOps } from '@whombat/client/session';
import { DEFAULT_AGENT_FACE, DEFAULT_AGENT_NAME } from '@whombat/core/domain';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonLink } from '../components/Button';
import { Input } from '../components/Input';
import { StatusDot } from '../components/StatusDot';
import { type Reach, useNow, useReach } from '../features/machine/useReach';
import ob from '../features/onboarding/OnboardingScreen.module.css';
import { ONBOARDING_STEPS } from '../features/onboarding/onboardingCopy';
import { savedNotes } from '../features/settings/BackupDestination';
import setup from './BoxSetup.module.css';
import type { BoxEnvironment } from './boxEnv';
import { WEB_CLIENT } from './connect';
import { type EndpointKey, browserLabel as label } from './keys';
import { LettersInput } from './LettersInput';
import { ProtectPlaces } from './ProtectPlaces';
import { PASSKEYS } from './passkeyEnv';

const T = BOX_SETUP_TEXT;

/** Where the setup stands: the claim's two screens, then the steps after it; the app's own steps come after. */
type Stage = Exclude<BoxSetupStep, (typeof BOX_APP_STEPS)[number]> | 'letters';

/** A step's title and line in the aside: the claim's own, or onboarding's for the app's steps that follow. */
function stepCopy(step: BoxSetupStep): { t: string; d: string } {
  if (step === 'name' || step === 'ai' || step === 'agent') {
    const copy = ONBOARDING_STEPS[BOX_APP_STEPS.indexOf(step)];
    return copy ? { t: copy.t, d: copy.d } : { t: '', d: '' };
  }
  return T.steps[step];
}

export function BoxSetup({
  env,
  keyPair,
  known,
  atAddress,
  claimLink,
  notice,
  tailscaleName,
  onClaimed,
  onTaken,
  onReread,
  onDone,
}: {
  env: BoxEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  /** This page is the box's own address (its passkey step is here). */
  atAddress: boolean;
  /** The claim link's secret from the address bar (`/c/<secret>`), at the address. */
  claimLink: string | null;
  /** What the letters screen says when the setup opens: why it is back here, or that new letters must be asked for. */
  notice?: string | null;
  /** This page's Tailscale name (`<name>.<tailnet>.ts.net`), or null. */
  tailscaleName: string | null;
  /** The claim worked: this browser is the person's first device. */
  onClaimed: (accountId: string) => void;
  /** Someone else claimed it meanwhile: the page for a box that is set up. */
  onTaken: () => void;
  /**
   * The connection or the proof was lost in the middle of the claim: the box is asked again what it is now, and when
   * nobody claimed it the setup opens on the letters with `text`.
   */
  onReread: (text: string) => void;
  /** Into the app, where its own setup carries on the count. */
  onDone: () => void;
}) {
  const steps = boxSetupSteps({ atAddress });
  const [stage, setStage] = useState<Stage>('letters');
  const [letters, setLetters] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [lettersProblem, setLettersProblem] = useState<string | null>(notice ?? null);
  const [claimProblem, setClaimProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrol, setEnrol] = useState<ApplianceSession | null>(null);
  const [app, setApp] = useState<ApplianceSession | null>(null);

  const claimed = stage !== 'letters' && stage !== 'account';
  // The enrollment session until the claim; the app's session after it.
  useEffect(() => {
    const s = createSecureSession({
      connector: env.connector({ peerId: known.peerId, key: keyPair }),
      client: WEB_CLIENT,
      expect: claimed ? 'app' : 'any',
      // At the box's own address the claim link gets this session a place kept for the visitor who has it.
      ...(claimed ? {} : { claimLink }),
    });
    s.connect();
    (claimed ? setApp : setEnrol)(s);
    return () => s.close();
  }, [env, known.peerId, keyPair, claimed, claimLink]);

  const claim = async () => {
    if (!enrol) return;
    setBusy(true);
    setClaimProblem(null);
    try {
      const out = await runLocalClaim({
        session: enrol,
        letters,
        link: claimLink,
        appliancePeerId: known.peerId,
        clientPeerId: keyPair.peerId,
        account: { name: name.trim(), email: email.trim() },
        endpoint: { label: label(), platform: 'web' },
      });
      onClaimed(out.accountId);
      setStage(atAddress ? 'passkey' : 'reach');
    } catch (error) {
      const next = localClaimNext(error);
      // Another device won: this page reads the box again and shows what a set-up Whombat shows.
      if (next.to === 'taken') onTaken();
      // The claim link changed under this page (someone asked for new letters at the box): the box is asked again,
      // and the page says to open the address its screen shows now. “Try again” would never work here.
      else if (ownClaimProbeOf(error) === 'needs_link') onReread('');
      // The connection or the proof was lost on the way: the box says what it is now before anything is asked again.
      else if (next.to === 'reread') onReread(next.text);
      else if (next.to === 'letters') {
        setLetters('');
        setLettersProblem(next.text);
        setStage('letters');
      } else setClaimProblem(next.text);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (stage === 'letters' && letters.length >= 4) {
      // Four letters of the box's own alphabet, checked before a try is spent on them.
      const ready = localClaimLettersReady(letters);
      setLettersProblem(ready ? null : COMMUNITY_TEXT.claim.errors.letters);
      if (ready) setStage('account');
    } else if (stage === 'account' && name.trim() && email.trim()) {
      // The box's own rules for a name and an email, before the exchange starts.
      const problem = localClaimAccountProblem({ name, email });
      if (problem) setClaimProblem(problem);
      else void claim();
    }
  };

  const current: BoxSetupStep = stage === 'letters' ? 'claim' : stage;
  const at = steps.indexOf(current);
  const kicker = T.stepLabel(at, steps.length);
  const tip =
    stage === 'letters'
      ? OWN_ADDRESS_TEXT.claim.tip
      : stage === 'account'
        ? T.account.tip
        : stage === 'reach'
          ? T.reach.tip
          : stage === 'backups'
            ? BACKUP_SETUP_TEXT.tip
            : null;

  return (
    <div className={ob.screen} data-box-setup={current}>
      <aside className={ob.aside}>
        <WhombatLogo variant="lockup" height={23} label="Whombat" />
        <div className={ob.steps}>
          {steps.map((s, i) => (
            <button
              key={s}
              type="button"
              className={ob.step}
              data-current={i === at || undefined}
              // Back to the letters before the claim; after it there's no going back.
              disabled={claimed || i > at}
              onClick={() => setStage(s === 'account' ? 'account' : 'letters')}
            >
              <span
                className={ob.stepDot}
                data-done={i < at || undefined}
                data-current={i === at || undefined}
              >
                {i < at ? '✓' : i + 1}
              </span>
              <span className={ob.stepText}>
                <span className={ob.stepTitle}>{stepCopy(s).t}</span>
                <span className={ob.stepDesc}>{stepCopy(s).d}</span>
              </span>
            </button>
          ))}
        </div>
        {tip ? (
          <div className={ob.tipRow}>
            <span className={ob.tipAvatar}>
              <WhombatAvatar face={DEFAULT_AGENT_FACE} size={64} eager label={DEFAULT_AGENT_NAME} />
            </span>
            <div className={ob.tipBubble}>{tip}</div>
          </div>
        ) : null}
      </aside>

      <main className={ob.main}>
        {claimed ? (
          !app ? null : stage === 'passkey' ? (
            <PasskeyStep
              session={app}
              appliance={known.peerId}
              kicker={kicker}
              onDone={() => setStage('backups')}
            />
          ) : stage === 'reach' ? (
            <ReachStep
              session={app}
              kicker={kicker}
              tailscaleName={tailscaleName}
              onDone={() => setStage('backups')}
            />
          ) : (
            <BackupsStep session={app} kicker={kicker} onDone={onDone} />
          )
        ) : (
          <form className={ob.content} onSubmit={submit}>
            <Header
              kicker={kicker}
              title={stage === 'letters' ? OWN_ADDRESS_TEXT.claim.title : T.account.title}
              sub={stage === 'letters' ? OWN_ADDRESS_TEXT.claim.sub : T.account.sub}
            />
            {stage === 'letters' ? (
              <div className={ob.nameBlock}>
                <label htmlFor="setup-letters" className={ob.label}>
                  {COMMUNITY_TEXT.claim.letters}
                </label>
                <LettersInput
                  id="setup-letters"
                  value={letters}
                  onChange={(v) => {
                    setLetters(v);
                    setLettersProblem(null);
                  }}
                  placeholder={COMMUNITY_TEXT.claim.lettersPlaceholder}
                  invalid={lettersProblem !== null}
                  aria-describedby={lettersProblem ? 'setup-letters-problem' : undefined}
                  autoFocus
                />
                {lettersProblem && (
                  <span id="setup-letters-problem" className={ob.urlNote} role="alert">
                    {lettersProblem}
                  </span>
                )}
              </div>
            ) : (
              <div className={setup.fields}>
                <div className={ob.nameBlock}>
                  <label htmlFor="setup-name" className={ob.label}>
                    {COMMUNITY_TEXT.account.name}
                  </label>
                  <Input
                    id="setup-name"
                    size="lg"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className={ob.nameBlock}>
                  <label htmlFor="setup-email" className={ob.label}>
                    {COMMUNITY_TEXT.account.email}
                  </label>
                  <Input
                    id="setup-email"
                    type="email"
                    size="lg"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>
            )}
            {claimProblem && stage === 'account' && (
              <p className={ob.finishProblem} role="alert">
                {claimProblem}
              </p>
            )}
            <div className={ob.footer}>
              {stage === 'account' ? (
                <Button
                  variant="secondary"
                  size="xl"
                  padY={12}
                  type="button"
                  onClick={() => setStage('letters')}
                >
                  {COMMUNITY_TEXT.account.back}
                </Button>
              ) : (
                <span />
              )}
              <Button
                variant="primary"
                size="xl"
                padX={22}
                padY={12}
                type="submit"
                disabled={
                  stage === 'letters' ? letters.length < 4 : busy || !enrol || !name.trim() || !email.trim()
                }
              >
                {stage === 'letters'
                  ? COMMUNITY_TEXT.claim.next
                  : busy
                    ? COMMUNITY_TEXT.account.claiming
                    : COMMUNITY_TEXT.account.claim}
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}

function Header({ kicker, title, sub }: { kicker: string; title: string; sub: string }) {
  return (
    <div className={ob.headerBlock}>
      <span className={ob.kicker}>{kicker}</span>
      <h1 className={ob.h1}>{title}</h1>
      <p className={ob.sub}>{sub}</p>
    </div>
  );
}

function Line({
  dot,
  title,
  meta,
  action,
}: {
  dot: 'ok' | 'warn' | 'bad' | 'mut';
  title: string;
  meta: string;
  action?: ReactNode;
}) {
  return (
    <div className={setup.row} data-row="tailscale">
      <StatusDot tone={dot} size={8} label={null} />
      <span className={setup.rowMain}>
        <span className={setup.rowTitle} role="status">
          {title}
        </span>
        <span className={setup.rowMeta}>{meta}</span>
      </span>
      {action}
    </div>
  );
}

/* Step 3 at the address: the box's passkey ------------------------------------------------------------------------- */

/** What the passkey step says while the person touches it (one line under the button). */
const PROMPT: Partial<Record<PasskeySetupStep, string>> = {
  unlock: OWN_ADDRESS_TEXT.passkey.unlock,
  verify: OWN_ADDRESS_TEXT.passkey.check,
};

/**
 * The box's own passkey, two touches (three without PRF at creation), with the words that say our website can't use
 * it, linked to the privacy page.
 */
function PasskeyStep({
  session,
  appliance,
  kicker,
  onDone,
}: {
  session: ApplianceSession;
  appliance: string;
  kicker: string;
  onDone: () => void;
}) {
  const t = OWN_ADDRESS_TEXT.passkey;
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<BoxPasskeyMade | null>(null);

  const make = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setMade(
        await createBoxPasskey({
          session,
          platform: PASSKEYS,
          appliance,
          name: label(),
          onPrompt: (step) => setPrompt(PROMPT[step] ?? null),
        }),
      );
    } catch (error) {
      if (!(error instanceof PasskeyCancelled)) setProblem(passkeyErrorText(error) ?? t.make);
    } finally {
      setBusy(false);
      setPrompt(null);
    }
  };

  const outcome = made ? boxPasskeyOutcome(made) : null;
  return (
    <div className={ob.content} data-step="passkey">
      <Header kicker={kicker} title={t.title} sub={t.sub} />
      <p className={setup.note} data-own-words="">
        {t.words}{' '}
        <a href={PRIVACY_PAGE_URL} target="_blank" rel="noopener noreferrer">
          {t.why}
        </a>
      </p>
      {outcome ? (
        <p className={setup.note} role="status">
          {outcome}
        </p>
      ) : prompt ? (
        <p className={setup.hint} role="status">
          {prompt}
        </p>
      ) : null}
      {problem && (
        <p className={ob.finishProblem} role="alert">
          {problem}
        </p>
      )}
      <div className={ob.footer}>
        {made ? (
          <span />
        ) : (
          <Button variant="secondary" size="xl" padY={12} onClick={onDone}>
            {t.skip}
          </Button>
        )}
        {made ? (
          <Button variant="primary" size="xl" padX={22} padY={12} onClick={onDone}>
            {t.next}
          </Button>
        ) : (
          <Button variant="primary" size="xl" padX={22} padY={12} disabled={busy} onClick={() => void make()}>
            {busy ? t.making : t.make}
          </Button>
        )}
      </div>
    </div>
  );
}

/* Step 3 elsewhere: how to reach it ----------------------------------------------------------------------------------- */

/**
 * Reach it from anywhere (LNK-14, LNK-40), the installer's two ways (one-environment.md): Easy, Whombat Link, offered
 * once; then Expert, on its Tailscale page that it is on there, elsewhere Tailscale's own controls (Turn on, its login
 * server, its sign-in link), and once Tailscale is on the advice to turn off key expiry for this box. Continue never
 * waits for either.
 */
function ReachStep({
  session,
  kicker,
  tailscaleName,
  onDone,
}: {
  session: ApplianceSession;
  kicker: string;
  tailscaleName: string | null;
  onDone: () => void;
}) {
  const reach = useReach(session);
  const [tailscaleOn, setTailscaleOn] = useState(false);
  return (
    <div className={ob.content} data-step="reach">
      <Header kicker={kicker} title={T.reach.title} sub={T.reach.sub} />
      <LinkOffer reach={reach} />
      <section className={setup.way} aria-label={REACH_CHOICE_TEXT.expert.label} data-reach-expert="">
        <h2 className={setup.wayTitle}>{REACH_CHOICE_TEXT.expert.label}</h2>
        <p className={setup.wayLine}>{REACH_CHOICE_TEXT.expert.line}</p>
        {tailscaleName ? (
          <div className={setup.card}>
            <Line dot="ok" title={TAILSCALE_TEXT.on} meta={T.reach.onTailscale(tailscaleName)} />
          </div>
        ) : (
          <TailscaleControls session={session} onOn={setTailscaleOn} />
        )}
        {tailscaleName || tailscaleOn ? (
          <p className={setup.note} data-key-expiry="">
            {REACH_TEXT.tailscale.keyExpiry}
          </p>
        ) : null}
      </section>
      <div className={ob.footer}>
        <span />
        <Button variant="primary" size="xl" padX={22} padY={12} onClick={onDone}>
          {T.next}
        </Button>
      </div>
    </div>
  );
}

/**
 * Tailscale on the app's session — Turn on (with your own login server behind “Use your own login server”), Tailscale's
 * sign-in link while it waits (asked again every 2 s), on with its name.
 */
function TailscaleControls({ session, onOn }: { session: ApplianceSession; onOn: (on: boolean) => void }) {
  const C = COMMUNITY_TEXT.tailscale;
  const api = useMemo(() => tailscaleApi(session), [session]);
  const [answer, setAnswer] = useState<HostTailscaleOutput | null>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const [server, setServer] = useState('');
  const typed = readLoginServer(own ? server : '');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` asks again.
  useEffect(() => {
    let live = true;
    api.state().then(
      (a) => live && setAnswer(a),
      () => live && setAnswer({ tailscale: null, reason: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [api, asked]);
  const v = tailscaleView(answer);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer asks again after its own wait.
  useEffect(() => {
    if (!v.pollMs) return;
    const t = setTimeout(() => setAsked((n) => n + 1), v.pollMs);
    return () => clearTimeout(t);
  }, [v.pollMs, answer]);
  const s = answer?.tailscale ?? null;
  const on = s?.state === 'on';
  useEffect(() => onOn(on), [on, onOn]);

  const turnOn = async () => {
    if (!typed.ok) return;
    setBusy(true);
    setNote(null);
    try {
      setAnswer(tailscaleAnswer(await api.on(own ? typed.value : null)));
    } catch (error) {
      setNote(tailscaleErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  const off = !s || s.state === 'off' || s.state === 'error';
  if (!answer) return null;
  if (v.hidden) return <p className={setup.note}>{C.notHere}</p>;
  return (
    <>
      {off && answer.tailscale ? (
        <div className={setup.fields}>
          {s?.state === 'error' && <Line dot="bad" title={v.title} meta={v.meta} />}
          {own && (
            <div className={ob.nameBlock}>
              <label htmlFor="setup-login-server" className={ob.label}>
                {C.ownLabel}
              </label>
              <Input
                id="setup-login-server"
                size="lg"
                className={setup.mono}
                placeholder={C.ownPlaceholder}
                autoComplete="url"
                spellCheck={false}
                value={server}
                onChange={(e) => setServer(e.target.value)}
                invalid={!typed.ok}
                aria-describedby="setup-login-server-hint"
                autoFocus
              />
              <span id="setup-login-server-hint" className={typed.ok ? setup.hint : ob.urlNote}>
                {typed.ok ? (typed.plainHttp ? TAILSCALE_TEXT.plainHttp : C.ownHint) : typed.problem}
              </span>
            </div>
          )}
          <div className={setup.actions}>
            <Button variant="secondary" size="lg" disabled={busy || !typed.ok} onClick={() => void turnOn()}>
              {busy ? C.turningOn : C.turnOn}
            </Button>
            {!own && (
              <Button variant="link" onClick={() => setOwn(true)}>
                {C.own}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className={setup.card}>
          {s?.state === 'needs_sign_in' ? (
            <Line
              dot="warn"
              title={C.signIn}
              meta={v.loginUrl ? C.signInMeta : TAILSCALE_TEXT.makingLink}
              action={
                v.loginUrl ? (
                  <ButtonLink
                    variant="primary"
                    size="sm"
                    href={v.loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {TAILSCALE_TEXT.openSignIn}
                  </ButtonLink>
                ) : null
              }
            />
          ) : s?.state === 'needs_approval' ? (
            <Line dot="warn" title={TAILSCALE_TEXT.approval} meta={C.approval} />
          ) : s?.state === 'starting' ? (
            <Line dot="warn" title={TAILSCALE_TEXT.starting} meta={TAILSCALE_TEXT.startingMeta} />
          ) : on && s ? (
            <Line
              dot="ok"
              title={TAILSCALE_TEXT.on}
              meta={s.https ? C.on(s.name ?? '') : `${C.on(s.name ?? '')} ${C.noHttps}`}
            />
          ) : (
            <Line dot="mut" title={v.title} meta={v.meta} />
          )}
        </div>
      )}
      {note && (
        <p className={ob.finishProblem} role="alert">
          {note}
        </p>
      )}
    </>
  );
}

/**
 * Whombat Link, offered once (LNK-40) in the installer's Easy words (one-environment.md): Recommended, the one offer
 * sentence, what it gives, Turn on (the box shows a code to type at the account site, followed here until Link is on)
 * and Not now. Nothing where the box can't have Link, and nothing once it is on or ending.
 */
function LinkOffer({ reach }: { reach: Reach }) {
  const [dismissed, setDismissed] = useState(false);
  const link = reach.reach?.link;
  const now = useNow(link?.state === 'starting');
  if (!link) return null;
  const t = REACH_TEXT;
  if (link.state === 'on')
    return (
      <div className={setup.card}>
        <Line dot="ok" title={t.link.on} meta={linkRowView(link, { offerLink: true, now }).meta} />
      </div>
    );
  if (link.state === 'starting') {
    const v = linkRowView(link, { offerLink: true, now });
    return (
      <section className={setup.offer} aria-label={t.offer.title} data-link-offer="starting">
        <h2 className={setup.offerTitle}>{v.title}</h2>
        {v.code ? (
          <>
            <p className={setup.offerBody}>
              Open{' '}
              <a href={v.code.url} target="_blank" rel="noopener noreferrer">
                {v.code.where}
              </a>{' '}
              and enter
            </p>
            <span className={setup.code} data-testid="whombat-link-box-code">
              {v.code.code}
            </span>
            <p className={setup.hint}>{v.code.left ? t.link.left(v.code.left) : t.link.codeOver}</p>
          </>
        ) : (
          <p className={setup.offerBody}>{v.meta}</p>
        )}
        {reach.error ? (
          <p className={ob.finishProblem} role="alert">
            {reach.error}
          </p>
        ) : null}
        <div className={setup.actions}>
          {v.action === 'newCode' ? (
            <Button
              variant="primary"
              size="lg"
              disabled={reach.busy !== null}
              onClick={() => void reach.turnOn()}
            >
              {t.link.newCode}
            </Button>
          ) : null}
          {v.action === 'cancel' || v.action === 'newCode' ? (
            <Button variant="link" disabled={reach.busy !== null} onClick={() => void reach.turnOff()}>
              {t.link.cancel}
            </Button>
          ) : null}
        </div>
      </section>
    );
  }
  if (dismissed || link.state === 'grace') return null;
  return (
    <section className={setup.offer} aria-label={t.offer.title} data-link-offer="">
      <div className={setup.offerHead}>
        <h2 className={setup.offerTitle}>{t.offer.title}</h2>
        <span className={setup.offerTag}>{t.offer.tag}</span>
      </div>
      <p className={setup.offerPrice}>{t.offer.price}</p>
      <ul className={setup.offerPoints}>
        {t.offer.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {reach.error ? (
        <p className={ob.finishProblem} role="alert">
          {reach.error}
        </p>
      ) : null}
      <div className={setup.actions}>
        <Button
          variant="secondary"
          size="lg"
          disabled={reach.busy !== null}
          onClick={() => void reach.turnOn()}
        >
          {reach.busy === 'on' ? t.link.turningOn : t.offer.turnOn}
        </Button>
        <Button variant="link" onClick={() => setDismissed(true)}>
          {t.offer.notNow}
        </Button>
      </div>
    </section>
  );
}

/* Step 4: backups ------------------------------------------------------------------------------------------------------ */

/**
 * Protect your Whombat (first-day.md): where backups go, what is there first (`ProtectPlaces`). Skippable; a Whombat
 * that has a destination already, or whose status can't be read, goes straight on.
 */
function BackupsStep({
  session,
  kicker,
  onDone,
}: {
  session: ApplianceSession;
  kicker: string;
  onDone: () => void;
}) {
  const B = BACKUP_SETUP_TEXT;
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  /** “Let {assistant} set it up”: the yes is kept, said before going on. */
  const [said, setSaid] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let live = true;
    sessionOps.applianceStatus(session).then(
      (s) => {
        if (!live) return;
        if (s.backup.state === 'unprotected') setNeeded(true);
        else done.current();
      },
      () => live && done.current(),
    );
    return () => {
      live = false;
    };
  }, [session]);
  if (!needed) return null;
  return (
    <div className={ob.content} data-step="backups">
      <Header kicker={kicker} title={B.title} sub={saved ? B.saved : (said ?? B.sub)} />
      {said || saved ? (
        <>
          {(saved ?? []).map((note) => (
            <p key={note} className={setup.note} role="status">
              {note}
            </p>
          ))}
          <div className={ob.footer}>
            <span />
            <Button variant="primary" size="xl" padX={22} padY={12} onClick={onDone}>
              {B.continue}
            </Button>
          </div>
        </>
      ) : (
        <ProtectPlaces
          session={session}
          onSaved={(result) => setSaved(savedNotes(result))}
          onAssistant={setSaid}
          onDone={onDone}
        />
      )}
    </div>
  );
}
