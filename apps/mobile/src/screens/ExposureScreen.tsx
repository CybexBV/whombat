/**
 * Open to the internet on the phone (Whombat internet-exposure.md; the web's `/internet`): the openings the box reads
 * from its proxies, tunnels and routers, worth a look and new first, each in the box's own words with This is meant
 * (Undo in the toast), Ask the assistant, the thing it leads to and where to change it; then where Whombat looked and
 * what it couldn't see there. The same reads and words as the web (`useExposure`, `exposureText`).
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { exposureAskSubject, exposureText, type StatusLevel } from '@whombat/client';
import { useExposure, useExposureMeant, useStartChat } from '@whombat/client/react';
import type { ExposureOpening, ExposureSource, ExposureSourceState } from '@whombat/core';
import { useMemo, useState } from 'react';
import { Linking, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { startedChatRoute } from '../data/chatRoom';
import { quietNote } from '../data/quiet';
import { showToast } from '../data/toast';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { backWordUnder } from '../navigation/backWord';
import { openHref } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ToneBadge } from '../ui/assistant';
import { BackBar, Screen } from '../ui/headers';
import { ExternalLink, Globe } from '../ui/icons';
import { Button, ErrorState, QuietText, Section, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { StatusMark } from '../ui/statusMark';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'Internet'>;

/** How each place's read shows: read in full says nothing, the rest a mark beside its words. */
const SOURCE_LEVEL: Record<ExposureSourceState, StatusLevel> = {
  read: 'connected',
  partly: 'learning',
  unread: 'needsLook',
  missing: 'learning',
};

export function ExposureScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const { slug } = useBurrowBase();
  const { rawLocale } = useI18n();
  const T = useMemo(() => exposureText(rawLocale), [rawLocale]);
  const agent = useAgentWords();
  const { supported, data, isPending, isError, refetch } = useExposure(slug);
  const meant = useExposureMeant(slug, T, (message, o) => {
    if (!message) return;
    quietNote((text, options) => showToast(text, { ...options, locale: rawLocale }))(message, o);
  });
  const start = useStartChat(slug);
  const [refreshing, setRefreshing] = useState(false);

  const back = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('ServersPlace'));
  const ask = (o: ExposureOpening) => {
    start
      .mutateAsync({ text: o.ask, subject: exposureAskSubject(o) })
      .then((result) => {
        if (result.status !== 'ok') return showToast(T.askFailed, { locale: rawLocale });
        const to = startedChatRoute(result.data, T.title);
        if (to.name === 'Thread') navigation.navigate('Thread', to.params);
        else navigation.navigate('Chat', to.params);
      })
      .catch(() => showToast(T.askFailed, { locale: rawLocale }));
  };

  return (
    <Screen>
      <BackBar
        label={route.params?.back ?? backWordUnder(navigation.getState(), route.key, rawLocale)}
        onPress={back}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomRoom + 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void refetch().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, paddingTop: 6 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              backgroundColor: theme.colors.sf2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Globe size={24} color={theme.colors.ink2} strokeWidth={1.75} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text size={22} weight={700} tracking={-0.01} accessibilityRole="header">
              {T.title}
            </Text>
            {data ? (
              <Text size={13.5} lh={1.4} color={theme.colors.mut} style={{ marginTop: 2 }}>
                {data.summary}
              </Text>
            ) : null}
          </View>
        </View>
        {!supported ? (
          <QuietText style={{ paddingHorizontal: 16 }}>{T.older}</QuietText>
        ) : isError && !data ? (
          <ErrorState text={T.failed} onRetry={() => void refetch()} />
        ) : isPending || !data ? (
          <SkeletonRows count={4} label={T.loading} />
        ) : (
          <>
            {data.openings.length ? (
              <Section title={T.openings}>
                {data.openings.map((o, i) => (
                  <Opening
                    key={o.id}
                    opening={o}
                    first={i === 0}
                    T={T}
                    askLabel={agent.ask}
                    busy={meant.busy(o.id)}
                    onMeant={(value) => meant.set(o, value)}
                    onAsk={() => ask(o)}
                    onOpen={(href) => openHref(href)}
                  />
                ))}
                <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
                  <Text size={13} lh={1.45} color={theme.colors.mut}>
                    {data.note}
                  </Text>
                </View>
              </Section>
            ) : (
              <Section>
                <View style={{ padding: 16, gap: 6 }}>
                  <Text size={15} weight={600} lh={1.4}>
                    {data.summary}
                  </Text>
                  <Text size={13.5} lh={1.45} color={theme.colors.mut}>
                    {data.note}
                  </Text>
                </View>
              </Section>
            )}
            {data.sources.length ? (
              <Section title={T.places}>
                {data.sources.map((s, i) => (
                  <SourceRow
                    key={s.thing ?? s.name}
                    source={s}
                    first={i === 0}
                    onOpen={(href) => openHref(href)}
                  />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Opening({
  opening: o,
  first,
  T,
  askLabel,
  busy,
  onMeant,
  onAsk,
  onOpen,
}: {
  opening: ExposureOpening;
  first: boolean;
  T: ReturnType<typeof exposureText>;
  askLabel: string;
  busy: boolean;
  onMeant: (meant: boolean) => void;
  onAsk: () => void;
  onOpen: (href: string) => void;
}) {
  const theme = useTheme();
  // Meant is asked only where Whombat points something out: what is new or worth a look.
  const canMean = !o.meant && (o.isNew || !!o.risk);
  return (
    <View
      style={{
        padding: 16,
        gap: 4,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Text size={15} weight={600} lh={1.35} style={{ flexShrink: 1 }}>
          {o.title}
        </Text>
        {o.isNew ? <ToneBadge text={T.isNew} tone="warn" /> : null}
        {o.meant ? <ToneBadge text={T.meant} tone="mut" /> : null}
      </View>
      <Text size={13.5} lh={1.4} color={theme.colors.mut}>
        {`${o.via} · ${o.protection.words}`}
      </Text>
      {o.risk ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 2 }}>
          <StatusMark level="needsLook" />
          <Text size={13.5} lh={1.4} color={theme.colors.warnText} style={{ flexShrink: 1 }}>
            <Text size={13.5} weight={600} color={theme.colors.warnText}>
              {`${T.looks}: `}
            </Text>
            {o.risk.words}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {canMean ? (
          <Button label={T.thisIsMeant} variant="secondary" busy={busy} onPress={() => onMeant(true)} />
        ) : o.meant ? (
          <Button label={T.pointOut} variant="quiet" busy={busy} onPress={() => onMeant(false)} />
        ) : null}
        <Button label={askLabel} variant="quiet" onPress={onAsk} />
      </View>
      {o.leadsTo || o.manage ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 }}>
          {o.leadsTo ? (
            <LinkText label={T.open(o.leadsTo.name)} onPress={() => o.leadsTo && onOpen(o.leadsTo.href)} />
          ) : null}
          {o.manage ? (
            <LinkText
              label={o.manage.label}
              external
              onPress={() => o.manage && void Linking.openURL(o.manage.url).catch(() => {})}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A link in the brand's colour, 44 tall to the finger; `external` leaves the app. */
function LinkText({ label, onPress, external }: { label: string; onPress: () => void; external?: boolean }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      accessibilityRole="link"
      accessibilityLabel={label}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Text size={14} color={theme.colors.brand}>
        {label}
      </Text>
      {external ? <ExternalLink size={13} color={theme.colors.brand} /> : null}
    </Touchable>
  );
}

function SourceRow({
  source: s,
  first,
  onOpen,
}: {
  source: ExposureSource;
  first: boolean;
  onOpen: (href: string) => void;
}) {
  const theme = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ width: 14, height: 21, alignItems: 'center', justifyContent: 'center' }}>
        <StatusMark level={SOURCE_LEVEL[s.state]} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={14.5} weight={600} lh={1.4}>
          {s.name}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut}>
          {s.words}
        </Text>
      </View>
    </View>
  );
  const frame = {
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: theme.colors.line,
  };
  const href = s.href;
  if (!href) return <View style={frame}>{body}</View>;
  return (
    <Touchable
      onPress={() => onOpen(href)}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={`${s.name}, ${s.words}`}
      style={frame}
    >
      {body}
    </Touchable>
  );
}
