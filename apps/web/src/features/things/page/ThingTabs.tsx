/**
 * A thing page's own tabs after the server's (contracts 0.88 `THING_PAGE_CLIENT_TABS`; connection-pages.md CP-05,
 * CP-01): **Activity** — the changes here, newest first, Whombat's and people's (“You”, Whombat HR-05; app
 * home-redesign.md AP-2213), with Undo while it can be undone and “Show more” —
 * and **Settings** — what Settings → Connections showed for it (sign-in, Look only or Manage, who looks after it, the
 * checks, the tools and their tiers), without its head; a device's actions and their tiers.
 */
import { useChanges, useTheAgent } from '@whombat/client/react';
import type { ThingPage } from '@whombat/core';
import { catalogEntry, isAccountPageId } from '@whombat/core/domain';
import { useState } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { SkeletonRows } from '../../../components/ListState';
import { ConnectionPage } from '../../connectors/ConnectionPage';
import { connectableEntry } from '../../connectors/catalog';
import { DoneList } from '../../home/DoneList';
import home from '../../home/Home.module.css';
import { AccountSettings } from '../../settings/ConnectionsTab';
import { Card } from '../parts';
import { WatchSettings } from '../quiet/WatchSettings';
import styles from './ThingPage.module.css';

/** How many changes a page of Activity asks for, and the most one read takes (`changes.list` caps at 100). */
const PAGE = 20;
const MOST = 100;

export function ActivityTab({
  burrow,
  page,
  now,
  timeZone,
}: {
  burrow: string;
  page: ThingPage;
  now: number;
  timeZone: string;
}) {
  const { words } = useTheAgent(burrow);
  const [limit, setLimit] = useState(PAGE);
  const { data, error, refetch, isFetching } = useChanges(
    { params: { burrow }, query: { thing: page.id, limit } },
    { placeholderData: (previous) => previous },
  );
  if (error && !data)
    return (
      <LoadErrorNote
        error={error}
        message="This list couldn’t load. Try again."
        onRetry={() => void refetch()}
      />
    );
  if (!data) return <SkeletonRows count={4} />;
  return (
    <Card title="Changes here">
      <DoneList
        burrow={burrow}
        changes={data.changes}
        now={now}
        timeZone={timeZone}
        empty={`Nothing yet. What you or ${words.name} change in ${page.name} shows up here.`}
        here={`/things/${encodeURIComponent(page.id)}`}
      />
      {data.before && limit < MOST ? (
        <div className={styles.more}>
          <button
            type="button"
            className={home.btn}
            disabled={isFetching}
            onClick={() => setLimit((l) => Math.min(MOST, l + PAGE))}
          >
            Show more
          </button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Settings: what Settings → Connections shows for it, then What Whombat watches there (quiet-notices.md QN-15;
 * AP-4826): its checks' switches and what is excepted, with Undo. An account's (Google, Microsoft 365, Email, GitHub,
 * Website feedback) is that account's own settings page: sign-in, services, what the assistant may do, repositories,
 * sites.
 */
export function SettingsTab({ burrow, page }: { burrow: string; page: ThingPage }) {
  if (page.kind === 'connection' && isAccountPageId(page.catalogId))
    return (
      <div className={styles.settings}>
        <AccountSettings burrow={burrow} account={page.catalogId} embedded />
        <WatchSettings burrow={burrow} thing={page.id} />
      </div>
    );
  const device = page.kind === 'device';
  const entry = device ? catalogEntry('device') : connectableEntry(page.catalogId);
  if (!entry || !page.connectionId)
    return (
      <div className={styles.settings}>
        <WatchSettings burrow={burrow} thing={page.id} />
      </div>
    );
  return (
    <div className={styles.settings}>
      <ConnectionPage
        burrow={burrow}
        entry={entry}
        connectionId={page.connectionId}
        embedded
        device={device}
      />
      <WatchSettings burrow={burrow} thing={page.id} />
    </div>
  );
}
