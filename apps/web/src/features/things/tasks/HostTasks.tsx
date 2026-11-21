/**
 * The task tracker (PX-05; Rackoon's `useTaskEvents` and `TaskDialogHost`), mounted once in the shell: the tasks
 * started in this browser end through the `hosts.task` frame, or by asking every few seconds when no frame came (no
 * socket, an older hub); each gets one toast with how it went (“Backup of web finished.”, “Clone of web failed: …”, a
 * failure or warnings with Show log), the server reads refetch, and a created guest opens. The task dialog lives here.
 */
import { serverHref, taskOutcomeText } from '@whombat/client/hosts';
import { useRefreshHosts } from '@whombat/client/hosts/react';
import { useRealtimeEvent, useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { useToast } from '../../../components/Toast';
import { TaskDialog } from './TaskDialog';
import {
  settleTask,
  showTask,
  type TaskOutcome,
  trackedTask,
  useOpenTask,
  useRunningTasks,
} from './taskTracker';

/** How often a running task is asked about when no frame said it ended. */
const ASK_MS = 3000;

export function HostTasks() {
  const toast = useToast();
  const { client } = useWhombat();
  const refresh = useRefreshHosts();
  const navigate = useNavigateHref();
  const open = useOpenTask();
  const running = useRunningTasks();
  const openRef = useRef(open);
  openRef.current = open;

  const finish = useCallback(
    (taskId: string, outcome: TaskOutcome) => {
      const t = settleTask(taskId, outcome);
      if (!t) return;
      refresh([
        'hosts.getServer',
        'hosts.getGuest',
        'hosts.listGuests',
        'hosts.manageRead',
        'hosts.fleet',
        // Look inside's waiting updates after a package task (SWU-05).
        ...(t.op.startsWith('packages.') ? (['hosts.inspect'] as const) : []),
      ]);
      // A created guest opens on its server's page (Rackoon's create flow).
      if (t.op === 'guest.create' && outcome.result !== 'error' && t.newId)
        navigate(`${serverHref(t.serverId)}?guest=${encodeURIComponent(t.newId)}`);
      // The dialog shows the outcome itself.
      if (openRef.current?.taskId === taskId) return;
      const text =
        outcome.result === 'ok' && t.finished
          ? t.finished
          : taskOutcomeText(t.what, outcome.result, outcome.message);
      toast.show(
        text,
        outcome.result === 'ok'
          ? undefined
          : {
              duration: 10_000,
              action: { label: 'Show log', onAction: () => showTask(trackedTask(taskId) ?? t) },
            },
      );
    },
    [refresh, navigate, toast],
  );

  useRealtimeEvent('hosts.task', (e) => {
    if (e.taskId) finish(e.taskId, { result: e.result, message: e.message ?? '' });
  });

  // Ask about the running ones the dialog isn't following (it asks every 1.5 s itself).
  useEffect(() => {
    if (!running.length) return;
    let live = true;
    const ask = async () => {
      for (const t of running) {
        if (!live || openRef.current?.taskId === t.taskId) continue;
        try {
          const res = await client.request(api.hosts.getTask, {
            params: { burrow: t.burrow, serverId: t.serverId, taskId: t.taskId },
            query: { platform: t.platform, logStart: -1 },
          });
          if (live && res.status === 'ok' && res.data.status !== 'running')
            finish(t.taskId, { result: res.data.status, message: res.data.message ?? '' });
        } catch {
          // Asked again next round.
        }
      }
    };
    const timer = setInterval(() => void ask(), ASK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, client, finish]);

  if (!open) return null;
  return <TaskDialog key={open.taskId} task={open} onClose={() => showTask(null)} onEnded={finish} />;
}
