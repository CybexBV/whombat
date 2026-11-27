/**
 * The questions and sheets of an Unraid server on the phone (Whombat incus-unraid.md IU-05…IU-07;
 * incus-unraid-mobile.md AP-1635…AP-1638): Stop the array (asked: its shares, containers and VMs stop), Check parity
 * (write corrections off unless switched on), Cancel the check (asked), a disk's details with Spin up / Spin down, a
 * plugin's Update and Update all (asked), and a notification's text with Archive. Every command runs as an Unraid task
 * that says when it starts and when it ends, in the web's words (`unraidChangeWords`); a parity check's task ends when
 * the check runs (“The parity check on blackbox is running.”), and Whombat says how the check itself ended.
 */

import { arrayStopWords, unraidChangeWords } from '@whombat/client/hosts';
import {
  type DiskRowView,
  diskFacts,
  type NotificationRow,
  type PluginRow,
} from '@whombat/client/hosts/mobile';
import type { HostGuest, HostUnraidDetail } from '@whombat/core';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useMobileT } from '../../i18n';
import { OneCard } from '../../ui/assistant';
import { Facts } from '../../ui/facts';
import { OneSheet } from '../../ui/oneSheet';
import { SwitchLine } from '../guest/parts';
import { type ChangeOutcome, type ManageSend, useManageChange } from '../guest/useServerChange';

/** One Unraid host op (`platform: unraid`), named by the server in its notes. */
export function useUnraidOp(serverId: string, serverName: string) {
  const { send, busy } = useManageChange(serverId);
  const run = useCallback(
    (op: ManageSend['op'], extra: Partial<ManageSend> = {}): Promise<ChangeOutcome> =>
      send({ op, platform: 'unraid', name: serverName, ...extra }),
    [send, serverName],
  );
  return { run, busy };
}

function close(o: ChangeOutcome, onClose: () => void, setError: (s: string) => void) {
  if (o.ok || o.waiting) onClose();
  else setError(o.message);
}

/** Stop the array: asked, then sent with `confirm`. */
export function StopArraySheet({
  serverId,
  serverName,
  unraid,
  guests,
  onClose,
}: {
  serverId: string;
  serverName: string;
  unraid: HostUnraidDetail;
  guests: readonly HostGuest[];
  onClose: () => void;
}) {
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={serverName}
      tone="bad"
      title={`Stop the array on ${serverName}?`}
      body={arrayStopWords(unraid, guests, serverName)}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Stop the array',
          variant: 'primary',
          onPress: () => void run('array.stop', { confirm: true }).then((o) => close(o, onClose, setError)),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

/** Check parity: reads every disk; corrections only when switched on. */
export function CheckParitySheet({
  serverId,
  serverName,
  onClose,
}: {
  serverId: string;
  serverName: string;
  onClose: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [correct, setCorrect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      title={`Check parity on ${serverName}`}
      body={tMobile('screens.it-reads-every-disk-that-takes-hours-and')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Start the check',
          variant: 'primary',
          onPress: () =>
            void run('parity.start', { params: { correct } }).then((o) => close(o, onClose, setError)),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    >
      <View style={{ marginTop: 12 }}>
        <SwitchLine
          label="Write corrections (only when you know why there are errors)"
          value={correct}
          onChange={setCorrect}
        />
      </View>
    </OneSheet>
  );
}

/** Cancel the running check: asked. */
export function CancelParitySheet({
  serverId,
  serverName,
  onClose,
}: {
  serverId: string;
  serverName: string;
  onClose: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={serverName}
      tone="warn"
      title={tMobile('screens.cancel-the-parity-check')}
      body={tMobile('screens.it-stops-where-it-is-you-can-start')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: 'Cancel the check',
          variant: 'primary',
          onPress: () =>
            void run('parity.cancel', { confirm: true }).then((o) => close(o, onClose, setError)),
        },
        { id: 'cancel', label: 'Keep checking', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

/** A disk: what Unraid's Main row shows, and Spin up or Spin down. */
export function DiskSheet({
  serverId,
  serverName,
  row,
  canChange,
  onClose,
}: {
  serverId: string;
  serverName: string;
  row: DiskRowView;
  canChange: boolean;
  onClose: () => void;
}) {
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [error, setError] = useState<string | null>(null);
  const op = row.spunDown ? 'disk.spin_up' : 'disk.spin_down';
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={row.status.text}
      tone={
        row.status.tone === 'ok'
          ? 'ok'
          : row.status.tone === 'bad'
            ? 'bad'
            : row.status.tone === 'warn'
              ? 'warn'
              : 'mut'
      }
      title={row.title}
      body={row.line}
      busy={busy ? 'spin' : null}
      buttons={[
        ...(canChange && row.canSpin
          ? [
              {
                id: 'spin',
                label: row.spunDown ? 'Spin up' : 'Spin down',
                variant: 'secondary' as const,
                onPress: () =>
                  void run(op, {
                    params: { disk: row.name },
                    follow: { kind: op, extra: row.title },
                  }).then((o) => close(o, onClose, setError)),
              },
            ]
          : []),
        {
          id: 'close',
          label: 'Close',
          variant: canChange && row.canSpin ? 'quiet' : 'primary',
          onPress: onClose,
        },
      ]}
      note={error}
    >
      <View style={{ marginTop: 14 }}>
        <OneCard>
          <View style={{ padding: 14 }}>
            <Facts facts={diskFacts(row.disk)} />
          </View>
        </OneCard>
      </View>
    </OneSheet>
  );
}

/** Update one plugin, or all of them: asked (Unraid installs it now). */
export function PluginUpdateSheet({
  serverId,
  serverName,
  plugin,
  count,
  onClose,
}: {
  serverId: string;
  serverName: string;
  /** One plugin, or null for all with an update. */
  plugin: PluginRow | null;
  count: number;
  onClose: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [error, setError] = useState<string | null>(null);
  const title = plugin
    ? `Update ${plugin.name} to ${plugin.update}?`
    : `Update ${count === 1 ? 'the plugin' : `${count} plugins`} on ${serverName}?`;
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={serverName}
      tone="warn"
      title={title}
      body={tMobile('screens.unraid-installs-the-new-version-now-most-plugins')}
      busy={busy ? 'go' : null}
      buttons={[
        {
          id: 'go',
          label: plugin ? 'Update' : 'Update all',
          variant: 'primary',
          onPress: () =>
            void run('plugin.update', {
              params: { plugin: plugin?.file ?? 'all' },
              confirm: true,
              ...(plugin ? { follow: { kind: 'plugin.update', extra: plugin.name } } : {}),
            }).then((o) => close(o, onClose, setError)),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}

/** A notification: its whole text and Archive (done at once). */
export function NotificationSheet({
  serverId,
  serverName,
  row,
  canChange,
  onClose,
}: {
  serverId: string;
  serverName: string;
  row: NotificationRow;
  canChange: boolean;
  onClose: () => void;
}) {
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [error, setError] = useState<string | null>(null);
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={row.meta}
      tone={row.tone ?? 'mut'}
      title={row.title}
      body={row.line}
      busy={busy ? 'archive' : null}
      buttons={[
        ...(canChange
          ? [
              {
                id: 'archive',
                label: 'Archive',
                variant: 'primary' as const,
                onPress: () =>
                  void run('notification.archive', {
                    params: { id: row.id },
                    done: unraidChangeWords('notification.archive', serverName, { target: row.id }).finished,
                  }).then((o) => close(o, onClose, setError)),
              },
            ]
          : []),
        { id: 'close', label: 'Close', variant: canChange ? 'quiet' : 'primary', onPress: onClose },
      ]}
      note={error}
    />
  );
}
