/**
 * An open Vault entry (docs/decisions/settings-groups.md): what the assistant should know, the PASSWORD or SIGN-IN
 * KEY (write-only: Replace), the CONNECTION with “Check again” (a website login's only its page and username),
 * an MCP server's TOOLS (a switch each, “New” for a tool that appeared or changed since), the agent's one row — “Neo can
 * use this”, On · Off (`AgentAccess`) — RECENT USE, and last
 * a closed **Danger** fold with Remove from Vault behind its confirm. A `secret` entry packs used before has no secret,
 * CONNECTION or keys: one line that nothing uses it, and Remove. An SSH key has SERVERS and KEY instead (its fingerprint and `authorized_keys` line under Technical
 * details), and the agent's key covers all of its servers. Writes answer the entry (`useVaultWrite`), so every block
 * updates at once.
 */

import { createLink } from '@tanstack/react-router';
import {
  VAULT_MCP_MOVE_TEXT,
  VAULT_TOTP_TEXT,
  vaultEntryRemoveNote,
  vaultEntryStaysMcp,
  vaultProblemOf,
  vaultTotpLine,
} from '@whombat/client';
import { useTheAgent, useVaultEntry, useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import {
  type VaultEntryDetail,
  vaultCheckLine,
  vaultCopy,
  vaultEntryShapeProblems,
  vaultRotateNotice,
  vaultSecretLine,
  vaultTotpProblem,
  vaultUseRow,
} from '@whombat/core/vault';
import { type FormEvent, useId, useState } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { Input } from '../../components/Input';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { DangerFold } from '../settings/DangerFold';
import { AgentAccess } from './AgentAccess';
import { secretBlockLabel, signsInText, VAULT_TEXT } from './copy';
import { type FieldProblems, inCommands, OUTCOME_TONES } from './model';
import { SshPublicKey } from './SshKey';
import { SshServers } from './SshServers';
import { useVaultWords } from './useVaultWords';
import styles from './Vault.module.css';

const RouterButtonLink = createLink(ButtonLink);

export function VaultEntryDetailView({
  burrow,
  entryId,
  onRemoved,
}: {
  burrow: string;
  entryId: string;
  onRemoved: () => void;
}) {
  const query = useVaultEntry({ params: { burrow, entryId } });
  if (query.error && !query.data)
    return (
      <div className={styles.block}>
        <ErrorNote message={VAULT_TEXT.entryFailed} onRetry={() => void query.refetch()} />
      </div>
    );
  if (!query.data)
    return (
      <div className={styles.block} aria-busy="true">
        <SkeletonRows count={3} lines={2} />
      </div>
    );
  const { entry } = query.data;
  // One row for the agent: on or off for it, nobody to give a key to (VS-03; AP-4000, AP-4940).
  const keys = <AgentAccess burrow={burrow} entry={entry} />;
  if (entry.kind === 'ssh')
    return (
      <>
        <About burrow={burrow} entry={entry} />
        <SshServers burrow={burrow} entry={entry} onStale={() => void query.refetch()} />
        <SshPublicKey burrow={burrow} entry={entry} />
        {keys}
        <RecentUse burrow={burrow} entry={entry} />
        <Remove burrow={burrow} entry={entry} onRemoved={onRemoved} />
      </>
    );
  return (
    <>
      {vaultEntryStaysMcp(entry) && <MoveToConnections entry={entry} />}
      <About burrow={burrow} entry={entry} />
      {entry.kind === 'secret' ? (
        <div className={styles.block}>
          <p className={styles.hint}>{VAULT_TEXT.secretUnused}</p>
        </div>
      ) : (
        <>
          <Secret burrow={burrow} entry={entry} />
          {entry.kind === 'login' && <AuthenticatorKey burrow={burrow} entry={entry} />}
          {entry.kind === 'login' ? (
            <LoginConnection burrow={burrow} entry={entry} />
          ) : (
            <Connection burrow={burrow} entry={entry} />
          )}
          {entry.kind === 'mcp' && <Tools burrow={burrow} entry={entry} />}
          {keys}
        </>
      )}
      <RecentUse burrow={burrow} entry={entry} />
      <Remove burrow={burrow} entry={entry} onRemoved={onRemoved} />
    </>
  );
}

type EntryProps = { burrow: string; entry: VaultEntryDetail };

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  return text ? (
    <p id={id} className={styles.fieldError}>
      {text}
    </p>
  ) : null;
}

/* WHAT SHOULD AGENTS KNOW? ------------------------------------------------------------------------ */

/** The note agents read (and the name and address), with Edit (`vault.update`). */
function About({ burrow, entry }: EntryProps) {
  const toast = useToast();
  const words = useVaultWords(burrow);
  const update = useVaultWrite(api.vault.update, burrow);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [description, setDescription] = useState(entry.description);
  const [url, setUrl] = useState(entry.url ?? '');
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const ids = { name: useId(), description: useId(), url: useId(), errors: useId() };
  const login = entry.auth?.type === 'form';

  const start = () => {
    setName(entry.name);
    setDescription(entry.description);
    setUrl(entry.url ?? '');
    setProblems({});
    setMessage(null);
    setEditing(true);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...(name.trim() !== entry.name ? { name: name.trim() } : {}),
      ...(description.trim() !== entry.description ? { description: description.trim() } : {}),
      ...(entry.url !== null && url.trim() !== entry.url ? { url: url.trim() } : {}),
    };
    if (Object.keys(body).length === 0) return setEditing(false);
    const local: FieldProblems = {};
    if (!name.trim()) local.name = 'Give it a name.';
    if (body.url !== undefined) {
      const url = vaultEntryShapeProblems(
        { kind: entry.kind, url: body.url, auth: entry.auth },
        'update',
      ).find((p) => p.field === 'url');
      if (url) local.url = url.message;
    }
    setProblems(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    try {
      const result = await update.mutateAsync({ params: { burrow, entryId: entry.id }, body });
      if (result.status === 'ok') {
        setEditing(false);
        toast.show(VAULT_TEXT.saved);
      }
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblems(p.fields);
      setMessage(p.message ?? (Object.keys(p.fields).length ? null : VAULT_TEXT.failed));
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <SectionLabel as="h3">{words.descriptionLabel.toUpperCase()}</SectionLabel>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={start}>
            {VAULT_TEXT.edit}
          </Button>
        )}
      </div>
      {editing ? (
        <form className={styles.form} onSubmit={(e) => void save(e)} noValidate>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={ids.name}>
                {VAULT_TEXT.name}
              </label>
              <Input
                id={ids.name}
                className={styles.input}
                maxLength={60}
                value={name}
                invalid={!!problems.name}
                aria-describedby={problems.name ? `${ids.name}-e` : undefined}
                onChange={(e) => setName(e.target.value)}
              />
              <FieldError id={`${ids.name}-e`} text={problems.name} />
            </div>
            {entry.url !== null && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={ids.url}>
                  {login ? VAULT_TEXT.signInPage : VAULT_TEXT.address}
                </label>
                <Input
                  id={ids.url}
                  className={styles.monoInput}
                  spellCheck={false}
                  autoCapitalize="off"
                  value={url}
                  invalid={!!problems.url}
                  aria-describedby={problems.url ? `${ids.url}-e` : undefined}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <FieldError id={`${ids.url}-e`} text={problems.url} />
              </div>
            )}
            <div className={`${styles.field} ${styles.fieldWide}`}>
              <label className={styles.fieldLabel} htmlFor={ids.description}>
                {words.descriptionLabel}
              </label>
              <textarea
                id={ids.description}
                className={styles.textarea}
                maxLength={500}
                value={description}
                placeholder={words.descriptionPlaceholder}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          {entry.url !== null && <p className={styles.hint}>{VAULT_TEXT.editAddressHint}</p>}
          {message && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="sm" disabled={update.isPending}>
              {update.isPending ? VAULT_TEXT.saving : VAULT_TEXT.save}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {VAULT_TEXT.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.description}>{entry.description || words.noDescription}</p>
      )}
    </div>
  );
}

/* SECRET ------------------------------------------------------------------------------------------ */

/** “Set · replaced 2 days ago” and Replace, a write-only input (VT-04, VT-71). */
function Secret({ burrow, entry }: EntryProps) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const { tag: uiLocale } = useWebI18n();
  const toast = useToast();
  const viewer = useBurrowViewer(burrow);
  const setSecret = useVaultWrite(api.vault.setSecret, burrow);
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');
  const [username, setUsername] = useState('');
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const ids = { value: useId(), username: useId() };
  const login = entry.auth?.type === 'basic' || entry.auth?.type === 'form';
  const none = entry.auth?.type === 'none';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value) return setProblems({ secret: 'Paste the secret.' });
    setProblems({});
    setMessage(null);
    try {
      const result = await setSecret.mutateAsync({
        params: { burrow, entryId: entry.id },
        body: {
          value,
          ...((entry.auth?.type === 'basic' || entry.auth?.type === 'form') &&
          username.trim() &&
          username.trim() !== entry.auth.username
            ? { username: username.trim() }
            : {}),
        },
      });
      if (result.status === 'ok') {
        setValue('');
        setReplacing(false);
        toast.show(VAULT_TEXT.secretReplaced);
      }
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblems(p.fields.value ? { secret: p.fields.value } : p.fields);
      setMessage(p.message ?? (Object.keys(p.fields).length ? null : VAULT_TEXT.failed));
    }
  }

  return (
    <div className={styles.block}>
      <SectionLabel as="h3">{secretBlockLabel(entry.auth)}</SectionLabel>
      {none ? (
        <p className={styles.hint}>{VAULT_TEXT.signsInWithNothing}</p>
      ) : replacing ? (
        <form className={styles.form} onSubmit={(e) => void save(e)} noValidate>
          <div className={styles.fields}>
            {login && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} htmlFor={ids.username}>
                  {VAULT_TEXT.username}
                </label>
                <Input
                  id={ids.username}
                  className={styles.input}
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            )}
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={ids.value}>
                {login ? VAULT_TEXT.secretLabel.password : VAULT_TEXT.secretLabel.token}
              </label>
              <Input
                id={ids.value}
                type="password"
                autoComplete="off"
                className={styles.input}
                placeholder={VAULT_TEXT.secretPlaceholder}
                value={value}
                invalid={!!problems.secret}
                aria-describedby={problems.secret ? `${ids.value}-e` : `${ids.value}-h`}
                onChange={(e) => setValue(e.target.value)}
              />
              <FieldError id={`${ids.value}-e`} text={problems.secret} />
            </div>
          </div>
          <p id={`${ids.value}-h`} className={styles.hint}>
            {VAULT_TEXT.replaceHint}
          </p>
          {message && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="sm" disabled={setSecret.isPending || !value}>
              {setSecret.isPending ? VAULT_TEXT.saving : VAULT_TEXT.save}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setReplacing(false);
                setValue('');
                setProblems({});
              }}
            >
              {VAULT_TEXT.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.line}>
          <span className={styles.lineText}>
            {vaultSecretLine(entry, Date.now(), viewer.timeZone, uiLocale)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setUsername(
                entry.auth?.type === 'basic' || entry.auth?.type === 'form' ? entry.auth.username : '',
              );
              setReplacing(true);
            }}
          >
            {VAULT_COPY.replace}
          </Button>
        </div>
      )}
    </div>
  );
}

/* AUTHENTICATOR KEY ------------------------------------------------------------------------------- */

/**
 * A website login's authenticator key (Whombat vault-simplify.md VLT-46; AP-6660): set or not, never the key; Add,
 * Replace and Remove through `vault.setTotp`, a setup key or `otpauth://` link pasted, checked here first.
 */
function AuthenticatorKey({ burrow, entry }: EntryProps) {
  const toast = useToast();
  const viewer = useBurrowViewer(burrow);
  const { words: agent } = useTheAgent(burrow);
  const setTotp = useVaultWrite(api.vault.setTotp, burrow);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const id = useId();
  const line = vaultTotpLine(entry.totp, Date.now(), viewer.timeZone);

  async function send(totp: string | null) {
    setMessage(null);
    try {
      const result = await setTotp.mutateAsync({ params: { burrow, entryId: entry.id }, body: { totp } });
      if (result.status === 'ok') {
        setValue('');
        setEditing(false);
        toast.show(totp === null ? VAULT_TOTP_TEXT.removed : VAULT_TOTP_TEXT.saved);
      }
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblem(p.fields.totp ?? null);
      setMessage(p.message ?? (p.fields.totp ? null : VAULT_TEXT.failed));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const local = vaultTotpProblem(value);
    setProblem(local);
    if (local) return;
    // Sent and then dropped: nothing keeps the key in the page.
    const typed = value;
    setValue('');
    await send(typed.trim());
  }

  return (
    <div className={styles.block} data-block="totp">
      <SectionLabel as="h3">{VAULT_TOTP_TEXT.label}</SectionLabel>
      {editing ? (
        <form className={styles.form} onSubmit={(e) => void save(e)} noValidate autoComplete="off">
          <div className={styles.fields}>
            <div className={`${styles.field} ${styles.fieldWide}`}>
              <label className={styles.fieldLabel} htmlFor={id}>
                {VAULT_TOTP_TEXT.field}
              </label>
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                autoCapitalize="off"
                className={styles.monoInput}
                placeholder={VAULT_TOTP_TEXT.placeholder}
                value={value}
                invalid={!!problem}
                aria-describedby={problem ? `${id}-e` : `${id}-h`}
                onChange={(e) => {
                  setValue(e.target.value);
                  setProblem(null);
                }}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
              />
              <FieldError id={`${id}-e`} text={problem ?? undefined} />
            </div>
          </div>
          <p id={`${id}-h`} className={styles.hint}>
            {VAULT_TOTP_TEXT.hint}
          </p>
          {message && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="sm" disabled={setTotp.isPending || !value.trim()}>
              {setTotp.isPending ? VAULT_TEXT.saving : VAULT_TEXT.save}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setValue('');
                setProblem(null);
                setMessage(null);
              }}
            >
              {VAULT_TEXT.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className={styles.line}>
            <span className={styles.lineText}>{line ?? VAULT_TOTP_TEXT.notSet(agent.name)}</span>
            <span className={styles.actions}>
              {line && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={setTotp.isPending}
                  onClick={() => void send(null)}
                >
                  {VAULT_TOTP_TEXT.remove}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                {line ? VAULT_TOTP_TEXT.replace : VAULT_TOTP_TEXT.add}
              </Button>
            </span>
          </div>
          {message && (
            <p className={styles.error} role="alert">
              {message}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* MOVE IT TO CONNECTIONS --------------------------------------------------------------------------- */

/**
 * An MCP server the Vault couldn't move to Connections (VLT-30; AP-6670): it keeps working, and its page points at
 * Connections' Custom MCP server with its address filled in.
 */
function MoveToConnections({ entry }: { entry: VaultEntryDetail }) {
  return (
    <div className={styles.block} data-block="move">
      <div className={styles.warnNote} role="note" data-notice="move">
        <p className={styles.noticeText}>
          <strong>{VAULT_MCP_MOVE_TEXT.title}</strong>
        </p>
        <p className={styles.noticeText}>{VAULT_MCP_MOVE_TEXT.body}</p>
        <div>
          <RouterButtonLink
            variant="secondary"
            size="sm"
            to="/settings"
            search={
              {
                tab: 'connections',
                connection: 'custom_mcp',
                ...(entry.url ? { url: entry.url } : {}),
              } as never
            }
          >
            {VAULT_MCP_MOVE_TEXT.link}
          </RouterButtonLink>
        </div>
      </div>
    </div>
  );
}

/* CONNECTION -------------------------------------------------------------------------------------- */

/** The address, how it signs in, the last check and “Check again” (VT-44). */
function Connection({ burrow, entry }: EntryProps) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const { tag: uiLocale } = useWebI18n();
  const viewer = useBurrowViewer(burrow);
  const check = useVaultWrite(api.vault.check, burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const auth = entry.auth;
  return (
    <div className={styles.block}>
      <SectionLabel as="h3">{VAULT_COPY.connection}</SectionLabel>
      <span className={styles.mono}>{entry.url}</span>
      {auth && <span className={styles.rowMeta}>{signsInText(auth)}</span>}
      {auth?.type === 'query' && <p className={styles.warning}>{VAULT_COPY.queryWarning}</p>}
      <div className={styles.line}>
        <span
          className={styles.lineText}
          data-tone={entry.check.status === 'failing' ? 'bad' : undefined}
          aria-live="polite"
        >
          {check.isPending
            ? VAULT_TEXT.checking
            : vaultCheckLine(entry.check, Date.now(), viewer.timeZone, uiLocale)}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={check.isPending}
          onClick={async () => {
            setProblem(null);
            try {
              await check.mutateAsync({ params: { burrow, entryId: entry.id } });
            } catch (error) {
              setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.checkFailed);
            }
          }}
        >
          {VAULT_COPY.checkAgain}
        </Button>
      </div>
      {problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * A website login's CONNECTION (VT-D28; since contracts 0.125 CT-1235, AP-5242): the sign-in page and who it signs in
 * as. Nothing tests it from here: the agent signs in with it in its browser, in your chats (HE-42).
 */
function LoginConnection({ entry }: EntryProps) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const auth = entry.auth?.type === 'form' ? entry.auth : null;
  return (
    <div className={styles.block}>
      <SectionLabel as="h3">{VAULT_COPY.connection}</SectionLabel>
      <span className={styles.mono}>{entry.url}</span>
      {auth && <span className={styles.rowMeta}>{signsInText(auth)}</span>}
    </div>
  );
}

/* TOOLS ------------------------------------------------------------------------------------------- */

/** An MCP server's tools, on or off; a new or changed tool is off with “New” until you decide (VT-44). */
function Tools({ burrow, entry }: EntryProps) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const setTool = useVaultWrite(api.vault.setTool, burrow);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className={styles.block}>
      <SectionLabel as="h3">{VAULT_COPY.tools}</SectionLabel>
      {entry.tools.length === 0 ? (
        <p className={styles.hint}>{VAULT_TEXT.noTools}</p>
      ) : (
        <ul className={styles.rows} aria-label={VAULT_COPY.tools}>
          {entry.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              name={tool.name}
              description={tool.description}
              isNew={tool.isNew}
              enabled={tool.enabled}
              pending={setTool.isPending}
              onChange={async (enabled) => {
                setProblem(null);
                try {
                  await setTool.mutateAsync({
                    params: { burrow, entryId: entry.id, tool: tool.name },
                    body: { enabled },
                  });
                } catch (error) {
                  setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
                }
              }}
            />
          ))}
        </ul>
      )}
      {entry.toolsIgnored > 0 && <p className={styles.hint}>{VAULT_COPY.toolsIgnored(entry.toolsIgnored)}</p>}
      {problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function ToolRow(props: {
  name: string;
  description: string;
  isNew: boolean;
  enabled: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const id = useId();
  return (
    <li className={styles.row}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>
          <span id={`${id}-name`} className={styles.toolName}>
            {props.name}
          </span>
          {props.isNew && (
            <Tag tone="brand" aria-label="New tool">
              {VAULT_COPY.newBadge}
            </Tag>
          )}
        </span>
        {props.description && (
          <span id={`${id}-desc`} className={styles.rowMeta}>
            {props.description}
          </span>
        )}
      </span>
      <Toggle
        size="sm"
        checked={props.enabled}
        disabled={props.pending}
        aria-labelledby={`${id}-name`}
        aria-describedby={props.description ? `${id}-desc` : undefined}
        onCheckedChange={props.onChange}
      />
    </li>
  );
}

/* RECENT USE -------------------------------------------------------------------------------------- */

/** The entry's history (VT-52, VT-53): agent · what · when · outcome. */
function RecentUse({ burrow, entry }: EntryProps) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const viewer = useBurrowViewer(burrow);
  const names = (id: string) => (viewer.principal(id) ? { shortName: viewer.shortName(id) } : undefined);
  return (
    <div className={styles.block}>
      <SectionLabel as="h3">{VAULT_COPY.recentUse}</SectionLabel>
      {entry.recentUses.length === 0 ? (
        <p className={styles.hint}>{VAULT_TEXT.noUses}</p>
      ) : (
        <ul className={styles.rows} aria-label={VAULT_COPY.recentUse}>
          {entry.recentUses.map((use) => {
            const row = vaultUseRow(use, {
              names,
              now: Date.now(),
              timeZone: viewer.timeZone,
            });
            return (
              <li key={use.id} className={styles.use}>
                <span className={styles.useWhat}>
                  {row.agent} · <code>{row.what}</code> ·{' '}
                  <span className={styles.outcome} style={{ color: `var(--${OUTCOME_TONES[use.outcome]})` }}>
                    {row.outcome}
                  </span>
                </span>
                <span className={styles.useWhen}>{row.when}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* Remove from Vault ------------------------------------------------------------------------------- */

/**
 * The rotate notice when an entry whose key was in the agent's commands is removed (AC-34): core's `vaultRotateNotice`, except for
 * an SSH key, whose “Generate a new key … on the servers below” has no entry left to act on.
 */
function removeRotateText(agentName: string, entry: Pick<VaultEntryDetail, 'name' | 'kind'>): string {
  const notice = vaultRotateNotice({ agentName, entryName: entry.name, kind: entry.kind });
  return entry.kind === 'ssh' ? VAULT_TEXT.sshRemovedRotate(agentName, entry.name) : notice.text;
}

function Remove({ burrow, entry, onRemoved }: EntryProps & { onRemoved: () => void }) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const toast = useToast();
  const words = useVaultWords(burrow);
  const { words: agent } = useTheAgent(burrow);
  const remove = useVaultWrite(api.vault.remove, burrow);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A key that was in the agent's commands (AC-34, AP-619): it may have kept a copy, so you hear it first.
  const rotate = entry.key && inCommands(entry) ? [removeRotateText(agent.name, entry)] : [];
  return (
    <div className={styles.block} data-block="danger">
      <DangerFold label={VAULT_TEXT.danger}>
        <div className={styles.foldBody}>
          {confirming && rotate.length > 0 && (
            <div className={styles.warnNote} role="note" data-notice="rotate">
              {rotate.map((text) => (
                <p key={text} className={styles.noticeText}>
                  {text}
                </p>
              ))}
            </div>
          )}
          {confirming ? (
            <div className={styles.confirm}>
              <p className={styles.confirmText}>
                {[words.removeConfirm(entry.name), vaultEntryRemoveNote(entry)].filter(Boolean).join(' ')}
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={remove.isPending}
                onClick={async () => {
                  setProblem(null);
                  try {
                    const result = await remove.mutateAsync({ params: { burrow, entryId: entry.id } });
                    if (result.status === 'ok') {
                      toast.show(VAULT_TEXT.removed(entry.name));
                      onRemoved();
                    }
                  } catch (error) {
                    setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
                  }
                }}
              >
                {VAULT_COPY.remove}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {VAULT_TEXT.cancel}
              </Button>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                {VAULT_COPY.remove}
              </Button>
            </div>
          )}
          {problem && (
            <p className={styles.error} role="alert">
              {problem}
            </p>
          )}
        </div>
      </DangerFold>
    </div>
  );
}
