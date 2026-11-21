/**
 * Add a step to a plan on Android (AP-718; the web's “Add a step”, WS-07): its title. A plan is the agent's own work
 * (Whombat one-agent.md OA-14; app one-agent.md AP-4990): the step has no owner. A refusal shows under the form in the
 * server's words; what went through is a toast, and the plan's answer is on the screen at once.
 */
import { usePlanWrite } from '@whombat/client/react';
import type { Plan } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  addStepBody,
  addStepDoneText,
  addStepLabel,
  addStepProblem,
  addStepRefusal,
  PLAN_STEP_TITLE_MAX,
} from '../data/planAdd';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { errorText, outcomeText, showNotice } from './feedback';

export function AddStepSheet({
  plan,
  visible,
  onClose,
}: {
  plan: Plan;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="PLAN" label="Add a step" maxHeight="92%">
      {visible ? <AddStepFields plan={plan} onClose={onClose} /> : null}
    </Sheet>
  );
}

function AddStepFields({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const add = usePlanWrite(api.plans.addStep);
  const [title, setTitle] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const busy = add.isPending;
  const problem = addStepProblem(title);

  const submit = async () => {
    if (problem || busy) return;
    try {
      const result = await add.mutateAsync({
        params: { burrow: slug, planId: plan.id },
        body: addStepBody(title),
      });
      if (result.status !== 'ok') {
        const text = outcomeText(result);
        if (text) Alert.alert(text.title, text.body);
        return;
      }
      showNotice(addStepDoneText(title));
      onClose();
    } catch (error) {
      setRefusal(addStepRefusal(error) ?? errorText(error));
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8, gap: 14 }}>
      <View style={{ paddingHorizontal: 22, gap: 4 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          Add a step
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
          {plan.title}
        </Text>
      </View>
      <View style={{ paddingHorizontal: 22, gap: 14 }}>
        <FormField
          label="New step"
          value={title}
          onChangeText={(v) => {
            setTitle(v);
            setRefusal(null);
          }}
          maxLength={PLAN_STEP_TITLE_MAX}
          placeholder="Add a step"
          autoFocus
        />
      </View>
      <View style={{ paddingHorizontal: 22, gap: 10 }}>
        <FormMessage text={refusal} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} style={{ flex: 1 }} />
          <Button
            label={addStepLabel(busy)}
            busy={busy}
            disabled={problem !== null}
            accessibilityHint={problem ?? undefined}
            onPress={() => void submit()}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </ScrollView>
  );
}
