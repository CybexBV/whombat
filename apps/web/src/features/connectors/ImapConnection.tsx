/**
 * Email (IMAP) in Settings → Connections (Whombat connections-more.md CM-19…CM-22, CM-29; app connections-more-web.md
 * AP-2764…; not in the mocks, B-05): the Google and Microsoft 365 pages' YOUR ACCOUNT card for mail from any other
 * provider. Not connected: the address and its password; Whombat finds the servers and says them in one line with
 * Change, which opens the server fields (open from the start when nothing was found), and a known provider's hint.
 * Connected: the account, its servers and state, Change password, Disconnect, the check and Check again.
 */
import { Link } from '@tanstack/react-router';
import {
  draftFromSettings,
  hintLinks,
  IMAP_COPY,
  IMAP_DISCONNECTED_TEXT,
  type ImapConnectProblem,
  imapAvailable,
  imapConnectedText,
  imapConnection,
  imapConnectProblem,
  looksLikeEmail,
  MAIL_SECURITY_LABELS,
  type MailDraftField,
  type MailServersDraft,
  mailAccountLine,
  mailCheckName,
  settingsFromDraft,
  settingsServers,
  withSecurity,
} from '@whombat/client';
import {
  useCheckConnection,
  useImapConnect,
  useImapDiscover,
  useRemoveConnection,
} from '@whombat/client/react';
import type { ImapDiscoverResponse } from '@whombat/core/contracts';
import {
  type Connection,
  type ConnectorsStatus,
  type ImapProviderHint,
  imapGuessSettings,
  imapServersLine,
  type MailSecurity,
} from '@whombat/core/domain';
import { formatAgo } from '@whombat/core/text';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { useWebI18n } from '../../i18n/provider';
import styles from '../settings/SettingsScreen.module.css';
import k from './Catalog.module.css';
import { ExternalLink } from './CatalogParts';
import c from './Connectors.module.css';
import { NOT_A_LOGIN } from './notALogin';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A field as Google's app form draws one (mono label over the input), with its help and its problem under it. */
function Field({
  id,
  label,
  help,
  problem,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  problem?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={c.field}>
      <label className={c.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children}
      {problem ? (
        <p className={c.error} role="alert">
          {problem}
        </p>
      ) : help ? (
        <p className={c.hint}>{help}</p>
      ) : null}
    </div>
  );
}
/** How long the address rests before Whombat looks for its servers (blur looks at once). */
const DISCOVER_AFTER_MS = 700;

export function ImapConnection({ status }: { status: ConnectorsStatus }) {
  const ids = useId();
  const connection = imapConnection(status);
  if (!imapAvailable(status)) return <p className={c.intro}>{IMAP_COPY.update}</p>;
  return (
    <section className={styles.section} aria-labelledby={`${ids}-account`}>
      <SectionLabel as="h2" id={`${ids}-account`}>
        YOUR ACCOUNT
      </SectionLabel>
      <div className={styles.card}>
        {status.mode === 'off' ? (
          <p className={styles.empty}>Connecting accounts is turned off on this Whombat.</p>
        ) : connection ? (
          <MailAccount connection={connection} />
        ) : (
          <ImapConnectForm />
        )}
      </div>
    </section>
  );
}

/* Connecting (CM-20…CM-22) ---------------------------------------------------------------------------- */

/** What the servers line knows: nothing yet, looking, or the answer for an address. */
type Found = { email: string; answer: ImapDiscoverResponse | null } | null;

function ImapConnectForm() {
  const ids = useId();
  const toast = useToast();
  const discover = useImapDiscover();
  const connect = useImapConnect();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [found, setFound] = useState<Found>(null);
  // The server fields, once they are open (Change, nothing found, or a refusal about the servers).
  const [draft, setDraft] = useState<MailServersDraft | null>(null);
  const [problem, setProblem] = useState<ImapConnectProblem>({
    message: null,
    fields: {},
    openServers: false,
  });
  const asked = useRef<string | null>(null);
  // The person typed in the server fields: a later address's answer doesn't replace what they typed.
  const edited = useRef(false);

  async function look(address: string) {
    const value = address.trim();
    if (!looksLikeEmail(value) || asked.current === value.toLowerCase()) return;
    asked.current = value.toLowerCase();
    let answer: ImapDiscoverResponse | null = null;
    try {
      const result = await discover.mutateAsync({ body: { email: value } });
      if (result.status === 'ok') answer = result.data;
    } catch {
      // Not found is the same as nothing found: the fields open with the guess.
    }
    if (asked.current !== value.toLowerCase()) return;
    setFound({ email: value, answer });
    if (edited.current) return;
    // Found: the line with Change. Nothing found (`guess`, or no answer): the fields open, filled with
    // imap.<domain> and smtp.<domain> (CM-20).
    if (answer?.settings && answer.source !== 'guess') setDraft(null);
    else {
      const settings = answer?.settings ?? imapGuessSettings(value);
      setDraft(settings ? draftFromSettings(settings) : null);
    }
  }

  // The address is looked up once it rests (and at once on blur).
  const lookLater = useRef(look);
  lookLater.current = look;
  useEffect(() => {
    if (!looksLikeEmail(email)) return;
    const timer = setTimeout(() => void lookLater.current(email), DISCOVER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [email]);

  const current = found && found.email.toLowerCase() === email.trim().toLowerCase() ? found : null;
  const settings = current?.answer?.settings ?? null;
  const looking = discover.isPending && looksLikeEmail(email);
  const showFound = !draft && settings && current?.answer?.source !== 'guess';
  const busy = connect.isPending;

  function openServers() {
    setDraft((open) => {
      if (open) return open;
      const from = settings ?? imapGuessSettings(email);
      return from ? draftFromSettings(from) : null;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const fields: ImapConnectProblem['fields'] = {};
    if (!looksLikeEmail(email)) fields.email = IMAP_COPY.emailMissing;
    if (!password) fields.password = IMAP_COPY.passwordMissing;
    const servers = draft ? settingsFromDraft(draft) : null;
    if (servers?.errors) Object.assign(fields, servers.errors);
    if (Object.keys(fields).length) return setProblem({ message: null, fields, openServers: false });
    setProblem({ message: null, fields: {}, openServers: false });
    const chosen = servers?.settings ?? settings ?? undefined;
    try {
      const result = await connect.mutateAsync({
        body: { email: email.trim(), password, ...(chosen ? { settings: chosen } : {}) },
      });
      if (result.status === 'ok') {
        setPassword('');
        toast.show(imapConnectedText(result.data.email));
      }
    } catch (error) {
      const next = imapConnectProblem(error);
      setProblem(next);
      if (next.openServers) openServers();
    }
  }

  const fieldProblem = (key: 'email' | 'password' | MailDraftField) => problem.fields[key];

  return (
    <form className={c.block} onSubmit={onSubmit} noValidate>
      <div className={c.head}>
        <StatusDot tone="mut" size={8} label="Not connected" />
        <span className={c.main}>
          <span className={c.name}>{IMAP_COPY.name}</span>
          <span className={c.meta}>{IMAP_COPY.notConnected}</span>
        </span>
      </div>
      <div className={c.fields}>
        <Field id={`${ids}-email`} label={IMAP_COPY.email} problem={fieldProblem('email')}>
          <Input
            id={`${ids}-email`}
            type="email"
            size="lg"
            autoComplete="off"
            {...NOT_A_LOGIN}
            spellCheck={false}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (problem.fields.email)
                setProblem({ ...problem, fields: { ...problem.fields, email: undefined } });
            }}
            onBlur={(e) => void look(e.target.value)}
            invalid={!!fieldProblem('email')}
          />
        </Field>
        <Field
          id={`${ids}-password`}
          label={IMAP_COPY.password}
          help={IMAP_COPY.passwordHint}
          problem={fieldProblem('password')}
        >
          <Input
            id={`${ids}-password`}
            type="password"
            size="lg"
            autoComplete="new-password"
            {...NOT_A_LOGIN}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (problem.fields.password)
                setProblem({ ...problem, fields: { ...problem.fields, password: undefined } });
            }}
            invalid={!!fieldProblem('password')}
          />
        </Field>
      </div>
      {looking && !current && (
        <span className={k.busy} role="status">
          <span className={k.spinner} aria-hidden="true" />
          {IMAP_COPY.looking}
        </span>
      )}
      {showFound && settings && (
        <div className={c.mailFound} role="status">
          <StatusDot tone="ok" size={8} label={null} />
          <span className={c.mailFoundText}>
            <span className={c.mailFoundTitle}>{IMAP_COPY.found}</span>
            <Hosts {...settingsServers(settings)} />
          </span>
          <Button variant="link" onClick={openServers}>
            {IMAP_COPY.change}
          </Button>
        </div>
      )}
      {draft && (
        <ServerFields
          draft={draft}
          onChange={(next) => {
            edited.current = true;
            setDraft(next);
          }}
          email={email}
          guessed={current?.answer?.source === 'guess' || (current !== null && !current.answer?.settings)}
          problems={problem.fields}
        />
      )}
      {current?.answer?.hint && <ProviderHint hint={current.answer.hint} />}
      {problem.message && (
        <p className={c.error} role="alert">
          {problem.message}
        </p>
      )}
      <div className={c.formActions}>
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          {IMAP_COPY.connect}
        </Button>
        {busy && (
          <span className={k.busy} role="status">
            <span className={k.spinner} aria-hidden="true" />
            {IMAP_COPY.connecting}
          </span>
        )}
      </div>
    </form>
  );
}

/** Stand-ins for the two names inside the line, so the words between them stay as the language orders them. */
const IMAP_MARK = '\u0001';
const SMTP_MARK = '\u0002';

/**
 * “imap.fastmail.com and smtp.fastmail.com” (`imapServersLine`), the names in mono and the words between them (“and”,
 * “en”) in the text face. The line is written with stand-ins for the names and cut at them, never at its words.
 */
function Hosts({ imapHost, smtpHost }: { imapHost: string; smtpHost: string }) {
  const { tag } = useWebI18n();
  if (imapHost === smtpHost)
    return (
      <span className={c.mailFoundHosts}>
        <span className={c.mailHosts}>{imapHost}</span>
      </span>
    );
  const line = imapServersLine({ imapHost: IMAP_MARK, smtpHost: SMTP_MARK }, tag);
  return (
    <span className={c.mailFoundHosts}>
      {line
        .split(new RegExp(`(${IMAP_MARK}|${SMTP_MARK})`))
        .filter(Boolean)
        .map((part, i) =>
          part === IMAP_MARK || part === SMTP_MARK ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the line's parts never move.
            <span key={i} className={c.mailHosts}>
              {part === IMAP_MARK ? imapHost : smtpHost}
            </span>
          ) : (
            part
          ),
        )}
    </span>
  );
}

const SECURITY_OPTIONS = (['tls', 'starttls'] as const).map((value) => ({
  value,
  label: MAIL_SECURITY_LABELS[value],
}));

/** IMAP host, port, security; SMTP the same; the username when it isn't the address (CM-20). */
function ServerFields({
  draft,
  onChange,
  email,
  guessed,
  problems,
}: {
  draft: MailServersDraft;
  onChange: (draft: MailServersDraft) => void;
  email: string;
  guessed: boolean;
  problems: ImapConnectProblem['fields'];
}) {
  const ids = useId();
  const side = (key: 'imap' | 'smtp', legend: string) => {
    const host = key === 'imap' ? 'imapHost' : 'smtpHost';
    const port = key === 'imap' ? 'imapPort' : 'smtpPort';
    const security: MailSecurity = key === 'imap' ? draft.imapSecurity : draft.smtpSecurity;
    return (
      <fieldset className={c.mailSide}>
        <legend className={c.fieldLabel}>{legend}</legend>
        <div className={c.mailRow}>
          <label className={c.mailHost} htmlFor={`${ids}-${host}`}>
            <span className={c.mailSmall}>{IMAP_COPY.server}</span>
            <Input
              id={`${ids}-${host}`}
              spellCheck={false}
              autoComplete="off"
              value={draft[host]}
              onChange={(e) => onChange({ ...draft, [host]: e.target.value })}
              invalid={!!problems[host]}
            />
          </label>
          <label className={c.mailPort} htmlFor={`${ids}-${port}`}>
            <span className={c.mailSmall}>{IMAP_COPY.port}</span>
            <Input
              id={`${ids}-${port}`}
              inputMode="numeric"
              autoComplete="off"
              value={draft[port]}
              onChange={(e) => onChange({ ...draft, [port]: e.target.value })}
              invalid={!!problems[port]}
            />
          </label>
          <div className={c.mailSecurity}>
            <span className={c.mailSmall} aria-hidden="true">
              {IMAP_COPY.security}
            </span>
            <SegmentedControl<MailSecurity>
              label={`${legend}: ${IMAP_COPY.security}`}
              value={security}
              onChange={(value) => onChange(withSecurity(draft, key, value))}
              options={SECURITY_OPTIONS}
            />
          </div>
        </div>
        {(problems[host] || problems[port]) && (
          <p className={c.error} role="alert">
            {problems[host] ?? problems[port]}
          </p>
        )}
      </fieldset>
    );
  };
  return (
    <div className={c.mailServers}>
      {guessed && <p className={c.hint}>{IMAP_COPY.guessed}</p>}
      {side('imap', IMAP_COPY.incoming)}
      {side('smtp', IMAP_COPY.outgoing)}
      <Field
        id={`${ids}-username`}
        label={IMAP_COPY.username}
        help={IMAP_COPY.usernameHint}
        problem={problems.username}
      >
        <Input
          id={`${ids}-username`}
          spellCheck={false}
          autoComplete="off"
          {...NOT_A_LOGIN}
          placeholder={email.trim() || 'you@example.com'}
          value={draft.username}
          onChange={(e) => onChange({ ...draft, username: e.target.value })}
          invalid={!!problems.username}
        />
      </Field>
    </div>
  );
}

/**
 * A known provider's hint (CM-21): an app password and where it's made, or the connection to use instead — both where
 * the hint has both (Gmail: the Google connection, and its app password for mail only; SG-18d, AP-3915).
 */
function ProviderHint({ hint }: { hint: ImapProviderHint }) {
  const { instead, page } = hintLinks(hint);
  const links = (
    <>
      {instead && (
        <Link
          to="/settings"
          search={{ tab: 'connections', connection: instead.connection }}
          className={c.externalLink}
        >
          {instead.text}
        </Link>
      )}
      {page && <ExternalLink href={page.url}>{page.text}</ExternalLink>}
    </>
  );
  return (
    <div className={c.mailHint} role="status">
      <span>{hint.text}</span>
      {instead && page ? <span className={c.mailHintLinks}>{links}</span> : links}
    </div>
  );
}

/* Connected ------------------------------------------------------------------------------------------- */

const CHECK_TONES: Record<string, DotTone> = { ok: 'ok', error: 'bad' };

function MailAccount({ connection }: { connection: Connection }) {
  const ids = useId();
  const toast = useToast();
  const connect = useImapConnect();
  const check = useCheckConnection();
  const remove = useRemoveConnection();
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<ImapConnectProblem | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const active = connection.status === 'active';

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    if (!password)
      return setProblem({
        message: null,
        fields: { password: IMAP_COPY.passwordMissing },
        openServers: false,
      });
    setProblem(null);
    try {
      // The servers stay as they are: only the password is new.
      const result = await connect.mutateAsync({ body: { email: connection.email, password } });
      if (result.status === 'ok') {
        setPassword('');
        setChanging(false);
        toast.show(imapConnectedText(result.data.email));
      }
    } catch (error) {
      setProblem(imapConnectProblem(error));
    }
  }

  async function onDisconnect() {
    const result = await remove.mutateAsync({ params: { connectionId: connection.id } });
    setConfirmDisconnect(false);
    if (result.status === 'ok') toast.show(IMAP_DISCONNECTED_TEXT);
  }

  return (
    <>
      <div className={c.block}>
        <div className={c.head}>
          <StatusDot
            tone={active ? 'ok' : 'warn'}
            size={8}
            label={active ? IMAP_COPY.connected : IMAP_COPY.needsPassword}
          />
          <span className={c.main}>
            <span className={c.name}>
              Email · <span className={c.email}>{connection.email}</span>
            </span>
            <span className={c.meta}>{mailAccountLine(connection)}</span>
          </span>
          {!changing && !confirmDisconnect && (
            <span className={c.actions}>
              <Button variant={active ? 'secondary' : 'primary'} size="sm" onClick={() => setChanging(true)}>
                {active ? IMAP_COPY.changePassword : IMAP_COPY.newPassword}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>
                {IMAP_COPY.disconnect}
              </Button>
            </span>
          )}
        </div>
        {confirmDisconnect && (
          <div className={c.formActions}>
            <span className={c.hint}>{IMAP_COPY.disconnectAsk}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onDisconnect()}
              disabled={remove.isPending}
            >
              {IMAP_COPY.disconnectConfirm}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
              {IMAP_COPY.cancel}
            </Button>
          </div>
        )}
        {changing && (
          <form className={c.appForm} onSubmit={onPassword} noValidate>
            <Field
              id={`${ids}-password`}
              label={IMAP_COPY.password}
              help={IMAP_COPY.passwordHint}
              problem={problem?.fields.password}
            >
              <Input
                id={`${ids}-password`}
                type="password"
                size="lg"
                autoComplete="new-password"
                {...NOT_A_LOGIN}
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={!!problem?.fields.password}
              />
            </Field>
            {problem?.message && (
              <p className={c.error} role="alert">
                {problem.message}
              </p>
            )}
            <div className={c.formActions}>
              <Button type="submit" variant="primary" size="md" disabled={connect.isPending}>
                {IMAP_COPY.connectAgain}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setChanging(false);
                  setPassword('');
                  setProblem(null);
                }}
              >
                {IMAP_COPY.cancel}
              </Button>
              {connect.isPending && (
                <span className={k.busy} role="status">
                  <span className={k.spinner} aria-hidden="true" />
                  {IMAP_COPY.connecting}
                </span>
              )}
            </div>
          </form>
        )}
        {active && connection.checks.length > 0 && (
          <ul className={c.checks} aria-label="Checks">
            {connection.checks.map((item) => (
              <li key={`${item.service}-${item.side ?? ''}`} className={c.check}>
                <StatusDot tone={CHECK_TONES[item.state] ?? 'warn'} size={7} label={null} />
                <span className={c.checkName}>{mailCheckName(item)}</span>
                <span className={c.checkState} data-state={item.state}>
                  {item.state === 'ok' ? 'Working' : (item.message ?? 'Couldn’t check')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {active && (
        <div className={c.footer}>
          <span className={c.meta}>
            {check.isPending
              ? IMAP_COPY.checking
              : connection.checkedAt
                ? `Checked ${formatAgo(connection.checkedAt, new Date(), LOCAL_TZ)}`
                : IMAP_COPY.notChecked}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate({ params: { connectionId: connection.id } })}
          >
            {IMAP_COPY.checkAgain}
          </Button>
        </div>
      )}
    </>
  );
}
