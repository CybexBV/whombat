/** A guest's snapshots (ported from Rackoon's `SnapshotsTab`/`SnapshotsDialog`): take one, go back to one or remove one (both asked). */
import { DASH, formatRelativeDay, selfAllowsAction } from '@whombat/client/hosts';
import { useHostManageRead, useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostSnapshot } from '@whombat/core/domain';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { useWebI18n } from '../../../i18n/provider';
import { Check, FormDialog, TextField } from '../manage/fields';
import { Card, ConfirmDialog, Empty, ErrorLine, useChangeRunner } from '../parts';
import styles from '../Things.module.css';
import type { GuestTabProps } from './tabProps';

export function SnapshotsTab({ burrow, serverId, guest, timeZone }: GuestTabProps) {
  const { tag: uiLocale } = useWebI18n();
  const list = useHostManageRead({
    params: { burrow, serverId },
    query: {
      op: 'snapshot.list',
      guestId: guest.id,
      platform: guest.platform === 'incus' || guest.platform === 'libvirt' ? guest.platform : 'pve',
    },
  });
  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  const [taking, setTaking] = useState(false);
  const [ask, setAsk] = useState<{
    snap: HostSnapshot;
    action: 'snapshot_restore' | 'snapshot_delete';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = list.data?.op === 'snapshot.list' ? list.data.items.filter((s) => !s.current) : [];
  const now = Date.now();
  const act = async (action: 'snapshot_restore' | 'snapshot_delete', snap: HostSnapshot) => {
    setError(null);
    const out = await run(
      () =>
        change.mutateAsync({
          params: { burrow, serverId, guestId: guest.id },
          body: { action, snapshot: snap.name, confirm: true },
        }),
      action === 'snapshot_restore'
        ? `Taking ${guest.name} back to “${snap.name}”.`
        : `Removing “${snap.name}”.`,
      { inline: true },
    );
    if (out.ok) {
      setAsk(null);
      void list.refetch();
    } else if (out.error) setError(out.message);
    else setAsk(null);
  };
  return (
    <Card
      title="Snapshots"
      meta="A moment to go back to"
      link={
        <Button
          size="sm"
          style={{ marginLeft: 'auto' }}
          iconStart={<Icon icon={Plus} size={14} />}
          onClick={() => setTaking(true)}
        >
          Take a snapshot
        </Button>
      }
    >
      {list.error ? (
        <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Snapshot
              </th>
              <th scope="col" className={styles.dropXs}>
                Taken
              </th>
              <th scope="col" className={styles.dropM}>
                Note
              </th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.name}>
                <td className={styles.cellMain}>
                  <span className={styles.mono}>{s.name}</span>{' '}
                  {s.memory ? <span className={styles.kind}>with memory</span> : null}
                </td>
                <td className={cx(styles.num, styles.dropXs)}>
                  {s.created ? formatRelativeDay(Date.parse(s.created), now, timeZone, uiLocale) : DASH}
                </td>
                <td className={cx(styles.muted, styles.dropM)} style={{ whiteSpace: 'normal' }}>
                  {s.description || ''}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 12 }}>
                    {/* Going back would restart the guest this Whombat runs in (IU-02): left out for it. */}
                    {selfAllowsAction(guest, 'snapshot_restore') ? (
                      <button
                        type="button"
                        className={styles.cardLink}
                        onClick={() => setAsk({ snap: s, action: 'snapshot_restore' })}
                      >
                        Go back to it
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Remove ${s.name}`}
                      onClick={() => setAsk({ snap: s, action: 'snapshot_delete' })}
                    >
                      <Icon icon={Trash2} size={14} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{list.isLoading ? 'Looking…' : 'No snapshots yet.'}</Empty>
      )}
      {taking ? (
        <SnapshotDialog
          {...{ burrow, serverId, guest }}
          onClose={() => {
            setTaking(false);
            void list.refetch();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={ask !== null}
        title={
          ask?.action === 'snapshot_restore'
            ? `Take ${guest.name} back to “${ask?.snap.name}”?`
            : `Remove “${ask?.snap.name}”?`
        }
        body={
          ask?.action === 'snapshot_restore'
            ? `Everything that changed on ${guest.name} since then is lost.`
            : 'The snapshot goes; the guest stays as it is now.'
        }
        confirm={ask?.action === 'snapshot_restore' ? 'Go back' : 'Remove'}
        serious
        busy={busy}
        error={error}
        onClose={() => {
          setAsk(null);
          setError(null);
        }}
        onConfirm={() => ask && void act(ask.action, ask.snap)}
      />
    </Card>
  );
}

function SnapshotDialog({ burrow, serverId, guest, onClose }: GuestTabProps & { onClose: () => void }) {
  const [name, setName] = useState(`before-${new Date().toISOString().slice(0, 10)}`);
  const [description, setDescription] = useState('');
  const [memory, setMemory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  const bad = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)
    ? null
    : 'Starts with a letter; letters, digits, “-” and “_”.';
  return (
    <FormDialog
      title={`Take a snapshot of ${guest.name}`}
      description="You can go back to it later. It takes a few seconds."
      action={busy ? 'Taking…' : 'Take it'}
      busy={busy}
      disabled={!!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          const out = await run(
            () =>
              change.mutateAsync({
                params: { burrow, serverId, guestId: guest.id },
                body: {
                  action: 'snapshot_create',
                  snapshot: name,
                  ...(description ? { description } : {}),
                  ...(memory ? { memory: true } : {}),
                },
              }),
            `Taking a snapshot of ${guest.name}.`,
            { inline: true },
          );
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <TextField
        label="Name"
        mono
        value={name}
        autoFocus
        error={bad}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField label="Note" value={description} onChange={(e) => setDescription(e.target.value)} />
      {guest.kind === 'vm' && guest.state === 'running' ? (
        <Check
          label="Include what’s in memory (it resumes exactly where it was)"
          checked={memory}
          onChange={setMemory}
        />
      ) : null}
    </FormDialog>
  );
}
