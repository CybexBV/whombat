import {
  agentFaceOf,
  lookFixOutcomeText,
  lookResearchView,
  lookThreadHref,
  researchPlanView,
  threadToOpen,
} from '@whombat/client';
import { useFixLook, useTheAgent } from '@whombat/client/react';
import type { ThingPage } from '@whombat/core';
import { useNavigateHref } from '../../../app/routing/navigation';
import { Button } from '../../../components/Button';
import { useToast } from '../../../components/Toast';
import { LookPlanBody } from '../../cards/LookPlanCard';
import { LookSays } from '../../home/LookSays';
import styles from './LookCard.module.css';

/**
 * What the assistant found out about what needs a look here (Whombat look-research.md LR-09; contracts 3.5
 * `ThingPage.research`; app look-research-web.md AP-5906), at the top of the Summary of a connection's, device's or
 * server's page (a server's research comes from `looks.get`, handle-it.md): its title, its words by its face, the step
 * it offers and Ask {assistant}, which opens the look's thread (the Ask pane without one). While it looks, a line saying
 * so; green once fixed. A plan of several steps shows as the plan card, with Go ahead and Change something (the
 * thread). Ignore stays on the line in Worth a look, which is the one it quiets.
 */
export function LookCard({
  burrow,
  page,
  onAsk,
}: {
  burrow: string;
  page: Pick<ThingPage, 'research' | 'status' | 'name'>;
  onAsk: () => void;
}) {
  const { agent, words } = useTheAgent(burrow);
  const navigateHref = useNavigateHref();
  const toast = useToast();
  // The go-ahead opens the look's thread, where the step is taken (backup-places.md BPL-15).
  const { mutate: fix, isPending } = useFixLook(burrow, (outcome, thread) => {
    const text = lookFixOutcomeText(outcome);
    if (text) toast.show(text);
    const open = threadToOpen(thread);
    if (open) navigateHref(open);
  });
  const research = page.research;
  const view = lookResearchView(research, words.name);
  if (!research || !view) return null;
  const bad = page.status === 'bad' || page.status === 'offline';
  const tone = view.fixed ? 'ok' : bad ? 'bad' : 'warn';
  const thread = lookThreadHref(research);
  const plan = researchPlanView(research, page.name);
  if (plan)
    return (
      <LookPlanBody
        burrow={burrow}
        view={plan}
        research={research}
        variant="page"
        tone={bad ? 'bad' : 'warn'}
        onChange={() => (thread ? navigateHref(thread) : onAsk())}
      />
    );
  const buttons = view.fix || view.ask;
  return (
    <section
      className={styles.card}
      data-tone={tone}
      data-research={view.state}
      aria-label={view.title ?? view.text}
    >
      {view.title ? <h2 className={styles.title}>{view.title}</h2> : null}
      <LookSays view={view} face={agentFaceOf(agent)} name={words.name} size={22} className={styles.says} />
      {buttons ? (
        <div className={styles.buttons}>
          {view.fix ? (
            <Button variant="primary" size="sm" disabled={isPending} onClick={() => fix(research)}>
              {view.fix}
            </Button>
          ) : null}
          {view.ask ? (
            <Button variant="ghost" size="sm" onClick={() => (thread ? navigateHref(thread) : onAsk())}>
              {view.ask}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
