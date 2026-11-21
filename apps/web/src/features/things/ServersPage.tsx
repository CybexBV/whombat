/**
 * Every guest of every server (`/things/servers?view=guests`; ported from Rackoon's `GuestsPage`): the Servers group's
 * “All guests” on Connections (Whombat connections-page.md CN-09; app AP-2523), with its filters and bulk power and the
 * crumb back to Connections. The servers list that lived here is part of Connections now: `/things/servers` without
 * the view goes there (the router), with Add a server and its fields.
 */
import { fleetLine, isHostsUnavailable } from '@whombat/client/hosts';
import { useHostsFleet, useHostsLive, useHostsStatus } from '@whombat/client/hosts/react';
import { CONNECTIONS_HREF } from '@whombat/core';
import { useBurrowContext } from '../messaging/useRoom';
import { Crumb } from './dashboard/PageHead';
import { FleetGuests } from './FleetGuests';
import { Card, ErrorLine, Skeleton } from './parts';
import styles from './Things.module.css';

export function ServersPage({ burrow }: { burrow: string }) {
  const { bootstrap } = useBurrowContext(burrow);
  useHostsLive(bootstrap?.burrow.id);
  const status = useHostsStatus({ params: { burrow } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow }, query: {} } : null);
  const servers = fleet.data?.servers ?? [];
  let body: React.ReactNode;
  if (status.data && !present)
    body = <p className={styles.dialogBody}>Servers aren’t set up on this Whombat.</p>;
  else if (
    isHostsUnavailable(status.error) ||
    isHostsUnavailable(fleet.error) ||
    status.data?.healthy === false
  )
    body = <p className={styles.dialogBody}>Servers aren’t reachable right now. Whombat keeps trying.</p>;
  else if (fleet.error) body = <ErrorLine error={fleet.error} onRetry={() => void fleet.refetch()} />;
  else if (!fleet.data) body = <Skeleton height={240} />;
  else if (!servers.length)
    body = (
      <Card>
        <p className={styles.empty}>No servers yet.</p>
      </Card>
    );
  else body = <FleetGuests burrow={burrow} servers={servers} />;
  return (
    <div className={styles.screen} data-screen="servers">
      <div className={styles.scroll}>
        <main className={styles.page} aria-label="Everything running on your servers">
          <Crumb href={CONNECTIONS_HREF} label="Connections" />
          <div className={styles.head}>
            <h1 className={styles.titleSans}>Everything running on your servers</h1>
          </div>
          {servers.length ? <div className={styles.facts}>{fleetLine(servers)}</div> : null}
          {body}
        </main>
      </div>
    </div>
  );
}
