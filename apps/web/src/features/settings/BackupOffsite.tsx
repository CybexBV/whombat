/**
 * Settings → This Whombat → Backups, A COPY SOMEWHERE ELSE (Whombat docs/decisions/offsite-copy.md): a second copy of
 * the backups in a bucket the person owns, away from home. Without one: one line that says why, and *Keep a copy
 * somewhere else*. With one: where it is, when it last copied, how many backups it holds, what went wrong and when
 * Whombat tries again, *Copy now*, *Change* and *Stop keeping a copy*. The form names the storage, its address, the
 * bucket and the key; Whombat checks the bucket before it keeps anything and says which step failed. The words and
 * views are `@whombat/client`'s (`offsiteView`, `offsiteInput`), so the phone says the same. A box from before doesn't
 * name a copy in its summary, and nothing is shown.
 */

import {
  OFFSITE_PRESETS,
  type OffsiteForm,
  offsiteErrorText,
  offsiteFormFrom,
  offsiteInput,
  offsitePlace,
  offsiteText,
  offsiteView,
} from '@whombat/client/managed';
import { useBackupOffsiteActions, useBackupPlaces, useBackupServiceStatus } from '@whombat/client/react';
import { interpolate } from '@whombat/core/i18n';
import type { BackupOffsite, BackupOffsiteProvider } from '@whombat/protocol/session';
import { type FormEvent, useId, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { liveText } from '../../i18n/clientWords';
import { currentLocale } from '../../i18n/provider';
import { ProviderLogo } from '../connectors/ConnectionsOverview';
import bd from './BackupDestination.module.css';
import os from './BackupOffsite.module.css';
import bp from './BackupPlaces.module.css';
import styles from './SettingsScreen.module.css';
import tw from './ThisWhombat.module.css';

const W = liveText(offsiteText);

/** The storage's mark: Cloudflare's and Hetzner's own, the first letter for the others. */
const MARKS: Readonly<Record<BackupOffsiteProvider, string>> = {
  b2: 'backblaze',
  r2: 'cloudflare',
  hetzner: 'hetzner',
  aws: 'aws',
  s3: 's3',
};

export function BackupOffsiteSection() {
  const { session } = useAppServices();
  const status = useBackupServiceStatus(session);
  const places = useBackupPlaces(session);
  // The NAS or server on the network that keeps the backups, by its name; a bucket or a disk isn't named here.
  const placeName = places.data?.places.find((p) => p.id === places.data?.currentPlaceId)?.name ?? null;
  const actions = useBackupOffsiteActions(session);
  const [editing, setEditing] = useState<'new' | 'change' | null>(null);
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const offsite = status.data?.summary.offsite;
  // A box from before (or one whose backup service isn't answering now) doesn't say: nothing to show or offer.
  if (offsite === undefined) return null;

  const copyNow = async () => {
    setNote(null);
    try {
      await actions.copyNow.mutateAsync();
      setNote({ text: W.queued, error: false });
    } catch (error) {
      setNote({ text: offsiteErrorText(error, currentLocale()), error: true });
    }
  };

  const remove = async () => {
    setRemoving(false);
    setNote(null);
    try {
      await actions.remove.mutateAsync();
    } catch (error) {
      setNote({ text: offsiteErrorText(error, currentLocale()), error: true });
    }
  };

  return (
    <section className={styles.section} aria-label={W.title} data-backup-offsite="">
      <SectionLabel as="h2">{W.title}</SectionLabel>
      <div className={styles.card}>
        {offsite ? (
          <OffsiteRows
            offsite={offsite}
            note={note}
            copying={actions.copyNow.isPending}
            onCopy={() => void copyNow()}
            onChange={() => setEditing('change')}
            onRemove={() => setRemoving(true)}
          />
        ) : (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.rowMeta}>
                {placeName ? interpolate(W.lead, { place: placeName }) : W.leadNoPlace}
              </span>
              {note ? (
                <span
                  className={note.error ? bp.error : styles.rowMeta}
                  role={note.error ? 'alert' : 'status'}
                >
                  {note.text}
                </span>
              ) : null}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
              {W.setUp}
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <OffsiteDialog
          offsite={editing === 'change' ? (offsite ?? null) : null}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await actions.set.mutateAsync(input);
            setEditing(null);
            setNote(null);
          }}
        />
      ) : null}

      <Modal open={removing} onOpenChange={(open) => !open && setRemoving(false)} width="md">
        {removing && offsite ? (
          <div className={tw.dialog}>
            <div className={tw.dialogHead}>
              <ModalTitle className={tw.dialogTitle}>
                {interpolate(W.removeTitle, { place: offsitePlace(offsite) })}
              </ModalTitle>
              <ModalDescription className={tw.dialogLead}>
                {interpolate(W.removeLead, { place: offsitePlace(offsite) })}
              </ModalDescription>
            </div>
            <div className={tw.dialogActions}>
              <ModalClose asChild>
                <Button variant="secondary" size="lg">
                  {W.form.cancel}
                </Button>
              </ModalClose>
              <Button variant="primary" size="lg" onClick={() => void remove()}>
                {W.removeConfirm}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}

function OffsiteRows({
  offsite,
  note,
  copying,
  onCopy,
  onChange,
  onRemove,
}: {
  offsite: BackupOffsite;
  note: { text: string; error: boolean } | null;
  copying: boolean;
  onCopy: () => void;
  onChange: () => void;
  onRemove: () => void;
}) {
  const view = offsiteView(offsite, currentLocale());
  return (
    <>
      <div className={styles.row} data-backup-offsite-state={offsite.state}>
        <ProviderLogo provider={MARKS[offsite.provider]} size={32} />
        <div className={styles.rowMain}>
          <span className={`${styles.rowTitle} ${os.line}`}>
            <StatusDot tone={view.line.dot} />
            {view.line.text}
          </span>
          {view.problem ? (
            <span className={bp.error} role="alert">
              {view.problem}
            </span>
          ) : null}
          {note ? (
            <span className={note.error ? bp.error : styles.rowMeta} role={note.error ? 'alert' : 'status'}>
              {note.text}
            </span>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" disabled={copying || !view.canCopy} onClick={onCopy}>
          {copying || !view.canCopy ? W.copyingNow : W.copyNow}
        </Button>
      </div>
      {view.rows.map((row) => (
        <div key={row.label} className={os.detail}>
          <span>{row.label}</span>
          <span className={os.value}>{row.value}</span>
        </div>
      ))}
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <span className={styles.rowMeta}>{W.sameRule}</span>
        </div>
        <div className={os.actions}>
          <Button variant="secondary" size="sm" onClick={onChange}>
            {W.change}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            {W.remove}
          </Button>
        </div>
      </div>
    </>
  );
}

/** Set up or change the copy: the storage, its address, the bucket and the key; checked before it is kept. */
function OffsiteDialog({
  offsite,
  onClose,
  onSave,
}: {
  offsite: BackupOffsite | null;
  onClose: () => void;
  onSave: (input: NonNullable<ReturnType<typeof offsiteInput>>) => Promise<void>;
}) {
  const [form, setForm] = useState<OffsiteForm>(() => offsiteFormFrom(offsite));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const preset = OFFSITE_PRESETS.find((p) => p.provider === form.provider) ?? OFFSITE_PRESETS[0];

  const set = (patch: Partial<OffsiteForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const input = offsiteInput(form);
    if (!input) {
      setError(W.form.missing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
    } catch (err) {
      setError(offsiteErrorText(err, currentLocale()));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: Exclude<keyof OffsiteForm, 'provider'>,
    label: string,
    options: {
      type?: string;
      placeholder?: string;
      hint?: string;
      mono?: boolean;
      autoComplete?: string;
    } = {},
  ) => (
    <div className={bd.field}>
      <label className={bd.label} htmlFor={`${id}-${name}`}>
        {label}
      </label>
      <Input
        id={`${id}-${name}`}
        size="md"
        type={options.type ?? 'text'}
        autoComplete={options.autoComplete ?? 'off'}
        spellCheck={false}
        placeholder={options.placeholder}
        className={options.mono ? bd.mono : undefined}
        aria-describedby={options.hint ? `${id}-${name}-hint` : undefined}
        value={form[name]}
        onChange={(e) => set({ [name]: e.target.value })}
      />
      {options.hint ? (
        <span id={`${id}-${name}-hint`} className={bd.hint}>
          {options.hint}
        </span>
      ) : null}
    </div>
  );

  return (
    <Modal open onOpenChange={(open) => !open && !busy && onClose()} width="lg">
      <form className={tw.dialog} onSubmit={(e) => void save(e)} noValidate data-backup-offsite-form="">
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{offsite ? W.form.changeTitle : W.form.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{W.form.lead}</ModalDescription>
        </div>
        <div className={bd.form}>
          <fieldset className={bd.kinds} aria-labelledby={`${id}-provider`}>
            <legend id={`${id}-provider`} className={bd.label}>
              {W.form.provider}
            </legend>
            {OFFSITE_PRESETS.map((p) => (
              <label key={p.provider} className={bd.kind} data-selected={p.provider === form.provider}>
                <input
                  type="radio"
                  name={`${id}-provider`}
                  value={p.provider}
                  className={bd.kindRadio}
                  checked={p.provider === form.provider}
                  onChange={() => set({ provider: p.provider })}
                />
                <span className={bd.kindTitle}>{W.form.providers[p.provider]}</span>
              </label>
            ))}
          </fieldset>
          {field('endpoint', W.form.endpoint, {
            placeholder: preset?.endpoint,
            hint: W.form.endpointHint[form.provider],
            mono: true,
          })}
          <div className={bd.pair}>
            {field('bucket', W.form.bucket, { mono: true })}
            {field('folder', W.form.folder, { mono: true, hint: W.form.folderHint })}
          </div>
          <div className={bd.pair}>
            {field('accessKeyId', W.form.keyId, { mono: true })}
            {field('secretAccessKey', W.form.secret, { type: 'password', autoComplete: 'new-password' })}
          </div>
          <p className={bd.hint}>{W.form.secretHint}</p>
          {preset?.region !== null || form.region
            ? field('region', W.form.region, {
                placeholder: preset?.region ?? '',
                hint: W.form.regionHint,
                mono: true,
              })
            : null}
          {error ? (
            <p className={bd.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className={tw.dialogActions}>
          <Button variant="secondary" size="lg" type="button" disabled={busy} onClick={onClose}>
            {W.form.cancel}
          </Button>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {busy ? W.form.saving : W.form.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
