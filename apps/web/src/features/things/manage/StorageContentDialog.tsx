/**
 * A Proxmox storage's files (ported from Rackoon's `StorageContentDialog` and `download.ts`; Whombat proxmox.md PX-01):
 * its ISO images, container templates and imports with Delete (asked first), Download from a link (Proxmox fetches
 * the file itself, checked against a checksum when one is given; only where the server allows it, else it says why)
 * and Get templates (Proxmox's own catalogue). One dialog, three views; downloads run as tasks on the server.
 */
import {
  APPLIANCE_SECTIONS,
  appliances,
  CHECKSUM_ALGORITHMS,
  type ChecksumAlgorithm,
  CONTENT_EXT_HINT,
  CONTENT_WORDS,
  checksumError,
  contentItems,
  DASH,
  downloadNameError,
  downloadParams,
  downloadUrlError,
  filenameFromUrl,
  filterAppliances,
  formatAgoIso,
  formatBytesBinary,
  type StorageContent,
  storageContents,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import { Download, Package, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import wc from '../HostFleet.module.css';
import { ConfirmDialog, Empty, ErrorLine, Skeleton } from '../parts';
import styles from '../Things.module.css';
import { FormDialog, SelectField, TextField } from './fields';
import { useManage } from './useManage';

type View = 'list' | 'download' | 'appliances';

/** Why Download from a link isn't offered (choices.download is false). */
export const NO_DOWNLOAD =
  'Downloading from a link needs Proxmox VE 8.3 or later on this server. Until then, add files in Proxmox itself.';

export function StorageContentDialog({
  burrow,
  serverId,
  storage,
  download,
  initial = 'list',
  onClose,
}: {
  burrow: string;
  serverId: string;
  storage: { id: string; content: string | readonly string[] };
  /** The server lets Proxmox download from a link (`choices.download`). */
  download: boolean;
  initial?: View;
  onClose: () => void;
}) {
  const kinds = storageContents(storage.content);
  const [content, setContent] = useState<StorageContent>(
    initial === 'appliances' && kinds.includes('vztmpl') ? 'vztmpl' : (kinds[0] ?? 'iso'),
  );
  const [view, setView] = useState<View>(initial);
  const back = initial === 'list' ? () => setView('list') : onClose;
  if (view === 'download')
    return (
      <DownloadView
        burrow={burrow}
        serverId={serverId}
        storage={storage.id}
        content={content}
        onBack={back}
        onClose={onClose}
      />
    );
  if (view === 'appliances')
    return (
      <ApplianceView
        burrow={burrow}
        serverId={serverId}
        storage={storage.id}
        onBack={back}
        onClose={onClose}
      />
    );
  return (
    <ListView
      burrow={burrow}
      serverId={serverId}
      storage={storage.id}
      kinds={kinds}
      content={content}
      download={download}
      onContent={setContent}
      onView={setView}
      onClose={onClose}
    />
  );
}

function ListView({
  burrow,
  serverId,
  storage,
  kinds,
  content,
  download,
  onContent,
  onView,
  onClose,
}: {
  burrow: string;
  serverId: string;
  storage: string;
  kinds: StorageContent[];
  content: StorageContent;
  download: boolean;
  onContent: (c: StorageContent) => void;
  onView: (v: View) => void;
  onClose: () => void;
}) {
  const [remove, setRemove] = useState<{ volume: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'content.list', storage, content, platform: 'pve' },
  });
  const { send, busy } = useManage(burrow, serverId);
  const items = contentItems(list.data, content);
  const now = Date.now();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
      <ModalTitle className={styles.dialogTitle}>
        Files on <span className={styles.mono}>{storage}</span>
      </ModalTitle>
      {kinds.length > 1 ? (
        <SegmentedControl
          options={kinds.map((k) => ({ value: k, label: CONTENT_WORDS[k] }))}
          value={content}
          onChange={onContent}
          label="Show"
          variant="soft"
        />
      ) : null}
      {list.error ? (
        <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton height={96} />
      ) : items.length ? (
        <ul className={`${wc.wcFiles} ${wc.wcScrollList}`} aria-label={CONTENT_WORDS[content]}>
          {items.map((i) => (
            <li key={i.volume} className={wc.wcFile}>
              <div className={wc.wcFileMain}>
                <b className={wc.wcMono}>{i.name}</b>
                <small>
                  {i.sizeBytes != null ? formatBytesBinary(i.sizeBytes) : DASH}
                  {i.created ? ` · added ${formatAgoIso(i.created, now)}` : ''}
                </small>
              </div>
              <button
                type="button"
                className={styles.iconBtn}
                aria-label={`Delete ${i.name}`}
                title="Delete"
                onClick={() => setRemove(i)}
              >
                <Icon icon={Trash2} size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{`No ${CONTENT_WORDS[content].toLowerCase()} on ${storage} yet.`}</Empty>
      )}
      {!download ? <p className={wc.wcNote}>{NO_DOWNLOAD}</p> : null}
      <div className={styles.dialogActions}>
        <span className={styles.spacer} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {download ? (
            <Button iconStart={<Icon icon={Download} size={15} />} onClick={() => onView('download')}>
              Download from a link
            </Button>
          ) : null}
          {content === 'vztmpl' ? (
            <Button iconStart={<Icon icon={Package} size={15} />} onClick={() => onView('appliances')}>
              Get templates
            </Button>
          ) : null}
        </span>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
      <ConfirmDialog
        open={remove !== null}
        title={`Delete ${remove?.name ?? ''}?`}
        body={`It’s removed from ${storage}. Guests that still use it lose it.`}
        confirm="Delete"
        serious
        busy={busy}
        error={error}
        onClose={() => {
          setRemove(null);
          setError(null);
        }}
        onConfirm={() =>
          void (async () => {
            if (!remove) return;
            const out = await send({
              op: 'content.delete',
              params: { platform: 'pve', volume: remove.volume },
              confirm: true,
              name: remove.name,
            });
            if (out.ok) {
              setRemove(null);
              void list.refetch();
            } else setError(out.message);
          })()
        }
      />
    </Modal>
  );
}

function DownloadView({
  burrow,
  serverId,
  storage,
  content,
  onBack,
  onClose,
}: {
  burrow: string;
  serverId: string;
  storage: string;
  content: StorageContent;
  onBack: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  // The name follows the link until it is typed.
  const [named, setNamed] = useState(false);
  const [algorithm, setAlgorithm] = useState<ChecksumAlgorithm | ''>('');
  const [checksum, setChecksum] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const name = named ? filename : filenameFromUrl(url);
  const submit = async () => {
    const errs = {
      url: downloadUrlError(url),
      filename: downloadNameError(name, content),
      checksum: checksumError(checksum, algorithm),
    };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    setError(null);
    const out = await send({
      op: 'content.download',
      params: downloadParams({ storage, content, url, filename: name, algorithm, checksum }),
      name: name.trim(),
    });
    if (out.ok) onBack();
    else {
      setErrors({
        url: out.fields.url,
        filename: out.fields.filename,
        checksum: out.fields.checksum ?? out.fields.checksum_algorithm,
      });
      setError(out.message);
    }
  };
  return (
    <FormDialog
      title={`Download to ${storage}`}
      description={`Proxmox downloads the file to ${storage} itself; it doesn’t pass through your browser.`}
      action={busy ? 'Starting…' : 'Download'}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
      width="lg"
      extra={
        <Button className={styles.spacer} onClick={onBack} disabled={busy}>
          Back
        </Button>
      }
    >
      <TextField
        label="Link"
        mono
        type="url"
        value={url}
        autoFocus
        placeholder="https://cdimage.debian.org/…/debian-13.1.0-amd64-netinst.iso"
        error={errors.url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <TextField
        label="File name"
        mono
        value={name}
        error={errors.filename}
        hint={`Ends in ${CONTENT_EXT_HINT[content]}`}
        onChange={(e) => {
          setNamed(true);
          setFilename(e.target.value);
        }}
      />
      <div className={styles.formRow} style={{ gridTemplateColumns: algorithm ? '180px 1fr' : '180px' }}>
        <SelectField
          label="Checksum"
          value={algorithm}
          options={[
            { value: '', label: 'Don’t check' },
            ...CHECKSUM_ALGORITHMS.map((a) => ({ value: a, label: a.toUpperCase() })),
          ]}
          onChange={(e) => setAlgorithm(e.target.value as ChecksumAlgorithm | '')}
        />
        {algorithm ? (
          <TextField
            label="Expected checksum"
            mono
            value={checksum}
            error={errors.checksum}
            hint="From the page you got the link from."
            onChange={(e) => setChecksum(e.target.value)}
          />
        ) : null}
      </div>
    </FormDialog>
  );
}

function ApplianceView({
  burrow,
  serverId,
  storage,
  onBack,
  onClose,
}: {
  burrow: string;
  serverId: string;
  storage: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const list = useHostManageRead(
    { params: { burrow, serverId }, query: { op: 'appliance.list', platform: 'pve' } },
    { staleTime: 5 * 60_000 },
  );
  const have = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'content.list', storage, content: 'vztmpl', platform: 'pve' },
  });
  const [q, setQ] = useState('');
  const [section, setSection] = useState('');
  const [getting, setGetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { send } = useManage(burrow, serverId);
  const all = appliances(list.data);
  const sections = [...new Set(all.map((a) => a.section).filter(Boolean))];
  const present = new Set(contentItems(have.data, 'vztmpl').map((v) => v.name));
  const shown = filterAppliances(all, q, section);
  const get = async (template: string) => {
    setGetting(template);
    setError(null);
    const out = await send({
      op: 'appliance.download',
      params: { platform: 'pve', storage, template },
      name: template,
    });
    setGetting(null);
    if (out.ok) void have.refetch();
    else setError(out.message);
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
      <ModalTitle className={styles.dialogTitle}>Get templates</ModalTitle>
      <ModalDescription className={styles.dialogBody}>
        Container templates from Proxmox, downloaded to <span className={styles.mono}>{storage}</span>.
      </ModalDescription>
      <div className={styles.toolbar} style={{ padding: 0 }}>
        <input
          className={styles.search}
          type="search"
          placeholder="Find a template…"
          aria-label="Find a template"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {sections.length > 1 ? (
          <SegmentedControl
            options={[
              { value: '', label: 'All' },
              ...sections.map((s) => ({ value: s, label: APPLIANCE_SECTIONS[s] ?? s })),
            ]}
            value={section}
            onChange={setSection}
            label="Kind"
            variant="soft"
          />
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {list.error ? (
        <ErrorLine error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton height={160} />
      ) : shown.length ? (
        <ul className={`${wc.wcFiles} ${wc.wcScrollList}`} aria-label="Templates">
          {shown.map((a) => (
            <li key={a.template} className={wc.wcFile}>
              <div className={wc.wcFileMain}>
                <b>
                  {a.headline}
                  {a.version ? <span className={styles.kind}> {a.version}</span> : null}
                </b>
                <small>{a.description ? `${a.description} · ${a.template}` : a.template}</small>
              </div>
              {present.has(a.template) ? (
                <span className={wc.wcFileEnd}>On {storage}</span>
              ) : (
                <Button
                  size="sm"
                  iconStart={<Icon icon={Download} size={14} />}
                  disabled={getting !== null}
                  aria-busy={getting === a.template || undefined}
                  aria-label={`Download ${a.headline}`}
                  onClick={() => void get(a.template)}
                >
                  {getting === a.template ? 'Starting…' : 'Download'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No template matches that.</Empty>
      )}
      <div className={styles.dialogActions}>
        <Button onClick={onBack}>Back</Button>
      </div>
    </Modal>
  );
}
