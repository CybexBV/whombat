/**
 * An automation run on Android (docs/decisions/bp-automations.md BP-C13; not mocked): status, its steps with their
 * state and what came out, Cancel (and Pause / Resume). A step waiting for a person opens the approval screen —
 * the same approval flow as the inbox, where a person approves with an explicit tap. A run of a deleted automation stays
 * readable and says “This automation was deleted.” (automation-recipes.md AP-983). In plain words (AP-1010…): an
 * assessment as tags and a sentence with its “Technical details” folded, a recipe's checks as their story, and a
 * finished run's skipped last steps as one row that opens them. A run started by a tracker's report shows the report
 * above its steps, read live from its tracker, with Reply and Set status for people who may (report-trackers.md TA-14,
 * TA-15).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { automationRunLabel, automationTrackerWords } from '@whombat/client';
import { useApiMutation, useAutomationRun } from '@whombat/client/react';
import { missingAttachmentsText } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type ReactNode, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  automationDeleteText,
  type RunStepAssessment,
  type RunStepView,
  runActive,
  runStatusCopy,
  runStepsView,
  type SkippedStepsView,
  SUGGESTS_A_CHANGE,
  TECHNICAL_DETAILS,
} from '../data/automations';
import { useBurrowBase } from '../data/BurrowProvider';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { ChevronDown, ChevronUp } from '../ui/icons';
import { bottomPadding } from '../ui/insets';
import { ListRow } from '../ui/ListRow';
import { Button, ErrorState, Section, SkeletonRows, StatusDot, toneColor } from '../ui/primitives';
import { RichText } from '../ui/rich';
import { Touchable } from '../ui/Touchable';
import { errorText, outcomeText } from './feedback';
import { TrackerItemSection, useTrackerItem } from './TrackerItem';

type Props = NativeStackScreenProps<RootStackParamList, 'AutomationRun'>;

export function AutomationRunScreen({ route, navigation }: Props) {
  const { rawLocale, tClient } = useI18n();
  const automationDeleteTextHere = automationDeleteText(rawLocale);
  const runStatusCopyHere = runStatusCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug } = useBurrowBase();
  const { number, back } = route.params;
  const params = { burrow: slug, number };
  const query = useAutomationRun({ params });
  const pause = useApiMutation(api.automations.pauseRun);
  const resume = useApiMutation(api.automations.resumeRun);
  const cancel = useApiMutation(api.automations.cancelRun);
  const [busy, setBusy] = useState<string | null>(null);
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'Automations' });

  const control = (action: 'pause' | 'resume' | 'cancel') => {
    const m = action === 'pause' ? pause : action === 'resume' ? resume : cancel;
    setBusy(action);
    m.mutate(
      { params },
      {
        onSuccess: (res) => {
          const text = outcomeText(res);
          if (text) Alert.alert(text.title, text.body);
          else void query.refetch();
        },
        onError: (err) => Alert.alert(tMobile('screens.that-didnt-work'), errorText(err)),
        onSettled: () => setBusy(null),
      },
    );
  };
  const confirmCancel = () =>
    Alert.alert(
      tMobile('screens.stop-this-run'),
      tMobile('screens.any-agent-working-for-it-stops-too-steps'),
      [
        { text: 'Keep going', style: 'cancel' },
        { text: 'Stop it', style: 'destructive', onPress: () => control('cancel') },
      ],
    );

  const data = query.data;
  const run = data?.run;
  // The report a tracker's run started from, live from the tracker, named in the words the automation keeps.
  const reportRun = run?.trigger.kind === 'tracker' ? run.id : null;
  const report = useTrackerItem(reportRun ? { params: { burrow: slug, runId: reportRun } } : null);
  const words = automationTrackerWords(data?.automation);
  const status = run ? runStatusCopyHere[run.status] : null;
  const steps = run ? runStepsView(run, words, rawLocale) : null;
  // The route's number is the run's: a request opened from a step comes back to “Run #12”.
  const openApproval = (approval: number) =>
    navigation.navigate('Approval', { number: approval, back: `Run #${number}` });

  return (
    <Screen>
      <BackBar label={back ?? tMobile('screens.automations')} onPress={goBack} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomPadding(36, insets.bottom, 16) }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => {
              void query.refetch();
              if (reportRun) void report.refetch();
            }}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        {query.isPending ? (
          <SkeletonRows count={4} label={tMobile('screens.loading-the-run')} />
        ) : !run || !status || !steps ? (
          <ErrorState text={tMobile('screens.this-run-didnt-load')} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusDot color={toneColor(theme, status.tone)} label={automationRunLabel(run)} />
                <Text size={11.5} mono color={theme.colors.ink2}>
                  {`${data.automation.name.toUpperCase()} · ${automationRunLabel(run).toUpperCase()}`}
                </Text>
              </View>
              <Text size={28} weight={700} accessibilityRole="header">
                {`Run #${run.number}`}
              </Text>
              <Text size={15} lh={1.42} color={theme.colors.ink2}>
                {run.trigger.summary}
              </Text>
              {run.error ? (
                <Text size={14} lh={1.42} color={theme.colors.bad}>
                  {run.error}
                </Text>
              ) : null}
              {run.missingAttachments?.length || run.missingAttachmentsOmitted ? (
                <Text size={14} lh={1.42} color={toneColor(theme, 'warn')}>
                  {missingAttachmentsText(run.missingAttachments ?? [], run.missingAttachmentsOmitted ?? 0)}
                </Text>
              ) : null}
              {data.automation.deletedAt ? (
                <Text size={14} lh={1.42} color={theme.colors.mut}>
                  {automationDeleteTextHere.deleted}
                </Text>
              ) : null}
            </View>
            {runActive(run.status) ? (
              <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 14 }}>
                {run.status === 'paused' ? (
                  <Button
                    label={tMobile('screens.resume')}
                    variant="secondary"
                    busy={busy === 'resume'}
                    onPress={() => control('resume')}
                    style={{ flex: 1 }}
                  />
                ) : run.status !== 'needs_review' ? (
                  <Button
                    label={tMobile('screens.pause')}
                    variant="secondary"
                    busy={busy === 'pause'}
                    onPress={() => control('pause')}
                    style={{ flex: 1 }}
                  />
                ) : null}
                <Button
                  label={tClient('reports.cancel')}
                  variant="secondary"
                  busy={busy === 'cancel'}
                  onPress={confirmCancel}
                  style={{ flex: 1 }}
                />
              </View>
            ) : null}
            {reportRun ? (
              <TrackerItemSection query={report} burrow={slug} runId={reportRun} words={words} />
            ) : null}
            <Section title={tMobile('screens.steps')}>
              {steps.steps.map((s) => (
                <StepRow key={s.key} step={s} onOpenApproval={openApproval} />
              ))}
              {steps.skipped ? <SkippedSteps fold={steps.skipped} onOpenApproval={openApproval} /> : null}
            </Section>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * A step: its name, state and what came out (a condition's story whole, AP-1011); an agent step with an assessment
 * shows that instead (AP-1010). A step that asked a person opens the request.
 */
function StepRow({
  step: s,
  onOpenApproval,
}: {
  step: RunStepView;
  onOpenApproval: (number: number) => void;
}) {
  const theme = useTheme();
  const open = s.approvalNumber !== null ? () => onOpenApproval(s.approvalNumber as number) : null;
  const request = s.approvalOpen ? (
    <Text size={13.5} weight={600} color={theme.colors.brand}>
      {`Request #${s.approvalNumber} needs a person ›`}
    </Text>
  ) : null;
  if (s.assessment)
    return (
      <AssessedStepRow step={s} assessment={s.assessment} onPress={open}>
        {request}
      </AssessedStepRow>
    );
  return (
    <ListRow
      title={s.title}
      meta={s.state}
      trailing={<StatusDot color={toneColor(theme, s.tone)} label={s.state} />}
      body={s.error ?? s.body}
      bodyLines={s.error ? 2 : s.bodyLines}
      accessibilityLabel={s.accessibilityLabel}
      {...(open ? { onPress: open } : {})}
    >
      {request}
    </ListRow>
  );
}

/**
 * An agent step's assessment (AP-1010), in a `ListRow`'s anatomy: the name line, the line as tags (the web's soft
 * `Tag`, the kind in `ink`), the plain summary, then a 44dp “Technical details” that opens the details as Markdown with
 * the messages' renderer. The name, tags and summary are one TalkBack stop; the fold is its own button.
 */
function AssessedStepRow({
  step: s,
  assessment: a,
  onPress,
  children,
}: {
  step: RunStepView;
  assessment: RunStepAssessment;
  onPress: (() => void) | null;
  children?: ReactNode;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text size={15.5} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
          {s.title}
        </Text>
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {s.state}
        </Text>
        <StatusDot color={toneColor(theme, s.tone)} label={s.state} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 2 }}>
        {a.tags.map((tag, i) => (
          <View
            key={tag}
            style={{
              paddingVertical: 2,
              paddingHorizontal: 7,
              borderRadius: theme.radii.tag,
              backgroundColor: theme.colors.sf2,
            }}
          >
            <Text
              size={10.5}
              weight={500}
              mono
              tracking={0.04}
              uppercase
              color={i === 0 ? theme.colors.ink : theme.colors.ink2}
            >
              {tag}
            </Text>
          </View>
        ))}
        {a.suggests ? (
          // The agent recommends a change (AP-1057): what the card in the thread offers.
          <View
            style={{
              paddingVertical: 2,
              paddingHorizontal: 7,
              borderRadius: theme.radii.tag,
              backgroundColor: theme.colors.sf2,
            }}
          >
            <Text size={10.5} weight={500} mono tracking={0.04} uppercase color={theme.colors.brand}>
              {SUGGESTS_A_CHANGE}
            </Text>
          </View>
        ) : null}
      </View>
      {a.summary ? (
        <Text size={15} lh={1.42} color={theme.colors.ink2}>
          {a.summary}
        </Text>
      ) : null}
      {s.error ? (
        <Text size={15} lh={1.42} color={theme.colors.ink2}>
          {s.error}
        </Text>
      ) : null}
      {children}
    </>
  );
  return (
    <View
      style={{
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      {onPress ? (
        <Touchable
          onPress={onPress}
          feedback="wash"
          accessibilityLabel={s.accessibilityLabel}
          style={{ gap: 4 }}
        >
          {content}
        </Touchable>
      ) : (
        <View accessible accessibilityLabel={s.accessibilityLabel} style={{ gap: 4 }}>
          {content}
        </View>
      )}
      {a.details ? (
        <>
          <Touchable
            onPress={() => setOpen((o) => !o)}
            feedback="wash"
            accessibilityLabel={TECHNICAL_DETAILS}
            accessibilityHint={
              open ? tMobile('screens.hides-them') : tMobile('screens.shows-what-was-checked')
            }
            accessibilityState={{ expanded: open }}
            ringRadius={10}
            style={{
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 8,
              marginHorizontal: -8,
              marginTop: 2,
              marginBottom: open ? 2 : -10,
              borderRadius: 10,
            }}
          >
            <Text size={14} weight={500} color={theme.colors.ink2}>
              {TECHNICAL_DETAILS}
            </Text>
            {open ? (
              <ChevronUp size={16} color={theme.colors.mut} strokeWidth={2} />
            ) : (
              <ChevronDown size={16} color={theme.colors.mut} strokeWidth={2} />
            )}
          </Touchable>
          {open ? (
            <RichText
              text={a.details}
              color={theme.colors.ink2}
              accentColor={theme.colors.brand}
              codeBackground={theme.colors.sf2}
              size={14}
              lh={1.45}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * A finished run's last steps that were never reached, as one row (AP-1014): “4 more steps skipped” with a chevron, the
 * steps under it while it is open. A 44dp+ row in the list's language (the activity's groups).
 */
function SkippedSteps({
  fold,
  onOpenApproval,
}: {
  fold: SkippedStepsView;
  onOpenApproval: (number: number) => void;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="wash"
        accessibilityLabel={fold.label}
        accessibilityHint={open ? tMobile('screens.hides-them') : tMobile('screens.shows-them')}
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <Text size={15} weight={500} color={theme.colors.ink2} style={{ flex: 1, minWidth: 0 }}>
          {fold.label}
        </Text>
        {open ? (
          <ChevronUp size={16} color={theme.colors.mut} strokeWidth={2} />
        ) : (
          <ChevronDown size={16} color={theme.colors.mut} strokeWidth={2} />
        )}
      </Touchable>
      {open ? fold.steps.map((s) => <StepRow key={s.key} step={s} onOpenApproval={onOpenApproval} />) : null}
    </>
  );
}
