/**
 * Your reports (Whombat docs/decisions/team-reports.md) on the phone, from Settings → You and About: the problems and
 * ideas the person sent the Whombat Team, those waiting for them first and those with something new marked with the
 * app's blue dot, closed ones folded under Closed (one with something new still shows), and New report where sending
 * one is possible (else why not, in a line). A list the Whombat kept while the team couldn't be reached says it may be
 * out of date. Pulling the page down reads it again.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  TEAM_REPORT_WORDS,
  teamReportGroups,
  teamReportRowLabel,
  teamReportRowLine,
  teamReportsUnavailableText,
  teamReportWhen,
} from '@whombat/client';
import { teamReportErrorText, useTeamReports } from '@whombat/client/react';
import type { TeamReportRow } from '@whombat/core';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { useMobileT } from '../i18n';
import { Card, Note } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { RowChevron } from '../ui/ListRow';
import { Button, ErrorState, Loading, SectionLabel } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { KindTile } from './teamReportParts';

type Props = NativeStackScreenProps<RootStackParamList, 'TeamReports'>;

export function TeamReportsScreen({ navigation, route }: Props) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const bottomRoom = useBottomRoom();
  const list = useTeamReports(slug);
  const [showClosed, setShowClosed] = useState(false);
  const [pulling, setPulling] = useState(false);
  const back = (
    <BackBar
      label={route.params?.back ?? tMobile('managed.back')}
      onPress={() =>
        navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'Settings' })
      }
    />
  );
  if (!list.supported)
    return (
      <Screen>
        {back}
        <ErrorState text={TEAM_REPORT_WORDS.updateFirst} />
      </Screen>
    );
  if (list.isError && !list.data)
    return (
      <Screen>
        {back}
        <ErrorState text={teamReportErrorText(list.error)} onRetry={() => void list.refetch()} />
      </Screen>
    );
  if (!list.data)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const { available, reason, stale, reports } = list.data;
  const groups = teamReportGroups(reports);
  const closedOpen = !groups.foldable || showClosed;
  const closedRows = closedOpen ? groups.closed : groups.closedWhileFolded;
  const open = (r: TeamReportRow) =>
    navigation.navigate('TeamReport', { reportId: r.id, back: TEAM_REPORT_WORDS.back });
  const unavailable = available ? null : teamReportsUnavailableText(reason);
  return (
    <Screen>
      {back}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void list.refetch().finally(() => setPulling(false));
            }}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <LargeTitle title={TEAM_REPORT_WORDS.title} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          <Note text={reports.length ? TEAM_REPORT_WORDS.intro : TEAM_REPORT_WORDS.empty} />
          {stale ? <QuietLine text={TEAM_REPORT_WORDS.stale} /> : null}
          {available ? (
            <Button
              label={TEAM_REPORT_WORDS.newReport}
              onPress={() => navigation.navigate('TeamReportNew', { back: TEAM_REPORT_WORDS.back })}
            />
          ) : unavailable ? (
            <QuietLine text={unavailable} />
          ) : null}
          {groups.open.length ? (
            <Card label={TEAM_REPORT_WORDS.open.toUpperCase()}>
              {groups.open.map((r, i) => (
                <ReportRow key={r.id} row={r} first={i === 0} onPress={() => open(r)} />
              ))}
            </Card>
          ) : null}
          {groups.closed.length ? (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <SectionLabel>{`${TEAM_REPORT_WORDS.closed.toUpperCase()} · ${groups.closed.length}`}</SectionLabel>
                {groups.foldable ? (
                  <Touchable
                    onPress={() => setShowClosed((v) => !v)}
                    feedback="wash"
                    ringRadius={10}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: closedOpen }}
                    accessibilityLabel={`${closedOpen ? TEAM_REPORT_WORDS.hideClosed : TEAM_REPORT_WORDS.showClosed} ${TEAM_REPORT_WORDS.closed.toLowerCase()} reports`}
                    style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 10 }}
                  >
                    <Text size={14} weight={500} color={theme.colors.ink2}>
                      {closedOpen ? TEAM_REPORT_WORDS.hideClosed : TEAM_REPORT_WORDS.showClosed}
                    </Text>
                  </Touchable>
                ) : null}
              </View>
              {closedRows.length ? (
                <Card>
                  {closedRows.map((r, i) => (
                    <ReportRow key={r.id} row={r} first={i === 0} onPress={() => open(r)} />
                  ))}
                </Card>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

/** A quiet line: a list that may be out of date, why a new report can't be sent now. */
function QuietLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
      {text}
    </Text>
  );
}

/**
 * One report: its kind's tile (the blue dot when something is new), its title (bold when new) and when it last changed
 * (blue when new), and under it its number, kind and status. The whole row opens the report.
 */
function ReportRow({ row, first, onPress }: { row: TeamReportRow; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const fresh = row.unread;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={teamReportRowLabel(row)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <KindTile kind={row.kind} fresh={fresh} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text
            size={15}
            weight={fresh ? 700 : 500}
            lh={1.35}
            color={fresh ? theme.colors.ink : theme.colors.ink2}
            numberOfLines={2}
            style={{ flex: 1, minWidth: 0 }}
          >
            {row.title}
          </Text>
          <Text
            size={11.5}
            mono
            weight={fresh ? 500 : 400}
            color={fresh ? theme.chart.chart1 : theme.colors.mut}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {teamReportWhen(row.updatedAt, now.getTime(), timeZone)}
          </Text>
        </View>
        <Text size={12.5} mono lh={1.4} color={theme.colors.mut} numberOfLines={1}>
          {teamReportRowLine(row)}
        </Text>
      </View>
      <RowChevron />
    </Touchable>
  );
}
