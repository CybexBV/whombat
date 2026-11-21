/**
 * A shared plan (work-supervision WS-09: “Mobile gets a plan screen from the plan card”; not mocked). The plan
 * card's header and markers in the run screen's language: `PLAN · 4 STEPS` + due, the title, progress
 * (“2 of 4 done”, cancelled steps not counted), then STEPS — marker, title and state label, the note, links to the
 * run / approval / automation run carrying the step, and its next actions as 44dp buttons. A plan is the agent's own
 * work (Whombat one-agent.md OA-14; app one-agent.md AP-4990): no step has an owner. `stepId` scrolls to that step and
 * marks it. “Add a step” opens a sheet (AP-718). Plan changes come back in the answer and over `plan.updated` (burrow
 * topic).
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { usePlan, usePlanWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { plainMenu } from '../data/nativeMenu';
import {
  type PlanMarker,
  type PlanStateTone,
  type PlanStepButton,
  type PlanStepView,
  planScreen,
  planStepCommand,
} from '../data/plan';
import { canAddStep } from '../data/planAdd';
import { navigateTo, useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { EllipsisVertical } from '../ui/icons';
import { ListRow } from '../ui/ListRow';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { Button, ErrorState, Section, Skeleton, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { AddStepSheet } from './AddStepSheet';
import { errorText, outcomeText } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Plan'>;

/** 16dp markers with a 2dp border (the card's): gate is a warn diamond, blocked a bad circle. */
export function PlanMarkerView({ marker, label }: { marker: PlanMarker; label: string }) {
  const theme = useTheme();
  const border =
    marker === 'done'
      ? theme.colors.ok
      : marker === 'active'
        ? theme.colors.progress
        : marker === 'gate'
          ? theme.colors.warn
          : marker === 'blocked'
            ? theme.colors.bad
            : theme.colors.line2;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        width: 16,
        height: 16,
        borderRadius: marker === 'gate' ? 3 : 8,
        borderWidth: 2,
        borderColor: border,
        backgroundColor: marker === 'done' ? theme.colors.ok : 'transparent',
        ...(marker === 'gate' ? { transform: [{ rotate: '45deg' }, { scale: 0.85 }] } : null),
      }}
    />
  );
}

export function stateColor(theme: ReturnType<typeof useTheme>, tone: PlanStateTone): string {
  switch (tone) {
    case 'ok':
      return theme.colors.ok;
    case 'ink2':
      return theme.colors.ink2;
    case 'warn':
      return theme.colors.warn;
    case 'bad':
      return theme.colors.bad;
    case 'mut':
      return theme.colors.mut;
  }
}

/** A step's ⋯ menu: Start, Mark done and Cancel (the buttons show only where the person is needed). */
function stepMenu(step: PlanStepView) {
  return plainMenu([
    step.more.map((b) => ({ id: b.action, title: b.label, destructive: b.action === 'cancel' })),
  ]);
}

/** A step's ⋯: 44dp, iOS's own menu on iPhone, a sheet elsewhere (`onMore`). */
function StepMore({
  step,
  busy,
  onPick,
  onMore,
}: {
  step: PlanStepView;
  busy: boolean;
  onPick: (id: string) => void;
  onMore: () => void;
}) {
  const theme = useTheme();
  const label = `More for ${step.title}`;
  const face = busy ? (
    <ActivityIndicator size="small" color={theme.colors.mut} />
  ) : (
    <EllipsisVertical size={19} color={theme.colors.ink2} strokeWidth={1.75} />
  );
  return hasNativeMenu ? (
    <NativeMenu spec={stepMenu(step)} onPick={onPick} trigger="tap" label={label} style={MORE_FACE}>
      <View style={MORE_FACE}>{face}</View>
    </NativeMenu>
  ) : (
    <Touchable onPress={onMore} feedback="wash" ringRadius={22} accessibilityLabel={label} style={MORE_FACE}>
      {face}
    </Touchable>
  );
}

const MORE_FACE = {
  width: 44,
  height: 44,
  marginTop: -11,
  marginRight: -10,
  borderRadius: 22,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

function StepRow({
  step,
  focused,
  busy,
  onAction,
  onMore,
  onLayoutY,
}: {
  step: PlanStepView;
  focused: boolean;
  busy: string | null;
  onAction: (step: PlanStepView, button: PlanStepButton) => void;
  onMore: (step: PlanStepView) => void;
  onLayoutY: (y: number) => void;
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const titleColor = step.titleStyle === 'normal' ? theme.colors.ink : theme.colors.mut;
  const pickMore = (id: string) => {
    const button = step.more.find((b) => b.action === id);
    if (button) onAction(step, button);
  };
  const moreBusy = busy !== null && step.more.some((b) => busy === `${step.id}:${b.action}`);
  return (
    <View
      onLayout={(e) => onLayoutY(e.nativeEvent.layout.y)}
      style={{
        gap: 10,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
        backgroundColor: focused ? theme.colors.sel : 'transparent',
      }}
    >
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View
          accessible
          accessibilityLabel={`${step.markerLabel}. ${step.accessibilityLabel}`}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', gap: 12 }}
        >
          <View style={{ width: 22, alignItems: 'center', paddingTop: 3 }}>
            <PlanMarkerView marker={step.marker} label={step.markerLabel} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Text
              size={15.5}
              weight={step.marker === 'active' || step.marker === 'gate' ? 600 : 500}
              color={titleColor}
              style={step.titleStyle === 'struck' ? { textDecorationLine: 'line-through' } : undefined}
            >
              {step.title}
            </Text>
            <Text size={11.5} weight={500} mono color={stateColor(theme, step.stateTone)} numberOfLines={1}>
              {step.stateLabel}
            </Text>
            {step.note ? (
              <Text size={13.5} lh={1.4} color={theme.colors.mut}>
                {step.note}
              </Text>
            ) : null}
          </View>
        </View>
        {step.more.length > 0 ? (
          <StepMore step={step} busy={moreBusy} onPick={pickMore} onMore={() => onMore(step)} />
        ) : null}
      </View>
      {step.links.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 34 }}>
          {step.links.map((l) => (
            <Touchable
              key={l.key}
              onPress={() => navigateTo(navigation, l.route)}
              feedback="wash"
              accessibilityRole="link"
              accessibilityLabel={`Open ${l.label}`}
              ringRadius={999}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 12,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: theme.colors.line2,
              }}
            >
              <Text size={12.5} weight={500} mono color={theme.colors.brand}>
                {`${l.label} ›`}
              </Text>
            </Touchable>
          ))}
        </View>
      ) : null}
      {step.buttons.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 34 }}>
          {step.buttons.map((b) => (
            <Button
              key={b.action}
              label={b.label}
              variant={b.variant}
              busy={busy === `${step.id}:${b.action}`}
              disabled={busy !== null}
              onPress={() => onAction(step, b)}
              style={{ minWidth: 96 }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function PlanScreen({ route, navigation }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const { planId, stepId, back = 'Back' } = route.params;
  const query = usePlan({ params: { burrow: slug, planId } });
  const start = usePlanWrite(api.plans.startStep);
  const update = usePlanWrite(api.plans.updateStep);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The step whose ⋯ sheet is open (where iOS's own menu isn't). */
  const [menuFor, setMenuFor] = useState<PlanStepView | null>(null);
  const scroll = useRef<ScrollView>(null);
  const stepsY = useRef(0);
  const rowsY = useRef(new Map<string, number>());
  /** The step the screen last scrolled to (a new `stepId` on the open screen scrolls again). */
  const scrolledTo = useRef<string | null>(null);
  const scrollToStep = () => {
    const y = stepId ? rowsY.current.get(stepId) : undefined;
    if (!stepId || y === undefined || scrolledTo.current === stepId) return;
    scrolledTo.current = stepId;
    // The section label (≈ 30dp) sits above the group the rows are laid out in.
    const top = stepsY.current + 30 + y - 16;
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: Math.max(0, top), animated: true }));
  };
  const hasPlan = !!query.data;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the focused step or the plan arrives
  useEffect(scrollToStep, [stepId, hasPlan]);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const plan = query.data?.plan;

  if (!plan) {
    const notFound = query.error && 'status' in query.error && query.error.status === 404;
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        {notFound ? (
          <ErrorState text="This plan isn’t here any more." />
        ) : query.error ? (
          <ErrorState text="This plan didn’t load." onRetry={() => void query.refetch()} />
        ) : (
          <View style={{ paddingTop: 10 }} accessibilityLabel="Loading the plan">
            <View style={{ gap: 10, paddingHorizontal: 22, paddingBottom: 22 }}>
              <Skeleton width={120} height={11} />
              <Skeleton width={240} height={22} />
              <Skeleton height={6} radius={3} />
            </View>
            <SkeletonRows count={4} avatarSize={16} lines={2} />
          </View>
        )}
      </Screen>
    );
  }

  const model = planScreen(plan, 'Plan');
  const params = (id: string) => ({ burrow: slug, planId: plan.id, stepId: id });
  const settle = {
    onSuccess: (res: Parameters<typeof outcomeText>[0]) => {
      const text = outcomeText(res);
      if (text) Alert.alert(text.title, text.body);
    },
    onError: (err: unknown) => Alert.alert('That didn’t go through', errorText(err)),
    onSettled: () => setBusy(null),
  };
  const act = (step: PlanStepView, button: PlanStepButton) => {
    const command = planStepCommand(button.action, step);
    if (!command) return;
    if (command.kind === 'open') {
      navigateTo(navigation, command.route);
      return;
    }
    const run = () => {
      setBusy(`${step.id}:${button.action}`);
      if (command.kind === 'start') start.mutate({ params: params(step.id), body: {} }, settle);
      else update.mutate({ params: params(step.id), body: { state: command.state } }, settle);
    };
    if (button.action === 'cancel')
      Alert.alert('Cancel this step?', 'It stays on the plan, struck through, and no longer counts.', [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Cancel step', style: 'destructive', onPress: run },
      ]);
    else run();
  };

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <AddStepSheet plan={plan} visible={adding} onClose={() => setAdding(false)} />
      <MenuSheet
        spec={menuFor ? stepMenu(menuFor) : null}
        visible={menuFor !== null}
        label={menuFor ? `More for ${menuFor.title}` : 'More'}
        onClose={() => setMenuFor(null)}
        onPick={(id) => {
          const step = menuFor;
          const button = step?.more.find((b) => b.action === id);
          if (step && button) act(step, button);
        }}
      />
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 22, paddingTop: 4, paddingBottom: 28 + bottomRoom }}
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
        <View style={{ gap: 10, paddingHorizontal: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {model.label}
            </Text>
            {model.due ? (
              <Text size={11.5} mono color={theme.colors.mut}>
                {model.due}
              </Text>
            ) : null}
          </View>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {model.title}
          </Text>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`${model.title}: ${model.progressText}`}
            accessibilityValue={{ min: 0, max: 100, now: model.progress }}
            style={{ gap: 8, paddingTop: 4 }}
          >
            <View
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
            <Text size={12.5} weight={500} mono color={theme.colors.ink2}>
              {model.progressText}
            </Text>
          </View>
        </View>
        <View onLayout={(e) => (stepsY.current = e.nativeEvent.layout.y)}>
          <Section title="STEPS">
            {model.steps.length === 0 ? (
              <View style={{ padding: 16 }}>
                <Text size={14.5} color={theme.colors.mut}>
                  No steps yet. Add the first one below.
                </Text>
              </View>
            ) : (
              model.steps.map((s) => (
                <StepRow
                  key={s.id}
                  step={s}
                  focused={s.id === stepId}
                  busy={busy}
                  onAction={act}
                  onMore={setMenuFor}
                  onLayoutY={(y) => {
                    rowsY.current.set(s.id, y);
                    if (s.id === stepId) scrollToStep();
                  }}
                />
              ))
            )}
            {canAddStep(plan) ? (
              <ListRow
                title="Add a step"
                trailing="+"
                onPress={() => setAdding(true)}
                accessibilityLabel="Add a step"
              />
            ) : null}
          </Section>
        </View>
      </ScrollView>
    </Screen>
  );
}
