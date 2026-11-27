import { planFocus, planFrame } from '@whombat/client';
import { type LinkRef, type Plan, type PlanStep, stepGoesAhead } from '@whombat/core/domain';
import { formatDue, plural } from '@whombat/core/text';
import { cx } from '../../components/cx';
import { currentLocale } from '../../i18n/provider';
import { cardStepDetail, countedSteps, GO_AHEAD, MARKER_LABEL, stepLinks } from '../plans/planModel';
import { CardFrame, FrameButton, frameStyles as f } from './CardFrame';
import { planCanvasHref } from './links';
import plan from './PlanCard.module.css';
import { CardLink, type NavigateHandler, type PrincipalLookup } from './parts';

export interface PlanCardProps {
  plan: Plan;
  principals: PrincipalLookup;
  onNavigate?: NavigateHandler;
  /** “Open plan”: the plan pane over this conversation (`?plan=<id>`); hidden when omitted. */
  planHref?: string | null;
  /** Where a step's linked work opens (a run page, the approval modal over this page, an automation run). */
  linkHref?: (link: LinkRef) => string;
  /**
   * “Go ahead” on a step the agent stopped at for the person's word (core `stepGoesAhead`): asks the agent to carry
   * on with it. Hidden when omitted (the person can't change the plan here).
   */
  onGoAhead?: (step: PlanStep) => void;
  /** The step whose “Go ahead” is on its way. */
  goingAhead?: string | null;
  /** The assistant's name (the name helper's), for “Neo is working”. */
  assistant?: string;
}

/** A step's mark by shape: done ✓, the step the card names →, blocked !, cancelled –, the rest ·. */
const STEP_MARK: Record<PlanStep['state'], string> = {
  done: '✓',
  active: '→',
  gate: '→',
  blocked: '!',
  queued: '·',
  cancelled: '–',
};

/**
 * A plan in a thread, in the cards' one layout (docs/decisions/chat-threads-cards.md): its status (the assistant at
 * work, waiting for the person, blocked or done) with when it changed, its title, a sentence naming the step it is on
 * or waits at, then Go ahead (a step waiting for the person's word) or Open plan with Open plan canvas beside it. Show
 * more opens the step it names and every step with its state, a blocked step's reason and its work's links; the steps'
 * count and due date are under Details. The steps are the agent's: no owner shows (one-agent.md AP-4952).
 */
export function PlanCard({
  plan: p,
  onNavigate,
  planHref,
  linkHref,
  onGoAhead,
  goingAhead,
  assistant = 'Your assistant',
}: PlanCardProps) {
  const canvasHref = planCanvasHref(p);
  const frame = planFrame(p, assistant);
  const focus = planFocus(p);
  const gate = focus?.kind === 'gate' && onGoAhead && stepGoesAhead(focus.step) ? focus.step : null;
  const busy = !!gate && goingAhead === gate.id;
  const open = planHref ? (
    <CardLink
      href={planHref}
      onNavigate={onNavigate}
      className={cx(f.button, gate ? f.other : f.main)}
      data-plan-open=""
    >
      Open plan
    </CardLink>
  ) : null;
  const canvas = canvasHref ? (
    <CardLink href={canvasHref} onNavigate={onNavigate} className={cx(f.button, f.other)}>
      Open plan canvas
    </CardLink>
  ) : null;
  const facts = [
    { term: 'Steps', value: plural(countedSteps(p), 'step') },
    p.due ? { term: 'Due', value: formatDue(p.due, currentLocale()) } : null,
    ...p.steps.flatMap((s, i) => stepLinks(s).map((l) => ({ term: `Step ${i + 1}`, value: l.label }))),
  ].filter((x): x is { term: string; value: string } => x !== null);
  return (
    <CardFrame
      card="plan"
      frame={frame}
      showKind={false}
      className={plan.card}
      actions={
        gate || open || canvas ? (
          <>
            {gate && (
              <FrameButton
                main
                disabled={busy}
                aria-label={`${GO_AHEAD}: ${gate.title}`}
                onClick={() => onGoAhead?.(gate)}
              >
                {busy ? `${GO_AHEAD}…` : GO_AHEAD}
              </FrameButton>
            )}
            {open}
            {canvas}
          </>
        ) : null
      }
      body={
        <>
          {focus && (
            <div className={f.callout} data-plan-focus={focus.kind}>
              <span className={f.calloutLabel}>{focus.label}</span>
              <span className={f.calloutText}>{focus.step.title}</span>
            </div>
          )}
          <ol className={f.rows}>
            {p.steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                focused={focus?.step.id === step.id}
                onNavigate={onNavigate}
                linkHref={linkHref}
                onGoAhead={step.id === gate?.id ? undefined : onGoAhead}
                busy={goingAhead === step.id}
              />
            ))}
          </ol>
        </>
      }
      details={
        <dl className={f.facts}>
          {facts.map((x) => (
            <div key={`${x.term}-${x.value}`} style={{ display: 'contents' }}>
              <dt>{x.term}</dt>
              <dd>{x.value}</dd>
            </div>
          ))}
        </dl>
      }
    />
  );
}

interface StepRowProps {
  step: PlanStep;
  focused: boolean;
  onNavigate?: NavigateHandler | undefined;
  linkHref?: ((link: LinkRef) => string) | undefined;
  onGoAhead?: ((step: PlanStep) => void) | undefined;
  busy: boolean;
}

function StepRow({ step, focused, onNavigate, linkHref, onGoAhead, busy }: StepRowProps) {
  const detail = cardStepDetail(step);
  const note = detail?.note;
  const goAhead = onGoAhead && stepGoesAhead(step);
  const mark = focused || step.state !== 'active' ? STEP_MARK[step.state] : '·';
  return (
    <li className={f.rowItem} data-state={step.state} data-focused={focused || undefined}>
      <span className={f.rowMark} role="img" aria-label={MARKER_LABEL[step.state]}>
        {mark}
      </span>
      <span className={cx(f.rowName, step.state === 'cancelled' && plan.cancelled)}>{step.title}</span>
      <span
        className={f.rowState}
        data-tone={step.state === 'gate' || step.state === 'blocked' ? 'warn' : undefined}
      >
        {step.stateLabel}
      </span>
      {note && <span className={f.rowNote}>{note}</span>}
      {((linkHref && detail && detail.links.length > 0) || goAhead) && (
        <span className={f.rowLinks}>
          {linkHref &&
            detail?.links.map((l) => (
              <CardLink key={l.kind} href={linkHref(l.link)} onNavigate={onNavigate}>
                {l.label}
              </CardLink>
            ))}
          {goAhead && (
            <FrameButton
              disabled={busy}
              aria-label={`${GO_AHEAD}: ${step.title}`}
              onClick={() => onGoAhead(step)}
            >
              {busy ? `${GO_AHEAD}…` : GO_AHEAD}
            </FrameButton>
          )}
        </span>
      )}
    </li>
  );
}
