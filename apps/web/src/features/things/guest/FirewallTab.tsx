/**
 * A guest's firewall (ported from Rackoon's `FirewallTab`; PX-01): a note when the datacenter's firewall is off (the
 * rules then do nothing), the switch, its policies and options with Options… (DHCP, NDP, router advertisement, MAC and
 * IP filter, policies, log levels), and the rules in order — add, edit, turn on or off, move up or down, delete, a
 * security group's rules too. Every change carries the digest it was based on; one made meanwhile reloads and says
 * “Changed meanwhile — review again.”
 */
import {
  DASH,
  FIREWALL_DEFAULTS,
  FIREWALL_LOG_LEVELS,
  FIREWALL_MACROS,
  FIREWALL_POLICIES,
  FIREWALL_PROTOCOLS,
  type FirewallRule,
  firewallActionWord,
  firewallOption,
  isOn,
  ruleSummary,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostFirewall } from '@whombat/core/domain';
import { ChevronDown, ChevronUp, Ellipsis, Info, Plus, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useRowMenu } from '../../../app/shell/ContextMenu';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { Toggle } from '../../../components/Toggle';
import { Check, FormDialog, SelectField, TextField } from '../manage/fields';
import { useManage } from '../manage/useManage';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import styles from '../Things.module.css';
import wb from '../wb.module.css';
import type { GuestTabProps } from './tabProps';

const FLAGS: { key: string; label: string; hint: string }[] = [
  { key: 'dhcp', label: 'DHCP', hint: 'Lets it get an address from the network.' },
  { key: 'ndp', label: 'NDP', hint: 'Lets IPv6 find its neighbours.' },
  { key: 'radv', label: 'Router advertisement', hint: 'Lets it announce itself as an IPv6 router.' },
  { key: 'macfilter', label: 'MAC filter', hint: 'Drops traffic from MAC addresses that aren’t its own.' },
  { key: 'ipfilter', label: 'IP filter', hint: 'Drops traffic from addresses it isn’t set up with.' },
];

/** A policy in words: what happens to traffic no rule matches. */
const policyWords = (p: string) =>
  p === 'ACCEPT'
    ? 'Allowed unless a rule stops it'
    : p === 'REJECT'
      ? 'Refused unless a rule allows it'
      : 'Dropped unless a rule allows it';

export function FirewallTab({ burrow, serverId, guest }: GuestTabProps) {
  const q = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'firewall.get', guestId: guest.id, platform: 'pve' },
  });
  const fw = q.data?.op === 'firewall.get' ? q.data.firewall : undefined;
  const { send, busy } = useManage(burrow, serverId);
  const menu = useRowMenu();
  const [dialog, setDialog] = useState<
    | { kind: 'options' }
    | { kind: 'rule'; rule: FirewallRule | null }
    | { kind: 'delete'; rule: FirewallRule }
    | null
  >(null);
  if (q.error) return <ErrorLine error={q.error} onRetry={() => void q.refetch()} />;
  if (!fw)
    return (
      <Card title="Firewall">
        <Empty>Looking…</Empty>
      </Card>
    );
  const on = isOn(firewallOption(fw, 'enable'));
  const flags = FLAGS.filter((f) => isOn(firewallOption(fw, f.key))).map((f) => f.label);
  const rules = [...fw.rules].sort((a, b) => a.pos - b.pos);
  const update = (r: FirewallRule, change: { rule?: FirewallRule; moveTo?: number }, done: string) =>
    void send(
      {
        op: 'firewall.rule_update',
        guestId: guest.id,
        params: { pos: r.pos, ...change },
        ...(fw.rulesDigest ? { digest: fw.rulesDigest } : {}),
        name: guest.name,
        done,
      },
      { inline: false },
    );
  return (
    <>
      {fw.clusterEnabled ? null : (
        <div className={styles.notice} role="note">
          <span className={`${styles.noticeIcon} ${styles.noticeIconMut}`} aria-hidden="true">
            <Icon icon={Info} size={16} />
          </span>
          <div>
            <b>The datacenter firewall is off</b>
            <p>
              These rules do nothing until it’s on: in Proxmox, Datacenter › Firewall › Options, set Firewall
              to Yes.
            </p>
          </div>
        </div>
      )}
      <Card
        title="Firewall"
        link={
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={SlidersHorizontal} size={14} />}
            onClick={() => setDialog({ kind: 'options' })}
          >
            Options…
          </Button>
        }
      >
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b id="fw-on">Firewall for {guest.name}</b>
              <small>Applies to its network devices that have the firewall option on.</small>
            </div>
            <Toggle
              aria-labelledby="fw-on"
              checked={on}
              disabled={busy}
              onCheckedChange={(v) =>
                void send(
                  {
                    op: 'firewall.options',
                    guestId: guest.id,
                    params: { set: { enable: v ? '1' : '0' } },
                    ...(fw.optionsDigest ? { digest: fw.optionsDigest } : {}),
                    name: guest.name,
                    done: v
                      ? `The firewall is on for ${guest.name}.`
                      : `The firewall is off for ${guest.name}.`,
                  },
                  { inline: false },
                )
              }
            />
          </div>
        </div>
        <dl className={wb.wbKv} style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <div>
            <dt>Incoming</dt>
            <dd>{policyWords(firewallOption(fw, 'policy_in'))}</dd>
          </div>
          <div>
            <dt>Outgoing</dt>
            <dd>{policyWords(firewallOption(fw, 'policy_out'))}</dd>
          </div>
          <div>
            <dt>Allowed and filters</dt>
            <dd>{flags.join(' · ') || DASH}</dd>
          </div>
          <div>
            <dt>Log in / out</dt>
            <dd className={styles.mono}>
              {firewallOption(fw, 'log_level_in')} / {firewallOption(fw, 'log_level_out')}
            </dd>
          </div>
        </dl>
      </Card>
      <Card
        title="Rules"
        meta="Checked from the top; the first that matches decides"
        link={
          <Button
            size="sm"
            style={{ marginLeft: 'auto' }}
            iconStart={<Icon icon={Plus} size={14} />}
            onClick={() => setDialog({ kind: 'rule', rule: null })}
          >
            Add a rule
          </Button>
        }
      >
        {rules.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.dropS}>
                  #
                </th>
                <th scope="col">On</th>
                <th scope="col" className={styles.dropM}>
                  Direction
                </th>
                <th scope="col">
                  <span className={styles.narrowSr}>Does</span>
                </th>
                <th scope="col" className={styles.cellMain}>
                  Matches
                </th>
                <th scope="col" className={styles.dropL}>
                  Note
                </th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => {
                const name = `rule ${r.pos}`;
                return (
                  <tr key={r.pos} className={r.enable ? undefined : wb.wbOff}>
                    <td className={cx(styles.num, styles.dropS)}>{r.pos}</td>
                    <td>
                      <Toggle
                        size="sm"
                        aria-label={`${name} on`}
                        checked={r.enable}
                        disabled={busy}
                        onCheckedChange={(v) =>
                          update(r, { rule: { ...r, enable: v } }, v ? 'The rule is on.' : 'The rule is off.')
                        }
                      />
                    </td>
                    <td className={styles.dropM}>
                      {r.type === 'in' ? 'In' : r.type === 'out' ? 'Out' : 'Group'}
                    </td>
                    <td>
                      {r.type === 'group' ? (
                        <span className={styles.mono}>{r.action}</span>
                      ) : (
                        <StateCell
                          tone={r.action === 'ACCEPT' ? 'ok' : 'bad'}
                          text={firewallActionWord(r.action)}
                          compact
                        />
                      )}
                    </td>
                    <td className={cx(styles.mono, wb.wbTd, styles.cellMain)}>
                      {ruleSummary(r)}
                      {r.log && r.log !== 'nolog' ? (
                        <span className={styles.kind}> · log {r.log}</span>
                      ) : null}
                    </td>
                    <td className={cx(styles.muted, wb.wbTd, styles.dropL)}>{r.comment ?? ''}</td>
                    <td>
                      <span className={wb.wbTools}>
                        <button
                          type="button"
                          className={styles.iconBtn}
                          aria-label={`Move ${name} up`}
                          title="Move up"
                          disabled={busy || i === 0}
                          onClick={() => update(r, { moveTo: r.pos - 1 }, 'Moved the rule up.')}
                        >
                          <Icon icon={ChevronUp} size={14} />
                        </button>
                        <button
                          type="button"
                          className={styles.iconBtn}
                          aria-label={`Move ${name} down`}
                          title="Move down"
                          disabled={busy || i === rules.length - 1}
                          onClick={() => update(r, { moveTo: r.pos + 1 }, 'Moved the rule down.')}
                        >
                          <Icon icon={ChevronDown} size={14} />
                        </button>
                        <button
                          type="button"
                          className={styles.iconBtn}
                          aria-label={`More for ${name}`}
                          aria-haspopup="menu"
                          disabled={busy}
                          onClick={(e) =>
                            menu.openFrom(
                              e.currentTarget,
                              `rule:${r.pos}`,
                              name,
                              [
                                { label: 'Edit…', onSelect: () => setDialog({ kind: 'rule', rule: r }) },
                                {
                                  label: 'Delete…',
                                  danger: true,
                                  separated: true,
                                  onSelect: () => setDialog({ kind: 'delete', rule: r }),
                                },
                              ],
                              'end',
                            )
                          }
                        >
                          <Icon icon={Ellipsis} size={15} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>No rules: the policies above decide.</Empty>
        )}
      </Card>
      {menu.element}
      {dialog?.kind === 'options' ? (
        <OptionsDialog
          burrow={burrow}
          serverId={serverId}
          guestId={guest.id}
          name={guest.name}
          fw={fw}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'rule' ? (
        <RuleDialog
          burrow={burrow}
          serverId={serverId}
          guestId={guest.id}
          name={guest.name}
          fw={fw}
          rule={dialog.rule}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteRuleDialog
          burrow={burrow}
          serverId={serverId}
          guestId={guest.id}
          name={guest.name}
          fw={fw}
          rule={dialog.rule}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

interface EditProps {
  burrow: string;
  serverId: string;
  guestId: string;
  name: string;
  fw: HostFirewall;
  onClose: () => void;
}

function OptionsDialog({ burrow, serverId, guestId, name, fw, onClose }: EditProps) {
  const [v, setV] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.keys(FIREWALL_DEFAULTS).map((k) => [k, firewallOption(fw, k)])),
  );
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  const put = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== firewallOption(fw, k)));
  const policies = FIREWALL_POLICIES.map((p) => ({
    value: p,
    label: p === 'ACCEPT' ? 'Allow' : p === 'DROP' ? 'Drop' : 'Refuse',
  }));
  const levels = FIREWALL_LOG_LEVELS.map((l) => ({ value: l, label: l === 'nolog' ? 'No log' : l }));
  return (
    <FormDialog
      title={`Firewall options for ${name}`}
      action={busy ? 'Saving…' : 'Save'}
      busy={busy}
      disabled={!Object.keys(changed).length}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'firewall.options',
            guestId,
            params: { set: changed },
            ...(fw.optionsDigest ? { digest: fw.optionsDigest } : {}),
            name,
            done: 'Saved the firewall options.',
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    >
      <div className={styles.formRow}>
        <SelectField
          label="Incoming, by default"
          options={policies}
          value={v.policy_in}
          onChange={(e) => put('policy_in', e.target.value)}
        />
        <SelectField
          label="Outgoing, by default"
          options={policies}
          value={v.policy_out}
          onChange={(e) => put('policy_out', e.target.value)}
        />
      </div>
      {FLAGS.map((f) => (
        <div key={f.key} className={wb.wbSwitchRow}>
          <span>
            <b id={`fw-opt-${f.key}`}>{f.label}</b>
            <small>{f.hint}</small>
          </span>
          <Toggle
            aria-labelledby={`fw-opt-${f.key}`}
            checked={isOn(v[f.key])}
            onCheckedChange={(c) => put(f.key, c ? '1' : '0')}
          />
        </div>
      ))}
      <div className={styles.formRow}>
        <SelectField
          label="Log incoming"
          options={levels}
          value={v.log_level_in}
          onChange={(e) => put('log_level_in', e.target.value)}
        />
        <SelectField
          label="Log outgoing"
          options={levels}
          value={v.log_level_out}
          onChange={(e) => put('log_level_out', e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

type RuleForm = Omit<FirewallRule, 'pos'>;
const PORTS_RE = /^\d{1,5}([:,]\d{1,5})*$/;

function RuleDialog({
  burrow,
  serverId,
  guestId,
  name,
  fw,
  rule,
  onClose,
}: EditProps & { rule: FirewallRule | null }) {
  const cfg = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'config.get', guestId, platform: 'pve' },
  });
  const nics =
    cfg.data?.op === 'config.get'
      ? Object.keys(cfg.data.config.values).filter((k) => /^net\d+$/.test(k))
      : [];
  const [r, setR] = useState<RuleForm>(() =>
    rule ? { ...rule } : { type: 'in', action: 'ACCEPT', enable: true },
  );
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { send, busy } = useManage(burrow, serverId);
  const put = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setR((o) => ({ ...o, [k]: v }));
  const group = r.type === 'group';
  const ports = !group && !r.macro && (r.proto === 'tcp' || r.proto === 'udp' || r.proto === 'sctp');
  const portBad = (p: string | undefined) =>
    ports && p?.trim() && !PORTS_RE.test(p.trim()) ? 'Ports like 443, 8000:8100 or 80,443.' : null;
  const errs = {
    dport: portBad(r.dport),
    sport: portBad(r.sport),
    action: group && !r.action ? 'Pick a security group.' : null,
  };
  const clean = (): RuleForm => {
    const out: RuleForm = { type: r.type, action: r.action, enable: r.enable };
    const keep = group
      ? (['iface', 'comment'] as const)
      : (['macro', 'proto', 'source', 'dest', 'sport', 'dport', 'iface', 'log', 'comment'] as const);
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
  const any = (label = 'Any') => ({ value: '', label });
  return (
    <FormDialog
      title={rule ? `Edit rule ${rule.pos}` : `Add a rule for ${name}`}
      description={rule ? undefined : 'New rules go to the top, so they’re checked first.'}
      action={busy ? 'Saving…' : rule ? 'Save' : 'Add rule'}
      busy={busy}
      width="lg"
      disabled={Object.values(errs).some(Boolean)}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          setFields({});
          const out = await send(
            rule
              ? {
                  op: 'firewall.rule_update',
                  guestId,
                  params: { pos: rule.pos, rule: { pos: rule.pos, ...clean() } },
                  ...(fw.rulesDigest ? { digest: fw.rulesDigest } : {}),
                  name,
                  done: 'Saved the rule.',
                }
              : {
                  op: 'firewall.rule_add',
                  guestId,
                  params: { rule: { pos: 0, ...clean() } },
                  name,
                  done: 'Added the rule.',
                },
          );
          if (out.ok) onClose();
          else {
            setFields(
              Object.fromEntries(Object.entries(out.fields).map(([k, v]) => [k.replace(/^rule\./, ''), v])),
            );
            setError(out.conflict || !Object.keys(out.fields).length ? out.message : null);
          }
        })()
      }
    >
      <div className={styles.field}>
        <span>Direction</span>
        <SegmentedControl
          options={[
            { value: 'in', label: 'Incoming' },
            { value: 'out', label: 'Outgoing' },
            { value: 'group', label: 'Security group', disabled: !fw.groups?.length },
          ]}
          value={r.type}
          onChange={(t) =>
            setR((o) => ({
              ...o,
              type: t,
              action: t === 'group' ? (fw.groups?.[0] ?? '') : o.type === 'group' ? 'ACCEPT' : o.action,
            }))
          }
          label="Direction"
          variant="soft"
        />
      </div>
      <div className={styles.formRow}>
        {group ? (
          <SelectField
            label="Security group"
            options={(fw.groups ?? []).map((x) => ({ value: x, label: x }))}
            value={r.action}
            error={errs.action ?? fields.action}
            onChange={(e) => put('action', e.target.value)}
          />
        ) : (
          <>
            <SelectField
              label="Does"
              options={FIREWALL_POLICIES.map((p) => ({ value: p, label: firewallActionWord(p) }))}
              value={r.action}
              error={fields.action}
              onChange={(e) => put('action', e.target.value)}
            />
            <SelectField
              label="Macro"
              options={[
                any('None'),
                ...[...new Set([...FIREWALL_MACROS, ...(r.macro ? [r.macro] : [])])].map((m) => ({
                  value: m,
                  label: m,
                })),
              ]}
              value={r.macro ?? ''}
              hint="A ready-made service, such as SSH."
              error={fields.macro}
              onChange={(e) => put('macro', e.target.value || undefined)}
            />
            <SelectField
              label="Protocol"
              options={[
                any(),
                ...[...new Set([...FIREWALL_PROTOCOLS, ...(r.proto ? [r.proto] : [])])].map((p) => ({
                  value: p,
                  label: p,
                })),
              ]}
              value={r.macro ? '' : (r.proto ?? '')}
              disabled={!!r.macro}
              hint={r.macro ? 'The macro sets it.' : undefined}
              error={fields.proto}
              onChange={(e) => put('proto', e.target.value || undefined)}
            />
          </>
        )}
        <SelectField
          label="Interface"
          options={[
            any(),
            ...[...new Set([...nics, ...(r.iface ? [r.iface] : [])])].map((n) => ({ value: n, label: n })),
          ]}
          value={r.iface ?? ''}
          error={fields.iface}
          onChange={(e) => put('iface', e.target.value || undefined)}
        />
      </div>
      {group ? null : (
        <>
          <div className={styles.formRow}>
            <TextField
              label="From"
              mono
              value={r.source ?? ''}
              placeholder="anywhere"
              hint="An address, a network (10.0.0.0/24), an alias or an IP set."
              error={fields.source}
              onChange={(e) => put('source', e.target.value)}
            />
            <TextField
              label="To"
              mono
              value={r.dest ?? ''}
              placeholder="anywhere"
              error={fields.dest}
              onChange={(e) => put('dest', e.target.value)}
            />
          </div>
          <div className={styles.formRow}>
            {ports ? (
              <>
                <TextField
                  label="To port"
                  mono
                  value={r.dport ?? ''}
                  placeholder="443"
                  error={errs.dport ?? fields.dport}
                  onChange={(e) => put('dport', e.target.value)}
                />
                <TextField
                  label="From port"
                  mono
                  value={r.sport ?? ''}
                  placeholder="any"
                  error={errs.sport ?? fields.sport}
                  onChange={(e) => put('sport', e.target.value)}
                />
              </>
            ) : null}
            <SelectField
              label="Log"
              options={FIREWALL_LOG_LEVELS.map((l) => ({ value: l, label: l === 'nolog' ? 'No log' : l }))}
              value={r.log ?? 'nolog'}
              onChange={(e) => put('log', e.target.value)}
            />
          </div>
        </>
      )}
      <TextField
        label="Note"
        value={r.comment ?? ''}
        maxLength={200}
        error={fields.comment}
        onChange={(e) => put('comment', e.target.value)}
      />
      <Check label="The rule is on" checked={r.enable} onChange={(v) => put('enable', v)} />
    </FormDialog>
  );
}

function DeleteRuleDialog({
  burrow,
  serverId,
  guestId,
  name,
  fw,
  rule,
  onClose,
}: EditProps & { rule: FirewallRule }) {
  const [error, setError] = useState<string | null>(null);
  const { send, busy } = useManage(burrow, serverId);
  return (
    <FormDialog
      title={`Delete rule ${rule.pos}?`}
      description={`${rule.comment ? `“${rule.comment}”: ` : ''}${firewallActionWord(rule.action)} ${ruleSummary(rule)}.`}
      action={busy ? 'Deleting…' : 'Delete rule'}
      serious
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() =>
        void (async () => {
          setError(null);
          const out = await send({
            op: 'firewall.rule_delete',
            guestId,
            params: { pos: rule.pos },
            ...(fw.rulesDigest ? { digest: fw.rulesDigest } : {}),
            name,
            done: 'Deleted the rule.',
          });
          if (out.ok) onClose();
          else setError(out.message);
        })()
      }
    />
  );
}
