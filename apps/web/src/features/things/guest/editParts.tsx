/**
 * Pieces the guest editing tabs share (ported from Rackoon's `features/guest/parts.tsx` and `dialogs.tsx`): a row with
 * what it becomes after the next restart and its actions (or the lock on a key only the platform changes), the “…”
 * menu of a row, the server's field errors for keys a dialog has no field for, the host's choices and the selects
 * they feed (storages, networks, ISO images from any ISO storage), and the card of settings no tab has a row for.
 */
import {
  discName,
  formatBytesBinary,
  isRestricted,
  otherKeys,
  storagesFor,
  volumeStorage,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import { useTheAgent } from '@whombat/client/react';
import type { HostChoices, HostGuestConfig } from '@whombat/core/domain';
import { Ellipsis, Lock } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type ContextMenuItem, useRowMenu } from '../../../app/shell/ContextMenu';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SelectField } from '../manage/fields';
import { Card } from '../parts';
import styles from '../Things.module.css';
import type { EditCtx } from './EditDialog';
import wa from './GuestEdit.module.css';

/** “Proxmox” or “Incus”: where a locked key is changed. */
export const platformName = (cfg: Pick<HostGuestConfig, 'platform'>): string =>
  cfg.platform === 'incus' ? 'Incus' : 'Proxmox';

export function Row({
  title,
  value,
  sub,
  action,
  mono,
  next,
  muted,
  locked,
  later = 'after restart',
}: {
  title: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  mono?: boolean;
  /** What it becomes at the next restart; "" when it goes then. */
  next?: string;
  /** Quieter words for a value that isn't set (“The server’s”). */
  muted?: boolean;
  /** Only the platform changes it: a lock with “Change this in <platform>” instead of the actions. */
  locked?: string;
  /** When `next` applies (libvirt: “at the next start”, AP-1652). */
  later?: string;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.muted} style={{ width: 150, flex: 'none' }}>
        {title}
      </span>
      <div className={styles.rowMain}>
        <div className={wa.waValue}>
          <b
            className={cx(mono && styles.mono, muted && wa.waNew)}
            style={mono ? { fontSize: 13.5, overflowWrap: 'anywhere' } : undefined}
          >
            {value}
          </b>
          {next !== undefined ? (
            <span className={wa.waNext}>{next === '' ? `→ removed (${later})` : `→ ${next} (${later})`}</span>
          ) : null}
        </div>
        {sub ? <small>{sub}</small> : null}
      </div>
      {locked ? <LockNote platform={locked} /> : action ? <span className={wa.waActs}>{action}</span> : null}
    </div>
  );
}

export function LockNote({ platform }: { platform: string }) {
  return (
    <span className={wa.waLock}>
      <Icon icon={Lock} size={13} />
      Change this in {platform}
    </span>
  );
}

/** A row's text action (“Change memory” for screen readers). */
export function EditBtn({
  label,
  onClick,
  text = 'Change',
  serious,
}: {
  label: string;
  onClick: () => void;
  text?: string;
  serious?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(styles.cardLink, serious && wa.waSerious)}
      style={{ marginLeft: 0 }}
      onClick={onClick}
    >
      {text} <span className={styles.srOnly}>{label}</span>
    </button>
  );
}

/** A row's “…” menu (grow, move, detach, remove). */
export function MoreBtn({ label, items }: { label: string; items: ContextMenuItem[] }) {
  const menu = useRowMenu();
  const open = menu.openKey === label;
  return (
    <>
      <button
        type="button"
        className={cx(styles.iconBtn, wa.waMore)}
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => menu.openFrom(e.currentTarget, label, `More for ${label}`, items, 'end')}
      >
        <Icon icon={Ellipsis} size={16} />
      </button>
      {menu.element}
    </>
  );
}

/** The server's field errors for keys a dialog has no field of its own for. */
export function KeyErrors({ errors, keys }: { errors: Record<string, string>; keys: readonly string[] }) {
  const list = keys.filter((k) => errors[k]).map((k) => `${k}: ${errors[k]}`);
  return list.length ? (
    <p className={styles.error} role="alert">
      {list.join(' ')}
    </p>
  ) : null;
}

/** The host's storages, networks, ISO images, CPU types and whether it is in a cluster. */
export function useChoices(ctx: Pick<EditCtx, 'burrow' | 'serverId' | 'config'>): HostChoices | undefined {
  const r = useHostManageRead({
    params: { burrow: ctx.burrow, serverId: ctx.serverId },
    query: { op: 'choices', platform: ctx.config.platform },
  });
  return r.data?.op === 'choices' ? r.data.choices : undefined;
}

const free = (s: HostChoices['storages'][number]) =>
  s.availBytes != null ? ` · ${formatBytesBinary(s.availBytes)} free` : '';

/** Storages that hold `content` (`images` for VM disks, `rootdir` for containers); `exclude` leaves one out. */
export function StorageSelect({
  choices,
  content,
  value,
  onChange,
  label = 'Storage',
  error,
  exclude,
}: {
  choices: HostChoices | undefined;
  content: string;
  value: string;
  onChange: (v: string) => void;
  label?: string;
  error?: string | null;
  exclude?: string;
}) {
  const list = storagesFor(choices, content).filter((s) => s.id !== exclude);
  const options = !choices
    ? [{ value: '', label: 'Loading…' }]
    : list.length
      ? list.map((s) => ({ value: s.id, label: `${s.id} (${s.type})${free(s)}` }))
      : [{ value: '', label: 'No storage here holds this' }];
  return (
    <SelectField
      label={label}
      options={options}
      value={value}
      disabled={!choices || !list.length}
      error={error}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The host's networks; one it no longer lists stays selectable, so opening a dialog changes nothing. */
export function BridgeSelect({
  choices,
  value,
  onChange,
  error,
}: {
  choices: HostChoices | undefined;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
}) {
  const list = choices?.bridges ?? [];
  const all = value && !list.includes(value) ? [value, ...list] : list;
  return (
    <SelectField
      label="Network"
      options={all.length ? all.map((b) => ({ value: b, label: b })) : [{ value: '', label: 'Loading…' }]}
      value={value}
      error={error}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

interface IsoItem {
  volume: string;
  name: string;
}

/**
 * An ISO image from any of the host's ISO storages, or none: the storage first, then its images (from the choices'
 * list when the host sends one, else that storage's content).
 */
export function IsoPicker({
  ctx,
  choices,
  value,
  onChange,
}: {
  ctx: Pick<EditCtx, 'burrow' | 'serverId'>;
  choices: HostChoices | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  const stores = storagesFor(choices, 'iso');
  const [store, setStore] = useState(() => volumeStorage(value) || '');
  const st = store || stores[0]?.id || '';
  const listed = (choices?.isos ?? [])
    .map((x) => ({
      volume: String(x.volume ?? ''),
      storage: String(x.storage ?? ''),
      name: String(x.name ?? ''),
    }))
    .filter((x) => x.volume);
  const content = useHostManageRead(
    st && choices && !listed.length
      ? {
          params: { burrow: ctx.burrow, serverId: ctx.serverId },
          query: { op: 'content.list', storage: st, content: 'iso' },
        }
      : null,
  );
  const items: IsoItem[] = listed.length
    ? listed
        .filter((x) => x.storage === st)
        .map((x) => ({ volume: x.volume, name: x.name || discName(x.volume) }))
    : content.data?.op === 'content.list'
      ? content.data.items
          .map((i) => String(i.volid ?? ''))
          .filter((v) => /\.(iso|img)$/i.test(v))
          .map((v) => ({ volume: v, name: discName(v) }))
      : [];
  const known = value === 'none' || !value || items.some((x) => x.volume === value);
  const options = [
    { value: 'none', label: 'No disc' },
    ...(!known && volumeStorage(value) === st ? [{ value, label: discName(value) }] : []),
    ...items.map((x) => ({ value: x.volume, label: x.name })),
  ];
  return (
    <div className={styles.formRow}>
      <SelectField
        label="ISO storage"
        options={
          stores.length ? stores.map((s) => ({ value: s.id, label: s.id })) : [{ value: '', label: '—' }]
        }
        value={st}
        disabled={!stores.length}
        onChange={(e) => {
          setStore(e.target.value);
          onChange('none');
        }}
      />
      <SelectField
        label="Disc"
        options={options}
        value={value || 'none'}
        hint={choices && !stores.length ? 'No storage on this server holds ISO images.' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * Settings no tab has a row for (PCI and USB passthrough, serial ports, raw arguments, SMBIOS …), as they are and
 * read-only; the ones only the platform changes carry its lock.
 */
export function OtherSettings({ ctx, cloudInit }: { ctx: EditCtx; cloudInit?: boolean }) {
  const cfg = ctx.config;
  const keys = otherKeys(cfg, { cloudInit });
  // The assistant changes them, by its name (Whombat assistant-name.md AN-01).
  const { words } = useTheAgent(ctx.burrow);
  if (!keys.length) return null;
  const platform = platformName(cfg);
  return (
    <Card title="Other settings" meta="Shown as they are">
      <div className={styles.rows}>
        {keys.map((k) => (
          <div key={k} className={styles.row}>
            <span className={styles.mono} style={{ width: 150, flex: 'none', fontSize: 13 }}>
              {k}
            </span>
            <div className={styles.rowMain}>
              <span className={wa.waRaw}>{cfg.values[k] ?? cfg.pending?.[k] ?? ''}</span>
            </div>
            {isRestricted(cfg, k) ? <LockNote platform={platform} /> : null}
          </div>
        ))}
      </div>
      {keys.some((k) => !isRestricted(cfg, k)) ? (
        <p className={styles.cardNote}>{words.Name} can change the others for you: ask in a chat.</p>
      ) : null}
    </Card>
  );
}
