/**
 * A new report to the Whombat Team on the phone (Whombat docs/decisions/team-reports.md): what it is about as two cards
 * (Something’s wrong, An idea), the one question it needs, What did you expect? for a problem, what is sent with it
 * (folded: the Whombat's version and update channel, this app's version, the phone and its system, the language), the
 * quiet line that the team and its assistant read it, where a security problem goes instead, and Send. Sent, its page
 * opens in its place and says so once. Opened from the assistant's card (`draftId`), the form starts with its draft
 * and sending it finishes it. Where the person can't send now, it says why and Send stays off, as on the web.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import {
  TEAM_REPORT_SECURITY_URL,
  teamReportClientContext,
  teamReportSentWith,
  teamReportsUnavailableText,
  teamReportWords,
} from '@whombat/client';
import { readUpdatesChannel } from '@whombat/client/managed';
import {
  teamReportErrorText,
  useCreateTeamReport,
  useTeamReportDraft,
  useTeamReports,
} from '@whombat/client/react';
import { sessionOps } from '@whombat/client/session';
import { TEAM_REPORT_EXPECTED_MAX, TEAM_REPORT_TEXT_MAX, type TeamReportKind } from '@whombat/core';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { phoneDeviceWords, phoneLanguage } from '../data/teamReports';
import { useI18n, useMobileT } from '../i18n';
import { useManaged } from '../managed/context';
import { ErrorLine } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField } from '../ui/formField';
import { BackBar, Screen } from '../ui/headers';
import { Bug, ChevronDown, ChevronUp, Lightbulb, type LucideIcon } from '../ui/icons';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { Button } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'TeamReportNew'>;

const KIND_ICONS: Record<TeamReportKind, LucideIcon> = { bug: Bug, idea: Lightbulb };
const PLATFORM: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';

/** What this phone says about itself with a report: the app's version, the phone and its system, the language. */
function phoneContext() {
  return teamReportClientContext({
    client: PLATFORM,
    appVersion: Constants.expoConfig?.version ?? null,
    device: phoneDeviceWords(
      { modelName: Device.modelName, osName: Device.osName, osVersion: Device.osVersion },
      PLATFORM,
    ),
    language: phoneLanguage(() => Intl.DateTimeFormat().resolvedOptions().locale),
  });
}

/** The Whombat's version, which the box adds to the report itself: read here only to show it. Null while unknown. */
function useRuntimeVersion(): string | null {
  const session = useManaged()?.session ?? null;
  const status = useQuery({
    queryKey: ['whombat', 'version', 'appliance.status'],
    queryFn: () => (session ? sessionOps.applianceStatus(session) : Promise.resolve(null)),
    enabled: session !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return status.data?.appliance.runtimeVersion || null;
}

/** The Whombat's update channel, which the box adds too: read here only to show it. Null while unknown. */
function useUpdateChannel() {
  const session = useManaged()?.session ?? null;
  const channel = useQuery({
    queryKey: ['whombat', 'updates.channel'],
    queryFn: () => (session ? readUpdatesChannel(session) : Promise.resolve(null)),
    enabled: session !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return channel.data?.channel ?? null;
}

export function TeamReportNewScreen({ navigation, route }: Props) {
  const { rawLocale } = useI18n();
  const teamReportWordsHere = teamReportWords(rawLocale);
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const bottomRoom = useBottomRoom();
  const draftId = route.params?.draftId;
  const list = useTeamReports(slug);
  const draft = useTeamReportDraft(slug, draftId);
  const create = useCreateTeamReport(slug);
  const [kind, setKind] = useState<TeamReportKind>('bug');
  const [text, setText] = useState('');
  const [expected, setExpected] = useState('');
  const [showSent, setShowSent] = useState(false);
  const context = useMemo(phoneContext, []);
  const runtimeVersion = useRuntimeVersion();
  const channel = useUpdateChannel();
  const sentWith = teamReportSentWith(
    {
      ...context,
      ...(runtimeVersion ? { runtimeVersion } : {}),
      ...(channel ? { channel } : {}),
    },
    rawLocale,
  );

  // Each of the assistant's drafts fills the form in once; one already sent or put aside fills in nothing.
  const filled = useRef<string | null>(null);
  const drafted = draft.data?.draft;
  useEffect(() => {
    if (!drafted || drafted.done || filled.current === drafted.id) return;
    filled.current = drafted.id;
    setKind(drafted.kind);
    setText(drafted.text);
    setExpected(drafted.expected);
  }, [drafted]);
  const draftNote = !draftId
    ? null
    : drafted?.done
      ? teamReportWordsHere.draftDone
      : draft.isError
        ? teamReportWordsHere.draftFailed
        : null;

  // As on the web: a Whombat that doesn't speak reports, or a person who can't send now, gets the reason, not Send.
  const unavailable =
    list.data && !list.data.available ? teamReportsUnavailableText(list.data.reason, rawLocale) : null;
  const blocked = !list.supported ? teamReportWordsHere.updateFirst : unavailable;
  const ready = !blocked && text.trim().length > 0 && !create.isPending;
  const send = () => {
    if (!ready) return;
    create.mutate(
      {
        kind,
        text: text.trim(),
        expected: kind === 'bug' ? expected.trim() : '',
        context,
        ...(draftId && drafted && !drafted.done ? { draftId } : {}),
      },
      {
        // Its page opens in the form's place, so back goes to the list.
        onSuccess: (report) =>
          navigation.replace('TeamReport', {
            reportId: report.id,
            sent: true,
            back: teamReportWordsHere.back,
          }),
      },
    );
  };

  return (
    <Screen>
      <BackBar
        label={route.params?.back ?? tMobile('managed.back')}
        onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('TeamReports'))}
      />
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 2,
            paddingBottom: 32 + bottomRoom,
            gap: 18,
          }}
        >
          <Text
            size={25}
            weight={700}
            lh={1.15}
            tracking={-0.02}
            accessibilityRole="header"
            style={{ paddingHorizontal: 6 }}
          >
            {teamReportWordsHere.formTitle}
          </Text>
          {blocked ? (
            <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
              {blocked}
            </Text>
          ) : null}
          {draftNote ? (
            <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
              {draftNote}
            </Text>
          ) : null}

          <View style={{ gap: 8 }}>
            <Text size={13} weight={500} color={theme.colors.ink2} style={{ paddingHorizontal: 2 }}>
              {teamReportWordsHere.kindQuestion}
            </Text>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={teamReportWordsHere.kindQuestion}
              style={{ flexDirection: 'row', gap: 10 }}
            >
              {(['bug', 'idea'] as const).map((k) => (
                <KindCard key={k} kind={k} selected={kind === k} onPress={() => setKind(k)} />
              ))}
            </View>
          </View>

          <FormField
            label={teamReportWordsHere.textLabel[kind]}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={TEAM_REPORT_TEXT_MAX}
            style={{ minHeight: 120, textAlignVertical: 'top' }}
          />
          {kind === 'bug' ? (
            <FormField
              label={`${teamReportWordsHere.expectedLabel} (${teamReportWordsHere.optional.toLowerCase()})`}
              value={expected}
              onChangeText={setExpected}
              multiline
              maxLength={TEAM_REPORT_EXPECTED_MAX}
              style={{ minHeight: 72, textAlignVertical: 'top' }}
            />
          ) : null}

          <SentWith rows={sentWith} open={showSent} onToggle={() => setShowSent((v) => !v)} />

          <View style={{ gap: 4, paddingHorizontal: 6 }}>
            <Text size={13} lh={1.45} color={theme.colors.mut}>
              {teamReportWordsHere.warning}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4 }}>
              <Text size={13} lh={1.45} color={theme.colors.mut}>
                {teamReportWordsHere.securityQuestion}
              </Text>
              <Touchable
                onPress={() => void Linking.openURL(TEAM_REPORT_SECURITY_URL)}
                feedback="wash"
                ringRadius={6}
                accessibilityRole="link"
                accessibilityLabel={`${teamReportWordsHere.securityQuestion} ${teamReportWordsHere.securityLink}`}
                hitSlop={{ top: 12, bottom: 12 }}
                style={{ minHeight: 20, justifyContent: 'center' }}
              >
                <Text
                  size={13}
                  lh={1.45}
                  weight={500}
                  color={theme.colors.brand}
                  style={{ textDecorationLine: 'underline' }}
                >
                  {teamReportWordsHere.securityLink}
                </Text>
              </Touchable>
            </View>
          </View>

          <ErrorLine text={create.isError ? teamReportErrorText(create.error, rawLocale) : null} />
          <Button
            label={create.isPending ? teamReportWordsHere.sending : teamReportWordsHere.send}
            size="lg"
            disabled={!ready}
            busy={create.isPending}
            onPress={send}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** One of the two kinds as a card: its icon, its name and a line under it; the chosen one outlined in ink. */
function KindCard({
  kind,
  selected,
  onPress,
}: {
  kind: TeamReportKind;
  selected: boolean;
  onPress: () => void;
}) {
  const { rawLocale } = useI18n();
  const teamReportWordsHere = teamReportWords(rawLocale);
  const theme = useTheme();
  const words = teamReportWordsHere.kinds[kind];
  const Icon = KIND_ICONS[kind];
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={14}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={`${words.title}. ${words.hint}`}
      style={{
        flex: 1,
        minHeight: 96,
        gap: 6,
        padding: 14,
        borderRadius: 14,
        borderWidth: selected ? 2 : 1,
        // The chosen card's thicker line takes its own room: the words don't move.
        margin: selected ? 0 : 1,
        borderColor: selected ? theme.colors.btn : theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Icon size={20} color={selected ? theme.colors.ink : theme.colors.ink2} strokeWidth={1.75} />
      <Text size={15} weight={600} lh={1.3}>
        {words.title}
      </Text>
      <Text size={12.5} lh={1.4} color={theme.colors.mut}>
        {words.hint}
      </Text>
    </Touchable>
  );
}

/** “What’s sent with it”, folded: each part on its own line when opened, and that nothing else goes. */
function SentWith({
  rows,
  open,
  onToggle,
}: {
  rows: { label: string; value: string }[];
  open: boolean;
  onToggle: () => void;
}) {
  const { rawLocale } = useI18n();
  const teamReportWordsHere = teamReportWords(rawLocale);
  const theme = useTheme();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      <Touchable
        onPress={onToggle}
        feedback="wash"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={teamReportWordsHere.sentWith}
        style={{
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 14,
        }}
      >
        <Text size={14} weight={500} color={theme.colors.ink2} style={{ flex: 1 }}>
          {teamReportWordsHere.sentWith}
        </Text>
        <Chevron size={18} color={theme.colors.mut} />
      </Touchable>
      {open ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 6 }}>
          {rows.map((r) => (
            <View key={r.label} style={{ flexDirection: 'row', gap: 10 }}>
              <Text size={13} color={theme.colors.mut} style={{ width: 96 }}>
                {r.label}
              </Text>
              <Text size={13} mono color={theme.colors.ink2} style={{ flex: 1 }}>
                {r.value}
              </Text>
            </View>
          ))}
          <Text size={12.5} lh={1.4} color={theme.colors.mut} style={{ paddingTop: 2 }}>
            {teamReportWordsHere.sentWithNothingElse}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
