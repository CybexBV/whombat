// Contents of a Proxmox storage (docs/MANAGE.md, Storage tab): ISO images,
// container templates and import files per content type, with Delete
// (admins), "Download from URL" (admins, when the host allows downloads)
// and "Get templates" (Proxmox's appliance list) for template storages.
// One dialog with three views; downloads run as tasks.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { type ChoiceStorage, type DownloadInput, manageApi, manageKeys, type StorageVolume, useAppliances, useStorageContent } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { SegmentedControl } from '../../components/controls';
import { InlineError, SelectField, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatFull, formatGb } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { checksumError, CHECKSUM_ALGORITHMS, EXT_HINT, filenameError, filenameFromUrl, urlError } from './download';
import { started } from './LifecycleDialogs';
import { fieldErrors, manageErrorText } from './manageErrors';

type Content = StorageVolume['content'];
const CONTENTS: Content[] = ['iso', 'vztmpl', 'import'];
const CONTENT_LABEL: Record<Content, () => string> = {
  iso: () => t('ISO images'),
  vztmpl: () => t('Container templates'),
  import: () => t('Import'),
};

/** Storages whose contents Rackoon lists (ISO images, container templates, import files). */
export function hasContents(s: Pick<ChoiceStorage, 'content'>): boolean {
  return s.content.some((c) => (CONTENTS as string[]).includes(c));
}

interface Props {
  serverId: string;
  storage: ChoiceStorage;
  isAdmin: boolean;
  /** choices.download: downloads from a URL work on this host. */
  download: boolean;
  initial?: 'list' | 'download' | 'appliances';
  onClose: () => void;
}

export function StorageContentDialog({ serverId, storage, isAdmin, download, initial = 'list', onClose }: Props) {
  const kinds = CONTENTS.filter((c) => storage.content.includes(c));
  const [content, setContent] = useState<Content>(initial === 'appliances' && kinds.includes('vztmpl') ? 'vztmpl' : (kinds[0] ?? 'iso'));
  const [view, setView] = useState(initial);
  const back = initial === 'list' ? () => setView('list') : onClose;
  const title = tx('Contents of {name}', { name: <span className="mono">{storage.id}</span> });
  if (view === 'download') return <DownloadView serverId={serverId} storage={storage} content={content} title={title} onBack={back} onClose={onClose} />;
  if (view === 'appliances') return <ApplianceView serverId={serverId} storage={storage} isAdmin={isAdmin} title={title} onBack={back} onClose={onClose} />;
  return <ListView serverId={serverId} storage={storage} isAdmin={isAdmin} download={download} kinds={kinds} content={content} onContent={setContent} title={title} onView={setView} onClose={onClose} />;
}

function ListView(p: {
  serverId: string;
  storage: ChoiceStorage;
  isAdmin: boolean;
  download: boolean;
  kinds: Content[];
  content: Content;
  onContent: (c: Content) => void;
  title: ReactNode;
  onView: (v: 'download' | 'appliances') => void;
  onClose: () => void;
}) {
  const { serverId, storage, content } = p;
  const qc = useQueryClient();
  const now = useNow(60_000);
  const list = useStorageContent(serverId, 'pve', storage.id, content);
  const [confirm, setConfirm] = useState<StorageVolume | null>(null);
  const del = useMutation({
    mutationFn: (v: StorageVolume) => manageApi.deleteContent(serverId, 'pve', v.volume),
    onSuccess: (r, v) => {
      started(serverId, 'pve', r, t('Delete {name}', { name: v.name }), t('{name} deleted.', { name: v.name }));
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: manageKeys.content(serverId, storage.id, content) });
      void qc.invalidateQueries({ queryKey: manageKeys.choices(serverId, 'pve') });
    },
  });
  const items = [...(list.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  if (confirm) {
    return (
      <Modal
        open
        onClose={() => setConfirm(null)}
        busy={del.isPending}
        tone="serious"
        title={t('Delete {name}?', { name: confirm.name })}
        description={t('The file is removed from {storage}. Guests that still use it lose it.', { storage: storage.id })}
        actions={
          <>
            <button type="button" className="btn-ghost" autoFocus onClick={() => setConfirm(null)}>
              {t('Cancel')}
            </button>
            <button type="button" className="btn-primary btn-sm is-serious" disabled={del.isPending} onClick={() => del.mutate(confirm)}>
              {t('Delete')}
            </button>
          </>
        }
      >
        {del.isError && <InlineError>{manageErrorText(del.error)}</InlineError>}
      </Modal>
    );
  }

  return (
    <Modal
      open
      wide
      onClose={p.onClose}
      title={p.title}
      actions={
        <>
          {p.isAdmin && p.download && (
            <button type="button" className="btn-ghost" onClick={() => p.onView('download')}>
              <Icon name="download" size={15} />
              {t('Download from URL')}
            </button>
          )}
          {p.isAdmin && content === 'vztmpl' && (
            <button type="button" className="btn-ghost" onClick={() => p.onView('appliances')}>
              <Icon name="box" size={15} />
              {t('Get templates')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn-ghost" onClick={p.onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      {p.kinds.length > 1 && <SegmentedControl label={t('Content')} value={content} onChange={p.onContent} options={p.kinds.map((k) => ({ value: k, label: CONTENT_LABEL[k]() }))} />}
      {list.isError ? (
        <InlineRetry title={t('Could not list the contents')} error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton height={96} />
      ) : items.length === 0 ? (
        <p className="lbl">{t('No {what} on {storage}.', { what: CONTENT_LABEL[content]().toLowerCase(), storage: storage.id })}</p>
      ) : (
        <ul className="plain-list" aria-label={CONTENT_LABEL[content]()}>
          {items.map((v) => (
            <li key={v.volume} className="ch-row">
              <div className="ch-main">
                <div className="ch-line1">
                  <span className="mono ch-target">{v.name}</span>
                </div>
                <div className="lbl">
                  {v.size_bytes != null ? formatGb(v.size_bytes / 1e9) : DASH}
                  {v.created && (
                    <>
                      {' · '}
                      <time dateTime={v.created} title={formatFull(Date.parse(v.created))}>
                        {formatAgoIso(v.created, now)}
                      </time>
                    </>
                  )}
                </div>
              </div>
              {p.isAdmin && (
                <button type="button" className="btn-ghost btn-icon row-action is-serious" aria-label={t('Delete {name}', { name: v.name })} title={t('Delete')} onClick={() => setConfirm(v)}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function DownloadView({ serverId, storage, content, title, onBack, onClose }: { serverId: string; storage: ChoiceStorage; content: Content; title: ReactNode; onBack: () => void; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  // The name follows the URL until the user edits it.
  const [named, setNamed] = useState(false);
  const [algorithm, setAlgorithm] = useState<DownloadInput['checksum_algorithm'] | ''>('');
  const [checksum, setChecksum] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const name = named ? filename : filenameFromUrl(url);

  const save = useMutation({
    mutationFn: () =>
      manageApi.download(serverId, storage.id, { platform: 'pve', content, url: url.trim(), filename: name.trim(), ...(algorithm && checksum.trim() ? { checksum: checksum.trim(), checksum_algorithm: algorithm } : {}) }),
    onSuccess: (r) => {
      started(serverId, 'pve', r, t('Download {name}', { name: name.trim() }), t('{name} downloaded.', { name: name.trim() }));
      onBack();
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = { url: urlError(url), filename: filenameError(name, content), checksum: checksumError(checksum, algorithm ?? '') };
    setErrors(errs);
    if (!Object.values(errs).some(Boolean)) save.mutate();
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      busy={save.isPending}
      title={title}
      description={t('Proxmox downloads the file to {storage} itself; it does not pass through the browser.', { storage: storage.id })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onBack}>
            {t('Back')}
          </button>
          <button type="submit" form="download-form" className="btn-primary btn-sm" disabled={save.isPending}>
            {t('Download')}
          </button>
        </>
      }
    >
      <form id="download-form" className="form-stack" onSubmit={submit} noValidate>
        <TextField label={t('URL')} mono type="url" value={url} autoFocus autoComplete="off" spellCheck={false} placeholder="https://cdimage.debian.org/…/debian-13.1.0-amd64-netinst.iso" error={errors.url} onChange={(e) => setUrl(e.target.value)} />
        <TextField
          label={t('File name')}
          mono
          value={name}
          autoComplete="off"
          spellCheck={false}
          hint={t('Ends in {ext}', { ext: EXT_HINT[content] })}
          error={errors.filename}
          onChange={(e) => {
            setNamed(true);
            setFilename(e.target.value);
          }}
        />
        <div className="form-grid">
          <SelectField label={t('Checksum')} value={algorithm} onChange={(e) => setAlgorithm(e.target.value as DownloadInput['checksum_algorithm'] | '')}>
            <option value="">{t('Do not verify')}</option>
            {CHECKSUM_ALGORITHMS.map((a) => (
              <option key={a} value={a}>
                {a.toUpperCase()}
              </option>
            ))}
          </SelectField>
          {algorithm && <TextField label={t('Expected checksum')} mono value={checksum} autoComplete="off" spellCheck={false} error={errors.checksum} onChange={(e) => setChecksum(e.target.value)} />}
        </div>
        {save.isError && <InlineError>{manageErrorText(save.error, ['url', 'filename', 'checksum'])}</InlineError>}
      </form>
    </Modal>
  );
}

function ApplianceView({ serverId, storage, isAdmin, title, onBack, onClose }: { serverId: string; storage: ChoiceStorage; isAdmin: boolean; title: ReactNode; onBack: () => void; onClose: () => void }) {
  const list = useAppliances(serverId, 'pve');
  const have = useStorageContent(serverId, 'pve', storage.id, 'vztmpl');
  const [q, setQ] = useState('');
  const [section, setSection] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const sections = useMemo(() => [...new Set((list.data ?? []).map((a) => a.section ?? '').filter(Boolean))], [list.data]);
  const present = new Set((have.data ?? []).map((v) => v.name));
  const needle = q.trim().toLowerCase();
  const shown = (list.data ?? []).filter((a) => (!section || a.section === section) && (!needle || `${a.headline ?? ''} ${a.template} ${a.description ?? ''}`.toLowerCase().includes(needle)));
  const get = useMutation({
    mutationFn: (template: string) => manageApi.downloadAppliance(serverId, 'pve', storage.id, template),
    onMutate: (template) => setBusy(template),
    onSuccess: (r, template) => started(serverId, 'pve', r, t('Download {name}', { name: template }), t('{name} downloaded.', { name: template })),
    onSettled: () => setBusy(null),
  });

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={title}
      description={t('Container templates from Proxmox, downloaded to {storage}.', { storage: storage.id })}
      actions={
        <button type="button" className="btn-ghost" onClick={onBack}>
          {t('Back')}
        </button>
      }
    >
      <div className="lc-toolbar">
        <div className="input-search">
          <Icon name="search" size={15} />
          <input type="search" aria-label={t('Search templates')} placeholder={t('Search templates')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {sections.length > 1 && (
          <SegmentedControl
            label={t('Section')}
            value={section}
            onChange={setSection}
            options={[{ value: '', label: t('All') }, ...sections.map((s) => ({ value: s, label: s === 'turnkeylinux' ? 'TurnKey' : s === 'system' ? t('System') : s === 'mail' ? t('Mail') : s }))]}
          />
        )}
      </div>
      {get.isError && <InlineError>{manageErrorText(get.error)}</InlineError>}
      {list.isError ? (
        <InlineRetry title={t('Could not load the template list')} error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton height={160} />
      ) : shown.length === 0 ? (
        <p className="lbl" role="status">
          {t('No templates match.')}
        </p>
      ) : (
        <ul className="plain-list lc-appliances" aria-label={t('Templates')}>
          {shown.map((a) => (
            <li key={a.template} className="ch-row">
              <div className="ch-main">
                <div className="ch-line1">
                  <span className="strong">{a.headline ?? a.package ?? a.template}</span>
                  {a.version && <span className="lbl">{a.version}</span>}
                </div>
                <div className="lbl ch-target">
                  {a.description ? `${a.description} · ` : ''}
                  <span className="mono">{a.template}</span>
                </div>
              </div>
              {present.has(a.template) ? (
                <span className="lbl nowrap">{t('On the storage')}</span>
              ) : (
                isAdmin && (
                  <button type="button" className="btn-ghost row-action" disabled={busy !== null} onClick={() => get.mutate(a.template)}>
                    {busy === a.template ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="download" size={14} />}
                    {t('Download')}
                    <span className="sr-only"> {a.headline ?? a.template}</span>
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
