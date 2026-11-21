// Options of a Proxmox guest: name, start at boot and order, OS type, boot
// order, the VM's QEMU switches, the container's features and console,
// protection, notes and tags, and the HA row (docs/MANAGE.md, Editing).
// Each row edits one key (a few edit a property string) through the
// review step.

import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { useGuestConfig } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { Chip } from '../../components/controls';
import { Field, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { t, tn } from '../../lib/i18n';
import { bootOrder, checkNumber, current, DISK_RE, diskFile, draftOf, flagValue, formatTags, isCdrom, keyOrder, keysOf, parseTags, rowValue, tagError, withBootOrder } from './config';
import { type DialogProps, FlagDialog, KeyErrors, type Option, SelectDialog, TextDialog } from './dialogs';
import { EditDialog, type EditCtx } from './EditDialog';
import type { GuestTabProps } from './GuestPage';
import { HARow } from './HARow';
import { CfgCard, CfgRow, CheckRow, EditButton, LockNote } from './parts';
import { PendingBanner } from './PendingBanner';
import { editProps, getProp, isOn, parseProps } from './props';

const OS_TYPES: Option[] = [
  { value: 'other', label: t('Other') },
  { value: 'l26', label: 'Linux 6.x – 2.6 kernel' },
  { value: 'l24', label: 'Linux 2.4 kernel' },
  { value: 'win11', label: 'Windows 11 / 2022 / 2025' },
  { value: 'win10', label: 'Windows 10 / 2016 / 2019' },
  { value: 'win8', label: 'Windows 8.x / 2012 / 2012 R2' },
  { value: 'win7', label: 'Windows 7 / 2008 R2' },
  { value: 'w2k8', label: 'Windows Vista / 2008' },
  { value: 'wxp', label: 'Windows XP / 2003' },
  { value: 'w2k', label: 'Windows 2000' },
  { value: 'solaris', label: 'Solaris' },
];

const CMODES: Option[] = [
  { value: 'tty', label: t('TTY (default)') },
  { value: 'console', label: t('/dev/console') },
  { value: 'shell', label: t('Shell') },
];

const HOTPLUG = ['disk', 'network', 'usb', 'memory', 'cpu'] as const;
const HOTPLUG_DEFAULT = ['network', 'disk', 'usb'];

function hotplugList(v: string | undefined): string[] {
  if (v === undefined || v === '1') return HOTPLUG_DEFAULT;
  if (v === '0' || v === '') return [];
  return v.split(',').filter(Boolean);
}

const yesNo = (on: boolean) => (on ? t('Yes') : t('No'));

function startupText(v: string | undefined): string {
  if (!v) return t('Any order');
  const items = parseProps(v);
  const order = getProp(items, 'order');
  const up = getProp(items, 'up');
  const down = getProp(items, 'down');
  return [order ? t('order {n}', { n: order }) : t('any order'), up ? t('start delay {n} s', { n: up }) : '', down ? t('shutdown timeout {n} s', { n: down }) : ''].filter(Boolean).join(' · ');
}

/** One option row: its key, how the value reads, the dialog that edits it. */
interface RowSpec {
  key: string;
  label: string;
  show: (v: string | undefined) => ReactNode;
  dialog: ReactNode;
  /** Shown read-only (with the lock). */
  locked?: boolean;
}

export function OptionsTab(props: GuestTabProps) {
  const { serverId, guest } = props;
  const config = useGuestConfig(serverId, guest.id);
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
  const vm = cfg.kind === 'vm';
  const v = cfg.values;
  const restricted = new Set(cfg.restricted ?? []);
  const close = () => setOpen(null);
  const p = { ctx, onClose: close };
  const name = guest.name;

  const flag = (key: string, label: string, switchLabel: string, defaultOn = false, description?: string): RowSpec => ({
    key,
    label,
    show: (x: string | undefined) => yesNo(isOn(x, defaultOn)),
    dialog: <FlagDialog {...p} cfgKey={key} title={label} label={t('{what} of {name}', { what: label, name })} switchLabel={switchLabel} defaultOn={defaultOn} description={description} />,
  });

  const rows: RowSpec[] = [
    vm
      ? {
          key: 'name',
          label: t('Name'),
          show: (x) => x ?? guest.name,
          dialog: <TextDialog {...p} cfgKey="name" title={t('Edit name')} label={t('Name of {name}', { name })} fieldLabel={t('Name')} hint={t('A DNS name: letters, digits, “-” and “.”.')} mono required />,
        }
      : {
          key: 'hostname',
          label: t('Hostname'),
          show: (x) => x ?? guest.name,
          dialog: <TextDialog {...p} cfgKey="hostname" title={t('Edit hostname')} label={t('Hostname of {name}', { name })} fieldLabel={t('Hostname')} hint={t('A DNS name: letters, digits, “-” and “.”.')} mono required />,
        },
    flag('onboot', t('Start at boot'), t('Start when the host boots')),
    { key: 'startup', label: t('Start and shutdown order'), show: startupText, dialog: <StartupDialog {...p} /> },
    vm
      ? { key: 'ostype', label: t('OS type'), show: (x) => OS_TYPES.find((o) => o.value === (x ?? 'other'))?.label ?? x, dialog: <SelectDialog {...p} cfgKey="ostype" title={t('Edit OS type')} label={t('OS type of {name}', { name })} fieldLabel={t('OS type')} options={OS_TYPES} /> }
      : { key: 'ostype', label: t('OS type'), show: (x) => x ?? t('Unknown'), dialog: null, locked: true },
  ];
  if (vm) {
    rows.push(
      { key: 'boot', label: t('Boot order'), show: (x) => bootOrder(x).join(', ') || t('Default'), dialog: <BootOrderDialog {...p} /> },
      flag('tablet', t('Tablet pointer'), t('Use a tablet for the pointer (absolute mouse position)'), true),
      { key: 'hotplug', label: t('Hotplug'), show: (x) => hotplugList(x).join(', ') || t('Off'), dialog: <HotplugDialog {...p} /> },
      flag('acpi', 'ACPI', t('ACPI support'), true),
      flag('kvm', 'KVM', t('KVM hardware virtualization'), true, t('Off only for nested setups without virtualization support.')),
      flag('localtime', t('Local time'), t('Use local time for the real-time clock'), false, t('Windows guests expect it.')),
      flag('freeze', t('Freeze CPU at start'), t('Freeze the CPU at start (start it from the monitor)')),
      { key: 'agent', label: t('QEMU guest agent'), show: (x) => (isOn(getProp(parseProps(x ?? '', 'enabled'), 'enabled')) ? t('Enabled') : t('Off')), dialog: <AgentDialog {...p} /> },
    );
  } else {
    rows.push(
      { key: 'unprivileged', label: t('Unprivileged container'), show: (x) => yesNo(isOn(x)), dialog: null, locked: true },
      { key: 'features', label: t('Features'), show: (x) => featuresText(x), dialog: <FeaturesDialog {...p} /> },
      { key: 'cmode', label: t('Console mode'), show: (x) => CMODES.find((o) => o.value === (x ?? 'tty'))?.label ?? x, dialog: <SelectDialog {...p} cfgKey="cmode" title={t('Edit console mode')} label={t('Console mode of {name}', { name })} fieldLabel={t('Console mode')} options={CMODES} /> },
      {
        key: 'tty',
        label: t('TTYs'),
        show: (x) => x ?? '2',
        dialog: <TextDialog {...p} cfgKey="tty" title={t('Edit TTYs')} label={t('TTYs of {name}', { name })} fieldLabel={t('TTYs')} hint={t('0 to 6; empty: 2')} validate={(x) => checkNumber(x, { min: 0, max: 6 }).error} />,
      },
      {
        key: 'timezone',
        label: t('Time zone'),
        show: (x) => x ?? t('The host’s'),
        dialog: <TextDialog {...p} cfgKey="timezone" title={t('Edit time zone')} label={t('Time zone of {name}', { name })} fieldLabel={t('Time zone')} hint={t('For example Europe/Amsterdam, or host; empty: the host’s')} mono />,
      },
    );
  }
  rows.push(
    flag('protection', t('Protection'), t('Protect from deletion'), false, t('Proxmox refuses to delete the guest or its disks while this is on.')),
    {
      key: 'description',
      label: t('Notes'),
      show: (x) => (x ? <span className="guest-notes">{x.length > 160 ? `${x.slice(0, 160)}…` : x}</span> : t('None')),
      dialog: <TextDialog {...p} cfgKey="description" title={t('Edit notes')} label={t('Notes of {name}', { name })} fieldLabel={t('Notes')} hint={t('Plain text; Proxmox shows it on the guest’s summary too.')} multiline />,
    },
    { key: 'tags', label: t('Tags'), show: (x) => <TagChips tags={parseTags(x)} />, dialog: <TagsDialog {...p} /> },
  );

  const shown = open ? rows.find((r) => r.key === open) : null;
  return (
    <div className="section guest-tab">
      <PendingBanner serverId={serverId} guest={guest} config={cfg} />
      <CfgCard title={t('Options')} id="cfg-options">
        {rows.map((r) => {
          const rv = rowValue(cfg, r.key);
          const locked = r.locked || restricted.has(r.key);
          return (
            <CfgRow
              key={r.key}
              label={r.label}
              muted={rv.value === undefined}
              next={rv.next === undefined ? undefined : rv.removed ? '' : r.show(rv.next)}
              actions={locked ? <LockNote platform="Proxmox" /> : <EditButton what={r.label} onClick={() => setOpen(r.key)} />}
            >
              {r.show(v[r.key])}
            </CfgRow>
          );
        })}
      </CfgCard>
      <HARow {...props} />
      {shown?.dialog}
    </div>
  );
}

function TagChips({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="ink-3">{t('None')}</span>;
  return (
    <span className="tag-list">
      {tags.map((x) => (
        <Chip key={x} className="chip-sm chip-solid">
          {x}
        </Chip>
      ))}
    </span>
  );
}

function featuresText(v: string | undefined): string {
  const items = parseProps(v ?? '');
  const on = (['nesting', 'keyctl', 'fuse'] as const).filter((k) => isOn(getProp(items, k)));
  const other = items.filter((x) => !['nesting', 'keyctl', 'fuse'].includes(x.key)).map((x) => `${x.key}=${x.value}`);
  return [...on, ...other].join(', ') || t('None');
}

// ---------------------------------------------------------------- dialogs

function StartupDialog({ ctx, onClose }: DialogProps) {
  const cur = current(ctx.config, 'startup') ?? '';
  const items = parseProps(cur);
  const [order, setOrder] = useState(getProp(items, 'order') ?? '');
  const [up, setUp] = useState(getProp(items, 'up') ?? '');
  const [down, setDown] = useState(getProp(items, 'down') ?? '');
  const o = checkNumber(order, { min: 0, optional: true });
  const u = checkNumber(up, { min: 0, optional: true });
  const d = checkNumber(down, { min: 0, optional: true });
  const value = editProps(cur, { order: order.trim() || undefined, up: up.trim() || undefined, down: down.trim() || undefined });
  const draft = o.error || u.error || d.error ? null : draftOf({ startup: value || undefined });
  return (
    <EditDialog ctx={ctx} title={t('Edit start and shutdown order')} description={t('Guests start in ascending order and shut down in the reverse order. Empty fields use the defaults.')} label={t('Start order of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <div className="form-grid">
            <TextField label={t('Order')} inputMode="numeric" value={order} placeholder={t('any')} onChange={(e) => setOrder(e.target.value)} error={o.error ?? undefined} autoFocus />
            <TextField label={t('Start delay (s)')} inputMode="numeric" value={up} placeholder="0" onChange={(e) => setUp(e.target.value)} hint={t('Wait before the next guest starts')} error={u.error ?? undefined} />
            <TextField label={t('Shutdown timeout (s)')} inputMode="numeric" value={down} placeholder="180" onChange={(e) => setDown(e.target.value)} error={d.error ?? undefined} />
          </div>
          <KeyErrors errors={errors} keys={['startup']} />
        </>
      )}
    </EditDialog>
  );
}

/** Boot devices in order: enabled ones first; checkboxes and Move up / Move down buttons (keyboard and screen readers). */
function BootOrderDialog({ ctx, onClose }: DialogProps) {
  const cfg = ctx.config;
  const cur = current(cfg, 'boot');
  const enabled0 = bootOrder(cur);
  const devices = [...keysOf(cfg, DISK_RE), ...keysOf(cfg, /^net\d+$/)].sort(keyOrder);
  const [list, setList] = useState<{ key: string; on: boolean }[]>(() => [
    ...enabled0.filter((k) => devices.includes(k)).map((key) => ({ key, on: true })),
    ...devices.filter((k) => !enabled0.includes(k)).map((key) => ({ key, on: false })),
  ]);
  const move = (i: number, by: number) =>
    setList((l) => {
      const j = i + by;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const order = list.filter((x) => x.on).map((x) => x.key);
  const same = order.join(';') === enabled0.join(';');
  const draft = same ? {} : draftOf({ boot: withBootOrder(cur, order) });
  const what = (k: string) => {
    const val = current(cfg, k);
    if (/^net/.test(k)) return getProp(parseProps(val ?? ''), 'bridge') ?? '';
    return isCdrom(val) ? t('CD/DVD · {file}', { file: diskFile(val) }) : diskFile(val);
  };
  return (
    <EditDialog ctx={ctx} title={t('Edit boot order')} description={t('The guest tries the checked devices from the top.')} label={t('Boot order of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <ol className="plain-list boot-list" aria-label={t('Boot devices')}>
            {list.map((x, i) => (
              <li key={x.key} className="boot-item">
                <label className="check-row">
                  <input type="checkbox" checked={x.on} onChange={(e) => setList((l) => l.map((y) => (y.key === x.key ? { ...y, on: e.target.checked } : y)))} />
                  <span className="mono strong">{x.key}</span>
                  <span className="ellipsis lbl">{what(x.key)}</span>
                </label>
                <span className="boot-moves">
                  <button type="button" className="btn-ghost btn-icon row-action" aria-label={t('Move {key} up', { key: x.key })} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="chevronUp" size={14} />
                  </button>
                  <button type="button" className="btn-ghost btn-icon row-action" aria-label={t('Move {key} down', { key: x.key })} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="chevronDown" size={14} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <KeyErrors errors={errors} keys={['boot']} />
        </>
      )}
    </EditDialog>
  );
}

function HotplugDialog({ ctx, onClose }: DialogProps) {
  const cur = current(ctx.config, 'hotplug');
  const was = hotplugList(cur);
  const [on, setOn] = useState<string[]>(was);
  const toggle = (k: string, v: boolean) => setOn((l) => (v ? [...l, k] : l.filter((x) => x !== k)));
  const sorted = HOTPLUG.filter((k) => on.includes(k));
  const isDefault = sorted.length === HOTPLUG_DEFAULT.length && HOTPLUG_DEFAULT.every((k) => on.includes(k));
  const same = sorted.join(',') === HOTPLUG.filter((k) => was.includes(k)).join(',');
  const draft = same ? {} : draftOf({ hotplug: isDefault ? undefined : sorted.length ? sorted.join(',') : '0' });
  const label: Record<(typeof HOTPLUG)[number], string> = { disk: t('Disks'), network: t('Network devices'), usb: 'USB', memory: t('Memory'), cpu: t('Processors') };
  return (
    <EditDialog ctx={ctx} title={t('Edit hotplug')} description={t('Devices the guest takes while it runs. Memory and processors need NUMA and guest support.')} label={t('Hotplug of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <div className="check-grid">
            {HOTPLUG.map((k) => (
              <CheckRow key={k} label={label[k]} checked={on.includes(k)} onChange={(v) => toggle(k, v)} />
            ))}
          </div>
          <KeyErrors errors={errors} keys={['hotplug']} />
        </>
      )}
    </EditDialog>
  );
}

function AgentDialog({ ctx, onClose }: DialogProps) {
  const cur = current(ctx.config, 'agent') ?? '';
  const items = parseProps(cur, 'enabled');
  const on0 = isOn(getProp(items, 'enabled'));
  const trim0 = isOn(getProp(items, 'fstrim_cloned_disks'));
  const [on, setOn] = useState(on0);
  const [trim, setTrim] = useState(trim0);
  const ch: Record<string, string | undefined> = {};
  if (on !== on0) ch.enabled = on ? '1' : '0';
  if (trim !== trim0) ch.fstrim_cloned_disks = flagValue(trim);
  // An empty value starts with the bare enabled flag ("1,fstrim_cloned_disks=1").
  const value = cur ? editProps(cur, ch, 'enabled') : [on ? '1' : '0', ...(trim ? ['fstrim_cloned_disks=1'] : [])].join(',');
  const draft = !Object.keys(ch).length ? {} : draftOf({ agent: value });
  return (
    <EditDialog ctx={ctx} title={t('Edit QEMU guest agent')} label={t('Guest agent of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <CheckRow label={t('Use the QEMU guest agent')} hint={t('the agent must run inside the guest')} checked={on} onChange={setOn} />
          <CheckRow label={t('Trim disks after a move or clone')} checked={trim} onChange={setTrim} />
          <KeyErrors errors={errors} keys={['agent']} />
        </>
      )}
    </EditDialog>
  );
}

function FeaturesDialog({ ctx, onClose }: DialogProps) {
  const cur = current(ctx.config, 'features') ?? '';
  const items = parseProps(cur);
  const was = { nesting: isOn(getProp(items, 'nesting')), keyctl: isOn(getProp(items, 'keyctl')), fuse: isOn(getProp(items, 'fuse')) };
  const [f, setF] = useState(was);
  const ch: Record<string, string | undefined> = {};
  for (const k of ['nesting', 'keyctl', 'fuse'] as const) if (f[k] !== was[k]) ch[k] = flagValue(f[k]);
  const value = editProps(cur, ch);
  const draft = !Object.keys(ch).length ? {} : draftOf({ features: value || undefined });
  return (
    <EditDialog ctx={ctx} title={t('Edit features')} label={t('Features of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <CheckRow label={t('Nesting')} hint={t('containers or systemd services inside the container')} checked={f.nesting} onChange={(v) => setF({ ...f, nesting: v })} />
          <CheckRow label="keyctl" hint={t('for Docker inside an unprivileged container')} checked={f.keyctl} onChange={(v) => setF({ ...f, keyctl: v })} />
          <CheckRow label="FUSE" hint={t('file systems in user space')} checked={f.fuse} onChange={(v) => setF({ ...f, fuse: v })} />
          <KeyErrors errors={errors} keys={['features']} />
        </>
      )}
    </EditDialog>
  );
}

/** Tags as chips: type and press Enter (or ","), remove with the chip's button; stored separated by ";". */
function TagsDialog({ ctx, onClose }: DialogProps) {
  const was = parseTags(current(ctx.config, 'tags'));
  const [tags, setTags] = useState(was);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = (raw: string) => {
    const next = raw.split(/[;,\s]+/).filter(Boolean);
    const e = next.map(tagError).find(Boolean);
    if (e) return setErr(e);
    setTags((l) => [...l, ...next.filter((x) => !l.some((y) => y.toLowerCase() === x.toLowerCase()))]);
    setErr(null);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && text.trim()) {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && !text && tags.length) setTags((l) => l.slice(0, -1));
  };
  // A tag still in the field counts too (Review without pressing Enter).
  const pendingText = text.trim() ? text.split(/[;,\s]+/).filter(Boolean) : [];
  const pendingErr = pendingText.map(tagError).find(Boolean) ?? null;
  const all = [...tags, ...pendingText.filter((x) => !tags.some((y) => y.toLowerCase() === x.toLowerCase()))];
  const same = formatTags(all) === formatTags(was);
  const draft = pendingErr ? null : same ? {} : draftOf({ tags: all.length ? formatTags(all) : undefined });
  return (
    <EditDialog ctx={ctx} title={t('Edit tags')} label={t('Tags of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          {tags.length > 0 && (
            <ul className="plain-list tag-list" aria-label={t('Tags')}>
              {tags.map((x) => (
                <li key={x}>
                  <span className="chip chip-solid tag-edit">
                    {x}
                    <button type="button" className="tag-x" aria-label={t('Remove tag {tag}', { tag: x })} onClick={() => setTags((l) => l.filter((y) => y !== x))}>
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Field label={t('Add a tag')} hint={tn(tags.length, 'Press Enter to add it. {n} tag.', 'Press Enter to add it. {n} tags.')} error={errors.tags ?? err ?? pendingErr ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={text}
                autoComplete="off"
                spellCheck={false}
                placeholder="prod"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => {
                  setText(e.target.value);
                  setErr(null);
                }}
                onKeyDown={onKey}
                autoFocus
              />
            )}
          </Field>
        </>
      )}
    </EditDialog>
  );
}
