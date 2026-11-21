// Configuration of an Incus instance: limits, autostart, protection,
// nesting, the snapshot schedule, the description and other allowed keys,
// devices (grow the root disk, a NIC's network), values a profile sets
// marked as such, and the keys only Incus itself may change
// (docs/MANAGE.md 2.5). Incus applies changes at once.

import { type ReactNode, useState } from 'react';
import { type Choices, type GuestConfig, useChoices, useGuestConfig } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { SelectField, Switch, TextField } from '../../components/forms';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { t } from '../../lib/i18n';
import { checkNumber, current, draftOf, formatSize, keyOrder, parseSize } from './config';
import { type DialogProps, FlagDialog, KeyErrors, TextDialog } from './dialogs';
import { EditDialog, type EditCtx } from './EditDialog';
import type { GuestTabProps } from './GuestPage';
import { ResizeDialog } from './hardwareDialogs';
import { CfgCard, CfgRow, EditButton, RestrictedCard } from './parts';
import { editProps, getProp, isOn, parseProps } from './props';

/** Keys with their own row (the rest of the allowed keys are listed under them). */
const OWN = new Set(['limits.cpu', 'limits.memory', 'boot.autostart', 'boot.autostart.priority', 'boot.autostart.delay', 'security.protection.delete', 'security.nesting', 'snapshots.schedule', 'snapshots.expiry', 'description']);

const MEM_RE = /^\d+(\.\d+)?\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)?$|^\d+%$/;

export function ConfigTab({ serverId, guest }: GuestTabProps) {
  const config = useGuestConfig(serverId, guest.id);
  const choices = useChoices(serverId, 'incus');
  const [open, setOpen] = useState<string | null>(null);
  if (!config.data) {
    return config.isError ? (
      <div className="card card-body">
        <InlineRetry title={t('Could not load the configuration')} error={config.error} onRetry={() => void config.refetch()} />
      </div>
    ) : (
      <Skeleton height={420} />
    );
  }
  const cfg = config.data;
  const ctx: EditCtx = { serverId, guest, config: cfg };
  const p = { ctx, onClose: () => setOpen(null) };
  const name = guest.name;
  const v = cfg.values;
  const restricted = new Set(cfg.restricted ?? []);
  const inherited = new Set(cfg.inherited ?? []);
  const container = cfg.kind === 'container';
  const profiles = cfg.profiles ?? [];
  const from = (k: string) => (inherited.has(k) ? (profiles.length === 1 ? t('from profile {name}', { name: profiles[0]! }) : t('from a profile ({names})', { names: profiles.join(', ') })) : undefined);

  const dialogs: Record<string, ReactNode> = {
    'limits.cpu': (
      <TextDialog
        {...p}
        cfgKey="limits.cpu"
        title={t('Edit CPU limit')}
        label={t('CPU limit of {name}', { name })}
        fieldLabel={t('CPUs')}
        hint={t('A number of CPUs (4), or the host CPUs to pin to (0-3 or 1,3). Empty: no limit.')}
        mono
        validate={(x) => (/^\d+$|^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(x) ? null : t('A number, a range (0-3) or a list (1,3).'))}
      />
    ),
    'limits.memory': (
      <TextDialog
        {...p}
        cfgKey="limits.memory"
        title={t('Edit memory limit')}
        label={t('Memory limit of {name}', { name })}
        fieldLabel={t('Memory')}
        hint={t('With a unit (4GiB, 512MiB) or a share of the host (50%). Empty: no limit.')}
        mono
        validate={(x) => (MEM_RE.test(x) ? null : t('A size like 4GiB or 512MiB, or a percentage like 50%.'))}
      />
    ),
    autostart: <AutostartDialog {...p} />,
    'security.protection.delete': (
      <FlagDialog {...p} explicit cfgKey="security.protection.delete" title={t('Delete protection')} label={t('Delete protection of {name}', { name })} switchLabel={t('Protect from deletion')} description={t('Incus refuses to delete the instance while this is on.')} />
    ),
    'security.nesting': (
      <FlagDialog {...p} explicit cfgKey="security.nesting" title={t('Nesting')} label={t('Nesting of {name}', { name })} switchLabel={t('Allow containers inside this container')} description={t('Needed for Docker or Incus inside the container.')} />
    ),
    snapshots: <SnapshotScheduleDialog {...p} />,
    description: <TextDialog {...p} cfgKey="description" title={t('Edit description')} label={t('Description of {name}', { name })} fieldLabel={t('Description')} multiline />,
  };

  const yes = (k: string) => (isOn(v[k]) ? t('Yes') : t('No'));
  const others = Object.keys(v)
    .filter((k) => !OWN.has(k) && !k.startsWith('device.') && !restricted.has(k))
    .sort(keyOrder);
  for (const k of others) dialogs[k] = <TextDialog {...p} cfgKey={k} title={t('Edit {key}', { key: k })} label={t('{key} of {name}', { key: k, name })} fieldLabel={k} mono />;
  const devices = Object.keys(v)
    .filter((k) => k.startsWith('device.') && !restricted.has(k))
    .sort(keyOrder);
  for (const k of devices) {
    const dev = k.slice('device.'.length);
    if (deviceType(v[k]) === 'disk') dialogs[k] = <ResizeDialog {...p} diskKey={dev} />;
    else if (deviceType(v[k]) === 'nic') dialogs[k] = <NicNetworkDialog {...p} cfgKey={k} choices={choices.data} />;
  }

  const autostart = isOn(v['boot.autostart']);
  const prio = v['boot.autostart.priority'];
  const delay = v['boot.autostart.delay'];
  return (
    <div className="section guest-tab">
      <CfgCard title={t('Configuration')} id="cfg-incus" sub={profiles.length ? t('Profiles: {names}', { names: profiles.join(', ') }) : undefined}>
        <CfgRow label={t('CPU limit')} sub={from('limits.cpu')} muted={!v['limits.cpu']} actions={<EditButton what={t('CPU limit')} onClick={() => setOpen('limits.cpu')} />}>
          {v['limits.cpu'] ? (/^\d+$/.test(v['limits.cpu']) ? t('{n} CPUs', { n: v['limits.cpu'] }) : t('CPUs {list}', { list: v['limits.cpu'] })) : t('No limit')}
        </CfgRow>
        <CfgRow label={t('Memory limit')} sub={from('limits.memory')} muted={!v['limits.memory']} actions={<EditButton what={t('memory limit')} onClick={() => setOpen('limits.memory')} />}>
          {v['limits.memory'] ? memText(v['limits.memory']) : t('No limit')}
        </CfgRow>
        <CfgRow
          label={t('Start at boot')}
          sub={[from('boot.autostart'), prio ? t('priority {n}', { n: prio }) : '', delay ? t('then wait {n} s', { n: delay }) : ''].filter(Boolean).join(' · ') || undefined}
          actions={<EditButton what={t('start at boot')} onClick={() => setOpen('autostart')} />}
        >
          {autostart ? t('Yes') : t('No')}
        </CfgRow>
        <CfgRow label={t('Delete protection')} sub={from('security.protection.delete')} actions={<EditButton what={t('delete protection')} onClick={() => setOpen('security.protection.delete')} />}>
          {yes('security.protection.delete')}
        </CfgRow>
        {container && (
          <CfgRow label={t('Nesting')} sub={from('security.nesting')} actions={<EditButton what={t('nesting')} onClick={() => setOpen('security.nesting')} />}>
            {yes('security.nesting')}
          </CfgRow>
        )}
        <CfgRow
          label={t('Automatic snapshots')}
          muted={!v['snapshots.schedule']}
          sub={v['snapshots.expiry'] ? t('kept for {time}', { time: v['snapshots.expiry'] }) : from('snapshots.schedule')}
          actions={<EditButton what={t('automatic snapshots')} onClick={() => setOpen('snapshots')} />}
        >
          {v['snapshots.schedule'] ? <span className="mono">{v['snapshots.schedule']}</span> : t('Off')}
        </CfgRow>
        <CfgRow label={t('Description')} muted={!v.description} actions={<EditButton what={t('description')} onClick={() => setOpen('description')} />}>
          {v.description ? <span className="guest-notes">{v.description}</span> : t('None')}
        </CfgRow>
        {others.map((k) => (
          <CfgRow key={k} label={<span className="mono">{k}</span>} sub={from(k)} actions={<EditButton what={k} onClick={() => setOpen(k)} />}>
            <span className="mono">{v[k]}</span>
          </CfgRow>
        ))}
      </CfgCard>
      {devices.length > 0 && (
        <CfgCard title={t('Devices')} id="cfg-devices">
          {devices.map((k) => (
            <DeviceRow key={k} cfg={cfg} k={k} sub={from(k)} onOpen={() => setOpen(k)} />
          ))}
        </CfgCard>
      )}
      <RestrictedCard cfg={cfg} platform="Incus" />
      {open && dialogs[open]}
    </div>
  );
}

const deviceType = (v: string | undefined) => getProp(parseProps(v ?? ''), 'type') ?? '';

/** "4GiB" -> "4 GiB" (Incus units as written; 50% stays). */
const memText = (v: string) => v.replace(/^(\d+(?:\.\d+)?)\s*(?=[A-Za-z])/, '$1 ');

function DeviceRow({ cfg, k, sub, onOpen }: { cfg: GuestConfig; k: string; sub?: string; onOpen: () => void }) {
  const items = parseProps(cfg.values[k] ?? '');
  const dev = k.slice('device.'.length);
  const type = getProp(items, 'type');
  if (type === 'disk') {
    const size = parseSize(getProp(items, 'size'));
    const path = getProp(items, 'path');
    return (
      <CfgRow
        label={path === '/' ? t('Root disk ({name})', { name: dev }) : t('Disk ({name})', { name: dev })}
        sub={[path && path !== '/' ? t('at {path}', { path }) : '', sub].filter(Boolean).join(' · ') || undefined}
        actions={<Menu label={t('More for {name}', { name: dev })} items={[{ label: t('Resize…'), icon: 'plus', onSelect: onOpen }]} buttonClassName="btn-ghost btn-icon row-action" floating />}
      >
        {[t('pool {name}', { name: getProp(items, 'pool') ?? '?' }), size ? formatSize(size) : t('the pool’s default size')].join(' · ')}
      </CfgRow>
    );
  }
  if (type === 'nic') {
    const network = getProp(items, 'network');
    const parent = getProp(items, 'parent');
    return (
      <CfgRow label={t('Network device ({name})', { name: dev })} sub={[getProp(items, 'name'), getProp(items, 'hwaddr'), sub].filter(Boolean).join(' · ') || undefined} actions={<EditButton what={dev} onClick={onOpen} />}>
        {network ? t('network {name}', { name: network }) : parent ? t('bridge {name}', { name: parent }) : (cfg.values[k] ?? '')}
      </CfgRow>
    );
  }
  return (
    <CfgRow label={<span className="mono">{dev}</span>} sub={sub}>
      <span className="mono cfg-raw">{cfg.values[k]}</span>
    </CfgRow>
  );
}

function AutostartDialog({ ctx, onClose }: DialogProps) {
  const on0 = isOn(current(ctx.config, 'boot.autostart'));
  const prio0 = current(ctx.config, 'boot.autostart.priority') ?? '';
  const delay0 = current(ctx.config, 'boot.autostart.delay') ?? '';
  const [on, setOn] = useState(on0);
  const [prio, setPrio] = useState(prio0);
  const [delay, setDelay] = useState(delay0);
  const pr = checkNumber(prio, { min: 0, optional: true });
  const de = checkNumber(delay, { min: 0, optional: true });
  const draft =
    pr.error || de.error
      ? null
      : draftOf({
          ...(on !== on0 ? { 'boot.autostart': on ? 'true' : 'false' } : {}),
          ...(prio.trim() !== prio0 ? { 'boot.autostart.priority': prio.trim() || undefined } : {}),
          ...(delay.trim() !== delay0 ? { 'boot.autostart.delay': delay.trim() || undefined } : {}),
        });
  return (
    <EditDialog ctx={ctx} title={t('Start at boot')} label={t('Autostart of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <Switch checked={on} onChange={setOn} label={t('Start when the host boots')} />
          <div className="form-grid">
            <TextField label={t('Priority')} inputMode="numeric" value={prio} placeholder="0" onChange={(e) => setPrio(e.target.value)} hint={t('Higher starts first')} error={errors['boot.autostart.priority'] ?? pr.error ?? undefined} />
            <TextField label={t('Then wait (s)')} inputMode="numeric" value={delay} placeholder="0" onChange={(e) => setDelay(e.target.value)} error={errors['boot.autostart.delay'] ?? de.error ?? undefined} />
          </div>
          <KeyErrors errors={errors} keys={['boot.autostart']} />
        </>
      )}
    </EditDialog>
  );
}

function SnapshotScheduleDialog({ ctx, onClose }: DialogProps) {
  const s0 = current(ctx.config, 'snapshots.schedule') ?? '';
  const e0 = current(ctx.config, 'snapshots.expiry') ?? '';
  const [schedule, setSchedule] = useState(s0);
  const [expiry, setExpiry] = useState(e0);
  const expErr = expiry.trim() && !/^(\d+[MHdwmy]\s*)+$/.test(expiry.trim()) ? t('Like 2w, 3d or 1m (minutes M, hours H, days d, weeks w, months m, years y).') : null;
  const draft = expErr
    ? null
    : draftOf({
        ...(schedule.trim() !== s0 ? { 'snapshots.schedule': schedule.trim() || undefined } : {}),
        ...(expiry.trim() !== e0 ? { 'snapshots.expiry': expiry.trim() || undefined } : {}),
      });
  return (
    <EditDialog ctx={ctx} title={t('Automatic snapshots')} label={t('Snapshot schedule of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <TextField label={t('Schedule')} mono value={schedule} placeholder="@daily" onChange={(e) => setSchedule(e.target.value)} hint={t('Cron syntax or @hourly, @daily, @weekly; empty: off')} error={errors['snapshots.schedule']} autoFocus />
          <TextField label={t('Keep for')} mono value={expiry} placeholder="2w" onChange={(e) => setExpiry(e.target.value)} hint={t('Empty: until deleted')} error={errors['snapshots.expiry'] ?? expErr ?? undefined} />
        </>
      )}
    </EditDialog>
  );
}

/**
 * The network of a NIC: an Incus network or a host bridge (the choices
 * mix both). It is sent as network=<name>; the agent turns a host bridge
 * into nictype=bridged,parent=<name>.
 */
function NicNetworkDialog({ ctx, onClose, cfgKey, choices }: DialogProps & { cfgKey: string; choices: Choices | undefined }) {
  const cur = current(ctx.config, cfgKey) ?? '';
  const items = parseProps(cur);
  const was = getProp(items, 'network') ?? getProp(items, 'parent') ?? '';
  const [net, setNet] = useState(was);
  const list = choices?.bridges ?? [];
  const all = was && !list.includes(was) ? [was, ...list] : list;
  const draft = net === was ? {} : draftOf({ [cfgKey]: editProps(cur, { network: net, nictype: undefined, parent: undefined }) });
  return (
    <EditDialog ctx={ctx} title={t('Edit {name}', { name: cfgKey.slice('device.'.length) })} label={t('Network of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <SelectField label={t('Network')} value={net} onChange={(e) => setNet(e.target.value)} disabled={!choices} autoFocus>
            {all.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </SelectField>
          <KeyErrors errors={errors} keys={[cfgKey]} />
        </>
      )}
    </EditDialog>
  );
}
