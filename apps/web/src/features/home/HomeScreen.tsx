import { Link } from '@tanstack/react-router';
import {
  ARRANGE_WORDS,
  addTile,
  arrangePins,
  arrangeTiles,
  CHAT_WORDS,
  type ConnectionsTab,
  type HomeSlot,
  homeGreeting,
  homeSection,
  homeSections,
  homeStatus,
  homeWebSlots,
  layoutNow,
  moveTileBy,
  moveTileTo,
  NEEDS_YOU_WORDS,
  OVERVIEW_PAGE_WORDS,
  OVERVIEW_STARTING_TOP,
  OVERVIEW_WORDS,
  type OverviewSectionView,
  overviewHeadline,
  overviewSectionAnchor,
  overviewSectionForTab,
  overviewSections,
  overviewShows,
  overviewTiles,
  ownFace,
  rangeOfTile,
  readAgo,
  readState,
  removeTile,
  setPin,
  setTopFigure,
  showId,
  showOnTile,
  sizeTile,
  statusText,
  todayMoments,
  viewFace,
} from '@whombat/client';
import { EVERYTHING_RUNNING_HREF, isHostsUnavailable } from '@whombat/client/hosts';
import {
  useArrangeOverview,
  useHomeOverview,
  useMoveWidget,
  useOverviewViews,
  useTheAgent,
} from '@whombat/client/react';
import type { OverviewLayout } from '@whombat/core';
import { Check, ChevronRight, Plus, Settings } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { INBOX_PATH } from '../../app/shell/location';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { StatusMark } from '../../components/StatusMark';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { AddServerDialog } from '../things/AddServer';
import { AppLink } from '../things/parts';
import { useThingLinkProps } from '../things/prefetch';
import { RepointServersDialog } from '../things/RepointServers';
import { useThingSearch } from '../things/search';
import a from './Arranged.module.css';
import { ArrangedTiles, TileLogo, thingColor } from './ArrangedTiles';
import { ArrangePanel, type PanelTarget } from './ArrangePanel';
import { EmptyConnections } from './EmptyConnections';
import styles from './Home.module.css';
import o from './Overview.module.css';
import { BrokenActions, OverviewPulse, OverviewToday, type PulseFigure } from './OverviewPulse';
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
 * Overview (docs/decisions/overview-one-page.md, overview-arranged.md): the title with the jump links and **Arrange**;
 * the summary card (the broken thing with *Look into it*, or how things are, and the four figures the person chose);
 * **Today**; **Connections** (the tiles as the person arranged them, OVA-01…OVA-06); **Servers** (one list, a row a
 * server); **Pinned** (what was pinned from a chat). Arrange shows a gear on every tile, figure and pinned chart, lets
 * tiles be dragged and saves each change at once. An old `?tab=` scrolls to its section once. Add a server opens here
 * (`?add=1`), and Point them here (`?repoint=1`, backup-file.md AP-4417). Live through `home.changed`,
 * `hosts:<burrowId>` and the shell's own writes.
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
  // Connections come before Servers (overview-arranged.md OVA-07).
  const shown = views
    .filter((v) => v.key !== 'services' || v.count > 0 || canAdd)
    .sort((a, b) => SECTION_ORDER.indexOf(a.key) - SECTION_ORDER.indexOf(b.key));
  const tiles = useMemo(
    () => (data ? overviewTiles(thingRows, data.things, now, timeZone, agent?.name ?? null) : []),
    [data, thingRows, now, timeZone, agent?.name],
  );
  // Nothing connected, no servers, nothing pinned: one card and one step instead of empty sections (first-day.md).
  const empty = !!data && !homeSection(sections, 'servers') && thingRows.length === 0 && pinned.length === 0;

  /* Arranging (overview-arranged.md): an older Whombat sends no layout and offers no Arrange. */
  const arranged = data?.arranged;
  const canArrange = canAdd && arranged !== undefined;
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const arrange = useArrangeOverview(burrow);
  const movePin = useMoveWidget(burrow);
  const arrangeButton = useRef<HTMLButtonElement>(null);
  const tileSet = useMemo(() => arrangeTiles(arranged, tiles), [arranged, tiles]);
  const top = arranged?.top?.length ? arranged.top : OVERVIEW_STARTING_TOP;
  const specs = useMemo(
    () =>
      arranged === undefined
        ? null
        : overviewShows(
            tileSet.shown.map((x) => x.tile),
            top,
          ),
    [arranged, tileSet.shown, top],
  );
  const tileViews = useOverviewViews(burrow, specs).data;
  const pinSet = useMemo(
    () =>
      arrangePins(
        arranged,
        pinned.map((slot) => ({ ...slot, id: slot.panel.id })),
      ),
    [arranged, pinned],
  );
  const save = (edit: (layout: OverviewLayout) => OverviewLayout) => {
    setProblem(null);
    const next = edit(layoutNow(arranged, thingRows));
    arrange.mutate(next, {
      onSuccess: (r) => {
        if (r.status !== 'ok') setProblem(ARRANGE_WORDS.couldntSave);
      },
      onError: () => setProblem(ARRANGE_WORDS.couldntSave),
    });
  };
  const stopArranging = () => {
    setPanel(null);
    setEditing(false);
    arrangeButton.current?.focus();
  };
  // Esc closes the panel, then ends arranging.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (panel) setPanel(null);
      else stopArranging();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const rowOf = (thing: string) => tiles.find((t) => t.row.id === thing)?.row ?? null;
  const figures: PulseFigure[] = data
    ? top.map((t) => {
        if ('own' in t)
          return {
            key: `own:${t.own}`,
            face: ownFace(t.own, data, thingRows, hosts.servers ?? null, agent?.name ?? null),
          };
        const row = rowOf(t.thing);
        const v = tileViews?.get(showId(t));
        const face = (v && viewFace(v)) || {
          value: '—',
          unit: null,
          label: row?.name ?? '',
          line: null,
          tone: null,
          spark: null,
          parts: null,
        };
        return {
          key: showId(t),
          face,
          color: thingColor(t.thing),
          ...(row ? { logo: <TileLogo row={row} size={13} /> } : {}),
        };
      })
    : [];
  const moveTile = (thing: string, by: -1 | 1) => save((l) => moveTileBy(l, thing, by));
  const linkProps = useThingLinkProps(burrow);
  const day = useMemo(
    () => (data ? todayMoments(data, now, timeZone, agent?.name ?? null) : null),
    [data, now, timeZone, agent?.name],
  );

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

  const tone = headline?.kind === 'broken' ? 'bad' : (status?.tone ?? 'ok');
  const statusWords = status ? statusText(status.parts) : '';
  const strong = status?.parts.find((p) => p.strong)?.text ?? null;
  const pulseHeading =
    headline?.kind === 'broken' && headlineItem ? (
      <Link to={INBOX_PATH} search={{ item: headlineItem.id } as never}>
        {headline.title}
      </Link>
    ) : tone === 'ok' ? (
      OVERVIEW_PAGE_WORDS.fine
    ) : (
      (strong ?? statusWords).replace(/\.$/, '')
    );
  const serverCount = hosts.servers?.length ?? 0;
  const pulseBody =
    headline?.kind === 'broken'
      ? headline.detail || null
      : tone === 'ok'
        ? `${OVERVIEW_PAGE_WORDS.watching(words.Name, serverCount, tileSet.shown.length + tileSet.removed.length)} ${statusWords.replace(/^All good\.\s*/, '')}`.trim()
        : strong
          ? statusWords.slice(statusWords.indexOf(strong) + strong.length).trim() || null
          : null;
  const greeting = data
    ? [
        homeGreeting(me?.name ?? null, now, timeZone),
        formatDay(now, timeZone),
        OVERVIEW_PAGE_WORDS.read(readAgo(data.generatedAt, now)),
      ].join(' · ')
    : '';

  return (
    <div className={styles.scroll} data-screen="home">
      <div className={cx(o.page, editing && a.editing)}>
        <header className={o.head}>
          <h1>{CHAT_WORDS.dashboard}</h1>
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
          {canArrange && data && !empty ? (
            <button
              ref={arrangeButton}
              type="button"
              className={a.arrange}
              aria-pressed={editing}
              aria-label={editing ? ARRANGE_WORDS.doneLabel : ARRANGE_WORDS.arrangeLabel}
              onClick={() => (editing ? stopArranging() : setEditing(true))}
              data-arrange="toggle"
            >
              <Icon icon={editing ? Check : Settings} size={16} />
              <span>{editing ? ARRANGE_WORDS.done : ARRANGE_WORDS.arrange}</span>
            </button>
          ) : null}
        </header>
        <div className={o.body}>
          {editing ? (
            <div className={a.editbar} role="status">
              <span>
                <b>{ARRANGE_WORDS.barTitle}</b> <span className={a.onWide}>{ARRANGE_WORDS.barBody}</span>
                <span className={a.onPhone}>{ARRANGE_WORDS.barBodyPhone}</span>
              </span>
              {problem ? <span className={a.problem}>{problem}</span> : null}
            </div>
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
              <OverviewPulse
                tone={tone}
                greeting={greeting}
                heading={pulseHeading}
                body={pulseBody}
                actions={
                  headline?.kind === 'broken' && headlineItem ? (
                    <BrokenActions
                      busyWords={
                        headline.busy === 'looking'
                          ? NEEDS_YOU_WORDS.looking(words)
                          : headline.busy === 'fixing'
                            ? NEEDS_YOU_WORDS.fixing(words)
                            : null
                      }
                      others={headline.others > 0 ? OVERVIEW_WORDS.others(headline.others) : null}
                      disabled={handleIt.busy}
                      onLook={() => handleIt.run(headlineItem)}
                      look={OVERVIEW_WORDS.lookIntoIt}
                    />
                  ) : null
                }
                figures={figures}
                editing={editing}
                onGear={(index) => setPanel({ kind: 'top', index })}
              />
              {day?.moments.length ? (
                <OverviewToday moments={day.moments} now={day.now} done={day.done} planned={day.planned} />
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
                    <ArrangedTiles
                      shown={tileSet.shown}
                      removed={tileSet.removed.length + pinSet.removed.length}
                      views={tileViews}
                      viewId={showId}
                      editing={editing}
                      linkProps={linkProps}
                      onGear={(thing) => setPanel({ kind: 'tile', thing })}
                      onAdd={() => setPanel({ kind: 'add' })}
                      onDrop={(thing, onto) => save((l) => moveTileTo(l, thing, onto))}
                    />
                  ) : (
                    <p className={o.note}>Nothing connected yet.</p>
                  )}
                </Section>
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
                    things={data?.things}
                  />
                </Section>
              ) : null}
              {pinnedView && pinSet.shown.length ? (
                <Section view={pinnedView}>
                  <div className={styles.grid}>
                    {pinSet.shown.map((slot, i) => (
                      <div key={slot.key} className={cx(styles[slot.size], a.pinWrap)} data-size={slot.size}>
                        <WidgetCard
                          burrow={burrow}
                          widget={slot.panel}
                          index={i}
                          count={pinSet.shown.length}
                          timeZone={timeZone}
                          now={now}
                        />
                        {editing ? (
                          <button
                            type="button"
                            className={a.gear}
                            aria-label={ARRANGE_WORDS.changePin(slot.panel.title)}
                            onClick={() => setPanel({ kind: 'pin', id: slot.id })}
                          >
                            <Icon icon={Settings} size={17} />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </div>
      {editing && panel && data ? (
        <ArrangePanel
          burrow={burrow}
          target={panel}
          tiles={tileSet.shown}
          removedTiles={tileSet.removed}
          pins={pinSet.shown.map((p) => ({ id: p.id, title: p.panel.title, size: p.size }))}
          removedPins={pinSet.removed.map((p) => ({ id: p.id, title: p.panel.title }))}
          top={top}
          views={tileViews}
          thingName={(thing) => rowOf(thing)?.name ?? thing}
          thingLogo={(thing) => {
            const row = rowOf(thing);
            return row ? <TileLogo row={row} size={14} /> : null;
          }}
          problem={problem}
          onShow={(thing, show) => save((l) => showOnTile(l, thing, show))}
          onRange={(thing, range) => save((l) => rangeOfTile(l, thing, range))}
          onSize={(thing, size) => save((l) => sizeTile(l, thing, size))}
          onMoveTile={moveTile}
          onRemoveTile={(thing) => {
            save((l) => removeTile(l, thing));
            setPanel(null);
          }}
          onAddTile={(thing) => save((l) => addTile(l, thing))}
          onTop={(index, t) => save((l) => setTopFigure(l, index, t))}
          onPinSize={(id, size) => save((l) => setPin(l, id, { size }))}
          onMovePin={(id, by) => {
            const order = pinned.map((p) => p.panel.id);
            const i = pinSet.shown.findIndex((p) => p.id === id);
            const neighbour = pinSet.shown[i + by];
            if (neighbour) movePin.mutate({ widgetId: id, position: order.indexOf(neighbour.id) });
          }}
          onRemovePin={(id) => {
            save((l) => setPin(l, id, { hidden: true }));
            setPanel(null);
          }}
          onAddPin={(id) => save((l) => setPin(l, id, { hidden: undefined }))}
          onClose={() => setPanel(null)}
        />
      ) : null}
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

/** The sections in the page's order (overview-arranged.md OVA-07). */
const SECTION_ORDER: readonly ConnectionsTab[] = ['services', 'servers', 'pinned'];

/** “Tuesday 24 November”. */
function formatDay(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
}
