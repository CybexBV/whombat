/**
 * One `hosts.manage` change at a time (ported from Rackoon's `useManageChange`): the toast says it was done, or that its
 * task started with Show progress (PX-05: the task is tracked, `HostTasks` toasts how it ended); a refusal comes back
 * for the dialog to show, with the field errors and whether the configuration changed meanwhile (“Changed meanwhile —
 * review again.”, which refetches it).
 */
import { useQueryClient } from '@tanstack/react-query';
import { hostErrorInfo, manageDoneText, taskStartedText, taskWhat } from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { queryKeys } from '@whombat/client/query';
import { api } from '@whombat/core/contracts';
import type { HostManageOp, HostManageResult } from '@whombat/core/domain';
import { useCallback } from 'react';
import { useToast } from '../../../components/Toast';
import { useChangeRunner } from '../parts';
import { showTask, type TaskPlatform, type TrackedTask, trackTask } from '../tasks/taskTracker';

export interface ManageSend {
  op: HostManageOp;
  guestId?: string;
  params?: Record<string, unknown>;
  digest?: string;
  confirm?: boolean;
  confirmName?: string;
  /** Names the thing changed in the toast. */
  name: string;
  /** What a started task's toasts call it (default “Backup of <name>”, by op). */
  what?: string;
  /** The toast when it was done at once (default by op: “Saved web’s settings.”). */
  done?: string;
  /** Whose host routes (`unraid` for an Unraid server's array, parity, plugins; AP-1592); also the task's. */
  platform?: TaskPlatform;
  /** The toast when its task started (default “<what> started.”). */
  started?: string;
  /** The toast when its task ended well (default “<what> finished.”). */
  finished?: string;
}

export type ManageOutcome =
  | { ok: true; result: HostManageResult }
  | { ok: false; message: string; conflict: boolean; fields: Record<string, string> };

export function useManage(burrow: string, serverId: string) {
  const change = useHostsChange(api.hosts.manage);
  const { run, busy } = useChangeRunner();
  const toast = useToast();
  const qc = useQueryClient();
  const send = useCallback(
    async (s: ManageSend, opts: { inline?: boolean } = { inline: true }): Promise<ManageOutcome> => {
      const out = await run(
        () =>
          change.mutateAsync({
            params: { burrow, serverId },
            body: {
              op: s.op,
              ...(s.guestId ? { guestId: s.guestId } : {}),
              params: (s.params ?? {}) as never,
              ...(s.digest ? { digest: s.digest } : {}),
              ...(s.confirm ? { confirm: true } : {}),
              ...(s.confirmName ? { confirmName: s.confirmName } : {}),
              ...(s.platform ? { platform: s.platform } : {}),
            },
          }),
        (data) =>
          // A started task gets its own toast below; a running Proxmox guest takes some changes at its next restart:
          // the toast says so (Rackoon's doneText).
          data.task
            ? null
            : s.op === 'config.set' && data.changes?.some((c) => c.pending)
              ? s.guestId?.startsWith('libvirt:')
                ? `Saved. ${s.name} takes it when it next starts.`
                : `Saved. ${s.name} takes it at its next restart.`
              : (s.done ?? manageDoneText(s.op, s.name, false)),
        opts,
      );
      if (out.ok) {
        const taskId = out.data.task?.id;
        if (taskId) {
          const task: TrackedTask = {
            burrow,
            serverId,
            taskId,
            // An Incus operation's id says so (`incus:<uuid>`), also for host changes that send no platform.
            platform:
              s.platform ??
              (taskId.startsWith('libvirt:') || s.guestId?.startsWith('libvirt:')
                ? 'libvirt'
                : taskId.startsWith('incus:') ||
                    s.guestId?.startsWith('incus:') ||
                    s.params?.platform === 'incus'
                  ? 'incus'
                  : 'pve'),
            op: s.op,
            what: s.what ?? taskWhat(s.op, s.name),
            ...(s.finished ? { finished: s.finished } : {}),
            ...(s.guestId ? { guestId: s.guestId } : {}),
            ...(out.data.newId ? { newId: out.data.newId } : {}),
          };
          trackTask(task);
          toast.show(s.started ?? taskStartedText(task.what), {
            action: { label: 'Show progress', onAction: () => showTask(task) },
          });
        }
        return { ok: true, result: out.data };
      }
      const info = out.error
        ? hostErrorInfo(out.error)
        : { message: out.message, conflict: false, fields: {} };
      // The configuration changed meanwhile: read it again, so the review shows what is there now.
      if (info.conflict) void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.manageRead') });
      return { ok: false, message: info.message, conflict: info.conflict, fields: info.fields };
    },
    [change, run, burrow, serverId, qc, toast],
  );
  return { send, busy };
}
