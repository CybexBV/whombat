import {
  agentFaceOf,
  LOOK_PLAN_WORDS,
  type LookPlanCardView,
  lookFixOutcomeText,
  lookPlanCardView,
  lookPlanLine,
  lookThreadHref,
  threadToOpen,
} from '@whombat/client';
import { useFixLook, useTheAgent } from '@whombat/client/react';
import type { LookPlanCard as LookPlanCardData, LookResearch } from '@whombat/core';
import { Check } from 'lucide-react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { LookSays } from '../home/LookSays';
import styles from './LookPlanCard.module.css';
import { SettledLine } from './SettledLine';

/**
 * A thing's plan as a card (Whombat handle-it.md; contracts 3.11): the assistant's title and words, “Here’s what I’ll
 * do on pve-01:”, its steps, then Go ahead (the person's yes for exactly those steps) and Change something (the thread,
 * to reply). While it takes them it says it is on it; once done, green with what it did. A page's LookCard draws it
 * with the title (`page`); in the thread the message above already says what it found, so the card starts at its list.
 */
export function LookPlanBody({
  burrow,
  view,
  research,
  variant,
  tone = 'warn',
  onChange,
}: {
  burrow: string;
  view: LookPlanCardView;
  /** The live research Go ahead sends; none: nothing to press. */
  research: LookResearch | null;
  variant: 'page' | 'thread';
  /** The look's colour while it waits (`bad` for a thing that is down or in trouble). */
  tone?: 'warn' | 'bad';
  /** Change something: opens the thread to reply (`from`, the button pressed). */
  onChange: (from: HTMLElement) => void;
}) {
  const { agent, words } = useTheAgent(burrow);
  const toast = useToast();
  const navigateHref = useNavigateHref();
  // On a page Go ahead opens the thread, where the steps are taken (backup-places.md BPL-15); in the thread it stays.
  const { mutate: goAhead, isPending } = useFixLook(burrow, (outcome, thread) => {
    const text = lookFixOutcomeText(outcome);
    if (text) toast.show(text);
    const open = variant === 'page' ? threadToOpen(thread) : null;
    if (open) navigateHref(open);
  });
  const shownTone = view.done ? 'ok' : view.state === 'gone' ? 'mut' : tone;
  // In the thread the message above it says what it found; once done or while it works, its words are the news.
  const words_ = variant === 'page' || view.state !== 'waiting';
  return (
    <section
      className={cx(styles.card, variant === 'thread' && styles.thread)}
      data-tone={shownTone}
      data-plan={view.state}
      data-card="look_plan"
      aria-label={view.title ?? view.head}
    >
      {words_ && view.title ? <h2 className={styles.title}>{view.title}</h2> : null}
      {words_ && view.text ? (
        <LookSays
          view={{ state: view.state, busy: view.busy, text: view.text }}
          face={agentFaceOf(agent)}
          name={words.name}
          size={22}
          className={styles.says}
        />
      ) : null}
      <p className={styles.head}>{view.head}</p>
      <ul className={styles.steps}>
        {view.steps.map((step, i) => (
          // Steps are the plan's own order; two may read alike.
          // biome-ignore lint/suspicious/noArrayIndexKey: a plan's steps have no ids
          <li key={i} className={styles.step}>
            <span className={styles.mark} aria-hidden="true">
              {view.done ? <Icon icon={Check} size={14} /> : null}
            </span>
            <span>
              {step}
              {view.done ? <span className={styles.srOnly}> (done)</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {view.goAhead || view.change ? (
        <div className={styles.buttons}>
          {view.goAhead && research ? (
            <Button variant="primary" size="sm" disabled={isPending} onClick={() => goAhead(research)}>
              {view.goAhead}
            </Button>
          ) : null}
          {view.change ? (
            <Button variant="ghost" size="sm" onClick={(e) => onChange(e.currentTarget)}>
              {view.change}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The `look_plan` card in the thing's thread: the plan while it waits, is taken or says what was done; one line once
 * it is no longer needed. Change something opens the thread to reply (the composer there).
 */
export function LookPlanCardContainer({
  burrow,
  card,
  size,
  anchorId,
}: {
  burrow: string;
  card: LookPlanCardData;
  size: 'md' | 'sm';
  anchorId?: string;
}) {
  const navigateHref = useNavigateHref();
  const view = lookPlanCardView(card.plan);
  if (!view || !card.plan) return null;
  if (view.state === 'gone') {
    const line = lookPlanLine(card.plan);
    return (
      <SettledLine
        line={line}
        label={`${LOOK_PLAN_WORDS.gone} ${card.plan.name}`}
        card="look_plan"
        size={size}
        id={anchorId}
      />
    );
  }
  const research = card.plan.research;
  const thread = research ? lookThreadHref(research) : null;
  return (
    <LookPlanBody
      burrow={burrow}
      view={view}
      research={research}
      variant="thread"
      onChange={(from) => {
        // In its thread, the thread's own reply box; elsewhere the thread opens.
        if (!focusReplyNear(from) && thread) navigateHref(thread);
      }}
    />
  );
}

/** Focuses the reply box of the pane `from` is in (the thread's composer), if there is one. */
export function focusReplyNear(from: HTMLElement): boolean {
  for (let el: HTMLElement | null = from.parentElement; el; el = el.parentElement) {
    const box = el.querySelector<HTMLTextAreaElement>('textarea');
    if (box) {
      box.focus();
      return true;
    }
  }
  return false;
}
