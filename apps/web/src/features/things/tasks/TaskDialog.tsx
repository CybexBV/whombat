/**
 * One task as it runs (ported from Rackoon's `features/guest/TaskDialog.tsx`; PX-05): it asks for the task every 1.5 s
 * from the last log line it has (`logStart`, `logNext`) and appends the new lines, follows the end of the log unless
 * the reader scrolled up, says how it ended (a package task what it installed, server-updates-app.md AP-2867), and stops
 * a running task that can be stopped (not an Install, SWU-04). Opened from a “… started” toast, an outcome
 * toast and the Tasks tab; `HostTasks` mounts it once.
 */
import {
  commitOutcomeText,
  formatDuration,
  formatTime,
  hostErrorInfo,
  packageOpOf,
  packageTaskOutcomeText,
  TASK_STATUS_WORDS,
  taskSeconds,
  taskStatusTone,
  taskTypeText,
  UPDATES_WORDS,
} from '@whombat/client/hosts';
import { useWhombat } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import type { HostTask } from '@whombat/core/domain';
import { Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { currentLocale } from '../../../i18n/provider';
import { useManage } from '../manage/useManage';
import { Dot } from '../parts';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import type { TaskOutcome, TrackedTask } from './taskTracker';

const POLL_MS = 1500;

export function TaskDialog({
  task,
  onClose,
  onEnded,
}: {
  task: TrackedTask;
  onClose: () => void;
  /** The task ended while the dialog watched it. */
  onEnded?: (taskId: string, outcome: TaskOutcome) => void;
}) {
  const { client } = useWhombat();
  const { send, busy } = useManage(task.burrow, task.serverId);
  const [status, setStatus] = useState<HostTask | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const next = useRef(0);
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Try again (`attempt`) starts over
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await client.request(api.hosts.getTask, {
          params: { burrow: task.burrow, serverId: task.serverId, taskId: task.taskId },
          query: { platform: task.platform, logStart: next.current },
        });
        if (!live) return;
        if (res.status !== 'ok')
          throw new Error(commitOutcomeText(res, currentLocale()) ?? 'That didn’t work.');
        const s = res.data;
        const add = s.log ?? [];
        if (add.length) setLines((l) => [...l, ...add]);
        next.current = s.logNext ?? next.current + add.length;
        setStatus(s);
        setNow(Date.now());
        setError(null);
        if (s.status === 'running') {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        setStopping(false);
        ended.current?.(task.taskId, { result: s.status, message: s.message ?? '' });
      } catch (err) {
        if (!live) return;
        setError(err);
        // A blip: keep following while the task runs.
        timer = setTimeout(() => void poll(), POLL_MS * 2);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, task.burrow, task.serverId, task.taskId, task.platform, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new lines scroll to the end
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const running = status?.status === 'running';
  // Install can't be stopped once it started (SWU-04): the task says so.
  const stoppable = running && status?.cancellable !== false;
  const title = task.what || (status ? taskTypeText(status.type) : 'Task');
  // A package task's result in words (SWU-10): what it installed and kept back, or why it couldn't start.
  const pkgOp = packageOpOf(task.op);
  const pkgResult =
    pkgOp && status && !running
      ? status.code === 'busy'
        ? UPDATES_WORDS.busy(task.serverId)
        : packageTaskOutcomeText(pkgOp, status.packages, task.serverId)
      : null;
  const started = status ? Date.parse(status.started) : Number.NaN;
  const meta = [
    task.serverId,
    Number.isFinite(started) ? `started ${formatTime(started)}` : '',
    status?.user ? `by ${status.user}` : '',
    status ? formatDuration(taskSeconds(status.started, status.ended, now), currentLocale()) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
      <ModalTitle className={styles.dialogTitle}>{title}</ModalTitle>
      <ModalDescription className={wb.wbTaskMeta}>{meta}</ModalDescription>
      {!status ? (
        error ? (
          <p className={styles.error} role="alert">
            {hostErrorInfo(error, currentLocale()).message}{' '}
            <button type="button" className={styles.cardLink} onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : (
          <div className={styles.skeleton} style={{ height: 160 }} aria-busy="true" />
        )
      ) : (
        <>
          <div className={wb.wbTaskState} role="status">
            <Dot tone={taskStatusTone(status.status)} />
            <b>{TASK_STATUS_WORDS[status.status]}</b>
            {pkgResult ? (
              <span className={styles.muted}>{pkgResult}</span>
            ) : status.message && status.message !== 'OK' ? (
              <span className={styles.muted}>{status.message}</span>
            ) : null}
          </div>
          {lines.length ? (
            <pre
              ref={log}
              className={`${styles.code} ${wb.wbTaskLog}`}
              role="log"
              aria-live="off"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls; keyboard users need to reach it
              tabIndex={0}
              aria-label="Task log"
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
              }}
            >
              {lines.join('\n')}
            </pre>
          ) : (
            <p className={styles.dialogBody}>
              {running ? 'Waiting for the first line of its log…' : 'This task wrote no log.'}
            </p>
          )}
        </>
      )}
      <div className={styles.dialogActions}>
        {stoppable ? (
          <Button
            className={styles.spacer}
            iconStart={<Icon icon={Square} size={13} />}
            disabled={stopping || busy}
            onClick={() =>
              void (async () => {
                setStopping(true);
                const out = await send(
                  {
                    op: 'task.stop',
                    params: { task: task.taskId, platform: task.platform },
                    // A server's update check stops on the host itself (contracts 0.98.0, CT-500).
                    ...(task.platform === 'host' ? { platform: 'host' as const } : {}),
                    name: title,
                  },
                  { inline: false },
                );
                if (!out.ok) setStopping(false);
              })()
            }
          >
            {stopping ? 'Stopping…' : 'Stop the task'}
          </Button>
        ) : null}
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
