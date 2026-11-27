/**
 * The audit log (mobile-parity.md MQ-03; the web's Audit log, TODO 13): every action in the burrow, signed by whoever
 * took it, newest first and grouped by day. Everyone / People / Agents, the kind chips with their counts (Vault once
 * the log holds one), “Only Banjo ×”; a row opens to its signed detail — SIGNED BY … EVENT “e-9f18 · signature
 * verified” — with a button to what it was about. Opened from the settings sheet's This Whombat group, from receipts
 * and log links (`routeForLink`), and `whombat://log?who=&open=`; a link's `open` event starts opened. Older pages load
 * with Load more. Export CSV stays on the web (a file download).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuditLogInfinite } from '@whombat/client/react';
import { type AuditEvent, type AuditTone, auditSubtitle, groupAuditByDay } from '@whombat/core';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { PrincipalAvatar } from '../avatars/Avatars';
import {
  type AuditFilters,
  auditActorOptions,
  auditContext,
  auditDetail,
  auditFilters,
  auditKindChips,
  auditRouteParams,
  auditRow,
  auditText,
  auditWhoName,
} from '../data/audit';
import { useBurrow, useNow } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useI18n, useMobileT } from '../i18n';
import { useOpenLink } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { Button, Chip, ErrorState, QuietText, SectionLabel, SkeletonRows, toneColor } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'AuditLog'>;

export function AuditLogScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const auditTextHere = auditText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const agent = useAgentWords();
  const theme = useTheme();
  const { slug, bootstrap, people, timeZone } = useBurrow();
  const now = useNow();
  const openLink = useOpenLink();
  const filters = auditFilters(route.params);
  const query = useAuditLogInfinite({
    params: { burrow: slug },
    query: { actor: filters.actor, kind: filters.kind, ...(filters.who ? { who: filters.who } : {}) },
  });
  // The opened row: the link's event at first, then whichever the person taps.
  const [open, setOpen] = useState<string | undefined>(filters.open);
  const ctx = useMemo(
    () => auditContext(bootstrap.principals, now, timeZone, rawLocale),
    [bootstrap.principals, now, timeZone, rawLocale],
  );
  const events = useMemo(() => query.data?.pages.flatMap((p) => p.events) ?? [], [query.data]);
  const counts = query.data?.pages[0]?.counts;
  const days = useMemo(
    () => groupAuditByDay(events, now, timeZone, rawLocale),
    [events, now, timeZone, rawLocale],
  );
  const whoName = auditWhoName(filters.who, bootstrap.principals);
  // `setParams` merges: a filter back at its default is set to undefined so it leaves the params.
  const change = (next: Partial<AuditFilters>) =>
    navigation.setParams({
      actor: undefined,
      kind: undefined,
      who: undefined,
      open: undefined,
      ...auditRouteParams({ ...filters, open: undefined, ...next }),
    });
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  const row = (event: AuditEvent) => {
    const model = auditRow(event, ctx, people.get(event.actorId));
    const opened = open === event.id;
    const detail = opened ? auditDetail(event, ctx) : null;
    const link = detail?.link ?? null;
    return (
      <View key={event.id} style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line }}>
        <Touchable
          onPress={() => setOpen(opened ? undefined : event.id)}
          feedback="wash"
          accessibilityLabel={model.accessibilityLabel}
          accessibilityState={{ expanded: opened }}
          style={{
            minHeight: 44,
            flexDirection: 'row',
            gap: 10,
            paddingVertical: 12,
            paddingHorizontal: 16,
          }}
        >
          <Text size={11.5} mono color={theme.colors.mut} style={{ width: 40, paddingTop: 2 }}>
            {model.time}
          </Text>
          <PrincipalAvatar principal={people.get(event.actorId)} size={28} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Text size={14.5} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
                {model.name}
              </Text>
              <Text size={10.5} weight={500} mono tracking={0.05} color={theme.colors.mut}>
                {model.tag}
              </Text>
            </View>
            <Text size={14} lh={1.42} color={theme.colors.ink2}>
              {model.text}
            </Text>
            <Text size={11} mono color={theme.colors.mut} numberOfLines={1}>
              {model.meta}
            </Text>
            {model.pill ? (
              <Text size={10.5} weight={500} mono tracking={0.05} color={toneOf(theme, model.pill.tone)}>
                {model.pill.text}
              </Text>
            ) : null}
          </View>
        </Touchable>
        {detail ? (
          <View style={{ gap: 8, paddingHorizontal: 16, paddingBottom: 14, paddingLeft: 66 }}>
            {detail.fields.map((field) => (
              <View
                key={field.label}
                accessible
                accessibilityLabel={`${field.label}: ${field.value}`}
                style={{ gap: 2 }}
              >
                <Text size={10.5} weight={500} mono tracking={0.05} color={theme.colors.mut}>
                  {field.label}
                </Text>
                <Text size={13} mono lh={1.4} color={toneOf(theme, field.tone)} selectable>
                  {field.value}
                </Text>
              </View>
            ))}
            {link ? (
              <View style={{ alignSelf: 'flex-start', paddingTop: 2 }}>
                <Button
                  label={link.label}
                  variant="secondary"
                  onPress={() => openLink(link.ref, auditTextHere.title)}
                  style={{ paddingHorizontal: 16 }}
                />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <Screen>
      <BackBar label={tMobile('managed.back')} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching && !query.isFetchingNextPage}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 12, gap: 6 }}>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {auditTextHere.title}
          </Text>
          <Text size={14} lh={1.5} color={theme.colors.ink2}>
            {auditSubtitle(bootstrap.burrow.name, agent.name, rawLocale)}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 16, gap: 12, paddingBottom: 14 }}>
          <Segmented
            options={auditActorOptions(rawLocale)}
            value={filters.actor}
            onChange={(actor) => change({ actor })}
            label={tMobile('screens.actor')}
          />
          {whoName ? (
            <View style={{ alignSelf: 'flex-start' }}>
              <Chip
                label={tMobile('audit.only', { name: whoName })}
                active
                onPress={() => change({ who: undefined })}
              />
            </View>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityRole="tablist"
            contentContainerStyle={{ gap: 6, paddingVertical: 7 }}
          >
            {auditKindChips(filters.kind, counts, rawLocale).map((c) => (
              <Chip
                key={c.value}
                label={c.label}
                count={c.count}
                active={c.active}
                onPress={() => change({ kind: c.value })}
              />
            ))}
          </ScrollView>
        </View>
        {query.error && !query.data ? (
          <ErrorState text={auditTextHere.loadFailed} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows
            count={8}
            lines={2}
            avatarSize={28}
            label={tMobile('screens.loading-the-audit-log')}
          />
        ) : events.length === 0 ? (
          <QuietText>{auditTextHere.empty}</QuietText>
        ) : (
          days.map((day) => (
            <View key={day.key} style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
              <SectionLabel>{day.label}</SectionLabel>
              <View
                style={{
                  borderRadius: 20,
                  backgroundColor: theme.colors.sf,
                  borderWidth: 1,
                  borderColor: theme.colors.line,
                  overflow: 'hidden',
                }}
              >
                {day.events.map(row)}
              </View>
            </View>
          ))
        )}
        {query.hasNextPage ? (
          <View style={{ paddingHorizontal: 16 }}>
            <Button
              label={query.isFetchingNextPage ? auditTextHere.loading : auditTextHere.loadMore}
              variant="secondary"
              disabled={query.isFetchingNextPage}
              onPress={() => void query.fetchNextPage()}
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Core's `neutral` reads as plain ink (the web's Tag); the others are the theme's tones. */
function toneOf(theme: ReturnType<typeof useTheme>, tone: AuditTone): string {
  return tone === 'neutral' ? theme.colors.ink : toneColor(theme, tone);
}
