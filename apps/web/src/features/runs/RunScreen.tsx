import { useQueryClient } from '@tanstack/react-query';
import { appPath } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useRun, useSubscription } from '@whombat/client/react';
import { conversationLabel, type Run, type RunDetail, topics } from '@whombat/core';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { SkeletonRows } from '../../components/ListState';
import { ScreenPlaceholder } from '../../components/Placeholder';
import { RunActivity } from '../activity';
import { usePrHref } from '../branch/usePrHref';
import { type RunAction, RunView } from './RunView';
import styles from './RunView.module.css';
import { useBurrowViewer } from './useBurrowViewer';
import { useRunControl } from './useRunControl';

export interface RunScreenProps {
  burrow: string;
  /** Run number (`/runs/:number`). */
  number: number;
}

/**
 * Agent run page (TODO 8.1–8.3): live from `runs.get` plus the `run:<id>` topic (`run.updated`,
 * `run.log`), with Pause / Resume / Take over on `api.runs.*`, and Try again on a failed run (CT-197, AP-596). The controls are `useRunControl`'s, shared with a failed run's line and card in a
 * conversation (AP-699).
 */
export function RunScreen({ burrow, number }: RunScreenProps) {
  const params = { burrow, number };
  const { data, error, isPending, refetch } = useRun({ params });
  const viewer = useBurrowViewer(burrow);
  const prHref = usePrHref(burrow);
  const navigate = useNavigateHref();
  const qc = useQueryClient();
  const control = useRunControl(burrow);

  useSubscription(data ? topics.run(data.run.id) : null);

  const setRun = (run: Run) =>
    qc.setQueryData<RunDetail>(queryKeys.runs.get({ params }), (d) => (d ? { ...d, run } : d));

  if (!data) {
    if (isPending) {
      return (
        <section className={styles.screen} data-screen="run" aria-busy="true">
          <SkeletonRows count={6} lines={2} />
        </section>
      );
    }
    const notFound = error && 'status' in error && error.status === 404;
    return (
      <ScreenPlaceholder
        screen="run"
        title={`Run #${number}`}
        subtitle={
          notFound
            ? 'This run doesn’t exist, or it’s in a room you’re not in.'
            : 'Couldn’t load this run. Try again in a moment.'
        }
      >
        {!notFound && (
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        )}
      </ScreenPlaceholder>
    );
  }

  const { run, log, grants, conversation } = data;
  const agent = viewer.principal(run.agentId);
  const agentName = agent?.name ?? 'The agent';
  const agentFace = agent?.kind === 'agent' ? agent.face : null;

  const onAction = (action: RunAction) => control.act(action, run, agentName, setRun);

  return (
    <RunView
      run={run}
      log={log}
      grants={grants}
      agent={{ name: agentName, face: agentFace }}
      askedBy={viewer.shortName(run.askedById)}
      where={conversationLabel(conversation)}
      timeZone={viewer.timeZone}
      viewerId={viewer.me?.id ?? null}
      nameOf={viewer.shortName}
      backHref={appPath(conversation.link)}
      branchRoomHref={run.prNumber ? prHref(run.prNumber, run.repoId) : null}
      onNavigate={(href) => navigate(href)}
      onAction={onAction}
      pending={control.pending}
      activity={<RunActivity burrow={burrow} of={{ runNumber: run.number }} label="ACTIVITY" />}
    />
  );
}
