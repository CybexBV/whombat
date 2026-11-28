/**
 * Servers and Connections as places (Whombat servers-connections-places.md): one list screen for both, the
 * `ServersPlace` and `ConnectionsPlace` routes (the web's `/servers` and `/connected`). Its heading with the `+` (“Add a
 * server” to Add a server, “Add a connection” to Add a connection), the place's line under it (`placeSummary`), then one
 * row each, Chat's shape: the logo on a 40pt tile, the name, a server's processor at the
 * end, and under the name how it is in a few words, with its status mark and in the problem's colour when it isn't
 * fine. A server that runs on another is set in under it with an elbow. The rows are `usePlaceLists`' (the same reads as
 * the Places sheet's marks). A row opens the thing's page (`Thing`), or the address a thing without a page follows; a long
 * press offers Open and Rename (server-names.md). From the two-page width the list is the left page and the picked
 * page shows beside it (`SplitStack`); opened there with nothing beside, it opens the row it opened last, else the
 * first (`placeOpening`), so the right page is never empty.
 */
import { StackActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  clientTranslator,
  exposureText,
  placeWords as listWords,
  type PlaceRowTone,
  type PlaceSummaryPart,
  placeOpening,
  placeSummaryParts,
  serversDown,
  type ThingPlace,
  thingRenameTarget,
} from '@whombat/client';
import { useSessionProtocol } from '@whombat/client/react';
import { EXPOSURE_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import type { NativeTheme as Theme } from '@whombat/tokens';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { listPlaceOfScreen, type PhonePlaceRow } from '../data/places';
import { parseThingRowPick, renameCopy, thingRowMenu } from '../data/rename';
import { type Tab, tabWords } from '../data/shell';
import { useLastInPlace, usePlaceLists } from '../data/usePlaceLists';
import { type ThingRenaming, useThingRename } from '../data/useThingRename';
import { useI18n } from '../i18n';
import { mobileTranslator } from '../i18n/translate';
import { backWordUnder } from '../navigation/backWord';
import { openHref } from '../navigation/hooks';
import { isBeside, useBeside, useLastTab, usePaneRole } from '../navigation/panes';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ThingIcon } from '../ui/assistant';
import { BackBar, Screen } from '../ui/headers';
import { Globe, Plus } from '../ui/icons';
import { InlineRename } from '../ui/inlineRename';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { PlacesButton, SHELL_TARGET } from '../ui/places';
import { Button, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { StatusMark } from '../ui/statusMark';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'ServersPlace' | 'ConnectionsPlace'>;

/** A row's line in its tone: the problem's colour, amber's text colour, or grey. */
function toneColor(theme: Theme, tone: PlaceRowTone): string {
  return tone === 'bad' ? theme.colors.bad : tone === 'warn' ? theme.colors.warnText : theme.colors.mut;
}

export function PlaceScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const { slug } = useBurrowBase();
  const place: ThingPlace = listPlaceOfScreen(route.name) ?? 'servers';
  const { rawLocale } = useI18n();
  const words = listWords(rawLocale)[place];
  const lists = usePlaceLists();
  const rows = lists[place];
  const loading = lists.loading[place];
  const role = usePaneRole();
  const lastTab = useLastTab();
  const beside = useBeside();
  const [last, keepLast] = useLastInPlace(place);
  const rename = useThingRename(slug);
  // Elsewhere than iPhone a held row's menu is a sheet, for the row it was held on.
  const [menuFor, setMenuFor] = useState<PhonePlaceRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const open = (row: PhonePlaceRow) => {
    keepLast(row.id);
    if (row.opens) openHref(row.opens);
    else
      navigation.navigate('Thing', {
        thingId: row.id,
        title: rename.shown(row.id, row.name),
        back: words.back,
      });
  };
  const pick = (row: PhonePlaceRow, id: string) => {
    const picked = parseThingRowPick(id);
    if (picked === 'open') open(row);
    else if (picked === 'rename') rename.start(row.id);
  };
  const add = () =>
    place === 'servers'
      ? navigation.navigate('AddServer', { back: words.title })
      : navigation.navigate('AddConnection');
  // As the left page the tabs wait under it: back goes to them. Alone it goes back to where it was opened.
  const goBack = () => {
    if (role === 'list') navigation.dispatch(StackActions.popTo('Tabs'));
    else if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Tabs');
  };

  // From the two-page width the right page is never empty: once the rows and the last one are known, open the one
  // looked at last while it is still listed, else the first. Once, so closing that page leaves the list as it is.
  // The route keeps it too: folding and unfolding mount this screen anew.
  const opened = useRef(!!route.params?.opened);
  const markOpened = () => {
    opened.current = true;
    navigation.setParams({ opened: true });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once, with the rows of the moment it can.
  useEffect(() => {
    if (opened.current || role !== 'list') return;
    if (beside) {
      markOpened();
      return;
    }
    if (last === undefined || loading) return;
    const pages = rows.filter((r) => !r.opens);
    const href = placeOpening(pages, last);
    const row = href ? pages.find((r) => r.href === href) : null;
    // Nothing with a page of its own yet (an empty list, or an older account's rows that lead elsewhere): the right
    // side asks for a pick, and the first such row to arrive is still the one to open.
    if (!row) {
      if (!route.params?.idle) navigation.setParams({ idle: true });
      return;
    }
    markOpened();
    open(row);
  }, [role, beside, last, loading, rows]);

  const chat = tabWords(rawLocale).ChatRoom;
  const renameWords = renameCopy(rawLocale);
  const summary = placeSummaryParts(place, rows, rawLocale);
  const empty = !rows.length && !loading;
  return (
    <Screen>
      <BackBar
        // As the list, back goes to the tabs: it names the tab they show, not the screen this was opened from.
        label={
          role === 'list'
            ? (tabWords(rawLocale)[lastTab as Tab] ?? chat)
            : (route.params?.back ?? backWordUnder(navigation.getState(), route.key, rawLocale))
        }
        onPress={goBack}
        right={<PlacesButton current={place} here={words.title} />}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomRoom + 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void lists.refetch().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <View style={{ paddingTop: 6, paddingHorizontal: 16, paddingBottom: 10 }}>
          {/* 48 tall and pulled back by 6 each side: the `+`'s padded target fits inside the row, which Android needs
              to deliver a touch, without moving anything. */}
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, marginVertical: -6 }}
          >
            <Text size={20} weight={700} tracking={-0.01} accessibilityRole="header" style={{ flex: 1 }}>
              {words.title}
            </Text>
            {place === 'connections' || lists.hosts ? (
              <Touchable
                onPress={add}
                feedback="wash"
                ringRadius={10}
                accessibilityRole="button"
                accessibilityLabel={words.add}
                // 48 to the finger, the shell's Android target (and more than iPhone's 44).
                hitSlop={6}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.colors.line2,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Plus size={18} color={theme.colors.ink2} strokeWidth={1.75} />
              </Touchable>
            ) : null}
          </View>
          {summary.length ? <Summary parts={summary} /> : null}
        </View>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            paddingTop: 4,
            paddingHorizontal: 8,
          }}
        >
          {rows.length ? (
            rows.map((row) => {
              const name = rename.shown(row.id, row.name);
              const target = thingRenameTarget({ id: row.id, name });
              return (
                <PlaceListRow
                  key={row.id}
                  row={row}
                  name={name}
                  selected={isBeside(beside, 'Thing', 'thingId', row.id)}
                  onPress={() => open(row)}
                  menu={target ? { onPick: (id) => pick(row, id), onOpen: () => setMenuFor(row) } : null}
                  renaming={renameBox(row, name, rename, rawLocale)}
                />
              );
            })
          ) : loading ? (
            <SkeletonRows count={4} avatarSize={40} label={words.title} />
          ) : empty ? (
            <Text size={14} color={theme.colors.mut} style={{ paddingHorizontal: 10, paddingVertical: 16 }}>
              {place === 'servers' && lists.hostsDown
                ? serversDown(rawLocale)
                : lists.failed
                  ? words.failed
                  : words.empty}
            </Text>
          ) : null}
          {place === 'servers' ? (
            <InternetRow
              selected={beside?.name === 'Internet'}
              onPress={() => navigation.navigate('Internet', { back: words.title })}
            />
          ) : null}
          {place === 'servers' && lists.hosts && lists.pendingServers ? (
            <WaitingCard pending={lists.pendingServers} onReview={add} />
          ) : null}
        </View>
      </ScrollView>
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menuFor ? thingRowMenu(rename.shown(menuFor.id, menuFor.name), rawLocale) : null}
          visible={menuFor !== null}
          label={renameWords.rowMenu(menuFor ? rename.shown(menuFor.id, menuFor.name) : '')}
          onClose={() => setMenuFor(null)}
          onPick={(id) => menuFor && pick(menuFor, id)}
        />
      )}
    </Screen>
  );
}

/** “5 servers · 1 not working · 1 needs a look”: the count grey, what isn't working red, what needs a look amber. */
function Summary({ parts }: { parts: readonly PlaceSummaryPart[] }) {
  const theme = useTheme();
  const color = (tone: PlaceSummaryPart['tone']) =>
    tone === 'bad' ? theme.colors.bad : tone === 'warn' ? theme.colors.warnText : theme.colors.mut;
  return (
    <Text size={13.5} color={theme.colors.mut} style={{ marginTop: 4 }}>
      {parts.map((part, i) => (
        // The dot between stays grey; only the count's words take its tone.
        <Fragment key={part.text}>
          {i ? ' · ' : ''}
          <Text size={13.5} color={color(part.tone)}>
            {part.text}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}

/** The box a row's name turns into while it is renamed, else null. */
function renameBox(row: PhonePlaceRow, name: string, rename: ThingRenaming, locale?: string): ReactNode {
  if (rename.editing !== row.id) return null;
  const target = thingRenameTarget({ id: row.id, name });
  if (!target) return null;
  const copy = renameCopy(locale);
  return (
    <InlineRename
      value={name}
      maxLength={target.max}
      label={copy.label(name)}
      hint={target.kind === 'server' ? copy.serverHint : undefined}
      onSave={(typed) => rename.save(target, typed)}
      onClose={rename.stop}
      size={15}
      weight={600}
    />
  );
}

/**
 * One row (the mock's `.row`): radius 12, padded 10, the 40pt logo tile spanning both lines, the name 15/600 and the
 * figure in mono 11.5 at the end, the line 13 under them with its mark. At least the platform's touch target tall, one
 * button named by `row.label`; selected while the page beside the list shows it. A child is set in 22 with the elbow.
 */
function PlaceListRow({
  row,
  name,
  selected,
  onPress,
  menu,
  renaming,
}: {
  row: PhonePlaceRow;
  name: string;
  selected: boolean;
  onPress: () => void;
  /** Open and Rename on a long press, for what can be renamed. */
  menu: { onPick: (id: string) => void; onOpen: () => void } | null;
  renaming: ReactNode;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const frame = {
    minHeight: SHELL_TARGET,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    padding: 10,
    borderRadius: 12,
    backgroundColor: selected ? theme.colors.sel : undefined,
  };
  const content = (
    <>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          backgroundColor: theme.colors.sf2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ThingIcon glyph={row.phoneGlyph} mark={row.mark} size={22} color={theme.colors.ink2} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {renaming ?? (
              <Text size={15} weight={600} tracking={-0.005} numberOfLines={1}>
                {name === row.name && row.note ? (
                  <>
                    {row.main}
                    {/* What tells two of a kind apart (“dev”), quieter, as the sidebar drew it. */}
                    <Text size={15} weight={400} color={theme.colors.mut}>
                      {` ${row.note}`}
                    </Text>
                  </>
                ) : (
                  name
                )}
              </Text>
            )}
          </View>
          {row.figure ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {row.figure}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <StatusMark level={row.level} />
          <Text size={13} color={toneColor(theme, row.tone)} numberOfLines={1} style={{ flexShrink: 1 }}>
            {row.line}
          </Text>
        </View>
      </View>
    </>
  );
  const body = renaming ? (
    <View style={frame}>{content}</View>
  ) : (
    <Touchable
      onPress={onPress}
      {...(menu && !hasNativeMenu ? { onLongPress: menu.onOpen } : null)}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="button"
      accessibilityLabel={
        name === row.name
          ? row.label
          : [
              name,
              row.line,
              row.figure
                ? clientTranslator(rawLocale).t('thingPlace.line.processor', { figure: row.figure })
                : null,
            ]
              .filter(Boolean)
              .join(', ')
      }
      accessibilityState={{ selected }}
      // Screen readers can't hold: Rename is the row's own action too.
      {...(menu
        ? {
            accessibilityActions: [{ name: 'rename', label: renameCopy(rawLocale).rename }],
            onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) =>
              menu.onPick(e.nativeEvent.actionName),
          }
        : null)}
      style={frame}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        {content}
      </View>
    </Touchable>
  );
  // The menu takes the row's own press (so a hold doesn't open it too): the Touchable is its only child.
  const pressable =
    menu && !renaming ? (
      <NativeMenu spec={thingRowMenu(name, rawLocale)} onPick={menu.onPick}>
        {body}
      </NativeMenu>
    ) : (
      body
    );
  if (!row.child) return pressable;
  // Set in under its parent: the elbow comes down from the row above and turns into this row's logo, beside the row
  // and inside its own box (the order it is read in stays the order it is shown).
  return (
    <View style={{ flexDirection: 'row' }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          marginLeft: 10,
          marginRight: 2,
          marginTop: -8,
          height: 36,
          width: 10,
          borderLeftWidth: 1.5,
          borderBottomWidth: 1.5,
          borderColor: theme.colors.line2,
          borderBottomLeftRadius: 7,
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>{pressable}</View>
    </View>
  );
}

/**
 * Open to the internet at the end of Servers (Whombat internet-exposure.md), set apart by a hairline: what the internet
 * can reach through the proxies, tunnels and routers Whombat is connected to. Only on a Whombat that can say.
 */
function InternetRow({ selected, onPress }: { selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const supported = protocolAtLeast(useSessionProtocol(), EXPOSURE_MINOR);
  if (!supported) return null;
  const words = exposureText(rawLocale);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, marginTop: 6, paddingTop: 6 }}>
      <Touchable
        onPress={onPress}
        feedback="wash"
        ringRadius={12}
        accessibilityRole="button"
        accessibilityLabel={`${words.title}, ${words.row}`}
        accessibilityState={{ selected }}
        style={{
          minHeight: SHELL_TARGET,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 10,
          borderRadius: 12,
          backgroundColor: selected ? theme.colors.sel : undefined,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Globe size={21} color={theme.colors.ink2} strokeWidth={1.75} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text size={15} weight={600} tracking={-0.005} numberOfLines={1}>
            {words.title}
          </Text>
          <Text size={13} color={theme.colors.mut} numberOfLines={1}>
            {words.row}
          </Text>
        </View>
      </Touchable>
    </View>
  );
}

/**
 * A server waiting to be added, under Servers' rows: a dashed `line2` frame, the server glyph on its tile, what it is
 * and what to do, and Review, which opens Add a server with its waiting list.
 */
function WaitingCard({ pending, onReview }: { pending: number; onReview: () => void }) {
  const { rawLocale } = useI18n();
  const tr = mobileTranslator(rawLocale);
  const theme = useTheme();
  const waiting = tr.tp('data.homeServers.waiting', pending, { count: pending });
  const review = tr.t('data.homeServers.review');
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.line2,
        borderRadius: 16,
        padding: 16,
        gap: 14,
        marginHorizontal: 8,
        marginTop: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ThingIcon glyph="server" size={22} color={theme.colors.ink2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text size={17} weight={600} lh={1.35} tracking={-0.01}>
            {waiting}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.mut} style={{ marginTop: 2 }}>
            {tr.t('data.homeServers.waitingLine')}
          </Text>
        </View>
      </View>
      <Button
        label={review}
        onPress={onReview}
        accessibilityLabel={`${review}: ${waiting}`}
        style={{ alignSelf: 'flex-start', paddingHorizontal: 16 }}
      />
    </View>
  );
}
