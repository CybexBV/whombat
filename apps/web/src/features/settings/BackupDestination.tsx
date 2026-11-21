/**
 * Choosing where a managed Whombat's backups go (AP-260, updates.md UP-F1; contracts 0.22 CT-142): an S3-compatible
 * bucket, an SFTP server or NAS (this Whombat's own key goes into the server's `authorized_keys`; the server's host key
 * is pinned, pasted or trusted on first use and shown to compare), a restic REST server, or a disk labelled
 * `WHOMBAT-BACKUP` on its machine. The same form is the claim's “Protect your Whombat” step and Settings → This
 * Whombat → BACKUPS. A Whombat before contracts 0.22 (no `backup.destinations`) takes the REST server only.
 *
 * Secrets travel only in the `secret` op `backup.configureDestination` and are cleared from the form once sent.
 * Not in the mocks: onboarding's choice cards (the Billing page's) and the settings' fields.
 */
import {
  ACCOUNTS_TEXT,
  BACKUP_SETUP_TEXT,
  type BackupForm,
  type BackupKind,
  backupErrorText,
  destinationInput,
  emptyBackupForm,
  MANAGED_TEXT,
} from '@whombat/client/managed';
import { type ApplianceSession, type BackupDestinationResult, sessionOps } from '@whombat/client/session';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { copyText } from '../../components/CopyButton';
import { Input } from '../../components/Input';
import styles from './BackupDestination.module.css';

const T = BACKUP_SETUP_TEXT;

export { backupErrorText };

/** What you are told after saving: whether old backups are safe from this box, and the host key to compare. */
export function savedNotes(result: BackupDestinationResult): string[] {
  return [
    ACCOUNTS_TEXT.appendOnly[result.appendOnly] ?? null,
    result.hostKeyFingerprint ? T.hostKeyPinned(result.hostKeyFingerprint) : null,
  ].filter((n): n is string => n !== null);
}

export interface BackupDestinationFormProps {
  session: ApplianceSession;
  /** The kinds offered (`BACKUP_KINDS`). */
  kinds: readonly BackupKind[];
  onSaved: (result: BackupDestinationResult) => void;
  /** Buttons after “Save and check” (Cancel, Skip for now). */
  extraActions?: ReactNode;
  /** `lg` in the claim's step (the sign-in frame), `md` in Settings. */
  size?: 'md' | 'lg';
}

export function BackupDestinationForm({
  session,
  kinds,
  onSaved,
  extraActions,
  size = 'md',
}: BackupDestinationFormProps) {
  const [form, setForm] = useState<BackupForm>(() => emptyBackupForm(kinds[0] ?? 'rest'));
  const [invalid, setInvalid] = useState<{ field: keyof BackupForm; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const legend = useId();
  const kind = kinds.includes(form.kind) ? form.kind : (kinds[0] ?? 'rest');

  const set = (patch: Partial<BackupForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setInvalid(null);
    setError(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const check = destinationInput({ ...form, kind });
    if (!check.ok) {
      setInvalid({ field: check.field, error: check.error });
      document.getElementById(`${legend}-${check.field}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await sessionOps.backupConfigure(session, check.input);
      setForm(emptyBackupForm(kind));
      onSaved(result);
    } catch (err) {
      setError(backupErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: keyof BackupForm,
    label: string,
    options: {
      type?: string;
      placeholder?: string;
      autoComplete?: string;
      hint?: string;
      mono?: boolean;
    } = {},
  ) => {
    const id = `${legend}-${name}`;
    const bad = invalid?.field === name;
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <Input
          id={id}
          size={size}
          type={options.type ?? 'text'}
          autoComplete={options.autoComplete ?? 'off'}
          spellCheck={false}
          placeholder={options.placeholder}
          className={options.mono ? styles.mono : undefined}
          invalid={bad}
          aria-describedby={bad ? `${id}-error` : options.hint ? `${id}-hint` : undefined}
          value={form[name]}
          onChange={(e) => set({ [name]: e.target.value })}
        />
        {bad ? (
          <span id={`${id}-error`} className={styles.fieldError} role="alert">
            {invalid.error}
          </span>
        ) : options.hint ? (
          <span id={`${id}-hint`} className={styles.hint}>
            {options.hint}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <form className={styles.form} onSubmit={(e) => void save(e)} noValidate>
      {kinds.length > 1 ? (
        <fieldset className={styles.kinds} aria-labelledby={legend}>
          <legend id={legend} className={styles.label}>
            {T.kindLegend}
          </legend>
          {kinds.map((k) => (
            <label key={k} className={styles.kind} data-selected={k === kind}>
              <input
                type="radio"
                name={legend}
                value={k}
                className={styles.kindRadio}
                checked={k === kind}
                onChange={() => set({ kind: k })}
              />
              <span className={styles.kindTitle}>{T.kinds[k].title}</span>
              <span className={styles.kindMeta}>{T.kinds[k].meta}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className={styles.hint}>{T.onlyRest}</p>
      )}

      {kind === 's3' && (
        <>
          {field('s3Endpoint', T.s3Endpoint, { placeholder: T.s3EndpointPlaceholder, mono: true })}
          <div className={styles.pair}>
            {field('s3Bucket', T.s3Bucket, { mono: true })}
            {field('s3Folder', T.s3Folder, { mono: true })}
          </div>
          <div className={styles.pair}>
            {field('s3AccessKeyId', T.s3AccessKeyId, { mono: true })}
            {field('s3SecretAccessKey', T.s3SecretAccessKey, {
              type: 'password',
              autoComplete: 'new-password',
            })}
          </div>
          {field('s3Region', T.s3Region, { mono: true, hint: T.s3Hint })}
        </>
      )}

      {kind === 'sftp' && (
        <>
          {/* The box's key first: you add it on the server before Save checks the connection (BK-19). */}
          <SshKey session={session} />
          <div className={styles.pair}>
            {field('sftpHost', T.sftpHost, { placeholder: T.sftpHostPlaceholder, mono: true })}
            {field('sftpPort', T.sftpPort, { placeholder: '22', mono: true })}
          </div>
          <div className={styles.pair}>
            {field('sftpPath', T.sftpPath, { placeholder: T.sftpPathPlaceholder, mono: true })}
            {field('sftpUser', T.sftpUser, { mono: true })}
          </div>
          {field('sftpHostKey', T.sftpHostKey, { mono: true, hint: T.sftpHostKeyHint })}
        </>
      )}

      {kind === 'rest' && (
        <>
          {field('restRepository', T.restRepository, {
            placeholder: T.restRepositoryPlaceholder,
            mono: true,
            hint: T.restHint,
          })}
          <div className={styles.pair}>
            {field('restUser', T.restUser)}
            {field('restPassword', T.restPassword, { type: 'password', autoComplete: 'new-password' })}
          </div>
        </>
      )}

      {kind === 'disk' && <p className={styles.note}>{T.diskHelp}</p>}

      {field('adoptPassword', T.adopt, { type: 'password' })}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="primary" size={size === 'lg' ? 'lg' : 'sm'} type="submit" disabled={busy}>
          {busy ? T.saving : T.save}
        </Button>
        {extraActions}
      </div>
    </form>
  );
}

/** This Whombat's SFTP key (`backup.sshPublicKey`, made on first ask), to add to the server's `authorized_keys`. */
function SshKey({ session }: { session: ApplianceSession }) {
  const [key, setKey] = useState<{ publicKey: string; fingerprint: string } | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again
  useEffect(() => {
    let live = true;
    setKey(null);
    sessionOps.backupSshPublicKey(session).then(
      (k) => live && setKey(k),
      () => live && setKey('failed'),
    );
    return () => {
      live = false;
    };
  }, [session, attempt]);
  return (
    <div className={styles.key} aria-live="polite">
      <span className={styles.label}>{T.sftpKeyLabel}</span>
      {key === null ? (
        <span className={styles.hint}>{T.sftpKeyLoading}</span>
      ) : key === 'failed' ? (
        <span className={styles.keyFailed}>
          {T.sftpKeyFailed}{' '}
          <Button variant="link" size="xs" onClick={() => setAttempt((n) => n + 1)}>
            {MANAGED_TEXT.retry}
          </Button>
        </span>
      ) : (
        <>
          <span className={styles.note}>{T.sftpKeyHelp}</span>
          <code className={styles.keyText} data-testid="backup-ssh-key">
            {key.publicKey}
          </code>
          <span className={styles.keyFoot}>
            <span className={styles.hint}>{T.sftpKeyFingerprint(key.fingerprint)}</span>
            {/* No toast: the claim's step runs outside the app's providers. */}
            <span className={styles.copyWrap}>
              {copied && (
                <span className={styles.hint} role="status">
                  {T.keyCopied}
                </span>
              )}
              <button
                type="button"
                className={styles.copy}
                onClick={() => void copyText(key.publicKey).then(setCopied)}
              >
                {T.copyKey}
              </button>
            </span>
          </span>
        </>
      )}
    </div>
  );
}
