/**
 * Add to Vault (docs/decisions/settings-groups.md): one form that asks what a person knows — what
 * it’s for, where it is, a username and a password or sign-in key, what the assistant should know — and picks the kind
 * itself (a username means a website login, none a sign-in key), saying which as it is typed. “Paste a server key
 * instead” takes a private key. Everything an expert chooses — the kind itself (a Connection to an MCP server, a
 * Password for an HTTP API, a new server key Whombat makes), how it signs in, a header's or parameter's name — waits
 * under **Advanced**. Save creates the entry and then runs “Check connection” (`vault.create` doesn't check), so the
 * card opens with its first result. A website login is not signed in to on its own: the agent signs in with it in its
 * browser, in your chats. A server key opens on its servers, which are added next.
 */
import { VAULT_AUTH_LABELS, vaultProblemOf } from '@whombat/client';
import { useTheAgent, useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import {
  VAULT_COPY,
  VAULT_DESCRIPTION_MAX,
  VAULT_NAME_MAX,
  VAULT_NEW_TEMPLATES,
  VAULT_SECRET_MAX,
  VAULT_SSH_COPY,
  VAULT_SSH_PASSPHRASE_MAX,
  VAULT_SSH_PRIVATE_KEY_MAX,
  VAULT_TEMPLATE_DEFS,
  type VaultAuthType,
  type VaultNetwork,
  type VaultTemplate,
  vaultTemplateDescription,
} from '@whombat/core/vault';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useOpenBurrow } from '../../app/routing/openBurrow';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { TEMPLATE_AUTHS, VAULT_TEXT } from './copy';
import { Fold } from './Fold';
import {
  createBody,
  emptyForm,
  type FieldProblems,
  formFor,
  formProblems,
  guessTemplate,
  looksLikePrivateKey,
  type SshKeyMode,
  sshKeyFields,
  type VaultForm,
} from './model';
import { useVaultWords } from './useVaultWords';
import styles from './Vault.module.css';

export interface AddToVaultModalProps {
  burrow: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The home network list, so Advanced can say what's reachable. */
  networks: readonly VaultNetwork[];
  /** The new entry, to open it. */
  onAdded: (entryId: string) => void;
}

export function AddToVaultModal({ burrow, open, onOpenChange, networks, onAdded }: AddToVaultModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} width="lg">
      {open && (
        <AddForm burrow={burrow} networks={networks} onDone={() => onOpenChange(false)} onAdded={onAdded} />
      )}
    </Modal>
  );
}

/**
 * The kinds Advanced offers, in a person's order: the everyday ones first, only those core's `VAULT_NEW_TEMPLATES` makes
 * (no `secret` entry, and no Connection: an MCP server is connected in Connections, Whombat vault-simplify.md VLT-30).
 */
const PREFERRED_ORDER: readonly VaultTemplate[] = ['login', 'token', 'basic', 'ssh'];
const KIND_ORDER: readonly VaultTemplate[] = [
  ...PREFERRED_ORDER.filter((t) => (VAULT_NEW_TEMPLATES as readonly VaultTemplate[]).includes(t)),
  ...VAULT_NEW_TEMPLATES.filter((t) => !PREFERRED_ORDER.includes(t)),
];

type SetField = <K extends keyof VaultForm>(key: K, value: VaultForm[K]) => void;

function AddForm({
  burrow,
  networks,
  onDone,
  onAdded,
}: {
  burrow: string;
  networks: readonly VaultNetwork[];
  onDone: () => void;
  onAdded: (entryId: string) => void;
}) {
  const toast = useToast();
  const create = useVaultWrite(api.vault.create, burrow);
  const check = useVaultWrite(api.vault.check, burrow);
  const { words: agent } = useTheAgent(burrow);
  // Null: the form picks the kind from what is typed (`guessTemplate`); Advanced, or “Paste a server key”, chooses one.
  const [kind, setKind] = useState<VaultTemplate | null>(null);
  const [form, setForm] = useState<VaultForm>(emptyForm('token'));
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const set: SetField = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const template = kind ?? guessTemplate(form);

  const choose = (next: VaultTemplate | null) => {
    setKind(next);
    setProblems({});
    setMessage(null);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    const saved = formFor(template, form);
    const local = sshKeyFields(formProblems(template, saved));
    if (template !== 'ssh' && looksLikePrivateKey(form.secret)) local.secret = VAULT_TEXT.keyInPassword;
    setProblems(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    try {
      const created = await create.mutateAsync({ params: { burrow }, body: createBody(template, saved) });
      if (created.status !== 'ok') return;
      const entry = created.data.entry;
      let summary: string | null = null;
      // A login signs in on Test sign-in; an SSH key is checked per server, once it has some (VT-S05).
      if (entry.kind !== 'secret' && entry.kind !== 'login' && entry.kind !== 'ssh') {
        try {
          const checked = await check.mutateAsync({ params: { burrow, entryId: entry.id } });
          if (checked.status === 'ok') summary = checked.data.result.summary;
        } catch {
          // The entry is saved; its card says “Not checked yet” and offers “Check again”.
        }
      }
      toast.show(summary ? VAULT_TEXT.addedChecked(entry.name, summary) : VAULT_TEXT.added(entry.name));
      onAdded(entry.id);
      onDone();
    } catch (error) {
      const p = vaultProblemOf(error);
      const fields = sshKeyFields(p.fields);
      setProblems(fields);
      setMessage(p.message ?? (Object.keys(fields).length ? null : VAULT_TEXT.failed));
    }
  }

  const busy = create.isPending || check.isPending;
  const kindId = useId();

  return (
    <div className={styles.modal}>
      <div className={styles.modalHeading}>
        <SectionLabel>{VAULT_TEXT.kicker}</SectionLabel>
        <ModalTitle className={styles.modalTitle}>{VAULT_COPY.add}</ModalTitle>
      </div>
      <form className={styles.form} onSubmit={(e) => void save(e)} noValidate>
        {template === 'ssh' ? (
          <SshFields form={form} set={set} problems={problems} onPassword={() => choose(null)} />
        ) : (
          <Fields
            chosen={kind}
            template={template}
            form={form}
            set={set}
            problems={problems}
            onPasteKey={() => {
              set('sshMode', 'import');
              choose('ssh');
            }}
          />
        )}
        <p className={styles.savedAs} data-saved-as={template}>
          <strong>{VAULT_TEMPLATE_DEFS[template].label}</strong> ·{' '}
          {vaultTemplateDescription(template, agent.name)}
        </p>
        <Fold label={VAULT_TEXT.advanced} name="advanced">
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={kindId}>
                {VAULT_TEXT.kind}
              </label>
              <select
                id={kindId}
                className={styles.select}
                value={kind ?? ''}
                onChange={(e) => choose((e.target.value || null) as VaultTemplate | null)}
              >
                <option value="">{VAULT_TEXT.kindAuto}</option>
                {KIND_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {VAULT_TEMPLATE_DEFS[t].label}
                  </option>
                ))}
              </select>
            </div>
            {template === 'ssh' ? (
              <SshKeyChoice form={form} set={set} />
            ) : (
              <AdvancedFields template={template} form={form} set={set} problems={problems} />
            )}
          </div>
          {template !== 'ssh' && <p className={styles.hint}>{VAULT_TEXT.addressHint(networks)}</p>}
        </Fold>
        {message && (
          <p className={styles.error} role="alert">
            {message}
          </p>
        )}
        <div className={styles.modalActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="md" disabled={busy}>
              {VAULT_TEXT.cancel}
            </Button>
          </ModalClose>
          <Button type="submit" variant="primary" size="md" disabled={busy}>
            {check.isPending ? VAULT_TEXT.checking : create.isPending ? VAULT_TEXT.saving : VAULT_TEXT.save}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  error,
  hint,
  wide,
  children,
}: {
  label: string;
  error?: string;
  hint?: ReactNode;
  wide?: boolean;
  children: (props: { id: string; invalid: boolean; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const describedBy =
    [error ? `${id}-e` : null, hint ? `${id}-h` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`${styles.field} ${wide ? styles.fieldWide : ''}`}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children({ id, invalid: !!error, describedBy })}
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

/**
 * The everyday fields: what it’s for, where, a username (a website login's and a password's; while the kind is picked
 * from what is typed, empty means a sign-in key), the password or sign-in key, and what the assistant should know.
 */
function Fields({
  chosen,
  template,
  form,
  set,
  problems,
  onPasteKey,
}: {
  /** The kind chosen under Advanced; null while the form picks it. */
  chosen: VaultTemplate | null;
  template: VaultTemplate;
  form: VaultForm;
  set: SetField;
  problems: FieldProblems;
  onPasteKey: () => void;
}) {
  const words = useVaultWords(useOpenBurrow());
  const kind = VAULT_TEMPLATE_DEFS[template].kind;
  const saved = formFor(template, form);
  const plainHttp = /^http:\/\//i.test(saved.url);
  const withUsername = chosen === null || template === 'basic' || template === 'login';
  const password = template === 'basic' || template === 'login';
  const secretLabel =
    chosen === null && !password
      ? VAULT_TEXT.secretLabel.either
      : password
        ? VAULT_TEXT.secretLabel.password
        : VAULT_TEXT.secretLabel.token;
  return (
    <div className={styles.fields}>
      <Field label={VAULT_TEXT.whatFor} error={problems.name}>
        {({ id, invalid, describedBy }) => (
          <Input
            id={id}
            className={styles.input}
            maxLength={VAULT_NAME_MAX}
            placeholder={VAULT_TEXT.namePlaceholder[chosen === null ? 'basic' : template]}
            value={form.name}
            invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => set('name', e.target.value)}
          />
        )}
      </Field>
      <Field label={chosen === 'login' ? VAULT_TEXT.signInPage : VAULT_TEXT.address} error={problems.url}>
        {({ id, invalid, describedBy }) => (
          <Input
            id={id}
            className={styles.monoInput}
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            placeholder={
              chosen === null ? VAULT_TEXT.anyAddressPlaceholder : VAULT_TEXT.addressPlaceholder[template]
            }
            value={form.url}
            invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => set('url', e.target.value)}
          />
        )}
      </Field>
      {plainHttp && (
        <p className={`${styles.warning} ${styles.fieldWide}`} role="note">
          {VAULT_COPY.httpWarning}
        </p>
      )}
      {withUsername && (
        <Field
          label={VAULT_TEXT.username}
          error={problems['auth.username']}
          hint={chosen === null ? VAULT_TEXT.usernameHint : undefined}
        >
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              className={styles.input}
              autoComplete="off"
              spellCheck={false}
              value={form.username}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => set('username', e.target.value)}
            />
          )}
        </Field>
      )}
      {!(saved.auth === 'none' && kind === 'mcp') && (
        <Field label={secretLabel} error={problems.secret} hint={VAULT_TEXT.secretHint}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              className={styles.input}
              maxLength={VAULT_SECRET_MAX}
              placeholder={VAULT_TEXT.secretPlaceholder}
              value={form.secret}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => set('secret', e.target.value)}
            />
          )}
        </Field>
      )}
      <div className={`${styles.fieldWide} ${styles.switchMode}`}>
        <Button variant="link" size="sm" onClick={onPasteKey}>
          {VAULT_TEXT.pasteKey}
        </Button>
      </div>
      <Field label={words.descriptionLabel} wide>
        {({ id }) => (
          <textarea
            id={id}
            className={styles.textarea}
            maxLength={VAULT_DESCRIPTION_MAX}
            placeholder={words.descriptionPlaceholder}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

/**
 * Advanced, for an API or an MCP server: how it signs in (a bearer token, a header, a query parameter, or nothing for an
 * MCP server on your network) and the header's or parameter's name.
 */
function AdvancedFields({
  template,
  form,
  set,
  problems,
}: {
  template: VaultTemplate;
  form: VaultForm;
  set: SetField;
  problems: FieldProblems;
}) {
  const auths = TEMPLATE_AUTHS[template];
  const auth = formFor(template, form).auth;
  return (
    <>
      {auths.length > 1 && (
        <Field label={VAULT_TEXT.signsIn} error={problems.auth}>
          {({ id, invalid, describedBy }) => (
            <select
              id={id}
              className={styles.select}
              value={auth}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(e) => set('auth', e.target.value as VaultAuthType)}
            >
              {auths.map((a) => (
                <option key={a} value={a}>
                  {VAULT_AUTH_LABELS[a]}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {auth === 'header' && (
        <Field label={VAULT_TEXT.headerName} error={problems['auth.name']}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              className={styles.monoInput}
              spellCheck={false}
              placeholder="X-API-Key"
              value={form.headerName}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => set('headerName', e.target.value)}
            />
          )}
        </Field>
      )}
      {auth === 'query' && (
        <Field label={VAULT_TEXT.queryName} error={problems['auth.name']} hint={VAULT_COPY.queryWarning}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              className={styles.monoInput}
              spellCheck={false}
              placeholder="api_key"
              value={form.queryName}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => set('queryName', e.target.value)}
            />
          )}
        </Field>
      )}
    </>
  );
}

const SSH_MODES: readonly { value: SshKeyMode; label: string }[] = [
  { value: 'generate', label: VAULT_SSH_COPY.generate },
  { value: 'import', label: VAULT_SSH_COPY.useOwn },
];

/** Advanced, for a server key: Whombat makes a new one, or you paste your own. */
function SshKeyChoice({ form, set }: { form: VaultForm; set: SetField }) {
  return (
    <div className={`${styles.field} ${styles.fieldWide}`}>
      {/* The control's own legend says “Key” to screen readers; this is its visible label. */}
      <span className={styles.fieldLabel} aria-hidden="true">
        {VAULT_SSH_COPY.key}
      </span>
      <SegmentedControl<SshKeyMode>
        label={VAULT_SSH_COPY.key}
        className={styles.segmented}
        value={form.sshMode}
        onChange={(mode) => set('sshMode', mode)}
        options={SSH_MODES}
      />
    </div>
  );
}

/**
 * A server key's form: what it’s for, what the assistant should know, then your own key with the passphrase
 * that opens it once — or, chosen under Advanced, a new key Whombat makes (its private half never leaves the Whombat).
 * Its servers are added on the entry, next.
 */
function SshFields({
  form,
  set,
  problems,
  onPassword,
}: {
  form: VaultForm;
  set: SetField;
  problems: FieldProblems;
  onPassword: () => void;
}) {
  const words = useVaultWords(useOpenBurrow());
  return (
    <div className={styles.fields}>
      <Field label={VAULT_TEXT.whatFor} error={problems.name} wide>
        {({ id, invalid, describedBy }) => (
          <Input
            id={id}
            className={styles.input}
            maxLength={VAULT_NAME_MAX}
            placeholder={VAULT_TEXT.namePlaceholder.ssh}
            value={form.name}
            invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => set('name', e.target.value)}
          />
        )}
      </Field>
      {form.sshMode === 'import' ? (
        <SshImportFields
          privateKey={form.privateKey}
          passphrase={form.passphrase}
          onPrivateKey={(v) => set('privateKey', v)}
          onPassphrase={(v) => set('passphrase', v)}
          problems={problems}
        />
      ) : (
        <p className={`${styles.hint} ${styles.fieldWide}`}>{VAULT_SSH_COPY.generateHint}</p>
      )}
      <p className={`${styles.hint} ${styles.fieldWide}`}>{VAULT_TEXT.serversNext}</p>
      <div className={`${styles.fieldWide} ${styles.switchMode}`}>
        <Button variant="link" size="sm" onClick={onPassword}>
          {VAULT_TEXT.usePassword}
        </Button>
      </div>
      <Field label={words.descriptionLabel} wide>
        {({ id }) => (
          <textarea
            id={id}
            className={styles.textarea}
            maxLength={VAULT_DESCRIPTION_MAX}
            placeholder={words.descriptionPlaceholder}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

/** “Private key” (the whole file, write-only once saved) and “Passphrase (if it has one)”, used once at import. */
export function SshImportFields({
  privateKey,
  passphrase,
  onPrivateKey,
  onPassphrase,
  problems,
}: {
  privateKey: string;
  passphrase: string;
  onPrivateKey: (value: string) => void;
  onPassphrase: (value: string) => void;
  problems: FieldProblems;
}) {
  return (
    <>
      <Field label={VAULT_SSH_COPY.privateKey} error={problems.privateKey} hint={VAULT_TEXT.secretHint} wide>
        {({ id, invalid, describedBy }) => (
          <textarea
            id={id}
            className={`${styles.textarea} ${styles.keyArea}`}
            maxLength={VAULT_SSH_PRIVATE_KEY_MAX}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            placeholder={VAULT_TEXT.ssh.privateKeyPlaceholder}
            value={privateKey}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(e) => onPrivateKey(e.target.value)}
          />
        )}
      </Field>
      <Field
        label={VAULT_SSH_COPY.passphrase}
        error={problems.passphrase}
        hint={VAULT_SSH_COPY.passphraseHint}
      >
        {({ id, invalid, describedBy }) => (
          <Input
            id={id}
            type="password"
            autoComplete="off"
            className={styles.input}
            maxLength={VAULT_SSH_PASSPHRASE_MAX}
            value={passphrase}
            invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => onPassphrase(e.target.value)}
          />
        )}
      </Field>
    </>
  );
}
