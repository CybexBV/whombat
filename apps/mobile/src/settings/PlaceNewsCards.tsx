/**
 * PLACE and NEWS on the phone (Whombat weather-news.md; app weather-news-apps.md), on This Whombat's About (a box) and
 * the demo world's This Whombat, after VERSION as the web has them after the quiet hours. The web's parts in the phone's
 * cards: the place guessed or chosen, *Change* (a town or city to look up, up to five places to tap, the time zone's
 * guess, OpenStreetMap's credit); the sites that are on (*Turn off*, or *Remove* for one the person added, and its
 * problem), *Suggested for …* with *Turn on*, the region's first, and *Add a news site*, a refusal said under the field.
 * The phone has no *Use my location*: it would need a location module and a new build (weather-news-apps.md). Every
 * button and result is a 44dp target. A Whombat from before answers neither: both stay away.
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
  PLACE_SETTING_WORDS,
  type Place,
  placeLabel,
} from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { Card, Row } from '../managed/ui';
import { errorText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';

const P = PLACE_SETTING_WORDS;
const N = NEWS_WORDS;
const CANCEL = 'Cancel';

/** A site's address without its scheme: “feeds.nos.nl”. */
const hostOf = (url: string) => /^https:\/\/([^/?#]+)/.exec(url)?.[1]?.replace(/^www\./, '') ?? url;

export function PlaceNewsCards() {
  const shown = placeNewsShown(useSessionProtocol());
  const { slug, bootstrap } = useBurrow();
  if (!shown) return null;
  return (
    <>
      <PlaceCard slug={slug} place={bootstrap.burrow.place ?? null} />
      <NewsCards slug={slug} />
    </>
  );
}

function PlaceCard({ slug, place }: { slug: string; place: Place | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Card label={P.title.toUpperCase()}>
      <Row
        first
        title={placeRowText(place)}
        body={P.about}
        action={
          <Button
            label={open ? CANCEL : P.change}
            variant="secondary"
            accessibilityLabel={open ? CANCEL : `${P.change} ${P.title.toLowerCase()}`}
            onPress={() => setOpen((was) => !was)}
          />
        }
      />
      {open ? <PlaceChange slug={slug} place={place} onDone={() => setOpen(false)} /> : null}
    </Card>
  );
}

function PlaceChange({ slug, place, onDone }: { slug: string; place: Place | null; onDone: () => void }) {
  const theme = useTheme();
  const find = useFindPlace(slug);
  const set = useSetPlace(slug);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Place[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const search = () => {
    if (query.trim().length < 2) return;
    setProblem(null);
    find.mutate(
      { query: query.trim() },
      {
        onSuccess: (result) => {
          setFound(result.places);
          if (result.places.length === 0) setProblem(P.noResults);
        },
        onError: () => {
          setFound(null);
          setProblem(P.failed);
        },
      },
    );
  };
  const keep = (next: Place | null) => {
    setProblem(null);
    const input = next ? (({ guessed: _guessed, ...rest }) => rest)(next) : null;
    set.mutate(input, {
      onSuccess: (burrow) => {
        showNotice(placeSavedText(burrow.place));
        onDone();
      },
      onError: (e) => setProblem(errorText(e)),
    });
  };
  const busy = find.isPending || set.isPending;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, gap: 10 }}>
      <FormField
        label={P.search}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={search}
        editable={!set.isPending}
      />
      <Button
        label={P.searchButton}
        busy={find.isPending}
        disabled={busy || query.trim().length < 2}
        onPress={search}
      />
      {found && found.length > 0 ? (
        <View
          style={{ borderWidth: 1, borderColor: theme.colors.line, borderRadius: 12, overflow: 'hidden' }}
        >
          {found.map((p, i) => (
            <Touchable
              key={`${p.name}:${p.lat}:${p.lon}`}
              feedback="wash"
              disabled={busy}
              accessibilityLabel={`${placeLabel(p)}, ${placeResultMeta(p)}`}
              onPress={() => keep(p)}
              style={{
                minHeight: 48,
                paddingHorizontal: 12,
                paddingVertical: 10,
                justifyContent: 'center',
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <Text size={15} weight={600}>
                {placeLabel(p)}
              </Text>
              <Text size={13} color={theme.colors.mut}>
                {placeResultMeta(p)}
              </Text>
            </Touchable>
          ))}
        </View>
      ) : null}
      <FormMessage text={problem} />
      {/* OpenStreetMap's data is ODbL: its credit stays by the results. */}
      <Text size={12} color={theme.colors.mut}>
        {P.credit}
      </Text>
      {place && !place.guessed ? (
        <Button label={P.useGuess} variant="secondary" disabled={busy} onPress={() => keep(null)} />
      ) : null}
    </View>
  );
}

function NewsCards({ slug }: { slug: string }) {
  const view = useNewsSources({ params: { burrow: slug } }, { retry: false });
  if (!view.data) return null;
  return <NewsParts slug={slug} view={view.data} />;
}

function NewsParts({ slug, view }: { slug: string; view: NewsSourcesView }) {
  const theme = useTheme();
  const set = useSetNewsSources(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const room = newsHasRoom(view);
  const change = (ids: string[], done?: string) => {
    setProblem(null);
    set.mutate(ids, {
      onSuccess: () => {
        if (done) showNotice(done);
      },
      onError: (e) => setProblem(fieldProblem(e, 'ids') ?? errorText(e)),
    });
  };
  const suggested = newsSuggestedTitle(view.place);
  return (
    <>
      <Card label={N.title.toUpperCase()}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {N.about}
          </Text>
        </View>
        {view.chosen.length === 0 ? (
          <Row title={N.none} muted />
        ) : (
          view.chosen.map((s) => (
            <ChosenRow
              key={s.id}
              source={s}
              busy={set.isPending}
              onOff={() => change(newsIdsWithout(view, s.id))}
            />
          ))
        )}
        {problem || !room ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <FormMessage text={problem ?? newsFullText()} />
          </View>
        ) : null}
      </Card>
      {suggested && view.suggestions.length > 0 ? (
        <Card label={suggested.toUpperCase()}>
          {view.suggestions.map((s, i) => (
            <Row
              key={s.id}
              first={i === 0}
              title={s.name}
              body={
                s.near !== 'country' && view.place?.regionName
                  ? view.place.regionName
                  : countryName(view.place?.country ?? '')
              }
              action={
                <Button
                  label={N.turnOn}
                  variant="secondary"
                  disabled={set.isPending || !room}
                  accessibilityLabel={`${N.turnOn} ${s.name}`}
                  onPress={() => change(newsIdsWith(view, s.id), newsAddedText(s.name))}
                />
              }
            />
          ))}
        </Card>
      ) : null}
      <AddSiteCard slug={slug} full={!room} />
    </>
  );
}

function ChosenRow({ source, busy, onOff }: { source: NewsChosenSource; busy: boolean; onOff: () => void }) {
  const theme = useTheme();
  const word = source.own ? N.remove : N.turnOff;
  return (
    <Row
      title={source.name}
      meta={hostOf(source.url)}
      action={
        <Button
          label={word}
          variant="secondary"
          disabled={busy}
          accessibilityLabel={`${word} ${source.name}`}
          onPress={onOff}
        />
      }
    >
      {source.problem ? (
        <Text size={13} lh={1.4} color={theme.colors.warn}>
          {source.problem}
        </Text>
      ) : null}
    </Row>
  );
}

function AddSiteCard({ slug, full }: { slug: string; full: boolean }) {
  const add = useAddNewsSite(slug);
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const submit = () => {
    if (!url.trim() || full) return;
    setFieldError(null);
    add.mutate(url.trim(), {
      onSuccess: (result) => {
        setUrl('');
        showNotice(newsAddedText(result.added.name));
      },
      onError: (e) => setFieldError(fieldProblem(e, 'url') ?? N.unreachable),
    });
  };
  return (
    <Card label={N.add.toUpperCase()}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
        <FormField
          label={N.addField}
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setFieldError(null);
          }}
          error={fieldError}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={submit}
          editable={!add.isPending}
        />
        <Button
          label={N.addButton}
          accessibilityLabel={N.add}
          busy={add.isPending}
          disabled={full || !url.trim()}
          onPress={submit}
        />
      </View>
    </Card>
  );
}
