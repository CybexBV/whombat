/**
 * “Keep server agents up to date” (Whombat agent-updates.md AU-05, AU-06; agent-updates-app.md AP-2986…AP-2988): one
 * switch in This Whombat → About → UPDATES, kept by the hosts service (`hosts.agentSettings`), on by default. Off,
 * nothing updates by itself; Update now still works on each server's System tab. Stopped after a version didn't come
 * back on a server, its words say so in amber. Only on a Whombat with `hosts.agent_updates`. Saved at once.
 */
import {
  AGENT_UPDATE_WORDS,
  agentSettingsView,
  commitOutcomeText,
  hostErrorInfo,
} from '@whombat/client/hosts';
import { useHostAgentSettings, useHostsChange, useHostsStatus } from '@whombat/client/hosts/react';
import { MANAGED_TEXT } from '@whombat/client/managed';
import { api } from '@whombat/core/contracts';
import { useId } from 'react';
import { cx } from '../../components/cx';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import styles from './SettingsScreen.module.css';

/** The switch's row, inside a card (the managed About's UPDATES); null where it doesn't show. */
export function AgentUpdatesSwitch({ burrow, last = true }: { burrow: string; last?: boolean }) {
  const ids = useId();
  const toast = useToast();
  const status = useHostsStatus({ params: { burrow } }, { retry: false });
  const settings = useHostAgentSettings(status.data?.present ? { params: { burrow } } : null, {
    retry: false,
  });
  const change = useHostsChange(api.hosts.updateAgentSettings);
  if (!settings.data) return null;
  const v = agentSettingsView(settings.data);
  const save = (autoUpdate: boolean) =>
    change.mutateAsync({ params: { burrow }, body: { autoUpdate } }).then(
      (result) =>
        toast.show(
          result.status === 'ok'
            ? AGENT_UPDATE_WORDS.switched(autoUpdate)
            : (commitOutcomeText(result) ?? ''),
        ),
      (error) => toast.show(hostErrorInfo(error).message),
    );
  return (
    <div className={cx(styles.row, last && styles.lastRow)} data-row="agent-updates">
      {v.tone === 'warn' ? <StatusDot tone="warn" size={8} label={v.meta} /> : null}
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${ids}-auto`}>
          {v.title}
        </label>
        <span className={styles.rowMeta} id={`${ids}-hint`}>
          {v.meta}
        </span>
      </span>
      <Toggle
        id={`${ids}-auto`}
        checked={v.on}
        disabled={change.isPending}
        aria-describedby={`${ids}-hint`}
        onCheckedChange={(next) => void save(next)}
      />
    </div>
  );
}

/** UPDATES on its own, where the About part has no Whombat updates of its own (a self-hosted Whombat). */
export function AgentUpdatesSection({ burrow }: { burrow: string }) {
  const settings = useHostAgentSettings({ params: { burrow } }, { retry: false });
  if (!settings.data) return null;
  return (
    <section className={styles.section} aria-label={MANAGED_TEXT.updates}>
      <SectionLabel as="h2">{MANAGED_TEXT.updates}</SectionLabel>
      <div className={styles.card}>
        <AgentUpdatesSwitch burrow={burrow} />
      </div>
    </section>
  );
}
