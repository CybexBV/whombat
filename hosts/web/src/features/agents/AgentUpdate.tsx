// Agent self-update in Settings › Agents: per agent the rollout state, an
// Update button (disabled with the reason when the agent cannot update
// itself), and "Update all". The hub updates one agent at a time and stops
// at the first failure; it asks for a recent sign-in first.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { qk } from '../../api/queries';
import type { AgentInfo } from '../../api/types';
import { errorText } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { Warn } from './agentParts';
import { formatVersion } from './ApproveForm';
import { updateView } from './updateView';

export function useUpdateAgents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (servers: string[]) => api.updateAgents(servers),
    onSuccess: (r) =>
      toast(
        r.servers.length === 1
          ? t('Updating {server} to {version}.', { server: r.servers[0]!, version: formatVersion(r.version) })
          : t('Updating {n} agents to {version}, one at a time.', { n: r.servers.length, version: formatVersion(r.version) }),
        'info',
      ),
    onError: (err) => toast(t('The update did not start: {error}', { error: errorText(err) }), 'error'),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.agents }),
  });
}

/** Nothing for agents on the hub's build; else the rollout state or the Update button. */
export function AgentUpdateLine({ a, running, update }: { a: AgentInfo; running: boolean; update: ReturnType<typeof useUpdateAgents> }) {
  const v = updateView(a);
  if (v.kind === 'none') return null;
  if (v.kind === 'busy') {
    return (
      <span className="state lbl" role="status">
        <span className="spinner spinner-sm" aria-hidden="true" />
        {v.text}
      </span>
    );
  }
  const blocked = !v.canUpdate || running || update.isPending;
  const reason = !v.canUpdate ? v.text : running ? t('An update is running') : undefined;
  const button = (
    <button
      type="button"
      className="btn-ghost row-action agent-update"
      aria-disabled={blocked || undefined}
      title={reason}
      onClick={() => !blocked && update.mutate([a.server_id])}
    >
      <Icon name="download" size={14} />
      {t('Update to {version}', { version: formatVersion(v.version) })}
      <span className="sr-only"> {t('on {id}', { id: a.server_id })}</span>
    </button>
  );
  return (
    <>
      {v.kind === 'failed' && <Warn>{t('Update failed: {error}', { error: v.text ?? '' })}</Warn>}
      {(v.kind !== 'failed' || v.canUpdate) && button}
      {v.kind === 'blocked' && <span className="lbl">{v.text}</span>}
    </>
  );
}
