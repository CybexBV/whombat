/**
 * A guest's Options (ported from Rackoon's `OptionsTab` and `HARow`): its name, starting with the server (order,
 * delay, shutdown timeout), the OS type, for VMs the tablet pointer, hotplug, ACPI, KVM, local time, freeze at start
 * and the guest agent with its settings, for containers the features, console mode, TTYs, time zone and whether it
 * is unprivileged (locked), protection, notes and tags as chips — each changed through the review — and high
 * availability on a cluster. Keys only Proxmox changes carry its lock.
 */
import {
  type AgentOpts,
  addTags,
  CONSOLE_MODES,
  type CtFeature,
  checkNumber,
  currentValue,
  featuresWords,
  flagValue,
  formatHotplug,
  formatTags,
  HOTPLUG,
  HOTPLUG_WORDS,
  hotplugList,
  isOn,
  isRestricted,
  laterWords,
  localTimeDefault,
  OS_TYPES,
  optionLabel,
  parseTags,
  readAgent,
  readFeatures,
  readStartup,
  rowValue,
  startupWords,
  writeAgent,
  writeFeatures,
  writeStartup,
} from '@whombat/client/hosts';
import type { HostGuestDetail } from '@whombat/core/domain';
import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Check, Field, SelectField, TextField } from '../manage/fields';
import { Card, Tags } from '../parts';
import styles from '../Things.module.css';
import { type EditCtx, EditDialog } from './EditDialog';
import { EditBtn, KeyErrors, platformName, Row } from './editParts';
import wa from './GuestEdit.module.css';
import { HACard } from './HACard';
import { SelectKeyDialog } from './hardwareDialogs';

const NAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const yesNo = (on: boolean) => (on ? 'Yes' : 'No');

/** One option row: its key, how its value reads, the dialog that changes it (none: shown locked). */
interface Spec {
  key: string;
  title: string;
  show: (v: string | undefined) => string;
  dialog?: ReactNode;
  /** Keys whose pending values the row reads too. */
  keys?: string[];
  sub?: string;
  rich?: (v: string | undefined) => ReactNode;
}

export function OptionsTab({ ctx }: { ctx: EditCtx; guest: HostGuestDetail }) {
  const [open, setOpen] = useState<string | null>(null);
  const cfg = ctx.config;
  const vm = cfg.kind === 'vm';
  const v = cfg.values;
  const name = ctx.guest.name;
  const platform = platformName(cfg);
  const close = () => setOpen(null);
  const p = { ctx, onClose: close };
  const flag = (
    key: string,
    title: string,
    label: string,
    defaultOn = false,
    description?: string,
  ): Spec => ({
    key,
    title,
    show: (x) => yesNo(isOn(x, defaultOn)),
    dialog: (
      <FlagDialog
        {...p}
        k={key}
        title={`${title} of ${name}`}
        label={label}
        defaultOn={defaultOn}
        description={description}
      />
    ),
  });
  const nameKey = vm ? 'name' : 'hostname';
  const rows: Spec[] = [
    {
      key: nameKey,
      title: vm ? 'Name' : 'Hostname',
      show: (x) => x ?? name,
      dialog: (
        <TextKeyDialog
          {...p}
          k={nameKey}
          label={vm ? 'Name' : 'Hostname'}
          required
          check={(s) => (NAME_RE.test(s) ? null : 'Letters, digits, dots and dashes.')}
        />
      ),
    },
    {
      key: 'onboot',
      keys: ['onboot', 'startup'],
      title: 'Start with the server',
      show: (x) => yesNo(isOn(x)),
      sub: v.startup ? startupWords(v.startup) : undefined,
      dialog: <StartupDialog {...p} />,
    },
    vm
      ? {
          key: 'ostype',
          title: 'OS type',
          show: (x) => optionLabel(OS_TYPES, x ?? 'other'),
          dialog: (
            <SelectKeyDialog
              {...p}
              k="ostype"
              title={`OS type of ${name}`}
              label="OS type"
              options={OS_TYPES}
              read={(x) => x ?? 'other'}
              write={(x) => x}
              hint={() => 'Proxmox tunes a few settings for it (the clock, the pointer, drivers).'}
            />
          ),
        }
      : { key: 'ostype', title: 'OS type', show: (x) => x ?? 'Unknown' },
  ];
  if (vm)
    rows.push(
      flag('tablet', 'Tablet pointer', 'Use a tablet pointer, so the mouse lines up in the console', true),
      {
        key: 'hotplug',
        title: 'Hotplug',
        show: (x) =>
          hotplugList(x)
            .map((k) => HOTPLUG_WORDS[k as keyof typeof HOTPLUG_WORDS] ?? k)
            .join(', ') || 'Off',
        dialog: <HotplugDialog {...p} />,
      },
      flag('acpi', 'ACPI', 'Let it switch itself off cleanly (ACPI)', true),
      flag(
        'kvm',
        'Virtualization',
        'Use KVM hardware virtualization',
        true,
        'Turn it off only for setups inside another VM without virtualization.',
      ),
      flag(
        'localtime',
        'Clock in local time',
        'Keep the clock in local time',
        localTimeDefault(v.ostype),
        'Windows expects it.',
      ),
      flag('freeze', 'Paused at start', 'Start it paused (resume it from the console)'),
      {
        key: 'agent',
        title: 'Guest agent',
        show: (x) => agentWords(x),
        sub: 'Lets Proxmox shut it down cleanly and see its addresses.',
        dialog: <AgentDialog {...p} />,
      },
    );
  else
    rows.push(
      { key: 'unprivileged', title: 'Unprivileged', show: (x) => yesNo(isOn(x)) },
      { key: 'features', title: 'Features', show: featuresWords, dialog: <FeaturesDialog {...p} /> },
      {
        key: 'cmode',
        title: 'Console mode',
        show: (x) => optionLabel(CONSOLE_MODES, x ?? 'tty'),
        dialog: (
          <SelectKeyDialog
            {...p}
            k="cmode"
            title={`Console mode of ${name}`}
            label="Console mode"
            options={CONSOLE_MODES}
          />
        ),
      },
      {
        key: 'tty',
        title: 'TTYs',
        show: (x) => x ?? '2',
        dialog: (
          <TextKeyDialog
            {...p}
            k="tty"
            label="TTYs"
            hint="0 to 6. Empty: 2."
            check={(s) => checkNumber(s, { min: 0, max: 6 }).error}
          />
        ),
      },
      {
        key: 'timezone',
        title: 'Time zone',
        show: (x) => x ?? 'The server’s',
        dialog: (
          <TextKeyDialog
            {...p}
            k="timezone"
            label="Time zone"
            mono
            hint="Like Europe/Amsterdam, or host. Empty: the server’s."
            check={(s) =>
              /^(host|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*)$/.test(s) ? null : 'Like Europe/Amsterdam.'
            }
          />
        ),
      },
    );
  rows.push(
    {
      key: 'protection',
      title: 'Protection',
      show: (x) => (isOn(x) ? 'Can’t be deleted' : 'Off'),
      dialog: (
        <FlagDialog
          {...p}
          k="protection"
          title={`Protection of ${name}`}
          label="Protect it from being deleted"
          description="Proxmox refuses to delete it or its disks while this is on."
        />
      ),
    },
    {
      key: 'tags',
      title: 'Tags',
      show: (x) => parseTags(x).join(', ') || 'None',
      rich: (x) => (parseTags(x).length ? <Tags tags={parseTags(x)} /> : 'None'),
      dialog: <TagsDialog {...p} />,
    },
    {
      key: 'description',
      title: 'Notes',
      show: (x) => (x ? (x.length > 60 ? `${x.slice(0, 60)}…` : x) : 'None'),
      rich: (x) => (x ? <span style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{x}</span> : 'None'),
      dialog: (
        <TextKeyDialog
          {...p}
          k="description"
          label="Notes"
          multiline
          hint="Plain text; Proxmox shows it on the guest’s summary too."
        />
      ),
    },
  );
  const shown = open ? rows.find((r) => r.key === open) : undefined;
  return (
    <>
      <Card title="Options">
        <div className={styles.rows}>
          {rows.map((r) => {
            const keys = r.keys ?? [r.key];
            const locked = keys.some((k) => isRestricted(cfg, k)) || !r.dialog;
            const rv = rowValue(cfg, r.key);
            const next =
              keys.length > 1
                ? laterWords(
                    cfg,
                    keys,
                    (x) => `${r.show(x[r.key])}${x.startup ? ` · ${startupWords(x.startup)}` : ''}`,
                  )
                : rv.next === undefined
                  ? undefined
                  : r.show(rv.removed ? undefined : rv.next);
            return (
              <Row
                key={r.key}
                title={r.title}
                value={r.rich ? r.rich(v[r.key]) : r.show(v[r.key])}
                mono={r.key === nameKey || r.key === 'timezone'}
                muted={
                  v[r.key] === undefined && !['onboot', 'protection', 'tags', 'description'].includes(r.key)
                }
                next={next}
                sub={r.sub}
                locked={locked ? platform : undefined}
                action={<EditBtn label={r.title.toLowerCase()} onClick={() => setOpen(r.key)} />}
              />
            );
          })}
        </div>
      </Card>
      <HACard ctx={ctx} />
      {shown?.dialog ?? null}
    </>
  );
}

function agentWords(x: string | undefined): string {
  const a = readAgent(x);
  if (!a.enabled) return 'Off';
  return ['On', a.fstrim ? 'trims disks after a move or clone' : '', a.type === 'isa' ? 'ISA channel' : '']
    .filter(Boolean)
    .join(' · ');
}

interface DialogProps {
  ctx: EditCtx;
  onClose: () => void;
}

/** One text key (a name, notes, a time zone). Empty removes it unless `required`. */
export function TextKeyDialog({
  ctx,
  k,
  label,
  multiline,
  mono,
  required,
  check,
  hint,
  onClose,
  encode = (s) => s,
  decode = (s) => s,
}: DialogProps & {
  k: string;
  label: string;
  multiline?: boolean;
  mono?: boolean;
  required?: boolean;
  check?: (s: string) => string | null;
  hint?: string;
  encode?: (s: string) => string;
  decode?: (s: string) => string;
}) {
  const initial = decode(currentValue(ctx.config, k) ?? '');
  const [value, setValue] = useState(initial);
  const next = multiline ? value.replace(/\s+$/, '') : value.trim();
  const error = !next ? (required ? 'Fill this in.' : null) : check ? check(next) : null;
  return (
    <EditDialog
      ctx={ctx}
      title={`${label} of ${ctx.guest.name}`}
      draft={error ? null : next === initial ? {} : next ? { set: { [k]: encode(next) } } : { delete: [k] }}
      onClose={onClose}
      wide={multiline}
    >
      {(errors) =>
        multiline ? (
          <Field label={label} hint={hint} error={errors[k]}>
            {(f) => (
              <textarea
                className={styles.input}
                rows={6}
                value={value}
                style={{ fontFamily: 'var(--font-sans)', fontSize: 14.5 }}
                onChange={(e) => setValue(e.target.value)}
                {...f}
              />
            )}
          </Field>
        ) : (
          <TextField
            label={label}
            value={value}
            mono={mono}
            autoFocus
            error={error ?? errors[k]}
            hint={hint}
            onChange={(e) => setValue(e.target.value)}
          />
        )
      }
    </EditDialog>
  );
}

/** A flag; Proxmox's default is written by leaving the key out. */
export function FlagDialog({
  ctx,
  k,
  title,
  label,
  defaultOn = false,
  description,
  onClose,
}: DialogProps & { k: string; title: string; label: string; defaultOn?: boolean; description?: string }) {
  const initial = isOn(currentValue(ctx.config, k), defaultOn);
  const [on, setOn] = useState(initial);
  return (
    <EditDialog
      ctx={ctx}
      title={title}
      description={description}
      draft={
        on === initial
          ? {}
          : {
              ...(flagValue(on, defaultOn) === undefined
                ? { delete: [k] }
                : { set: { [k]: flagValue(on, defaultOn) as string } }),
            }
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <Check label={label} checked={on} onChange={setOn} />
          <KeyErrors errors={errors} keys={[k]} />
        </>
      )}
    </EditDialog>
  );
}

function StartupDialog({ ctx, onClose }: DialogProps) {
  const cur = currentValue(ctx.config, 'startup');
  const [on, setOn] = useState(isOn(currentValue(ctx.config, 'onboot')));
  const [s, setS] = useState(() => readStartup(cur));
  const o = checkNumber(s.order, { min: 0, optional: true });
  const u = checkNumber(s.up, { min: 0, optional: true });
  const d = checkNumber(s.down, { min: 0, optional: true });
  const startup = writeStartup(cur, s);
  return (
    <EditDialog
      ctx={ctx}
      title={`Start ${ctx.guest.name} with the server`}
      description="Guests start in turn, lowest first, and shut down the other way round. Empty fields use Proxmox’s defaults."
      draft={
        o.error || u.error || d.error
          ? null
          : {
              set: {
                ...(flagValue(on) !== undefined ? { onboot: '1' } : {}),
                ...(startup ? { startup } : {}),
              },
              delete: [...(flagValue(on) === undefined ? ['onboot'] : []), ...(startup ? [] : ['startup'])],
            }
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          <Check label="Start it when the server starts" checked={on} onChange={setOn} />
          <div className={styles.formRow}>
            <TextField
              label="In turn"
              inputMode="numeric"
              value={s.order}
              placeholder="Any"
              error={o.error ?? errors.startup}
              onChange={(e) => setS({ ...s, order: e.target.value })}
            />
            <TextField
              label="Then wait (s)"
              inputMode="numeric"
              value={s.up}
              placeholder="0"
              error={u.error}
              hint="Before the next one starts."
              onChange={(e) => setS({ ...s, up: e.target.value })}
            />
            <TextField
              label="Shutdown timeout (s)"
              inputMode="numeric"
              value={s.down}
              placeholder="180"
              error={d.error}
              hint="Then it’s stopped."
              onChange={(e) => setS({ ...s, down: e.target.value })}
            />
          </div>
          <KeyErrors errors={errors} keys={['onboot']} />
        </>
      )}
    </EditDialog>
  );
}

function HotplugDialog({ ctx, onClose }: DialogProps) {
  const cur = currentValue(ctx.config, 'hotplug');
  const was = hotplugList(cur);
  const [on, setOn] = useState<string[]>(was);
  const same = HOTPLUG.filter((k) => on.includes(k)).join() === HOTPLUG.filter((k) => was.includes(k)).join();
  const next = formatHotplug(on);
  return (
    <EditDialog
      ctx={ctx}
      title={`Hotplug of ${ctx.guest.name}`}
      description="What it takes while it runs. Memory and processors also need NUMA and the guest’s support."
      draft={same ? {} : next === undefined ? { delete: ['hotplug'] } : { set: { hotplug: next } }}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <div className={wa.waChecks}>
            {HOTPLUG.map((k) => (
              <Check
                key={k}
                label={HOTPLUG_WORDS[k]}
                checked={on.includes(k)}
                onChange={(x) => setOn(x ? [...on, k] : on.filter((y) => y !== k))}
              />
            ))}
          </div>
          <KeyErrors errors={errors} keys={['hotplug']} />
        </>
      )}
    </EditDialog>
  );
}

/** The guest agent and its settings; every other setting of the key stays (PX-08). */
function AgentDialog({ ctx, onClose }: DialogProps) {
  const cur = currentValue(ctx.config, 'agent');
  const [was] = useState(() => readAgent(cur));
  const [a, setA] = useState<AgentOpts>(was);
  const changed = JSON.stringify(a) !== JSON.stringify(was);
  const next = writeAgent(cur, a, was);
  return (
    <EditDialog
      ctx={ctx}
      title={`Guest agent of ${ctx.guest.name}`}
      description="Proxmox’s helper (the QEMU guest agent) has to be installed and running inside the machine."
      draft={!changed ? {} : next === undefined ? { delete: ['agent'] } : { set: { agent: next } }}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <Check
            label="Use the guest agent"
            checked={a.enabled}
            onChange={(enabled) => setA({ ...a, enabled })}
          />
          <Check
            label="Trim its disks after a move or clone"
            checked={a.fstrim}
            onChange={(fstrim) => setA({ ...a, fstrim })}
          />
          <Check
            label="Pause its file systems during a backup"
            checked={a.freezeFs}
            onChange={(freezeFs) => setA({ ...a, freezeFs })}
          />
          <SelectField
            label="Channel"
            options={[
              { value: '', label: 'VirtIO (default)' },
              { value: 'isa', label: 'ISA' },
            ]}
            value={a.type}
            onChange={(e) => setA({ ...a, type: e.target.value })}
          />
          <KeyErrors errors={errors} keys={['agent']} />
        </>
      )}
    </EditDialog>
  );
}

const FEATURE_WORDS: Record<CtFeature, ReactNode> = {
  nesting: 'Nesting · containers or systemd services inside it',
  keyctl: 'keyctl · for Docker in an unprivileged container',
  fuse: 'FUSE · file systems in user space',
};

/** Nesting, keyctl and FUSE; other features (`mount=nfs`) stay as they are. */
function FeaturesDialog({ ctx, onClose }: DialogProps) {
  const cur = currentValue(ctx.config, 'features');
  const [was] = useState(() => readFeatures(cur));
  const [f, setF] = useState(was);
  const changed = JSON.stringify(f) !== JSON.stringify(was);
  const next = writeFeatures(cur, f, was);
  return (
    <EditDialog
      ctx={ctx}
      title={`Features of ${ctx.guest.name}`}
      draft={!changed ? {} : next === undefined ? { delete: ['features'] } : { set: { features: next } }}
      onClose={onClose}
    >
      {(errors) => (
        <>
          {(Object.keys(FEATURE_WORDS) as CtFeature[]).map((k) => (
            <Check key={k} label={FEATURE_WORDS[k]} checked={f[k]} onChange={(x) => setF({ ...f, [k]: x })} />
          ))}
          <KeyErrors errors={errors} keys={['features']} />
        </>
      )}
    </EditDialog>
  );
}

/** Tags as chips: type one and press Enter (or “,”), remove one with its ×; stored as Proxmox's “a;b” list. */
function TagsDialog({ ctx, onClose }: DialogProps) {
  const was = parseTags(currentValue(ctx.config, 'tags'));
  const [tags, setTags] = useState(was);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const out = addTags(tags, text);
    setError(out.error);
    if (!out.error) {
      setTags(out.tags);
      setText('');
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && text.trim()) {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && tags.length) setTags(tags.slice(0, -1));
  };
  // A tag still in the field counts too (Review without pressing Enter).
  const typed = addTags(tags, text);
  const all = typed.error ? tags : typed.tags;
  const same = formatTags(all) === formatTags(was);
  return (
    <EditDialog
      ctx={ctx}
      title={`Tags of ${ctx.guest.name}`}
      draft={
        typed.error
          ? null
          : same
            ? {}
            : all.length
              ? { set: { tags: formatTags(all) } }
              : { delete: ['tags'] }
      }
      onClose={onClose}
    >
      {(errors) => (
        <>
          {tags.length ? (
            <ul className={wa.waChips} aria-label="Tags">
              {tags.map((t) => (
                <li key={t} className={wa.waChip}>
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                  >
                    <Icon icon={X} size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Field
            label="Add a tag"
            hint={`Press Enter to add it. ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}.`}
            error={errors.tags ?? error ?? typed.error}
          >
            {(f) => (
              <input
                className={styles.input}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5 }}
                value={text}
                autoComplete="off"
                spellCheck={false}
                placeholder="prod"
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
                onKeyDown={onKey}
                {...f}
              />
            )}
          </Field>
        </>
      )}
    </EditDialog>
  );
}
