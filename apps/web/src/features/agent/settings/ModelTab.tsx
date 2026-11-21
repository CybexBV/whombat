import {
  ApiError,
  backgroundModelChoices,
  draftWithBackgroundModel,
  draftWithEffort,
  draftWithFast,
  draftWithModel,
  draftWithProvider,
  effortChoices,
  effortHint,
  fastChoice,
  InvalidRequestError,
  localModelOf,
  type ModelRuntimeDraft,
  modelChoices,
  modelFallbackNote,
  modelRuntimeBody,
  modelRuntimeDraft,
  providerModels,
} from '@whombat/client';
import { useBootstrap, useSetAgentModel } from '@whombat/client/react';
import { type AgentEffort, PROVIDER_LABELS } from '@whombat/core/domain';
import { MODEL_EFFORT_COPY } from '@whombat/core/text';
import { useEffect, useId, useState } from 'react';
import { SectionLabel } from '../../../components/SectionLabel';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useToast } from '../../../components/Toast';
import { ToggleRow } from '../../../components/Toggle';
import { useAgentSetupStatus } from '../AiProviderPanel';
import { AnotherModel } from '../AnotherModel';
import { CredentialSection } from '../CredentialSection';
import { ProviderPicker } from '../ProviderPicker';
import type { SettingsTabProps } from './AgentTab';
import styles from './AgentTab.module.css';
import { modelSavedText, outcomeNotice } from './model';
import { SaveBar } from './SaveBar';
import { useDraft } from './useDraft';

/** EFFORT's Automatic in the segmented control (it takes strings only). */
const AUTOMATIC = 'automatic';

/** “Model”, “Effort”: the contracts' section labels as accessible names. */
const sentence = (label: string) => label.charAt(0) + label.slice(1).toLowerCase();

/** The server's sentence when it refuses the model or the effort (`validation_failed` on `runtime`, ME-04). */
function runtimeRefusalOf(err: unknown): string | null {
  if (err instanceof ApiError || err instanceof InvalidRequestError)
    return err.fields.runtime?.[0] ?? err.message;
  return null;
}

/**
 * Settings → Agent → Model and AI (AP-381; one-agent.md AP-4927): the AI provider that runs its turns — Claude Code,
 * ChatGPT, or Local, the burrow's model on its network (hermes-engine-app.md AP-5041) — then its MODEL (the tool's own list, “Default (Opus)” first; on Local the burrow's own model first,
 * the others its server listed and “Another model” for any other, AP-5001) and EFFORT (Automatic, then the levels that
 * model takes; none on Local) with the quiet note when its last turn ran on the default model (model-effort.md
 * AP-1128…AP-1130), and RUNS ON — the person's own sign-in it runs on (`CredentialSection`, one-person.md OP-09; not on
 * Local, which needs no sign-in). Save sends the whole model runtime in one `agent.update`.
 */
export function ModelTab({ burrow, profile, onDirtyChange }: SettingsTabProps) {
  const { agent } = profile;
  const { data: setup } = useAgentSetupStatus(burrow);
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const localModel = localModelOf(bootstrap?.burrow);
  const form = useDraft<ModelRuntimeDraft>(modelRuntimeDraft(agent.runtime));
  const update = useSetAgentModel(burrow);
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const ids = { model: useId(), backgroundModel: useId(), backgroundHint: useId(), effortHint: useId() };
  useEffect(() => onDirtyChange(form.dirty), [form.dirty, onDirtyChange]);
  if (!form.draft) return null;
  const { draft } = form;
  const local = draft.provider === 'local';
  const models = providerModels(setup, draft.provider, localModel);
  const backgroundModels = backgroundModelChoices(models, draft.backgroundModel);
  const efforts = effortChoices(models, draft.model, draft.effort);
  // Fast replies (chat-runtime.md CR-10, AP-2700): only where the picked model offers them, on a runtime with them.
  const fast = fastChoice(draft, models);
  // Only about the provider it is on: a draft on another one has nothing to do with its last turn.
  const fallback =
    draft.provider === agent.runtime.provider
      ? modelFallbackNote(agent.name, profile.modelFallback, models)
      : null;

  async function save() {
    if (!form.draft || !form.base) return;
    setNotice(null);
    const before = form.base;
    const body = modelRuntimeBody(form.draft);
    let result: Awaited<ReturnType<typeof update.mutateAsync>>;
    try {
      result = await update.mutateAsync({ params: { burrow }, body: { runtime: body } });
    } catch (err) {
      const refusal = runtimeRefusalOf(err);
      if (refusal === null) throw err;
      return setNotice(refusal);
    }
    const refused = outcomeNotice(result);
    if (refused) return setNotice(refused);
    const next = modelRuntimeDraft(body);
    form.saved(() => next);
    form.edit(() => next);
    toast.show(modelSavedText(agent.name, before, next));
  }

  return (
    <>
      <div className={styles.group}>
        <SectionLabel>AI PROVIDER</SectionLabel>
        {setup ? (
          <ProviderPicker
            status={setup}
            value={draft.provider}
            onChange={(provider) => form.edit((d) => draftWithProvider(d, provider))}
            localModel={localModel}
            layout="row"
          />
        ) : (
          <div className={styles.row}>
            <span className={styles.rowText}>{PROVIDER_LABELS[agent.runtime.provider]}</span>
          </div>
        )}
      </div>
      <div className={styles.group}>
        <SectionLabel>{MODEL_EFFORT_COPY.modelSection}</SectionLabel>
        <div
          role="radiogroup"
          aria-label={sentence(MODEL_EFFORT_COPY.modelSection)}
          className={styles.choices}
        >
          {modelChoices(models, draft.model).map((choice) => (
            <label key={choice.id ?? ''} className={styles.choice}>
              <input
                type="radio"
                name={ids.model}
                className={styles.choiceRadio}
                value={choice.id ?? ''}
                checked={choice.id === draft.model}
                onChange={() => form.edit((d) => draftWithModel(d, choice.id, models))}
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceLabel}>{choice.label}</span>
                {choice.description ? (
                  <span className={styles.choiceDescription}>{choice.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        {local ? (
          <AnotherModel onUse={(model) => form.edit((d) => draftWithModel(d, model, models))} />
        ) : null}
        {fallback ? (
          <p className={styles.fallback} data-model-fallback="">
            {fallback}
          </p>
        ) : null}
      </div>
      {backgroundModels.length > 1 ? (
        <div className={styles.group}>
          <SectionLabel>{MODEL_EFFORT_COPY.backgroundModelSection}</SectionLabel>
          <div
            role="radiogroup"
            aria-label={sentence(MODEL_EFFORT_COPY.backgroundModelSection)}
            aria-describedby={ids.backgroundHint}
            className={styles.choices}
          >
            {backgroundModels.map((choice) => (
              <label key={choice.id ?? ''} className={styles.choice}>
                <input
                  type="radio"
                  name={ids.backgroundModel}
                  className={styles.choiceRadio}
                  value={choice.id ?? ''}
                  checked={choice.id === (draft.backgroundModel ?? null)}
                  onChange={() => form.edit((d) => draftWithBackgroundModel(d, choice.id))}
                />
                <span className={styles.choiceText}>
                  <span className={styles.choiceLabel}>{choice.label}</span>
                  {choice.description ? (
                    <span className={styles.choiceDescription}>{choice.description}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <p id={ids.backgroundHint} className={styles.fallback}>
            {MODEL_EFFORT_COPY.backgroundModelHint}
          </p>
        </div>
      ) : null}
      {efforts.length > 0 ? (
        <div className={styles.group}>
          <SectionLabel>{MODEL_EFFORT_COPY.effortSection}</SectionLabel>
          <div className={styles.effortRow}>
            <SegmentedControl<string>
              label={sentence(MODEL_EFFORT_COPY.effortSection)}
              role="radiogroup"
              className={styles.effortControl}
              describedBy={ids.effortHint}
              options={efforts.map((e) => ({ value: e.value ?? AUTOMATIC, label: e.label }))}
              value={draft.effort ?? AUTOMATIC}
              onChange={(value) =>
                form.edit((d) => draftWithEffort(d, value === AUTOMATIC ? null : (value as AgentEffort)))
              }
            />
            <span id={ids.effortHint} className={styles.effortHint}>
              {effortHint(draft.effort)}
            </span>
          </div>
        </div>
      ) : null}
      {fast ? (
        <div className={styles.group} data-fast-replies="">
          <ToggleRow
            label={fast.label}
            hint={fast.hint}
            checked={fast.on}
            size="md"
            className={styles.fastRow}
            onCheckedChange={(on) => form.edit((d) => draftWithFast(d, on, models))}
          />
        </div>
      ) : null}
      {/* A model on the network needs no one's sign-in (AP-5041): none while the agent is on it or about to be. */}
      {agent.runtime.provider !== 'local' && !local ? (
        <CredentialSection burrow={burrow} provider={agent.runtime.provider} />
      ) : null}
      <SaveBar
        dirty={form.dirty}
        saving={update.isPending}
        notice={notice}
        onSave={save}
        onDiscard={() => {
          setNotice(null);
          form.discard();
        }}
      />
    </>
  );
}
