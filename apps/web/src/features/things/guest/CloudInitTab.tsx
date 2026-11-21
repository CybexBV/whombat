/**
 * A guest's Cloud-Init (ported from Rackoon's `CloudInitTab`): the user, its password (set twice, never shown, and
 * removable), SSH keys (one per line, kept URL-encoded as Proxmox does), the DNS domain and servers, package upgrades
 * at the first start, and each network device's IPv4 and IPv6 addresses, each checked and sent through the review.
 */
import {
  currentValue,
  decodeSshKeys,
  encodeSshKeys,
  formatIpConfig,
  type IpConfig,
  ipConfigWords,
  ipErrors,
  isOn,
  keysOf,
  MASK,
  NET_RE,
  parseIpConfig,
  rowValue,
  sshKeyLabel,
  sshKeyLines,
  sshKeysError,
} from '@whombat/client/hosts';
import { useState } from 'react';
import { Field, TextField } from '../manage/fields';
import { Card } from '../parts';
import styles from '../Things.module.css';
import { type EditCtx, EditDialog } from './EditDialog';
import { EditBtn, KeyErrors, platformName, Row } from './editParts';
import { DnsDialog, IpFields, RemoveDialog } from './hardwareDialogs';
import { FlagDialog, TextKeyDialog } from './OptionsTab';

export function CloudInitTab({ ctx }: { ctx: EditCtx }) {
  const [open, setOpen] = useState<string | null>(null);
  const cfg = ctx.config;
  const v = cfg.values;
  const name = ctx.guest.name;
  const lock = (k: string) => (cfg.restricted?.includes(k) ? platformName(cfg) : undefined);
  const next = (k: string, fmt: (x: string | undefined) => string) => {
    const r = rowValue(cfg, k);
    return r.next === undefined ? undefined : fmt(r.removed ? undefined : r.next);
  };
  const keys = sshKeyLines(decodeSshKeys(v.sshkeys));
  const keysText = (x: string | undefined) => {
    const n = sshKeyLines(decodeSshKeys(x)).length;
    return n ? `${n} ${n === 1 ? 'key' : 'keys'}` : 'None';
  };
  const nets = keysOf(cfg, NET_RE);
  const close = () => setOpen(null);
  const p = { ctx, onClose: close };
  return (
    <>
      <Card title="Cloud-Init" meta="Read by the guest when it starts">
        <div className={styles.rows}>
          <Row
            title="User"
            value={v.ciuser ?? 'The image’s default'}
            mono={!!v.ciuser}
            muted={!v.ciuser}
            next={next('ciuser', (x) => x ?? 'the image’s default')}
            locked={lock('ciuser')}
            action={<EditBtn label="user" onClick={() => setOpen('ciuser')} />}
          />
          <Row
            title="Password"
            value={v.cipassword ? 'Set' : 'None'}
            muted={!v.cipassword}
            next={next('cipassword', (x) => (x ? 'a new one' : 'none'))}
            locked={lock('cipassword')}
            action={
              <>
                <EditBtn
                  label="password"
                  text={v.cipassword ? 'Change' : 'Set'}
                  onClick={() => setOpen('cipassword')}
                />
                {v.cipassword ? (
                  <EditBtn
                    label="password"
                    text="Remove…"
                    serious
                    onClick={() => setOpen('removePassword')}
                  />
                ) : null}
              </>
            }
          />
          <Row
            title="SSH keys"
            value={keysText(v.sshkeys)}
            muted={!keys.length}
            sub={keys.map(sshKeyLabel).join(', ') || undefined}
            next={next('sshkeys', keysText)}
            locked={lock('sshkeys')}
            action={<EditBtn label="SSH keys" onClick={() => setOpen('sshkeys')} />}
          />
          <Row
            title="DNS domain"
            value={v.searchdomain ?? 'The server’s'}
            mono={!!v.searchdomain}
            muted={!v.searchdomain}
            next={next('searchdomain', (x) => x ?? 'the server’s')}
            locked={lock('searchdomain')}
            action={<EditBtn label="DNS domain" onClick={() => setOpen('dns')} />}
          />
          <Row
            title="DNS servers"
            value={v.nameserver ?? 'The server’s'}
            mono={!!v.nameserver}
            muted={!v.nameserver}
            next={next('nameserver', (x) => x ?? 'the server’s')}
            locked={lock('nameserver')}
            action={<EditBtn label="DNS servers" onClick={() => setOpen('dns')} />}
          />
          <Row
            title="Upgrade packages"
            value={isOn(v.ciupgrade, true) ? 'Yes, at the first start' : 'No'}
            next={next('ciupgrade', (x) => (isOn(x, true) ? 'yes' : 'no'))}
            locked={lock('ciupgrade')}
            action={<EditBtn label="package upgrades" onClick={() => setOpen('ciupgrade')} />}
          />
          {nets.map((n) => {
            const k = `ipconfig${n.slice(3)}`;
            return (
              <Row
                key={k}
                title={`Addresses (${n})`}
                value={ipConfigWords(v[k])}
                mono={!!v[k] && parseIpConfig(v[k]).v4 === 'static'}
                muted={!v[k]}
                next={next(k, ipConfigWords)}
                locked={lock(k)}
                action={<EditBtn label={`addresses of ${n}`} onClick={() => setOpen(k)} />}
              />
            );
          })}
        </div>
      </Card>
      {open === 'ciuser' ? (
        <TextKeyDialog
          {...p}
          k="ciuser"
          label="User"
          mono
          hint="Empty: the image’s default user."
          check={(s) => (/^[a-z_][a-z0-9_-]*\$?$/i.test(s) ? null : 'Letters, digits, “_” and “-”.')}
        />
      ) : null}
      {open === 'cipassword' ? <PasswordDialog {...p} /> : null}
      {open === 'removePassword' ? (
        <RemoveDialog
          {...p}
          k="cipassword"
          title={`Remove the password of ${name}?`}
          description="The user then signs in with an SSH key only."
        />
      ) : null}
      {open === 'sshkeys' ? <SshKeysDialog {...p} /> : null}
      {open === 'dns' ? <DnsDialog {...p} /> : null}
      {open === 'ciupgrade' ? (
        <FlagDialog
          {...p}
          k="ciupgrade"
          title={`Package upgrades of ${name}`}
          label="Upgrade its packages at the first start"
          defaultOn
        />
      ) : null}
      {open?.startsWith('ipconfig') ? <IpDialog {...p} k={open} /> : null}
    </>
  );
}

/** A new password, typed twice (Proxmox only says whether one is set). */
function PasswordDialog({ ctx, onClose }: { ctx: EditCtx; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const mismatch = again && pw !== again ? 'The two differ.' : null;
  return (
    <EditDialog
      ctx={ctx}
      title={
        currentValue(ctx.config, 'cipassword')
          ? `New password for ${ctx.guest.name}`
          : `A password for ${ctx.guest.name}`
      }
      description="For the Cloud-Init user. Whombat doesn’t keep it or show it again."
      draft={!pw || pw !== again || pw === MASK ? null : { set: { cipassword: pw } }}
      onClose={onClose}
    >
      {(errors) => (
        <>
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={pw}
            autoFocus
            error={errors.cipassword}
            onChange={(e) => setPw(e.target.value)}
          />
          <TextField
            label="The same again"
            type="password"
            autoComplete="new-password"
            value={again}
            error={mismatch}
            onChange={(e) => setAgain(e.target.value)}
          />
        </>
      )}
    </EditDialog>
  );
}

/** OpenSSH public keys, one per line; stored URL-encoded like Proxmox's own dialog. */
function SshKeysDialog({ ctx, onClose }: { ctx: EditCtx; onClose: () => void }) {
  const initial = decodeSshKeys(currentValue(ctx.config, 'sshkeys'));
  const [text, setText] = useState(initial);
  const lines = sshKeyLines(text);
  const error = sshKeysError(text);
  const same = text.trim() === initial.trim();
  return (
    <EditDialog
      ctx={ctx}
      title={`SSH keys of ${ctx.guest.name}`}
      draft={
        error
          ? null
          : same
            ? {}
            : text.trim()
              ? { set: { sshkeys: encodeSshKeys(`${text.trim()}\n`) } }
              : { delete: ['sshkeys'] }
      }
      onClose={onClose}
      wide
    >
      {(errors) => (
        <Field
          label="Public keys"
          hint={`One per line. ${lines.length} ${lines.length === 1 ? 'key' : 'keys'}.`}
          error={error ?? errors.sshkeys}
        >
          {(f) => (
            <textarea
              className={styles.input}
              rows={7}
              value={text}
              spellCheck={false}
              autoComplete="off"
              placeholder="ssh-ed25519 AAAA… you@laptop"
              onChange={(e) => setText(e.target.value)}
              {...f}
            />
          )}
        </Field>
      )}
    </EditDialog>
  );
}

function IpDialog({ ctx, k, onClose }: { ctx: EditCtx; k: string; onClose: () => void }) {
  const prev = currentValue(ctx.config, k) ?? '';
  const [initial] = useState(() => parseIpConfig(prev));
  const [c, setC] = useState<IpConfig>(initial);
  const e = ipErrors(c);
  const changed = JSON.stringify(c) !== JSON.stringify(initial);
  const value = formatIpConfig(c, prev);
  return (
    <EditDialog
      ctx={ctx}
      title={`Addresses of ${ctx.guest.name} (net${k.slice(8)})`}
      draft={
        Object.values(e).some(Boolean)
          ? null
          : !changed
            ? {}
            : value
              ? { set: { [k]: value } }
              : { delete: [k] }
      }
      onClose={onClose}
      wide
    >
      {(errors) => (
        <>
          <IpFields c={c} set={setC} />
          <KeyErrors errors={errors} keys={[k]} />
        </>
      )}
    </EditDialog>
  );
}
