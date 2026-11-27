/**
 * Plans on Android (AP-718; the web's Plans pane, work-supervision WS-09): every plan the viewer can see, Open or All,
 * open ones first — the title, where it lives, progress and due, and the step that leads it with its marker. A row
 * opens the plan screen. Opened from a conversation's menu with `conversationId` (the Agents tab that opened all of
 * them is gone, one-layout-android.md AP-2640): that conversation's plans, as the web's conversation header has them (AP-859; no “where” on
 * the rows, the back button names the conversation). Plans come and go over `plan.updated` (the shared client), and
 * on pull.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePlans } from '@whombat/client/react';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { whereOf } from '../data/people';
import {
  type PlanListFilter,
  planFilters,
  planListRows,
  plansEmptyText,
  plansHereEmptyText,
} from '../data/planList';
import { overviewTitle } from '../data/shell';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { ListRow } from '../ui/ListRow';
import { Chip, ErrorState, QuietText, Section, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { PlanMarkerView, stateColor } from './PlanScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'Plans'>;

export function PlansScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, bootstrap } = useBurrow();
  const back = route.params?.back ?? overviewTitle(rawLocale);
  const conversationId = route.params?.conversationId;
  const [filter, setFilter] = useState<PlanListFilter>('open');
  const query = usePlans({
    params: { burrow: slug },
    query: conversationId ? { conversationId, status: filter } : { status: filter },
  });
  const rows = useMemo(
    () =>
      planListRows(
        query.data?.plans ?? [],
        (id) => (conversationId ? undefined : whereOf(bootstrap, id)),
        rawLocale,
      ),
    [query.data, bootstrap, conversationId, rawLocale],
  );
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 20 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <LargeTitle title={tMobile('screens.plans')} />
        <View
          style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 22, paddingTop: 6, paddingBottom: 14 }}
          accessibilityRole="tablist"
        >
          {planFilters(rawLocale).map((f) => (
            <Chip
              key={f.value}
              label={f.label}
              active={filter === f.value}
              onPress={() => setFilter(f.value)}
            />
          ))}
        </View>
        {query.error && !query.data ? (
          <ErrorState text={tMobile('screens.plans-didnt-load')} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows count={4} lines={2} label={tMobile('screens.loading-plans')} />
        ) : rows.length === 0 ? (
          <QuietText>
            {(conversationId ? plansHereEmptyText(rawLocale) : plansEmptyText(rawLocale))[filter]}
          </QuietText>
        ) : (
          <Section title={`PLANS · ${rows.length}`}>
            {rows.map((r) => (
              <ListRow
                key={r.id}
                title={r.title}
                meta={r.where}
                trailing="›"
                onPress={() => navigation.navigate('Plan', { planId: r.id, back: tMobile('screens.plans') })}
                accessibilityLabel={r.accessibilityLabel}
              >
                <Text size={12.5} weight={500} mono color={theme.colors.ink2}>
                  {r.meta}
                </Text>
                {r.next ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <PlanMarkerView marker={r.next.marker} label={r.next.markerLabel} />
                    <Text size={14} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
                      {r.next.title}
                    </Text>
                    <Text
                      size={11.5}
                      weight={500}
                      mono
                      color={stateColor(theme, r.next.tone)}
                      numberOfLines={1}
                    >
                      {r.next.stateLabel}
                    </Text>
                  </View>
                ) : null}
              </ListRow>
            ))}
          </Section>
        )}
      </ScrollView>
    </Screen>
  );
}
