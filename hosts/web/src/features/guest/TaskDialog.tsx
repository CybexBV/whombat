// The task dialog: follows one platform task (GET …/tasks/{id}?log_start=)
// every 1.5 s while it runs, appending the new log lines, with its state,
// who started it, how long it took and Stop for running tasks. Opened from
// the "… started" toast, the Tasks tab and outcome toasts; mounted once in
// the shell (TaskDialogHost).

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { manageApi, type TaskStatus } from '../../api/manage';
import { Dot } from '../../components/controls';
import { errorText } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/common';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatDuration, formatFull, formatTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { type OpenTask, showTask, taskSettled, useOpenTask } from './taskEvents';
import { TASK_STATE, taskSeconds, taskTypeLabel } from './taskLabels';

const POLL_MS = 1500;

export function TaskDialog({ task, onClose }: { task: OpenTask; onClose: () => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const next = useRef(0);
  const log = useRef<HTMLPreElement>(null);
  // Follow the end of the log unless the reader scrolled up.
  const stick = useRef(true);

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = await manageApi.task(task.serverId, task.platform, task.taskId, next.current, ctl.signal);
        if (ctl.signal.aborted) return;
        const add = s.log ?? [];
        if (add.length) setLines((l) => [...l, ...add]);
        next.current = s.log_next ?? next.current + add.length;
        setStatus(s);
        setError(null);
        if (s.status === 'running') {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        setStopping(false);
        taskSettled(task.taskId, { result: s.status, message: s.message ?? '' });
        for (const queryKey of [['guestList'], ['server', task.serverId], ['guests', task.serverId], ['guest', task.serverId], ['manage', task.serverId]]) void qc.invalidateQueries({ queryKey });
      } catch (err) {
        if (!ctl.signal.aborted) setError(err);
      }
    };
    void poll();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [task.serverId, task.platform, task.taskId, attempt, qc]);

  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const stop = async () => {
    setStopping(true);
    try {
      await manageApi.stopTask(task.serverId, task.platform, task.taskId);
    } catch (err) {
      setStopping(false);
      toast(t('Could not stop the task: {error}', { error: errorText(err) }), 'error');
    }
  };

  const running = status?.status === 'running';
  const state = status ? TASK_STATE[status.status] : null;
  const title = task.label ?? (status ? taskTypeLabel(status.type) : t('Task'));
  const started = status ? Date.parse(status.started) : NaN;
  const meta = status
    ? [
        Number.isFinite(started) ? t('started {time}', { time: formatTime(started) }) : '',
        status.user ? t('by {user}', { user: status.user }) : '',
        formatDuration(taskSeconds(status.started, status.ended, now)),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={title}
      description={
        <span className="task-meta">
          <span className="mono">{task.serverId}</span>
          {meta && (
            <span title={Number.isFinite(started) ? formatFull(started) : undefined}>
              {' · '}
              {meta}
            </span>
          )}
        </span>
      }
      actions={
        <>
          {running && (
            <button type="button" className="btn-ghost is-serious" disabled={stopping} onClick={() => void stop()}>
              <Icon name="square" size={14} />
              {stopping ? t('Stopping…') : t('Stop task')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn-ghost" autoFocus onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      {error && !status ? (
        <InlineRetry title={t('Could not load the task')} error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !status ? (
        <Skeleton height={160} />
      ) : (
        <>
          <div className="task-state" role="status">
            {running ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Dot color={state!.color} />}
            <span className="strong">{state!.label}</span>
            {status.message && status.message !== 'OK' && <span className="ink-2 task-msg">{status.message}</span>}
          </div>
          {error && <InlineRetry title={t('Lost the task')} error={error} onRetry={() => setAttempt((n) => n + 1)} />}
          {lines.length > 0 ? (
            <pre
              ref={log}
              className="task-log"
              tabIndex={0}
              aria-label={t('Task log')}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
              }}
            >
              {lines.join('\n')}
            </pre>
          ) : (
            <p className="lbl">{running ? t('Waiting for the first log line…') : t('This task has no log.')}</p>
          )}
        </>
      )}
    </Modal>
  );
}

/** The dialog of the task opened from a toast or the Tasks tab (one at a time). */
export function TaskDialogHost() {
  const open = useOpenTask();
  if (!open) return null;
  return <TaskDialog key={open.taskId} task={open} onClose={() => showTask(null)} />;
}
