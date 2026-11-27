import { useAgentSetup, useRecheckAgentSetup } from '@whombat/client/react';
import {
  type AgentSetupStatus,
  agentsCanReply,
  PROVIDER_LABELS,
  type ProviderSetup,
} from '@whombat/core/domain';
import { ENGINE_PROBLEM_COPY, formatAgo, providerStateLabel } from '@whombat/core/text';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { useWebI18n } from '../../i18n/provider';
import { GitHubNotice } from '../github/GitHubNotice';
import styles from './AiProviderPanel.module.css';

/**
 * This Whombat's AI provider status (`host.agents`): read at mount and when an agent changes (`agent.updated`, at
 * most once per 30 s); polled every 30 s only while agents can't reply (the shell's notice shows then), every 2 s while
 * a “Check again” is running and every 5 s where people are setting it up (`watch`). web-efficiency.md WE-06.
 */
export function useAgentSetupStatus(burrow: string | null, options: { watch?: boolean } = {}) {
  return useAgentSetup(burrow ? { params: { burrow } } : null, {
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.recheckPending) return 2_000;
      if (options.watch) return 5_000;
      return data && !agentsCanReply(data) ? 30_000 : false;
    },
  });
}

const TONES: Record<ProviderSetup['state'], DotTone> = {
  ready: 'ok',
  logged_out: 'warn',
  missing: 'bad',
  error: 'bad',
  unknown: 'mut',
};

/**
 * One provider as the runner found it: its name and its state in the contracts' words (ChatGPT's “Ready” without the
 * runner's version, CT-1451; chatgpt-no-client.md AP-5611, AP-5613, AP-5622), with what went wrong under it.
 */
export function ProviderRow({ setup }: { setup: ProviderSetup }) {
  const { tag: uiLocale } = useWebI18n();
  const label = providerStateLabel(setup, uiLocale);
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <StatusDot tone={TONES[setup.state]} size={8} label={label} />
        <span className={styles.main}>
          <span className={styles.name}>{PROVIDER_LABELS[setup.provider]}</span>
          <span className={styles.meta}>{label}</span>
        </span>
      </div>
      <ProviderReadiness setup={setup} />
    </div>
  );
}

/**
 * What went wrong with one provider, under its row (SS-03): the runner's own words when it didn't start. Installing and
 * signing in are the rows' own buttons (Settings → AI), never a command to type (hermes-engine-app.md AP-5324).
 */
export function ProviderReadiness({ setup }: { setup: ProviderSetup }) {
  return setup.state === 'error' && setup.detail ? <GitHubNotice text={setup.detail} /> : null;
}

/**
 * What the runner says about the engine every turn runs on (Hermes, CT-1160; hermes-engine-app.md AP-5040): nothing
 * while it is ready, else the contracts' words for you to act on, never its name (`ENGINE_PROBLEM_COPY`).
 */
export function engineProblemText(status: Pick<AgentSetupStatus, 'runner' | 'hermes'>): string | null {
  if (!status.runner.connected || !status.hermes || status.hermes.ready) return null;
  return ENGINE_PROBLEM_COPY[status.hermes.problem ?? 'broken'];
}

/**
 * The agent runner (`host.agents`): running on this machine, or how to start it; while what it runs turns on isn't
 * ready, the contracts' words for that under it (AP-5040).
 */
export function RunnerRow({ status }: { status: AgentSetupStatus }) {
  const engine = engineProblemText(status);
  return (
    <div
      className={styles.row}
      data-engine-problem={engine ? (status.hermes?.problem ?? 'broken') : undefined}
    >
      <div className={styles.head}>
        <StatusDot
          tone={status.runner.connected ? (engine ? 'warn' : 'ok') : 'bad'}
          size={8}
          label={status.runner.connected ? 'Running' : 'Not running'}
        />
        <span className={styles.main}>
          <span className={styles.name}>Agent runner</span>
          <span className={styles.meta}>
            {status.runner.connected ? 'Running on this machine' : 'Not running'}
          </span>
        </span>
      </div>
      {!status.runner.connected ? (
        <GitHubNotice text="Your agent replies through Whombat’s runner, which isn’t running right now. Restarting your Whombat starts it again." />
      ) : engine ? (
        <GitHubNotice text={engine} />
      ) : null}
    </div>
  );
}

/** Under the card: when the host was last checked, and “Check again” after you fixed something. */
export function ReadinessFooter({ burrow, status }: { burrow: string; status: AgentSetupStatus }) {
  const recheck = useRecheckAgentSetup(burrow);
  const checking = recheck.isPending || status.recheckPending;
  return (
    <div className={styles.footer}>
      <span className={styles.meta}>
        {checking
          ? 'Checking Claude Code and ChatGPT…'
          : status.checkedAt
            ? `Checked ${formatAgo(status.checkedAt, new Date(), 'UTC')}`
            : null}
      </span>
      <Button
        variant="secondary"
        size="md"
        onClick={() => recheck.mutate()}
        disabled={checking || !status.runner.connected}
      >
        Check again
      </Button>
    </div>
  );
}

export interface AiProviderPanelProps {
  burrow: string;
  status: AgentSetupStatus;
  /** More rows at the end of the card. */
  children?: ReactNode;
}

/**
 * AI provider (docs/decisions/agent-setup.md; not in the mocks — onboarding's repo card and Settings' rows):
 * the agent runner, Claude Code and ChatGPT as the runner found them, and “Check again” after you fixed
 * something. Onboarding shows it, and Settings → AI
 * for a server without `clients.*`; Settings → AI → AI CLIENTS otherwise puts the same rows under each client (SS-03).
 */
export function AiProviderPanel({ burrow, status, children }: AiProviderPanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.card}>
        <RunnerRow status={status} />
        {status.providers.map((setup) => (
          <ProviderRow key={setup.provider} setup={setup} />
        ))}
        {children}
      </div>
      <ReadinessFooter burrow={burrow} status={status} />
    </div>
  );
}
