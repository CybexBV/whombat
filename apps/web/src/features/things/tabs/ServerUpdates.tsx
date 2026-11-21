/**
 * A server's operating-system updates on its System tab (Whombat server-updates.md SWU-07, SWU-10, SWU-13, SWU-14;
 * server-updates-app.md AP-2860…AP-2872): the Health card's Updates line gets Install updates and Check now, the line
 * says “Installing updates…” or “Checking for updates…” while the server reports a package task (also one started on
 * another device or before a reload) with its live log one click away in the task dialog, and how the last one ended
 * with when; without Full control it says why instead. The Restart line gets Restart now (the head's Power
 * question). Install asks first. What shows for whom is `serverUpdatesView` (`@whombat/client/hosts`).
 */
import {
  isUnraidServer,
  type PackageOp,
  type ServerUpdatesView,
  serverUpdatesView,
  UPDATES_WORDS,
} from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core/domain';
import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { ServerPowerDialog } from '../manage/ServerPowerDialog';
import { useManage } from '../manage/useManage';
import { ConfirmDialog, StateCell } from '../parts';
import styles from '../Things.module.css';
import { showTask, type TrackedTask, trackedTask, trackTask } from '../tasks/taskTracker';

export interface ServerUpdates {
  view: ServerUpdatesView;
  name: string;
  busy: boolean;
  /** Ask before installing (the question is `UpdatesDialogs`'). */
  askInstall: () => void;
  check: () => void;
  showLog: () => void;
  askRestart: () => void;
  dialogs: {
    installing: boolean;
    restarting: boolean;
    close: () => void;
    install: () => Promise<{ ok: boolean; message?: string }>;
  };
}

function packageTask(
  burrow: string,
  serverId: string,
  taskId: string,
  op: PackageOp,
  name: string,
): TrackedTask {
  return {
    burrow,
    serverId,
    taskId,
    platform: 'host',
    op: `packages.${op}`,
    what: UPDATES_WORDS.what(op, name),
    finished: UPDATES_WORDS.finished(op, name),
  };
}

export function useServerUpdates(burrow: string, serverId: string, detail: HostServerDetail): ServerUpdates {
  const { send, busy } = useManage(burrow, serverId);
  const [installing, setInstalling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const name = detail.server.id;
  const view = serverUpdatesView({
    server: name,
    system: detail.health?.system ?? null,
    remoteControl: detail.server.remoteControl,
    unraid: isUnraidServer(detail),
    connected: detail.server.agent.connected !== false && detail.server.status !== 'offline',
    now: Date.parse(detail.asOf),
  });
  const running = view.running;
  // A task the server reports (started on another device, or before a reload) is followed here too: its end
  // refreshes the page and says how it went, as for one started here.
  useEffect(() => {
    if (running && !trackedTask(running.taskId))
      trackTask(packageTask(burrow, serverId, running.taskId, running.op, name));
  }, [running, burrow, serverId, name]);
  const start = (op: PackageOp, inline: boolean) =>
    send(
      {
        op: op === 'install' ? 'packages.install' : 'packages.check',
        platform: 'host',
        ...(op === 'install' ? { confirm: true } : {}),
        name,
        what: UPDATES_WORDS.what(op, name),
        started: UPDATES_WORDS.started(op, name),
        finished: UPDATES_WORDS.finished(op, name),
      },
      { inline },
    );
  return {
    view,
    name,
    busy,
    askInstall: () => setInstalling(true),
    check: () => void start('check', false),
    showLog: () => {
      if (running)
        showTask(
          trackedTask(running.taskId) ?? packageTask(burrow, serverId, running.taskId, running.op, name),
        );
    },
    askRestart: () => setRestarting(true),
    dialogs: {
      installing,
      restarting,
      close: () => {
        setInstalling(false);
        setRestarting(false);
      },
      install: async () => {
        const out = await start('install', true);
        if (out.ok) setInstalling(false);
        return out.ok ? { ok: true } : { ok: false, message: out.message };
      },
    },
  };
}

/** The Health card's Updates line (SWU-10). */
export function UpdatesRow({ u }: { u: ServerUpdates }) {
  const v = u.view;
  return (
    <div className={styles.row} data-row="updates">
      <div className={styles.rowMain}>
        <b>{UPDATES_WORDS.title}</b>
        <small>
          <StateCell tone={v.line.tone} text={v.line.text} />
        </small>
        {v.result ? (
          <small>
            {/* “Installed 23 updates · 12 min ago”: the sentence's stop gives way to the time (AP-2863). */}
            {v.result.text.replace(/\.$/, '')} · {v.result.when}
          </small>
        ) : null}
        {v.note ? <small>{v.note}</small> : null}
      </div>
      {v.line.checked ? <span className={styles.rowEnd}>{v.line.checked}</span> : null}
      {v.running ? (
        <Button size="sm" onClick={u.showLog}>
          {UPDATES_WORDS.showLog}
        </Button>
      ) : null}
      {v.check ? (
        <Button size="sm" disabled={u.busy} onClick={u.check}>
          {UPDATES_WORDS.check}
        </Button>
      ) : null}
      {v.install ? (
        <Button size="sm" variant="primary" disabled={u.busy} onClick={u.askInstall}>
          {UPDATES_WORDS.install}
        </Button>
      ) : null}
    </div>
  );
}

/** The Health card's Restart line, with Restart now when a restart is needed and the viewer may (SWU-10). */
export function RestartRow({ u }: { u: ServerUpdates }) {
  const r = u.view.restart;
  return (
    <div className={styles.row} data-row="restart">
      <div className={styles.rowMain}>
        <b>{UPDATES_WORDS.restartTitle}</b>
        <small>
          <StateCell tone={r.tone} text={r.text} />
        </small>
      </div>
      {r.button ? (
        <Button size="sm" onClick={u.askRestart}>
          {UPDATES_WORDS.restartNow}
        </Button>
      ) : null}
    </div>
  );
}

/** Install updates elsewhere on the tab (Look inside → Updates, the hint): the same question. */
export function InstallUpdatesButton({ u }: { u: ServerUpdates }) {
  if (!u.view.install) return null;
  return (
    <Button size="sm" variant="primary" disabled={u.busy} onClick={u.askInstall}>
      {UPDATES_WORDS.install}
    </Button>
  );
}

/** The install question (SWU-10) and the restart question (the head's Power, ONE-12), once per tab. */
export function UpdatesDialogs({
  u,
  burrow,
  serverId,
  thisWhombat,
}: {
  u: ServerUpdates;
  burrow: string;
  serverId: string;
  thisWhombat: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    u.dialogs.close();
  };
  return (
    <>
      <ConfirmDialog
        open={u.dialogs.installing}
        title={UPDATES_WORDS.confirmTitle(u.view.count, u.name)}
        body={UPDATES_WORDS.confirmBody(u.name)}
        confirm={UPDATES_WORDS.install}
        busy={u.busy}
        error={error}
        onClose={close}
        onConfirm={() =>
          void u.dialogs.install().then((out) => {
            if (out.ok) setError(null);
            else setError(out.message ?? null);
          })
        }
      />
      <ServerPowerDialog
        burrow={burrow}
        serverId={serverId}
        name={u.name}
        action={u.dialogs.restarting ? 'host_reboot' : null}
        thisWhombat={thisWhombat}
        onClose={close}
      />
    </>
  );
}
