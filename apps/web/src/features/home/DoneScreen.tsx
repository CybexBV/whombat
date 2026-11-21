import { useChanges, useTheAgent } from '@whombat/client/react';
import { useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { SkeletonRows } from '../../components/ListState';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import settings from '../settings/SettingsScreen.module.css';
import { DoneList } from './DoneList';
import styles from './Home.module.css';

/** How many changes a page asks for, and the most one read takes (`changes.list` caps `limit` at 100). */
const PAGE = 20;
const MOST = 100;

export interface DoneScreenProps {
  burrow: string;
}

/**
 * Everything I did (`/done`; one-whombat.md ONE-08; app one-whombat-shell.md AP-1263): every change the assistant made
 * through its tools, newest first, with Undo while it can be undone. “Show more” reads further back.
 */
export function DoneScreen({ burrow }: DoneScreenProps) {
  const { timeZone } = useBurrowContext(burrow);
  const { words } = useTheAgent(burrow);
  const now = useNow(60_000);
  const [limit, setLimit] = useState(PAGE);
  const { data, error, refetch, isFetching } = useChanges(
    { params: { burrow }, query: { limit } },
    { placeholderData: (previous) => previous },
  );
  return (
    <div className={settings.scroll} data-screen="done">
      <div className={settings.page}>
        <div className={settings.header}>
          <div className={settings.heading}>
            <h1 className={settings.title}>Everything I did</h1>
            <p className={settings.subtitle}>
              What {words.name} changed for you, newest first. Undo works for a day where there’s a way back.
            </p>
          </div>
        </div>
        <div className={settings.panel}>
          {error && !data ? (
            <LoadErrorNote
              error={error}
              message="This list couldn’t load. Try again."
              onRetry={() => void refetch()}
            />
          ) : !data ? (
            <SkeletonRows count={6} />
          ) : (
            <section className={styles.card}>
              <DoneList
                burrow={burrow}
                changes={data.changes}
                now={now}
                timeZone={timeZone}
                empty={`Nothing yet. What ${words.name} changes for you shows up here.`}
              />
              {data.before && limit < MOST && (
                <div className={styles.more}>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={isFetching}
                    onClick={() => setLimit((l) => Math.min(MOST, l + PAGE))}
                  >
                    Show more
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
