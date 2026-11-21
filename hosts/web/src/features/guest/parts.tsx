// Building blocks of the configuration tabs: a card of rows (label, value,
// the value after the next restart, actions), read-only rows for keys only
// the platform's own interface may change, and the select fields fed by
// the host's choices (storages, bridges, ISO images).

import type { ReactNode } from 'react';
import type { Choices, GuestConfig } from '../../api/manage';
import { SelectField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { t, tx } from '../../lib/i18n';
import { formatSize, keyOrder } from './config';

export function CfgCard({ title, id, sub, actions, children }: { title: string; id: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card cfg-card" aria-labelledby={id}>
      <div className="card-head">
        <h2 className="h2" id={id}>
          {title}
        </h2>
        {sub && <span className="sub">{sub}</span>}
        {actions && <div className="cfg-head-act">{actions}</div>}
      </div>
      <dl className="cfg-list">{children}</dl>
    </section>
  );
}

interface CfgRowProps {
  label: ReactNode;
  children: ReactNode;
  /** A second, quieter line (options, the raw value). */
  sub?: ReactNode;
  /** The value after the next restart (pending), "" when the key goes away then. */
  next?: ReactNode;
  actions?: ReactNode;
  /** Quieter text for unset values. */
  muted?: boolean;
}

export function CfgRow({ label, children, sub, next, actions, muted }: CfgRowProps) {
  return (
    <div className="cfg-row">
      <dt className="lbl">{label}</dt>
      <dd className="cfg-v">
        <span className={muted ? 'ink-3' : undefined}>{children}</span>
        {next !== undefined && (
          <span className="cfg-next">
            <Icon name="arrowRight" size={13} />
            {next === '' ? t('removed (after restart)') : tx('{value} (after restart)', { value: next })}
          </span>
        )}
        {sub && <small className="cfg-sub">{sub}</small>}
      </dd>
      {actions && <dd className="cfg-act">{actions}</dd>}
    </div>
  );
}

/** The row's Edit button ("Edit memory" for screen readers). */
export function EditButton({ what, onClick, text }: { what: string; onClick: () => void; text?: string }) {
  return (
    <button type="button" className="btn-ghost row-action" onClick={onClick}>
      {text ?? t('Edit')}
      <span className="sr-only"> {what}</span>
    </button>
  );
}

/** Keys Rackoon shows but never changes (root-only settings, host devices, raw options). */
export function RestrictedCard({ cfg, platform, skip = [] }: { cfg: GuestConfig; platform: string; skip?: string[] }) {
  // meta (creation time and QEMU version) is Proxmox's own bookkeeping.
  const keys = (cfg.restricted ?? []).filter((k) => k !== 'meta' && !skip.includes(k)).sort(keyOrder);
  if (!keys.length) return null;
  return (
    <CfgCard title={t('Settings only {platform} can change', { platform })} id="cfg-restricted" sub={t('Read-only here')}>
      {keys.map((k) => (
        <CfgRow key={k} label={<span className="mono">{k}</span>} actions={<LockNote platform={platform} />}>
          <span className="mono cfg-raw">{cfg.values[k] ?? ''}</span>
        </CfgRow>
      ))}
    </CfgCard>
  );
}

export function LockNote({ platform }: { platform: string }) {
  return (
    <span className="cfg-lock lbl">
      <Icon name="lock" size={13} />
      {t('Change this in {platform}', { platform })}
    </span>
  );
}

// ---------------------------------------------------------------- choice fields

const free = (s: Choices['storages'][number]) => (s.avail_bytes != null ? ` · ${t('{size} free', { size: formatSize(s.avail_bytes) })}` : '');

/** Storages offering `content` (images for VM disks, rootdir for container volumes). */
export function StorageSelect({ choices, content, value, onChange, label, error, exclude }: {
  choices: Choices | undefined;
  content: string;
  value: string;
  onChange: (v: string) => void;
  label?: string;
  error?: string;
  /** Leave this storage out (the disk's current one, for Move). */
  exclude?: string;
}) {
  const list = (choices?.storages ?? []).filter((s) => s.content.includes(content) && s.id !== exclude);
  return (
    <SelectField label={label ?? t('Storage')} value={value} onChange={(e) => onChange(e.target.value)} error={error} disabled={!choices}>
      {!choices && <option value="">{t('Loading…')}</option>}
      {choices && !list.length && <option value="">{t('No storage offers this')}</option>}
      {list.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id} ({s.type}){free(s)}
        </option>
      ))}
    </SelectField>
  );
}

export function BridgeSelect({ choices, value, onChange, label, error }: { choices: Choices | undefined; value: string; onChange: (v: string) => void; label?: string; error?: string }) {
  const list = choices?.bridges ?? [];
  // Keep a bridge the host no longer lists selectable, so opening the dialog changes nothing.
  const all = value && !list.includes(value) ? [value, ...list] : list;
  return (
    <SelectField label={label ?? t('Bridge')} value={value} onChange={(e) => onChange(e.target.value)} error={error} disabled={!choices}>
      {!choices && <option value="">{t('Loading…')}</option>}
      {all.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </SelectField>
  );
}

/** ISO images of the host's iso storages, or no medium. */
export function IsoSelect({ choices, value, onChange }: { choices: Choices | undefined; value: string; onChange: (v: string) => void }) {
  const list = choices?.isos ?? [];
  const known = value === 'none' || list.some((x) => x.volume === value);
  return (
    <SelectField label={t('Medium')} value={value} onChange={(e) => onChange(e.target.value)} disabled={!choices}>
      <option value="none">{t('No medium')}</option>
      {!known && value && <option value={value}>{value}</option>}
      {list.map((x) => (
        <option key={x.volume} value={x.volume}>
          {x.name} ({x.storage})
        </option>
      ))}
    </SelectField>
  );
}

/** A checkbox row (the existing .check-row style). */
export function CheckRow({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="lbl"> · {hint}</span>}
      </span>
    </label>
  );
}
