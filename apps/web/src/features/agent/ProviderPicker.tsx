import { localModelCheckLine } from '@whombat/client';
import {
  type AgentProvider,
  type AgentSetupStatus,
  LIVE_PROVIDERS,
  type LiveProvider,
  type LocalModelView,
  localModelName,
  PROVIDER_LABELS,
} from '@whombat/core/domain';
import { AI_PROVIDER_SETTINGS, CHAT_PROVIDER_LABELS, providerStateLabel } from '@whombat/core/text';
import { cx } from '../../components/cx';
import { SegmentedControl } from '../../components/SegmentedControl';
import { engineProblemText } from './AiProviderPanel';
import styles from './ProviderPicker.module.css';

export interface ProviderPickerProps {
  status: AgentSetupStatus;
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
  /**
   * The burrow's model on its network (`Burrow.localModel` on a runtime with `ai.local_model`; hermes-engine-app.md
   * AP-5041): Local is offered with one, and stays shown while the agent is on it without one.
   */
  localModel?: LocalModelView | null;
  /** Read-only (no key to change agents). */
  disabled?: boolean;
  /** `row`: label left, control right (Settings → Agent); `stack`: control under a section label (onboarding). */
  layout?: 'row' | 'stack';
  /** Where a provider that isn't ready gets set up; null when the AI provider panel is right there. */
  setupAt?: string | null;
  className?: string;
}

/**
 * One line under the control: what turns run on can't start (the contracts' words, AP-5040), else the picked provider's
 * state and where to fix it when it isn't ready (ChatGPT's “Ready on this machine.” without a version,
 * chatgpt-no-client.md AP-5613); for Local, the model on the network by its name and its last test.
 */
export function providerHint(
  status: AgentSetupStatus,
  value: AgentProvider,
  setupAt: string | null = AI_PROVIDER_SETTINGS,
  localModel: LocalModelView | null = null,
): string {
  const engine = engineProblemText(status);
  if (engine) return engine;
  if (value === 'local') {
    if (!localModel)
      return setupAt
        ? `The model on your network isn’t set up yet: set it up in ${setupAt}.`
        : 'The model on your network isn’t set up yet.';
    const name = `${localModelName(localModel)}, on your network.`;
    return localModel.check
      ? `${name} ${localModelCheckLine(localModel.check, localModel.model).text}`
      : name;
  }
  const setup = status.providers.find((p) => p.provider === value);
  if (!setup || setup.state === 'unknown')
    return status.runner.connected
      ? 'Not checked yet.'
      : `Part of Whombat is restarting, so ${PROVIDER_LABELS[value]} can’t be checked right now.`;
  const label = providerStateLabel(setup);
  if (setup.state === 'ready') return `${label} on this machine.`;
  return setupAt
    ? `${label}: set it up in ${setupAt}.`
    : `${label} yet: your agent replies once it’s set up.`;
}

/**
 * Which AI provider runs the agent's turns (docs/decisions/agent-setup.md; not in the mocks — Settings' segmented
 * rows): Claude Code and ChatGPT as the runner found them (AP-5611), and Local — the burrow's model on its network (AP-5041) —
 * where there is one. One that can't run can't be picked, but stays shown while it is the agent's current one.
 */
export function ProviderPicker({
  status,
  value,
  onChange,
  localModel = null,
  disabled = false,
  layout = 'stack',
  setupAt = AI_PROVIDER_SETTINGS,
  className,
}: ProviderPickerProps) {
  const ready = (p: LiveProvider) => status.providers.some((s) => s.provider === p && s.state === 'ready');
  const options: { value: AgentProvider; label: string; disabled: boolean }[] = [
    ...LIVE_PROVIDERS.map((p) => ({
      value: p,
      label: PROVIDER_LABELS[p],
      disabled: !ready(p) && p !== value,
    })),
    ...(localModel || value === 'local'
      ? [
          {
            value: 'local' as const,
            label: CHAT_PROVIDER_LABELS.local,
            disabled: !localModel && value !== 'local',
          },
        ]
      : []),
  ];
  return (
    <div className={cx(layout === 'row' ? styles.row : styles.stack, className)}>
      {layout === 'row' ? <span className={styles.label}>Runs on</span> : null}
      <SegmentedControl<AgentProvider>
        label="AI provider"
        disabled={disabled}
        className={styles.end}
        options={options}
        value={value}
        onChange={onChange}
      />
      <span className={styles.hint}>{providerHint(status, value, setupAt, localModel)}</span>
    </div>
  );
}
