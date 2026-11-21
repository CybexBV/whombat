/**
 * A guest's Snapshots on the phone (proxmox-mobile.md AP-1495): the moments to go back to, newest first, and Take a
 * snapshot (with memory for a running VM). A snapshot opens its sheet: Go back to it, or Remove it — both asked
 * first, then sent with `confirm`; each says when it started and when it ended.
 */
import { snapshotRows } from '@whombat/client/hosts/mobile';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostGuestDetail } from '@whombat/core';
import { useState } from 'react';
import { BigButton, OneCard, OneRow } from '../../ui/assistant';
import { OneSheet } from '../../ui/oneSheet';
import { ErrorState, SkeletonRows } from '../../ui/primitives';
import { CardQuiet, RowAction, SettingLine } from './parts';
import { useGuestAction } from './useServerChange';

type Ask = { name: string; step: 'choose' | 'snapshot_restore' | 'snapshot_delete' };

export function GuestSnapshots({
  slug,
  serverId,
  guest,
  now,
  timeZone,
  canChange,
  canRestore = true,
  schedule,
  onTake,
}: {
  slug: string;
  serverId: string;
  guest: HostGuestDetail;
  now: number;
  timeZone: string;
  canChange: boolean;
  /** Going back to a snapshot (never on this Whombat itself, IU-02). */
  canRestore?: boolean;
  /** Incus: the schedule in words, and Change when it may be changed (incus-unraid-mobile.md AP-1626). */
  schedule?: { text: string; onChange: (() => void) | null };
  onTake: () => void;
}) {
  const q = useHostManageRead(
    {
      params: { burrow: slug, serverId },
      query: {
        op: 'snapshot.list',
        guestId: guest.id,
        platform: guest.platform === 'incus' ? 'incus' : guest.platform === 'libvirt' ? 'libvirt' : 'pve',
      },
    },
    { retry: false },
  );
  const [ask, setAsk] = useState<Ask | null>(null);
  const rows = q.data?.op === 'snapshot.list' ? snapshotRows(q.data.items, now, timeZone) : [];
  return (
    <>
      {schedule ? (
        <OneCard>
          <SettingLine
            first
            label="Schedule"
            value={schedule.text}
            action={
              schedule.onChange ? (
                <RowAction label="Change" spoken="Change the snapshot schedule" onPress={schedule.onChange} />
              ) : null
            }
          />
        </OneCard>
      ) : null}
      {canChange ? <BigButton label="Take a snapshot" variant="secondary" onPress={onTake} /> : null}
      {q.isPending ? (
        <SkeletonRows count={3} lines={2} label="Loading the snapshots" />
      ) : q.isError ? (
        <ErrorState text="The snapshots didn’t load." onRetry={() => void q.refetch()} />
      ) : (
        <OneCard label="Snapshots">
          {rows.length ? (
            rows.map((r) => (
              <OneRow
                key={r.name}
                title={r.name}
                titleMono
                line={r.note || null}
                meta={r.line}
                chevron={canChange}
                label={r.label}
                {...(canChange
                  ? {
                      hint: canRestore ? 'Go back to it or remove it' : 'Remove it',
                      onPress: () => setAsk({ name: r.name, step: 'choose' }),
                    }
                  : {})}
              />
            ))
          ) : (
            <CardQuiet>No snapshots yet.</CardQuiet>
          )}
        </OneCard>
      )}
      {ask ? (
        <SnapshotAsk
          serverId={serverId}
          guest={guest}
          canRestore={canRestore}
          ask={ask}
          onAsk={setAsk}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </>
  );
}

function SnapshotAsk({
  serverId,
  guest,
  canRestore,
  ask,
  onAsk,
  onClose,
}: {
  serverId: string;
  guest: HostGuestDetail;
  canRestore: boolean;
  ask: Ask;
  onAsk: (a: Ask) => void;
  onClose: () => void;
}) {
  const { send, busy } = useGuestAction(serverId, guest);
  const [error, setError] = useState<string | null>(null);
  if (ask.step === 'choose')
    return (
      <OneSheet
        visible
        onClose={onClose}
        badge={guest.name}
        title={`“${ask.name}”`}
        buttons={[
          ...(canRestore
            ? [
                {
                  id: 'restore',
                  label: 'Go back to it',
                  variant: 'secondary' as const,
                  onPress: () => onAsk({ ...ask, step: 'snapshot_restore' }),
                },
              ]
            : []),
          {
            id: 'delete',
            label: 'Remove it',
            variant: 'secondary',
            onPress: () => onAsk({ ...ask, step: 'snapshot_delete' }),
          },
          { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
        ]}
      />
    );
  const restore = ask.step === 'snapshot_restore';
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={guest.name}
      tone="bad"
      title={restore ? `Take ${guest.name} back to “${ask.name}”?` : `Remove “${ask.name}”?`}
      body={
        restore
          ? `Everything that changed on ${guest.name} since then is lost.`
          : 'The snapshot goes; the guest stays as it is now.'
      }
      busy={busy}
      buttons={[
        {
          id: ask.step,
          label: restore ? 'Go back' : 'Remove',
          variant: 'primary',
          onPress: () =>
            void send({
              action: ask.step as 'snapshot_restore' | 'snapshot_delete',
              snapshot: ask.name,
              confirm: true,
            }).then((o) => {
              if (o.ok || o.waiting) onClose();
              else setError(o.message);
            }),
        },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={error}
    />
  );
}
