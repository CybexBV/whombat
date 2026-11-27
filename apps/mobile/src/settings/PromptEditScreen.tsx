/**
 * A prompt being kept or changed (Whombat docs/decisions/prompts.md; app prompts-phone.md): its Title and its words
 * (Prompt, many lines, both to core's limits), “For a repository” with its hint and, on one that is, “Let it reshape
 * the code” and “Merge into main when it’s done” with their hints and the AI its T3 Code thread runs on (the delegation checklist's AI sheet, “T3 Code’s
 * default” when none); Cancel and Save under it, as the council's editor has them, and Remove (asked first) on one
 * that is kept already. It opens from Settings → You → Prompts, or from Save as prompt in a message's menu with the
 * message's words and a title from their first line; that one goes back to the chat once saved, with “Saved to your
 * prompts”. Why it couldn't be saved shows over Save. Leaving with changes not saved asks first.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { problemText, promptWords } from '@whombat/client';
import { queryHook } from '@whombat/client/react';
import { api, PROMPT_TEXT_MAX, PROMPT_TITLE_MAX } from '@whombat/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  type PromptDraft,
  promptAiFromMenu,
  promptAiLine,
  promptAiShown,
  promptCanSave,
  promptDraftBody,
  promptDraftFor,
  samePromptDraft,
} from '../data/prompts';
import { usePrompts, usePromptWrites } from '../data/usePrompts';
import { useI18n, useMobileT } from '../i18n';
import { Card } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { DelegationAiSheet } from '../screens/DelegationAiSheet';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField } from '../ui/formField';
import { haptic } from '../ui/haptics';
import { BackBar, Screen } from '../ui/headers';
import { ChevronsUpDown } from '../ui/icons';
import { bottomPadding } from '../ui/insets';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'PromptEdit'>;

/** `delegations.models`: what T3 Code runs, for the AI a prompt's thread runs on. */
const useDelegationModels = queryHook(api.delegations.models);

export function PromptEditScreen({ navigation, route }: Props) {
  const { rawLocale } = useI18n();
  const promptWordsHere = promptWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug } = useBurrowBase();
  const promptId = route.params?.promptId ?? null;
  const fromText = route.params?.fromText ?? null;
  const here = usePrompts();
  const prompt = promptId ? (here.prompts?.find((p) => p.id === promptId) ?? null) : null;
  const waiting = !!promptId && !here.prompts && !here.error;
  const original = useMemo(
    () => (promptId ? (prompt ? promptDraftFor(prompt) : null) : promptDraftFor(null, fromText)),
    [promptId, prompt, fromText],
  );
  const [edits, setEdits] = useState<PromptDraft | null>(null);
  const draft = edits ?? original;
  const [problem, setProblem] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiOpening, setAiOpening] = useState(0);
  const writes = usePromptWrites();
  const busy = writes.create.isPending || writes.save.isPending || writes.remove.isPending;
  const models = useDelegationModels(
    { params: { burrow: slug } },
    { enabled: aiOpen || !!draft?.ai, retry: false },
  );
  const options = models.data?.options ?? null;

  // Leaving with changes not saved asks first; after a save or a remove it doesn't.
  const dirty = !!draft && (promptId ? !!original && !samePromptDraft(draft, original) : !!edits);
  const guard = useRef({ dirty, leaving: false });
  guard.current.dirty = dirty;
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (!guard.current.dirty || guard.current.leaving) return;
        e.preventDefault();
        Alert.alert(tMobile('settings2.leave.title'), tMobile('settings2.prompts.leave'), [
          { text: tMobile('settings2.leave.stay'), style: 'cancel' },
          {
            text: tMobile('settings2.leave.discard'),
            style: 'destructive',
            onPress: () => navigation.dispatch(e.data.action),
          },
        ]);
      }),
    [navigation, tMobile],
  );
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('SettingsPrompts');
  const leave = () => {
    guard.current.leaving = true;
    goBack();
  };
  // A prompt that is gone (removed elsewhere) has nothing to change here.
  const gone = !!promptId && !!here.prompts && !prompt && !busy;
  useEffect(() => {
    if (!gone || guard.current.leaving) return;
    guard.current.leaving = true;
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('SettingsPrompts');
  }, [gone, navigation]);

  const change = (next: Partial<PromptDraft>) => {
    if (!draft) return;
    setEdits({ ...draft, ...next });
    setProblem(null);
  };
  const canSave = !!draft && promptCanSave(draft, promptId ? original : null) && !busy;
  const failed = (error: unknown) => setProblem(problemText(error, promptWordsHere.failed, rawLocale));
  const onSave = () => {
    if (!draft || !canSave) return;
    const body = promptDraftBody(draft);
    const done = (status: string) => {
      if (status !== 'ok') return setProblem(promptWordsHere.failed);
      haptic('success');
      if (!promptId) showNotice(promptWordsHere.saved);
      leave();
    };
    if (promptId)
      writes.save.mutate(
        { params: { burrow: slug, promptId }, body },
        { onSuccess: (r) => done(r.status), onError: failed },
      );
    else
      writes.create.mutate(
        { params: { burrow: slug }, body },
        { onSuccess: (r) => done(r.status), onError: failed },
      );
  };
  const onRemove = () => {
    if (!promptId || !prompt) return;
    Alert.alert(promptWordsHere.removeAsk(prompt.title), undefined, [
      { text: promptWordsHere.cancel, style: 'cancel' },
      {
        text: promptWordsHere.remove,
        style: 'destructive',
        onPress: () =>
          writes.remove.mutate(
            { params: { burrow: slug, promptId } },
            {
              onSuccess: (r) => {
                if (r.status !== 'ok') return setProblem(promptWordsHere.failed);
                haptic('success');
                leave();
              },
              onError: failed,
            },
          ),
      },
    ]);
  };

  const title = promptId ? promptWordsHere.edit : promptWordsHere.add;
  const back = (
    <BackBar label={fromText === null ? promptWordsHere.title : tMobile('managed.back')} onPress={goBack} />
  );
  if (!draft)
    return (
      <Screen>
        {back}
        {waiting ? (
          <Loading />
        ) : (
          <ErrorState
            text={problemText(here.error, promptWordsHere.failed, rawLocale)}
            onRetry={here.refetch}
          />
        )}
      </Screen>
    );
  const aiValue = promptAiLine(draft.ai, options, rawLocale);
  return (
    <Screen>
      {back}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28, gap: 18 }}
        >
          <Text
            size={25}
            weight={700}
            lh={1.15}
            tracking={-0.02}
            accessibilityRole="header"
            style={{ paddingHorizontal: 6 }}
          >
            {title}
          </Text>
          <FormField
            label={promptWordsHere.fieldTitle}
            value={draft.title}
            onChangeText={(t) => change({ title: t })}
            maxLength={PROMPT_TITLE_MAX}
            returnKeyType="next"
          />
          <FormField
            label={promptWordsHere.fieldText}
            value={draft.text}
            onChangeText={(t) => change({ text: t })}
            maxLength={PROMPT_TEXT_MAX}
            multiline
            textAlignVertical="top"
          />
          <Card>
            <SwitchRow
              first
              title={promptWordsHere.onRepository}
              hint={promptWordsHere.onRepositoryHint}
              on={draft.onRepository}
              onChange={(on) => change({ onRepository: on })}
            />
            {draft.onRepository ? (
              <>
                <SwitchRow
                  title={promptWordsHere.ownIt}
                  hint={promptWordsHere.ownItHint}
                  on={draft.ownIt}
                  onChange={(on) => change({ ownIt: on })}
                />
                <SwitchRow
                  title={promptWordsHere.merge}
                  hint={promptWordsHere.mergeHint}
                  on={draft.merge}
                  onChange={(on) => change({ merge: on })}
                />
                <Touchable
                  onPress={() => {
                    setAiOpening((n) => n + 1);
                    setAiOpen(true);
                  }}
                  feedback="wash"
                  accessibilityLabel={`${promptWordsHere.ai}: ${aiValue}`}
                  style={{
                    minHeight: 48,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    paddingHorizontal: 16,
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.line,
                  }}
                >
                  <Text size={15.5} weight={500} numberOfLines={1} style={{ flexShrink: 0 }}>
                    {promptWordsHere.ai}
                  </Text>
                  <Text
                    size={15}
                    color={theme.colors.ink2}
                    numberOfLines={1}
                    style={{ flex: 1, minWidth: 0, textAlign: 'right' }}
                  >
                    {aiValue}
                  </Text>
                  <ChevronsUpDown size={16} color={theme.colors.mut} strokeWidth={2} />
                </Touchable>
              </>
            ) : null}
          </Card>
          {promptId && prompt ? (
            <Button label={promptWordsHere.remove} variant="quiet" onPress={onRemove} disabled={busy} />
          ) : null}
        </ScrollView>
        <View
          style={{
            gap: 10,
            paddingTop: 14,
            paddingHorizontal: 22,
            paddingBottom: bottomPadding(36, insets.bottom, 14),
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            backgroundColor: theme.colors.bg,
          }}
        >
          {problem ? (
            <Text size={13.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
              {problem}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button
              label={promptWordsHere.cancel}
              variant="secondary"
              size="lg"
              onPress={goBack}
              style={{ flex: 1 }}
            />
            <Button
              label={promptWordsHere.save}
              size="lg"
              onPress={onSave}
              busy={writes.create.isPending || writes.save.isPending}
              disabled={!canSave}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
      <DelegationAiSheet
        visible={aiOpen}
        opening={aiOpening}
        title={promptWordsHere.ai}
        subtitle={draft.title.trim() || null}
        first={promptWordsHere.aiDefault}
        current={promptAiShown(draft.ai, options)}
        models={models.data}
        error={models.error}
        onClose={() => setAiOpen(false)}
        onDone={(menu, opts) => {
          setAiOpen(false);
          change({ ai: promptAiFromMenu(menu, opts) });
        }}
      />
    </Screen>
  );
}

/** A switch with what it does under its name, as the app's other switch rows in a card. */
function SwitchRow({
  title,
  hint,
  on,
  onChange,
  first = false,
}: {
  title: string;
  hint: string;
  on: boolean;
  onChange: (on: boolean) => void;
  first?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={600}>
          {title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {hint}
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={onChange}
        accessibilityLabel={title}
        accessibilityHint={hint}
        accessibilityRole="switch"
        {...switchColors(theme, on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
