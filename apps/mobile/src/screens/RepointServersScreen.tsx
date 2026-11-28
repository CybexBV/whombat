/**
 * Point them here on the phone (Whombat backup-file.md BF-15, BF-16; contracts 0.117 CT-910…CT-914; app
 * backup-file.md AP-4421): the screen BF-16's Needs you item opens (`/things/servers?repoint=1` →
 * `whombat://servers/repoint`). It says the address changed and which servers haven't found it; Point them here signs in
 * to each with your Vault key and points its agent here, then each server's way there as Add a server's job
 * steps: Pointed here, or Needs a password / Didn't work with “Point it here”, which opens Add a server filled in with its
 * address. Leave them goes back and changes nothing. On a Whombat without `hosts.repoint` it says it needs an update.
 * The state and the words are the web's (`@whombat/client/hosts`: `useRepointServers`, `repointView`).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { type RepointRow, repointRowLabel, repointText } from '@whombat/client/hosts';
import { useHostsLive, useRepointServers } from '@whombat/client/hosts/react';
import { hostRepointWords } from '@whombat/core';
import type { ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase } from '../data/BurrowProvider';
import { useI18n, useMobileT } from '../i18n';
import { backWordUnder } from '../navigation/backWord';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { Check, X } from '../ui/icons';
import { bottomPadding } from '../ui/insets';
import { Button, SkeletonRows } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'RepointServers'>;

export function RepointServersScreen({ route, navigation }: Props) {
  const { slug, currentBootstrap } = useBurrowBase();
  const { rawLocale } = useI18n();
  useHostsLive(currentBootstrap().burrow.id);
  const back = route.params?.back ?? backWordUnder(navigation.getState(), route.key, rawLocale);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <Repoint
        slug={slug}
        onBack={goBack}
        onAddServer={(address, title) =>
          navigation.navigate('AddServer', { ...(address ? { address } : {}), back: title })
        }
      />
    </Screen>
  );
}

function Repoint({
  slug,
  onBack,
  onAddServer,
}: {
  slug: string;
  onBack: () => void;
  /** “Point it here”: Add a server filled in; `title` names this screen on its back bar. */
  onAddServer: (address: string, title: string) => void;
}) {
  const { rawLocale } = useI18n();
  const repointTextHere = repointText(rawLocale);
  const hostRepointWordsHere = hostRepointWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const repoint = useRepointServers(slug);
  const { view } = repoint;
  return (
    <>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <Title>{view.title}</Title>
        {view.step === 'loading' && !repoint.error ? (
          <SkeletonRows count={3} lines={2} label={tMobile('managed.loading')} />
        ) : (
          <>
            {view.lead ? (
              <Text size={15} lh={1.5} color={theme.colors.ink2}>
                {view.lead}
              </Text>
            ) : null}
            {view.rows.length ? (
              <View accessibilityLiveRegion="polite">
                {view.rows.map((row, i) => (
                  <ServerRow
                    key={row.id}
                    row={row}
                    first={i === 0}
                    onAddServer={(address) => onAddServer(address, view.title)}
                  />
                ))}
              </View>
            ) : null}
            {view.outcome ? (
              <Text size={15} lh={1.5} weight={500} accessibilityLiveRegion="polite">
                {view.outcome}
              </Text>
            ) : null}
          </>
        )}
        {repoint.error ? (
          <Text size={15} lh={1.5} weight={500} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {repoint.error}
          </Text>
        ) : null}
      </ScrollView>
      <Footer bottomInset={insets.bottom}>
        {view.step === 'ask' ? (
          <>
            <Button
              label={view.title}
              size="lg"
              busy={repoint.starting}
              onPress={() => void repoint.start()}
            />
            <Button label={hostRepointWordsHere.leaveThem} size="lg" variant="secondary" onPress={onBack} />
          </>
        ) : view.step === 'running' ? (
          <Button label={repointTextHere.hide} size="lg" variant="secondary" onPress={onBack} />
        ) : (
          <Button label={repointTextHere.done} size="lg" onPress={onBack} />
        )}
      </Footer>
    </>
  );
}

function Title({ children }: { children: string }) {
  return (
    <Text size={28} weight={700} tracking={-0.02} accessibilityRole="header">
      {children}
    </Text>
  );
}

function Footer({ bottomInset, children }: { bottomInset: number; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 10,
        paddingTop: 10,
        paddingHorizontal: 16,
        paddingBottom: bottomPadding(36, bottomInset, 12),
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        backgroundColor: theme.colors.bg,
      }}
    >
      {children}
    </View>
  );
}

/**
 * A server as Add a server's job step: its mark (✓ pointed, a spinner while pointing, an empty ring before, an amber ring
 * for a password, ✗ where it didn't work), its name, address and state, and “Point it here” where it needs one.
 */
function ServerRow({
  row,
  first,
  onAddServer,
}: {
  row: RepointRow;
  first: boolean;
  onAddServer: (address: string) => void;
}) {
  const { rawLocale } = useI18n();
  const hostRepointWordsHere = hostRepointWords(rawLocale);

  const theme = useTheme();
  const mark = (() => {
    switch (row.state) {
      case 'pointed':
        return (
          <View style={[MARK, { backgroundColor: theme.colors.ok }]}>
            <Check size={14} color={theme.colors.bg} strokeWidth={3} />
          </View>
        );
      case 'failed':
        return (
          <View style={[MARK, { backgroundColor: theme.colors.bad }]}>
            <X size={14} color={theme.colors.bg} strokeWidth={3} />
          </View>
        );
      case 'pointing':
        return (
          <View style={MARK}>
            <ActivityIndicator size="small" color={theme.colors.brand} />
          </View>
        );
      case 'no_key':
        return <View style={[MARK, { borderWidth: 1.5, borderColor: theme.colors.warn }]} />;
      default:
        return <View style={[MARK, { borderWidth: 1.5, borderColor: theme.colors.line2 }]} />;
    }
  })();
  const sub = [row.address, row.stateText].filter(Boolean).join(' · ');
  const add = row.addServer;
  return (
    <View
      style={{
        gap: 10,
        paddingVertical: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityLabel={repointRowLabel(row)}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}
      >
        {/* Keyed by state: a view that gains a background after the spinner otherwise loses its round corners. */}
        <View key={row.state ?? 'none'}>{mark}</View>
        <View style={{ flex: 1, minWidth: 0, gap: 3, paddingTop: 1 }}>
          <Text size={15.5} lh={1.35}>
            {row.name}
          </Text>
          {sub ? (
            <Text size={13} lh={1.4} color={theme.colors.mut}>
              {sub}
            </Text>
          ) : null}
          {row.line ? (
            <Text size={13} lh={1.4} color={theme.colors.mut}>
              {row.line}
            </Text>
          ) : null}
        </View>
      </View>
      {add ? (
        <Button
          label={hostRepointWordsHere.pointItHere}
          variant="secondary"
          accessibilityLabel={`${hostRepointWordsHere.pointItHere}: ${row.name}`}
          style={{ marginLeft: 34 }}
          onPress={() => onAddServer(add.address)}
        />
      ) : null}
    </View>
  );
}

const MARK = {
  width: 22,
  height: 22,
  borderRadius: 11,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
