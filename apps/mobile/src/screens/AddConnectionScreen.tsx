/**
 * Add a connection on Android (connections-redesign-android.md AP-1173…AP-1176), opened from the Connections screen's
 * button: every service offered here, found with a search field (“Search 31 services”: any word, in any order, in the
 * name, description or category) and category chips (All, then each category with an entry, the Inbox's chips in a row
 * that scrolls sideways), listed by category as compact rows — logo, name, one line of description, a “Connected” tag
 * when you have a connection of it or “Set up” when it must be set up first, ›. A row opens the entry's Connect
 * {Name}, or an account's own screen (phone-connect.md PC-01, PC-02, AP-2902): before, it opened the web page, which the
 * managed app caught and turned back into Settings → Connections. The footer offers the Custom entries: “Not in the
 * list? Connect any MCP server or any HTTP API.” Found on your network comes first (PC-08, AP-2913).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import {
  type AddCategory,
  type AvailableRow,
  addConnectionChips,
  addConnectionFooter,
  addConnectionGroups,
  addConnectionText,
  addNoMatch,
  addSearchPlaceholder,
  type ConnectionOpens,
  connectionsText,
} from '../data/connections';
import { useConnections } from '../data/useConnections';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import { BackBar, Screen } from '../ui/headers';
import { Search, X } from '../ui/icons';
import { ListRow, RowChevron } from '../ui/ListRow';
import { CardNote, Chip, Section, SkeletonRows } from '../ui/primitives';
import { StatusPill } from '../ui/StatusPill';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';
import { FoundOnNetwork } from './connect/FoundOnNetwork';

type Props = NativeStackScreenProps<RootStackParamList, 'AddConnection'>;

export function AddConnectionScreen({ navigation }: Props) {
  const { rawLocale } = useI18n();
  const addConnectionTextHere = addConnectionText(rawLocale);
  const connectionsTextHere = connectionsText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrow();
  const { catalog, offered, settled, refetch } = useConnections();
  /** What a row opens (AP-2902): Connect {Name}, the account's own screen, or Add a server (Find My without a Mac). */
  const open = (opens: ConnectionOpens | null) => {
    if (!opens) return undefined;
    if (opens.screen === 'AddServer')
      return () => navigation.navigate('AddServer', { back: addConnectionTextHere.title });
    return () =>
      opens.screen === 'Connect'
        ? navigation.navigate('Connect', { catalogId: opens.catalogId, back: addConnectionTextHere.title })
        : navigation.navigate('ConnectAccount', { page: opens.page, back: addConnectionTextHere.title });
  };
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<AddCategory>('all');
  const chips = useMemo(() => addConnectionChips(offered), [offered]);
  // A chip whose category went (its entries turned off since) falls back to All.
  const category = chips.some((c) => c.value === picked) ? picked : 'all';
  const groups = useMemo(() => addConnectionGroups(offered, category, q), [offered, category, q]);
  const footer = addConnectionFooter(offered);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Connections'));
  const placeholder = addSearchPlaceholder(offered.length);
  // The entries' statuses say what's turned off here, the accounts whether Email (IMAP) is offered; until both answer
  // (or fail) the list would change under a finger.
  const ready = settled;

  return (
    <Screen>
      <BackBar label={connectionsTextHere.title} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={catalog.isRefetching}
            onRefresh={refetch}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 12 }}>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {addConnectionTextHere.title}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 16 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 12,
              paddingRight: 4,
              minHeight: 44,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.line2,
              backgroundColor: theme.colors.sf,
            }}
          >
            <Search size={16} color={theme.colors.mut} strokeWidth={1.75} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={placeholder}
              placeholderTextColor={theme.colors.mut}
              accessibilityLabel={placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              cursorColor={theme.colors.ink}
              selectionColor={theme.colors.brand}
              style={{
                flex: 1,
                minHeight: 44,
                color: theme.colors.ink,
                ...textMetrics({ size: 15 }),
                includeFontPadding: false,
              }}
            />
            {q ? (
              <Touchable
                onPress={() => setQ('')}
                accessibilityLabel={tMobile('screens.clear-search')}
                ringRadius={16}
                hitSlop={hitSlopFor(34)}
                style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={16} color={theme.colors.mut} strokeWidth={2} />
              </Touchable>
            ) : null}
          </View>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          accessibilityRole="tablist"
          // The chips' 7dp hit slop stays inside the row.
          contentContainerStyle={{
            gap: 6,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 14 + bottomRoom,
          }}
        >
          {chips.map((c) => (
            <Chip
              key={c.value}
              label={c.label}
              active={category === c.value}
              onPress={() => setPicked(c.value)}
            />
          ))}
        </ScrollView>

        <FoundOnNetwork
          burrow={slug}
          query={q}
          onConnect={(row) =>
            // A server to add (connect-in-chat.md): Add a server with its address filled in.
            row.action === 'server' && row.serverAddress
              ? navigation.navigate('AddServer', {
                  address: row.serverAddress,
                  back: addConnectionTextHere.title,
                })
              : navigation.navigate('Connect', {
                  catalogId: row.catalogId,
                  url: row.url,
                  back: addConnectionTextHere.title,
                })
          }
        />
        {!ready ? (
          <SkeletonRows count={6} avatarSize={40} lines={2} label={addConnectionTextHere.loading} />
        ) : groups.length === 0 ? (
          q.trim() ? (
            <Section>
              <CardNote>{addNoMatch(q)}</CardNote>
            </Section>
          ) : null
        ) : (
          groups.map((g) => (
            <Section key={g.category} title={g.title}>
              {g.rows.map((r) => (
                <AddRow key={r.id} row={r} onPress={open(r.opens)} />
              ))}
            </Section>
          ))
        )}
        {ready ? (
          <AddFooter mcp={open(footer.mcp?.opens ?? null)} api={open(footer.api?.opens ?? null)} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** An entry's compact row (AP-1173): logo, name, one line of description, its tag and › when it opens a screen. */
function AddRow({ row, onPress }: { row: AvailableRow; onPress: (() => void) | undefined }) {
  const theme = useTheme();
  return (
    <ListRow
      leading={<ConnectionLogo logo={row.logo} />}
      title={row.title}
      trailing={
        row.tag || onPress ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {row.tag ? <StatusPill text={row.tag.text} tone={row.tag.tone} /> : null}
            {onPress ? <RowChevron /> : null}
          </View>
        ) : null
      }
      onPress={onPress}
      accessibilityLabel={row.accessibilityLabel}
    >
      <Text size={13.5} color={theme.colors.ink2} numberOfLines={1}>
        {row.description}
      </Text>
      {/* Why it can't be connected yet (“Needs a secure address”); “not set up” already shows as its tag. */}
      {row.note && !row.tag ? (
        <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
          {row.note}
        </Text>
      ) : null}
    </ListRow>
  );
}

/**
 * “Not in the list? Connect any MCP server or any HTTP API.” (AP-1175), centred and muted, each link opening its Custom
 * entry's Connect {Name} (AP-2902); a link whose entry isn't offered is left out, and with neither the line goes.
 * The words wrap as pieces, so a link never breaks across lines; each link is its own TalkBack stop (“Connect any MCP
 * server”, a link).
 */
function AddFooter({ mcp, api }: { mcp: (() => void) | undefined; api: (() => void) | undefined }) {
  const { rawLocale } = useI18n();
  const addConnectionTextHere = addConnectionText(rawLocale);

  const theme = useTheme();
  if (!mcp && !api) return null;
  // “Connect” is in each link's TalkBack label instead.
  const words = (text: string, hidden = false) => (
    <Text
      size={13.5}
      lh={1.45}
      color={theme.colors.mut}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no' : 'auto'}
    >
      {text}
    </Text>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'baseline',
        columnGap: 4,
        rowGap: 2,
        paddingHorizontal: 22,
        paddingTop: 6,
      }}
    >
      {words(addConnectionTextHere.footer)}
      {words(addConnectionTextHere.connect, true)}
      {mcp ? <FooterLink label={addConnectionTextHere.mcp} onPress={mcp} last={!api} /> : null}
      {mcp && api ? words(addConnectionTextHere.or) : null}
      {api ? <FooterLink label={addConnectionTextHere.api} onPress={api} last /> : null}
    </View>
  );
}

/** A link in the footer: underlined like the app's other inline links, padded to 44dp; the sentence's full stop after the last. */
function FooterLink({ label, onPress, last }: { label: string; onPress: () => void; last: boolean }) {
  const { rawLocale } = useI18n();
  const addConnectionTextHere = addConnectionText(rawLocale);

  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      <Touchable
        accessibilityRole="link"
        accessibilityLabel={`${addConnectionTextHere.connect} ${label}`}
        feedback="fade"
        hitSlop={{ top: 13, bottom: 13, left: 6, right: 6 }}
        onPress={onPress}
      >
        <Text
          size={13.5}
          lh={1.45}
          weight={500}
          color={theme.colors.ink2}
          style={{ textDecorationLine: 'underline', textDecorationColor: theme.colors.line2 }}
        >
          {label}
        </Text>
      </Touchable>
      {last ? (
        <Text
          size={13.5}
          lh={1.45}
          color={theme.colors.mut}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          .
        </Text>
      ) : null}
    </View>
  );
}
