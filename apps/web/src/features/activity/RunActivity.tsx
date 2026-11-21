import { appPath } from '@whombat/client';
import { useActivity } from '@whombat/client/react';
import { useHereHref, useNavigateHref } from '../../app/routing/navigation';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { ActivityFeed } from './ActivityFeed';
import styles from './ActivityFeed.module.css';

export interface LiveActivityProps {
  burrow: string;
  /** A run's activity (all its turns) or one turn's. */
  of: { runNumber: number } | { dispatchId: string };
  /** The section label (“ACTIVITY” on the run page); none in a NEEDS YOU row. */
  label?: string;
  compact?: boolean;
}

/**
 * Observed activity from `activity.list`, live through `activity.updated` (the run page subscribes to `run:<id>`,
 * the conversation topics carry the rest). Quiet while it loads; a Whombat without activity (an older server) shows
 * nothing rather than an error.
 */
export function RunActivity({ burrow, of, label, compact = false }: LiveActivityProps) {
  const { data, error, refetch } = useActivity({ params: { burrow }, query: of }, { retry: false });
  const viewer = useBurrowViewer(burrow);
  const navigate = useNavigateHref();
  const here = useHereHref();
  const missing = error && 'status' in error && error.status === 404 && !data;
  if (missing) return null;
  return (
    <section className={styles.section} aria-label={label ? 'Activity' : undefined} data-run-activity="">
      {label && <SectionLabel as="h2">{label}</SectionLabel>}
      {data ? (
        <ActivityFeed
          activities={data.activities}
          timeZone={viewer.timeZone}
          compact={compact}
          linkHref={(link) =>
            link.type === 'approval' && !link.in ? here({ approval: link.number }) : appPath(link)
          }
          onNavigate={(href) => navigate(href)}
        />
      ) : error ? (
        <ErrorNote
          message="Couldn’t load the activity. Try again in a moment."
          onRetry={() => void refetch()}
        />
      ) : (
        <SkeletonRows count={compact ? 2 : 4} lines={1} />
      )}
    </section>
  );
}
