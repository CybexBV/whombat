// Muting a host = a maintenance window for it: its alerts stay visible but
// do not ask for attention or notify. The host header shows the chip
// "Muted until 18:00" with Unmute; operators open the menu to mute.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { MaintenanceInfo } from '../../api/types';
import { SegmentedControl } from '../../components/controls';
import { errorText, TextField } from '../../components/forms';
import type { MenuItem } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatClock } from '../../lib/format';
import { t } from '../../lib/i18n';

function untilTomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return Math.round((d.getTime() - now) / 60000);
}

export function useMute(serverId: string) {
  const qc = useQueryClient();
  const settle = () => {
    for (const k of [['server', serverId], ['fleet'], ['alerts'], ['maintenance'], ['servers']]) void qc.invalidateQueries({ queryKey: k });
  };
  const mute = useMutation({
    mutationFn: ({ minutes, note }: { minutes: number; note: string }) => api.createMaintenance({ scope: 'server', target: serverId, duration_min: minutes, note }),
    onSuccess: settle,
    onError: (err) => toast(t('Could not mute {id}: {error}', { id: serverId, error: errorText(err) }), 'error'),
  });
  const unmute = useMutation({
    mutationFn: (id: string) => api.deleteMaintenance(id),
    onSuccess: settle,
    onError: (err) => toast(t('Could not unmute {id}: {error}', { id: serverId, error: errorText(err) }), 'error'),
  });
  return { mute, unmute };
}

/** Menu items of the host header for muting. */
export function muteItems(m: ReturnType<typeof useMute>, now: number, openDialog: () => void): MenuItem[] {
  return [
    { heading: true, label: t('Mute alerts') },
    { label: t('For 1 hour'), icon: 'clock', onSelect: () => m.mute.mutate({ minutes: 60, note: '' }) },
    { label: t('For 4 hours'), icon: 'clock', onSelect: () => m.mute.mutate({ minutes: 240, note: '' }) },
    { label: t('Until tomorrow 08:00'), icon: 'clock', onSelect: () => m.mute.mutate({ minutes: untilTomorrowMorning(now), note: '' }) },
    { label: t('With a note…'), icon: 'edit', onSelect: openDialog },
  ];
}

const MUTE_FOR = [
  { value: '60', label: t('1 hour') },
  { value: '240', label: t('4 hours') },
  { value: '1440', label: t('1 day') },
  { value: '10080', label: t('1 week') },
] as const;

export function MuteDialog({ serverId, open, onClose, m }: { serverId: string; open: boolean; onClose: () => void; m: ReturnType<typeof useMute> }) {
  const [minutes, setMinutes] = useState('240');
  const [note, setNote] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={m.mute.isPending}
      title={t('Mute {id}', { id: serverId })}
      description={t('Its alerts stay visible but send no notifications and do not count as needing attention.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary" disabled={m.mute.isPending} onClick={() => m.mute.mutate({ minutes: Number(minutes), note }, { onSuccess: onClose })}>
            {t('Mute')}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <SegmentedControl label={t('For')} options={MUTE_FOR.map((o) => ({ value: o.value, label: o.label }))} value={minutes} onChange={setMinutes} />
        <TextField label={t('Note')} placeholder={t('Replacing the PSU')} value={note} maxLength={256} autoFocus onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

/** "Muted until 18:00 · Unmute" in the host header. */
export function MutedChip({ maint, canUnmute, m }: { maint: MaintenanceInfo; canUnmute: boolean; m: ReturnType<typeof useMute> }) {
  const now = useNow();
  return (
    <span className="chip chip-muted" title={maint.note || t('Alerts of this host are muted')}>
      {t('Muted until {time}', { time: formatClock(Date.parse(maint.until), now) })}
      {canUnmute && (
        <button type="button" className="chip-action" onClick={() => m.unmute.mutate(maint.id)} disabled={m.unmute.isPending}>
          {t('Unmute')}
        </button>
      )}
    </span>
  );
}
