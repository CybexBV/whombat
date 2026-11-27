/**
 * Settings → News and weather (`?tab=news`; app weather-news-apps.md; the approved mockup of 2026-11-27): a page of its
 * own for where this Whombat is and the sources its headlines come from, shown only where the Whombat answers them
 * (`placeNewsShown`).
 *
 * - PLACE: “Amsterdam · guessed from the time zone” or the place chosen, and *Change*: a town or city to look up (up to
 *   five places), *Use my location* (the browser's, asked only when pressed), *Use the time zone’s guess*, and
 *   OpenStreetMap's credit under the results.
 * - YOUR SOURCES with how many of how many: each source with its grip (drag it, or *Move up* and *Move down*), its mark
 *   (letters on a tone: no site's own icon, which would tell the site who looks), its name, whom it is for or what it is
 *   (“Netherlands · national”, “YouTube · added by you”), its problem with *Find it again*, and *Turn off* (a
 *   suggestion) or *Remove* (one the person added). Buttons, not switches: a source turned off leaves this list.
 * - FIND MORE: *Suggested* (a country, the place's first, and its topics as chips; *Add*, or “On”), *Add your own* (any
 *   site, feed, YouTube channel, subreddit or podcast by its address) and *Import* (another reader's OPML file, read on
 *   this device; and *Save as OPML*). A Whombat from before browsing shows its suggestions for the place and *Add your
 *   own*, up to 12.
 * Every change is the person's own write through the commit pipeline (`news.setSources`, `news.addSite`,
 * `news.importSites`, `place.set`).
 */
import {
  countryName,
  fieldProblem,
  newsAddedText,
  newsIdsWith,
  newsIdsWithout,
  newsSuggestedTitle,
  placeResultMeta,
  placeRowText,
  placeSavedText,
} from '@whombat/client';
import {
  newsMoreShown,
  useAddNewsSite,
  useBootstrap,
  useFindPlace,
  useImportNewsSites,
  useNewsBrowse,
  useNewsSources,
  useSessionProtocol,
  useSetNewsSources,
  useSetPlace,
} from '@whombat/client/react';
import {
  NEWS_WORDS,
  type NewsBrowseSite,
  type NewsBrowseView,
  type NewsChosenSource,
  type NewsImportSkipped,
  type NewsSourcesView,
  type NewsSuggestion,
  newsOpml,
  newsSourceKind,
  PLACE_SETTING_WORDS,
  type Place,
  placeLabel,
  roundCoord,
} from '@whombat/core';
import { Check, ChevronDown, ChevronUp, GripVertical, MapPin, Play, Podcast } from 'lucide-react';
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import nw from './NewsWeather.module.css';
import {
  browseLine,
  chipHas,
  chipWords,
  chosenLine,
  fillNews,
  findAgainAddress,
  importWords,
  moveSource,
  NEWS_OPML_FILE,
  type NewsChip,
  newsChips,
  newsCountText,
  newsFullFor,
  newsHost,
  newsMax,
  opmlPlan,
  placeSource,
  sameOrder,
  sourceInitials,
  sourceTone,
  suggestionLine,
} from './newsModel';
import styles from './SettingsScreen.module.css';

const P = PLACE_SETTING_WORDS;
const N = NEWS_WORDS;

/** The page's parts under its title: PLACE, YOUR SOURCES and FIND MORE. */
export function NewsWeatherTab({ burrow }: { burrow: string }) {
  const more = newsMoreShown(useSessionProtocol());
  return (
    <>
      <PlaceSection burrow={burrow} />
      <NewsParts burrow={burrow} more={more} />
    </>
  );
}

/* PLACE ------------------------------------------------------------------------------------------------------------ */

function PlaceSection({ burrow }: { burrow: string }) {
  const { tag: uiLocale } = useWebI18n();
  const id = useId();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const [open, setOpen] = useState(false);
  if (!bootstrap) return null;
  const place = bootstrap.burrow.place ?? null;
  return (
    <section
      className={styles.section}
      aria-labelledby={id}
      id="place"
      data-place={place?.guessed ? 'guessed' : 'chosen'}
    >
      <SectionLabel as="h2" id={id}>
        {P.title.toUpperCase()}
      </SectionLabel>
      <div className={styles.card}>
        <div className={cx(styles.row, !open && styles.lastRow)}>
          <span className={nw.pin}>
            <Icon icon={MapPin} size={18} />
          </span>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} data-place-line="">
              {placeRowText(place, uiLocale)}
            </span>
            {place ? (
              <span className={styles.rowMeta}>{countryName(place.country, undefined, uiLocale)}</span>
            ) : null}
          </span>
          <Button
            size="sm"
            aria-expanded={open}
            aria-controls={`${id}-change`}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Cancel' : P.change}
          </Button>
        </div>
        {open ? (
          <PlaceChange id={`${id}-change`} burrow={burrow} place={place} onDone={() => setOpen(false)} />
        ) : null}
      </div>
    </section>
  );
}

/** *Change*: the search and its results, the device's location, the time zone's guess, OpenStreetMap's credit. */
function PlaceChange({
  id,
  burrow,
  place,
  onDone,
}: {
  id: string;
  burrow: string;
  place: Place | null;
  onDone: () => void;
}) {
  const toast = useToast();
  const find = useFindPlace(burrow);
  const set = useSetPlace(burrow);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Place[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const look = (input: { query: string } | { lat: number; lon: number }) => {
    setProblem(null);
    find.mutate(input, {
      onSuccess: (result) => {
        setFound(result.places);
        if (result.places.length === 0) setProblem(P.noResults);
      },
      onError: () => {
        setFound(null);
        setProblem(P.failed);
      },
    });
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length >= 2) look({ query: query.trim() });
  };
  // The browser asks the person; only what they allow is used, rounded to about a kilometre before it leaves.
  const locate = () => {
    setProblem(null);
    if (!('geolocation' in navigator)) return setProblem(P.noLocation);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (at) => {
        setLocating(false);
        look({ lat: roundCoord(at.coords.latitude), lon: roundCoord(at.coords.longitude) });
      },
      () => {
        setLocating(false);
        setProblem(P.noLocation);
      },
      { maximumAge: 10 * 60_000, timeout: 15_000 },
    );
  };
  const keep = (next: Place | null) => {
    setProblem(null);
    const input = next ? withoutGuessed(next) : null;
    set.mutate(input, {
      onSuccess: (burrowNow) => {
        toast.show(placeSavedText(burrowNow.place, currentLocale()));
        onDone();
      },
      onError: () => setProblem(P.failed),
    });
  };
  const busy = find.isPending || set.isPending || locating;
  return (
    <div id={id} className={cx(styles.row, styles.lastRow, nw.change)} data-place-change="">
      <form className={nw.find} onSubmit={search}>
        <Input
          aria-label={P.search}
          placeholder={P.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="address-level2"
          className={nw.field}
        />
        <Button type="submit" size="sm" variant="primary" disabled={busy || query.trim().length < 2}>
          {P.searchButton}
        </Button>
      </form>
      {found && found.length > 0 ? (
        <ul className={nw.results} aria-label={P.title}>
          {found.map((p) => (
            <li key={`${p.name}:${p.lat}:${p.lon}`}>
              <button type="button" className={nw.result} disabled={busy} onClick={() => keep(p)}>
                <span className={nw.resultName}>{placeLabel(p)}</span>
                <span className={nw.resultMeta}>{placeResultMeta(p, currentLocale())}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <span className={nw.problem} role="alert">
          {problem}
        </span>
      ) : null}
      <span className={nw.credit}>{P.credit}</span>
      <div className={nw.actions}>
        <Button size="sm" onClick={locate} disabled={busy}>
          {P.useLocation}
        </Button>
        {place && !place.guessed ? (
          <Button size="sm" variant="ghost" onClick={() => keep(null)} disabled={busy}>
            {P.useGuess}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A place as `place.set` takes it: without whether it was guessed. */
function withoutGuessed(p: Place) {
  const { guessed: _guessed, ...rest } = p;
  return rest;
}

/* The news ---------------------------------------------------------------------------------------------------------- */

type FindTab = 'suggested' | 'own' | 'import';

/** What *Find it again* asks of Add your own: the address to put in its field (a new object each time it is asked). */
interface Prefill {
  address: string;
}

function NewsParts({ burrow, more }: { burrow: string; more: boolean }) {
  const view = useNewsSources({ params: { burrow } }, { retry: false });
  // Whom each suggestion that is on is for, from the place's country's list (a Whombat from before has none).
  const browse = useNewsBrowse(more ? { params: { burrow }, query: {} } : null, { retry: false });
  const [tab, setTab] = useState<FindTab>('suggested');
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  if (!view.data) return null;
  const max = newsMax(more);
  const findAgain = (source: NewsChosenSource) => {
    setTab('own');
    setPrefill({ address: findAgainAddress(source) });
  };
  return (
    <>
      <YourSources burrow={burrow} view={view.data} browse={browse.data} max={max} onFindAgain={findAgain} />
      <FindMore
        burrow={burrow}
        view={view.data}
        more={more}
        max={max}
        tab={tab}
        onTab={setTab}
        prefill={prefill}
        onPrefilled={() => setPrefill(null)}
      />
    </>
  );
}

/* YOUR SOURCES ------------------------------------------------------------------------------------------------------ */

function YourSources({
  burrow,
  view,
  browse,
  max,
  onFindAgain,
}: {
  burrow: string;
  view: NewsSourcesView;
  browse: NewsBrowseView | undefined;
  max: number;
  onFindAgain: (source: NewsChosenSource) => void;
}) {
  const id = useId();
  const set = useSetNewsSources(burrow);
  const ids = view.chosen.map((s) => s.id);
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  // The order (or the list without a source) as it was asked, until the Whombat answers: nothing jumps back meanwhile.
  const [pending, setPending] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const card = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  const live = useRef({ drag, ids });
  live.current = { drag, ids };

  const byId = new Map(view.chosen.map((s) => [s.id, s]));
  const order = drag?.order ?? pending ?? ids;
  const shown = order.map((x) => byId.get(x)).filter((s): s is NewsChosenSource => s !== undefined);

  const save = (next: string[]) => {
    setProblem(null);
    setPending(next);
    set.mutate(next, {
      onSettled: () => setPending(null),
      onError: (e) => setProblem(fieldProblem(e, 'ids') ?? e.message),
    });
  };

  // A source moved by its button keeps the focus on that button (or on the other one at either end).
  useLayoutEffect(() => {
    const at = refocus.current;
    if (!at) return;
    refocus.current = null;
    const buttons = card.current?.querySelectorAll<HTMLButtonElement>(`[data-move^="${CSS.escape(at)}:"]`);
    const usable = [...(buttons ?? [])].find((b) => !b.getAttribute('aria-disabled'));
    usable?.focus();
  });

  const start = (event: ReactPointerEvent, sourceId: string) => {
    if (event.button !== 0 || set.isPending) return;
    event.preventDefault();
    setDrag({ id: sourceId, order });
    const move = (e: PointerEvent) => {
      const now = live.current.drag;
      if (!now) return;
      // Its place among the others: after every row whose middle is above the pointer.
      const to = now.order
        .filter((x) => x !== now.id)
        .filter((x) => {
          const r = rows.current.get(x)?.getBoundingClientRect();
          return r ? e.clientY > r.top + r.height / 2 : false;
        }).length;
      const next = placeSource(now.order, now.id, to);
      if (!sameOrder(next, now.order)) setDrag({ id: now.id, order: next });
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const { drag: done, ids: before } = live.current;
      setDrag(null);
      if (e.type === 'pointerup' && done && !sameOrder(done.order, before)) save(done.order);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <section className={styles.section} aria-labelledby={id} id="news" data-news="">
      <div className={styles.sectionHead}>
        <SectionLabel as="h2" id={id}>
          {N.chosen.toUpperCase()}
        </SectionLabel>
        <span className={nw.count} data-news-count="">
          {newsCountText(view.chosen.length, max)}
        </span>
      </div>
      <div className={styles.card} data-news-chosen="" ref={card}>
        {shown.length === 0 ? (
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMeta}>{N.none}</span>
          </div>
        ) : (
          shown.map((s, i) => (
            <SourceRow
              key={s.id}
              ref={(el) => {
                if (el) rows.current.set(s.id, el);
                else rows.current.delete(s.id);
              }}
              source={s}
              line={chosenLine(s, { place: view.place, browse })}
              first={i === 0}
              last={i === shown.length - 1}
              dragging={drag?.id === s.id}
              busy={set.isPending}
              onGrip={(e) => start(e, s.id)}
              onMove={(by) => {
                const next = moveSource(order, s.id, by);
                if (sameOrder(next, order)) return;
                refocus.current = s.id;
                save(next);
              }}
              onOff={() => save(newsIdsWithout({ chosen: shown }, s.id))}
              onFindAgain={() => onFindAgain(s)}
            />
          ))
        )}
      </div>
      {problem ? (
        <span className={nw.problem} role="alert">
          {problem}
        </span>
      ) : null}
    </section>
  );
}

function SourceRow({
  ref,
  source,
  line,
  first,
  last,
  dragging,
  busy,
  onGrip,
  onMove,
  onOff,
  onFindAgain,
}: {
  ref: (el: HTMLDivElement | null) => void;
  source: NewsChosenSource;
  line: string;
  first: boolean;
  last: boolean;
  dragging: boolean;
  busy: boolean;
  onGrip: (event: ReactPointerEvent) => void;
  onMove: (by: -1 | 1) => void;
  onOff: () => void;
  onFindAgain: () => void;
}) {
  const name = source.name;
  const word = source.own ? N.remove : N.turnOff;
  const edge = (end: boolean) => end || busy || undefined;
  return (
    <div
      ref={ref}
      className={cx(styles.row, nw.source, last && styles.lastRow)}
      data-source={source.id}
      data-dragging={dragging || undefined}
    >
      {/* The pointer's way to reorder; Move up and Move down are the keyboard's and a touch's. */}
      <span className={nw.grip} onPointerDown={onGrip} aria-hidden="true">
        <Icon icon={GripVertical} size={16} />
      </span>
      <SourceMark id={source.id} name={name} kind={newsSourceKind(source)} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{name}</span>
        <span className={nw.meta}>{line}</span>
        {source.problem ? (
          <span className={nw.sourceProblem} data-problem="">
            {/[.!?]$/.test(source.problem) ? source.problem : `${source.problem}.`}{' '}
            <button type="button" className={nw.inlineLink} onClick={onFindAgain}>
              {N.findAgain}
            </button>
          </span>
        ) : null}
      </span>
      <span className={nw.moves}>
        <button
          type="button"
          className={nw.move}
          data-move={`${source.id}:up`}
          aria-label={fillNews(N.moveUp, { name })}
          aria-disabled={edge(first)}
          onClick={() => !first && !busy && onMove(-1)}
        >
          <Icon icon={ChevronUp} size={16} />
        </button>
        <button
          type="button"
          className={nw.move}
          data-move={`${source.id}:down`}
          aria-label={fillNews(N.moveDown, { name })}
          aria-disabled={edge(last)}
          onClick={() => !last && !busy && onMove(1)}
        >
          <Icon icon={ChevronDown} size={16} />
        </button>
      </span>
      <Button size="sm" disabled={busy} aria-label={`${word} ${name}`} onClick={onOff}>
        {word}
      </Button>
    </div>
  );
}

/** A source's mark: its letters on a tone (a channel or a podcast by its sign). Decorative: its name is beside it. */
function SourceMark({ id, name, kind }: { id: string; name: string; kind: string }) {
  const sign = kind === 'youtube' ? Play : kind === 'podcast' ? Podcast : null;
  const letters = sign ? '' : sourceInitials(name);
  return (
    <span
      className={cx(nw.mark, nw[`tone${sourceTone(id)}`])}
      data-letters={letters.length > 2 ? 'three' : undefined}
      aria-hidden="true"
    >
      {sign ? <Icon icon={sign} size={13} /> : letters}
    </span>
  );
}

/* FIND MORE --------------------------------------------------------------------------------------------------------- */

function FindMore({
  burrow,
  view,
  more,
  max,
  tab,
  onTab,
  prefill,
  onPrefilled,
}: {
  burrow: string;
  view: NewsSourcesView;
  more: boolean;
  max: number;
  tab: FindTab;
  onTab: (tab: FindTab) => void;
  prefill: Prefill | null;
  onPrefilled: () => void;
}) {
  const id = useId();
  const tabsId = useId();
  const panelId = `${tabsId}-panel`;
  const room = Math.max(0, max - view.chosen.length);
  const full = room === 0;
  const tabs = [
    { key: 'suggested' as const, label: N.tabSuggested },
    { key: 'own' as const, label: N.tabOwn },
    { key: 'import' as const, label: N.tabImport },
  ];
  return (
    <section className={styles.section} aria-labelledby={id} id="find-more" data-news-find="">
      <SectionLabel as="h2" id={id}>
        {N.findMore.toUpperCase()}
      </SectionLabel>
      <div className={styles.card}>
        {more ? (
          <>
            <Tabs
              tabs={tabs}
              value={tab}
              onChange={onTab}
              label={N.findMore}
              idPrefix={tabsId}
              panelId={panelId}
              className={nw.tabs}
              tabClassName={nw.tab}
            />
            <div id={panelId} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} data-news-tab={tab}>
              {tab === 'suggested' ? (
                <Suggested burrow={burrow} view={view} full={full} />
              ) : tab === 'own' ? (
                <AddOwn burrow={burrow} full={full} prefill={prefill} onPrefilled={onPrefilled} />
              ) : (
                <Import burrow={burrow} view={view} room={room} max={max} />
              )}
            </div>
          </>
        ) : (
          <>
            <OlderSuggested burrow={burrow} view={view} full={full} />
            <AddOwn burrow={burrow} full={full} prefill={prefill} onPrefilled={onPrefilled} />
          </>
        )}
      </div>
      {full ? <p className={styles.sectionNote}>{newsFullFor(max)}</p> : null}
      <p className={styles.sectionNote}>{N.about}</p>
    </section>
  );
}

/** Turning a suggestion on: it goes last in YOUR SOURCES, and the toast says so. */
function useTurnOn(burrow: string, view: NewsSourcesView) {
  const { tag: uiLocale } = useWebI18n();
  const toast = useToast();
  const set = useSetNewsSources(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const turnOn = (sourceId: string, name: string) => {
    setProblem(null);
    set.mutate(newsIdsWith(view, sourceId), {
      onSuccess: () => toast.show(newsAddedText(name, uiLocale)),
      onError: (e) => setProblem(fieldProblem(e, 'ids') ?? e.message),
    });
  };
  return { turnOn, busy: set.isPending, problem };
}

/** *Suggested*: a country (the place's first), its topics that have sites, and its sites with *Add* or “On”. */
function Suggested({ burrow, view, full }: { burrow: string; view: NewsSourcesView; full: boolean }) {
  const { tag: uiLocale } = useWebI18n();
  const selectId = useId();
  const [country, setCountry] = useState<string | undefined>(undefined);
  const [chip, setChip] = useState<NewsChip>('all');
  const browse = useNewsBrowse(
    { params: { burrow }, query: country ? { country } : {} },
    { retry: false, placeholderData: (previous) => previous },
  );
  const { turnOn, busy, problem } = useTurnOn(burrow, view);
  const on = useMemo(() => new Set(view.chosen.map((s) => s.id)), [view.chosen]);
  const data = browse.data;
  const countries = useMemo(
    () =>
      (data?.countries ?? [])
        .map((c) => ({ code: c.code, name: countryName(c.code, undefined, uiLocale) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    [data?.countries, uiLocale],
  );
  const sites = data?.sites ?? [];
  const chips = newsChips(sites);
  const current = chips.includes(chip) ? chip : 'all';
  const listed = sites.filter((s) => chipHas(s, current));
  const shownCountry = country ?? data?.country ?? '';
  return (
    <>
      <div className={nw.chips}>
        <span className={nw.country}>
          <select
            id={selectId}
            className={nw.countrySelect}
            aria-label={N.country}
            value={shownCountry}
            onChange={(e) => {
              setCountry(e.target.value || undefined);
              setChip('all');
            }}
            data-news-country=""
          >
            {shownCountry ? null : <option value="">{N.country}</option>}
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <Icon icon={ChevronDown} size={13} className={nw.countryChevron} />
        </span>
        {chips.map((c) => (
          <Chip
            key={c}
            active={c === current}
            className={nw.chip}
            onClick={() => setChip(c)}
            data-news-chip={c}
          >
            {chipWords(c)}
          </Chip>
        ))}
      </div>
      {data && listed.length === 0 ? (
        <div className={cx(styles.row, styles.lastRow)}>
          <span className={styles.rowMeta}>{N.browseNone}</span>
        </div>
      ) : (
        listed.map((site, i) => (
          <BrowseRow
            key={site.id}
            site={site}
            line={browseLine(site, view.place)}
            on={on.has(site.id)}
            last={i === listed.length - 1}
            busy={busy || full}
            onAdd={() => turnOn(site.id, site.name)}
          />
        ))
      )}
      {problem ? (
        <div className={cx(styles.row, styles.lastRow)}>
          <span className={nw.problem} role="alert">
            {problem}
          </span>
        </div>
      ) : null}
    </>
  );
}

function BrowseRow({
  site,
  line,
  on,
  last,
  busy,
  onAdd,
}: {
  site: Pick<NewsBrowseSite, 'id' | 'name' | 'url' | 'kind'>;
  line: string;
  on: boolean;
  last: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      className={cx(styles.row, nw.browseRow, last && styles.lastRow)}
      data-suggestion={site.id}
      data-on={on || undefined}
    >
      <SourceMark id={site.id} name={site.name} kind={newsSourceKind(site)} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{site.name}</span>
        <span className={nw.meta}>{line}</span>
      </span>
      {on ? (
        <span className={nw.on}>
          <Icon icon={Check} size={14} />
          {N.on}
        </span>
      ) : (
        <Button size="sm" disabled={busy} aria-label={`${N.addButton} ${site.name}`} onClick={onAdd}>
          {N.addButton}
        </Button>
      )}
    </div>
  );
}

/** A Whombat from before browsing: its suggestions for the place, the nearest first, each with *Add*. */
function OlderSuggested({ burrow, view, full }: { burrow: string; view: NewsSourcesView; full: boolean }) {
  const { tag: uiLocale } = useWebI18n();
  const { turnOn, busy, problem } = useTurnOn(burrow, view);
  const title = newsSuggestedTitle(view.place, uiLocale);
  if (!title || view.suggestions.length === 0) return null;
  return (
    <>
      <div className={cx(styles.row, nw.subRow)}>
        <h3 className={nw.sub}>{title}</h3>
      </div>
      {view.suggestions.map((s: NewsSuggestion) => (
        <BrowseRow
          key={s.id}
          site={s}
          line={suggestionLine(s, view.place)}
          on={false}
          last={false}
          busy={busy || full}
          onAdd={() => turnOn(s.id, s.name)}
        />
      ))}
      {problem ? (
        <div className={styles.row}>
          <span className={nw.problem} role="alert">
            {problem}
          </span>
        </div>
      ) : null}
    </>
  );
}

/** *Add your own*: any site, feed, channel or podcast by its address; a refusal under the field, an added one a toast. */
function AddOwn({
  burrow,
  full,
  prefill,
  onPrefilled,
}: {
  burrow: string;
  full: boolean;
  prefill: Prefill | null;
  onPrefilled: () => void;
}) {
  const fieldId = useId();
  const toast = useToast();
  const add = useAddNewsSite(burrow);
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // *Find it again*: the source's address in the field and the focus there, once per ask.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new ask is a new object; the callback is the parent's
  useEffect(() => {
    if (!prefill) return;
    setUrl(prefill.address);
    setProblem(null);
    field.current?.focus();
    field.current?.scrollIntoView?.({ block: 'center' });
    onPrefilled();
  }, [prefill]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setProblem(null);
    add.mutate(url.trim(), {
      onSuccess: (result) => {
        setUrl('');
        toast.show(newsAddedText(result.added.name, currentLocale()));
      },
      onError: (err) => setProblem(fieldProblem(err, 'url') ?? N.unreachable),
    });
  };
  return (
    <form className={cx(styles.row, styles.lastRow, nw.add)} onSubmit={submit} data-news-add="">
      <div className={nw.find}>
        <Input
          ref={field}
          id={fieldId}
          aria-label={N.addField}
          placeholder={N.addField}
          value={url}
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          invalid={problem !== null}
          aria-describedby={problem ? `${fieldId}-problem` : undefined}
          onChange={(e) => {
            setUrl(e.target.value);
            setProblem(null);
          }}
          className={nw.field}
        />
        <Button type="submit" size="sm" variant="primary" disabled={add.isPending || full || !url.trim()}>
          {N.addButton}
        </Button>
      </div>
      {problem ? (
        <span id={`${fieldId}-problem`} className={nw.problem} role="alert">
          {problem}
        </span>
      ) : null}
    </form>
  );
}

/** *Import*: another reader's OPML file, read on this device and sent as its feeds' addresses; *Save as OPML*. */
function Import({
  burrow,
  view,
  room,
  max,
}: {
  burrow: string;
  view: NewsSourcesView;
  room: number;
  max: number;
}) {
  const id = useId();
  const imp = useImportNewsSites(burrow);
  const file = useRef<HTMLInputElement>(null);
  const [said, setSaid] = useState<{ lines: string[]; skipped: NewsImportSkipped[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const read = async (chosen: File) => {
    setSaid(null);
    setProblem(null);
    let text: string;
    try {
      text = await chosen.text();
    } catch {
      return setProblem(N.importNone);
    }
    const plan = opmlPlan(text, room);
    if (plan.none) return setProblem(N.importNone);
    if (plan.urls.length === 0) return setProblem(newsFullFor(max));
    imp.mutate(plan.urls, {
      onSuccess: (result) =>
        setSaid({
          lines: importWords(result.added.length, result.skipped.length + plan.left),
          skipped: result.skipped,
        }),
      onError: (e) => setProblem(fieldProblem(e, 'urls') ?? N.unreachable),
    });
  };
  // Another reader takes the list as a file; nothing leaves this device to make it.
  const opml = `data:text/x-opml;charset=utf-8,${encodeURIComponent(newsOpml(view.chosen))}`;
  return (
    <div className={cx(styles.row, styles.lastRow, nw.import)} data-news-import="">
      <p className={nw.importLine} id={`${id}-line`}>
        {N.importLine}
      </p>
      <input
        ref={file}
        type="file"
        accept=".opml,.xml,text/xml,application/xml,text/x-opml"
        className={nw.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        data-news-import-file=""
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = '';
          if (chosen) void read(chosen);
        }}
      />
      <div className={nw.actions}>
        <Button
          size="sm"
          variant="primary"
          aria-describedby={`${id}-line`}
          disabled={imp.isPending || room === 0}
          onClick={() => file.current?.click()}
        >
          {N.importButton}
        </Button>
        {view.chosen.length > 0 ? (
          <a className={nw.export} href={opml} download={NEWS_OPML_FILE} data-news-export="">
            {N.export}
          </a>
        ) : null}
      </div>
      {said ? (
        <div className={nw.said} role="status">
          <span>{said.lines.join(' ')}</span>
          {said.skipped.length > 0 ? (
            <ul className={nw.skipped}>
              {said.skipped.map((s) => (
                <li key={s.url}>
                  <span className={nw.meta}>{newsHost(s.url)}</span> · {s.problem}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <span className={nw.problem} role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
