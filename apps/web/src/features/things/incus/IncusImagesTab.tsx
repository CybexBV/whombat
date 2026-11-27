/**
 * An Incus server's Images (Whombat incus-unraid.md IU-04; AP-1575): what's in its image store — the images it made
 * (the computer base images, an image made from an instance) and the ones it keeps from images.linuxcontainers.org —
 * with Download an image (an alias and a kind, kept up to date by default), Refresh and Delete (asked). Downloads and
 * refreshes are Incus operations the task tracker follows.
 */
import {
  DASH,
  formatBytesBinary,
  formatRelativeDay,
  type HostIncusImage,
  INCUS_COMMON_IMAGES,
  imageName,
  imageTypeWord,
  incusDetail,
  incusDoneText,
  incusTaskWhat,
  remoteAliasError,
  sortImages,
} from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core/domain';
import { Download } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { currentLocale } from '../../../i18n/provider';
import { GuestKindIcon } from '../GuestName';
import { Check, FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Card, Empty } from '../parts';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { useIncusChoices } from './IncusDialogs';
import { useIncusCanChange } from './IncusStorage';

export function IncusImagesTab({
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
  const canChange = useIncusCanChange(burrow, detail);
  const { send, busy } = useManage(burrow, serverId);
  const [open, setOpen] = useState<{ kind: 'download' } | { kind: 'delete'; img: HostIncusImage } | null>(
    null,
  );
  const images = sortImages(inc?.images ?? []);
  const now = Date.parse(detail.asOf);
  const refresh = (img: HostIncusImage) =>
    void send(
      {
        op: 'image.refresh',
        params: {
          fingerprint: img.fingerprint,
          ...(img.project !== 'default' ? { project: img.project } : {}),
        },
        name: imageName(img),
        what: incusTaskWhat('image.refresh', imageName(img)),
        done: incusDoneText('image.refresh', imageName(img)),
      },
      { inline: false },
    );
  return (
    <>
      <Card
        title="Images"
        meta={
          images.length
            ? `${images.length} on this server · ${formatBytesBinary(images.reduce((a, i) => a + i.sizeBytes, 0))}`
            : undefined
        }
        link={
          canChange ? (
            <Button
              size="sm"
              style={{ marginLeft: 'auto' }}
              iconStart={<Icon icon={Download} size={14} />}
              onClick={() => setOpen({ kind: 'download' })}
            >
              Download an image
            </Button>
          ) : undefined
        }
      >
        {!inc ? (
          <Empty>No word from Incus about its images yet.</Empty>
        ) : images.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Image
                </th>
                <th scope="col" className={styles.dropS}>
                  Size
                </th>
                <th scope="col" className={styles.dropL}>
                  Added
                </th>
                <th scope="col" className={styles.dropM}>
                  Last used
                </th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {images.map((i) => (
                <tr key={`${i.project}/${i.fingerprint}`}>
                  <td className={styles.cellMain}>
                    <span className={styles.cellLine}>
                      <GuestKindIcon
                        kind={{
                          glyph: i.type === 'virtual-machine' ? 'vm' : 'lxc',
                          label: `${imageTypeWord(i.type)} image`,
                          id: null,
                        }}
                      />
                      <span
                        className={cx(i.aliases[0] ? styles.mono : undefined, styles.ellipsis)}
                        style={i.aliases[0] ? undefined : { fontWeight: 500 }}
                        title={imageName(i)}
                      >
                        {imageName(i)}
                      </span>
                      {i.project !== 'default' ? <span className={styles.kind}>{i.project}</span> : null}
                    </span>
                    <span className={cx(wi.wiSub, styles.underIcon)}>
                      {[
                        i.aliases[0] ? i.description : null,
                        i.fingerprint.slice(0, 12),
                        i.cached ? 'kept from images.linuxcontainers.org' : null,
                        i.autoUpdate ? 'updates itself' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </td>
                  <td className={cx(styles.num, styles.dropS)}>{formatBytesBinary(i.sizeBytes)}</td>
                  <td className={cx(styles.num, styles.dropL)}>
                    {i.uploadedAt
                      ? formatRelativeDay(Date.parse(i.uploadedAt), now, timeZone, currentLocale())
                      : DASH}
                  </td>
                  <td className={cx(styles.num, styles.dropM)}>
                    {i.lastUsedAt
                      ? formatRelativeDay(Date.parse(i.lastUsedAt), now, timeZone, currentLocale())
                      : 'Never'}
                  </td>
                  <td>
                    {canChange ? (
                      <span className={wi.wiActs}>
                        {i.cached || i.autoUpdate ? (
                          <button
                            type="button"
                            className={styles.cardLink}
                            style={{ marginLeft: 0 }}
                            disabled={busy}
                            onClick={() => refresh(i)}
                          >
                            Refresh <span className={styles.srOnly}>{imageName(i)}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`${styles.cardLink} ${wi.wiSerious}`}
                          style={{ marginLeft: 0 }}
                          onClick={() => setOpen({ kind: 'delete', img: i })}
                        >
                          Delete… <span className={styles.srOnly}>{imageName(i)}</span>
                        </button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No images yet: download one, or make one from an instance’s More menu.</Empty>
        )}
        {images.some((i) => i.cached) ? (
          <p className={styles.cardNote}>Incus removes the copies it kept by itself once they go unused.</p>
        ) : null}
      </Card>
      {open?.kind === 'download' ? (
        <DownloadDialog
          burrow={burrow}
          serverId={serverId}
          projects={inc?.projects.map((p) => p.name) ?? ['default']}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteImageDialog burrow={burrow} serverId={serverId} img={open.img} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}

function DownloadDialog({
  burrow,
  serverId,
  projects,
  onClose,
}: {
  burrow: string;
  serverId: string;
  projects: string[];
  onClose: () => void;
}) {
  const choices = useIncusChoices(burrow, serverId);
  const [alias, setAlias] = useState('debian/13');
  const [type, setType] = useState<'container' | 'virtual-machine'>('container');
  const [project, setProject] = useState('default');
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const listId = useId();
  const known = [
    ...new Set([
      ...(choices?.remoteImages ?? []).filter((r) => r.type === type).map((r) => r.alias),
      ...INCUS_COMMON_IMAGES,
    ]),
  ];
  const bad = remoteAliasError(alias);
  const clean = alias.trim().replace(/^images:/, '');
  return (
    <FormDialog
      title="Download an image"
      description="From images.linuxcontainers.org. New instances start from it at once instead of downloading it first."
      action={busy ? 'Starting…' : 'Download'}
      busy={busy}
      disabled={!!bad}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send({
            op: 'image.download',
            params: { alias: clean, type, ...(project !== 'default' ? { project } : {}), autoUpdate: auto },
            name: clean,
            what: incusTaskWhat('image.download', clean),
          });
          if (out.ok) onClose();
          else {
            setFields(out.fields);
            setError(Object.keys(out.fields).length ? null : out.message);
          }
        })()
      }
    >
      <TextField
        label="Image"
        mono
        list={listId}
        value={alias}
        autoFocus
        error={bad ?? fields.alias}
        hint="Like debian/13, ubuntu/24.04 or alpine/3.22; add /cloud for one that reads cloud-init."
        onChange={(e) => setAlias(e.target.value)}
      />
      <datalist id={listId}>
        {known.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <div className={styles.field}>
        <span>Kind</span>
        <SegmentedControl
          options={[
            { value: 'container', label: 'Container' },
            { value: 'virtual-machine', label: 'Virtual machine' },
          ]}
          value={type}
          onChange={setType}
          label="Kind"
          variant="soft"
        />
      </div>
      {projects.length > 1 ? (
        <SelectField
          label="Project"
          options={projects.map((p) => ({ value: p, label: p }))}
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
      ) : null}
      <Check
        label="Keep it up to date"
        hint="Incus fetches new builds of it on its own."
        checked={auto}
        onChange={setAuto}
      />
    </FormDialog>
  );
}

function DeleteImageDialog({
  burrow,
  serverId,
  img,
  onClose,
}: {
  burrow: string;
  serverId: string;
  img: HostIncusImage;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const name = imageName(img);
  return (
    <FormDialog
      title={`Delete ${name}?`}
      description="Instances made from it keep running; new ones can’t start from it until it’s downloaded again."
      action={busy ? 'Deleting…' : 'Delete image'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'image.delete',
            params: {
              fingerprint: img.fingerprint,
              ...(img.project !== 'default' ? { project: img.project } : {}),
            },
            confirm: true,
            name,
            what: incusTaskWhat('image.delete', name),
            done: incusDoneText('image.delete', name),
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
