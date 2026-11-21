// Cloud-Init of a Proxmox VM with a cloud-init drive: user, password
// (write-only: Proxmox only says whether one is set), DNS, SSH keys (kept
// URL-encoded in `sshkeys`, like Proxmox does), package upgrades and the
// IP configuration of each network device (docs/MANAGE.md, Editing).

import { type ReactNode, useState } from 'react';
import { useGuestConfig } from '../../api/manage';
import { Skeleton } from '../../components/common';
import { Field, TextField } from '../../components/forms';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { t, tn } from '../../lib/i18n';
import { current, decodeSshKeys, draftOf, encodeSshKeys, formatIpConfig, type IpConfig, keysOf, MASK, parseIpConfig, rowValue, sshKeyLabel, sshKeyLines } from './config';
import { type DialogProps, FlagDialog, KeyErrors, TextDialog } from './dialogs';
import { EditDialog, type EditCtx } from './EditDialog';
import type { GuestTabProps } from './GuestPage';
import { DnsDialog, IpFields, ipErrors, RemoveDialog } from './hardwareDialogs';
import { CfgCard, CfgRow, EditButton } from './parts';
import { PendingBanner } from './PendingBanner';
import { isOn } from './props';

function ipText(v: string | undefined): string {
  if (!v) return t('Not set');
  const c = parseIpConfig(v);
  const v4 = c.v4 === 'dhcp' ? t('IPv4 DHCP') : c.v4 === 'static' ? `${c.ip}${c.gw ? ` · ${t('gateway {ip}', { ip: c.gw })}` : ''}` : '';
  const v6 = c.v6 === 'auto' ? t('IPv6 SLAAC') : c.v6 === 'dhcp' ? t('IPv6 DHCP') : c.v6 === 'static' ? `${c.ip6}${c.gw6 ? ` · ${t('gateway {ip}', { ip: c.gw6 })}` : ''}` : '';
  return [v4, v6].filter(Boolean).join(', ') || t('None');
}

function keysText(v: string | undefined): ReactNode {
  const lines = sshKeyLines(decodeSshKeys(v));
  if (!lines.length) return t('None');
  return (
    <>
      {tn(lines.length, '{n} key', '{n} keys')}
      <span className="lbl"> · {lines.map(sshKeyLabel).join(', ')}</span>
    </>
  );
}

export function CloudInitTab({ serverId, guest }: GuestTabProps) {
  const config = useGuestConfig(serverId, guest.id);
  const [open, setOpen] = useState<string | null>(null);
  if (!config.data) {
    return config.isError ? (
      <div className="card card-body">
        <InlineRetry title={t('Could not load the configuration')} error={config.error} onRetry={() => void config.refetch()} />
      </div>
    ) : (
      <Skeleton height={320} />
    );
  }
  const cfg = config.data;
  const ctx: EditCtx = { serverId, guest, config: cfg };
  const p = { ctx, onClose: () => setOpen(null) };
  const name = guest.name;
  const v = cfg.values;
  const nets = keysOf(cfg, /^net\d+$/);
  const row = (key: string, show: (x: string | undefined) => ReactNode) => {
    const r = rowValue(cfg, key);
    return { value: show(r.value), next: r.next === undefined ? undefined : r.removed ? '' : show(r.next), unset: r.value === undefined };
  };
  const passwordSet = (x: string | undefined) => (x ? t('Set') : t('Not set'));

  const dialogs: Record<string, ReactNode> = {
    ciuser: <TextDialog {...p} cfgKey="ciuser" title={t('Edit user')} label={t('Cloud-Init user of {name}', { name })} fieldLabel={t('User')} hint={t('Empty: the image’s default user')} mono />,
    cipassword: <PasswordDialog {...p} />,
    removePassword: <RemoveDialog {...p} cfgKey="cipassword" title={t('Remove the password?')} description={t('The user then signs in with an SSH key only.')} />,
    dns: <DnsDialog {...p} />,
    sshkeys: <SshKeysDialog {...p} />,
    ciupgrade: <FlagDialog {...p} cfgKey="ciupgrade" title={t('Upgrade packages')} label={t('Package upgrades of {name}', { name })} switchLabel={t('Upgrade packages at the first boot')} defaultOn />,
  };
  for (const n of nets) dialogs[`ipconfig${n.slice(3)}`] = <IpConfigDialog {...p} cfgKey={`ipconfig${n.slice(3)}`} nic={n} />;

  const user = row('ciuser', (x) => x ?? t('The image’s default'));
  const pw = row('cipassword', passwordSet);
  const domain = row('searchdomain', (x) => x ?? t('The host’s'));
  const servers = row('nameserver', (x) => x ?? t('The host’s'));
  const keys = row('sshkeys', keysText);
  const upgrade = row('ciupgrade', (x) => (isOn(x, true) ? t('Yes') : t('No')));
  return (
    <div className="section guest-tab">
      <PendingBanner serverId={serverId} guest={guest} config={cfg} />
      <CfgCard title={t('Cloud-Init')} id="cfg-cloudinit" sub={t('Applies when the guest boots with a regenerated drive')}>
        <CfgRow label={t('User')} next={user.next} muted={user.unset} actions={<EditButton what={t('user')} onClick={() => setOpen('ciuser')} />}>
          <span className={user.unset ? undefined : 'mono'}>{user.value}</span>
        </CfgRow>
        <CfgRow
          label={t('Password')}
          next={pw.next}
          muted={pw.unset}
          actions={
            <>
              <EditButton what={t('password')} text={v.cipassword ? t('Change') : t('Set|action')} onClick={() => setOpen('cipassword')} />
              {v.cipassword && <Menu label={t('More for {name}', { name: t('password') })} items={[{ label: t('Remove…'), icon: 'trash', danger: true, onSelect: () => setOpen('removePassword') }]} buttonClassName="btn-ghost btn-icon row-action" floating />}
            </>
          }
        >
          {pw.value}
        </CfgRow>
        <CfgRow label={t('DNS domain')} next={domain.next} muted={domain.unset} actions={<EditButton what={t('DNS domain')} onClick={() => setOpen('dns')} />}>
          <span className={domain.unset ? undefined : 'mono'}>{domain.value}</span>
        </CfgRow>
        <CfgRow label={t('DNS servers')} next={servers.next} muted={servers.unset} actions={<EditButton what={t('DNS servers')} onClick={() => setOpen('dns')} />}>
          <span className={servers.unset ? undefined : 'mono'}>{servers.value}</span>
        </CfgRow>
        <CfgRow label={t('SSH public keys')} next={keys.next} muted={keys.unset} actions={<EditButton what={t('SSH public keys')} onClick={() => setOpen('sshkeys')} />}>
          {keys.value}
        </CfgRow>
        <CfgRow label={t('Upgrade packages')} next={upgrade.next} actions={<EditButton what={t('package upgrades')} onClick={() => setOpen('ciupgrade')} />}>
          {upgrade.value}
        </CfgRow>
        {nets.map((n) => {
          const key = `ipconfig${n.slice(3)}`;
          const r = row(key, ipText);
          return (
            <CfgRow key={key} label={t('IP config ({key})', { key: n })} next={r.next} muted={r.unset} actions={<EditButton what={t('IP config of {key}', { key: n })} onClick={() => setOpen(key)} />}>
              <span className={r.unset ? undefined : 'mono'}>{r.value}</span>
            </CfgRow>
          );
        })}
      </CfgCard>
      {open && dialogs[open]}
    </div>
  );
}

/** A new password (never shown: Proxmox answers "**********" for a set one). */
function PasswordDialog({ ctx, onClose }: DialogProps) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const mismatch = again && pw !== again ? t('The passwords differ.') : null;
  const draft = !pw || pw !== again || pw === MASK ? null : draftOf({ cipassword: pw });
  return (
    <EditDialog ctx={ctx} title={current(ctx.config, 'cipassword') ? t('Change the password') : t('Set a password')} description={t('For the Cloud-Init user. Rackoon never shows it again.')} label={t('Cloud-Init password of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose}>
      {(errors) => (
        <>
          <TextField label={t('New password')} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} error={errors.cipassword} autoFocus />
          <TextField label={t('Repeat the password')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ?? undefined} />
        </>
      )}
    </EditDialog>
  );
}

/** One OpenSSH public key per line; stored URL-encoded like Proxmox's own dialog. */
function SshKeysDialog({ ctx, onClose }: DialogProps) {
  const cur = current(ctx.config, 'sshkeys');
  const initial = decodeSshKeys(cur);
  const [text, setText] = useState(initial);
  const lines = sshKeyLines(text);
  const bad = lines.findIndex((l) => !/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)\s+[A-Za-z0-9+/=]+(\s.*)?$/.test(l));
  const err = bad >= 0 ? t('Key {n} is not an OpenSSH public key (type, key, comment).', { n: bad + 1 }) : null;
  const same = text.trim() === initial.trim();
  const draft = err ? null : same ? {} : draftOf({ sshkeys: text.trim() ? encodeSshKeys(text.trim()) : undefined });
  return (
    <EditDialog ctx={ctx} title={t('Edit SSH public keys')} label={t('SSH keys of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose} wide>
      {(errors) => (
        <Field label={t('Public keys')} hint={tn(lines.length, 'One key per line. {n} key.', 'One key per line. {n} keys.')} error={errors.sshkeys ?? err ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              className="input mono"
              rows={6}
              value={text}
              spellCheck={false}
              autoComplete="off"
              placeholder="ssh-ed25519 AAAA… user@host"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          )}
        </Field>
      )}
    </EditDialog>
  );
}

function IpConfigDialog({ ctx, onClose, cfgKey, nic }: DialogProps & { cfgKey: string; nic: string }) {
  const cur = current(ctx.config, cfgKey) ?? '';
  const initial = parseIpConfig(cur);
  const [c, setC] = useState<IpConfig>(initial);
  const e = ipErrors(c);
  const changed = JSON.stringify(c) !== JSON.stringify(initial);
  const value = formatIpConfig(c, cur);
  const draft = e.ip || e.gw || e.ip6 ? null : !changed ? {} : draftOf({ [cfgKey]: value || undefined });
  return (
    <EditDialog ctx={ctx} title={t('Edit IP config of {key}', { key: nic })} label={t('IP config of {name}', { name: ctx.guest.name })} draft={draft} onClose={onClose} wide>
      {(errors) => (
        <>
          <IpFields c={c} set={setC} />
          <KeyErrors errors={errors} keys={[cfgKey]} />
        </>
      )}
    </EditDialog>
  );
}
