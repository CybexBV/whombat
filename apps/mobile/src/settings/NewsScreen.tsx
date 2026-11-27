/**
 * Settings → News and weather on the phone (Whombat weather-news.md; app weather-news-apps.md), its own page from the
 * Settings list, laid out after the web's for a phone: the page's line, PLACE (the place guessed or chosen, *Change*:
 * a town or city to look up, up to five places to tap, the time zone's guess, OpenStreetMap's credit), YOUR SOURCES
 * with “5 of 30” (each source's mark, name, what it is, its problem in amber, *Turn off* or *Remove*, and *Change order*
 * for Move up and Move down), then FIND MORE in three parts: *Suggested* (a country, the topics that have sites, each
 * site with Add or On), *Add your own* (an address: a site, a feed, a YouTube channel, a subreddit, a podcast) and
 * *Import* (another reader's OPML file, picked on the phone). A Whombat before browsing has the place's suggestions and
 * Add your own, and reads 12. The phone has no *Use my location*: it would need a location module and a new build. Every
 * button and row is a 44dp target. A Whombat from before the place and the news shows only the page's line.
 */

import { HUMAN_INITIALS_COLOR, toneFor } from '@whombat/avatars';
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
  placeNewsShown,
  useAddNewsSite,
  useFindPlace,
  useImportNewsSites,
  useNewsBrowse,
  useNewsSources,
  useSessionProtocol,
  useSetNewsSources,
  useSetPlace,
} from '@whombat/client/react';
import {
  NEWS_SOURCES_MAX,
  NEWS_WORDS,
  type NewsBrowseSite,
  type NewsSourcesView,
  newsOpmlUrls,
  PLACE_SETTING_WORDS,
  type Place,
  placeLabel,
} from '@whombat/core';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { type ReactNode, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { Card, Row } from '../managed/ui';
import { errorText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { Check, ChevronDown, ChevronsUpDown, ChevronUp, type LucideIcon } from '../ui/icons';
import { Button, Chip } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { UnderlineTabs } from '../ui/UnderlineTabs';
import {
  browseSiteLine,
  chosenSourceLine,
  type NewsChip,
  newsChipHas,
  newsChipLabel,
  newsChips,
  newsCountText,
  newsFullTextFor,
  newsIdsMoved,
  newsImportText,
  newsMax,
  sourceInitials,
} from './news';
import { SettingsPage } from './SettingsPages';

const P = PLACE_SETTING_WORDS;
const N = NEWS_WORDS;
const CANCEL = 'Cancel';
/** The biggest list file read: an OPML of a few hundred feeds is far smaller. */
const IMPORT_MAX_BYTES = 1_000_000;

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

export function SettingsNewsScreen() {
  const theme = useTheme();
  const protocol = useSessionProtocol();
  const { slug, bootstrap } = useBurrow();
  const shown = placeNewsShown(protocol);
  return (
    <SettingsPage title={N.page}>
      <Text size={15} lh={1.5} color={theme.colors.ink2} style={{ paddingHorizontal: 6, marginTop: -8 }}>
        {N.pageLine}
      </Text>
      {shown ? (
        <>
          <PlaceCard slug={slug} place={bootstrap.burrow.place ?? null} />
          <NewsCards slug={slug} more={newsMoreShown(protocol)} />
        </>
      ) : null}
    </SettingsPage>
  );
}

/* Place ------------------------------------------------------------------------------------------------------------ */

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

/* Your sources ----------------------------------------------------------------------------------------------------- */

function NewsCards({ slug, more }: { slug: string; more: boolean }) {
  const view = useNewsSources({ params: { burrow: slug } }, { retry: false });
  if (!view.data) return null;
  return <NewsParts slug={slug} view={view.data} more={more} />;
}

type FindPart = 'suggested' | 'own' | 'import';

function NewsParts({ slug, view, more }: { slug: string; view: NewsSourcesView; more: boolean }) {
  const set = useSetNewsSources(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const max = newsMax(more);
  const room = view.chosen.length < max;
  const change = (ids: string[], done?: string) => {
    setProblem(null);
    set.mutate(ids, {
      onSuccess: () => {
        if (done) showNotice(done);
      },
      onError: (e) => setProblem(fieldProblem(e, 'ids') ?? errorText(e)),
    });
  };
  const turnOn = (site: { id: string; name: string }) =>
    change(newsIdsWith(view, site.id), newsAddedText(site.name));
  const parts: { key: FindPart; label: string }[] = [
    { key: 'suggested', label: N.tabSuggested },
    { key: 'own', label: N.tabOwn },
    ...(more ? [{ key: 'import' as const, label: N.tabImport }] : []),
  ];
  const [part, setPart] = useState<FindPart>('suggested');
  return (
    <>
      <YourSources
        view={view}
        max={max}
        busy={set.isPending}
        problem={problem ?? (room ? null : newsFullTextFor(max))}
        onOff={(id) => change(newsIdsWithout(view, id))}
        onMove={(id, by) => change(newsIdsMoved(view.chosen, id, by))}
      />
      <View>
        <LabelRow label={N.findMore.toUpperCase()} />
        <View style={{ marginTop: -2 }}>
          <UnderlineTabs<FindPart>
            tabs={parts}
            value={part}
            onChange={setPart}
            label={N.findMore}
            bleed={16}
          />
        </View>
      </View>
      {part === 'suggested' ? (
        more ? (
          <BrowseCard slug={slug} room={room} busy={set.isPending} onAdd={turnOn} />
        ) : (
          <SuggestedCard view={view} room={room} busy={set.isPending} onAdd={turnOn} />
        )
      ) : part === 'own' ? (
        <AddOwnCard slug={slug} full={!room} max={max} />
      ) : (
        <ImportCard slug={slug} full={!room} max={max} />
      )}
    </>
  );
}

/** A section's label with something on its right (“5 of 30”). */
function LabelRow({ label, end }: { label: string; end?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 6 }}>
      <Text
        size={11}
        weight={500}
        mono
        tracking={0.05}
        color={theme.colors.mut}
        accessibilityRole="header"
        style={{ flex: 1 }}
      >
        {label}
      </Text>
      {end ? (
        <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
          {end}
        </Text>
      ) : null}
    </View>
  );
}

function YourSources({
  view,
  max,
  busy,
  problem,
  onOff,
  onMove,
}: {
  view: NewsSourcesView;
  max: number;
  busy: boolean;
  problem: string | null;
  onOff: (id: string) => void;
  onMove: (id: string, by: number) => void;
}) {
  const theme = useTheme();
  const [ordering, setOrdering] = useState(false);
  const chosen = view.chosen;
  const count = newsCountText(chosen.length, max);
  return (
    <View>
      <LabelRow label={N.chosen.toUpperCase()} end={count} />
      <Card>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {N.about}
          </Text>
        </View>
        {chosen.length === 0 ? (
          <Row title={N.none} muted />
        ) : (
          chosen.map((s, i) => (
            <SourceRow
              key={s.id}
              mark={s}
              name={s.name}
              line={chosenSourceLine(s, view.place)}
              problem={s.problem ?? null}
              end={
                ordering ? (
                  <>
                    <MoveButton
                      label={fill(N.moveUp, { name: s.name })}
                      icon={ChevronUp}
                      disabled={busy || i === 0}
                      onPress={() => onMove(s.id, -1)}
                    />
                    <MoveButton
                      label={fill(N.moveDown, { name: s.name })}
                      icon={ChevronDown}
                      disabled={busy || i === chosen.length - 1}
                      onPress={() => onMove(s.id, 1)}
                    />
                  </>
                ) : (
                  <Button
                    label={s.own ? N.remove : N.turnOff}
                    variant="secondary"
                    disabled={busy}
                    accessibilityLabel={`${s.own ? N.remove : N.turnOff} ${s.name}`}
                    onPress={() => onOff(s.id)}
                  />
                )
              }
            />
          ))
        )}
        {problem ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <FormMessage text={problem} />
          </View>
        ) : null}
        {chosen.length > 1 ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
              paddingHorizontal: 8,
              paddingVertical: 4,
              alignItems: 'flex-start',
            }}
          >
            <Button
              label={ordering ? N.orderDone : N.order}
              variant="quiet"
              onPress={() => setOrdering((was) => !was)}
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
}

/** A source's mark: its letters on a tone of its own (the avatars' tones, fixed in both themes). */
function SourceMark({ id, name }: { id: string; name: string }) {
  const letters = sourceInitials(name);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        backgroundColor: toneFor(id),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text size={letters.length > 2 ? 10.5 : 12.5} weight={700} color={HUMAN_INITIALS_COLOR}>
        {letters}
      </Text>
    </View>
  );
}

function SourceRow({
  mark,
  name,
  line,
  problem = null,
  end,
  first = false,
}: {
  mark: { id: string; name: string };
  name: string;
  line: string;
  problem?: string | null;
  end: ReactNode;
  first?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 60,
        paddingVertical: 10,
        paddingLeft: 16,
        paddingRight: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <SourceMark id={mark.id} name={mark.name} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={500} lh={1.35}>
          {name}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {line}
        </Text>
        {problem ? (
          <Text size={13} lh={1.4} color={theme.colors.warnText}>
            {problem}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>{end}</View>
    </View>
  );
}

function MoveButton({
  label,
  icon: Icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      feedback="wash"
      ringRadius={22}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon size={20} color={disabled ? theme.colors.line2 : theme.colors.ink2} />
    </Touchable>
  );
}

/** Add, or On for one that is on already. */
function AddOrOn({
  name,
  on,
  disabled,
  onAdd,
}: {
  name: string;
  on: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const theme = useTheme();
  if (on)
    return (
      <View
        accessible
        accessibilityLabel={`${name}, ${N.on}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 8 }}
      >
        <Check size={16} color={theme.colors.okText} />
        <Text size={14} weight={500} color={theme.colors.okText}>
          {N.on}
        </Text>
      </View>
    );
  return (
    <Button
      label={N.addButton}
      variant="secondary"
      disabled={disabled}
      accessibilityLabel={`${N.addButton} ${name}`}
      onPress={onAdd}
    />
  );
}

/* Find more: suggested --------------------------------------------------------------------------------------------- */

/** Every country's suggestions, by topic (a Whombat that browses). */
function BrowseCard({
  slug,
  room,
  busy,
  onAdd,
}: {
  slug: string;
  room: boolean;
  busy: boolean;
  onAdd: (site: NewsBrowseSite) => void;
}) {
  const theme = useTheme();
  const [country, setCountry] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [chip, setChip] = useState<NewsChip>('all');
  const browse = useNewsBrowse(
    { params: { burrow: slug }, query: country ? { country } : {} },
    { retry: false },
  );
  const data = browse.data;
  const chips = useMemo(() => (data ? newsChips(data.sites) : []), [data]);
  const shownChip = chips.includes(chip) ? chip : 'all';
  const sites = data ? data.sites.filter((s) => newsChipHas(shownChip, s)) : [];
  const countries = useMemo(
    () =>
      (data?.countries ?? [])
        .map((c) => ({ code: c.code, name: countryName(c.code) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );
  if (!data) return browse.error ? <FormMessage text={errorText(browse.error)} /> : null;
  const shownName = data.country ? countryName(data.country) : '';
  return (
    <Card>
      {countries.length > 0 ? (
        <Touchable
          onPress={() => setPicking(true)}
          feedback="wash"
          accessibilityRole="button"
          accessibilityLabel={`${N.country}, ${shownName}`}
          accessibilityState={{ expanded: picking }}
          style={{
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingHorizontal: 16,
          }}
        >
          <Text size={15.5} weight={500} style={{ flexShrink: 0 }}>
            {N.country}
          </Text>
          <Text
            size={15}
            color={theme.colors.ink2}
            numberOfLines={1}
            style={{ flex: 1, minWidth: 0, textAlign: 'right' }}
          >
            {shownName}
          </Text>
          <ChevronsUpDown size={16} color={theme.colors.mut} strokeWidth={2} />
        </Touchable>
      ) : null}
      {chips.length > 1 ? (
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 8,
            rowGap: 14,
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: 14,
          }}
        >
          {chips.map((c) => (
            <Chip key={c} label={newsChipLabel(c)} active={c === shownChip} onPress={() => setChip(c)} />
          ))}
        </View>
      ) : null}
      {sites.map((s, i) => (
        <SourceRow
          key={s.id}
          first={i === 0 && countries.length === 0 && chips.length <= 1}
          mark={s}
          name={s.name}
          line={browseSiteLine(s)}
          end={<AddOrOn name={s.name} on={s.on} disabled={busy || !room} onAdd={() => onAdd(s)} />}
        />
      ))}
      <CountrySheet
        visible={picking}
        countries={countries}
        chosen={data.country}
        onClose={() => setPicking(false)}
        onPick={(code) => {
          setPicking(false);
          setChip('all');
          setCountry(code);
        }}
      />
    </Card>
  );
}

/** The countries Whombat suggests sites for, by name, the shown one ticked. */
function CountrySheet({
  visible,
  countries,
  chosen,
  onClose,
  onPick,
}: {
  visible: boolean;
  countries: readonly { code: string; name: string }[];
  chosen: string | null;
  onClose: () => void;
  onPick: (code: string) => void;
}) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} label={N.country} title={N.country.toUpperCase()}>
      <ScrollView accessibilityRole="radiogroup" accessibilityLabel={N.country}>
        {countries.map((c) => {
          const on = c.code === chosen;
          return (
            <Touchable
              key={c.code}
              onPress={() => onPick(c.code)}
              feedback="wash"
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={c.name}
              style={{
                minHeight: 48,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 22,
                paddingVertical: 12,
              }}
            >
              <Text size={16} weight={on ? 600 : 400} style={{ flex: 1 }}>
                {c.name}
              </Text>
              {on ? <Check size={18} color={theme.colors.brand} /> : null}
            </Touchable>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}

/** A Whombat before browsing: the place's own suggestions, nearest first. */
function SuggestedCard({
  view,
  room,
  busy,
  onAdd,
}: {
  view: NewsSourcesView;
  room: boolean;
  busy: boolean;
  onAdd: (site: { id: string; name: string }) => void;
}) {
  const title = newsSuggestedTitle(view.place);
  if (!title || view.suggestions.length === 0) return null;
  return (
    <Card label={title.toUpperCase()}>
      {view.suggestions.map((s, i) => (
        <SourceRow
          key={s.id}
          first={i === 0}
          mark={s}
          name={s.name}
          line={
            s.near !== 'country' && view.place?.regionName
              ? view.place.regionName
              : countryName(view.place?.country ?? '')
          }
          end={<AddOrOn name={s.name} on={false} disabled={busy || !room} onAdd={() => onAdd(s)} />}
        />
      ))}
    </Card>
  );
}

/* Find more: your own and import ----------------------------------------------------------------------------------- */

function AddOwnCard({ slug, full, max }: { slug: string; full: boolean; max: number }) {
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
    <Card>
      <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
        <FormField
          label={N.addField}
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setFieldError(null);
          }}
          error={fieldError ?? (full ? newsFullTextFor(max) : null)}
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

/** Another reader's list: an OPML file picked on the phone, its feeds sent to the Whombat to check and add. */
function ImportCard({ slug, full, max }: { slug: string; full: boolean; max: number }) {
  const theme = useTheme();
  const importSites = useImportNewsSites(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const choose = async () => {
    setProblem(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['text/x-opml', 'text/xml', 'application/xml', '*/*'],
      copyToCacheDirectory: true,
      multiple: false,
    }).catch(() => null);
    const asset = picked && !picked.canceled ? picked.assets[0] : null;
    if (!asset) return;
    setReading(true);
    const file = new File(asset.uri);
    let urls: string[] = [];
    try {
      urls = (asset.size ?? 0) > IMPORT_MAX_BYTES ? [] : newsOpmlUrls(await file.text());
    } catch {
      urls = [];
    } finally {
      setReading(false);
      // The picker's copy isn't kept.
      try {
        file.delete();
      } catch {
        // already gone
      }
    }
    if (urls.length === 0) return setProblem(N.importNone);
    importSites.mutate(urls.slice(0, NEWS_SOURCES_MAX), {
      onSuccess: (result) => showNotice(newsImportText(result)),
      onError: (e) => setProblem(fieldProblem(e, 'urls') ?? errorText(e)),
    });
  };
  return (
    <Card>
      <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
        <Text size={14} lh={1.45} color={theme.colors.ink2}>
          {N.importLine}
        </Text>
        <FormMessage text={problem ?? (full ? newsFullTextFor(max) : null)} />
        <Button
          label={N.importButton}
          variant="secondary"
          busy={reading || importSites.isPending}
          disabled={full}
          onPress={() => void choose()}
        />
      </View>
    </Card>
  );
}
