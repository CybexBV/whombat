/**
 * The AI menu of the delegation checklist (Whombat docs/decisions/delegate.md; app delegation-phone.md): a bottom sheet
 * for one task (“AI for task 2” over its title) or for every task (“AI for every task” over “2 of 3 use this”). Model:
 * the default first (“Same as the others”, or “T3 Code’s default”), then the models T3 Code runs, each with its company;
 * Effort: the chosen model's efforts as pills that wrap, its own default on until changed; Fast with its switch where the
 * model has a fast tier; then Cancel and Done. It draws as the chat's “answers with” sheet does (its model rows, effort
 * pills and fast row). What T3 Code runs is asked for when the sheet opens. Every word and rule is `@whombat/client`'s
 * (`delegationAi.ts`), shared with the web.
 */
import {
  DELEGATION_AI_WORDS,
  type DelegationAiDraft,
  delegationAiDraft,
  delegationAiMenu,
  problemText,
  withAiModel,
} from '@whombat/client';
import type { CouncilProviderOption, DelegationAi, DelegationModelsResponse } from '@whombat/core';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { delegationAiModelRows } from '../data/delegation';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { EffortPill, FastRow, ModelRows } from './ChatRuntimeSheet';

export interface DelegationAiSheetProps {
  visible: boolean;
  /** Changes each time the sheet opens: the menu starts again from what the card says. */
  opening: number;
  title: string;
  subtitle: string | null;
  /** The first model: the default (“Same as the others”, “T3 Code’s default”). */
  first: string;
  /** What the card says now for this task (or every task). */
  current: DelegationAi | null;
  /** What T3 Code runs, once asked; `error` when asking didn't work. */
  models: DelegationModelsResponse | undefined;
  error: unknown;
  onClose: () => void;
  /** Done: the menu as it was left, with what T3 Code runs. */
  onDone: (draft: DelegationAiDraft, options: readonly CouncilProviderOption[]) => void;
}

export function DelegationAiSheet(props: DelegationAiSheetProps) {
  return (
    <Sheet
      visible={props.visible}
      onClose={props.onClose}
      label={props.title}
      closeLabel={DELEGATION_AI_WORDS.cancel}
      surface="sf"
      maxHeight="90%"
    >
      <AiMenu key={props.opening} {...props} />
    </Sheet>
  );
}

function AiMenu({ title, subtitle, first, current, models, error, onClose, onDone }: DelegationAiSheetProps) {
  const theme = useTheme();
  const [draft, setDraft] = useState<DelegationAiDraft>(() => delegationAiDraft(current));
  const options = models?.options ?? null;
  const menu = options ? delegationAiMenu(options, draft, current) : null;
  const quiet = !models
    ? error
      ? problemText(error, DELEGATION_AI_WORDS.t3.unreachable)
      : DELEGATION_AI_WORDS.loading
    : options
      ? null
      : DELEGATION_AI_WORDS.t3[models.t3 === 'ready' ? 'unreachable' : models.t3];
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
      <View style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 12, gap: 3 }}>
        <Text size={18} weight={700} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text size={13.5} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {quiet ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 18,
            paddingBottom: 12,
          }}
        >
          {!models && !error ? <ActivityIndicator size="small" color={theme.colors.mut} /> : null}
          <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ flex: 1 }}>
            {quiet}
          </Text>
        </View>
      ) : null}
      {menu && options ? (
        <>
          <Label text={DELEGATION_AI_WORDS.model} />
          <ModelRows
            label={DELEGATION_AI_WORDS.model}
            rows={delegationAiModelRows(menu, first)}
            more={0}
            onPick={(id) => setDraft(withAiModel(options, draft, id ?? ''))}
            onMore={() => {}}
          />
          {menu.selected && menu.efforts.length ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12 }}>
              <Label text={DELEGATION_AI_WORDS.effort} inline />
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={DELEGATION_AI_WORDS.effort}
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}
              >
                {menu.efforts.map((e) => (
                  <EffortPill
                    key={e.value}
                    label={e.word}
                    picked={e.on}
                    onPress={() => setDraft({ ...draft, effort: e.value })}
                  />
                ))}
              </View>
            </View>
          ) : null}
          {menu.fast !== null ? (
            <FastRow
              row={{
                kind: 'offered',
                title: DELEGATION_AI_WORDS.fast,
                text: DELEGATION_AI_WORDS.fastHint,
                on: menu.fast,
                note: null,
              }}
              onChange={(on) => setDraft({ ...draft, fast: on })}
            />
          ) : null}
        </>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 14 }}>
        <Button
          label={DELEGATION_AI_WORDS.cancel}
          variant="secondary"
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <Button
          label={DELEGATION_AI_WORDS.done}
          disabled={!options}
          onPress={() => {
            if (options) onDone(draft, options);
          }}
          style={{ flex: 1 }}
        />
      </View>
    </ScrollView>
  );
}

/** A part's name over it (as the chat's sheet names Effort). */
function Label({ text, inline = false }: { text: string; inline?: boolean }) {
  const theme = useTheme();
  return (
    <Text
      size={10.5}
      weight={500}
      mono
      uppercase
      tracking={0.06}
      color={theme.colors.mut}
      accessibilityRole="header"
      style={inline ? { marginBottom: 8 } : { paddingHorizontal: 18, paddingBottom: 8 }}
    >
      {text}
    </Text>
  );
}
