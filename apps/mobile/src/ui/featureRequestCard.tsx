/**
 * A tracker's feature request put to the person, in a chat (docs/app/decisions/report-trackers.md), in the automation
 * plan card's language at phone width: FEATURE REQUEST with the agent's value as a chip, the request's title and where
 * it is from, the agent's sentence and why that value, what the customer reads either way folded, and while it waits
 * Approve, Approve and build (when the automation builds), Decline and Ask the customer, wrapping onto lines on a
 * narrow phone, with “Reply in this thread to ask Dusty about it.” under them. Decline and Ask open their form in place
 * of the buttons; the field keeps clear of the keyboard in a thread (`useRevealInList`). A refusal stays on the card in
 * the server's words (one that no longer waits reads the messages again); what went through is a toast, the card says
 * what was decided at once, and it folds into its line when the server re-sends it. Opened from its line it is the same
 * card with what was decided in place of the buttons, and “Hide card”.
 */

import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  canSendNote,
  FEATURE_NOTE_MAX,
  type FeatureForm,
  featureCardText,
  featureDecideBody,
  featureDecidedToast,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import { api, type FeatureDecisionChoice, featureRequestWords } from '@whombat/core';
import { useRef, useState } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  type FeatureRequestCardView as CardView,
  featureCardHints,
  featureRequestCardView,
} from '../data/featureRequest';
import { useI18n } from '../i18n';
import { errorText, outcomeText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { HideCardButton } from './chat';
import { FormField } from './formField';
import { ChevronDown, ChevronUp } from './icons';
import { Button } from './primitives';
import { useRevealInList } from './revealInList';
import { Touchable } from './Touchable';

/**
 * A button in a row that wraps: as wide as its words, the line's room shared out, never wider than the card (at the
 * largest text size its words end in “…”).
 */
const GROW: StyleProp<ViewStyle> = { flexGrow: 1, maxWidth: '100%' };

export function FeatureRequestCardView({
  view,
  collapse,
}: {
  view: CardView;
  /** Opened from its line: “Hide card” returns the line. */
  collapse?: (() => void) | undefined;
}) {
  const { rawLocale } = useI18n();
  const featureCardTextHere = featureCardText(rawLocale);
  const featureRequestWordsHere = featureRequestWords(rawLocale);
  const featureCardHintsHere = featureCardHints(rawLocale);

  const theme = useTheme();
  const { slug, people } = useBurrowBase();
  const qc = useQueryClient();
  const decide = useApiMutation(api.tracker.decide);
  const reveal = useRevealInList();
  const formRef = useRef<View>(null);
  const [form, setForm] = useState<FeatureForm | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<FeatureDecisionChoice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [readsOpen, setReadsOpen] = useState(false);
  // What the server answered, until it re-sends the card (which then shows as its line).
  const [answered, setAnswered] = useState<CardView | null>(null);
  const shown = view.waiting ? (answered ?? view) : view;
  const W = featureRequestWordsHere;

  const send = (choice: FeatureDecisionChoice, text?: string) => {
    if (busy) return;
    setProblem(null);
    setBusy(choice);
    decide
      .mutateAsync({
        params: { burrow: slug, requestId: view.requestId },
        body: featureDecideBody(choice, text),
      })
      .then(
        (result) => {
          if (result.status !== 'ok')
            return setProblem(outcomeText(result, rawLocale)?.body ?? errorText(null, rawLocale));
          setAnswered(featureRequestCardView(result.data.request, people, rawLocale));
          setForm(null);
          showNotice(featureDecidedToast(choice, view.agent, rawLocale));
        },
        (error) => {
          // A request that no longer waits is a conflict, in the server's words: someone may have answered first, so
          // the messages are read again and the card shows where it is.
          setProblem(errorText(error, rawLocale));
          if (error instanceof ApiError && error.status === 409) {
            void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
            void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list') });
          }
        },
      )
      .finally(() => setBusy(null));
  };
  const open = (which: FeatureForm) => {
    setProblem(null);
    setNote(which === 'decline' ? view.declineReason : '');
    setForm(which);
  };
  const close = () => {
    setProblem(null);
    setForm(null);
  };

  const outcome = shown.outcome;
  const outcomeColor =
    outcome?.tone === 'ok'
      ? theme.colors.ok
      : outcome?.tone === 'bad'
        ? theme.colors.bad
        : outcome?.tone === 'warn'
          ? theme.colors.warn
          : theme.colors.mut;
  const dot = shown.waiting ? theme.colors.warn : outcomeColor;
  const problemLine = problem ? (
    <Text size={13.5} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
      {problem}
    </Text>
  ) : null;

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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot }} />
          <Text
            size={11}
            weight={500}
            mono
            tracking={0.05}
            uppercase
            color={theme.colors.mut}
            accessibilityRole="header"
            style={{ flexShrink: 1 }}
          >
            {shown.label}
          </Text>
        </View>
        <View
          accessible
          accessibilityLabel={shown.valueLabel}
          style={{
            borderRadius: 999,
            paddingVertical: 3,
            paddingHorizontal: 9,
            backgroundColor: theme.colors.sf2,
          }}
        >
          <Text size={11.5} weight={600} mono color={theme.colors.ink2}>
            {shown.value}
          </Text>
        </View>
        {collapse ? <HideCardButton onPress={collapse} /> : null}
      </View>

      <View style={{ marginTop: 8, gap: 2 }}>
        <Text size={17} weight={700} tracking={-0.01} lh={1.3}>
          {shown.title}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut}>
          {shown.from}
        </Text>
      </View>
      {shown.summary ? (
        <Text size={15} lh={1.5} color={theme.colors.ink2} style={{ marginTop: 8 }}>
          {shown.summary}
        </Text>
      ) : null}
      {shown.valueWhy ? (
        <Text size={14} lh={1.45} color={theme.colors.mut} style={{ marginTop: 4 }}>
          {shown.valueWhy}
        </Text>
      ) : null}

      {shown.reads.length ? (
        <View style={{ marginTop: 4 }}>
          <Touchable
            onPress={() => setReadsOpen((o) => !o)}
            feedback="wash"
            accessibilityLabel={featureCardTextHere.reads}
            accessibilityState={{ expanded: readsOpen }}
            ringRadius={10}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10 }}
          >
            {readsOpen ? (
              <ChevronUp size={16} color={theme.colors.mut} strokeWidth={2} />
            ) : (
              <ChevronDown size={16} color={theme.colors.mut} strokeWidth={2} />
            )}
            <Text size={14} weight={600}>
              {featureCardTextHere.reads}
            </Text>
          </Touchable>
          {readsOpen ? (
            <View style={{ gap: 12, paddingBottom: 4 }}>
              {shown.reads.map((r) => (
                <View key={r.id} style={{ gap: 6 }}>
                  <Text size={13.5} weight={600}>
                    {r.label}
                  </Text>
                  {/* Exactly what the customer would get, signed: plain text, never Markdown. */}
                  <View
                    style={{
                      borderLeftWidth: 3,
                      borderLeftColor: theme.colors.line2,
                      backgroundColor: theme.colors.sf2,
                      borderRadius: 8,
                      paddingVertical: 8,
                      paddingHorizontal: 11,
                    }}
                  >
                    <Text size={13.5} lh={1.45} color={theme.colors.ink2} selectable>
                      {r.text}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {!shown.waiting && outcome ? (
        // What was decided, in place of the buttons.
        <View style={{ marginTop: 12, gap: 2 }} accessible accessibilityLiveRegion="polite">
          <Text size={14.5} weight={600} lh={1.4} color={outcomeColor}>
            {outcome.lead}
          </Text>
          {outcome.detail ? (
            <Text size={14} lh={1.45} color={theme.colors.ink2}>
              {outcome.detail}
            </Text>
          ) : null}
        </View>
      ) : null}

      {shown.waiting && form ? (
        // Decline's reason or the question, in place of the buttons; kept clear of the keyboard in a thread (the list
        // measures it, so Android mustn't flatten it away).
        <View ref={formRef} collapsable={false} style={{ marginTop: 12, gap: 10 }}>
          <FormField
            label={form === 'decline' ? W.declineLabel : W.askLabel}
            value={note}
            onChangeText={(v) => {
              setNote(v);
              setProblem(null);
            }}
            hint={form === 'decline' ? W.declineHint(shown.agent) : W.askHint(shown.agent)}
            multiline
            maxLength={FEATURE_NOTE_MAX}
            editable={busy === null}
            // Asking starts empty, so the cursor goes there; a decline has the agent's reason ready to send.
            autoFocus={form === 'ask'}
            onFocus={() => reveal?.(formRef.current)}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button
              label={form === 'decline' ? W.declineSend : W.askSend}
              onPress={() => send(form, note)}
              busy={busy === form}
              disabled={!canSendNote(note) || (busy !== null && busy !== form)}
              accessibilityHint={featureCardHintsHere[form](shown.agent)}
              style={GROW}
            />
            <Button
              label={W.cancel}
              variant="secondary"
              onPress={close}
              disabled={busy !== null}
              style={GROW}
            />
          </View>
          {problemLine}
        </View>
      ) : null}

      {shown.waiting && !form ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button
              label={W.approve}
              onPress={() => send('approve')}
              busy={busy === 'approve'}
              disabled={busy !== null && busy !== 'approve'}
              accessibilityHint={featureCardHintsHere.approve(shown.agent)}
              style={GROW}
            />
            {shown.canBuild ? (
              <Button
                label={W.build}
                variant="secondary"
                onPress={() => send('build')}
                busy={busy === 'build'}
                disabled={busy !== null && busy !== 'build'}
                accessibilityHint={featureCardHintsHere.build(shown.agent)}
                style={GROW}
              />
            ) : null}
            <Button
              label={W.decline}
              variant="secondary"
              onPress={() => open('decline')}
              disabled={busy !== null}
              accessibilityHint={featureCardHintsHere.opensDecline}
              style={GROW}
            />
            <Button
              label={W.ask}
              variant="secondary"
              onPress={() => open('ask')}
              disabled={busy !== null}
              accessibilityHint={featureCardHintsHere.opensAsk}
              style={GROW}
            />
          </View>
          {problemLine}
        </View>
      ) : null}

      {shown.waiting ? (
        <Text size={13.5} lh={1.4} color={theme.colors.mut} style={{ marginTop: 10 }}>
          {W.askAgent(shown.agent)}
        </Text>
      ) : null}
    </View>
  );
}
