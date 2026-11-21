// Tasks of a Proxmox guest (docs/MANAGE.md, Tasks): the platform's task list,
// newest first, with friendly names; a task opens the task dialog with its
// log.

import { type ManagePlatform, useGuestTasks } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { Dot } from '../../components/controls';
import { InlineRetry } from '../../components/InlineRetry';
import { useNow } from '../../lib/clock';
import { formatDuration, formatFull, formatRelativeDay } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { GuestTabProps } from './GuestPage';
import { showTask } from './taskEvents';
import { TASK_STATE, taskSeconds, taskTypeLabel } from './taskLabels';

export function TasksTab({ serverId, guest }: GuestTabProps) {
  const list = useGuestTasks(serverId, guest.id);
  const now = useNow();
  const platform = guest.platform as ManagePlatform;
  const items = list.data ?? [];
  return (
    <section className="card" aria-labelledby="tasks-title">
      <div className="card-head">
        <h2 className="h2" id="tasks-title">
          {t('Tasks')}
        </h2>
        <span className="sub">{t('Newest first · open a task for its log')}</span>
      </div>
      {list.isError ? (
        <div className="card-body">
          <InlineRetry title={t('Could not list the tasks')} error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : !list.data ? (
        <div className="card-body">
          <Skeleton height={96} />
        </div>
      ) : items.length === 0 ? (
        <div className="guests-empty">{t('No tasks for {name} yet.', { name: guest.name })}</div>
      ) : (
        <div className="gt-scroll">
          <table className="lc-table">
            <thead>
              <tr>
                <th scope="col">{t('Task')}</th>
                <th scope="col">{t('Status')}</th>
                <th scope="col" className="hide-phone">
                  {t('User')}
                </th>
                <th scope="col">{t('Started')}</th>
                <th scope="col" className="num">
                  {t('Duration')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const s = TASK_STATE[x.status] ?? TASK_STATE.error;
                const label = taskTypeLabel(x.type);
                const started = Date.parse(x.started);
                return (
                  <tr key={x.id} className="is-clickable" onClick={() => showTask({ serverId, platform, taskId: x.id, label: `${label} · ${guest.name}` })}>
                    <td>
                      <button
                        type="button"
                        className="btn-text lc-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          showTask({ serverId, platform, taskId: x.id, label: `${label} · ${guest.name}` });
                        }}
                      >
                        {label}
                      </button>
                    </td>
                    <td>
                      <span className="state" title={x.message && x.message !== 'OK' ? x.message : undefined}>
                        {x.status === 'running' ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Dot color={s.color} />}
                        {s.label}
                      </span>
                    </td>
                    <td className="ink-2 hide-phone lc-user">
                      <span className="ellipsis">{x.user ?? ''}</span>
                    </td>
                    <td className="ink-2 nowrap" title={Number.isFinite(started) ? formatFull(started) : undefined}>
                      {Number.isFinite(started) ? formatRelativeDay(started, now) : x.started}
                    </td>
                    <td className="num ink-2">{formatDuration(taskSeconds(x.started, x.ended, now))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
