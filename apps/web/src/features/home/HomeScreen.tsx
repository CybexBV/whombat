import { Link } from '@tanstack/react-router';
import {
  CHAT_WORDS,
  type ConnectionsTab,
  type HomeSlot,
  homeSection,
  homeSections,
  homeStatus,
  homeWebSlots,
  NEEDS_YOU_WORDS,
  OVERVIEW_WORDS,
  type OverviewSectionView,
  overviewHeadline,
  overviewSectionAnchor,
  overviewSectionForTab,
  overviewSections,
  overviewTiles,
  readState,
} from '@whombat/client';
import { EVERYTHING_RUNNING_HREF, isHostsUnavailable } from '@whombat/client/hosts';
import { useHomeOverview, useTheAgent } from '@whombat/client/react';
import { ChevronRight, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { INBOX_PATH } from '../../app/shell/location';
import { Icon } from '../../components/Icon';
import { StatusMark } from '../../components/StatusMark';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { AddServerDialog } from '../things/AddServer';
import { AppLink } from '../things/parts';
import { RepointServersDialog } from '../things/RepointServers';
import { useThingSearch } from '../things/search';
import { EmptyConnections } from './EmptyConnections';
import styles from './Home.module.css';
import o from './Overview.module.css';
import { OverviewConnections } from './OverviewConnections';
import { OverviewServers, RowPlaceholders, useOverviewFleet } from './OverviewServers';
import { ReadNote } from './ReadState';
import { useHandleIt } from './useHandleIt';
import { WidgetCard } from './WidgetCard';

export interface HomeScreenProps {
  burrow: string;
}

/** Scrolls to a section and moves focus there; at once when the person asked for less motion. */
function goToSection(anchor: string, smooth: boolean) {
  const el = document.getElementById(anchor);
  if (!el) return false;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
  el.scrollIntoView?.({ behavior: smooth && !still ? 'smooth' : 'auto', block: 'start' });
  el.focus({ preventScroll: true });
  return true;
}

/** A section's heading row: its name, count, summary line and links. */
function SectionHead({ view, links }: { view: OverviewSectionView; links?: ReactNode }) {
  return (
    <div className={o.sech}>
      <h2 id={`${view.anchor}-title`}>{view.label}</h2>
      <span className={o.count}>{view.count}</span>
      {view.summary ? <span className={o.meta}>{view.summary}</span> : null}
      {links ? <span className={o.links}>{links}</span> : null}
    </div>
  );
}

function Section({
  view,
  links,
  children,
}: {
  view: OverviewSectionView;
  links?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={view.anchor}
      className={o.section}
      aria-labelledby={`${view.anchor}-title`}
      data-section={view.key}
      tabIndex={-1}
    >
      <SectionHead view={view} links={links} />
      {children}
    </section>
  );
}

/**
 * Overview on one page (docs/decisions/overview-one-page.md): the title with the status sentence when nothing is broken
 * and the jump links on the right, the broken thing and how many other things need the person
 * (overview-server-connection-final.md OSC-01), then **Servers** (one list, a row a server), **Connections** (small
 * tiles) and **Pinned** (what was pinned from a chat), each with its heading, count and line. An old `?tab=` scrolls to
 * its section once. Add a server opens here (`?add=1`), and Point them here (`?repoint=1`, backup-file.md AP-4417).
 * Live through `home.changed`, `hosts:<burrowId>` and the shell's own writes.
 */
export function HomeScreen({ burrow }: HomeScreenProps) {
  const { me, timeZone } = useBurrowContext(burrow);
  const now = useNow(30_000);
  const { data, error, refetch, isFetching } = useHomeOverview({ params: { burrow } });
  const { words, agent } = useTheAgent(burrow);
  // Loading, a failed first read, a failed refresh (the saved readings stay), apart from a refresh that is going.
  const read = readState({ hasData: !!data, error, fetching: isFetching });
  // Servers shows where the hosts service runs (it says so when it is down).
  const hosts = useOverviewFleet(burrow);
  const servers = hosts.present || isHostsUnavailable(hosts.status.error);
  const [search, set] = useThingSearch();
  const adding = search.add === '1' || search.add === 'server';
  // Point them here (BF-16's Needs you item, `?repoint=1`; backup-file.md AP-4417).
  const repointing = !adding && search.repoint === '1';
  // Every person may add a connection of their own; a shared one asks for a manager on its page (CX-03).
  const canAdd = me?.kind === 'person';
  const headline = data ? overviewHeadline(data, { timeZone }) : null;
  const status = headline?.kind === 'status' ? headline.status : data ? homeStatus(data, { timeZone }) : null;
  // The Inbox item the headline names, for its link and *Look into it*.
  const headlineItem = (status?.itemId && data?.needsYou.find((i) => i.id === status.itemId)) || null;
  const handleIt = useHandleIt(burrow, timeZone);
  const sections = useMemo(
    () => (data ? homeSections(data, { now, timeZone, servers, canAddConnection: canAdd }) : []),
    [data, now, timeZone, servers, canAdd],
  );
  const pinned = useMemo(
    () => homeWebSlots(sections).filter((s): s is Extract<HomeSlot, { panel: unknown }> => 'panel' in s),
    [sections],
  );
  const things = homeSection(sections, 'things');
  const thingRows = things?.rows ?? [];
  const views = useMemo(() => overviewSections(sections, hosts.servers), [sections, hosts.servers]);
  const view = (key: ConnectionsTab) => views.find((v) => v.key === key) ?? null;
  // A section with nothing in it isn't drawn; Connections stays for whoever may add one (its link is in its heading).
  const shown = views.filter((v) => v.key !== 'services' || v.count > 0 || canAdd);
  const tiles = useMemo(
    () => (data ? overviewTiles(thingRows, data.things, now, timeZone, agent?.name ?? null) : []),
    [data, thingRows, now, timeZone, agent?.name],
  );
  // Nothing connected, no servers, nothing pinned: one card and one step instead of empty sections (first-day.md).
  const empty = !!data && !homeSection(sections, 'servers') && thingRows.length === 0 && pinned.length === 0;

  // An old `?tab=` address (the tabs before) scrolls to its section once, when it is there.
  const arrived = useRef(false);
  const asked = overviewSectionForTab(search.tab);
  useEffect(() => {
    if (arrived.current || !asked || !data) return;
    if (goToSection(overviewSectionAnchor(asked), false)) arrived.current = true;
  });

  const servicesView = view('services');
  const serversView = view('servers');
  const pinnedView = view('pinned');

  return (
    <div className={styles.scroll} data-screen="home">
      <div className={o.page}>
        <header className={o.head}>
          <h1>{CHAT_WORDS.dashboard}</h1>
          {headline?.kind === 'status' && status ? (
            <p className={o.sentence} data-tone={status.tone}>
              {status.tone === 'ok' ? <span className={o.okDot} aria-hidden="true" /> : null}
              <span>
                {status.parts.map((part, i) =>
                  part.strong ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the sentence's pieces in order
                    <b key={i}>{part.text}</b>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the sentence's pieces in order
                    <span key={i}>{part.text}</span>
                  ),
                )}
              </span>
            </p>
          ) : null}
          {data && !empty && shown.length > 1 ? (
            <nav className={o.jump} aria-label={OVERVIEW_WORDS.onThisPage}>
              {shown.map((v) => (
                <a
                  key={v.key}
                  href={`#${v.anchor}`}
                  onClick={(e) => {
                    e.preventDefault();
                    goToSection(v.anchor, true);
                  }}
                >
                  {v.label}
                  <span className={o.jumpCount}>{v.count}</span>
                  {v.tone ? (
                    <StatusMark
                      className={o.jumpDot}
                      level={v.tone === 'bad' ? 'notWorking' : 'needsLook'}
                      label={v.tone === 'bad' ? 'something isn’t working' : 'something needs a look'}
                    />
                  ) : null}
                </a>
              ))}
            </nav>
          ) : null}
        </header>
        <div className={o.body}>
          {headline?.kind === 'broken' && headlineItem ? (
            <>
              {/* The broken thing first: its title (to its Inbox row), its consequence, one Look into it. */}
              <section className={o.broken} aria-labelledby="overview-broken" data-overview="broken">
                <div className={o.brokenText}>
                  <h2 id="overview-broken">
                    <Link
                      to={INBOX_PATH}
                      search={{ item: headlineItem.id } as never}
                      className={o.brokenTitle}
                    >
                      {headline.title}
                    </Link>
                  </h2>
                  {headline.detail ? <p>{headline.detail}</p> : null}
                </div>
                {headline.busy ? (
                  <span className={o.busy}>
                    {headline.busy === 'looking'
                      ? NEEDS_YOU_WORDS.looking(words)
                      : NEEDS_YOU_WORDS.fixing(words)}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={o.lookButton}
                    disabled={handleIt.busy}
                    aria-describedby="overview-broken"
                    onClick={() => handleIt.run(headlineItem)}
                  >
                    {OVERVIEW_WORDS.lookIntoIt}
                  </button>
                )}
              </section>
              {headline.others > 0 ? (
                <Link to={INBOX_PATH} className={o.others}>
                  {OVERVIEW_WORDS.others(headline.others)}
                  <Icon icon={ChevronRight} size={13} />
                </Link>
              ) : null}
            </>
          ) : null}

          {read === 'failed' ? (
            // The first read failed: nothing saved to show, so no figures that could look current.
            <ReadNote
              className={o.readNote}
              title={OVERVIEW_WORDS.couldntRead(CHAT_WORDS.dashboard)}
              body={OVERVIEW_WORDS.noSaved}
              error={error}
              busy={isFetching}
              onRetry={() => void refetch()}
            />
          ) : !data ? (
            <div className={o.ph} role="status" aria-busy="true">
              <p className={o.loading}>{OVERVIEW_WORDS.loading(CHAT_WORDS.dashboard)}</p>
              <i className={o.phHead} />
              <RowPlaceholders />
              <div className={o.phTiles} aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
          ) : empty && canAdd ? (
            <EmptyConnections burrow={burrow} />
          ) : (
            <>
              {read === 'saved' ? (
                // A refresh failed: what is below keeps its readings, each with its own time.
                <ReadNote
                  className={o.readNote}
                  title={OVERVIEW_WORDS.couldntRefresh(CHAT_WORDS.dashboard)}
                  body={OVERVIEW_WORDS.savedEach}
                  error={error}
                  busy={isFetching}
                  onRetry={() => void refetch()}
                />
              ) : null}
              {serversView ? (
                <Section
                  view={serversView}
                  links={
                    <>
                      {hosts.servers?.length ? (
                        <AppLink href={EVERYTHING_RUNNING_HREF} className={o.link}>
                          {OVERVIEW_WORDS.everythingRunning}
                          <Icon icon={ChevronRight} size={13} />
                        </AppLink>
                      ) : null}
                      {canAdd ? (
                        <button type="button" className={o.link} onClick={() => set({ add: '1' })}>
                          <Icon icon={Plus} size={14} />
                          {OVERVIEW_WORDS.addServer}
                        </button>
                      ) : null}
                    </>
                  }
                >
                  <OverviewServers
                    burrow={burrow}
                    now={now}
                    timeZone={timeZone}
                    onAdd={() => set({ add: '1' })}
                    savedNoteShown={read === 'saved'}
                  />
                </Section>
              ) : null}
              {servicesView && shown.includes(servicesView) ? (
                <Section
                  view={servicesView}
                  links={
                    canAdd ? (
                      <Link
                        to="/connections"
                        // Add a connection's own page (connections-catalog.md AP-1157), here on Overview.
                        search={{ connection: 'add' } as never}
                        className={o.link}
                        data-add="connection"
                      >
                        <Icon icon={Plus} size={14} />
                        {OVERVIEW_WORDS.addConnection}
                      </Link>
                    ) : null
                  }
                >
                  {tiles.length ? (
                    <OverviewConnections burrow={burrow} tiles={tiles} />
                  ) : (
                    <p className={o.note}>Nothing connected yet.</p>
                  )}
                </Section>
              ) : null}
              {pinnedView && pinned.length ? (
                <Section view={pinnedView}>
                  <div className={styles.grid}>
                    {pinned.map((slot) => (
                      <WidgetCard
                        key={slot.key}
                        className={styles[slot.place]}
                        burrow={burrow}
                        widget={slot.panel}
                        index={slot.index}
                        count={slot.count}
                        timeZone={timeZone}
                        now={now}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </div>
      {repointing ? (
        <RepointServersDialog
          burrow={burrow}
          onClose={() => set({ repoint: undefined }, { replace: true })}
          onAddServer={(address) =>
            set({ repoint: undefined, add: '1', address: address || undefined }, { replace: true })
          }
        />
      ) : null}
      {adding ? (
        <AddServerDialog
          burrow={burrow}
          onClose={() =>
            set(
              { add: undefined, address: undefined, user: undefined, control: undefined, name: undefined },
              { replace: true },
            )
          }
        />
      ) : null}
    </div>
  );
}
