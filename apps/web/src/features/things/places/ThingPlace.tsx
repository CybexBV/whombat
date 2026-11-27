/**
 * Servers and Connections as places (servers-connections-places.md):
 *
 * - `ThingInPlace` wraps a server's or connection's page (`/things/<id>`): on a wide window (Chat's split, 1240 px) its
 *   place's list sits beside it; on a narrower one the page is alone with “‹ Servers” back to the list. A page neither
 *   list holds keeps the whole width and its own crumb.
 * - `PlaceScreen` is `/servers` and `/connected`: on a wide window it opens the page looked at last in that place, else
 *   the first row (never an empty right side); on a narrow one, or with nothing listed, it is the list alone.
 */

import { useRouterState } from '@tanstack/react-router';
import {
  PLACE_WORDS,
  type PlaceRow,
  placeOfThing,
  placeOpening,
  SERVERS_DOWN,
  type ThingPlace,
} from '@whombat/client';
import { type ReactNode, useEffect } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { PLACE_HREFS } from '../../../app/shell/assistantSidebarModel';
import { useInboxSplit } from '../../chats/inboxNav';
import { isAskOpen } from '../AskPane';
import { useThingSearch } from '../search';
import { keepLastViewed, readLastViewed } from './lastViewed';
import { PlaceList } from './PlaceList';
import styles from './Places.module.css';
import { PlaceCrumbProvider } from './placeContext';
import { type PlaceLists, usePlaceLists } from './usePlaceLists';

function rowsOf(lists: PlaceLists, place: ThingPlace): PlaceRow[] {
  return place === 'servers' ? lists.servers : lists.connections;
}

/** What an empty list says when nothing could be read, with Retry; null when it simply holds nothing. */
function failureOf(lists: PlaceLists, place: ThingPlace, rows: readonly PlaceRow[]) {
  if (rows.length) return null;
  if (lists.failed) return { message: PLACE_WORDS[place].failed, onRetry: lists.retry };
  if (place === 'servers' && lists.hostsDown) return { message: SERVERS_DOWN, onRetry: lists.retry };
  return null;
}

function addOf(lists: PlaceLists, place: ThingPlace): string | null {
  return place === 'servers' ? lists.addServer : lists.addConnection;
}

/** The place a thing's id names (`server:pve-02`, `connection:con_unifi`), before the lists can say. */
function placeOfThingId(thing: string): ThingPlace | null {
  if (/^server:[^/:]+$/.test(thing)) return 'servers';
  if (/^(?:connection|device):[^/:]+$/.test(thing)) return 'connections';
  return null;
}

export function ThingInPlace({
  burrow,
  thing,
  children,
}: {
  burrow: string;
  /** The thing id, decoded (`server:pve-02`). */
  thing: string;
  children: ReactNode;
}) {
  const lists = usePlaceLists(burrow);
  const [search] = useThingSearch();
  // With Ask open beside the page there is no room for the list too: the page and Ask keep the width, as on a narrow
  // window, with “‹ Servers” back to the list.
  const wide = useInboxSplit() && !isAskOpen(search);
  // Before Home answers, a page opened by its address takes the place its id names, so it isn't drawn full width
  // first and then moved; the lists say for sure once they come.
  // A guest's page or a console over a server's address is its own full-width page, not the server's.
  const over = !!search.guest || !!search.console;
  const place = over ? null : lists.known ? placeOfThing(thing, lists) : placeOfThingId(thing);
  useEffect(() => {
    // Only once the lists say so: a guess from the address alone mustn't replace the one looked at last.
    if (place && lists.known) keepLastViewed(burrow, place, thing);
  }, [burrow, place, thing, lists.known]);
  // One shape whatever the lists say, so the page isn't drawn again (and read again) when they arrive: the list, when
  // there is one, takes the first slot and the page always sits in the second.
  const crumb = !place
    ? undefined
    : wide
      ? null
      : { href: PLACE_HREFS[place], label: PLACE_WORDS[place].back };
  return (
    <div className={styles.split}>
      {place && wide ? (
        <PlaceList
          // Another place is another list: its own scroll, nothing half renamed carried over.
          key={place}
          burrow={burrow}
          place={place}
          rows={rowsOf(lists, place)}
          selected={thing}
          addHref={addOf(lists, place)}
          alone={false}
          loading={!lists.settled[place]}
          failure={failureOf(lists, place, rowsOf(lists, place))}
        />
      ) : null}
      <div className={styles.page}>
        <PlaceCrumbProvider value={crumb}>{children}</PlaceCrumbProvider>
      </div>
    </div>
  );
}

export function PlaceScreen({ burrow, place }: { burrow: string; place: ThingPlace }) {
  const lists = usePlaceLists(burrow);
  const wide = useInboxSplit();
  const navigate = useNavigateHref();
  const rows = rowsOf(lists, place);
  // Only once the rows are final: before, a wide window waits a moment rather than show the list alone and jump.
  const opening = wide && lists.settled[place] ? placeOpening(rows, readLastViewed(burrow, place)) : null;
  // What the address carries for the shell (an approval or a thread opened over it) goes along to the page.
  const carried = useRouterState({
    select: (st) => `${st.location.searchStr}${st.location.hash ? `#${st.location.hash}` : ''}`,
  });
  useEffect(() => {
    if (opening) navigate(`${opening}${carried}`, { replace: true });
  }, [opening, carried, navigate]);
  if (opening) return null;
  // A wide window still waiting for the rows: the list's column where it will stay (its head, nothing under it yet)
  // and the page's side empty, so nothing jumps when the page opens beside it.
  if (wide && !lists.settled[place])
    return (
      <div className={styles.split}>
        <PlaceList
          burrow={burrow}
          place={place}
          rows={rows}
          selected={null}
          addHref={addOf(lists, place)}
          alone={false}
          loading
        />
        <div className={styles.page} aria-busy="true" />
      </div>
    );
  return (
    <div className={styles.alone}>
      <PlaceList
        burrow={burrow}
        place={place}
        rows={rows}
        selected={null}
        addHref={addOf(lists, place)}
        alone
        loading={!lists.settled[place]}
        failure={failureOf(lists, place, rows)}
      />
    </div>
  );
}
