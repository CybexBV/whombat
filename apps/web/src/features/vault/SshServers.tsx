/**
 * An SSH key's SERVERS (docs/decisions/vault.md VT-S04…VT-S06, VT-S13; AP-600): a row per server — status dot, its
 * name (what agents call it), `user@host:port`, the last check — with Check, Edit and Remove; “Add server” and Edit
 * open the server modal. Adding a server checks it at once, and the easiest way to add one is to ask the assistant in
 * chat (it puts the key there with the server's password, used once). A Whombat that trusts a server's key the first
 * time it connects asks nothing then; a key it can't trust on its own asks one
 * question in words — “Is staging the server at staging.example.com?”, or for a **changed** key, on the failing edge,
 * whether it was set up again — answered with **Yes, trust it**. The fingerprint and the command to compare
 * it with wait under Technical details.
 */
import { vaultKeptPasswordLine, vaultProblemOf } from '@whombat/client';
import { useVaultNetworks, useVaultWrite } from '@whombat/client/react';
import { api, VAULT_LIMIT_MESSAGES } from '@whombat/core/contracts';
import {
  VAULT_SSH_COPY,
  VAULT_SSH_HOST_MAX,
  VAULT_SSH_PRODUCTION_COPY,
  VAULT_SSH_SERVER_NAME_MAX,
  VAULT_SSH_SERVERS_MAX,
  VAULT_SSH_USERNAME_MAX,
  type VaultEntryDetail,
  type VaultNetwork,
  type VaultSshServer,
  vaultSshHostKeyLabel,
  vaultSshServerCheckLine,
  vaultSshServerTarget,
  vaultSshTrustCopy,
  vaultSshTrustQuestion,
} from '@whombat/core/vault';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { ToggleRow } from '../../components/Toggle';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { portsText, VAULT_TEXT } from './copy';
import { Fold } from './Fold';
import {
  CHECK_LABELS,
  CHECK_TONES,
  type FieldProblems,
  type ServerForm,
  serverBody,
  serverChanges,
  serverFormOf,
  serverMoves,
  serverProblemOf,
  serverProblems,
} from './model';
import { useVaultWords } from './useVaultWords';
import styles from './Vault.module.css';

type EntryProps = { burrow: string; entry: VaultEntryDetail };

export function SshServers({ burrow, entry, onStale }: EntryProps & { onStale: () => void }) {
  const words = useVaultWords(burrow);
  const [editing, setEditing] = useState<VaultSshServer | 'new' | null>(null);
  const full = entry.servers.length >= VAULT_SSH_SERVERS_MAX;
  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <SectionLabel as="h3">{VAULT_SSH_COPY.servers}</SectionLabel>
        <Button
          variant="secondary"
          size="sm"
          iconStart={<Icon name="add" size={14} />}
          disabled={full}
          title={full ? VAULT_LIMIT_MESSAGES.servers : undefined}
          onClick={() => setEditing('new')}
        >
          {VAULT_SSH_COPY.addServer}
        </Button>
      </div>
      {entry.servers.length === 0 ? (
        <p className={styles.hint}>{VAULT_SSH_COPY.noServers}</p>
      ) : (
        <ul className={styles.rows} aria-label={VAULT_SSH_COPY.servers}>
          {entry.servers.map((server) => (
            <ServerRow
              key={server.id}
              burrow={burrow}
              entry={entry}
              server={server}
              onEdit={() => setEditing(server)}
              onStale={onStale}
            />
          ))}
        </ul>
      )}
      {full ? (
        <p className={styles.hint}>{VAULT_LIMIT_MESSAGES.servers}</p>
      ) : (
        <p className={styles.hint}>{words.serversByChat}</p>
      )}
      <ServerModal
        burrow={burrow}
        entry={entry}
        server={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </div>
  );
}

function ServerRow({
  burrow,
  entry,
  server,
  onEdit,
  onStale,
}: EntryProps & { server: VaultSshServer; onEdit: () => void; onStale: () => void }) {
  const toast = useToast();
  const viewer = useBurrowViewer(burrow);
  const check = useVaultWrite(api.vault.checkSshServer, burrow);
  const remove = useVaultWrite(api.vault.removeSshServer, burrow);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const params = { burrow, entryId: entry.id, serverId: server.id };
  const status = server.check.status;
  const busy = check.isPending || remove.isPending;
  // A password kept for a server that doesn't take keys: shown as set, never the value (CT-1664).
  const kept = vaultKeptPasswordLine(server.password, Date.now(), viewer.timeZone);

  return (
    <li className={styles.server} data-server={server.name}>
      <div className={styles.serverHead}>
        <span className={styles.serverDot}>
          <StatusDot tone={CHECK_TONES[status]} size={8} label={CHECK_LABELS[status]} />
        </span>
        <span className={styles.serverMain}>
          <span className={styles.serverTitle}>
            <span className={styles.serverName}>{server.name}</span>
            {server.production && (
              <Tag variant="outline" tone="warn" className={styles.production}>
                {VAULT_SSH_PRODUCTION_COPY.badge}
              </Tag>
            )}
            <span className={styles.serverTarget}>{vaultSshServerTarget(server)}</span>
          </span>
          <span
            className={styles.serverCheck}
            data-tone={status === 'failing' ? 'bad' : undefined}
            aria-live="polite"
          >
            {check.isPending
              ? VAULT_TEXT.checking
              : vaultSshServerCheckLine(server, Date.now(), viewer.timeZone)}
          </span>
          {kept && (
            <span className={styles.serverKept} data-kept-password>
              {kept}
            </span>
          )}
        </span>
        <span className={styles.serverActions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-label={`${VAULT_SSH_COPY.check} ${server.name}`}
            onClick={async () => {
              setProblem(null);
              try {
                await check.mutateAsync({ params });
              } catch (error) {
                setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.checkFailed);
              }
            }}
          >
            {VAULT_SSH_COPY.check}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`${VAULT_SSH_COPY.edit} ${server.name}`}
            onClick={onEdit}
          >
            {VAULT_SSH_COPY.edit}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={`${VAULT_SSH_COPY.remove} ${server.name}`}
            aria-expanded={confirming}
            onClick={() => setConfirming(true)}
          >
            {VAULT_SSH_COPY.remove}
          </Button>
        </span>
      </div>
      {server.seenHostKey && !confirming && (
        <TrustCard burrow={burrow} entry={entry} server={server} onStale={onStale} />
      )}
      {confirming && (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>{VAULT_SSH_COPY.removeServer}</p>
          <Button
            variant="secondary"
            size="sm"
            disabled={remove.isPending}
            onClick={async () => {
              setProblem(null);
              try {
                const result = await remove.mutateAsync({ params });
                if (result.status === 'ok') toast.show(VAULT_TEXT.ssh.serverRemoved(server.name));
              } catch (error) {
                setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
              }
            }}
          >
            {VAULT_SSH_COPY.remove}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            {VAULT_TEXT.cancel}
          </Button>
        </div>
      )}
      {problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
    </li>
  );
}

/**
 * The trust card: one question in words about the server (`vaultSshTrustQuestion`) and **Yes, trust it**, which
 * sends the fingerprint the last check saw: the server trusts it only if it still shows that key, and signs in once. A
 * changed key (a pin that differs) asks on the failing edge. Under Technical details: the fingerprint, how to
 * compare it on the server, and for a changed key the one trusted until now.
 */
function TrustCard({
  burrow,
  entry,
  server,
  onStale,
}: EntryProps & { server: VaultSshServer; onStale: () => void }) {
  const toast = useToast();
  const trust = useVaultWrite(api.vault.trustSshHostKey, burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const seen = server.seenHostKey;
  const titleId = useId();
  if (!seen) return null;
  const copy = vaultSshTrustCopy(seen);
  const changed = server.hostKey !== null;
  return (
    <section className={styles.trust} data-tone={changed ? 'bad' : undefined} aria-labelledby={titleId}>
      <p id={titleId} className={styles.trustQuestion}>
        {vaultSshTrustQuestion(server, changed)}
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={trust.isPending}
          onClick={async () => {
            setProblem(null);
            try {
              const result = await trust.mutateAsync({
                params: { burrow, entryId: entry.id, serverId: server.id },
                body: { fingerprint: seen.fingerprint },
              });
              if (result.status === 'ok')
                toast.show(VAULT_TEXT.ssh.trusted(server.name, result.data.result.summary));
            } catch (error) {
              // The server shows another key now (`host_key_mismatch`): the card shows the new one to compare.
              setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
              onStale();
            }
          }}
        >
          {trust.isPending ? VAULT_TEXT.ssh.trusting : copy.action}
        </Button>
      </div>
      {problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
      <Fold label={VAULT_TEXT.technical} name="technical">
        <p className={styles.trustText}>
          {changed ? `${VAULT_TEXT.ssh.newHostKey}: ` : null}
          <span className={styles.trustFingerprint}>{copy.fingerprint}</span> {copy.compare}{' '}
          <code>{copy.command}</code> {copy.after}
        </p>
        {changed && server.hostKey && (
          <p className={styles.trustBefore}>
            {VAULT_TEXT.ssh.trustedBefore(
              `${server.hostKey.fingerprint} (${vaultSshHostKeyLabel(server.hostKey.algorithm)})`,
            )}
          </p>
        )}
      </Fold>
    </section>
  );
}

/* Add server / Edit server ------------------------------------------------------------------------ */

function ServerModal({
  burrow,
  entry,
  server,
  open,
  onOpenChange,
}: EntryProps & { server: VaultSshServer | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md">
      {open && (
        <ServerFormView burrow={burrow} entry={entry} server={server} onDone={() => onOpenChange(false)} />
      )}
    </Modal>
  );
}

/** Where a server may be (VT-S06), in the address hint's words: the internet on port 22, the home network's list. */
export function sshHostHint(networks: readonly VaultNetwork[]): string {
  return networks.length
    ? `${VAULT_TEXT.ssh.publicHosts} On your network: ${networks
        .map((n) => `${n.cidr} · ${portsText(n.ports)}`)
        .join('; ')}.`
    : `${VAULT_TEXT.ssh.publicHosts} Nothing on your network is on the home network list yet.`;
}

function ServerFormView({
  burrow,
  entry,
  server,
  onDone,
}: EntryProps & { server: VaultSshServer | null; onDone: () => void }) {
  const toast = useToast();
  const networks = useVaultNetworks({});
  const add = useVaultWrite(api.vault.addSshServer, burrow);
  const update = useVaultWrite(api.vault.updateSshServer, burrow);
  const check = useVaultWrite(api.vault.checkSshServer, burrow);
  // Production (AC-11, AP-618): the agent's commands reach it only after your yes.
  const [form, setForm] = useState<ServerForm>(() => serverFormOf(server ?? undefined));
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const set = (key: keyof ServerForm, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const busy = add.isPending || update.isPending || check.isPending;
  const moves = server !== null && serverMoves(server, form);

  async function save(e: FormEvent) {
    e.preventDefault();
    const local = serverProblems(form);
    setProblems(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    try {
      if (server) {
        const body = serverChanges(server, form);
        if (!body) return onDone();
        const result = await update.mutateAsync({
          params: { burrow, entryId: entry.id, serverId: server.id },
          body,
        });
        if (result.status === 'ok') {
          onDone();
          toast.show(VAULT_TEXT.saved);
        }
        return;
      }
      const body = serverBody(form);
      const added = await add.mutateAsync({ params: { burrow, entryId: entry.id }, body });
      if (added.status !== 'ok') return;
      // Check it at once: it signs in, trusting the key it shows (VS-10), or an older Whombat waits for Trust (VT-S05).
      let summary: string | null = null;
      try {
        const checked = await check.mutateAsync({
          params: { burrow, entryId: entry.id, serverId: added.data.serverId },
        });
        if (checked.status === 'ok') summary = checked.data.result.summary;
      } catch {
        // The server is saved; its row says “Not checked yet” and offers Check.
      }
      onDone();
      toast.show(
        summary
          ? VAULT_TEXT.ssh.serverAddedChecked(body.name, summary)
          : VAULT_TEXT.ssh.serverAdded(body.name),
      );
    } catch (error) {
      const p = serverProblemOf(error);
      setProblems(p.fields);
      setMessage(p.message ?? (Object.keys(p.fields).length ? null : VAULT_TEXT.failed));
    }
  }

  return (
    <form className={styles.modal} onSubmit={(e) => void save(e)} noValidate>
      <div className={styles.modalHeading}>
        <SectionLabel tone="mut">{VAULT_TEXT.ssh.serverKicker(entry.name)}</SectionLabel>
        <ModalTitle className={styles.modalTitle}>
          {server ? VAULT_SSH_COPY.editServer : VAULT_SSH_COPY.addServer}
        </ModalTitle>
      </div>
      <div className={styles.fields}>
        <ServerField
          label={VAULT_SSH_COPY.serverName}
          error={problems.name}
          hint={VAULT_SSH_COPY.serverNameHint}
        >
          {(props) => (
            <Input
              {...props}
              className={styles.monoInput}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              maxLength={VAULT_SSH_SERVER_NAME_MAX}
              placeholder={VAULT_TEXT.ssh.namePlaceholder}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </ServerField>
        <ServerField label={VAULT_SSH_COPY.username} error={problems.username}>
          {(props) => (
            <Input
              {...props}
              className={styles.monoInput}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              maxLength={VAULT_SSH_USERNAME_MAX}
              placeholder={VAULT_TEXT.ssh.usernamePlaceholder}
              value={form.username}
              onChange={(e) => set('username', e.target.value)}
            />
          )}
        </ServerField>
        <ServerField
          label={VAULT_SSH_COPY.host}
          error={problems.host}
          hint={sshHostHint(networks.data?.networks ?? [])}
        >
          {(props) => (
            <Input
              {...props}
              className={styles.monoInput}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              inputMode="url"
              maxLength={VAULT_SSH_HOST_MAX + 2}
              placeholder={VAULT_TEXT.ssh.hostPlaceholder}
              value={form.host}
              onChange={(e) => set('host', e.target.value)}
            />
          )}
        </ServerField>
        <ServerField label={VAULT_SSH_COPY.port} error={problems.port} narrow>
          {(props) => (
            <Input
              {...props}
              className={styles.monoInput}
              inputMode="numeric"
              autoComplete="off"
              maxLength={5}
              placeholder={VAULT_TEXT.ssh.portPlaceholder}
              value={form.port}
              onChange={(e) => set('port', e.target.value)}
            />
          )}
        </ServerField>
      </div>
      <ToggleRow
        label={VAULT_SSH_PRODUCTION_COPY.label}
        hint={VAULT_SSH_PRODUCTION_COPY.hint}
        checked={form.production}
        onCheckedChange={(production) => setForm((f) => ({ ...f, production }))}
      />
      {moves && (
        <p className={styles.warning} role="note">
          {VAULT_SSH_COPY.hostChangeNote}
        </p>
      )}
      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}
      <div className={styles.modalActions}>
        <ModalClose asChild>
          <Button variant="secondary" size="xl" disabled={busy}>
            {VAULT_TEXT.cancel}
          </Button>
        </ModalClose>
        <Button type="submit" variant="primary" size="xl" padX={20} disabled={busy}>
          {check.isPending
            ? VAULT_TEXT.checking
            : add.isPending || update.isPending
              ? VAULT_TEXT.saving
              : server
                ? VAULT_TEXT.save
                : VAULT_SSH_COPY.addServer}
        </Button>
      </div>
    </form>
  );
}

function ServerField({
  label,
  error,
  hint,
  narrow,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  narrow?: boolean;
  children: (props: { id: string; invalid: boolean; 'aria-describedby': string | undefined }) => ReactNode;
}) {
  const id = useId();
  const describedBy =
    [error ? `${id}-e` : null, hint ? `${id}-h` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`${styles.field} ${narrow ? styles.fieldPort : ''}`}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children({ id, invalid: !!error, 'aria-describedby': describedBy })}
      {error && (
        <p id={`${id}-e`} className={styles.fieldError}>
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-h`} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}
