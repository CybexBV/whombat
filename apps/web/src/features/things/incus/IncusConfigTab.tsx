/**
 * An Incus instance's Configuration (Whombat incus-unraid.md IU-04; AP-1563, AP-1564): the settings Whombat changes as
 * groups — Resources, Boot, Security, Snapshots, Notes, then Profiles — the instance's own `user.*` keys as a small
 * key/value list, and everything else as it is, the keys only Incus changes locked (“Change this with the incus
 * command”). Every change goes through the review (`key  old → new`) and is sent with the digest it was reviewed on.
 * A key that comes from a profile says so: the instance can set its own value but not remove the profile's. The guest
 * this Whombat runs in shows its settings without a way to change them (IU-02).
 */
import {
  type ConfigDraft,
  currentValue,
  EXPIRY_PRESETS,
  expiryError,
  fieldError,
  fieldWords,
  groupFields,
  INCUS_GROUPS,
  INCUS_LOCK_WORDS,
  type IncusField,
  incusOn,
  incusOtherKeys,
  isInherited,
  isRestricted,
  isSelfGuest,
  presetOf,
  SCHEDULE_PRESETS,
  scheduleError,
  scheduleWords,
  userKeyError,
  userKeys,
} from '@whombat/client/hosts';
import type { HostGuestDetail } from '@whombat/core/domain';
import { Lock, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { type EditCtx, EditDialog, ReviewList } from '../guest/EditDialog';
import { EditBtn, KeyErrors, Row } from '../guest/editParts';
import { Check, Field, FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Card, Empty } from '../parts';
import styles from '../Things.module.css';
import wi from './Incus.module.css';
import { useIncusChoices } from './IncusDialogs';

/** The lock on a key only Incus changes. */
export function IncusLock() {
  return (
    <span className={wi.wiLock}>
      <Icon icon={Lock} size={13} />
      {INCUS_LOCK_WORDS}
    </span>
  );
}

const SCHEDULE_KEYS = ['snapshots.schedule', 'snapshots.expiry', 'snapshots.pattern'];

export function IncusConfigTab({ ctx, guest }: { ctx: EditCtx; guest: HostGuestDetail }) {
  const [open, setOpen] = useState<string | null>(null);
  const cfg = ctx.config;
  const self = isSelfGuest(guest);
  const close = () => setOpen(null);
  const field = INCUS_GROUPS.flatMap((g) => g.fields).find((f) => f.key === open);
  return (
    <>
      {INCUS_GROUPS.map((g) =>
        g.id === 'notes' ? (
          // The notes read as text, as on a Proxmox guest's Summary (`description`).
          <Card
            key={g.id}
            title="Notes"
            id="wi-group-notes"
            link={
              self || isRestricted(cfg, 'description') ? undefined : (
                <button
                  type="button"
                  className={styles.cardLink}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setOpen('description')}
                >
                  {cfg.values.description ? 'Edit' : 'Add'}
                  <span className={styles.srOnly}> notes</span>
                </button>
              )
            }
          >
            {cfg.values.description ? (
              <p className={wi.wiNotes}>{cfg.values.description}</p>
            ) : (
              <Empty>No notes yet. Incus shows them as its description.</Empty>
            )}
          </Card>
        ) : (
          <Card key={g.id} title={g.title} id={`wi-group-${g.id}`}>
            <div className={styles.rows}>
              {groupFields(g, cfg.kind).map((f) => (
                <FieldRow key={f.key} ctx={ctx} f={f} self={self} onChange={() => setOpen(f.key)} />
              ))}
            </div>
          </Card>
        ),
      )}
      <ProfilesCard ctx={ctx} self={self} onChange={() => setOpen('profiles')} />
      <UserKeys ctx={ctx} self={self} />
      <OtherKeys ctx={ctx} />
      {open === 'profiles' ? <ProfilesDialog ctx={ctx} onClose={close} /> : null}
      {field && SCHEDULE_KEYS.includes(field.key) ? <ScheduleDialog ctx={ctx} onClose={close} /> : null}
      {field && !SCHEDULE_KEYS.includes(field.key) ? (
        <FieldDialog ctx={ctx} f={field} onClose={close} />
      ) : null}
    </>
  );
}

function FieldRow({
  ctx,
  f,
  self,
  onChange,
}: {
  ctx: EditCtx;
  f: IncusField;
  self: boolean;
  onChange: () => void;
}) {
  const cfg = ctx.config;
  const v = cfg.values[f.key];
  const locked = isRestricted(cfg, f.key);
  const notes = f.kind === 'notes';
  return (
    <Row
      title={f.label}
      value={
        notes && v ? <span style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{v}</span> : fieldWords(f, v)
      }
      mono={f.kind === 'text' && !!v}
      muted={v === undefined || v === ''}
      sub={isInherited(cfg, f.key) ? 'From a profile' : undefined}
      action={
        locked ? (
          <IncusLock />
        ) : self ? undefined : (
          <EditBtn label={f.label.toLowerCase()} text={v ? 'Change' : 'Set'} onClick={onChange} />
        )
      }
    />
  );
}

interface DialogProps {
  ctx: EditCtx;
  onClose: () => void;
}

/** What emptying a field does: remove the instance's own value; a profile's value can't be removed here. */
function emptied(ctx: EditCtx, key: string): ConfigDraft | null {
  const cur = currentValue(ctx.config, key);
  if (cur === undefined) return {};
  return isInherited(ctx.config, key) ? null : { delete: [key] };
}

/** One setting of a group: a number, a size, a yes or no, a text, the notes. */
function FieldDialog({ ctx, f, onClose }: DialogProps & { f: IncusField }) {
  const cur = currentValue(ctx.config, f.key) ?? '';
  const inherited = isInherited(ctx.config, f.key);
  const tri = f.key === 'boot.autostart';
  const boolDefault = f.unset === f.on;
  const [value, setValue] = useState(
    f.kind === 'bool' ? (tri ? (cur ? String(incusOn(cur)) : '') : String(incusOn(cur, boolDefault))) : cur,
  );
  const next = f.kind === 'notes' ? value.replace(/\s+$/, '') : value.trim();
  const error = f.kind === 'bool' ? null : next ? fieldError(f, next) : null;
  let draft: ConfigDraft | null;
  if (error) draft = null;
  else if (f.kind === 'bool' && !tri)
    draft = String(incusOn(cur, boolDefault)) === next ? {} : { set: { [f.key]: next } };
  else if (next === cur) draft = {};
  else if (!next) draft = emptied(ctx, f.key);
  else draft = { set: { [f.key]: next } };
  const fromProfile =
    !next && inherited && cur !== ''
      ? 'This comes from a profile, so it stays unless the profile changes.'
      : null;
  return (
    <EditDialog
      ctx={ctx}
      title={`${f.label} of ${ctx.guest.name}`}
      description={f.kind === 'bool' ? f.hint : undefined}
      draft={draft}
      onClose={onClose}
      wide={f.kind === 'notes'}
    >
      {(errors) =>
        f.kind === 'bool' ? (
          tri ? (
            <SelectField
              label={f.label}
              options={[
                { value: '', label: f.unset },
                { value: 'true', label: 'Yes' },
                { value: 'false', label: 'No' },
              ]}
              value={value}
              autoFocus
              error={errors[f.key]}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <>
              <Check
                label={`${f.label}: ${f.on ?? 'Yes'}`}
                checked={value === 'true'}
                onChange={(on) => setValue(String(on))}
              />
              <KeyErrors errors={errors} keys={[f.key]} />
            </>
          )
        ) : f.kind === 'notes' ? (
          <Field
            label="Notes"
            hint="Plain text; Incus shows it as the instance’s description."
            error={errors[f.key]}
          >
            {(p) => (
              <textarea
                className={styles.input}
                rows={6}
                value={value}
                style={{ fontFamily: 'var(--font-sans)', fontSize: 14.5 }}
                onChange={(e) => setValue(e.target.value)}
                {...p}
              />
            )}
          </Field>
        ) : (
          <TextField
            label={f.label}
            value={value}
            mono
            autoFocus
            inputMode={f.kind === 'int' || f.kind === 'seconds' ? 'numeric' : undefined}
            placeholder={f.unset}
            error={error ?? fromProfile ?? errors[f.key]}
            hint={f.hint ? `${f.hint}${inherited ? '' : ' Empty: as Incus has it.'}` : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
        )
      }
    </EditDialog>
  );
}

/**
 * The snapshot schedule (IU-04): how often, how long each is kept and what they're called, in one review. Opened from
 * Configuration's Snapshots group and the Snapshots tab (“Set a schedule”, the hint's way out).
 */
export function ScheduleDialog({ ctx, onClose }: DialogProps) {
  const cur = (k: string) => currentValue(ctx.config, k) ?? '';
  const [sched, setSched] = useState(cur('snapshots.schedule'));
  const [schedPreset, setSchedPreset] = useState(() =>
    presetOf(SCHEDULE_PRESETS, cur('snapshots.schedule') || ''),
  );
  const [expiry, setExpiry] = useState(cur('snapshots.expiry'));
  const [expPreset, setExpPreset] = useState(() => presetOf(EXPIRY_PRESETS, cur('snapshots.expiry') || ''));
  const [pattern, setPattern] = useState(cur('snapshots.pattern'));
  const sErr =
    schedPreset === 'custom'
      ? sched.trim()
        ? scheduleError(sched)
        : 'Type a schedule, like 0 3 * * *.'
      : null;
  const eErr =
    expPreset === 'custom' ? (expiry.trim() ? expiryError(expiry) : 'Type how long, like 10d.') : null;
  const pErr = /\s/.test(pattern.trim()) ? 'One word, no spaces.' : null;
  const want: Record<string, string> = {
    'snapshots.schedule': schedPreset === 'custom' ? sched.trim() : schedPreset,
    'snapshots.expiry': expPreset === 'custom' ? expiry.trim() : expPreset,
    'snapshots.pattern': pattern.trim(),
  };
  let draft: ConfigDraft | null = sErr || eErr || pErr ? null : { set: {}, delete: [] };
  let blocked: string | null = null;
  if (draft)
    for (const [k, v] of Object.entries(want)) {
      if (v === cur(k)) continue;
      if (v) (draft.set as Record<string, string>)[k] = v;
      else if (isInherited(ctx.config, k))
        blocked = 'A profile sets this; the instance can only set its own value.';
      else draft.delete?.push(k);
    }
  if (blocked) draft = null;
  return (
    <EditDialog
      ctx={ctx}
      title={`Snapshots of ${ctx.guest.name}`}
      description="Incus takes them on its own and removes them once they’re older than you keep them."
      draft={draft}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <div className={wi.wiPreset}>
            <SelectField
              label="Take one"
              options={SCHEDULE_PRESETS}
              value={schedPreset}
              autoFocus
              onChange={(e) => {
                setSchedPreset(e.target.value);
                if (e.target.value === 'custom' && !sched.trim()) setSched('0 3 * * *');
              }}
            />
            {schedPreset === 'custom' ? (
              <TextField
                label="Schedule (cron)"
                mono
                value={sched}
                error={sErr ?? errors['snapshots.schedule']}
                hint={sched.trim() && !sErr ? scheduleWords(sched) : 'minute hour day month weekday'}
                onChange={(e) => setSched(e.target.value)}
              />
            ) : (
              <span />
            )}
          </div>
          <div className={wi.wiPreset}>
            <SelectField
              label="Keep each"
              options={EXPIRY_PRESETS}
              value={expPreset}
              onChange={(e) => {
                setExpPreset(e.target.value);
                if (e.target.value === 'custom' && !expiry.trim()) setExpiry('10d');
              }}
            />
            {expPreset === 'custom' ? (
              <TextField
                label="For"
                mono
                value={expiry}
                error={eErr ?? errors['snapshots.expiry']}
                hint="M minutes, H hours, d days, w weeks, m months, y years."
                onChange={(e) => setExpiry(e.target.value)}
              />
            ) : (
              <span />
            )}
          </div>
          <TextField
            label="Names"
            mono
            value={pattern}
            placeholder="snap%d"
            error={pErr ?? errors['snapshots.pattern']}
            hint="%d becomes a number. Empty: snap0, snap1, …"
            onChange={(e) => setPattern(e.target.value)}
          />
          {blocked ? (
            <p className={styles.error} role="alert">
              {blocked}
            </p>
          ) : null}
        </>
      )}
    </EditDialog>
  );
}

/* Profiles ------------------------------------------------------------------------------------------- */

function ProfilesCard({ ctx, self, onChange }: { ctx: EditCtx; self: boolean; onChange: () => void }) {
  const list = ctx.config.profiles ?? [];
  return (
    <Card
      title="Profiles"
      meta="Later ones win"
      link={
        self ? undefined : (
          <button type="button" className={styles.cardLink} style={{ marginLeft: 'auto' }} onClick={onChange}>
            Change <span className={styles.srOnly}>profiles</span>
          </button>
        )
      }
    >
      <div style={{ padding: '2px 20px 16px' }}>
        {list.length ? (
          <ul
            className={wi.wiChips}
            aria-label="Profiles"
            style={{ margin: 0, padding: 0, listStyle: 'none' }}
          >
            {list.map((p) => (
              <li key={p} className={wi.wiChip}>
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <span className={styles.muted}>None: everything is set on the instance itself.</span>
        )}
      </div>
    </Card>
  );
}

/** Which profiles the instance uses, in order; reviewed and sent with the digest. */
function ProfilesDialog({ ctx, onClose }: DialogProps) {
  const choices = useIncusChoices(ctx.burrow, ctx.serverId);
  const now = ctx.config.profiles ?? [];
  const [picked, setPicked] = useState<string[]>(now);
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(ctx.burrow, ctx.serverId);
  const all = [...new Set([...now, ...(choices?.profiles ?? [])])];
  const same = picked.join(',') === now.join(',');
  return (
    <FormDialog
      title={`Profiles of ${ctx.guest.name}`}
      description={
        step === 'edit'
          ? 'Its settings and devices come from these, in this order; its own ones win.'
          : undefined
      }
      action={step === 'edit' ? 'Review' : busy ? 'Applying…' : 'Apply'}
      busy={busy}
      disabled={same}
      error={error}
      extra={
        step === 'review' ? (
          <Button onClick={() => setStep('edit')} disabled={busy} style={{ marginRight: 'auto' }}>
            Back
          </Button>
        ) : undefined
      }
      onClose={onClose}
      onSubmit={() => {
        if (step === 'edit') return setStep('review');
        void (async () => {
          setError(null);
          const out = await send({
            op: 'config.set',
            guestId: ctx.guest.id,
            params: { profiles: picked },
            digest: ctx.config.digest,
            name: ctx.guest.name,
          });
          if (out.ok) onClose();
          else setError(out.fields.profiles ?? out.message);
        })();
      }}
    >
      {step === 'edit' ? (
        <div className={wi.wiImages}>
          {all.map((p) => (
            <Check
              key={p}
              label={<span className={styles.mono}>{p}</span>}
              checked={picked.includes(p)}
              onChange={(on) => setPicked((x) => (on ? [...x, p] : x.filter((y) => y !== p)))}
            />
          ))}
        </div>
      ) : (
        <ReviewList
          rows={[
            {
              key: 'profiles',
              old: now.join(', ') || '(none)',
              new: picked.join(', ') || '(none)',
              op: 'set',
            },
          ]}
          restartNote={false}
        />
      )}
    </FormDialog>
  );
}

/* user.* ------------------------------------------------------------------------------------------- */

function UserKeys({ ctx, self }: { ctx: EditCtx; self: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const keys = userKeys(ctx.config.values);
  return (
    <Card
      title="Your own keys"
      meta="user.*"
      link={
        self ? undefined : (
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={Plus} size={14} />}
            onClick={() => setEdit('')}
          >
            Add a key
          </Button>
        )
      }
    >
      {keys.length ? (
        <div className={styles.rows}>
          {keys.map((k) => (
            <div key={k} className={styles.row}>
              <span className={wi.wiKey} title={k}>
                {k}
              </span>
              <span className={wi.wiRaw}>{ctx.config.values[k]}</span>
              {isInherited(ctx.config, k) ? <span className={wi.wiFrom}>From a profile</span> : null}
              {self ? null : (
                <span className={wi.wiActs}>
                  <EditBtn label={k} onClick={() => setEdit(k)} />
                  {isInherited(ctx.config, k) ? null : <RemoveKey ctx={ctx} k={k} />}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty>No user.* keys. Scripts and tools use them to note things on an instance.</Empty>
      )}
      {edit !== null ? <UserKeyDialog ctx={ctx} k={edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

function RemoveKey({ ctx, k }: { ctx: EditCtx; k: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`${styles.cardLink} ${wi.wiSerious}`}
        style={{ marginLeft: 0 }}
        onClick={() => setOpen(true)}
      >
        Remove <span className={styles.srOnly}>{k}</span>
      </button>
      {open ? (
        <EditDialog ctx={ctx} title={`Remove ${k}?`} draft={{ delete: [k] }} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function UserKeyDialog({ ctx, k, onClose }: DialogProps & { k: string }) {
  const adding = k === '';
  const [key, setKey] = useState(adding ? 'user.' : k);
  const [value, setValue] = useState(adding ? '' : (currentValue(ctx.config, k) ?? ''));
  const keyErr = adding ? (key.trim() === 'user.' ? null : userKeyError(key)) : null;
  const taken =
    adding && key.trim() in ctx.config.values ? 'That key is there already: change it in the list.' : null;
  const ok = !keyErr && !taken && key.trim() !== 'user.' && value.trim() !== '';
  const draft: ConfigDraft | null = ok ? { set: { [key.trim()]: value.replace(/\s+$/, '') } } : null;
  return (
    <EditDialog
      ctx={ctx}
      title={adding ? `Add a key to ${ctx.guest.name}` : `${k} of ${ctx.guest.name}`}
      draft={draft}
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <TextField
            label="Key"
            mono
            value={key}
            autoFocus={adding}
            disabled={!adding}
            error={keyErr ?? taken ?? errors[key.trim()]}
            hint={adding ? 'Starts with user., like user.owner.' : undefined}
            onChange={(e) => setKey(e.target.value)}
          />
          <TextField
            label="Value"
            mono
            value={value}
            autoFocus={!adding}
            hint="Empty values aren’t kept: remove the key instead."
            onChange={(e) => setValue(e.target.value)}
          />
        </>
      )}
    </EditDialog>
  );
}

/* The rest -------------------------------------------------------------------------------------------- */

function OtherKeys({ ctx }: { ctx: EditCtx }) {
  const keys = incusOtherKeys(ctx.config.values);
  if (!keys.length) return null;
  return (
    <Card title="Other settings" meta="Shown as they are">
      <div className={styles.rows}>
        {keys.map((k) => (
          <OtherRow key={k} k={k} value={ctx.config.values[k] ?? ''} locked={isRestricted(ctx.config, k)} />
        ))}
      </div>
    </Card>
  );
}

function OtherRow({ k, value, locked }: { k: string; value: string; locked: boolean }): ReactNode {
  return (
    <div className={styles.row}>
      <span className={wi.wiKey} title={k}>
        {k}
      </span>
      <span className={wi.wiRaw}>{value}</span>
      {locked ? <IncusLock /> : null}
    </div>
  );
}
