/**
 * The council of Settings → the assistant → Council, being changed (Whombat docs/decisions/council.md; app
 * council-phone.md): only its most rounds and the score to reach (as the app's menu: iOS's own on iPhone, a sheet
 * elsewhere), since who sits is T3 Code's own council. It opens on the person's rounds and score, else the usual ones.
 * What keeps it from being saved shows over Save, which stays off. Save keeps it, with T3 Code's seats as they came (a
 * toast, then back). The server's refusal shows in its own words; an older Whombat (`unknown_op`) says it needs an
 * update. Leaving with unsaved changes asks first.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { councilSetupWords } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase } from '../data/BurrowProvider';
import { councilActionProblem, olderWhombat } from '../data/council';
import {
  COUNCIL_ROUND_CHOICES,
  type CouncilDraft,
  councilCanSave,
  councilDraftBody,
  councilDraftCheck,
  councilDraftFor,
  councilTargetPicker,
  sameCouncilDraft,
} from '../data/councilSetups';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { haptic } from '../ui/haptics';
import { BackBar, Screen } from '../ui/headers';
import { bottomPadding } from '../ui/insets';
import { PickerRow } from '../ui/pickerRow';
import { Button, ErrorState, Section, SkeletonRows } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { useCouncilSetup } from './agent/CouncilPart';
import { useUnsavedGuard } from './agent/parts';
import { outcomeText, showNotice } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'SettingsCouncil'>;

export function CouncilSetupScreen({ navigation }: Props) {
  const { rawLocale } = useI18n();
  const councilSetupWordsHere = councilSetupWords(rawLocale);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { slug } = useBurrowBase();
  const assistant = useAgentWords().name;
  const query = useCouncilSetup({ params: { burrow: slug } }, { retry: false });
  const data = query.data;
  const original = useMemo(() => (data ? councilDraftFor(data) : null), [data]);
  const [edits, setEdits] = useState<CouncilDraft | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const draft = edits ?? original;
  const dirty = !!edits && !!original && !sameCouncilDraft(edits, original);
  const guard = useUnsavedGuard(assistant, councilSetupWordsHere.title);
  const { onDirtyChange } = guard;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const save = useApiMutation(api.councils.saveSetup);
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('SettingsAgent', { part: 'council' });

  const change = (next: CouncilDraft) => {
    setEdits(next);
    setRefusal(null);
  };

  const options = data?.options ?? null;
  const check = draft ? councilDraftCheck(draft) : null;
  const busy = save.isPending;
  const canSave =
    !!draft && !!original && !!options && councilCanSave(draft, original, !!data?.setup) && !busy;

  const onSave = () => {
    if (!draft || !canSave) return;
    save.mutate(
      { params: { burrow: slug }, body: councilDraftBody(draft) },
      {
        onSuccess: (result) => {
          const text = outcomeText(result, rawLocale);
          if (text) return setRefusal(text.title);
          haptic('success');
          showNotice(councilSetupWordsHere.saved);
          void qc.invalidateQueries({ queryKey: queryKeys.scope('councils.setup', { burrow: slug }) });
          guard.leave(goBack);
        },
        onError: (error) => setRefusal(councilActionProblem(error, rawLocale)),
      },
    );
  };

  return (
    <Screen>
      <BackBar label={assistant} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 28 }}
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {councilSetupWordsHere.title}
          </Text>
        </View>
        {!data ? (
          query.error ? (
            <ErrorState
              text={councilActionProblem(query.error, rawLocale)}
              {...(olderWhombat(query.error) ? {} : { onRetry: () => void query.refetch() })}
            />
          ) : (
            <SkeletonRows count={3} lines={2} label={councilSetupWordsHere.title} />
          )
        ) : !options ? (
          <Quiet>{councilSetupWordsHere.t3[data.t3 === 'ready' ? 'unreachable' : data.t3]}</Quiet>
        ) : draft ? (
          <CouncilForm draft={draft} onChange={change} />
        ) : null}
      </ScrollView>
      {draft && options ? (
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
          {refusal ? (
            <Text size={13.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
              {refusal}
            </Text>
          ) : check?.problem ? (
            <Text size={13.5} lh={1.4} color={theme.colors.mut} accessibilityLiveRegion="polite">
              {check.problem}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button
              label={councilSetupWordsHere.cancel}
              variant="secondary"
              size="lg"
              onPress={goBack}
              style={{ flex: 1 }}
            />
            <Button
              label={councilSetupWordsHere.save}
              size="lg"
              onPress={onSave}
              busy={save.isPending}
              disabled={!canSave}
              {...(check?.problem ? { accessibilityHint: check.problem } : {})}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

/** The form itself: rounds and score. */
function CouncilForm({ draft, onChange }: { draft: CouncilDraft; onChange: (next: CouncilDraft) => void }) {
  const { rawLocale } = useI18n();
  const councilSetupWordsHere = councilSetupWords(rawLocale);
  const target = councilTargetPicker(draft, rawLocale);
  return (
    <Section>
      <View style={{ paddingTop: 12, paddingHorizontal: 16, gap: 10 }}>
        <Text size={15.5} weight={500}>
          {councilSetupWordsHere.rounds}
        </Text>
        <Segmented<string>
          label={councilSetupWordsHere.rounds}
          options={COUNCIL_ROUND_CHOICES}
          value={String(draft.rounds)}
          onChange={(v) => onChange({ ...draft, rounds: Number(v) })}
        />
      </View>
      <Hint>{councilSetupWordsHere.roundsHint}</Hint>
      <PickerRow {...target} onPick={(id) => onChange({ ...draft, target: Number(id) })} last />
      <Hint last>{councilSetupWordsHere.targetHint}</Hint>
    </Section>
  );
}

/** A quiet line on the page. */
function Quiet({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {children}
      </Text>
    </View>
  );
}

/** What a choice above it means, in the card (a line under it unless it is the last). */
function Hint({ children, last = false }: { children: ReactNode; last?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingTop: 6,
        paddingBottom: 12,
        paddingHorizontal: 16,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: theme.colors.line }),
      }}
    >
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {children}
      </Text>
    </View>
  );
}
