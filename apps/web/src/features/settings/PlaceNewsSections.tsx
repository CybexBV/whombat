/**
 * Settings → This Whombat → About, beside the quiet hours (which say the time zone): **PLACE** and **NEWS** (Whombat
 * weather-news.md; app weather-news-apps.md). Not in the mocks: they follow their neighbours — the small label, one
 * line, a card of rows.
 *
 * - PLACE: where this Whombat is, for the weather and the suggested news — “Amsterdam · guessed from the time zone” or
 *   the place chosen — and *Change*: a town or city to look up (up to five places), *Use my location* (the browser's,
 *   asked only when pressed), *Use the time zone’s guess*, and OpenStreetMap's credit under the results.
 * - NEWS: one line saying headlines come straight from the sites to this Whombat; the sites that are on (each its
 *   *Turn off*, or *Remove* for one the person added, and its problem); *Suggested for …* with *Turn on*, the region's
 *   first; *Add a news site* by its address, a refusal said under the field.
 * A Whombat from before answers neither: both stay away (`placeNewsShown`).
 */
import {
  countryName,
  fieldProblem,
  newsAddedText,
  newsFullText,
  newsHasRoom,
  newsIdsWith,
  newsIdsWithout,
  newsSuggestedTitle,
  placeResultMeta,
  placeRowText,
  placeSavedText,
} from '@whombat/client';
import {
  placeNewsShown,
  useAddNewsSite,
  useBootstrap,
  useFindPlace,
  useNewsSources,
  useSessionProtocol,
  useSetNewsSources,
  useSetPlace,
} from '@whombat/client/react';
import {
  NEWS_WORDS,
  type NewsChosenSource,
  type NewsSourcesView,
  type NewsSuggestion,
  PLACE_SETTING_WORDS,
  type Place,
  placeLabel,
  roundCoord,
} from '@whombat/core';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import pn from './PlaceNews.module.css';
import styles from './SettingsScreen.module.css';

const P = PLACE_SETTING_WORDS;
const N = NEWS_WORDS;

/** PLACE and NEWS, where the Whombat answers them. */
export function PlaceNewsSections({ burrow }: { burrow: string }) {
  const shown = placeNewsShown(useSessionProtocol());
  if (!shown) return null;
  return (
    <>
      <PlaceSection burrow={burrow} />
      <NewsSection burrow={burrow} />
    </>
  );
}

/** A site's address without its scheme: “feeds.nos.nl”. */
const hostOf = (url: string) => /^https:\/\/([^/?#]+)/.exec(url)?.[1]?.replace(/^www\./, '') ?? url;

export function PlaceSection({ burrow }: { burrow: string }) {
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
      <p className={styles.sectionHint}>{P.about}</p>
      <div className={styles.card}>
        <div className={cx(styles.row, !open && styles.lastRow)}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} data-place-line="">
              {placeRowText(place)}
            </span>
            {place ? <span className={styles.rowMeta}>{countryName(place.country)}</span> : null}
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
        toast.show(placeSavedText(burrowNow.place));
        onDone();
      },
      onError: () => setProblem(P.failed),
    });
  };
  const busy = find.isPending || set.isPending || locating;
  return (
    <div id={id} className={cx(styles.row, styles.lastRow, pn.change)} data-place-change="">
      <form className={pn.find} onSubmit={search}>
        <Input
          aria-label={P.search}
          placeholder={P.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="address-level2"
          className={pn.field}
        />
        <Button type="submit" size="sm" variant="primary" disabled={busy || query.trim().length < 2}>
          {P.searchButton}
        </Button>
      </form>
      {found && found.length > 0 ? (
        <ul className={pn.results} aria-label={P.title}>
          {found.map((p) => (
            <li key={`${p.name}:${p.lat}:${p.lon}`}>
              <button type="button" className={pn.result} disabled={busy} onClick={() => keep(p)}>
                <span className={pn.resultName}>{placeLabel(p)}</span>
                <span className={pn.resultMeta}>{placeResultMeta(p)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <span className={pn.problem} role="alert">
          {problem}
        </span>
      ) : null}
      <span className={pn.credit}>{P.credit}</span>
      <div className={pn.actions}>
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

export function NewsSection({ burrow }: { burrow: string }) {
  const id = useId();
  const view = useNewsSources({ params: { burrow } }, { retry: false });
  if (!view.data) return null;
  return (
    <section className={styles.section} aria-labelledby={id} id="news" data-news="">
      <SectionLabel as="h2" id={id}>
        {N.title.toUpperCase()}
      </SectionLabel>
      <p className={styles.sectionHint}>{N.about}</p>
      <NewsCards burrow={burrow} view={view.data} />
    </section>
  );
}

function NewsCards({ burrow, view }: { burrow: string; view: NewsSourcesView }) {
  const toast = useToast();
  const set = useSetNewsSources(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const room = newsHasRoom(view);
  const change = (ids: string[], done?: string) => {
    setProblem(null);
    set.mutate(ids, {
      onSuccess: () => {
        if (done) toast.show(done);
      },
      onError: (e) => setProblem(fieldProblem(e, 'ids') ?? e.message),
    });
  };
  const suggested = newsSuggestedTitle(view.place);
  return (
    <>
      <h3 className={pn.sub}>{N.chosen}</h3>
      <div className={styles.card} data-news-chosen="">
        {view.chosen.length === 0 ? (
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMeta}>{N.none}</span>
          </div>
        ) : (
          view.chosen.map((s, i) => (
            <ChosenRow
              key={s.id}
              source={s}
              last={i === view.chosen.length - 1}
              busy={set.isPending}
              onOff={() => change(newsIdsWithout(view, s.id))}
            />
          ))
        )}
      </div>
      {problem ? (
        <span className={pn.problem} role="alert">
          {problem}
        </span>
      ) : null}
      {suggested && view.suggestions.length > 0 ? (
        <>
          <h3 className={pn.sub}>{suggested}</h3>
          <div className={styles.card} data-news-suggested="">
            {view.suggestions.map((s, i) => (
              <SuggestionRow
                key={s.id}
                source={s}
                place={view.place}
                last={i === view.suggestions.length - 1}
                busy={set.isPending || !room}
                onOn={() => change(newsIdsWith(view, s.id), newsAddedText(s.name))}
              />
            ))}
          </div>
        </>
      ) : null}
      {!room ? <p className={styles.sectionNote}>{newsFullText()}</p> : null}
      <AddSite burrow={burrow} full={!room} />
    </>
  );
}

function ChosenRow({
  source,
  last,
  busy,
  onOff,
}: {
  source: NewsChosenSource;
  last: boolean;
  busy: boolean;
  onOff: () => void;
}) {
  const word = source.own ? N.remove : N.turnOff;
  return (
    <div className={cx(styles.row, last && styles.lastRow)} data-source={source.id}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{source.name}</span>
        <span className={styles.rowMeta}>{hostOf(source.url)}</span>
        {source.problem ? (
          <span className={pn.sourceProblem} data-problem="">
            {source.problem}
          </span>
        ) : null}
      </span>
      <Button size="sm" disabled={busy} aria-label={`${word} ${source.name}`} onClick={onOff}>
        {word}
      </Button>
    </div>
  );
}

function SuggestionRow({
  source,
  place,
  last,
  busy,
  onOn,
}: {
  source: NewsSuggestion;
  place: Place | null;
  last: boolean;
  busy: boolean;
  onOn: () => void;
}) {
  // How near it is: the place's region (or area) by its name, else the country.
  const where =
    source.near !== 'country' && place?.regionName ? place.regionName : countryName(place?.country ?? '');
  return (
    <div
      className={cx(styles.row, last && styles.lastRow)}
      data-suggestion={source.id}
      data-near={source.near}
    >
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{source.name}</span>
        <span className={styles.rowMeta}>{where}</span>
      </span>
      <Button size="sm" disabled={busy} aria-label={`${N.turnOn} ${source.name}`} onClick={onOn}>
        {N.turnOn}
      </Button>
    </div>
  );
}

/** *Add a news site*: its address, Add; a site that isn't a feed (or the twelfth) says so under the field. */
function AddSite({ burrow, full }: { burrow: string; full: boolean }) {
  const fieldId = useId();
  const toast = useToast();
  const add = useAddNewsSite(burrow);
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setProblem(null);
    add.mutate(url.trim(), {
      onSuccess: (result) => {
        setUrl('');
        toast.show(newsAddedText(result.added.name));
      },
      onError: (err) => setProblem(fieldProblem(err, 'url') ?? N.unreachable),
    });
  };
  return (
    <>
      <h3 className={pn.sub}>
        <label htmlFor={fieldId}>{N.add}</label>
      </h3>
      <div className={styles.card}>
        <form className={cx(styles.row, styles.lastRow, pn.add)} onSubmit={submit} data-news-add="">
          <div className={pn.find}>
            <Input
              id={fieldId}
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
              className={pn.field}
            />
            <Button type="submit" size="sm" variant="primary" disabled={add.isPending || full || !url.trim()}>
              {N.addButton}
            </Button>
          </div>
          {problem ? (
            <span id={`${fieldId}-problem`} className={pn.problem} role="alert">
              {problem}
            </span>
          ) : null}
        </form>
      </div>
    </>
  );
}
