/**
 * MODEL's and EFFORT's sheet on an agent's screen (Whombat model-effort.md ME-01, ME-06; AP-1133): the choices as radio
 * rows (44dp minimum, the picked one checked in `brand`, a model's own line under its name), edge to edge between
 * hairlines as a sheet's rows are, and a quiet note under them (a chosen level applies to every turn). A tap saves at
 * once; a refusal shows in the sheet, read out, and the sheet stays open. On Local the model sheet ends with “Another
 * model”: a field and Use, which saves a model the list doesn't name (hermes-engine-app.md AP-5001, AP-5121).
 */

import type { AgentModelRuntimeUpdate } from '@whombat/core';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { ModelEffortChoice, ModelEffortView } from '../data/runsOn';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField } from '../ui/formField';
import { Check } from '../ui/icons';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';

export interface ModelEffortSheetProps {
  /** MODEL or EFFORT while it is open; null when it is closed. */
  title: string | null;
  /** What TalkBack calls the sheet and its choices (“Banjo’s model”). */
  label: string;
  choices: readonly ModelEffortChoice[];
  /** Under the choices. */
  note: string | null;
  /** While a choice is being saved: the rows don't take another tap. */
  busy: boolean;
  error: string | null;
  onPick: (choice: ModelEffortChoice) => void;
  onClose: () => void;
  /** Local's “Another model” (AP-5001); absent or null for the tools' lists and for EFFORT. */
  another?: ModelEffortView['another'];
  /** A typed model's whole runtime, to save. */
  onAnother?: (runtime: AgentModelRuntimeUpdate) => void;
}

export function ModelEffortSheet({
  title,
  label,
  choices,
  note,
  busy,
  error,
  onPick,
  onClose,
  another = null,
  onAnother,
}: ModelEffortSheetProps) {
  const { tClient } = useI18n();
  const theme = useTheme();
  const [typed, setTyped] = useState('');
  // A fresh field every time the sheet opens.
  useEffect(() => {
    if (title === null) setTyped('');
  }, [title]);
  return (
    <Sheet
      visible={title !== null}
      onClose={onClose}
      title={title ?? undefined}
      label={label}
      maxHeight="80%"
    >
      <ScrollView accessibilityRole="radiogroup" accessibilityLabel={label}>
        {choices.map((c) => (
          <Touchable
            key={c.key}
            onPress={() => onPick(c)}
            disabled={busy}
            feedback="wash"
            accessibilityRole="radio"
            accessibilityState={{ checked: c.checked, disabled: busy }}
            accessibilityLabel={c.detail ? `${c.label}. ${c.detail}` : c.label}
            style={{
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 22,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={15.5} weight={c.checked ? 600 : 500}>
                {c.label}
              </Text>
              {c.detail ? (
                <Text size={13} lh={1.4} color={theme.colors.mut}>
                  {c.detail}
                </Text>
              ) : null}
            </View>
            {c.checked ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
          </Touchable>
        ))}
        <View style={{ height: 1, backgroundColor: theme.colors.line }} />
        {another ? (
          <View style={{ paddingHorizontal: 22, paddingTop: 14, gap: 10 }}>
            <FormField
              label={another.label}
              hint={another.hint}
              value={typed}
              onChangeText={setTyped}
              mono
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => typed.trim() && onAnother?.(another.runtime(typed))}
            />
            <Button
              label={another.use}
              variant="secondary"
              disabled={busy || !typed.trim()}
              accessibilityHint={`${label}: ${typed.trim()}`}
              onPress={() => onAnother?.(another.runtime(typed))}
            />
          </View>
        ) : null}
        {note ? (
          <Text
            size={13}
            lh={1.45}
            color={theme.colors.mut}
            style={{ paddingHorizontal: 22, paddingTop: 12 }}
          >
            {note}
          </Text>
        ) : null}
        {error ? (
          <Text
            size={13.5}
            lh={1.45}
            color={theme.colors.bad}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={{ paddingHorizontal: 22, paddingTop: 12 }}
          >
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={{ paddingHorizontal: 22, paddingTop: 12 }}>
        <Button label={tClient('reports.cancel')} variant="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}
