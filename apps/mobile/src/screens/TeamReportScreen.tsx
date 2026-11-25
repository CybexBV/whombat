/**
 * One report to the Whombat Team on the phone (Whombat docs/decisions/team-reports.md), where its Inbox item and push
 * lead: its number and kind, its title, its status in words and the four-step track; It works / Still happening once
 * a fix is there for the person or the report was closed; then the conversation, oldest first (a quiet line above it
 * when the oldest messages of a long one were left out) — what the person sent, their messages and the Whombat Team's,
 * status changes as quiet lines — and, while the report is open, the reply box. The team's words are plain
 * text: no formatting, no links to tap, no pictures. Withdraw report is in the ⋯, asked first. Opening it reads it.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  TEAM_REPORT_WORDS,
  type TeamReportEntry,
  teamReportMessageWhen,
  teamReportTimeline,
} from '@whombat/client';
import {
  teamReportErrorText,
  teamReportMissing,
  useActTeamReport,
  useReplyTeamReport,
  useTeamReport,
} from '@whombat/client/react';
import {
  TEAM_REPORT_MESSAGES_MAX,
  TEAM_REPORT_REPLY_MAX,
  TEAM_REPORT_STATUS_WORDS,
  type TeamReport,
  type TeamReportAction,
  TeamReportId,
  teamReportCanConfirm,
  teamReportOpen,
} from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { teamReportTone } from '../data/teamReports';
import { ErrorLine } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { BackBar, Screen } from '../ui/headers';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { StatusPill } from '../ui/StatusPill';
import { useBottomRoom } from '../ui/screenBottom';
import { showNotice } from './feedback';
import { ReportMore, ReportTrack, reportKicker } from './teamReportParts';

type Props = NativeStackScreenProps<RootStackParamList, 'TeamReport'>;

export function TeamReportScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const bottomRoom = useBottomRoom();
  const reportId = route.params.reportId;
  // A link may name anything: a report's id is asked for, anything else isn't here.
  const valid = TeamReportId.safeParse(reportId).success;
  const { report, earlier, supported, error, isError, refetch } = useTeamReport(
    slug,
    valid ? reportId : null,
  );
  const act = useActTeamReport(slug, reportId);
  // “Sent.” shows once, as the page opens after the form; the param goes so a later visit doesn't say it again.
  const [sent] = useState(route.params.sent === true);
  useEffect(() => {
    if (route.params.sent !== undefined) navigation.setParams({ sent: undefined });
  }, [route.params.sent, navigation]);
  const scroller = useRef<ScrollView>(null);

  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('TeamReports', undefined);
  // A withdrawn report's page gives way to the list: the one under it, or the list in its place.
  const toList = () => {
    const routes = navigation.getState().routes;
    if (routes[routes.length - 2]?.name === 'TeamReports') navigation.goBack();
    else navigation.replace('TeamReports', undefined);
  };
  const withdraw = () =>
    Alert.alert(TEAM_REPORT_WORDS.withdrawConfirm, undefined, [
      { text: TEAM_REPORT_WORDS.cancel, style: 'cancel' },
      {
        text: TEAM_REPORT_WORDS.withdraw,
        style: 'destructive',
        onPress: () =>
          act.mutate('withdraw', {
            onSuccess: () => {
              showNotice(TEAM_REPORT_WORDS.withdrawn);
              toList();
            },
            onError: (e) => Alert.alert(teamReportErrorText(e)),
          }),
      },
    ]);
  const back = (
    <BackBar
      label={route.params.back ?? TEAM_REPORT_WORDS.back}
      onPress={goBack}
      right={report ? <ReportMore title={report.title} onWithdraw={withdraw} /> : undefined}
    />
  );
  if (!supported)
    return (
      <Screen>
        {back}
        <ErrorState text={TEAM_REPORT_WORDS.updateFirst} />
      </Screen>
    );
  if (!valid)
    return (
      <Screen>
        {back}
        <ErrorState text={TEAM_REPORT_WORDS.notFound} />
      </Screen>
    );
  if (!report && isError)
    return (
      <Screen>
        {back}
        {teamReportMissing(error) ? (
          <ErrorState text={TEAM_REPORT_WORDS.notFound} />
        ) : (
          <ErrorState text={TEAM_REPORT_WORDS.reportFailed} onRetry={() => void refetch()} />
        )}
      </Screen>
    );
  if (!report)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const pick = (action: TeamReportAction) => act.mutate(action);
  return (
    <Screen>
      {back}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          ref={scroller}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 2,
            paddingBottom: 32 + bottomRoom,
            gap: 18,
          }}
        >
          {sent ? (
            <View
              accessibilityLiveRegion="polite"
              style={{ padding: 14, borderRadius: 14, backgroundColor: theme.colors.sf2 }}
            >
              <Text size={14} lh={1.45} color={theme.colors.ink2}>
                {TEAM_REPORT_WORDS.sent}
              </Text>
            </View>
          ) : null}
          <View style={{ gap: 6, paddingHorizontal: 6 }}>
            <Text size={11.5} mono color={theme.colors.mut}>
              {reportKicker(report)}
            </Text>
            <Text size={25} weight={700} lh={1.2} tracking={-0.02} accessibilityRole="header">
              {report.title}
            </Text>
            <View style={{ paddingTop: 4 }}>
              <StatusPill
                text={TEAM_REPORT_STATUS_WORDS[report.status]}
                tone={teamReportTone(report.status)}
              />
            </View>
          </View>
          <ReportTrack status={report.status} />
          {teamReportCanConfirm(report.status) ? (
            <View
              style={{
                gap: 10,
                padding: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
              }}
            >
              <Text size={15} weight={600}>
                {TEAM_REPORT_WORDS.confirmQuestion}
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button
                  label={TEAM_REPORT_WORDS.works}
                  style={{ flex: 1 }}
                  busy={act.isPending && act.variables === 'works'}
                  disabled={act.isPending}
                  onPress={() => pick('works')}
                />
                <Button
                  label={TEAM_REPORT_WORDS.stillHappening}
                  variant="secondary"
                  style={{ flex: 1 }}
                  busy={act.isPending && act.variables === 'still_happening'}
                  disabled={act.isPending}
                  onPress={() => pick('still_happening')}
                />
              </View>
            </View>
          ) : null}
          <ErrorLine
            text={act.isError && act.variables !== 'withdraw' ? teamReportErrorText(act.error) : null}
          />
          {earlier > 0 ? (
            <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
              {TEAM_REPORT_WORDS.earlier}
            </Text>
          ) : null}
          <Conversation report={report} earlier={earlier} />
          {/* A closed report takes no replies: “Still happening” opens it again. */}
          {teamReportOpen(report.status) ? (
            <ReplyBox
              report={report}
              earlier={earlier}
              onSent={() => scroller.current?.scrollToEnd({ animated: true })}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The conversation, oldest first: the person's words in their bubble, the team's on the page, status lines quiet. */
function Conversation({ report, earlier }: { report: TeamReport; earlier: number }) {
  const entries = teamReportTimeline(report, earlier);
  return (
    <View style={{ gap: 14 }}>
      {entries.map((entry) => (
        <Entry key={entry.key} entry={entry} />
      ))}
    </View>
  );
}

function Entry({ entry }: { entry: TeamReportEntry }) {
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const when = teamReportMessageWhen(entry.at, now.getTime(), timeZone);
  if (entry.kind === 'status')
    return (
      <View
        accessible
        accessibilityLabel={`${entry.words}, ${when}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.line }} />
        <Text size={12} mono color={theme.colors.mut} style={{ flexShrink: 1, textAlign: 'center' }}>
          {`${entry.words} · ${when}`}
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.line }} />
      </View>
    );
  const mine = entry.kind === 'sent' || entry.author === 'reporter';
  const who = entry.kind === 'sent' ? TEAM_REPORT_WORDS.you : entry.who;
  return (
    <View style={{ gap: 4, alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <Text size={12} color={theme.colors.mut} style={{ paddingHorizontal: 4 }}>
        <Text size={12} weight={600} color={theme.colors.ink2}>
          {who}
        </Text>
        {` · ${when}`}
      </Text>
      <View
        style={{
          maxWidth: '92%',
          gap: 8,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: 16,
          backgroundColor: mine ? theme.colors.bubble : theme.colors.sf,
          borderWidth: mine ? 0 : 1,
          borderColor: theme.colors.line,
        }}
      >
        {/* Plain text, as written: no formatting, and a link is only words (the team's words are outsiders'). */}
        <Text size={15} lh={1.45} selectable>
          {entry.text}
        </Text>
        {entry.kind === 'sent' && entry.expected ? (
          <View style={{ gap: 2 }}>
            <Text size={12} weight={600} color={theme.colors.ink2}>
              {TEAM_REPORT_WORDS.expected}
            </Text>
            <Text size={14} lh={1.45} color={theme.colors.ink2} selectable>
              {entry.expected}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** “Write to the Whombat Team” and Send; a report that can't take more replies says so instead. */
function ReplyBox({ report, earlier, onSent }: { report: TeamReport; earlier: number; onSent: () => void }) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const reply = useReplyTeamReport(slug, report.id);
  const [text, setText] = useState('');
  if (report.messages.length + earlier >= TEAM_REPORT_MESSAGES_MAX)
    return (
      <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
        {TEAM_REPORT_WORDS.full}
      </Text>
    );
  const ready = text.trim().length > 0 && !reply.isPending;
  const metrics = textMetrics({ size: 15.5, family: 'sans', lineHeight: 1.4 });
  return (
    <View style={{ gap: 10 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        maxLength={TEAM_REPORT_REPLY_MAX}
        placeholder={TEAM_REPORT_WORDS.reply}
        accessibilityLabel={TEAM_REPORT_WORDS.reply}
        placeholderTextColor={theme.colors.placeholder}
        selectionColor={theme.colors.brand}
        cursorColor={theme.colors.ink}
        style={{
          minHeight: 88,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
          color: theme.colors.ink,
          textAlignVertical: 'top',
          ...metrics,
        }}
      />
      <ErrorLine text={reply.isError ? teamReportErrorText(reply.error) : null} />
      <Button
        label={TEAM_REPORT_WORDS.replySend}
        accessibilityLabel={`${TEAM_REPORT_WORDS.replySend}: ${TEAM_REPORT_WORDS.reply}`}
        disabled={!ready}
        busy={reply.isPending}
        style={{ alignSelf: 'flex-end', minWidth: 120 }}
        onPress={() =>
          reply.mutate(text.trim(), {
            onSuccess: () => {
              setText('');
              onSent();
            },
          })
        }
      />
    </View>
  );
}
