// Acknowledge / snooze an open alert (operators and admins). An
// acknowledged alert stays open but stops asking for attention: no badge,
// no banner, no reminders. A snooze lapses at its time.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { useAuthState } from '../../api/queries';
import type { Alert } from '../../api/types';
import { errorText, TextField } from '../../components/forms';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { SegmentedControl } from '../../components/controls';
import { t } from '../../lib/i18n';

export function useCanAct(): boolean {
  const role = useAuthState().data?.user?.role;
  return role === 'operator' || role === 'admin';
}

function useAck() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['alerts'] });
    void qc.invalidateQueries({ queryKey: ['fleet'] });
    void qc.invalidateQueries({ queryKey: ['server'] });
  };
  const ack = useMutation({
    mutationFn: ({ a, note, minutes }: { a: Alert; note: string; minutes: number }) => api.ackAlert(a.id, note, minutes),
    onSuccess: done,
    onError: (err) => toast(t('Could not acknowledge: {error}', { error: errorText(err) }), 'error'),
  });
  const unack = useMutation({
    mutationFn: (a: Alert) => api.unackAlert(a.id),
    onSuccess: done,
    onError: (err) => toast(t('Could not undo: {error}', { error: errorText(err) }), 'error'),
  });
  return { ack, unack };
}

const DURATIONS = [
  { value: '0', label: t('Until resolved') },
  { value: '60', label: t('1 hour') },
  { value: '240', label: t('4 hours') },
  { value: '1440', label: t('1 day') },
] as const;

/** The row control: a menu while it needs attention, "Undo" once acknowledged. */
export function AlertActions({ a }: { a: Alert }) {
  const can = useCanAct();
  const { ack, unack } = useAck();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [minutes, setMinutes] = useState<string>('0');
  if (!can || a.state === 'resolved') return null;
  if (a.acknowledged) {
    return (
      <button type="button" className="btn-ghost row-action" onClick={() => unack.mutate(a)} disabled={unack.isPending}>
        {t('Undo')}
      </button>
    );
  }
  return (
    <>
      <Menu
        label={t('Acknowledge {title}', { title: a.title })}
        buttonClassName="btn-ghost row-action"
        items={[
          { label: t('Acknowledge'), icon: 'check', onSelect: () => ack.mutate({ a, note: '', minutes: 0 }) },
          { label: t('Snooze 1 hour'), icon: 'clock', onSelect: () => ack.mutate({ a, note: '', minutes: 60 }) },
          { label: t('Snooze 1 day'), icon: 'clock', onSelect: () => ack.mutate({ a, note: '', minutes: 1440 }) },
          { label: t('With a note…'), icon: 'edit', onSelect: () => setNoteOpen(true) },
        ]}
      >
        {t('Acknowledge')}
      </Menu>
      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        busy={ack.isPending}
        title={t('Acknowledge')}
        description={a.title}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setNoteOpen(false)}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={ack.isPending}
              onClick={() => ack.mutate({ a, note, minutes: Number(minutes) }, { onSuccess: () => setNoteOpen(false) })}
            >
              {t('Acknowledge')}
            </button>
          </>
        }
      >
        <div className="form-stack">
          <TextField label={t('Note')} placeholder={t('Replacing the disk on Friday')} value={note} maxLength={256} autoFocus onChange={(e) => setNote(e.target.value)} />
          <SegmentedControl label={t('For')} options={DURATIONS.map((d) => ({ value: d.value, label: d.label }))} value={minutes} onChange={setMinutes} />
        </div>
      </Modal>
    </>
  );
}
