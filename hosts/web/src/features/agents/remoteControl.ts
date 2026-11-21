// Remote control per server (REMOTE-CONSOLE 5): the hub toggle (admin
// switch) and the agent's local policy must both allow a capability. Shared
// by the agents list (summary line) and the server's settings page (switches).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { qk } from '../../api/queries';
import type { AgentInfo, RemoteControlToggles, ServerSettings } from '../../api/types';
import { errorText } from '../../components/forms';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';

export type Capability = keyof RemoteControlToggles;
export const CAPS: Capability[] = ['console', 'power', 'manage', 'diagnose', 'host_shell', 'host_power'];
export const CAP_LABEL: Record<Capability, string> = {
  console: t('Console'),
  power: t('Power actions'),
  manage: t('Manage guests'),
  diagnose: t('Diagnostics'),
  host_shell: t('Host shell'),
  host_power: t('Host power'),
};
export const CAP_TEXT: Record<Capability, string> = {
  console: t('console'),
  power: t('power actions'),
  manage: t('managing guests'),
  diagnose: t('diagnostics'),
  host_shell: t('the host shell'),
  host_power: t('host power'),
};
/** Host access: separate switches for the host itself (root shell, reboot). Diagnostics is not host access: read-only, on by default. */
export const HOST_CAPS: Capability[] = ['host_shell', 'host_power'];

/** on: both allow it; off: the hub switch is off; blocked: on here, but the agent's config forbids it. */
export type CapState = 'on' | 'off' | 'blocked';

export function capState(a: Pick<AgentInfo, 'remote_control' | 'agent_policy'>, cap: Capability): CapState {
  if (!a.remote_control?.[cap]) return 'off';
  return a.agent_policy?.[cap] ? 'on' : 'blocked';
}

/** One line for the agents list: "Console and power", "Console only", "Off", "Console blocked on host", … */
export function remoteSummary(a: Pick<AgentInfo, 'remote_control' | 'agent_policy'>): { text: string; warn: boolean } {
  const c = capState(a, 'console');
  const p = capState(a, 'power');
  if (c === 'blocked' && p === 'blocked') return { text: t('Console and power blocked on host'), warn: true };
  if (c === 'blocked') return { text: p === 'on' ? t('Power on · console blocked on host') : t('Console blocked on host'), warn: true };
  if (p === 'blocked') return { text: c === 'on' ? t('Console on · power blocked on host') : t('Power blocked on host'), warn: true };
  if (c === 'on' && p === 'on') return { text: t('Console and power'), warn: false };
  if (c === 'on') return { text: t('Console only'), warn: false };
  if (p === 'on') return { text: t('Power only'), warn: false };
  return { text: t('Off'), warn: false };
}

/** Hub toggle mutation, optimistic on the agents list with a per-field rollback. */
export function useRemoteControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cap, value }: { id: string; cap: Capability; value: boolean }) => api.patchServer(id, { remote_control: { [cap]: value } }),
    onMutate: async ({ id, cap, value }) => {
      await qc.cancelQueries({ queryKey: qk.agents });
      qc.setQueryData<AgentInfo[]>(qk.agents, (list) => list?.map((a) => (a.server_id === id ? { ...a, remote_control: { ...a.remote_control, [cap]: value } } : a)));
    },
    onError: (err, { id, cap, value }) => {
      qc.setQueryData<AgentInfo[]>(qk.agents, (list) => list?.map((a) => (a.server_id === id ? { ...a, remote_control: { ...a.remote_control, [cap]: !value } } : a)));
      toast(value ? t('Could not turn {cap} on for {id}: {error}', { cap: CAP_TEXT[cap], id, error: errorText(err) }) : t('Could not turn {cap} off for {id}: {error}', { cap: CAP_TEXT[cap], id, error: errorText(err) }), 'error');
    },
    onSuccess: (settings: ServerSettings | null, { id }) => {
      if (settings && typeof settings === 'object' && settings.remote_control) {
        qc.setQueryData(qk.settings(id), settings);
        qc.setQueryData<AgentInfo[]>(qk.agents, (list) =>
          list?.map((a) => (a.server_id === id ? { ...a, remote_control: settings.remote_control, agent_policy: settings.agent_policy ?? a.agent_policy } : a)),
        );
      }
    },
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.agents });
      void qc.invalidateQueries({ queryKey: ['server', id] });
    },
  });
}

/** Where the host-side switches live and how the agent applies a change, by install method. */
export function hostConfigFix(install: string | null | undefined): { file: string; reload: string } {
  switch (install) {
    case 'unraid':
      return { file: '/boot/config/plugins/rackoon/agent.toml', reload: '/etc/rc.d/rc.rackoon-agent reload' };
    case 'openrc':
      return { file: '/etc/rackoon/agent.toml', reload: 'rc-service rackoon-agent reload' };
    case 'sysv':
      return { file: '/etc/rackoon/agent.toml', reload: '/etc/init.d/rackoon-agent reload' };
    default:
      return { file: '/etc/rackoon/agent.toml', reload: 'systemctl reload rackoon-agent' };
  }
}
