/**
 * Settings → Connections on the phone (Whombat docs/decisions/connections-catalog.md CX-70, CX-74; sidebar-tabs.md),
 * what this Whombat is signed in to (connections-redesign-android.md AP-1170…AP-1172): the intro and a primary “Add a
 * connection” that opens its own screen (`AddConnectionScreen`), then NEEDS YOU — a connection whose state isn't fine,
 * its state and detail on one line and “Sign in again” or “Open” — then ACCOUNTS · N and APPS AND SERVICES · N, compact
 * rows: logo, name, one mono line with where it is (and
 * “Look only”; AP-1177), a green dot and › or ↗. Your Google / Microsoft 365 / Email accounts, GitHub and Website
 * feedback are rows like your catalog connections (one kind, one-person-android.md AP-5766). A catalog connection opens
 * its screen; an account its page on a box at session minor 7, else its own screen (phone-connect.md PC-02, AP-2902).
 * Opened from Settings' Connections row (`connections.catalog`, CX-75). The Vault screen's language: mono kicker, 25/700 title, intro, grouped lists.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RefreshControl, ScrollView, View } from 'react-native';
import {
  CONNECTIONS_TEXT,
  type ConnectedRow,
  connectionsOverview,
  type NeedsYouRow,
} from '../data/connections';
import { useConnections } from '../data/useConnections';
import type { RootStackParamList } from '../navigation/routes';
import { SETTINGS_TEXT } from '../settings/list';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import { BackBar, Screen } from '../ui/headers';
import { ListRow, RowChevron } from '../ui/ListRow';
import { Button, CardNote, ErrorState, Section, SkeletonRows, StatusDot, toneColor } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';

type Props = NativeStackScreenProps<RootStackParamList, 'Connections'>;

export function ConnectionsScreen({ navigation }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { list, rows, refetch } = useConnections();
  const { needsYou, accounts, apps, accountsTitle, appsTitle, empty } = connectionsOverview(rows);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  /**
   * What pressing a row does: a catalog connection's screen (1Password's page, where its sync is); an account's page on
   * a box that has them, else its own screen (AP-2902).
   */
  const press = (r: ConnectedRow): (() => void) | undefined => {
    const opens = r.opens;
    if (r.kind === 'catalog' && opens?.screen !== 'Thing')
      return () =>
        navigation.navigate('Connection', {
          connectionId: r.id,
          title: r.title,
          back: CONNECTIONS_TEXT.title,
        });
    if (opens?.screen === 'Thing')
      return () =>
        navigation.navigate('Thing', {
          thingId: opens.thingId,
          title: r.title,
          back: CONNECTIONS_TEXT.title,
        });
    return opens?.screen === 'ConnectAccount'
      ? () => navigation.navigate('ConnectAccount', { page: opens.page, back: CONNECTIONS_TEXT.title })
      : undefined;
  };

  return (
    <Screen>
      <BackBar label={SETTINGS_TEXT.title} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={refetch}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 4 }}>
          <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
            {CONNECTIONS_TEXT.kicker}
          </Text>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {CONNECTIONS_TEXT.title}
          </Text>
          <Text size={14} color={theme.colors.ink2}>
            {CONNECTIONS_TEXT.intro}
          </Text>
          <Button
            label={CONNECTIONS_TEXT.add}
            onPress={() => navigation.navigate('AddConnection')}
            style={{ marginTop: 10 }}
          />
        </View>

        {list.error && !list.data ? (
          <ErrorState text={CONNECTIONS_TEXT.loadFailed} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <SkeletonRows count={3} avatarSize={40} lines={2} label={CONNECTIONS_TEXT.loading} />
        ) : (
          <>
            {needsYou.length > 0 ? (
              <Section title={CONNECTIONS_TEXT.needsYou}>
                {needsYou.map((r) => (
                  <NeedsYouListRow key={r.key} row={r} onPress={press(r)} />
                ))}
              </Section>
            ) : null}
            {accounts.length > 0 ? (
              <Section title={accountsTitle}>
                {accounts.map((r) => (
                  <ConnectedListRow key={r.key} row={r} onPress={press(r)} />
                ))}
              </Section>
            ) : null}
            {apps.length > 0 ? (
              <Section title={appsTitle}>
                {apps.map((r) => (
                  <ConnectedListRow key={r.key} row={r} onPress={press(r)} />
                ))}
              </Section>
            ) : null}
            {empty ? (
              <Section title={CONNECTIONS_TEXT.connected}>
                <CardNote>{CONNECTIONS_TEXT.nothingConnected}</CardNote>
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * A NEEDS YOU row (AP-1171): logo, title, the action word on the right, and the reason line under it — the state in its
 * tone with its dot, then the detail. TalkBack says the row's state, detail and tag, then the action.
 */
function NeedsYouListRow({ row, onPress }: { row: NeedsYouRow; onPress: (() => void) | undefined }) {
  const theme = useTheme();
  const tone = toneColor(theme, row.state.tone);
  return (
    <ListRow
      leading={<ConnectionLogo logo={row.logo} />}
      title={row.title}
      trailing={
        onPress ? (
          <Text size={13} weight={600} color={theme.colors.brand} numberOfLines={1}>
            {row.action}
          </Text>
        ) : null
      }
      onPress={onPress}
      accessibilityLabel={onPress ? `${row.accessibilityLabel}. ${row.action}` : row.accessibilityLabel}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: tone }} />
        <Text size={12} weight={500} mono color={tone} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {row.state.label}
          {row.reason ? (
            <Text size={12} mono color={theme.colors.mut}>
              {` · ${row.reason}`}
            </Text>
          ) : null}
        </Text>
      </View>
    </ListRow>
  );
}

/**
 * A CONNECTED row (AP-1172): logo, title, one meta line and a chevron for its screen. Connected has no mark
 * (phone-refresh-status.md); a row in another state keeps its dot, and the row's label says the state either way.
 */
function ConnectedListRow({ row, onPress }: { row: ConnectedRow; onPress: (() => void) | undefined }) {
  const theme = useTheme();
  return (
    <ListRow
      leading={<ConnectionLogo logo={row.logo} />}
      title={row.title}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {row.state.tone === 'ok' ? null : (
            <StatusDot color={toneColor(theme, row.state.tone)} label={row.state.label} size={7} />
          )}
          {onPress ? <RowChevron /> : null}
        </View>
      }
      onPress={onPress}
      accessibilityLabel={row.accessibilityLabel}
    >
      {row.line ? (
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1}>
          {row.line}
        </Text>
      ) : null}
    </ListRow>
  );
}
