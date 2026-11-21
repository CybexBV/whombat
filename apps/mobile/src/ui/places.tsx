/**
 * Places (docs/decisions/phone-shell-final.md): the button that opens it and the sheet — the platform's own sheet, with
 * Close first, the nine places in the web sidebar's order (`data/places.ts`) with Chat's and the Inbox's counts, then
 * a shortcut to each server and connection with its real logo. It scrolls at large text rather than shrinking a row.
 * Choosing a place closes the sheet and, once it is down, opens the place; closing it puts a screen reader back on the
 * button that opened it.
 */
import { StackActions } from '@react-navigation/native';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { useHomeOverview } from '@whombat/client/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { serverFacts } from '../data/homeServers';
import {
  PLACE_WORDS,
  PLACES,
  PLACES_COPY,
  type PlaceId,
  placeLabel,
  placeRoute,
  placesThings,
  type ServerFacts,
} from '../data/places';
import { useAppNavigation } from '../navigation/hooks';
import { useBadges } from '../navigation/TabBar';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ThingIcon } from './assistant';
import {
  ChartNoAxesColumn,
  Folder,
  Inbox,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Menu,
  MessageCircle,
  Search,
  Settings as SettingsIcon,
  X,
  Zap,
} from './icons';
import { focusRowSoon, registerRowFocus } from './rowFocus';
import { Sheet, useAfterSheet } from './sheet';
import { Touchable } from './Touchable';

/** The smallest target: 44pt on iPhone, 48dp on Android. */
export const SHELL_TARGET = Platform.OS === 'ios' ? 44 : 48;

/** Each place's icon: the tab bar's for the tabs. */
export const PLACE_ICONS: Record<PlaceId, LucideIcon> = {
  search: Search,
  chat: MessageCircle,
  inbox: Inbox,
  overview: LayoutGrid,
  automations: Zap,
  files: Folder,
  vault: Lock,
  usage: ChartNoAxesColumn,
  settings: SettingsIcon,
};

/**
 * The servers as Overview's Servers shows them (their logos, systems and how they are), from the same reads, so
 * nothing is asked again; none where the Whombat runs no hosts service.
 */
export function useServerFacts(): ServerFacts[] {
  const { slug } = useBurrowBase();
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow: slug } } : null, { retry: false });
  return useMemo(() => serverFacts(fleet.data?.servers ?? []), [fleet.data?.servers]);
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
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<View>(null);
  useEffect(() => registerRowFocus(OPENER, ref), []);
  return (
    <>
      <Touchable
        ref={ref}
        onPress={() => setOpen(true)}
        feedback="wash"
        ringRadius={iconOnly ? SHELL_TARGET / 2 : 10}
        accessibilityRole="button"
        accessibilityLabel={PLACES_COPY.open}
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
            {PLACES_COPY.open}
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
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { slug } = useBurrowBase();
  const badges = useBadges();
  const overview = useHomeOverview({ params: { burrow: slug } });
  const servers = useServerFacts();
  const things = useMemo(
    () => placesThings(overview.data?.things, servers),
    [overview.data?.things, servers],
  );
  const after = useAfterSheet();
  const go = after.onDismissed;
  const choose = (run: () => void) => {
    after.later(run);
    onChosen();
  };
  const openPlace = (place: PlaceId) =>
    choose(() => {
      const route = placeRoute(place, here);
      // Back to the tabs, the pages above them closing, on the tab chosen.
      if (route.kind === 'tab') navigation.dispatch(StackActions.popTo('Tabs', { screen: route.tab }));
      else (navigation.navigate as (name: string, params: object) => void)(route.name, route.params);
    });
  const openThing = (id: string, title: string) =>
    choose(() => navigation.navigate('Thing', { thingId: id, title, back: here }));
  const counts: Partial<Record<PlaceId, { count: number; tone: 'ink' | 'warn' | 'bad' }>> = {
    chat: { count: badges.ChatRoom?.count ?? 0, tone: 'ink' },
    inbox: {
      count: badges.NeedsYou?.count ?? 0,
      tone: badges.NeedsYou?.tone === 'bad' ? 'bad' : badges.NeedsYou?.tone === 'warn' ? 'warn' : 'ink',
    },
  };
  return (
    <Sheet visible={visible} onClose={onClose} onDismissed={go} label={PLACES_COPY.title} maxHeight="92%">
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
          {PLACES_COPY.title}
        </Text>
        <Touchable
          onPress={onClose}
          feedback="wash"
          ringRadius={SHELL_TARGET / 2}
          accessibilityRole="button"
          accessibilityLabel={PLACES_COPY.close}
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
        {PLACES.map((place) => {
          const badge = counts[place];
          const count = badge?.count ?? 0;
          const Icon = PLACE_ICONS[place];
          return (
            <PlaceRow
              key={place}
              label={placeLabel(place, count, badge?.tone === 'bad')}
              title={PLACE_WORDS[place]}
              selected={place === current}
              leading={<Icon size={20} color={theme.colors.ink2} strokeWidth={1.75} />}
              count={count}
              tone={badge?.tone ?? 'ink'}
              onPress={() => openPlace(place)}
            />
          );
        })}
        {things.servers.length ? (
          <ThingsSection title={PLACES_COPY.servers}>
            {things.servers.map((t) => (
              <PlaceRow
                key={t.id}
                label={t.label}
                title={t.name}
                mono
                leading={<ThingIcon glyph={t.glyph} mark={t.mark} size={20} />}
                onPress={() => openThing(t.id, t.name)}
              />
            ))}
          </ThingsSection>
        ) : null}
        {things.connections.length ? (
          <ThingsSection title={PLACES_COPY.connections}>
            {things.connections.map((t) => (
              <PlaceRow
                key={t.id}
                label={t.label}
                title={t.name}
                leading={<ThingIcon glyph={t.glyph} mark={t.mark} size={20} />}
                onPress={() => openThing(t.id, t.name)}
              />
            ))}
          </ThingsSection>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function ThingsSection({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, marginTop: 8, paddingTop: 8 }}>
      <Text
        size={12}
        weight={500}
        color={theme.colors.mut}
        accessibilityRole="header"
        style={{ paddingHorizontal: 12, paddingVertical: 6 }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A row of the sheet: icon or logo, the name (wrapping at large text, the row growing), a count at the end. */
function PlaceRow({
  title,
  label,
  leading,
  selected = false,
  mono = false,
  count = 0,
  tone = 'ink',
  onPress,
}: {
  title: string;
  label: string;
  leading: ReactNode;
  selected?: boolean;
  mono?: boolean;
  count?: number;
  tone?: 'ink' | 'warn' | 'bad';
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
      <Text size={15} weight={selected ? 600 : 400} mono={mono} style={{ flex: 1 }}>
        {title}
      </Text>
      {count > 0 ? <CountPill count={count} tone={tone} /> : null}
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
