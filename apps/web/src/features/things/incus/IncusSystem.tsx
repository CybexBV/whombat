/**
 * Incus on a server's System tab (Whombat incus-unraid.md IU-04, IU-07, IU-08; AP-1578): Incus's own warnings first,
 * only when it has some (less-is-more.md AP-1752); the Incus version and what it holds with its projects in one card
 * (AP-1766); its operations — the running ones (Cancel when Incus allows it) and the last 48 hours, each opening its
 * log. Projects are changed with the incus command (IU-10).
 */
import {
  DASH,
  formatAgoIso,
  formatDuration,
  formatRelativeDay,
  incusDetail,
  incusDoneText,
  incusOperationText,
  incusWarnings,
  plural,
  TASK_STATUS_WORDS,
  taskCancellable,
  taskSeconds,
  taskStatusTone,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostServerDetail, HostTask } from '@whombat/core/domain';
import { cx } from '../../../components/cx';
import { currentLocale } from '../../../i18n/provider';
import { useManage } from '../manage/useManage';
import { Card, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import { showTask } from '../tasks/taskTracker';
import wi from './Incus.module.css';
import { useIncusCanChange } from './IncusStorage';

const WINDOW_MS = 48 * 3_600_000;

export function IncusSystem({
  burrow,
  serverId,
  detail,
  timeZone,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone?: string;
}) {
  const inc = incusDetail(detail);
  const opsOn = detail.server.remoteControl.manage === true;
  if (!inc) return null;
  const instances = inc.projects.reduce((a, p) => a + p.instances, 0);
  const running = inc.projects.reduce((a, p) => a + p.running, 0);
  const warnings = incusWarnings(detail);
  return (
    <>
      {warnings.length ? (
        <Card title="Incus warnings" meta={plural(warnings.length, 'warning')}>
          <div className={styles.rows}>
            {warnings.map((w) => (
              <div key={`${w.type}:${w.message}:${w.project ?? ''}`} className={styles.row}>
                <StateCell tone="warn" text="" />
                <div className={styles.rowMain}>
                  <b style={{ fontWeight: 400 }}>{w.message}</b>
                  <small>
                    {[
                      w.count > 1 ? `${w.count} times` : null,
                      w.project ? `project ${w.project}` : null,
                      w.lastSeen
                        ? `last ${formatAgoIso(w.lastSeen, Date.parse(detail.asOf), currentLocale())}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card title="Incus" meta={`${inc.version} · ${inc.clustered ? 'in a cluster' : 'one server'}`}>
        <div className={styles.facts2}>
          <Fact label="Instances" value={`${running} of ${instances}`} note="running" />
          <Fact label="Pools" value={String(inc.pools.length)} />
          <Fact label="Images" value={String(inc.images.length)} />
          <Fact label="Profiles" value={String(inc.profiles.length)} />
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Project
              </th>
              <th scope="col">Instances</th>
              <th scope="col" className={styles.dropXs}>
                Running
              </th>
            </tr>
          </thead>
          <tbody>
            {inc.projects.map((p) => (
              <tr key={p.name}>
                <td className={styles.cellMain}>
                  <span className={styles.mono}>{p.name}</span>
                  {p.description ? <span className={wi.wiSub}>{p.description}</span> : null}
                </td>
                <td className={styles.num}>{p.instances}</td>
                <td className={cx(styles.num, styles.dropXs)}>{p.running}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.cardNote}>Projects are changed with the incus command.</p>
      </Card>
      {opsOn ? <Operations burrow={burrow} serverId={serverId} detail={detail} timeZone={timeZone} /> : null}
    </>
  );
}

function Operations({
  burrow,
  serverId,
  detail,
  timeZone,
}: {
  burrow: string;
  serverId: string;
  detail: HostServerDetail;
  timeZone?: string;
}) {
  const canChange = useIncusCanChange(burrow, detail);
  const { send, busy } = useManage(burrow, serverId);
  const q = useHostManageRead(
    { params: { burrow, serverId }, query: { op: 'task.list', platform: 'incus' } },
    {
      refetchInterval: (query) =>
        query.state.data?.op === 'task.list' && query.state.data.items.some((t) => t.status === 'running')
          ? 5000
          : false,
    },
  );
  const now = Date.now();
  const items =
    q.data?.op === 'task.list'
      ? q.data.items
          .filter((t) => t.status === 'running' || now - Date.parse(t.started) < WINDOW_MS)
          .sort(
            (a, b) =>
              Number(b.status === 'running') - Number(a.status === 'running') ||
              b.started.localeCompare(a.started),
          )
      : [];
  const open = (t: HostTask) =>
    showTask({
      burrow,
      serverId,
      taskId: t.id,
      platform: 'incus',
      op: '',
      what: incusOperationText(t),
      ...(t.guestId ? { guestId: t.guestId } : {}),
    });
  const cancel = (t: HostTask) =>
    void send(
      {
        op: 'task.stop',
        params: { task: t.id, platform: 'incus' },
        name: incusOperationText(t),
        done: incusDoneText('task.stop', ''),
      },
      { inline: false },
    );
  // Nothing ran: no card (AP-1752).
  if (!q.error && !items.length) return null;
  return (
    <Card title="Operations" meta="Running, and the last 48 hours">
      {q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Operation
              </th>
              <th scope="col">
                <span className={styles.narrowSr}>Result</span>
              </th>
              <th scope="col" className={styles.dropS}>
                Started
              </th>
              <th scope="col" className={styles.dropM}>
                Took
              </th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
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
                    {incusOperationText(t)}
                  </button>
                  {t.status === 'error' && t.message ? <span className={wi.wiSub}>{t.message}</span> : null}
                </td>
                <td>
                  <StateCell tone={taskStatusTone(t.status)} text={TASK_STATUS_WORDS[t.status]} compact />
                </td>
                <td className={cx(styles.num, styles.dropS)}>
                  {formatRelativeDay(Date.parse(t.started), now, timeZone, currentLocale())}
                </td>
                <td className={cx(styles.num, styles.dropM)}>
                  {t.status === 'running'
                    ? DASH
                    : formatDuration(taskSeconds(t.started, t.ended, now), currentLocale())}
                </td>
                <td>
                  {t.status === 'running' && taskCancellable(t) && canChange ? (
                    <button
                      type="button"
                      className={`${styles.cardLink} ${wi.wiSerious}`}
                      style={{ marginLeft: 0 }}
                      disabled={busy}
                      onClick={() => cancel(t)}
                    >
                      Cancel <span className={styles.srOnly}>{incusOperationText(t)}</span>
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={styles.fact}>
      <span className={styles.lbl}>{label}</span>
      <b>{value}</b>
      {note ? <span>{note}</span> : null}
    </div>
  );
}
