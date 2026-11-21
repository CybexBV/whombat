/**
 * An SSH key's KEY: one plain sentence — Whombat made it and
 * keeps it, or it is your own — and under **Technical details** what only someone at a server's command line needs:
 * the `authorized_keys` line (`restrict <public key> whombat-<entry key>`) with Copy, where it goes, the fingerprint,
 * and the two ways to change the key — “Generate a new key” and “Replace with my own key” — each behind a dialog that
 * says the old key stops working on every server at once. The private key is never shown: there is nothing to read back.
 */
import { vaultProblemOf } from '@whombat/client';
import { useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import {
  VAULT_SSH_COPY,
  VAULT_SSH_KEY_TYPE_LABELS,
  type VaultEntryDetail,
  vaultSecretLine,
  vaultSshAuthorizedKeysLine,
} from '@whombat/core/vault';
import { type FormEvent, useState } from 'react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { Modal, ModalClose, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { SshImportFields } from './AddToVaultModal';
import { VAULT_TEXT } from './copy';
import { Fold } from './Fold';
import { type FieldProblems, replaceKeyBody, replaceKeyProblems } from './model';
import styles from './Vault.module.css';

type EntryProps = { burrow: string; entry: VaultEntryDetail };

/** “ED25519 · made by Whombat · added 5 days ago”. */
export function sshKeyMeta(entry: VaultEntryDetail, now: number, timeZone: string): string | null {
  if (entry.auth?.type !== 'ssh_key') return null;
  const when = vaultSecretLine(entry, now, timeZone).replace(/^Set · /, '');
  return [VAULT_SSH_KEY_TYPE_LABELS[entry.auth.keyType], VAULT_TEXT.ssh.origin[entry.auth.origin], when].join(
    ' · ',
  );
}

export function SshPublicKey({ burrow, entry }: EntryProps) {
  const viewer = useBurrowViewer(burrow);
  const [generating, setGenerating] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const auth = entry.auth?.type === 'ssh_key' ? entry.auth : null;
  const line = auth ? vaultSshAuthorizedKeysLine(auth.publicKey, entry.id) : null;
  return (
    <div className={styles.block} data-block="ssh-key">
      <SectionLabel as="h3">{VAULT_TEXT.ssh.keyHeading}</SectionLabel>
      <p className={styles.hint}>{auth ? VAULT_TEXT.ssh.keyIntro[auth.origin] : VAULT_TEXT.ssh.noKey}</p>
      <Fold label={VAULT_TEXT.technical} name="technical">
        {auth && line ? (
          <>
            <div className={styles.codeHead}>
              <p className={styles.hint}>{VAULT_SSH_COPY.authorizedKeysHint}</p>
              <CopyButton text={line} copied={VAULT_TEXT.ssh.lineCopied} className={styles.copy}>
                {VAULT_SSH_COPY.copy}
              </CopyButton>
            </div>
            <pre className={styles.code}>
              <code>{line}</code>
            </pre>
            <div className={styles.fingerprint}>
              <span className={styles.mono}>{auth.fingerprint}</span>
              <span className={styles.rowMeta}>{sshKeyMeta(entry, Date.now(), viewer.timeZone)}</span>
            </div>
          </>
        ) : null}
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={() => setGenerating(true)}>
            {VAULT_SSH_COPY.generateNew}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
            {VAULT_SSH_COPY.replaceOwn}
          </Button>
        </div>
      </Fold>
      <GenerateDialog burrow={burrow} entry={entry} open={generating} onOpenChange={setGenerating} />
      <ReplaceDialog burrow={burrow} entry={entry} open={replacing} onOpenChange={setReplacing} />
    </div>
  );
}

/**
 * “Generate a new key”: the server makes a new pair at once; the old key stops working everywhere (VT-S03). Also the
 * rotate notice's action after a key in the agent's commands was taken back (AC-34, AP-619).
 */
export function GenerateDialog({
  burrow,
  entry,
  open,
  onOpenChange,
  onGenerated,
}: EntryProps & { open: boolean; onOpenChange: (open: boolean) => void; onGenerated?: () => void }) {
  const toast = useToast();
  const generate = useVaultWrite(api.vault.generateSshKey, burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const change = (next: boolean) => {
    if (!next) setProblem(null);
    onOpenChange(next);
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      kicker={VAULT_TEXT.ssh.kicker}
      title={VAULT_TEXT.ssh.generateTitle(entry.name)}
      confirmLabel={VAULT_TEXT.ssh.generateConfirm}
      busy={generate.isPending}
      error={problem}
      onConfirm={async () => {
        setProblem(null);
        try {
          const result = await generate.mutateAsync({ params: { burrow, entryId: entry.id } });
          if (result.status === 'ok') {
            change(false);
            onGenerated?.();
            toast.show(VAULT_TEXT.ssh.generated);
          }
        } catch (error) {
          setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
        }
      }}
    >
      {VAULT_SSH_COPY.replaceWarning}
    </ConfirmDialog>
  );
}

/**
 * “Replace with my own key”: the take-over dialog's language with the import fields in it. The key and its passphrase
 * are a secret op (VT-S03): sent once, never kept in the form after it closes.
 */
function ReplaceDialog({
  burrow,
  entry,
  open,
  onOpenChange,
}: EntryProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md">
      {open && <ReplaceForm burrow={burrow} entry={entry} onDone={() => onOpenChange(false)} />}
    </Modal>
  );
}

function ReplaceForm({ burrow, entry, onDone }: EntryProps & { onDone: () => void }) {
  const toast = useToast();
  const replace = useVaultWrite(api.vault.replaceSshKey, burrow);
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const local = replaceKeyProblems(privateKey, passphrase);
    setProblems(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    try {
      const result = await replace.mutateAsync({
        params: { burrow, entryId: entry.id },
        body: replaceKeyBody(privateKey, passphrase),
      });
      if (result.status === 'ok') {
        onDone();
        toast.show(VAULT_TEXT.ssh.replaced);
      }
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblems(p.fields);
      setMessage(p.message ?? (Object.keys(p.fields).length ? null : VAULT_TEXT.failed));
    }
  }

  return (
    <form className={styles.modal} onSubmit={(e) => void save(e)} noValidate>
      <div className={styles.modalHeading}>
        <SectionLabel tone="mut">{VAULT_TEXT.ssh.kicker}</SectionLabel>
        <ModalTitle className={styles.modalTitle}>{VAULT_TEXT.ssh.replaceTitle(entry.name)}</ModalTitle>
      </div>
      <p className={styles.explainer}>{VAULT_SSH_COPY.replaceWarning}</p>
      <div className={styles.fields}>
        <SshImportFields
          privateKey={privateKey}
          passphrase={passphrase}
          onPrivateKey={setPrivateKey}
          onPassphrase={setPassphrase}
          problems={problems}
        />
      </div>
      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}
      <div className={styles.modalActions}>
        <ModalClose asChild>
          <Button variant="secondary" size="xl" disabled={replace.isPending}>
            {VAULT_TEXT.cancel}
          </Button>
        </ModalClose>
        <Button type="submit" variant="primary" size="xl" padX={20} disabled={replace.isPending}>
          {replace.isPending ? VAULT_TEXT.saving : VAULT_TEXT.ssh.replaceConfirm}
        </Button>
      </div>
    </form>
  );
}
