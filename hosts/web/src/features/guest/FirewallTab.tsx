// Firewall of a Proxmox guest (docs/MANAGE.md, Firewall tab): the switch,
// policies and options, and the rules in order (add, edit, delete, move up
// and down, turn one on or off). Every change carries the digest it was
// based on; 409 digest_mismatch reloads and asks to look again. A note says
// when the datacenter firewall is off (the guest's rules then do nothing).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { type FirewallRule, type GuestFirewall, manageApi, manageKeys, useFirewall, useGuestConfig } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { SegmentedControl } from '../../components/controls';
import { InlineError, SelectField, Switch, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { DASH } from '../../lib/format';
import { t } from '../../lib/i18n';
import { fieldErrors, isDigestMismatch, manageErrorText } from '../manage/manageErrors';
import type { GuestTabProps } from './GuestPage';

/** Proxmox's defaults for options a guest has not set. */
const DEFAULTS: Record<string, string> = { enable: '0', dhcp: '1', ndp: '1', radv: '0', macfilter: '1', ipfilter: '0', policy_in: 'DROP', policy_out: 'ACCEPT', log_level_in: 'nolog', log_level_out: 'nolog' };
const POLICIES = ['ACCEPT', 'DROP', 'REJECT'];
const LOG_LEVELS = ['nolog', 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const MACROS = ['SSH', 'HTTP', 'HTTPS', 'Web', 'DNS', 'Ping', 'NTP', 'SMTP', 'SMTPS', 'IMAPS', 'SMB', 'NFS', 'RDP', 'VNC', 'MySQL', 'PostgreSQL', 'Ceph', 'DHCPfwd'];
const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmpv6', 'esp', 'gre', 'sctp'];

const FLAGS: { key: string; label: string; hint: string }[] = [
  { key: 'dhcp', label: 'DHCP', hint: t('Allow DHCP so the guest gets an address') },
  { key: 'ndp', label: 'NDP', hint: t('Allow IPv6 neighbor discovery') },
  { key: 'radv', label: t('Router advertisement'), hint: t('Let the guest announce itself as an IPv6 router') },
  { key: 'macfilter', label: t('MAC filter'), hint: t('Drop traffic from MAC addresses other than the guest’s') },
  { key: 'ipfilter', label: t('IP filter'), hint: t('Drop traffic from addresses the guest is not configured with') },
];

const opt = (fw: GuestFirewall, k: string) => fw.options[k] ?? DEFAULTS[k] ?? '';
const on = (v: string) => v === '1';

/** "SSH from 10.20.0.0/24", "tcp port 443 to …", "group monitoring". */
export function ruleSummary(r: Omit<FirewallRule, 'pos'>): string {
  if (r.type === 'group') return t('the rules of the security group');
  const parts = [r.macro || r.proto || t('any protocol')];
  if (r.dport) parts.push(t('port {port}', { port: r.dport }));
  if (r.sport) parts.push(t('from port {port}', { port: r.sport }));
  if (r.source) parts.push(t('from {addr}', { addr: r.source }));
  if (r.dest) parts.push(t('to {addr}', { addr: r.dest }));
  if (r.iface) parts.push(t('on {iface}', { iface: r.iface }));
  return parts.join(' ');
}

export function FirewallTab({ serverId, guest }: GuestTabProps) {
  const qc = useQueryClient();
  const fw = useFirewall(serverId, guest.id);
  const [dialog, setDialog] = useState<{ kind: 'options' } | { kind: 'rule'; rule: FirewallRule | null } | { kind: 'delete'; rule: FirewallRule } | null>(null);
  const reload = () => void qc.invalidateQueries({ queryKey: manageKeys.firewall(serverId, guest.id) });
  const failed = (err: unknown) => {
    if (isDigestMismatch(err)) {
      reload();
      toast(t('The firewall changed meanwhile — review again.'), 'info');
    } else toast(manageErrorText(err), 'error');
  };

  const enable = useMutation({
    mutationFn: (v: boolean) => manageApi.setFirewallOptions(serverId, guest.id, { digest: fw.data?.options_digest, set: { enable: v ? '1' : '0' } }),
    onSuccess: reload,
    onError: failed,
  });
  const update = useMutation({
    mutationFn: (p: { pos: number; rule?: FirewallRule; move_to?: number }) => manageApi.updateFirewallRule(serverId, guest.id, p.pos, { digest: fw.data?.rules_digest, ...(p.rule ? { rule: p.rule } : {}), ...(p.move_to !== undefined ? { move_to: p.move_to } : {}) }),
    onSuccess: reload,
    onError: failed,
  });

  if (fw.isError) return <InlineRetry title={t('Could not load the firewall')} error={fw.error} onRetry={() => void fw.refetch()} />;
  if (!fw.data) return <Skeleton height={240} />;
  const f = fw.data;
  const enabled = on(opt(f, 'enable'));
  const busy = enable.isPending || update.isPending;
  const flags = FLAGS.filter((x) => on(opt(f, x.key))).map((x) => x.label);

  return (
    <div className="lc-stack">
      {!f.cluster_enabled && (
        <div className="rc-note" role="note">
          <Icon name="info" size={16} />
          <span>{t('The datacenter firewall is off, so these rules do nothing yet. Turn it on in Proxmox under Datacenter › Firewall › Options.')}</span>
        </div>
      )}
      <section className="card" aria-labelledby="fw-title">
        <div className="card-head">
          <h2 className="h2" id="fw-title">
            {t('Firewall')}
          </h2>
          <button type="button" className="btn-ghost" onClick={() => setDialog({ kind: 'options' })}>
            <Icon name="edit" size={14} />
            {t('Options…')}
          </button>
        </div>
        <div className="card-body lc-stack">
          <Switch
            checked={enabled}
            busy={enable.isPending}
            disabled={busy}
            onChange={(v) => enable.mutate(v)}
            label={t('Firewall for {name}', { name: guest.name })}
            description={t('Applies to network devices with the firewall option on.')}
          />
          <dl className="lc-kv">
            <div>
              <dt className="lbl">{t('Inbound')}</dt>
              <dd>{opt(f, 'policy_in')}</dd>
            </div>
            <div>
              <dt className="lbl">{t('Outbound')}</dt>
              <dd>{opt(f, 'policy_out')}</dd>
            </div>
            <div>
              <dt className="lbl">{t('Allowed and filters')}</dt>
              <dd>{flags.join(' · ') || DASH}</dd>
            </div>
            <div>
              <dt className="lbl">{t('Log level in / out')}</dt>
              <dd>
                {opt(f, 'log_level_in')} / {opt(f, 'log_level_out')}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="card" aria-labelledby="fw-rules-title">
        <div className="card-head">
          <h2 className="h2" id="fw-rules-title">
            {t('Rules')}
          </h2>
          <span className="lc-head-tools">
            <span className="sub">{t('First match wins, top to bottom')}</span>
            <button type="button" className="btn-ghost" onClick={() => setDialog({ kind: 'rule', rule: null })}>
              <Icon name="plus" size={15} />
              {t('Add rule')}
            </button>
          </span>
        </div>
        {f.rules.length === 0 ? (
          <div className="guests-empty">{t('No rules: the policies decide.')}</div>
        ) : (
          <div className="gt-scroll">
            <table className="lc-table" aria-labelledby="fw-rules-title">
              <thead>
                <tr>
                  <th scope="col" className="num hide-phone">
                    #
                  </th>
                  <th scope="col">{t('On')}</th>
                  <th scope="col">{t('Direction')}</th>
                  <th scope="col">{t('Action')}</th>
                  <th scope="col">{t('Match')}</th>
                  <th scope="col" className="hide-phone">
                    {t('Comment')}
                  </th>
                  <th scope="col">
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {f.rules.map((r, i) => {
                  const name = t('rule {n}', { n: r.pos });
                  return (
                    <tr key={r.pos} className={r.enable ? undefined : 'is-stopped'}>
                      <td className="num ink-3 hide-phone">{r.pos}</td>
                      <td>
                        <input
                          type="checkbox"
                          className="lc-check"
                          checked={r.enable}
                          disabled={busy}
                          aria-label={t('{rule} on', { rule: name })}
                          onChange={(e) => update.mutate({ pos: r.pos, rule: { ...r, enable: e.target.checked } })}
                        />
                      </td>
                      <td className="ink-2">{r.type === 'in' ? t('In') : r.type === 'out' ? t('Out') : t('Group')}</td>
                      <td>
                        <span className={r.type === 'group' ? 'mono' : 'strong'}>{r.action}</span>
                      </td>
                      <td className="lc-match">
                        <span className="ellipsis">{ruleSummary(r)}</span>
                        {r.log && r.log !== 'nolog' && <span className="lbl"> · {t('log {level}', { level: r.log })}</span>}
                      </td>
                      <td className="ink-2 hide-phone lc-notes">
                        <span className="ellipsis">{r.comment ?? ''}</span>
                      </td>
                      <td className="last">
                        <span className="row-tools">
                          <button type="button" className="btn-ghost btn-icon row-action" aria-label={t('Move {rule} up', { rule: name })} title={t('Move up')} disabled={busy || i === 0} onClick={() => update.mutate({ pos: r.pos, move_to: r.pos - 1 })}>
                            <Icon name="chevronUp" size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn-ghost btn-icon row-action"
                            aria-label={t('Move {rule} down', { rule: name })}
                            title={t('Move down')}
                            disabled={busy || i === f.rules.length - 1}
                            onClick={() => update.mutate({ pos: r.pos, move_to: r.pos + 1 })}
                          >
                            <Icon name="chevronDown" size={14} />
                          </button>
                          <Menu
                            label={t('More for {rule}', { rule: name })}
                            buttonClassName="btn-ghost btn-icon row-action"
                            floating
                            items={[
                              { label: t('Edit…'), icon: 'edit', onSelect: () => setDialog({ kind: 'rule', rule: r }) },
                              { label: t('Delete…'), icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'delete', rule: r }) },
                            ]}
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog?.kind === 'options' && <OptionsDialog serverId={serverId} guestId={guest.id} fw={f} onClose={() => setDialog(null)} onDone={reload} onFailed={failed} />}
      {dialog?.kind === 'rule' && <RuleDialog serverId={serverId} guestId={guest.id} fw={f} rule={dialog.rule} onClose={() => setDialog(null)} onDone={reload} onFailed={failed} />}
      {dialog?.kind === 'delete' && <DeleteRuleDialog serverId={serverId} guestId={guest.id} fw={f} rule={dialog.rule} onClose={() => setDialog(null)} onDone={reload} onFailed={failed} />}
    </div>
  );
}

interface EditProps {
  serverId: string;
  guestId: string;
  fw: GuestFirewall;
  onClose: () => void;
  onDone: () => void;
  onFailed: (err: unknown) => void;
}

function OptionsDialog({ serverId, guestId, fw, onClose, onDone, onFailed }: EditProps) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, opt(fw, k)])));
  const set = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== opt(fw, k)));
  const save = useMutation({
    mutationFn: () => manageApi.setFirewallOptions(serverId, guestId, { digest: fw.options_digest, set: changed }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => {
      onFailed(err);
      if (isDigestMismatch(err)) onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={t('Firewall options')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="fw-options" className="btn-primary btn-sm" disabled={save.isPending || !Object.keys(changed).length}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        id="fw-options"
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (Object.keys(changed).length) save.mutate();
        }}
      >
        <div className="form-grid">
          <SelectField label={t('Inbound policy')} value={v.policy_in} autoFocus onChange={(e) => set('policy_in', e.target.value)}>
            {POLICIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </SelectField>
          <SelectField label={t('Outbound policy')} value={v.policy_out} onChange={(e) => set('policy_out', e.target.value)}>
            {POLICIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </SelectField>
        </div>
        {FLAGS.map((x) => (
          <Switch key={x.key} checked={on(v[x.key] ?? '')} onChange={(c) => set(x.key, c ? '1' : '0')} label={x.label} description={x.hint} />
        ))}
        <div className="form-grid">
          <SelectField label={t('Log level in')} value={v.log_level_in} onChange={(e) => set('log_level_in', e.target.value)}>
            {LOG_LEVELS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </SelectField>
          <SelectField label={t('Log level out')} value={v.log_level_out} onChange={(e) => set('log_level_out', e.target.value)}>
            {LOG_LEVELS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </SelectField>
        </div>
        {save.isError && !isDigestMismatch(save.error) && <InlineError>{manageErrorText(save.error)}</InlineError>}
      </form>
    </Modal>
  );
}

type RuleForm = Omit<FirewallRule, 'pos'>;

function RuleDialog({ serverId, guestId, fw, rule, onClose, onDone, onFailed }: EditProps & { rule: FirewallRule | null }) {
  const nics = Object.keys(useGuestConfig(serverId, guestId).data?.values ?? {}).filter((k) => /^net\d+$/.test(k));
  const [r, setR] = useState<RuleForm>(() => (rule ? { ...rule } : { type: 'in', action: 'ACCEPT', enable: true }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setR((o) => ({ ...o, [k]: v }));
  const group = r.type === 'group';
  const ports = !group && !r.macro && (r.proto === 'tcp' || r.proto === 'udp' || r.proto === 'sctp');

  const clean = (): RuleForm => {
    const out: RuleForm = { type: r.type, action: r.action, enable: r.enable };
    const keep = group ? (['iface', 'comment'] as const) : (['macro', 'proto', 'source', 'dest', 'sport', 'dport', 'iface', 'log', 'comment'] as const);
    for (const k of keep) {
      const v = r[k]?.trim();
      if (!v) continue;
      if ((k === 'sport' || k === 'dport') && !ports) continue;
      if (k === 'proto' && r.macro) continue;
      if (k === 'log' && v === 'nolog') continue;
      out[k] = v;
    }
    return out;
  };
  const save = useMutation({
    mutationFn: () => (rule ? manageApi.updateFirewallRule(serverId, guestId, rule.pos, { digest: fw.rules_digest, rule: { pos: rule.pos, ...clean() } }) : manageApi.addFirewallRule(serverId, guestId, { ...clean(), pos: 0 })),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      if (isDigestMismatch(err)) {
        onFailed(err);
        onClose();
      }
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const portErr = (p: string | undefined) => (p && !/^\d{1,5}([:,]\d{1,5})*$/.test(p.trim()) ? t('Ports like 443, 8000:8080 or 80,443.') : undefined);
    const errs = { action: group && !r.action ? t('Choose a security group.') : undefined, dport: ports ? portErr(r.dport) : undefined, sport: ports ? portErr(r.sport) : undefined };
    setErrors(Object.fromEntries(Object.entries(errs).filter(([, v]) => v)) as Record<string, string>);
    if (!Object.values(errs).some(Boolean)) save.mutate();
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      busy={save.isPending}
      title={rule ? t('Edit rule {n}', { n: rule.pos }) : t('Add a firewall rule')}
      description={rule ? undefined : t('New rules go to the top of the list.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="fw-rule" className="btn-primary btn-sm" disabled={save.isPending}>
            {rule ? t('Save') : t('Add rule')}
          </button>
        </>
      }
    >
      <form id="fw-rule" className="form-stack" onSubmit={submit} noValidate>
        <SegmentedControl
          label={t('Direction')}
          value={r.type}
          onChange={(v) => setR((o) => ({ ...o, type: v, action: v === 'group' ? (fw.groups?.[0] ?? '') : o.type === 'group' ? 'ACCEPT' : o.action }))}
          options={[
            { value: 'in', label: t('In') },
            { value: 'out', label: t('Out') },
            { value: 'group', label: t('Security group'), disabled: !fw.groups?.length, title: fw.groups?.length ? undefined : t('No security groups in this cluster') },
          ]}
        />
        <div className="form-grid">
          {group ? (
            <SelectField label={t('Security group')} value={r.action} error={errors.action} autoFocus onChange={(e) => set('action', e.target.value)}>
              {(fw.groups ?? []).map((g) => (
                <option key={g}>{g}</option>
              ))}
            </SelectField>
          ) : (
            <>
              <SelectField label={t('Action')} value={r.action} error={errors.action} autoFocus onChange={(e) => set('action', e.target.value)}>
                {POLICIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </SelectField>
              <SelectField label={t('Macro')} value={r.macro ?? ''} error={errors.macro} onChange={(e) => set('macro', e.target.value || undefined)}>
                <option value="">{t('None')}</option>
                {[...new Set([...MACROS, ...(r.macro ? [r.macro] : [])])].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </SelectField>
              <SelectField label={t('Protocol')} value={r.macro ? '' : (r.proto ?? '')} disabled={!!r.macro} hint={r.macro ? t('Set by the macro') : undefined} error={errors.proto} onChange={(e) => set('proto', e.target.value || undefined)}>
                <option value="">{t('Any')}</option>
                {[...new Set([...PROTOCOLS, ...(r.proto ? [r.proto] : [])])].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </SelectField>
            </>
          )}
          <SelectField label={t('Interface')} value={r.iface ?? ''} error={errors.iface} onChange={(e) => set('iface', e.target.value || undefined)}>
            <option value="">{t('Any')}</option>
            {[...new Set([...nics, ...(r.iface ? [r.iface] : [])])].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </SelectField>
        </div>
        {!group && (
          <div className="form-grid">
            <TextField label={t('Source')} mono value={r.source ?? ''} placeholder={t('any')} hint={t('Address, network (10.0.0.0/24), alias or IP set')} error={errors.source} onChange={(e) => set('source', e.target.value)} />
            <TextField label={t('Destination')} mono value={r.dest ?? ''} placeholder={t('any')} error={errors.dest} onChange={(e) => set('dest', e.target.value)} />
            {ports && <TextField label={t('Destination port')} mono value={r.dport ?? ''} placeholder="443" error={errors.dport} onChange={(e) => set('dport', e.target.value)} />}
            {ports && <TextField label={t('Source port')} mono value={r.sport ?? ''} placeholder={t('any')} error={errors.sport} onChange={(e) => set('sport', e.target.value)} />}
            <SelectField label={t('Log level')} value={r.log ?? 'nolog'} onChange={(e) => set('log', e.target.value)}>
              {LOG_LEVELS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </SelectField>
          </div>
        )}
        <TextField label={t('Comment')} value={r.comment ?? ''} maxLength={200} error={errors.comment} onChange={(e) => set('comment', e.target.value)} />
        <label className="check-row">
          <input type="checkbox" checked={r.enable} onChange={(e) => set('enable', e.target.checked)} />
          {t('Rule is on')}
        </label>
        {save.isError && !isDigestMismatch(save.error) && <InlineError>{manageErrorText(save.error, Object.keys(errors))}</InlineError>}
      </form>
    </Modal>
  );
}

function DeleteRuleDialog({ serverId, guestId, fw, rule, onClose, onDone, onFailed }: EditProps & { rule: FirewallRule }) {
  const save = useMutation({
    mutationFn: () => manageApi.deleteFirewallRule(serverId, guestId, rule.pos, fw.rules_digest),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: (err) => {
      onFailed(err);
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      tone="serious"
      title={t('Delete rule {n}?', { n: rule.pos })}
      description={
        <>
          <b>{rule.action}</b> {ruleSummary(rule)}
        </>
      }
      actions={
        <>
          <button type="button" className="btn-ghost" autoFocus onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary btn-sm is-serious" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('Delete rule')}
          </button>
        </>
      }
    />
  );
}
