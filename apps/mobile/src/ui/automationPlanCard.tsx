/**
 * A plan for an automation in a chat (Whombat automation-chat.md; the phone's automation-chat-mobile.md), in the
 * device skill card's language at phone width: the state in its colour, the name and the agent's sentence, for a change
 * WHAT CHANGES (`+` added, `−` removed, `~` reworded), Whombat's rows as label and value (the label column narrow
 * enough for a phone), the agent's “How I thought about it”, what the agent is asked folded, and while it waits Turn it
 * on, Try it and Not now with “or reply to change it”. Refusals stay on the card in the server's words; what went
 * through is a toast, and the card folds into its line when the server re-sends it. Opened from its line it is the
 * same card without buttons, with “Hide card”.
 */
import { useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { AUTOMATION_PLAN_TEXT, type PlanCardView, tryItLabel } from '../data/automationPlan';
import { useBurrowBase } from '../data/BurrowProvider';
import { useAppNavigation } from '../navigation/hooks';
import { errorText, outcomeText, showNotice } from '../screens/feedback';
import { SAMPLES_STALE_MS, useAutomationSamples, useStartAutomation } from '../screens/useStartAutomation';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { MonoLabel } from './assistant';
import { HideCardButton } from './chat';
import { ChevronDown, ChevronUp } from './icons';
import { Button } from './primitives';
import { Touchable } from './Touchable';

type Busy = 'accept' | 'decline' | 'try' | null;

export function AutomationPlanCardView({
  view,
  collapse,
}: {
  view: PlanCardView;
  /** Opened from its line: “Hide card” returns the line. */
  collapse?: (() => void) | undefined;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const navigation = useAppNavigation();
  const accept = useApiMutation(api.automations.acceptPlan);
  const decline = useApiMutation(api.automations.declinePlan);
  const { start } = useStartAutomation();
  const samples = useAutomationSamples(
    view.waiting && view.tryIt === 'sample' ? { params: { burrow: slug, id: view.automationId } } : null,
    { staleTime: SAMPLES_STALE_MS, retry: false },
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [askedOpen, setAskedOpen] = useState(false);
  const kind = view.change ? 'change' : 'new';
  const params = { burrow: slug, planId: view.planId };

  const turnOn = () => {
    setProblem(null);
    setBusy('accept');
    accept
      .mutateAsync({ params })
      .then(
        (result) => {
          if (result.status !== 'ok') return setProblem(outcomeText(result)?.body ?? errorText(null));
          showNotice(AUTOMATION_PLAN_TEXT.turnedOn[kind](view.name));
        },
        (error) => setProblem(errorText(error)),
      )
      .finally(() => setBusy(null));
  };
  const notNow = () => {
    setProblem(null);
    setBusy('decline');
    decline
      .mutateAsync({ params })
      .then(
        (result) => {
          if (result.status !== 'ok') return setProblem(outcomeText(result)?.body ?? errorText(null));
          showNotice(AUTOMATION_PLAN_TEXT.setAside[kind](view.name));
        },
        (error) => setProblem(errorText(error)),
      )
      .finally(() => setBusy(null));
  };
  const tryIt = () => {
    setProblem(null);
    setBusy('try');
    void start(view.automationId, { test: true, tryIt: view.tryIt }).then((outcome) => {
      setBusy(null);
      if (!outcome.ok) return setProblem(outcome.text);
      showNotice(AUTOMATION_PLAN_TEXT.trying(view.name, outcome.sample?.number ?? null));
      navigation.navigate('AutomationRun', { number: outcome.runNumber, back: 'Back' });
    });
  };

  const stateColor =
    view.tone === 'warn' ? theme.colors.warn : view.tone === 'ok' ? theme.colors.ok : theme.colors.mut;
  const signColor = (tone: PlanCardView['changes'][number]['tone']) =>
    tone === 'ok' ? theme.colors.ok : tone === 'bad' ? theme.colors.bad : theme.colors.mut;
  const tryLabel = tryItLabel(view.tryIt, samples.isError ? [] : samples.data?.samples);

  return (
    <View
      style={{
        marginTop: 8,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        paddingTop: 14,
        paddingHorizontal: 16,
        paddingBottom: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View
          accessible
          accessibilityLabel={view.accessibilityLabel}
          style={{ flex: 1, minWidth: 0, gap: 6 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: stateColor }} />
            <Text size={11} weight={500} mono tracking={0.05} color={stateColor} style={{ flexShrink: 1 }}>
              {view.status}
            </Text>
          </View>
          <Text size={19} weight={700} tracking={-0.01} lh={1.25}>
            {view.name}
          </Text>
          {view.description ? (
            <Text size={15} lh={1.5} color={theme.colors.ink2}>
              {view.description}
            </Text>
          ) : null}
        </View>
        {collapse ? <HideCardButton onPress={collapse} /> : null}
      </View>

      {view.changes.length ? (
        <View
          style={{
            marginTop: 10,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.hi,
            paddingVertical: 8,
            paddingHorizontal: 12,
            gap: 4,
          }}
        >
          <MonoLabel>{AUTOMATION_PLAN_TEXT.whatChanges}</MonoLabel>
          {view.changes.map((c) => (
            <View
              key={c.key}
              accessible
              accessibilityLabel={c.accessibilityLabel}
              style={{ flexDirection: 'row', alignItems: 'flex-start' }}
            >
              <Text size={14.5} lh={1.45} weight={700} color={signColor(c.tone)} style={{ width: 18 }}>
                {c.sign}
              </Text>
              <Text size={14.5} lh={1.45} style={{ flex: 1 }}>
                {c.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {view.sections.length ? (
        <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
          {view.sections.map((s) => (
            <View
              key={s.key}
              accessible
              accessibilityLabel={s.accessibilityLabel}
              style={{
                flexDirection: 'row',
                gap: 10,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.line,
              }}
            >
              <Text
                size={11}
                weight={500}
                mono
                tracking={0.05}
                color={theme.colors.mut}
                style={{ width: 80, paddingTop: 3 }}
              >
                {s.label}
              </Text>
              <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                {s.lines.map((l) => (
                  <View key={l.key}>
                    <Text size={14.5} lh={1.45}>
                      {l.text}
                    </Text>
                    {l.detail ? (
                      <Text size={13.5} lh={1.4} color={theme.colors.mut}>
                        {l.detail}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {view.thinking.length ? (
        <View
          style={{
            marginTop: 10,
            borderRadius: 12,
            backgroundColor: theme.colors.sf2,
            paddingVertical: 10,
            paddingHorizontal: 13,
            gap: 6,
          }}
        >
          <Text size={14} weight={600} accessibilityRole="header">
            {AUTOMATION_PLAN_TEXT.thinking}
          </Text>
          {view.thinking.map((point) => (
            <View key={point} style={{ flexDirection: 'row', gap: 8 }}>
              <Text size={14} lh={1.45} color={theme.colors.mut} importantForAccessibility="no">
                •
              </Text>
              <Text size={14} lh={1.45} color={theme.colors.ink2} style={{ flex: 1 }}>
                {point}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {view.asked.prompts.length ? (
        <View style={{ marginTop: 4 }}>
          <Touchable
            onPress={() => setAskedOpen((open) => !open)}
            feedback="wash"
            accessibilityLabel={view.asked.title}
            accessibilityState={{ expanded: askedOpen }}
            ringRadius={10}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10 }}
          >
            {askedOpen ? (
              <ChevronUp size={16} color={theme.colors.mut} strokeWidth={2} />
            ) : (
              <ChevronDown size={16} color={theme.colors.mut} strokeWidth={2} />
            )}
            <Text size={14} weight={600}>
              {view.asked.title}
            </Text>
          </Touchable>
          {askedOpen ? (
            <View style={{ gap: 10, paddingBottom: 4 }}>
              {view.asked.prompts.map((p) => (
                <View key={p.key} style={{ gap: 2 }}>
                  <Text size={13.5} weight={600}>
                    {p.step}
                  </Text>
                  <Text size={13.5} lh={1.45} color={theme.colors.ink2} selectable>
                    {p.text}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {view.waiting ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <Button
            label={view.accept}
            onPress={turnOn}
            busy={busy === 'accept'}
            disabled={busy !== null && busy !== 'accept'}
            accessibilityHint={AUTOMATION_PLAN_TEXT.acceptHint[kind](view.name)}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={tryLabel}
              variant="secondary"
              onPress={tryIt}
              busy={busy === 'try'}
              disabled={busy !== null && busy !== 'try'}
              accessibilityHint={AUTOMATION_PLAN_TEXT.tryHint}
              style={{ flex: 1 }}
            />
            <Button
              label={view.decline}
              variant="secondary"
              onPress={notNow}
              busy={busy === 'decline'}
              disabled={busy !== null && busy !== 'decline'}
              accessibilityHint={AUTOMATION_PLAN_TEXT.declineHint[kind]}
              style={{ flex: 1 }}
            />
          </View>
          {problem ? (
            <Text size={13.5} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
              {problem}
            </Text>
          ) : null}
          <Text size={13.5} lh={1.4} color={theme.colors.mut}>
            {AUTOMATION_PLAN_TEXT.replyHint}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
