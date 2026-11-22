/**
 * Settings → Agent → Model and AI (one-agent.md AP-4968; was the agent screen's RUNS ON): the AI provider the agent runs
 * on, and — where the web allows it — moving it to another: Claude Code or ChatGPT when ready, Local once the burrow has a
 * model on its network (hermes-engine-app.md AP-5120). Each move asks first. Then SIGN-IN: your own sign-in or API key
 * (one-person-android.md AP-5763; none on Local). While the
 * burrow sends the agent's tool through an AI gateway (Whombat ai-gateway.md AIG-17; AP-1124) the section starts with
 * “Runs on Fusebox” and why; it shows even where the runner's providers aren't known. Then, where the runtime has
 * `agents.model_effort`, its MODEL and EFFORT (Whombat model-effort.md; AP-1133): a row each with what it is on, which
 * opens a sheet of the choices; a tap saves the whole model runtime at once. A move to another provider clears both.
 * Where the runtime has `chat.runtime` and the model has them, FAST REPLIES with a switch, saved the same way, and the
 * provider it is on says “Opus · High effort · Fast” (Whombat chat-runtime.md CR-10; chat-runtime-android.md AP-2730,
 * AP-2731). On Local, MODEL's sheet also takes another model by its name (AP-5001), and EFFORT and FAST REPLIES don't
 * show (it has neither).
 */
import { gatewayRunsOn, localModelOf, modelRuntimeSaved, problemText } from '@whombat/client';
import { useAgentSetup, useSessionProtocol, useSetAgentModel } from '@whombat/client/react';
import {
  type AgentModelRuntimeUpdate,
  type AgentProfile,
  CHAT_RUNTIME_COPY,
  MODEL_EFFORT_COPY,
} from '@whombat/core';
import { BACKGROUND_MODEL_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { type ModelEffortChoice, modelEffortView, runsOnModel, signInLine } from '../data/runsOn';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ListRow } from '../ui/ListRow';
import { Section } from '../ui/primitives';
import { ModelEffortSheet } from './ModelEffortSheet';

function Note({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {children}
      </Text>
    </View>
  );
}

export function RunsOnSection({ profile, onChanged }: { profile: AgentProfile; onChanged: () => void }) {
  const theme = useTheme();
  const { slug, bootstrap } = useBurrow();
  // Where the Whombat says which providers are ready (`host.agents`); hidden where it doesn't answer.
  const { data: status } = useAgentSetup({ params: { burrow: slug } }, { retry: false });
  const update = useSetAgentModel(slug);
  const protocol = useSessionProtocol();
  const canPickBackgroundModel = protocolAtLeast(protocol, BACKGROUND_MODEL_MINOR);
  const [error, setError] = useState<string | null>(null);
  const [fastError, setFastError] = useState<string | null>(null);
  const [picking, setPicking] = useState<'model' | 'backgroundModel' | 'effort' | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const localModel = localModelOf(bootstrap.burrow);
  // Its tool goes through the burrow's AI gateway (AIG-17): said first, whatever else the section shows.
  const gateway = gatewayRunsOn(bootstrap.burrow, profile.agent.runtime.provider);
  const gatewayRow = gateway ? (
    <ListRow
      title={gateway.title}
      body={gateway.note}
      accessibilityLabel={`${gateway.title}. ${gateway.note}`}
    />
  ) : null;
  const agent = profile.agent;
  // Its turns run on your own sign-in (OP-09).
  const signIn = signInLine(agent.runtime);
  const signInSection = signIn ? (
    <Section title="SIGN-IN">
      <ListRow title={signIn.title} body={signIn.note} bodyLines={4} />
    </Section>
  ) : null;
  const bare = (
    <>
      {gatewayRow ? <Section title="RUNS ON">{gatewayRow}</Section> : null}
      {signInSection}
    </>
  );
  if (!status) return bare;
  const model = runsOnModel(agent.runtime, status, { agentName: agent.name, localModel });

  const choices = modelEffortView(
    agent,
    status,
    true,
    profile.modelFallback,
    true,
    localModel,
    canPickBackgroundModel,
  );
  const fast = choices?.fast ?? null;
  /** Fast replies switched: saved at once, the whole model runtime (CR-10, AP-2730). */
  const switchFast = (on: boolean) => {
    if (!fast) return;
    setFastError(null);
    save(fast.runtime(on), { done: () => {}, refused: setFastError });
  };
  const open = (which: 'model' | 'backgroundModel' | 'effort') => {
    setPickError(null);
    setPicking(which);
  };
  /** A model or an effort picked in its sheet: saved at once, the whole model runtime (ME-01). */
  const pick = (choice: ModelEffortChoice) => {
    if (choice.checked) return setPicking(null);
    setPickError(null);
    save(choice.runtime, {
      done: () => setPicking(null),
      refused: (text) => setPickError(text),
    });
  };
  const save = (
    runtime: AgentModelRuntimeUpdate,
    then: { done: () => void; refused: (text: string) => void },
  ) =>
    update.mutate(
      { params: { burrow: slug }, body: { runtime } },
      {
        onSuccess: (r) => {
          if (r.status !== 'ok') {
            then.refused(r.status === 'blocked' ? r.message : 'Waiting for a person to approve.');
            return;
          }
          if (!modelRuntimeSaved(runtime, r.data.agent.runtime)) {
            onChanged();
            then.refused(MODEL_EFFORT_COPY.notSaved);
            return;
          }
          then.done();
          onChanged();
        },
        onError: (e) => then.refused(problemText(e)),
      },
    );

  const move = (option: (typeof model.options)[number]) => {
    Alert.alert(`Move ${agent.name} to ${option.label}?`, `From now on it works on ${option.label}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Move',
        onPress: () => {
          setError(null);
          // The provider alone: its model and effort go back to the default and automatic (ME-01).
          save(option.runtime, { done: () => {}, refused: setError });
        },
      },
    ]);
  };

  const sheet =
    picking && choices
      ? picking === 'model'
        ? choices.model
        : picking === 'backgroundModel'
          ? choices.backgroundModel
          : choices.effort
      : null;
  const editable = !update.isPending;
  return (
    <>
      <Section title="RUNS ON">
        {gatewayRow}
        {model.options.map((o) => (
          <ListRow
            key={o.key}
            title={o.label}
            meta={o.state}
            // What it runs with there, under the provider it is on (AP-2731): “Opus · High effort · Fast”.
            body={o.selected ? (choices?.summary ?? null) : null}
            trailing={
              o.selected ? (
                <Text size={15} weight={600} color={theme.colors.ok} accessibilityLabel="Current">
                  ✓
                </Text>
              ) : null
            }
            onPress={o.selectable && !update.isPending ? () => move(o) : undefined}
            accessibilityLabel={`${o.label}, ${o.state}${o.selected ? `, current${choices?.summary ? `, ${choices.summary}` : ''}` : o.selectable ? ', tap to move here' : ''}`}
          />
        ))}
        {model.note ? <Note>{model.note}</Note> : null}
        {error ? <Note>{error}</Note> : null}
      </Section>
      {choices ? (
        <Section title={MODEL_EFFORT_COPY.modelSection}>
          <ListRow
            title={choices.model.label}
            body={choices.model.description}
            trailing="›"
            onPress={editable ? () => open('model') : undefined}
            accessibilityLabel={`${agent.name}’s model: ${choices.model.label}, tap to change`}
          />
          {choices.fallback ? <Note>{choices.fallback}</Note> : null}
        </Section>
      ) : null}
      {choices?.backgroundModel ? (
        <Section title={MODEL_EFFORT_COPY.backgroundModelSection}>
          <ListRow
            title={choices.backgroundModel.label}
            body={choices.backgroundModel.hint}
            bodyLines={3}
            trailing="›"
            onPress={editable ? () => open('backgroundModel') : undefined}
            accessibilityLabel={`${agent.name}’s background model: ${choices.backgroundModel.label}. ${choices.backgroundModel.hint}, tap to change`}
          />
        </Section>
      ) : null}
      {choices?.effort ? (
        <Section title={MODEL_EFFORT_COPY.effortSection}>
          <ListRow
            title={choices.effort.label}
            body={choices.effort.hint}
            trailing="›"
            onPress={editable ? () => open('effort') : undefined}
            accessibilityLabel={`${agent.name}’s effort: ${choices.effort.label}. ${choices.effort.hint}, tap to change`}
          />
        </Section>
      ) : null}
      {fast ? (
        <Section title={CHAT_RUNTIME_COPY.fast.toUpperCase()}>
          <ListRow
            title={fast.label}
            body={fast.hint}
            bodyLines={3}
            control={
              <Switch
                value={fast.on}
                disabled={!editable}
                onValueChange={switchFast}
                accessibilityLabel={`${agent.name}’s ${fast.label.toLowerCase()}`}
                accessibilityHint={fast.hint}
                accessibilityRole="switch"
                trackColor={{ true: theme.colors.warn, false: theme.colors.line2 }}
                thumbColor={fast.on ? theme.colors.btnfg : theme.colors.mut}
                style={{ minHeight: 44 }}
              />
            }
          />
          {fastError ? <Note>{fastError}</Note> : null}
        </Section>
      ) : null}
      {signInSection}
      {choices ? (
        <ModelEffortSheet
          title={
            sheet
              ? picking === 'model'
                ? MODEL_EFFORT_COPY.modelSection
                : picking === 'backgroundModel'
                  ? MODEL_EFFORT_COPY.backgroundModelSection
                  : MODEL_EFFORT_COPY.effortSection
              : null
          }
          label={
            picking === 'effort'
              ? `${agent.name}’s effort`
              : picking === 'backgroundModel'
                ? `${agent.name}’s background model`
                : `${agent.name}’s model`
          }
          choices={sheet?.choices ?? []}
          note={
            picking === 'effort'
              ? choices.fixedHint
              : picking === 'backgroundModel'
                ? MODEL_EFFORT_COPY.backgroundModelHint
                : null
          }
          another={picking === 'model' ? choices.another : null}
          onAnother={(runtime) => {
            setPickError(null);
            save(runtime, { done: () => setPicking(null), refused: (text) => setPickError(text) });
          }}
          busy={update.isPending}
          error={pickError}
          onPick={pick}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </>
  );
}
