/**
 * The Settings tab (the final design, docs/design-handoff/council-ui-2026-11/16-final/settings/,
 * docs/decisions/final-settings-vault-files-usage.md; settings-tab-android.md AP-2620…AP-2627), the same on iPhone and
 * Android: the title and one line, a newer app on top (`UpdateCard`), **Often used** — Notifications on a Whombat, the
 * theme (Light · Dark · Auto, saved to the account) and Moving faces (this phone's own) — then **All settings**, the groups in the web's order:
 * You (your face and what You holds), the assistant by its name (its face, what it runs on or its AI sign-in in
 * trouble), Connections (what needs you, else how many are connected), This Whombat, News and weather (where the
 * Whombat is and the news it reads, where it answers them), Screens where it has them, and
 * Advanced (`settingsRows`), each with one line on how it is doing and a chevron. This Whombat's state is read here:
 * while it loads or can't be read a card in Often used says so and every row keeps working. VERSION under it, then
 * Sign out and Switch Whombat (none in the demo). Pulling the page down reads it again and asks for a newer app.
 */

import { useIsFocused } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import {
  agentFaceOf,
  agentGroupParts,
  hasLooksAhead,
  settingsGroupText,
  settingsHomeRows,
  settingsHomeText,
} from '@whombat/client';
import { useSessionProtocol } from '@whombat/client/react';
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { PersonAvatar, WhombatAvatar } from '../avatars/Avatars';
import { useBurrow } from '../data/BurrowProvider';
import { useTheAgentHere } from '../data/useAgent';
import { usePrompts } from '../data/usePrompts';
import { useI18n } from '../i18n';
import { useManaged } from '../managed/context';
import { managedCopy } from '../managed/copy';
import { useUpdateCheck } from '../managed/useAppUpdate';
import { type AppNavigation, useAppNavigation } from '../navigation/hooks';
import { useBeside } from '../navigation/panes';
import { type ThemePreference, themePreferences } from '../theme/preference';
import { Text } from '../theme/Text';
import { useTheme, useThemeContext } from '../theme/theme';
import { Screen } from '../ui/headers';
import {
  Bell,
  Box,
  Contrast,
  type LucideIcon,
  Monitor,
  Moon,
  Newspaper,
  Plug,
  Settings as SettingsIcon,
  SlidersVertical,
  Smartphone,
  Sun,
} from '../ui/icons';
import { PLACE_SIDE, PlaceCard, PlaceRow, PlaceSection, PlaceState } from '../ui/place';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { useBottomRoom } from '../ui/screenBottom';
import { TabTop } from '../ui/topRow';
import { useSetTheme } from './accountTheme';
import { FaceMotionRow } from './FaceMotionRow';
import { youLine, youPartsHere } from './groups';
import { type SettingsRowKey, type SettingsRowView, settingsText } from './list';
import { UpdateCard } from './UpdateCard';
import { useApplianceLine, useSettingsRows } from './useSettingsFacts';
import { VersionCard } from './VersionCard';
import { WhombatsSheet } from './WhombatsSheet';

/** The rows' leading slot: an icon, or the assistant's face, a little wider. */
const LEADING = { width: 24, alignItems: 'center', justifyContent: 'center' } as const;

/** The rows' icons; the assistant's row wears its face instead. */
const ICONS: Record<Exclude<SettingsRowKey, 'agent'>, LucideIcon> = {
  connections: Plug,
  appliance: Box,
  news: Newspaper,
  screen: Monitor,
  advanced: SlidersVertical,
};

/** The pages a row opens, to mark the row while the page beside the list shows one of them. */
const ROW_ROUTES: Record<SettingsRowKey, readonly string[]> = {
  agent: ['SettingsAgent'],
  connections: ['Connections'],
  appliance: ['Whombat', 'SettingsWhombat', 'WhombatAbout'],
  news: ['SettingsNews'],
  screen: ['SettingsDesk'],
  advanced: ['SettingsAdvanced'],
};

/** Where a row goes (AP-2625): its group's page, or the page its line is about (“Update ready”: About). */
function openRow(navigation: AppNavigation, row: SettingsRowView, managed: boolean) {
  const key = row.key;
  switch (key) {
    case 'agent':
      return navigation.navigate('SettingsAgent');
    case 'connections':
      return navigation.navigate('Connections');
    case 'appliance':
      // A Whombat's Overview is This Whombat (AP-2626); the demo world's is its own page. An update that waits for
      // the owner opens About, where Update now is.
      if (managed && row.opens === 'about') return navigation.navigate('WhombatAbout');
      return managed ? navigation.navigate('Whombat') : navigation.navigate('SettingsWhombat');
    case 'news':
      return navigation.navigate('SettingsNews');
    case 'screen':
      return navigation.navigate('SettingsDesk');
    case 'advanced':
      return navigation.navigate('SettingsAdvanced');
  }
}

export function SettingsScreen() {
  const { rawLocale, tClient } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const settingsHomeTextHere = settingsHomeText(rawLocale);

  const theme = useTheme();
  const navigation = useAppNavigation();
  const { bootstrap, mode } = useBurrow();
  const managed = useManaged();
  const rows = useSettingsRows();
  const beside = useBeside();
  const me = bootstrap.me;
  const agent = useTheAgentHere();
  const agentName = agent?.name ?? '';
  const prompts = usePrompts();
  const parts = youPartsHere({ mode, prompts: prompts.shown });
  const you = youLine(parts, rawLocale);
  const notifications = parts.includes('notifications');
  const applianceLine = useApplianceLine();
  // The home's names and, where a row has no news of its own, what it holds.
  const agentParts = agentGroupParts({ looksAhead: hasLooksAhead(useSessionProtocol()) });
  const home = Object.fromEntries(
    settingsHomeRows(agentName, parts, agentParts, rawLocale).map((r) => [r.key, r]),
  ) as Record<string, { title: string; line: string }>;
  const homeRows = { you: home.you?.title ?? settingsGroupText(rawLocale).groups('').you };
  const homeLine = (key: SettingsRowKey) => home[key === 'screen' ? 'screens' : key]?.line ?? null;
  const [switching, setSwitching] = useState(false);

  // Back on the tab: This Whombat's line is read again (a backup set up on its Overview).
  const focused = useIsFocused();
  const qc = useQueryClient();
  useEffect(() => {
    if (focused) void qc.invalidateQueries({ queryKey: ['settings'] });
  }, [focused, qc]);
  const updateCheck = useUpdateCheck(managed?.updates, focused);
  // On an iPhone the list runs on under iOS's tab bar and ends above it.
  const bottomRoom = useBottomRoom();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([qc.invalidateQueries({ queryKey: ['settings'] }), updateCheck?.checkNow()]).catch(
      () => {},
    );
    setRefreshing(false);
  };

  return (
    <Screen>
      <TabTop title={settingsHomeTextHere.title} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: PLACE_SIDE,
          paddingTop: 6,
          paddingBottom: 24 + bottomRoom,
          gap: 22,
        }}
        showsVerticalScrollIndicator={false}
        // “Update available” appearing on top after “Check” at the bottom keeps the VERSION card where it was (AP-2972).
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <Text size={15} lh={1.5} color={theme.colors.ink2} style={{ paddingTop: 8 }}>
          {settingsHomeTextHere.subtitle(agentName)}
        </Text>
        <UpdateCard />

        <PlaceSection title={settingsHomeTextHere.oftenUsed}>
          <PlaceCard>
            {notifications ? (
              <PlaceRow
                first
                icon={Bell}
                title={settingsHomeTextHere.notifications.title}
                line={settingsHomeTextHere.notifications.line}
                selected={beside?.name === 'SettingsNotifications'}
                onPress={() => navigation.navigate('SettingsNotifications')}
              />
            ) : null}
            <ThemeRow first={!notifications} />
            <FaceMotionRow />
          </PlaceCard>
          {/* This Whombat's state is read here; while it loads or can't be read, every row still works. */}
          {managed && applianceLine === null ? (
            <PlaceState
              kind="failed"
              icon={SettingsIcon}
              title={settingsHomeTextHere.failedTitle}
              line={settingsHomeTextHere.failedLine}
              retryLabel={settingsHomeTextHere.retry}
              onRetry={() => void qc.invalidateQueries({ queryKey: ['settings'] })}
            />
          ) : managed && applianceLine === undefined ? (
            <PlaceState kind="loading" icon={SettingsIcon} title={settingsHomeTextHere.loading} />
          ) : null}
        </PlaceSection>

        <PlaceSection title={settingsHomeTextHere.allSettings}>
          <PlaceCard>
            <PlaceRow
              first
              mark={<PersonAvatar person={me} size={28} />}
              title={homeRows.you}
              line={you}
              label={`${homeRows.you}, ${me.name}, ${you}`}
              selected={beside?.name === 'SettingsProfile'}
              onPress={() => navigation.navigate('SettingsProfile')}
            />
            {rows.map((row) => (
              <PlaceRow
                key={row.key}
                icon={row.key === 'agent' ? undefined : ICONS[row.key]}
                mark={row.key === 'agent' ? <WhombatAvatar face={agentFaceOf(agent)} size={28} /> : undefined}
                title={row.key === 'screen' ? settingsHomeTextHere.screensTitle : row.title}
                line={row.value ?? homeLine(row.key)}
                bad={row.tone === 'bad'}
                warn={row.tone === 'warn'}
                label={row.label}
                selected={!!beside && ROW_ROUTES[row.key].includes(beside.name)}
                onPress={() => openRow(navigation, row, !!managed)}
              />
            ))}
          </PlaceCard>
        </PlaceSection>

        <VersionCard />

        {/* Which Whombat this phone talks to (AP-2627): its sheet lists the organization's Whombats (AP-3084). The demo
            world has nothing to sign out of or switch. */}
        {managed ? (
          <>
            <Button
              label={tClient('managed.appliances.signOut')}
              variant="secondary"
              size="lg"
              onPress={() => managed.signOut()}
            />
            {/* A community box has no organization's list to switch through (AP-5470). */}
            {managed.community ? null : (
              <Button
                label={managedCopyHere.whombat.switch}
                variant="quiet"
                onPress={() => setSwitching(true)}
              />
            )}
          </>
        ) : null}
      </ScrollView>
      {managed ? (
        <WhombatsSheet
          visible={switching}
          current={managed.applianceId}
          whombats={managed.whombats}
          onAll={() => managed.switchAppliance()}
          onClose={() => setSwitching(false)}
        />
      ) : null}
    </Screen>
  );
}

/** Each theme's icon, as the web's menu has them: the sun, the moon, and the phone that Auto follows. */
const THEME_ICONS: Record<ThemePreference, LucideIcon> = { light: Sun, dark: Moon, system: Smartphone };

/**
 * The theme in the list (AP-2622): Light · Dark · Auto, as on the web, one tap, saved to the account. The word stays
 * whole; the switch takes the rest.
 */
function ThemeRow({ first }: { first: boolean }) {
  const { displayLanguage, rawLocale } = useI18n();
  const settingsTextHere = settingsText(rawLocale);
  const options = themePreferences(rawLocale).map((option) => ({
    ...option,
    icon: THEME_ICONS[option.value],
  }));
  const wideLabels = displayLanguage !== 'en';

  const theme = useTheme();
  const { preference } = useThemeContext();
  const setTheme = useSetTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 14,
        minHeight: 64,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={LEADING}>
        <Contrast size={20} color={theme.colors.ink2} />
      </View>
      <Text size={16} weight={600} style={{ flexShrink: 0 }}>
        {settingsTextHere.theme}
      </Text>
      <View
        style={{ flex: 1, minWidth: 180, flexBasis: wideLabels ? 270 : undefined, alignItems: 'flex-end' }}
      >
        <View style={{ width: '100%', maxWidth: wideLabels ? 270 : 216 }}>
          <Segmented
            options={options}
            value={preference}
            onChange={setTheme}
            label={settingsTextHere.theme}
            fit={wideLabels}
          />
        </View>
      </View>
    </View>
  );
}
