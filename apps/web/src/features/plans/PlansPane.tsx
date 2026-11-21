import { useRouterState } from '@tanstack/react-router';
import { useBootstrap, usePlans } from '@whombat/client/react';
import { type Bootstrap, type ConversationSummary, formatDue, type Plan, planProgress } from '@whombat/core';
import { useState } from 'react';
import { useSearchUpdate } from '../../app/routing/navigation';
import { parseShellLocation, type ShellLocation } from '../../app/shell/location';
import { Button, IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { roomRepo } from '../branch/prLinks';
import { CreatePlanModal } from './CreatePlanModal';
import styles from './Plans.module.css';
import { progressText } from './planModel';
import { cap, StepMarker } from './StepMarker';

/** The conversation the page shows, from the sidebar the bootstrap carries. */
export function conversationAt(
  bootstrap: Bootstrap | undefined,
  location: ShellLocation,
): ConversationSummary | null {
  const s = bootstrap?.sidebar;
  if (!s) return null;
  switch (location.kind) {
    case 'pr': {
      // The room's repo when the address names one (AP-496).
      const rooms = s.branchRooms.filter((c) => c.prNumber === location.number);
      return (location.repo ? rooms.find((c) => roomRepo(c) === location.repo) : rooms[0]) ?? null;
    }
    default:
      return null;
  }
}

/** The page's conversation (a branch room), or null elsewhere / while loading. */
export function useCurrentConversation(burrow: string): ConversationSummary | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search });
  const { data } = useBootstrap({ params: { burrow } });
  return conversationAt(data, parseShellLocation(pathname, search as Record<string, unknown>));
}

/** The furthest-along state a plan shows in the list: the first step that needs someone, else the first open one. */
function headline(plan: Plan) {
  return (
    plan.steps.find((s) => s.state === 'gate' || s.state === 'blocked') ??
    plan.steps.find((s) => s.state === 'active' || s.state === 'queued') ??
    null
  );
}

/**
 * The conversation header's “Plans” (WS-09): this conversation's plans, open ones first, each opening the plan pane;
 * “Make a plan” at the top. Works on an unseeded burrow: an empty state with the way to make one.
 */
export function PlansPane({ burrow, onClose }: { burrow: string; onClose: () => void }) {
  const conversation = useCurrentConversation(burrow);
  const updateSearch = useSearchUpdate();
  const [making, setMaking] = useState(false);
  const { data, error, refetch } = usePlans(
    conversation ? { params: { burrow }, query: { conversationId: conversation.id, status: 'all' } } : null,
  );
  const open = (plan: Plan) =>
    void updateSearch((s) => ({ ...s, plans: undefined, plan: plan.id, step: undefined, thread: undefined }));
  const plans = data?.plans ?? [];
  const sorted = [
    ...plans.filter((p) => planProgress(p).done < planProgress(p).total || p.steps.length === 0),
    ...plans.filter((p) => p.steps.length > 0 && planProgress(p).done === planProgress(p).total),
  ];

  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>
        <div className={styles.paneHeading}>
          <h2 className={styles.paneTitle}>Plans</h2>
          {conversation && <span className={styles.paneContext}>{conversation.title}</span>}
        </div>
        <IconButton label="Close plans" onClick={onClose}>
          <Icon name="close" size={16} />
        </IconButton>
      </div>
      <div className={styles.paneBody}>
        {conversation && (
          <Button variant="secondary" size="sm" className={styles.makePlan} onClick={() => setMaking(true)}>
            Make a plan
          </Button>
        )}
        {!conversation ? (
          <SkeletonRows count={3} lines={2} />
        ) : error ? (
          <ErrorNote
            message="Couldn’t load this conversation’s plans. Try again in a moment."
            onRetry={() => void refetch()}
          />
        ) : !data ? (
          <SkeletonRows count={3} lines={2} />
        ) : sorted.length === 0 ? (
          <EmptyNote>
            No plans here yet. Make one to share who does what, or use “Make a plan” on a message.
          </EmptyNote>
        ) : (
          <section className={styles.section} aria-label="Plans in this conversation">
            <SectionLabel as="h3">{`PLANS · ${sorted.length}`}</SectionLabel>
            <ul className={styles.planList}>
              {sorted.map((plan) => {
                const next = headline(plan);
                return (
                  <li key={plan.id}>
                    <button type="button" className={styles.planRow} onClick={() => open(plan)}>
                      <span className={styles.planRowTitle}>{plan.title}</span>
                      <span className={styles.planRowMeta}>
                        {progressText(plan)}
                        {plan.due ? ` · ${formatDue(plan.due)}` : ''}
                      </span>
                      {next && (
                        <span className={styles.planRowNext}>
                          <StepMarker state={next.state} size={12} />
                          <span className={styles.planRowStep}>{next.title}</span>
                          <span className={styles[`state${cap(next.state)}`]}>{next.stateLabel}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {conversation && (
        <CreatePlanModal
          burrow={burrow}
          conversationId={conversation.id}
          open={making}
          onOpenChange={setMaking}
          onCreated={open}
        />
      )}
    </div>
  );
}
