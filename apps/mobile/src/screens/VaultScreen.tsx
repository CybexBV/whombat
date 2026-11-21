/**
 * The Vault on iPhone and Android (docs/decisions/vault.md VT-73; the final design,
 * docs/design-handoff/council-ui-2026-11/16-final/vault/, docs/decisions/final-settings-vault-files-usage.md): the
 * title and one line, “Add to Vault” on a line of its own (AP-718: every template but an SSH key, which is added on the
 * web), your entries in one card — each its lock, name and one line: how its check went and when it was last used, or,
 * only for a failing one, why it isn't working in the Not working colour — opening its entry screen, where a secret is
 * only ever replaced, never shown. Then what the Vault never shows, what saving from chat does where the Whombat does it
 * (VS-08; AP-4040) and the home network list, read-only. Loading, empty and failed reads each have a card of their own.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { VAULT_ROW_TEXT, vaultRowLine } from '@whombat/client';
import { useVault, useVaultNetworks } from '@whombat/client/react';
import { VAULT_COPY } from '@whombat/core/vault';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { PLACE_WORDS } from '../data/places';
import { useAgentWords } from '../data/useAgent';
import { vaultEntryRows, vaultNetworkRows, vaultSavedIntroFor } from '../data/vault';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { Lock } from '../ui/icons';
import { ListRow } from '../ui/ListRow';
import { PLACE_SIDE, PlaceCard, PlaceRow, PlaceState, PlaceTitle } from '../ui/place';
import { PlacesButton } from '../ui/places';
import { Button, CardNote, Section } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { AddToVaultSheet } from './AddToVaultSheet';

type Props = NativeStackScreenProps<RootStackParamList, 'Vault'>;

export function VaultScreen({ navigation, route }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const { now, timeZone } = useViewContext();
  const query = useVault({ params: { burrow: slug } });
  const networks = useVaultNetworks({});
  // The agent by name (less-is-more.md AP-1822).
  const words = useAgentWords();
  const agent = words.Name;
  const savedIntro = vaultSavedIntroFor(words.name, true);
  // Each entry says whether it is on for the agent (`agentOn`, AP-4992): no keys to read.
  const rows = useMemo(
    () =>
      vaultEntryRows(query.data?.entries ?? [], now, timeZone, agent).map((row, i) => {
        const entry = query.data?.entries[i];
        const line = entry
          ? vaultRowLine(entry, { now, timeZone, agent: words.name })
          : { text: row.meta, failing: false };
        return { ...row, line, accessibilityLabel: `${row.name}, ${line.text}. ${row.meta}` };
      }),
    [query.data, now, timeZone, agent, words.name],
  );
  const networkRows = useMemo(() => vaultNetworkRows(networks.data?.networks ?? []), [networks.data]);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const [adding, setAdding] = useState(false);

  return (
    <Screen>
      <BackBar
        label={route.params?.back ?? 'Back'}
        onPress={goBack}
        right={<PlacesButton current="vault" here={PLACE_WORDS.vault} />}
      />
      <AddToVaultSheet
        visible={adding}
        onClose={() => setAdding(false)}
        networks={networks.data?.networks ?? []}
        onAdded={(entry) => {
          setAdding(false);
          navigation.navigate('VaultEntry', { entryId: entry.id, title: entry.name, back: VAULT_COPY.title });
        }}
      />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: PLACE_SIDE, paddingBottom: 28 + bottomRoom, gap: 18 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => {
              void query.refetch();
              void networks.refetch();
            }}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <PlaceTitle title={VAULT_COPY.title} intro={VAULT_ROW_TEXT.intro(words.name)} />
        {/* Add to Vault on a line of its own, so it never collides with the title at large text. */}
        {query.data ? (
          <Button
            label={VAULT_COPY.add}
            size="lg"
            wrap
            disabled={!query.data.canAdd}
            onPress={() => setAdding(true)}
          />
        ) : null}
        {query.error && !query.data ? (
          <PlaceState
            kind="failed"
            icon={Lock}
            title={VAULT_ROW_TEXT.failedTitle}
            line={VAULT_ROW_TEXT.failedLine}
            retryLabel={VAULT_ROW_TEXT.retry}
            onRetry={() => void query.refetch()}
          />
        ) : !query.data ? (
          <PlaceState kind="loading" icon={Lock} title={VAULT_ROW_TEXT.loading} />
        ) : rows.length === 0 ? (
          <PlaceState
            kind="empty"
            icon={Lock}
            title={VAULT_ROW_TEXT.emptyTitle}
            line={VAULT_COPY.noEntries}
          />
        ) : (
          <PlaceCard>
            {rows.map((r, i) => (
              <PlaceRow
                key={r.id}
                first={i === 0}
                icon={Lock}
                title={r.name}
                line={r.line.text}
                bad={r.line.failing}
                label={r.accessibilityLabel}
                onPress={() =>
                  navigation.navigate('VaultEntry', {
                    entryId: r.id,
                    title: r.name,
                    back: VAULT_COPY.title,
                  })
                }
              />
            ))}
          </PlaceCard>
        )}
        <View style={{ gap: 8 }}>
          <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
            {VAULT_ROW_TEXT.closed}
          </Text>
          {/* What saving from chat does, where the Whombat does it (VS-08; AP-4040). */}
          {savedIntro ? (
            <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
              {savedIntro}
            </Text>
          ) : null}
        </View>
        {networks.data ? (
          // The grouped list brings its own 16 of side: the card lines up with the page's.
          <View style={{ marginHorizontal: -16 }}>
            <Section title={VAULT_COPY.homeNetwork}>
              <CardNote>{VAULT_COPY.homeNetworkIntro}</CardNote>
              {networkRows.length === 0 ? (
                <CardNote>{VAULT_COPY.noNetworks}</CardNote>
              ) : (
                networkRows.map((n) => (
                  <ListRow
                    key={n.id}
                    title={n.cidr}
                    titleMono
                    meta={n.ports}
                    body={n.note}
                    accessibilityLabel={n.line}
                  />
                ))
              )}
            </Section>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
