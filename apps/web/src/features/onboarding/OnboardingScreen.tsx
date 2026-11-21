import { WhombatAvatar } from '@whombat/avatars/react';
import { WhombatLogo } from '@whombat/brand/react';
import {
  ApiError,
  agentFaceBackground,
  agentFaceLabel,
  agentFaceStyle,
  agentNameForFace,
  InvalidRequestError,
} from '@whombat/client';
import { BOX_SETUP_TEXT, boxClaimSteps } from '@whombat/client/managed';
import { useApiMutation, useOnboarding, useSlugCheck } from '@whombat/client/react';
import { clientUsable } from '@whombat/client/signins';
import { api } from '@whombat/core/contracts';
import {
  AGENT_FACES,
  AGENT_NAME_MAX,
  type AgentFace,
  type AgentProvider,
  agentCharacter,
  DEFAULT_AGENT_FACE,
  DEFAULT_AGENT_NAME,
  LIVE_PROVIDERS,
  type LiveProvider,
  ONBOARDING_PROVIDER_STEP,
  ONBOARDING_STEP_COUNT,
} from '@whombat/core/domain';
import {
  burrowAddress,
  DEFAULT_PUBLIC_URL,
  onboardingBackLabel,
  onboardingNextLabel,
  onboardingStepLabel,
  slugify,
  welcomeToast,
} from '@whombat/core/text';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { useToast } from '../../components/Toast';
import { agentNameProblem } from '../agent/settings/ProfileTab';
import faceStyles from '../agent/settings/ProfileTab.module.css';
import { AiSetup, useClientsStatus, useSignInsStatus } from '../ai';
import styles from './OnboardingScreen.module.css';
import { AI_STEP_TEXT, ONBOARDING_STEPS } from './onboardingCopy';

export interface OnboardingScreenProps {
  /** After "Open {burrow}": go to the new burrow. */
  onDone?: (burrowSlug: string) => void;
  /** "Skip for now" at step 1 (no burrow to go to yet). */
  onSkip?: () => void;
  /**
   * Resume an onboarding in progress (`?burrow=&step=`, e.g. after a reload — docs/decisions/web-push-connect.md).
   * Re-fetches onboarding progress for `resumeBurrow` and jumps to `resumeStep` (0–2 since contracts 3.0, CT-1506).
   */
  resumeBurrow?: string;
  resumeStep?: number;
}

const LAST_STEP = ONBOARDING_STEP_COUNT - 1;
const AGENT_STEP = ONBOARDING_PROVIDER_STEP + 1;

/**
 * The 3-step onboarding flow (TODO 14.1/14.2; SUB-08, CT-68; Whombat one-agent.md OA-13, one-person.md OP-11; app
 * one-agent.md AP-4954, one-person.md AP-5673): Name your Whombat → Set up your AI → Meet your agent (its name and one
 * of the five characters — a face and a way of talking, agent-voices.md AP-5500 — saved with `onboarding.update` when
 * the step is left and given to the agent by `onboarding.complete`). No Invite people: a Whombat is one person's. The
 * mock's “Connect your code” is gone (GitHub stays in Settings); “Set up your AI” chooses Claude Code and/or ChatGPT
 * and signs in to each (`features/ai`, docs/decisions/subscriptions.md), or — on a self-hosted server before contracts
 * 0.9, which has no `clients.*` — shows the host's AI provider panel as before. Step 1 creates the burrow
 * (`burrows.create`) and with it the agent; the others refine its already-created `OnboardingState` (clients, provider)
 * and finish with `onboarding.complete`. The mutation endpoints this screen uses aren't in the shared fixtures'
 * `IMPLEMENTED` set — see `docs/decisions/canvas-onboarding.md` (FX-12 in `docs/decisions/fixtures.md` reserves that
 * set for pure-data reads; onboarding is exercised end-to-end with a mocked-server test instead, matching
 * `apps/web/src/app/auth/auth.test.tsx`).
 */
export function OnboardingScreen({ onDone, onSkip, resumeBurrow, resumeStep }: OnboardingScreenProps) {
  const toast = useToast();
  const { fixtures, managed } = useAppServices();
  const [step, setStep] = useState(0);
  // On a Whombat, a new burrow starts with the organization's name (AP-75); most keep it.
  const suggestedName = managed?.orgName?.trim() ?? '';
  const [burrowName, setBurrowName] = useState(suggestedName);
  /** The server's `app.whombat.com/{slug}` for the created (or resumed) burrow. */
  const [burrowHostname, setBurrowHostname] = useState<string | null>(null);
  const [debouncedName, setDebouncedName] = useState(suggestedName);
  const [burrowSlug, setBurrowSlug] = useState<string | null>(null);
  const steps = ONBOARDING_STEPS;
  /** “Set up your AI”: the chosen clients, in the order picked (CT-68). */
  const [clients, setClients] = useState<LiveProvider[]>([]);
  /** The agent's provider; null = this Whombat's default (the first ready provider). */
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  /** Opening the burrow failed: the server's reason. */
  const [finishProblem, setFinishProblem] = useState<string | null>(null);
  /** Meet your agent: the name and face as onboarding saved them (Dusty, in Dusty's drawing, until changed; OA-08). */
  const [saved, setSaved] = useState<{ name: string; face: AgentFace }>({
    name: DEFAULT_AGENT_NAME,
    face: DEFAULT_AGENT_FACE,
  });
  /** The name typed (or following the face, AP-5502) and the face picked; null until changed. */
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentFace, setAgentFace] = useState<AgentFace | null>(null);
  const [agentProblem, setAgentProblem] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedName(burrowName.trim()), 300);
    return () => clearTimeout(id);
  }, [burrowName]);

  // Only while the burrow doesn't exist yet: once created (or resumed), its own name is "taken".
  const slugCheck = useSlugCheck(
    step === 0 && !burrowSlug && debouncedName ? { query: { name: debouncedName } } : null,
  );

  const createBurrow = useApiMutation(api.burrows.create);
  const updateOnboarding = useApiMutation(api.onboarding.update);
  const completeOnboarding = useApiMutation(api.onboarding.complete);

  // Resume (a reload): re-fetch this burrow's onboarding progress and hydrate
  // local state from it, once, the first time `resumeBurrow` shows up with no burrow set locally yet.
  const resuming = Boolean(resumeBurrow) && !burrowSlug;
  const resumeQuery = useOnboarding(resuming ? { params: { burrow: resumeBurrow as string } } : null);
  const resumeApplied = useRef(false);
  useEffect(() => {
    if (!resuming || !resumeBurrow || !resumeQuery.data || resumeApplied.current) return;
    resumeApplied.current = true;
    const o = resumeQuery.data;
    setBurrowSlug(resumeBurrow);
    setBurrowHostname(o.host);
    setBurrowName(o.burrowName);
    setClients([...o.clients]);
    setProvider(o.provider);
    setSaved({ name: o.agentName, face: o.agentFace });
    setStep(Math.min(Math.max(resumeStep ?? o.step, 0), LAST_STEP));
  }, [resuming, resumeBurrow, resumeStep, resumeQuery.data]);

  // “Set up your AI”: the clients on this Whombat (CT-72).
  const onAiStep = step === ONBOARDING_PROVIDER_STEP && Boolean(burrowSlug);
  const clientsQuery = useClientsStatus(onAiStep);
  // Whether an AI is signed in: Continue waits for one, and the step is ticked only then (FDY-33). Where the lists
  // can't be read (a server without them) the step is as it was.
  const signInsQuery = useSignInsStatus(Boolean(burrowSlug));
  const aiUnknown = clientsQuery.isError || signInsQuery.isError;
  const aiReady =
    aiUnknown || LIVE_PROVIDERS.some((p) => clientUsable(p, clientsQuery.data, signInsQuery.data));
  // On the box's own page this setup carries on the claim's count (FDY-32): its steps show done above these.
  const boxPage = managed?.page?.kind === 'box' ? managed.page : null;
  const claimSteps = boxPage ? boxClaimSteps({ atAddress: boxPage.atAddress ?? true }) : [];
  const kicker = boxPage
    ? BOX_SETUP_TEXT.stepLabel(claimSteps.length + step, claimSteps.length + ONBOARDING_STEP_COUNT)
    : onboardingStepLabel(step, ONBOARDING_STEP_COUNT);
  const savedName = saved.name;
  const savedFace = saved.face;
  const shownName = (agentName ?? savedName).trim() || savedName;
  const shownFace = agentFace ?? savedFace;

  const nameTrimmed = burrowName.trim();
  // Burrows are path-based on the one public origin (docs/decisions/production.md): the page's own origin,
  // which is PUBLIC_URL in production. Fixture mode (Storybook, visual tests) shows the live address.
  const origin = fixtures || typeof window === 'undefined' ? DEFAULT_PUBLIC_URL : window.location.origin;
  const localHost = burrowAddress(slugify(nameTrimmed || 'burrow'), origin);
  const checkMatchesName = slugCheck.data && slugCheck.data.name === debouncedName;
  const unavailableReason = checkMatchesName && !slugCheck.data?.available ? slugCheck.data?.reason : null;
  // Once the burrow is created its real slug wins; before that, the live check's slug, or a local guess.
  const previewHost = burrowSlug
    ? (burrowHostname ?? burrowAddress(burrowSlug, origin))
    : checkMatchesName
      ? (slugCheck.data?.host ?? localHost)
      : localHost;

  async function handleCreateBurrow() {
    if (!nameTrimmed || createBurrow.isPending) return;
    const result = await createBurrow.mutateAsync({ body: { name: nameTrimmed } });
    if (result.status === 'ok') {
      const { burrow, onboarding } = result.data;
      setBurrowSlug(burrow.slug);
      setBurrowHostname(onboarding.host);
      setSaved({ name: onboarding.agentName, face: onboarding.agentFace });
      setStep(1);
    }
  }

  function saveProgress(
    nextStep: number,
    picked: AgentProvider | null = provider,
    chosen: readonly LiveProvider[] = clients,
  ) {
    if (!burrowSlug) return;
    updateOnboarding.mutate({
      params: { burrow: burrowSlug },
      body: {
        step: nextStep,
        burrowName: nameTrimmed,
        clients: [...chosen],
        ...(picked ? { provider: picked } : {}),
      },
    });
  }

  function handleBack() {
    if (step === 0) {
      onSkip?.();
      return;
    }
    const prev = step - 1;
    setStep(prev);
    saveProgress(prev);
  }

  async function handleNext() {
    if (step === 0 && !burrowSlug) {
      await handleCreateBurrow();
      return;
    }
    if (step === AGENT_STEP && !(await saveAgent())) return;
    if (step < LAST_STEP) {
      const next = step + 1;
      setStep(next);
      saveProgress(next);
      return;
    }
    if (!burrowSlug || completeOnboarding.isPending) return;
    setFinishProblem(null);
    let result: Awaited<ReturnType<typeof completeOnboarding.mutateAsync>>;
    try {
      result = await completeOnboarding.mutateAsync({
        params: { burrow: burrowSlug },
        body: provider ? { provider } : {},
      });
    } catch (err) {
      // Refusals show above the buttons.
      if (err instanceof ApiError || err instanceof InvalidRequestError)
        setFinishProblem(err.fields.name?.[0] ?? err.message);
      else setFinishProblem('Couldn’t open your Whombat. Try again in a moment.');
      return;
    }
    if (result.status === 'ok') {
      toast.show(welcomeToast(burrowName, shownName));
      onDone?.(result.data.burrow.slug);
    }
  }

  function goToStep(i: number) {
    if (i === step) return;
    if (i > 0 && !burrowSlug) return;
    setStep(i);
  }

  /**
   * Leaving Meet your agent saves what changed (`onboarding.update`): the name (checked first, as Settings → Agent does)
   * and the face; “Open {burrow}” gives them to the agent. False keeps the step open with the reason under the name.
   */
  async function saveAgent(): Promise<boolean> {
    if (!burrowSlug) return true;
    const name = (agentName ?? savedName).trim();
    const body: { agentName?: string; agentFace?: AgentFace } = {};
    if (name && name !== savedName) {
      const problem = agentNameProblem(name);
      if (problem) {
        setAgentProblem(problem);
        return false;
      }
      body.agentName = name;
    }
    if (agentFace && agentFace !== savedFace) body.agentFace = agentFace;
    if (!body.agentName && !body.agentFace) return true;
    setAgentProblem(null);
    try {
      const result = await updateOnboarding.mutateAsync({ params: { burrow: burrowSlug }, body });
      if (result.status !== 'ok') {
        setAgentProblem(
          result.status === 'blocked' ? result.message : 'That needs a person to approve first.',
        );
        return false;
      }
      setSaved({ name: result.data.agentName, face: result.data.agentFace });
      setAgentName(null);
      setAgentFace(null);
      return true;
    } catch (err) {
      setAgentProblem(
        err instanceof ApiError || err instanceof InvalidRequestError
          ? (err.fields.agentName?.[0] ?? err.fields.agentFace?.[0] ?? err.message)
          : 'Couldn’t save that. Try again in a moment.',
      );
      return false;
    }
  }

  /**
   * Picks a character. While the name is still a character's (Dusty untouched, or another of the five) it follows the
   * face, so Neo is called Neo; a name of someone's own stays (AP-5502).
   */
  function pickFace(face: AgentFace) {
    setAgentFace(face);
    const name = agentName ?? savedName;
    const follows = agentNameForFace(name, face);
    if (follows !== name) {
      setAgentName(follows);
      setAgentProblem(null);
    }
  }

  const copy = steps[step];
  if (!copy) return <div className={styles.status}>Couldn’t load onboarding.</div>;

  const nextDisabled =
    step === 0
      ? !nameTrimmed || createBurrow.isPending || Boolean(unavailableReason)
      : step === LAST_STEP
        ? completeOnboarding.isPending || updateOnboarding.isPending
        : step === ONBOARDING_PROVIDER_STEP
          ? !aiReady
          : false;
  /** A step left behind is ticked; Set up your AI only once an AI is signed in. */
  const stepDone = (i: number) => i < step && (i !== ONBOARDING_PROVIDER_STEP || aiReady);

  return (
    <div className={styles.screen}>
      <aside className={styles.aside}>
        <WhombatLogo variant="lockup" height={23} label="Whombat" />

        <div className={styles.steps}>
          {claimSteps.map((s) => (
            <div key={s} className={styles.step} data-static="true">
              <span className={styles.stepDot} data-done="true">
                ✓
              </span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{BOX_SETUP_TEXT.steps[s].t}</span>
                <span className={styles.stepDesc}>{BOX_SETUP_TEXT.steps[s].d}</span>
              </span>
            </div>
          ))}
          {steps.map((s, i) => (
            <button
              key={s.t}
              type="button"
              className={styles.step}
              data-current={i === step || undefined}
              onClick={() => goToStep(i)}
            >
              <span
                className={styles.stepDot}
                data-done={stepDone(i) || undefined}
                data-current={i === step || undefined}
              >
                {stepDone(i) ? '✓' : claimSteps.length + i + 1}
              </span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{s.t}</span>
                <span className={styles.stepDesc}>{s.d}</span>
              </span>
            </button>
          ))}
        </div>

        <div className={styles.tipRow}>
          {/* The agent itself gives the tips, with the name and face picked so far (OA-08). */}
          <span className={styles.tipAvatar}>
            <WhombatAvatar face={shownFace} size={64} eager label={shownName} />
          </span>
          <div className={styles.tipBubble}>{copy.tip(shownName)}</div>
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.content}>
          <div className={styles.headerBlock}>
            <span className={styles.kicker}>{kicker}</span>
            <h1 className={styles.h1}>{copy.title}</h1>
            <p className={styles.sub}>{copy.sub}</p>
          </div>

          {step === 0 && (
            <div className={styles.nameBlock}>
              <label htmlFor="onboarding-burrow-name" className={styles.label}>
                WHOMBAT NAME
              </label>
              <Input
                id="onboarding-burrow-name"
                size="display"
                value={burrowName}
                onChange={(e) => setBurrowName(e.target.value)}
                invalid={Boolean(unavailableReason)}
                autoFocus
              />
              <span className={styles.urlPreview}>{previewHost}</span>
              {unavailableReason ? (
                <span className={styles.urlNote}>
                  {unavailableReason === 'taken'
                    ? 'That name is already taken.'
                    : unavailableReason === 'reserved'
                      ? 'That name is reserved.'
                      : 'That name isn’t valid.'}
                </span>
              ) : (
                slugCheck.isError && (
                  <span className={styles.urlNote}>
                    Couldn’t check that name.{' '}
                    <Button
                      variant="link"
                      className={styles.urlRetry}
                      onClick={() => void slugCheck.refetch()}
                    >
                      Retry
                    </Button>
                  </span>
                )
              )}
            </div>
          )}

          {onAiStep && (clientsQuery.data || clientsQuery.isError) && (
            <AiSetup
              clients={clients}
              onClientsChange={(next) => {
                setClients(next);
                saveProgress(step, provider, next);
              }}
              provider={provider}
              onProviderChange={(next) => {
                setProvider(next);
                saveProgress(step, next);
              }}
            />
          )}
          {onAiStep && !clientsQuery.data && !clientsQuery.isError && (
            <div className={styles.status}>Checking the AI providers…</div>
          )}
          {onAiStep && !aiReady && <p className={styles.aiLater}>{AI_STEP_TEXT.later}</p>}

          {step === AGENT_STEP && (
            <div className={styles.meetAgent}>
              <span className={styles.meetBust} style={{ background: agentFaceBackground(shownFace) }}>
                <WhombatAvatar
                  face={shownFace}
                  size={128}
                  crop="bust"
                  eager
                  label={agentFaceLabel(shownFace)}
                />
              </span>
              <div className={styles.meetFields}>
                <label htmlFor="onboarding-agent-name" className={styles.label}>
                  NAME
                </label>
                <Input
                  id="onboarding-agent-name"
                  size="lg"
                  maxLength={AGENT_NAME_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  value={agentName ?? savedName}
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    setAgentProblem(null);
                  }}
                  invalid={agentProblem !== null}
                  aria-describedby={agentProblem ? 'onboarding-agent-problem' : undefined}
                />
                {agentProblem && (
                  <span id="onboarding-agent-problem" className={styles.urlNote} role="alert">
                    {agentProblem}
                  </span>
                )}
                <span className={styles.label} id="onboarding-agent-face">
                  CHARACTER
                </span>
                <div
                  className={faceStyles.faces}
                  role="radiogroup"
                  aria-labelledby="onboarding-agent-face"
                  aria-describedby="onboarding-agent-style"
                >
                  {AGENT_FACES.map((key) => (
                    <label
                      key={key}
                      className={faceStyles.face}
                      data-on={key === shownFace || undefined}
                      style={key === shownFace ? { background: agentFaceBackground(key) } : undefined}
                      title={agentFaceLabel(key)}
                    >
                      <input
                        type="radio"
                        className={faceStyles.faceInput}
                        name="onboarding-agent-faces"
                        value={key}
                        checked={key === shownFace}
                        onChange={() => pickFace(key)}
                        aria-label={agentFaceLabel(key)}
                      />
                      <WhombatAvatar face={key} size={64} crop="bust" eager decorative />
                      {key === shownFace ? (
                        <span className={faceStyles.check} aria-hidden="true">
                          <Icon icon={Check} size={12} />
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
                {/* How the picked character talks (AP-5501), read out again as the pick changes. */}
                <p id="onboarding-agent-style" className={styles.characterStyle} aria-live="polite">
                  <strong className={styles.characterName}>{agentCharacter(shownFace).name}</strong>
                  {' · '}
                  {agentFaceStyle(shownFace)}
                </p>
              </div>
            </div>
          )}

          {finishProblem && step === LAST_STEP && (
            <p className={styles.finishProblem} role="alert">
              {finishProblem}
            </p>
          )}
          <div className={styles.footer}>
            <Button variant="secondary" size="xl" padY={12} onClick={handleBack}>
              {onboardingBackLabel(step)}
            </Button>
            <span className={styles.footerEnd}>
              {onAiStep && !aiReady && (
                <Button variant="link" onClick={handleNext}>
                  {AI_STEP_TEXT.skip}
                </Button>
              )}
              <Button
                variant="primary"
                size="xl"
                padX={22}
                padY={12}
                disabled={nextDisabled}
                onClick={handleNext}
              >
                {onboardingNextLabel(step, LAST_STEP, burrowName)}
              </Button>
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
