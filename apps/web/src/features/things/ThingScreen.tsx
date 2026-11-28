/**
 * A thing's page (`/things/:thing`, one Whombat ONE-04/ONE-05): `servers?view=guests` every guest of every server (the
 * servers list is part of Connections, CN-09: without the view the router takes it there, and so does this), `server:<id>` a server's
 * page (mock 2), and a connection or a device its own page (Whombat connection-pages.md CP-01; connection-pages-web.md),
 * each in its place with the place's list beside it (servers-connections-places.md). A runtime without `things.pages` opens a connection's page in Settings → Connections as before (CP-18;
 * AP-1300). Props as the route passes them: the open burrow and the thingId, URL-encoded or not.
 */

import { useRouterState } from '@tanstack/react-router';
import { parseThingId } from '@whombat/core';
import { useEffect } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { PLACE_HREFS } from '../../app/shell/assistantSidebarModel';
import { ThingPageScreen } from './page/ThingPageScreen';
import { ThingInPlace } from './places/ThingPlace';
import { ServerPage } from './ServerPage';
import { ServersPage } from './ServersPage';
import styles from './Things.module.css';

export interface ThingScreenProps {
  burrow: string;
  /** The thingId (`server:pve-02`, `connection:con_…`, `device:con_…`) or `servers`. */
  thing: string;
}

export function ThingScreen({ burrow, thing }: ThingScreenProps) {
  const decoded = safeDecode(thing);
  if (decoded === 'servers') return <ServersAddress burrow={burrow} />;
  const parsed = parseThingId(decoded);
  // A server's or connection's page sits in its place, the place's list beside it (servers-connections-places.md).
  if (parsed?.kind === 'server')
    return (
      <ThingInPlace burrow={burrow} thing={decoded}>
        <ServerPage key={parsed.id} burrow={burrow} serverId={parsed.id} />
      </ThingInPlace>
    );
  if (parsed)
    return (
      <ThingInPlace burrow={burrow} thing={decoded}>
        <ThingPageScreen key={decoded} burrow={burrow} thing={decoded} />
      </ThingInPlace>
    );
  return (
    <div className={styles.page}>
      <h1 className={styles.titleSans}>Not found</h1>
      <p className={styles.dialogBody}>There’s nothing here by that name.</p>
    </div>
  );
}

/** `/things/servers`: every guest with `?view=guests`, else the Servers list with the query (the router does it first). */
function ServersAddress({ burrow }: { burrow: string }) {
  const guests = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown>).view === 'guests',
  });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const navigate = useNavigateHref();
  useEffect(() => {
    if (!guests) navigate(`${PLACE_HREFS.servers}${searchStr}`, { replace: true });
  }, [guests, navigate, searchStr]);
  return guests ? <ServersPage burrow={burrow} /> : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
