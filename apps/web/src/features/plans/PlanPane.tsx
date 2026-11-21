import { appPath } from '@whombat/client';
import { useConversation, usePlan, useSubscription } from '@whombat/client/react';
import {
  conversationLabel,
  formatClock,
  formatDue,
  type Plan,
  type PlanStep,
  type PlanStepAction,
  planProgress,
  topics,
} from '@whombat/core';
import { type FormEvent, type MouseEvent, useEffect, useRef, useState } from 'react';
import { useHereHref, useNavigateHref } from '../../app/routing/navigation';
import { type ContextMenuItem, useRowMenu } from '../../app/shell/ContextMenu';
import { Button, IconButton } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import styles from './Plans.module.css';
import {
  ACTION_LABEL,
  openWorkLink,
  paneStepActions,
  progressText,
  stepActionLabel,
  stepLinks,
} from './planModel';
import { cap, StepMarker } from './StepMarker';
import { type PlanActions, usePlanActions } from './usePlanActions';

export interface PlanPaneProps {
  burrow: string;
  planId: string;
  /** `&step=`: scrolled to and highlighted. */
  stepId?: string;
  /** Removes `?plan=` (the × button; Esc is handled by the shell). */
  onClose: () => void;
}

/**
 * The plan pane (work-supervision WS-09): a 400px right pane like the thread pane, `?plan=<id>` on the conversation
 * route. Title, due date and progress; every step with its marker, state, note, the work it links to and its next
 * actions (core `planStepActions`: Start, Mark done, Retry, Cancel, Open work); add, edit, reorder and remove (only a
 * step that never started); create or open the plan canvas; the message it was made from. A plan is the agent's own
 * work: its steps have no owner to pick and nothing is handed over (Whombat one-agent.md OA-14; app one-agent.md
 * AP-4952).
 */
export function PlanPane({ burrow, planId, stepId, onClose }: PlanPaneProps) {
  const { data, error, refetch } = usePlan({ params: { burrow, planId } });
  const plan = data?.plan;
  useSubscription(plan ? topics.conversation(plan.conversationId) : null);

  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>
        <div className={styles.paneHeading}>
          <h2 className={styles.paneTitle}>Plan</h2>
          {plan && <PlanContext burrow={burrow} plan={plan} />}
        </div>
        <IconButton label="Close plan" onClick={onClose}>
          <Icon name="close" size={16} />
        </IconButton>
      </div>
      <div className={styles.paneBody}>
        {plan ? (
          <PlanBody burrow={burrow} plan={plan} stepId={stepId} />
        ) : error ? (
          <ErrorNote
            message={
              'status' in error && error.status === 404
                ? 'This plan isn’t here any more, or it’s in a room you’re not in.'
                : 'Couldn’t load this plan. Try again in a moment.'
            }
            onRetry={'status' in error && error.status === 404 ? undefined : () => void refetch()}
          />
        ) : (
          <SkeletonRows count={5} avatarSize={22} lines={2} />
        )}
      </div>
    </div>
  );
}

function PlanContext({ burrow, plan }: { burrow: string; plan: Plan }) {
  const { data: detail } = useConversation(
    plan.conversationId ? { params: { burrow, conversationId: plan.conversationId } } : null,
    { retry: false },
  );
  const where = detail ? conversationLabel(detail.conversation) : null;
  const due = plan.due ? formatDue(plan.due) : null;
  const text = [where, due].filter(Boolean).join(' · ');
  return text ? <span className={styles.paneContext}>{text}</span> : null;
}

function PlanBody({ burrow, plan, stepId }: { burrow: string; plan: Plan; stepId?: string }) {
  const actions = usePlanActions(burrow);
  const viewer = useBurrowViewer(burrow);
  const navigate = useNavigateHref();
  const here = useHereHref();
  const menu = useRowMenu();
  const { done, total } = planProgress(plan);
  const canvasHref = plan.canvasSlug ? appPath({ type: 'canvas', slug: plan.canvasSlug }) : null;

  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  const workHref = (link: ReturnType<typeof stepLinks>[number]) =>
    link.link.type === 'approval' ? here({ approval: link.link.number }) : appPath(link.link);

  const source = plan.source;
  const sourceHref = source
    ? source.threadRootId && source.threadRootId !== source.messageId
      ? here({ thread: source.threadRootId, plan: undefined, step: undefined })
      : `${here({ plan: undefined, step: undefined })}#${source.messageId}`
    : null;
  const maker = plan.createdById ? viewer.shortName(plan.createdById) : null;

  return (
    <>
      <PlanTitle plan={plan} actions={actions} />
      <div className={styles.progressRow}>
        <span className={styles.progressText}>{progressText(plan)}</span>
        <DueField plan={plan} actions={actions} />
      </div>
      {total > 0 && (
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label="Plan progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <span className={styles.progressFill} style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
      )}

      <section className={styles.section} aria-label="Steps">
        <SectionLabel as="h3">{`STEPS · ${plan.steps.length}`}</SectionLabel>
        {plan.steps.length === 0 ? (
          <EmptyNote>No steps yet. Add the first one below.</EmptyNote>
        ) : (
          <ol className={styles.stepList}>
            {plan.steps.map((step, i) => (
              <StepRow
                key={step.id}
                plan={plan}
                step={step}
                index={i}
                focused={step.id === stepId}
                actions={actions}
                workHref={workHref}
                follow={follow}
                onMenu={(event, label, items) => menu.open(event, step.id, label, items)}
                menuOpen={menu.openKey === step.id}
              />
            ))}
          </ol>
        )}
        <AddStep plan={plan} actions={actions} />
      </section>

      {menu.element}
      <section className={styles.section} aria-label="Plan canvas and source">
        <SectionLabel as="h3">CANVAS</SectionLabel>
        <div className={styles.canvasRow}>
          {canvasHref ? (
            <a href={canvasHref} className={styles.linkButton} onClick={follow(canvasHref)}>
              Open plan canvas
            </a>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={actions.pending === `canvas:${plan.id}`}
              onClick={() => void actions.createCanvas(plan)}
            >
              {actions.pending === `canvas:${plan.id}` ? 'Creating…' : 'Create plan canvas'}
            </Button>
          )}
        </div>
        {(sourceHref || maker) && (
          <p className={styles.provenance}>
            {maker ? `Made by ${maker}` : 'Made'}
            {plan.createdAt ? ` at ${formatClock(plan.createdAt, viewer.timeZone)}` : ''}
            {sourceHref && (
              <>
                {' from '}
                <a href={sourceHref} className={styles.inlineLink} onClick={follow(sourceHref)}>
                  this message
                </a>
              </>
            )}
            .
          </p>
        )}
      </section>
    </>
  );
}

function PlanTitle({ plan, actions }: { plan: Plan; actions: PlanActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.title);
  if (!editing)
    return (
      <div className={styles.titleRow}>
        <h3 className={styles.planTitle}>{plan.title}</h3>
        <IconButton
          label="Rename plan"
          className={styles.quietIcon}
          onClick={() => {
            setDraft(plan.title);
            setEditing(true);
          }}
        >
          <Icon name="edit" size={15} />
        </IconButton>
      </div>
    );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title || title === plan.title) return setEditing(false);
    if (await actions.rename(plan, title)) setEditing(false);
  };
  return (
    <form className={styles.inlineForm} onSubmit={(e) => void save(e)}>
      <input
        className={styles.textInput}
        value={draft}
        maxLength={160}
        aria-label="Plan title"
        // biome-ignore lint/a11y/noAutofocus: the user just asked to rename
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

function DueField({ plan, actions }: { plan: Plan; actions: PlanActions }) {
  return (
    <label className={styles.dueField}>
      <span className={styles.dueLabel}>Due</span>
      <input
        type="date"
        className={styles.dateInput}
        value={plan.due ?? ''}
        onChange={(e) => void actions.setDue(plan, e.target.value || null)}
      />
    </label>
  );
}

interface StepRowProps {
  plan: Plan;
  step: PlanStep;
  index: number;
  focused: boolean;
  actions: PlanActions;
  workHref: (link: ReturnType<typeof stepLinks>[number]) => string;
  follow: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
  onMenu: (event: MouseEvent<HTMLElement>, label: string, items: ContextMenuItem[]) => void;
  menuOpen: boolean;
}

function StepRow({ plan, step, index, focused, actions, workHref, follow, onMenu, menuOpen }: StepRowProps) {
  const ref = useRef<HTMLLIElement>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [title, setTitle] = useState(step.title);
  const links = stepLinks(step);
  const { buttons, more, removable } = paneStepActions(step);
  const busy = actions.pending?.endsWith(`:${step.id}`) ?? false;
  const n = index + 1;

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView?.({ block: 'center' });
    ref.current?.focus({ preventScroll: true });
  }, [focused]);

  const act = (action: PlanStepAction) => {
    switch (action) {
      case 'start':
        return void actions.start(plan, step, 'start');
      case 'retry':
        return void actions.start(plan, step, 'retry');
      case 'mark_done':
        return void actions.markDone(plan, step);
      case 'cancel':
        return void actions.cancel(plan, step);
      default:
        return;
    }
  };
  const work = openWorkLink(step);
  const moreButton = (
    <IconButton
      label={`More for step ${n}`}
      className={cx(styles.toolButton, menuOpen && styles.toolButtonOpen)}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      disabled={busy}
      onClick={(event) => onMenu(event, `Step ${n}`, menuItems)}
    >
      <Icon name="more" size={15} />
    </IconButton>
  );
  // Buttons only where the person is needed (and the way to the work); the rest, edits and order in the step's menu.
  const primary: PlanStepAction[] = buttons.slice(0, 2);
  const menuItems: ContextMenuItem[] = [
    ...more.map((a) => ({ label: stepActionLabel(a, step), onSelect: () => act(a) })),
    {
      label: 'Edit title',
      onSelect: () => {
        setTitle(step.title);
        setMode('edit');
      },
    },
    ...(index > 0 ? [{ label: 'Move up', onSelect: () => void actions.move(plan, step, -1) }] : []),
    ...(index < plan.steps.length - 1
      ? [{ label: 'Move down', onSelect: () => void actions.move(plan, step, 1) }]
      : []),
    ...(removable ? [{ label: 'Remove step', onSelect: () => void actions.remove(plan, step) }] : []),
  ];

  return (
    <li
      ref={ref}
      tabIndex={focused ? -1 : undefined}
      className={cx(styles.step, focused && styles.stepFocused)}
      data-state={step.state}
      aria-label={`Step ${n}: ${step.title}`}
    >
      <StepMarker state={step.state} />
      <div className={styles.stepMain}>
        {mode === 'edit' ? (
          <form
            className={styles.inlineForm}
            onSubmit={async (e) => {
              e.preventDefault();
              const t = title.trim();
              if (!t || t === step.title) return setMode('view');
              if (await actions.editStep(plan, step, t)) setMode('view');
            }}
          >
            <input
              className={styles.textInput}
              value={title}
              maxLength={160}
              aria-label={`Title of step ${n}`}
              // biome-ignore lint/a11y/noAutofocus: the user just asked to edit
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setMode('view');
                }
              }}
            />
            <Button type="submit" variant="primary" size="xs" disabled={!title.trim() || busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </form>
        ) : (
          <span
            className={cx(
              styles.stepTitle,
              step.state === 'done' && styles.stepDone,
              step.state === 'cancelled' && styles.stepCancelled,
            )}
          >
            {step.title}
          </span>
        )}
        <span className={styles.stepMeta}>
          <span className={cx(styles.stepState, styles[`state${cap(step.state)}`])}>{step.stateLabel}</span>
          {/* Nothing for the person to press: only the step's menu, beside its state. */}
          {mode === 'view' && primary.length === 0 && moreButton}
        </span>
        {step.note && <p className={styles.stepNote}>{step.note}</p>}
        {links.length > 0 && (
          <span className={styles.stepLinks}>
            {links.map((l) => (
              <a key={l.kind} href={workHref(l)} className={styles.inlineLink} onClick={follow(workHref(l))}>
                {l.label}
              </a>
            ))}
          </span>
        )}
        {mode === 'view' && primary.length > 0 && (
          <div className={styles.stepActions}>
            {primary.map((action) =>
              action === 'open_work' ? (
                work && (
                  <a
                    key={action}
                    href={workHref(work)}
                    className={styles.smallLinkButton}
                    onClick={follow(workHref(work))}
                  >
                    {ACTION_LABEL.open_work}
                  </a>
                )
              ) : (
                <Button
                  key={action}
                  variant={action === 'start' || action === 'retry' ? 'primary' : 'secondary'}
                  size="xs"
                  disabled={busy}
                  aria-label={`${stepActionLabel(action, step)}: step ${n}`}
                  onClick={() => act(action)}
                >
                  {actions.pending === `${action}:${step.id}`
                    ? `${stepActionLabel(action, step)}…`
                    : stepActionLabel(action, step)}
                </Button>
              ),
            )}
            {moreButton}
          </div>
        )}
      </div>
    </li>
  );
}

/** Add a step (WS-07): the agent's next queued step. A refusal shows under the form in the server's words. */
function AddStep({ plan, actions }: { plan: Plan; actions: PlanActions }) {
  const [title, setTitle] = useState('');
  const busy = actions.pending === `add:${plan.id}`;
  return (
    <form
      className={styles.addStep}
      aria-label="Add a step"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = title.trim();
        if (!t) return;
        if (await actions.addStep(plan, t)) setTitle('');
      }}
    >
      <div className={styles.addStepRow}>
        <input
          className={styles.textInput}
          value={title}
          maxLength={160}
          placeholder="Add a step"
          aria-label="New step"
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={!title.trim() || busy}>
          {busy ? 'Adding…' : 'Add step'}
        </Button>
      </div>
    </form>
  );
}
