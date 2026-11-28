/**
 * Places (docs/decisions/phone-shell-final.md, servers-connections-places.md): the button that opens it and the sheet —
 * the platform's own sheet, with Close first, the places in their order (`data/places.ts`) with Chat's and the Inbox's
 * counts; Servers (once there is a server or the hosts service) and Connections right after the Inbox, each with the
 * worst status mark of what it holds (the red ring for something not working, the amber dot for a look) and its name
 * saying so. It scrolls at large text rather than shrinking a row. Choosing a place closes the sheet and, once it is
 * down, opens the place; closing it puts a screen reader back on the button that opened it.
 */

import { StackActions } from '@react-navigation/native';
import { placeSpoken, type StatusLevel } from '@whombat/client';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { serverFacts } from '../data/homeServers';
import {
  type PlaceId,
  placeLabel,
  placeRoute,
  placesCopy,
  placeWords,
  type ServerFacts,
  sheetPlaces,
} from '../data/places';
import { type Tab, tabWords } from '../data/shell';
import { usePlaceLists } from '../data/usePlaceLists';
import { useI18n } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { useLastTab, usePaneRole } from '../navigation/panes';
import { LIST_PAGES } from '../navigation/splitRouter';
import { useBadges } from '../navigation/TabBar';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import {
  Folder,
  Inbox,
  Lock,
  type LucideIcon,
  Menu,
  MessageCircle,
  Plug,
  Server,
  Settings as SettingsIcon,
  X,
  Zap,
} from './icons';
import { focusRowSoon, registerRowFocus } from './rowFocus';
import { Sheet, useAfterSheet, whenSheetDown } from './sheet';
import { StatusMark } from './statusMark';
import { Touchable } from './Touchable';

/** The smallest target: 44pt on iPhone, 48dp on Android. */
export const SHELL_TARGET = Platform.OS === 'ios' ? 44 : 48;

/** Each place's icon: the tab bar's for the tabs. */
export const PLACE_ICONS: Record<PlaceId, LucideIcon> = {
  chat: MessageCircle,
  inbox: Inbox,
  servers: Server,
  connections: Plug,
  automations: Zap,
  files: Folder,
  vault: Lock,
  settings: SettingsIcon,
};

/**
 * The servers as Servers shows them (their logos, systems and how they are) for Search, from the same reads, so
 * nothing is asked again; none where the Whombat runs no hosts service.
 */
export function useServerFacts(): ServerFacts[] {
  const { slug } = useBurrowBase();
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow: slug } } : null, { retry: false });
  const { rawLocale } = useI18n();
  return useMemo(() => serverFacts(fleet.data?.servers ?? [], rawLocale), [fleet.data?.servers, rawLocale]);
}

const OPENER = 'places-opener';

/**
 * The Places button: the menu glyph alone at the start of a tab's top row (`iconOnly`), the glyph and the word at the
 * right of a pushed page's back row. `current` is the place on screen (marked in the sheet), `here` the title the next
 * page's “‹ …” names.
 */
export function PlacesButton({
  current,
  here,
  iconOnly = false,
}: {
  current: PlaceId | null;
  here: string;
  iconOnly?: boolean;
}) {
  const { rawLocale } = useI18n();
  const copy = placesCopy(rawLocale);
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<View>(null);
  useEffect(() => registerRowFocus(OPENER, ref), []);
  return (
    <>
      <Touchable
        ref={ref}
        onPress={() => {
          // Two pages can each show a Places button: the focus comes back to the one that opened the sheet.
          registerRowFocus(OPENER, ref);
          setOpen(true);
        }}
        feedback="wash"
        ringRadius={iconOnly ? SHELL_TARGET / 2 : 10}
        accessibilityRole="button"
        accessibilityLabel={copy.open}
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: SHELL_TARGET,
          minWidth: SHELL_TARGET,
          paddingHorizontal: iconOnly ? 0 : 8,
          borderRadius: iconOnly ? SHELL_TARGET / 2 : 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <Menu size={iconOnly ? 22 : 20} color={theme.colors.ink2} strokeWidth={1.75} />
        {iconOnly ? null : (
          <Text size={15} color={theme.colors.ink2}>
            {copy.open}
          </Text>
        )}
      </Touchable>
      <PlacesSheet
        visible={open}
        current={current}
        here={here}
        onClose={() => {
          setOpen(false);
          focusRowSoon(OPENER);
        }}
        onChosen={() => setOpen(false)}
      />
    </>
  );
}

function PlacesSheet({
  visible,
  current,
  here,
  onClose,
  onChosen,
}: {
  visible: boolean;
  current: PlaceId | null;
  here: string;
  onClose: () => void;
  onChosen: () => void;
}) {
  const { rawLocale } = useI18n();
  const copy = placesCopy(rawLocale);
  const theme = useTheme();
  const navigation = useAppNavigation();
  const badges = useBadges();
  const role = usePaneRole();
  const after = useAfterSheet();
  // The rows (and the reads behind Servers' and Connections' marks) only while the sheet is up or going down; drawn
  // in the very render that opens it, so the sheet takes its height at once.
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);
  // Android's sheet never says it is down: let the rows go once it surely is.
  useEffect(() => {
    if (!visible && mounted) return whenSheetDown(() => setMounted(false));
  }, [visible, mounted]);
  const lastTab = useLastTab();
  // A place that is the left page gives way to the tabs: what opens next goes back to them, by their name.
  const fromList = role === 'list' && (current === 'servers' || current === 'connections');
  const backWord = fromList ? (tabWords(rawLocale)[lastTab as Tab] ?? tabWords(rawLocale).ChatRoom) : here;
  const go = () => {
    after.onDismissed();
    setMounted(false);
  };
  const choose = (run: () => void) => {
    after.later(run);
    onChosen();
  };
  const openPlace = (place: PlaceId) => {
    // The place already open: nothing to open, and its own back stays as it was.
    if (place === current) {
      onClose();
      return;
    }
    choose(() => {
      const route = placeRoute(place, backWord);
      // Back to the tabs, the pages above them closing, on the tab chosen.
      if (route.kind === 'tab') navigation.dispatch(StackActions.popTo('Tabs', { screen: route.tab }));
      else {
        // From a place that is the left page, another place takes its page: back to the tabs first, so it opens
        // beside them rather than beside the list.
        if (fromList && !LIST_PAGES.includes(route.name)) navigation.dispatch(StackActions.popTo('Tabs'));
        (navigation.navigate as (name: string, params: object) => void)(route.name, route.params);
      }
    });
  };
  const counts: Partial<Record<PlaceId, { count: number; tone: 'ink' | 'warn' | 'bad' }>> = {
    chat: { count: badges.ChatRoom?.count ?? 0, tone: 'ink' },
    inbox: {
      count: badges.NeedsYou?.count ?? 0,
      tone: badges.NeedsYou?.tone === 'bad' ? 'bad' : badges.NeedsYou?.tone === 'warn' ? 'warn' : 'ink',
    },
  };
  return (
    <Sheet visible={visible} onClose={onClose} onDismissed={go} label={copy.title} maxHeight="92%">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 24,
          paddingRight: 12,
          paddingBottom: 4,
        }}
      >
        <Text size={20} weight={700} accessibilityRole="header">
          {copy.title}
        </Text>
        <Touchable
          onPress={onClose}
          feedback="wash"
          ringRadius={SHELL_TARGET / 2}
          accessibilityRole="button"
          accessibilityLabel={copy.close}
          style={{
            width: SHELL_TARGET,
            height: SHELL_TARGET,
            borderRadius: SHELL_TARGET / 2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={20} color={theme.colors.ink2} strokeWidth={1.75} />
        </Touchable>
      </View>
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}
      >
        {visible || mounted ? <SheetRows current={current} counts={counts} onOpen={openPlace} /> : null}
      </ScrollView>
    </Sheet>
  );
}

/** The sheet's places in order, Servers and Connections with the worst mark of what they hold. */
function SheetRows({
  current,
  counts,
  onOpen,
}: {
  current: PlaceId | null;
  counts: Partial<Record<PlaceId, { count: number; tone: 'ink' | 'warn' | 'bad' }>>;
  onOpen: (place: PlaceId) => void;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const words = placeWords(rawLocale);
  const lists = usePlaceLists();
  return (
    <>
      {sheetPlaces(lists.shown).map((place) => {
        const badge = counts[place];
        const count = badge?.count ?? 0;
        const Icon = PLACE_ICONS[place];
        // Servers and Connections carry the worst mark of what they hold, and say it.
        const list = place === 'servers' || place === 'connections' ? place : null;
        const tone = list ? lists.tone[list] : null;
        return (
          <PlaceRow
            key={place}
            label={
              list
                ? placeSpoken(list, tone, rawLocale)
                : placeLabel(place, count, badge?.tone === 'bad', rawLocale)
            }
            title={words[place]}
            selected={place === current}
            leading={<Icon size={20} color={theme.colors.ink2} strokeWidth={1.75} />}
            count={count}
            tone={badge?.tone ?? 'ink'}
            mark={tone ? TONE_LEVEL[tone] : null}
            onPress={() => onOpen(place)}
          />
        );
      })}
    </>
  );
}

/** A list place's mark by its worst tone: the red ring for something not working, the amber dot for a look. */
const TONE_LEVEL: Record<'bad' | 'warn', StatusLevel> = { bad: 'notWorking', warn: 'needsLook' };

/**
 * A row of the sheet: the icon, the name (wrapping at large text, the row growing), a count or a status mark at the
 * end (decorative: the row's name says it).
 */
function PlaceRow({
  title,
  label,
  leading,
  selected = false,
  count = 0,
  tone = 'ink',
  mark = null,
  onPress,
}: {
  title: string;
  label: string;
  leading: ReactNode;
  selected?: boolean;
  count?: number;
  tone?: 'ink' | 'warn' | 'bad';
  mark?: StatusLevel | null;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={{
        minHeight: SHELL_TARGET,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: selected ? theme.colors.sel : undefined,
      }}
    >
      <View style={{ width: 22, alignItems: 'center' }}>{leading}</View>
      <Text size={15} weight={selected ? 600 : 400} style={{ flex: 1 }}>
        {title}
      </Text>
      {count > 0 ? <CountPill count={count} tone={tone} /> : null}
      {mark ? <StatusMark level={mark} /> : null}
    </Touchable>
  );
}

/** A count in the tokens' colours: `btnfg` on `ink` for unread, on `warn` or `bad` for the Inbox. Decorative. */
function CountPill({ count, tone }: { count: number; tone: 'ink' | 'warn' | 'bad' }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        // It grows with the text rather than cutting the number off.
        minWidth: 22,
        minHeight: 22,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors[tone],
      }}
    >
      {/* The count is said in the row's name; at large text it stays a pill beside the word. */}
      <Text
        size={11}
        weight={500}
        mono
        color={theme.colors.btnfg}
        maxFontSizeMultiplier={1.3}
        // The font's own line box: a set line height grows past the capped text at the largest sizes.
        style={{ lineHeight: undefined }}
      >
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}
