/**
 * A run (not mocked on mobile; `whombat://runs/1907`, the live notification's target): the approval
 * screen's hero (112dp agent, mono label with the live dot, title, context line), a progress card with
 * "Now: …", tests and the diff, the run's controls (Pause, Resume, Try again, Take over — the web's rules, AP-711), then
 * STEPS, ACTIVITY (observed actions, WS-13…WS-17) and LIVE LOG — the desktop run page's content in the inbox's
 * language. Updates live from `run.updated` / `run.log` / `activity.updated` on the run's topic; pull to refresh
 * (AP-719). A run with a pull request opens it (AP-712) and its branch room.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { runAttentionLabel } from '@whombat/client';
import { useRun, useSubscription } from '@whombat/client/react';
import { topics } from '@whombat/core';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runFaceState } from '../avatars/faceEngine';
import { LiveFace } from '../avatars/LiveFace';
import { useBurrow, useViewContext } from '../data/BurrowProvider';
import { whereOf } from '../data/people';
import { pullRequestTarget } from '../data/pullRequest';
import {
  type RunControlButton,
  type RunDot,
  type RunStepView,
  runBranchRoom,
  runControlButtons,
  runScreen,
  type StepMarker,
} from '../data/run';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { bottomPadding } from '../ui/insets';
import {
  Button,
  ErrorState,
  Section,
  SectionLabel,
  Skeleton,
  SkeletonRows,
  toneColor,
} from '../ui/primitives';

import { RunActivity } from './RunActivity';
import { useRunControl } from './useRunControl';

type Props = NativeStackScreenProps<RootStackParamList, 'Run'>;

function LabelDot({ dot }: { dot: RunDot }) {
  const theme = useTheme();
  const color =
    dot === 'live'
      ? theme.colors.progress
      : dot === 'mut'
        ? theme.colors.mut
        : toneColor(theme, dot === 'ok' ? 'ok' : dot === 'warn' ? 'warn' : 'bad');
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        ...(dot === 'live' ? { boxShadow: `0 0 0 4px ${theme.colors.liveHalo}` } : {}),
      }}
    />
  );
}

function StepMarkerDot({ marker }: { marker: StepMarker }) {
  const theme = useTheme();
  const border =
    marker === 'done'
      ? theme.colors.ok
      : marker === 'active'
        ? theme.colors.progress
        : marker === 'paused'
          ? theme.colors.warn
          : marker === 'failed' || marker === 'stopped'
            ? theme.colors.bad
            : theme.colors.line2;
  return (
    <View
      style={{
        width: 16,
        height: 16,
        marginTop: 3,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: border,
        backgroundColor: marker === 'done' ? theme.colors.ok : 'transparent',
      }}
    />
  );
}

function StepRow({ step }: { step: RunStepView }) {
  const theme = useTheme();
  const queued = step.marker === 'queued';
  return (
    <View
      accessible
      accessibilityLabel={`${step.title}. ${step.stateLabel}${step.at ? `, ${step.at}` : ''}. ${step.detail}`}
      style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16 }}
    >
      <View style={{ width: 16, alignItems: 'center', paddingTop: 13 }}>
        <StepMarkerDot marker={step.marker} />
        {step.connector !== 'none' ? (
          <View
            style={{
              flex: 1,
              width: 2,
              minHeight: 14,
              marginTop: 4,
              backgroundColor: step.connector === 'ok' ? theme.colors.ok : theme.colors.line,
            }}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3, paddingTop: 13, paddingBottom: 13 }}>
        <Text
          size={15.5}
          weight={step.marker === 'active' ? 600 : 500}
          color={queued ? theme.colors.mut : theme.colors.ink}
        >
          {step.title}
        </Text>
        {step.detail ? (
          <Text size={13.5} lh={1.4} color={theme.colors.mut}>
            {step.detail}
          </Text>
        ) : null}
      </View>
      <Text size={11.5} mono color={theme.colors.mut} style={{ paddingTop: 16 }}>
        {step.at}
      </Text>
    </View>
  );
}

export function RunScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug, bootstrap } = useBurrow();
  const ctx = useViewContext();
  const { number, back = tMobile('places.inbox') } = route.params;
  const query = useRun({ params: { burrow: slug, number } });
  const detail = query.data;
  useSubscription(detail ? topics.run(detail.run.id) : null);
  const control = useRunControl(slug);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  if (!detail) {
    const notFound = query.error && 'status' in query.error && query.error.status === 404;
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        {notFound ? (
          <ErrorState text={tMobile('screens.this-run-isnt-here-any-more')} />
        ) : query.error ? (
          <ErrorState text={tMobile('screens.this-run-didnt-load')} onRetry={() => void query.refetch()} />
        ) : (
          <View style={{ paddingTop: 10 }} accessibilityLabel={tMobile('screens.loading-the-run')}>
            <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 22, paddingBottom: 22 }}>
              <Skeleton width={112} height={112} radius={56} />
              <Skeleton width={140} height={13} />
              <Skeleton width={220} height={20} />
            </View>
            <SkeletonRows count={4} lines={1} />
          </View>
        )}
      </Screen>
    );
  }

  const model = runScreen(detail, ctx, whereOf(bootstrap, detail.run.conversationId));
  const room = runBranchRoom(bootstrap.sidebar.branchRooms, detail.run);
  const pr = detail.run.prNumber
    ? pullRequestTarget(bootstrap.sidebar.branchRooms, detail.run.prNumber, room?.repo)
    : null;
  const buttons = runControlButtons(detail.run, model.agentName, rawLocale);
  const press = (b: RunControlButton) => {
    const go = () => control.act(b.action, detail.run, model.agentName);
    if (!b.confirm) return go();
    Alert.alert(b.confirm.title, b.confirm.body, [
      { text: tMobile('screens.run.cancel'), style: 'cancel' },
      { text: b.confirm.cta, style: 'destructive', onPress: go },
    ]);
  };
  const logColor = {
    ok: theme.code.pass,
    bad: theme.code.fail,
    command: theme.code.command,
    plain: theme.code.text,
  };

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 22, paddingTop: 4, paddingBottom: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 22 }}>
          {model.agentFace ? (
            <LiveFace
              face={model.agentFace}
              size={112}
              state={runFaceState(detail.run)}
              label={model.agentName}
            />
          ) : null}
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            accessible
            accessibilityLiveRegion="polite"
            accessibilityLabel={model.label}
          >
            <LabelDot dot={model.dot} />
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {model.label}
            </Text>
          </View>
          <Text
            size={25}
            weight={700}
            lh={1.15}
            tracking={-0.02}
            accessibilityRole="header"
            style={{ textAlign: 'center' }}
          >
            {model.title}
          </Text>
          <Text size={15} color={theme.colors.ink2} style={{ textAlign: 'center' }}>
            {model.context}
          </Text>
          {model.attention ? (
            <Text
              size={14.5}
              lh={1.4}
              color={theme.colors.ink2}
              accessibilityLiveRegion="polite"
              style={{ textAlign: 'center' }}
            >
              <Text size={14.5} weight={600} color={theme.colors.warn}>
                {runAttentionLabel(rawLocale)}
              </Text>
              {` · ${model.attention}`}
            </Text>
          ) : null}
        </View>

        <View
          style={{
            marginHorizontal: 22,
            gap: 12,
            padding: 16,
            borderRadius: 18,
            backgroundColor: theme.colors.sf,
            borderWidth: 1,
            borderColor: theme.colors.line,
          }}
        >
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={tMobile('screens2.run.progress', { number: model.number })}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(model.progress) }}
            style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.sf2, overflow: 'hidden' }}
          >
            <View
              style={{
                width: `${model.progress}%`,
                height: '100%',
                borderRadius: 3,
                backgroundColor: theme.colors.progress,
              }}
            />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <Text size={14.5} lh={1.4} color={theme.colors.ink2} style={{ flexShrink: 1 }}>
              {model.now}
            </Text>
            {model.tests ? (
              <Text size={12.5} weight={500} mono color={toneColor(theme, model.tests.tone)}>
                {model.tests.text}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
            <Text size={12} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
              {model.branch}
            </Text>
            {model.diff ? (
              <Text size={12} weight={500} mono>
                <Text size={12} weight={500} mono color={theme.colors.ok}>
                  {model.diff.add}
                </Text>{' '}
                <Text size={12} weight={500} mono color={theme.colors.bad}>
                  {model.diff.del}
                </Text>{' '}
                <Text size={12} weight={500} mono color={theme.colors.mut}>
                  {model.diff.files}
                </Text>
              </Text>
            ) : null}
          </View>
          <Text size={13.5} color={theme.colors.mut}>
            {model.askedBy}
          </Text>
        </View>

        {buttons.length > 0 ? (
          <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 22 }}>
            {buttons.map((b) => (
              <Button
                key={b.action}
                label={b.label}
                variant={b.variant}
                busy={control.pending === b.action}
                disabled={control.pending !== null}
                onPress={() => press(b)}
                style={{ flex: 1 }}
              />
            ))}
          </View>
        ) : null}

        <View>
          {model.steps.length > 0 ? (
            <Section title={tMobile('screens.steps')}>
              <View style={{ paddingVertical: 2 }}>
                {model.steps.map((s) => (
                  <StepRow key={s.key} step={s} />
                ))}
              </View>
            </Section>
          ) : null}
          <RunActivity runNumber={model.number} />
          {model.log.length > 0 ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
              <SectionLabel>{tMobile('screens.live-log')}</SectionLabel>
              <View
                accessibilityLabel={tMobile('screens.live-log-2')}
                style={{
                  borderRadius: 16,
                  backgroundColor: theme.colors.code,
                  paddingVertical: 14,
                }}
              >
                {model.log.map((l) => (
                  <View key={l.seq} style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16 }}>
                    <Text size={12.5} lh={1.7} mono color={theme.code.timestamp} style={{ width: 40 }}>
                      {l.at}
                    </Text>
                    <Text size={12.5} lh={1.7} mono color={logColor[l.tone]} style={{ flex: 1 }}>
                      {l.text}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>
      {room || pr ? (
        <View
          style={{
            paddingTop: 14,
            paddingHorizontal: 22,
            paddingBottom: bottomPadding(36, insets.bottom, 14),
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            backgroundColor: theme.colors.bg,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {pr ? (
              <Button
                label={`PR #${pr.number}`}
                variant="secondary"
                size="lg"
                onPress={() =>
                  navigation.navigate('PullRequest', {
                    ...pr,
                    back: tMobile('screens2.run.number', { number: model.number }),
                  })
                }
                accessibilityHint={tMobile('screens.opens-the-pull-request-checks-files-changed-and')}
                style={{ flex: 1 }}
              />
            ) : null}
            {room ? (
              <Button
                label={tMobile('screens.branch-room')}
                variant="secondary"
                size="lg"
                onPress={() => navigation.navigate('Conversation', { conversationId: room.id })}
                style={{ flex: 1 }}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
