/**
 * The tasks that ran for a guest (ported from Rackoon's `TasksTab`): newest first, in words; a row opens the task
 * dialog with its log, which follows a running one (`tasks/TaskDialog.tsx`).
 */
import {
  DASH,
  formatDuration,
  formatRelativeDay,
  TASK_STATUS_WORDS,
  taskSeconds,
  taskStatusTone,
  taskTypeText,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostTask } from '@whombat/core/domain';
import { cx } from '../../../components/cx';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import { showTask } from '../tasks/taskTracker';

import type { GuestTabProps } from './tabProps';

export function TasksTab({ burrow, serverId, guest, timeZone }: GuestTabProps) {
  const platform = guest.platform === 'incus' || guest.platform === 'libvirt' ? guest.platform : 'pve';
  const q = useHostManageRead(
    { params: { burrow, serverId }, query: { op: 'task.list', guestId: guest.id, platform } },
    // A running task moves on its own; the list follows it.
    {
      refetchInterval: (query) =>
        query.state.data?.op === 'task.list' && query.state.data.items.some((t) => t.status === 'running')
          ? 5000
          : false,
    },
  );
  const items =
    q.data?.op === 'task.list' ? [...q.data.items].sort((a, b) => b.started.localeCompare(a.started)) : [];
  const now = Date.now();
  const open = (t: HostTask) =>
    showTask({
      burrow,
      serverId,
      taskId: t.id,
      platform,
      op: '',
      what: `${taskTypeText(t.type)} · ${guest.name}`,
      ...(t.guestId ? { guestId: t.guestId } : {}),
    });
  return (
    <Card title="Tasks" meta="Newest first · open one for its log">
      {q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Task
              </th>
              <th scope="col">
                <span className={styles.narrowSr}>Result</span>
              </th>
              <th scope="col" className={styles.dropM}>
                By
              </th>
              <th scope="col" className={styles.dropXs}>
                Started
              </th>
              <th scope="col" className={styles.dropS}>
                Took
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td className={styles.cellMain}>
                  <button
                    type="button"
                    className={styles.name}
                    style={{ fontFamily: 'var(--font-sans)' }}
                    onClick={() => open(t)}
                  >
                    {taskTypeText(t.type)}
                  </button>
                </td>
                <td title={t.message && t.message !== 'OK' ? t.message : undefined}>
                  <StateCell tone={taskStatusTone(t.status)} text={TASK_STATUS_WORDS[t.status]} compact />
                </td>
                <td className={cx(styles.kind, styles.dropM)}>{t.user ?? DASH}</td>
                <td className={cx(styles.num, styles.dropXs)}>
                  {formatRelativeDay(Date.parse(t.started), now, timeZone)}
                </td>
                <td className={cx(styles.num, styles.dropS)}>
                  {formatDuration(taskSeconds(t.started, t.ended, now))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{q.isLoading ? 'Looking…' : `No tasks for ${guest.name} yet.`}</Empty>
      )}
    </Card>
  );
}
