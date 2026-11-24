/**
 * One catalog connection (Whombat connections-catalog.md CX-72; app AP-757; not in the mocks, B-05):
 * `?tab=connections&connection=<catalogId>&id=<connectionId>`. Its head (logo, label with Rename, entry and whose it is),
 * CONNECTION (state, the last check with “Check again”, who connected it, its address and the handle the agent uses), SIGN-IN
 * (Replace token or Reconnect, Remove with a confirm) and TOOLS (Allowed · Asks · Off per tool; “Always asks” for the
 * sensitive ones, CX-31; “New” for a new or changed one, CX-18). With `connections.sign_in_once` (CT-314, AP-845)
 * CONNECTION also says what the agent may do — Look only or Manage — and you Change it there (`connections.update`
 * `access`); raising a key the service itself
 * made to look only says to sign in again (CS-11). An entry that signs in on the service's own page (Plex's, Whombat
 * connection-signin.md SG-01; `connections.service_login`) offers Sign in again there beside Replace token, and Replace
 * password asks a session's two-step code when the service does (Synology, SG-09; AP-3912). Nobody looks after a
 * connection: there is one agent (Whombat one-agent.md OA-07; app one-agent.md AP-4944). A connection only automations use
 * (a report tracker; Whombat report-trackers.md TA-02, TA-03) has none of the agent's parts — no level, handle or TOOLS — but
 * “Used by automations” and how its poller is doing. An AI gateway (Fusebox or
 * the generic one; Whombat ai-gateway.md AIG-01, AIG-05, AIG-06; AP-1117) has none of them either, but which tools go
 * through it, the pool's line and CLAUDE CODE AND CODEX with a switch per tool (`GatewayParts`); removing it says what
 * the server says when Fusebox couldn't be told. 1Password (Whombat onepassword-sync.md) has none of
 * the agent's parts and no last use, and Remove asks whether the entries it kept in step stay in the Vault; KEPT IN
 * STEP is its page's own 1Password tab (`OnePasswordParts`), not here. Settings' cards, the Google page's checks and
 * footer, the Vault's tool rows.
 */
import { createLink, useNavigate } from '@tanstack/react-router';
import {
  ApiError,
  disconnectQuery,
  ONEPASSWORD_APP_TEXT,
  ONEPASSWORD_DISCONNECT_OPTIONS,
  withBurrow,
} from '@whombat/client';
import {
  accessChoices,
  type ChoiceSetting,
  CONNECT_FORM_TEXT,
  choiceSavedText,
  choiceSettings,
  codeProblem,
  codeProblemText,
  codeShown,
  codeSignInAgain,
  connectionReason,
  guidedSteps,
  raiseNote,
  reconnectServiceLoginBody,
  SIGN_IN_AGAIN_TEXT,
  setSecretBody,
} from '@whombat/client/connections';
import { useMacChoices } from '@whombat/client/hosts/react';
import { holdGoogleConnect } from '@whombat/client/managed';
import { useConnectionTools, useConnectionWrite, useTheAgent } from '@whombat/client/react';
import { api, type StartNextcloudLoginResponse } from '@whombat/core/contracts';
import {
  ALWAYS_ASKS_LABEL,
  type CatalogCheckResult,
  type CatalogEntry,
  CONNECTION_ACCESS_LABELS,
  CONNECTION_TOOL_TIER_LABELS,
  CONNECTION_TOOL_TIERS,
  type ConnectionAccessLevel,
  type ConnectionToolTier,
  type ConnectionToolView,
  type ConnectionView,
  catalogSignIn,
  connectionHost,
  NEW_TOOL_LABEL,
  scopeListWords,
} from '@whombat/core/domain';
import { formatAgo } from '@whombat/core/text';
import type { OnePasswordDisconnectChoice } from '@whombat/core/vault';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useManaged } from '../../app/providers';
import { Button, ButtonLink } from '../../components/Button';
import { Input } from '../../components/Input';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import styles from '../settings/SettingsScreen.module.css';
import k from './Catalog.module.css';
import { CatalogHeader } from './CatalogHeader';
import { ExternalLink, Field, GuideSteps, OptionCards } from './CatalogParts';
import c from './Connectors.module.css';
import {
  NextcloudWait,
  openLoginPage,
  openLoginTab,
  pointLoginTab,
  type ServiceLoginStarted,
  ServiceLoginWait,
  usePreparedServiceLogin,
} from './ConnectParts';
import {
  accessText,
  connectionState,
  connectProblem,
  installationLine,
  pollerNote,
  sessionSecret,
  shownTier,
  tierSelectable,
  toolsText,
  USED_BY_AUTOMATIONS,
  usedByAgents,
  usedByAutomations,
  usedByGateway,
  usedByVaultSync,
} from './catalog';
import {
  GatewayPoolLine,
  GatewaySwitchesSection,
  GatewayUsedByBlock,
  useGatewayOf,
  useGatewayPool,
} from './GatewayParts';
import { useConnectionWords } from './useConnectionWords';

const RouterButtonLink = createLink(ButtonLink);

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const CHECK_NAMES: Record<CatalogCheckResult['id'], string> = {
  credential: 'Sign-in',
  mcp: 'MCP server',
  destination: 'Address',
  tools: 'Tools',
};

const CHECK_TONES: Record<CatalogCheckResult['state'], DotTone> = { ok: 'ok', warning: 'warn', error: 'bad' };

export function ConnectionPage({
  burrow,
  entry,
  connectionId,
  connected,
  onOutcomeSeen,
  navigate: leave = (url) => window.location.assign(url),
  embedded = false,
  device = false,
}: {
  burrow: string;
  entry: CatalogEntry;
  connectionId: string;
  /** It was just connected (`connected=` after a sign-in elsewhere): a toast, once. */
  connected?: boolean;
  onOutcomeSeen?: () => void;
  navigate?: (url: string) => void;
  /**
   * The Settings tab of its own page (connection-pages.md CP-01, connection-pages-web.md AP-1900…): that page's head
   * names it, so this one drops its logo and title; NAME keeps Rename.
   */
  embedded?: boolean;
  /** A switched-on device (CP-13): only its actions and their tiers (TOOLS), as it has no sign-in of its own. */
  device?: boolean;
}) {
  const toast = useToast();
  const query = useConnectionTools({ params: { burrow, connectionId } }, { retry: false });
  const data = query.data;
  const seen = useRef(false);
  // An AI gateway's switches (AIG-05).
  const gateway = usedByGateway(entry);
  // Sign in again asked from the level's note: a connection made with a code signs in again in SIGN-IN, not anew.
  const [againAsked, setAgainAsked] = useState(0);

  useEffect(() => {
    if (seen.current || !connected || !data) return;
    seen.current = true;
    toast.show(`${data.connection.label} connected.`);
    onOutcomeSeen?.();
  }, [connected, data, toast, onOutcomeSeen]);

  if (query.error && !data) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <>
        {embedded ? null : <CatalogHeader entry={entry} />}
        <ErrorNote
          message={
            gone
              ? 'This connection isn’t here any more, or it isn’t yours to see.'
              : 'Couldn’t load this connection. Try again in a moment.'
          }
          onRetry={gone ? undefined : () => void query.refetch()}
        />
      </>
    );
  }
  if (!data)
    return (
      <>
        {embedded ? null : <CatalogHeader entry={entry} />}
        <div className={styles.card}>
          <SkeletonRows count={3} lines={2} />
        </div>
      </>
    );

  const conn = data.connection;
  if (device)
    return <ToolsSection burrow={burrow} conn={conn} tools={data.tools} truncated={data.truncated} />;
  return (
    <>
      <Head burrow={burrow} entry={entry} conn={conn} embedded={embedded} />
      <ConnectionSection
        burrow={burrow}
        entry={entry}
        conn={conn}
        onSignInAgain={() => setAgainAsked((n) => n + 1)}
      />
      {/* Claude Code and ChatGPT through it (AIG-05, AP-1117): the switches, where the runtime has `ai.gateway`. */}
      {gateway && <GatewaySwitchesSection burrow={burrow} entry={entry} conn={conn} />}
      <SignInSection burrow={burrow} entry={entry} conn={conn} leave={leave} againAsked={againAsked} />
      {usedByAgents(entry) && (
        <ToolsSection burrow={burrow} conn={conn} tools={data.tools} truncated={data.truncated} />
      )}
    </>
  );
}

/** The head with the label and Rename; embedded, NAME with the label and Rename. */
function Head({
  burrow,
  entry,
  conn,
  embedded,
}: {
  burrow: string;
  entry: CatalogEntry;
  conn: ConnectionView;
  embedded: boolean;
}) {
  const ids = useId();
  const toast = useToast();
  const update = useConnectionWrite(api.connections.update, burrow);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(conn.label);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = label.trim();
    if (!next) return setProblem('Give it a name.');
    if (next === conn.label) return setEditing(false);
    try {
      const result = await update.mutateAsync({
        params: { burrow, connectionId: conn.id },
        body: { label: next },
      });
      if (result.status === 'ok') {
        setEditing(false);
        toast.show(`Renamed to ${result.data.connection.label}.`);
      }
    } catch (err) {
      const p = connectProblem(err);
      setProblem(p.fields.label ?? p.message);
    }
  }

  const rename = !editing ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        setLabel(conn.label);
        setProblem(null);
        setEditing(true);
      }}
    >
      Rename
    </Button>
  ) : null;
  return (
    <>
      {embedded ? (
        <section className={styles.section} aria-labelledby="connection-name">
          <SectionLabel as="h2" id="connection-name">
            NAME
          </SectionLabel>
          <div className={styles.card}>
            <div className={c.block}>
              <div className={c.head}>
                <span className={c.main}>
                  <span className={c.name}>{conn.label}</span>
                  <span className={c.meta}>{entry.name}</span>
                </span>
                {rename ? <span className={c.actions}>{rename}</span> : null}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <CatalogHeader entry={entry} title={conn.label} line={entry.name} aside={rename} />
      )}
      {editing && (
        <form className={k.rename} onSubmit={save} noValidate>
          <label className={c.srOnly} htmlFor={`${ids}-label`}>
            Name
          </label>
          <Input
            id={`${ids}-label`}
            size="md"
            autoComplete="off"
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            invalid={problem !== null}
          />
          <Button type="submit" variant="primary" size="md" disabled={update.isPending}>
            Save
          </Button>
          <Button variant="ghost" size="md" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {problem && (
            <p className={c.error} role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
    </>
  );
}

/** CONNECTION: the state and why, the checks, the facts, and the last check with “Check again”. */
function ConnectionSection({
  burrow,
  entry,
  conn,
  onSignInAgain,
}: {
  burrow: string;
  entry: CatalogEntry;
  conn: ConnectionView;
  onSignInAgain: () => void;
}) {
  const recheck = useConnectionWrite(api.connections.recheck, burrow);
  const [problem, setProblem] = useState<string | null>(null);
  // Only automations use it (TA-02), or it is an AI gateway (AIG-01): none of the agent's parts below.
  const automations = usedByAutomations(entry);
  const agents = usedByAgents(entry);
  const gateway = usedByGateway(entry);
  // Which tools go through it, and the pool's line (AIG-01, AIG-11; AP-1117).
  const gatewayNow = useGatewayOf(burrow, conn);
  const pool = useGatewayPool(burrow, conn.id);
  // Look only / Manage (CT-314).
  const levels = agents;
  const state = connectionState(conn);
  const host = connectionHost(entry, conn.fields);
  const reason = connectionReason(entry, conn);
  // How the poller that reads it for automations is doing (TA-03), naming the connection: the entry's name is the
  // same for every tracker. An older runtime sends no `poller`.
  const poller = automations ? pollerNote(conn.poller, conn.label, new Date(), LOCAL_TZ) : null;
  // Which installation it is (0.75, TA-32): “Development · version 0.1.174”.
  const installation = automations ? installationLine(conn.poller) : null;
  // Who calls it, by name in the assistant shell (less-is-more.md AP-1802).
  const words = useConnectionWords(burrow);
  const line = reason ?? (agents ? words.callsLine(toolsText(conn.toolCount), conn.handle) : null);
  return (
    <section className={styles.section} aria-labelledby="connection-state">
      <SectionLabel as="h2" id="connection-state">
        CONNECTION
      </SectionLabel>
      <div className={styles.card}>
        <div className={c.block}>
          <div className={c.head}>
            <StatusDot tone={state.tone} size={8} label={state.text} />
            <span className={c.main}>
              <span className={c.name}>{state.text}</span>
              {line && <span className={c.meta}>{line}</span>}
              {installation && (
                <span className={c.meta} data-installation="">
                  {installation}
                </span>
              )}
              {poller && (
                <span className={c.meta} data-tone={poller.tone} data-poller="">
                  {poller.text}
                </span>
              )}
              {gateway && pool ? <GatewayPoolLine pool={pool} /> : null}
            </span>
          </div>
          {conn.checks.length > 0 && (
            <ul className={c.checks} aria-label="Checks">
              {conn.checks.map((check) => (
                <li key={check.id} className={c.check}>
                  <StatusDot tone={CHECK_TONES[check.state]} size={7} label={null} />
                  <span className={c.checkName}>{CHECK_NAMES[check.id]}</span>
                  <span
                    className={c.checkState}
                    data-state={
                      check.state === 'warning' ? 'no_scope' : check.state === 'error' ? 'error' : undefined
                    }
                  >
                    {check.message ?? (check.state === 'ok' ? 'Working' : 'Couldn’t check')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <dl className={k.facts}>
            <dt>CONNECTED BY</dt>
            <dd>
              {conn.connectedBy.name} · {formatAgo(conn.createdAt, new Date(), LOCAL_TZ)}
            </dd>
            {(conn.detail || host) && (
              <>
                <dt>{conn.detail ? 'ACCOUNT' : 'ADDRESS'}</dt>
                <dd className={k.mono}>{conn.detail ?? host}</dd>
              </>
            )}
            {agents && (
              <>
                <dt>{words.callsIt}</dt>
                <dd className={k.mono}>{conn.handle}</dd>
              </>
            )}
            {/* The Vault's sync isn't used by anyone: KEPT IN STEP says when it last checked. */}
            {!usedByVaultSync(entry) && (
              <>
                <dt>LAST USED</dt>
                <dd>{conn.lastUsedAt ? formatAgo(conn.lastUsedAt, new Date(), LOCAL_TZ) : 'Not yet'}</dd>
              </>
            )}
          </dl>
          {problem && (
            <p className={c.error} role="alert">
              {problem}
            </p>
          )}
        </div>
        {automations && (
          <div className={c.block} data-block="used-by-automations">
            <span className={c.main}>
              <span className={c.name}>{USED_BY_AUTOMATIONS.title}</span>
              <span className={c.meta}>{USED_BY_AUTOMATIONS.text}</span>
              <span className={c.meta} data-organization="">
                {USED_BY_AUTOMATIONS.organization}
              </span>
            </span>
          </div>
        )}
        {gateway && <GatewayUsedByBlock gateway={gatewayNow} />}
        {levels && <AccessBlock burrow={burrow} entry={entry} conn={conn} onSignInAgain={onSignInAgain} />}
        <ChoiceBlocks burrow={burrow} entry={entry} conn={conn} />
        <div className={c.footer}>
          <span className={c.meta}>
            {recheck.isPending
              ? `Checking with ${entry.name}…`
              : conn.checkedAt
                ? `Checked ${formatAgo(conn.checkedAt, new Date(), LOCAL_TZ)}`
                : 'Not checked yet'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={recheck.isPending}
            onClick={async () => {
              setProblem(null);
              try {
                await recheck.mutateAsync({ params: { burrow, connectionId: conn.id } });
              } catch (err) {
                setProblem(connectProblem(err).message);
              }
            }}
          >
            Check again
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * The connection's choices that can change later (findmy-connection.md §2.1): a select's own options (Find My's Read in
 * the background) and the Mac of an entry checked through a Mac, among the servers that are Macs. Each its block with
 * Change, radio cards and Save; the server checks the new value as it checks a new connection.
 */
function ChoiceBlocks({
  burrow,
  entry,
  conn,
}: {
  burrow: string;
  entry: CatalogEntry;
  conn: ConnectionView;
}) {
  const macs = useMacChoices(burrow, entry.check?.kind === 'mac');
  const settings = choiceSettings(entry, conn.fields, macs);
  return (
    <>
      {settings.map((setting) => (
        <ChoiceBlock key={setting.field} burrow={burrow} conn={conn} setting={setting} />
      ))}
    </>
  );
}

function ChoiceBlock({
  burrow,
  conn,
  setting,
}: {
  burrow: string;
  conn: ConnectionView;
  setting: ChoiceSetting;
}) {
  const ids = useId();
  const toast = useToast();
  const update = useConnectionWrite(api.connections.update, burrow);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(setting.value);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (value === setting.value) return setEditing(false);
    setProblem(null);
    try {
      const result = await update.mutateAsync({
        params: { burrow, connectionId: conn.id },
        body: { fields: { [setting.field]: value } },
      });
      if (result.status === 'ok') {
        setEditing(false);
        toast.show(choiceSavedText(setting, value));
      }
    } catch (err) {
      const p = connectProblem(err);
      setProblem(p.fields[setting.field] ?? p.message);
    }
  }

  return (
    <div className={c.block} data-choice={setting.field}>
      <div className={c.head}>
        <span className={c.main}>
          <span className={c.fieldLabel}>{setting.label.toUpperCase()}</span>
          {!editing && <span className={c.name}>{setting.valueLabel}</span>}
        </span>
        {!editing && (
          <span className={c.actions}>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Change ${setting.label}`}
              onClick={() => {
                setValue(setting.value);
                setProblem(null);
                setEditing(true);
              }}
            >
              Change
            </Button>
          </span>
        )}
      </div>
      {editing && (
        <form className={c.appForm} onSubmit={save} noValidate>
          <OptionCards
            name={`${ids}-${setting.field}`}
            label={setting.label}
            help={setting.help}
            options={setting.options}
            value={value}
            disabled={update.isPending}
            onChange={setValue}
          />
          <div className={c.formActions}>
            <Button type="submit" variant="primary" size="md" disabled={update.isPending}>
              Save
            </Button>
            <Button variant="ghost" size="md" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {problem && (
        <p className={c.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * What agents may do (CS-10, CS-11; AP-845): Look only or Manage with what it means for this service, and Change for
 * those who may change the connection. Raising one to Manage where sign in once asks the service for a key at the level
 * says that such a key still only looks, with Sign in again (the connect page, the address filled in).
 */
function AccessBlock({
  burrow,
  entry,
  conn,
  onSignInAgain,
}: {
  burrow: string;
  entry: CatalogEntry;
  conn: ConnectionView;
  onSignInAgain: () => void;
}) {
  const ids = useId();
  const toast = useToast();
  const update = useConnectionWrite(api.connections.update, burrow);
  const [editing, setEditing] = useState(false);
  const [level, setLevel] = useState<ConnectionAccessLevel>(conn.access);
  const [raised, setRaised] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const words = useConnectionWords(burrow);
  const choices = accessChoices(entry).map((x) => ({ ...x, text: words.access(x.text) }));
  const current = choices.find((x) => x.value === conn.access);
  const note = raised && conn.access === 'manage' ? raiseNote(entry) : null;
  // A connection made with a code signs in again on this page (SIGN-IN), so it never makes a second one.
  const withCode = codeSignInAgain(entry, conn) !== null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (level === conn.access) return setEditing(false);
    setProblem(null);
    try {
      const result = await update.mutateAsync({
        params: { burrow, connectionId: conn.id },
        body: { access: level },
      });
      if (result.status === 'ok') {
        setEditing(false);
        setRaised(level === 'manage');
        toast.show(`${conn.label} set to ${CONNECTION_ACCESS_LABELS[level]}.`);
      }
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  return (
    <div className={c.block}>
      <div className={c.head}>
        <span className={c.main}>
          <span className={c.fieldLabel}>{words.mayDo}</span>
          {!editing && (
            <>
              <span className={c.name}>{CONNECTION_ACCESS_LABELS[conn.access]}</span>
              <span className={c.meta}>{current?.text}</span>
            </>
          )}
        </span>
        {!editing && (
          <span className={c.actions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setLevel(conn.access);
                setProblem(null);
                setEditing(true);
              }}
            >
              Change
            </Button>
          </span>
        )}
      </div>
      {editing && (
        <form className={c.appForm} onSubmit={save} noValidate>
          <fieldset className={k.fieldset}>
            <legend className={c.srOnly}>{words.mayDoQuestion}</legend>
            <div className={k.scopes}>
              {choices.map((a) => (
                <label key={a.value} className={k.scope}>
                  <input
                    type="radio"
                    name={`${ids}-access`}
                    className={k.radio}
                    value={a.value}
                    checked={level === a.value}
                    disabled={update.isPending}
                    onChange={() => setLevel(a.value)}
                  />
                  <span className={k.scopeText}>
                    <span className={k.scopeTitle}>{a.label}</span>
                    <span className={c.meta}>{a.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className={c.formActions}>
            <Button type="submit" variant="primary" size="md" disabled={update.isPending}>
              Save
            </Button>
            <Button variant="ghost" size="md" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {note && (
        <div className={k.problem}>
          <p className={c.stepText}>{note}</p>
          {withCode ? (
            <Button variant="secondary" size="sm" onClick={onSignInAgain}>
              {SIGN_IN_AGAIN_TEXT.button}
            </Button>
          ) : (
            <RouterButtonLink
              variant="secondary"
              size="sm"
              to="/settings"
              search={{
                tab: 'connections',
                connection: entry.id,
                ...(conn.fields.url ? { url: conn.fields.url } : {}),
              }}
            >
              Sign in again
            </RouterButtonLink>
          )}
        </div>
      )}
      {problem && (
        <p className={c.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * SIGN-IN: Replace token (a token connection) or Reconnect (a sign-in elsewhere), and Remove with a confirm. A token from
 * the service's own page (Plex's, SG-01) can be signed in for again there (Sign in again, `connectionId`), and Replace
 * password asks a session's two-step code once the service does (SG-09). A token a code was exchanged for (T3 Code's
 * pairing code) signs in again with a new code instead of being replaced: the steps to make one and its field.
 */
function SignInSection({
  burrow,
  entry,
  conn,
  leave,
  againAsked,
}: {
  burrow: string;
  entry: CatalogEntry;
  conn: ConnectionView;
  leave: (url: string) => void;
  /** Asked again from the level's note (a count): the code's form opens, in sight. */
  againAsked: number;
}) {
  const ids = useId();
  const toast = useToast();
  const { words: agent } = useTheAgent(burrow);
  const go = useNavigate();
  const managed = useManaged();
  const setSecret = useConnectionWrite(api.connections.setSecret, burrow);
  const startOAuth = useConnectionWrite(api.connections.startOAuth, burrow);
  const startNextcloud = useConnectionWrite(api.connections.startNextcloud, burrow);
  const startService = useConnectionWrite(api.connections.startServiceLogin, burrow);
  const disconnect = useConnectionWrite(api.connections.disconnect, burrow);
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecretValue] = useState('');
  const [code, setCode] = useState('');
  /** The service asked for a two-step code (SG-09): its words, the help under the code. */
  const [codeAsked, setCodeAsked] = useState<string | null>(null);
  const [codeTrouble, setCodeTrouble] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // Removing the Vault's sync: whether the entries it kept in step stay in the Vault (the default) or go too.
  const [vaultEntries, setVaultEntries] = useState<OnePasswordDisconnectChoice>('keep');
  const [problem, setProblem] = useState<string | null>(null);
  const [login, setLogin] = useState<StartNextcloudLoginResponse | null>(null);
  const [service, setService] = useState<ServiceLoginStarted | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  const method = catalogSignIn(entry, conn.signIn);
  const token = conn.signIn === 'token' && method?.kind === 'token';
  // Made with a code (T3 Code's pairing code): Sign in again with a new one, never Replace token.
  const again = codeSignInAgain(entry, conn);
  // The token came from (or can come from) the service's own page, where the runtime signs in there (CT-744).
  const serviceMethod = entry.signIn.find((m) => m.kind === 'service_login');
  const signInAgain = token && !!serviceMethod;
  // A session sign-in keeps a password, not a token (CM-10).
  const secretWord = sessionSecret(entry) ?? 'token';
  const busy =
    setSecret.isPending ||
    startOAuth.isPending ||
    startNextcloud.isPending ||
    startService.isPending ||
    disconnect.isPending;
  const needs = conn.status !== 'active';
  const showCode = !!method && codeShown(method, codeAsked !== null);
  // A connection that needs signing in again has the service's page made ready, so the click opens it directly.
  const prepared = usePreparedServiceLogin(
    burrow,
    signInAgain && needs && !service ? reconnectServiceLoginBody(conn) : null,
  );

  useEffect(() => {
    if (codeAsked !== null) codeInput.current?.focus();
  }, [codeAsked]);

  useEffect(() => {
    if (!againAsked) return;
    setReplacing(true);
    section.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [againAsked]);

  // A call needed more than the service allowed (step-up): the page opens at Allow on {Name}, where the card led.
  const asked = conn.signIn === 'mcp_oauth' && conn.status === 'active' ? (conn.permissionAsked ?? []) : [];
  const askedAny = asked.length > 0;
  useEffect(() => {
    if (askedAny) section.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [askedAny]);

  // The code's field takes the focus once, when its form opens.
  const codeForm = replacing && again !== null;
  useEffect(() => {
    if (codeForm) secretInput.current?.focus({ preventScroll: true });
  }, [codeForm]);

  function stopReplacing() {
    setReplacing(false);
    setSecretValue('');
    setCode('');
    setCodeAsked(null);
    setCodeTrouble(null);
    setProblem(null);
  }

  async function replace(e: FormEvent) {
    e.preventDefault();
    if (!secret)
      return setProblem(`${method?.kind === 'token' ? method.secretLabel : 'The token'} is needed.`);
    const trouble = showCode ? codeProblem(code, codeAsked !== null) : null;
    setCodeTrouble(trouble);
    if (trouble) return;
    setProblem(null);
    try {
      const result = await setSecret.mutateAsync({
        params: { burrow, connectionId: conn.id },
        body: setSecretBody(method, secret, code),
      });
      if (result.status === 'ok') {
        stopReplacing();
        // A session's password is never called a token (CM-10): “Password replaced.”, “App password replaced.”.
        toast.show(`${secretWord.charAt(0).toUpperCase()}${secretWord.slice(1)} replaced.`);
      }
    } catch (err) {
      const p = connectProblem(err, undefined, method ?? undefined);
      // DSM asks for a two-step code with this password (SG-09): the code, then the same again.
      if (p.secondFactor) {
        setCodeAsked(p.secondFactor);
        setProblem(null);
        return;
      }
      if (p.fields.code) {
        setCodeTrouble(p.fields.code);
        setProblem(null);
        return;
      }
      setProblem(p.fields.secret ?? p.message);
    }
  }

  /** Sign in again with a new code: the server signs in with it once more, the connection and its level kept. */
  async function signInWithCode(e: FormEvent) {
    e.preventDefault();
    if (!again) return;
    const trouble = codeProblemText(again, secret);
    if (trouble) return setProblem(trouble);
    setProblem(null);
    try {
      const result = await setSecret.mutateAsync({
        params: { burrow, connectionId: conn.id },
        body: setSecretBody(method, secret.trim()),
      });
      if (result.status === 'ok') {
        stopReplacing();
        toast.show(SIGN_IN_AGAIN_TEXT.done(entry.name));
      }
    } catch (err) {
      const p = connectProblem(err, undefined, again.method);
      setProblem(p.fields.secret ?? p.fields.password ?? p.message);
    }
  }

  /** Sign in again on the service's own page (SG-01, SG-02): the same connection, its level kept. */
  async function signInThere() {
    setProblem(null);
    const ready = prepared.take(reconnectServiceLoginBody(conn));
    if (ready) {
      openLoginPage(ready.loginUrl);
      setService({ login: ready, tab: null });
      return;
    }
    const tab = openLoginTab();
    try {
      const result = await startService.mutateAsync({
        params: { burrow },
        body: reconnectServiceLoginBody(conn),
      });
      if (result.status !== 'ok') return tab?.close();
      setService({ login: result.data, tab: pointLoginTab(tab, result.data.loginUrl) });
    } catch (err) {
      tab?.close();
      setProblem(connectProblem(err).message);
    }
  }

  async function reconnect() {
    setProblem(null);
    try {
      if (conn.signIn === 'nextcloud_login') {
        const tab = window.open('about:blank', '_blank');
        const result = await startNextcloud.mutateAsync({
          params: { burrow },
          body: { fields: conn.fields, connectionId: conn.id },
        });
        if (result.status !== 'ok') return tab?.close();
        if (tab) {
          tab.opener = null;
          tab.location.href = result.data.loginUrl;
        }
        setLogin(result.data);
        return;
      }
      if (conn.signIn !== 'ha_oauth' && conn.signIn !== 'mcp_oauth' && conn.signIn !== 'app_oauth') return;
      const returnTo = withBurrow(`/settings?tab=connections&connection=${entry.id}&id=${conn.id}`, burrow);
      if (
        managed &&
        !holdGoogleConnect(() => sessionStorage, {
          device: managed.applianceId,
          returnTo,
          flow: 'connection',
        })
      )
        return setProblem('Couldn’t start the sign-in in this tab. Try again in a moment.');
      const result = await startOAuth.mutateAsync({
        params: { burrow },
        body: {
          catalogId: entry.id,
          method: conn.signIn,
          fields: conn.fields,
          connectionId: conn.id,
          returnTo,
        },
      });
      if (result.status === 'ok') leave(result.data.authorizeUrl);
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  async function remove() {
    setProblem(null);
    try {
      const query = disconnectQuery(entry, vaultEntries);
      const result = await disconnect.mutateAsync({
        params: { burrow, connectionId: conn.id },
        ...(query ? { query } : {}),
      });
      if (result.status !== 'ok') return;
      // A Fusebox that didn't answer keeps Whombat's client: the server says to remove it there (AIG-03, AP-1119), and
      // that stays up until it is read.
      const notice = removedNotice(result.data);
      toast.show(notice ?? `${conn.label} removed.`, notice ? { duration: null } : undefined);
      void go({ to: '/settings', search: { tab: 'connections' } });
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  return (
    <section ref={section} className={styles.section} aria-labelledby="connection-signin">
      <SectionLabel as="h2" id="connection-signin">
        SIGN-IN
      </SectionLabel>
      <div className={styles.card}>
        {service ? (
          <ServiceLoginWait
            burrow={burrow}
            entry={entry}
            started={service}
            onConnected={(c) => {
              setService(null);
              toast.show(`${c.label} connected.`);
            }}
            onCancel={() => setService(null)}
            onFailed={(message) => {
              setService(null);
              setProblem(message);
            }}
          />
        ) : login ? (
          <NextcloudWait
            burrow={burrow}
            entry={entry}
            login={login}
            onCancel={() => setLogin(null)}
            onFailed={(message) => {
              setLogin(null);
              setProblem(message);
            }}
          />
        ) : (
          <div className={c.block}>
            <div className={c.head}>
              <span className={c.main}>
                <span className={c.name}>{again?.title ?? method?.label ?? 'Sign-in'}</span>
                <span className={c.meta}>
                  {again
                    ? again.line
                    : token
                      ? `The ${secretWord} is kept sealed on this Whombat and never shown again.`
                      : conn.signIn === 'none'
                        ? 'This server needs no sign-in.'
                        : askedAny
                          ? `${agent.Name} needs your OK to ${scopeListWords(asked)}. What you allowed before stays.`
                          : `Signed in with ${entry.name}. Reconnect to sign in again.`}
                </span>
              </span>
              {!replacing && !confirm && (
                <span className={c.actions}>
                  {signInAgain && (
                    <Button
                      variant={needs ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={busy}
                      onClick={() => void signInThere()}
                    >
                      Sign in again
                    </Button>
                  )}
                  {again ? (
                    <Button
                      variant={again.needs ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={busy}
                      onClick={() => setReplacing(true)}
                    >
                      {SIGN_IN_AGAIN_TEXT.button}
                    </Button>
                  ) : token ? (
                    <Button
                      variant={needs && !signInAgain ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setReplacing(true)}
                    >
                      Replace {secretWord}
                    </Button>
                  ) : conn.signIn !== 'none' ? (
                    <Button
                      variant={needs || askedAny ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={busy}
                      onClick={() => void reconnect()}
                    >
                      {askedAny ? `Allow on ${entry.name}…` : 'Reconnect'}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setVaultEntries('keep');
                      setConfirm(true);
                    }}
                  >
                    Remove
                  </Button>
                </span>
              )}
            </div>
            {replacing && again && (
              <form className={c.appForm} onSubmit={signInWithCode} noValidate>
                <GuideSteps
                  label={CONNECT_FORM_TEXT.making(again.words.label)}
                  steps={guidedSteps(entry, again.words, conn.fields)}
                />
                <label className={k.field} htmlFor={`${ids}-secret`}>
                  <span className={c.fieldLabel}>{again.words.label.toUpperCase()}</span>
                  <Input
                    ref={secretInput}
                    id={`${ids}-secret`}
                    size="md"
                    type="password"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={again.words.placeholder}
                    value={secret}
                    onChange={(e) => {
                      setSecretValue(e.target.value);
                      setProblem(null);
                    }}
                    invalid={problem !== null}
                  />
                </label>
                <p className={c.hint}>{again.words.help}</p>
                <div className={c.formActions}>
                  <Button type="submit" variant="primary" size="md" disabled={busy}>
                    {SIGN_IN_AGAIN_TEXT.submit}
                  </Button>
                  <Button variant="ghost" size="md" onClick={stopReplacing}>
                    Cancel
                  </Button>
                  {setSecret.isPending && (
                    <span className={k.busy} role="status">
                      <span className={k.spinner} aria-hidden="true" />
                      {SIGN_IN_AGAIN_TEXT.signingIn(entry.name)}
                    </span>
                  )}
                </div>
              </form>
            )}
            {replacing && !again && method?.kind === 'token' && (
              <form className={c.appForm} onSubmit={replace} noValidate>
                <label className={k.field} htmlFor={`${ids}-secret`}>
                  <span className={c.fieldLabel}>{method.secretLabel.toUpperCase()}</span>
                  <Input
                    id={`${ids}-secret`}
                    size="md"
                    type="password"
                    spellCheck={false}
                    autoComplete="new-password"
                    value={secret}
                    onChange={(e) => {
                      setSecretValue(e.target.value);
                      setCodeTrouble(null);
                    }}
                    invalid={problem !== null}
                  />
                </label>
                <p className={c.hint}>
                  {method.secretHelp} Whombat checks it before it replaces the old one.
                </p>
                {showCode && (
                  <Field
                    id={`${ids}-code`}
                    label={CONNECT_FORM_TEXT.code}
                    help={codeAsked ?? CONNECT_FORM_TEXT.codeHelp}
                    problem={codeTrouble ?? undefined}
                  >
                    <Input
                      ref={codeInput}
                      id={`${ids}-code`}
                      size="md"
                      inputMode="numeric"
                      spellCheck={false}
                      autoComplete="one-time-code"
                      placeholder={CONNECT_FORM_TEXT.codePlaceholder}
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setCodeTrouble(null);
                      }}
                      invalid={codeTrouble !== null}
                    />
                  </Field>
                )}
                <div className={c.formActions}>
                  <Button type="submit" variant="primary" size="md" disabled={busy}>
                    Save
                  </Button>
                  <Button variant="ghost" size="md" onClick={stopReplacing}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {confirm && usedByVaultSync(entry) && (
              // The Vault's sync asks what becomes of the entries it kept in step; 1Password itself never changes.
              <div className={c.appForm} data-remove="vault-sync">
                <p className={c.hint}>{ONEPASSWORD_APP_TEXT.removeAsk(conn.label)}</p>
                <OptionCards
                  name={`${ids}-vault-entries`}
                  label={ONEPASSWORD_APP_TEXT.removeChoice}
                  options={ONEPASSWORD_DISCONNECT_OPTIONS}
                  value={vaultEntries}
                  disabled={busy}
                  onChange={(v) => setVaultEntries(v === 'remove' ? 'remove' : 'keep')}
                />
                <div className={c.formActions}>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void remove()}>
                    Remove {conn.label}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {confirm && !usedByVaultSync(entry) && (
              <div className={c.formActions}>
                <span className={c.hint}>
                  {usedByGateway(entry)
                    ? `Remove ${conn.label}? Claude Code and ChatGPT run on your own sign-in again.`
                    : usedByAutomations(entry)
                      ? `Remove ${conn.label}? Automations that read it get no new reports until you connect it again.`
                      : `Remove ${conn.label}? ${agent.Name} can’t use it until you connect it again.`}
                </span>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void remove()}>
                  Remove {conn.label}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
                  Cancel
                </Button>
              </div>
            )}
            {problem && (
              <p className={c.error} role="alert">
                {problem}
              </p>
            )}
            {entry.docsUrl && !replacing && !confirm && (
              <div>
                <ExternalLink href={entry.docsUrl}>{entry.name} documentation</ExternalLink>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * What the server said after Remove, when it said something: a Fusebox that couldn't be reached keeps Whombat's client,
 * so its sentence says to remove it there (AIG-03, AP-1119). Null otherwise (the toast says “Fusebox removed.”).
 */
export function removedNotice(data: { notice?: string | null }): string | null {
  return data.notice?.trim() || null;
}

const TIER_OPTIONS = (tool: ConnectionToolView) =>
  CONNECTION_TOOL_TIERS.map((value: ConnectionToolTier) => ({
    value,
    label: CONNECTION_TOOL_TIER_LABELS[value],
    disabled: !tierSelectable(tool, value),
  }));

/** From this many tools the list gets a filter (Home Assistant's server lists over a hundred; AP-833). */
const TOOLS_FILTER_FROM = 12;

/** TOOLS: each tool with what it does and its tier (CX-18, CX-72). */
function ToolsSection({
  burrow,
  conn,
  tools,
  truncated,
}: {
  burrow: string;
  conn: ConnectionView;
  tools: readonly ConnectionToolView[];
  truncated: boolean;
}) {
  const setTool = useConnectionWrite(api.connections.setTool, burrow);
  const said = useConnectionWords(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterId = useId();
  const words = filter.trim().toLowerCase();
  const shown = words
    ? tools.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(words))
    : tools;
  return (
    <section className={styles.section} aria-labelledby="connection-tools">
      <SectionLabel as="h2" id="connection-tools">
        TOOLS
      </SectionLabel>
      {/* One sentence (AP-1751): a call that always asks says so on its own row (“Always asks”). */}
      <p className={c.hint}>{said.toolsHint(conn.label, conn.access === 'read')}</p>
      {tools.length > TOOLS_FILTER_FROM && (
        <div className={k.toolFilter}>
          <label className={c.srOnly} htmlFor={filterId}>
            Find a tool
          </label>
          <Input
            id={filterId}
            type="search"
            size="md"
            autoComplete="off"
            placeholder={`Find one of ${tools.length} tools`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      <div className={styles.card}>
        {tools.length === 0 ? (
          <p className={styles.empty}>No tools yet. Check again once the service is reachable.</p>
        ) : shown.length === 0 ? (
          <p className={styles.empty}>No tool matches “{filter.trim()}”.</p>
        ) : (
          <ul className={k.tools} aria-label="Tools">
            {shown.map((tool) => (
              <ToolRow
                tiersLabel={said.toolTiers(tool.name)}
                key={tool.name}
                tool={tool}
                pending={setTool.isPending}
                onChange={async (tier) => {
                  setProblem(null);
                  try {
                    await setTool.mutateAsync({
                      params: { burrow, connectionId: conn.id, tool: tool.name },
                      body: { tier },
                    });
                  } catch (err) {
                    setProblem(connectProblem(err).message);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>
      {truncated && (
        <p className={c.hint}>The service lists more tools than Whombat keeps: the rest are left out.</p>
      )}
      {problem && (
        <p className={c.error} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

function ToolRow({
  tool,
  pending,
  onChange,
  tiersLabel,
}: {
  tool: ConnectionToolView;
  /** The tiers' accessible name (“HassTurnOn: what Neo may do”). */
  tiersLabel: string;
  pending: boolean;
  onChange: (tier: ConnectionToolTier) => void;
}) {
  const id = useId();
  const tier = shownTier(tool);
  return (
    <li className={k.tool}>
      <span className={k.toolMain}>
        <span className={k.toolTitle}>
          <span id={`${id}-name`} className={k.toolName}>
            {tool.name}
          </span>
          {tool.isNew && (
            <Tag tone="brand" aria-label="New tool">
              {NEW_TOOL_LABEL}
            </Tag>
          )}
          {tool.sensitive && <Tag tone="warn">{ALWAYS_ASKS_LABEL}</Tag>}
        </span>
        <span className={`${c.meta} ${k.toolText}`} title={tool.description || undefined}>
          {accessText(tool)}
          {tool.description ? ` · ${tool.description}` : ''}
        </span>
      </span>
      <SegmentedControl<ConnectionToolTier>
        label={tiersLabel}
        size="sm"
        value={tier}
        disabled={pending}
        onChange={onChange}
        options={TIER_OPTIONS(tool)}
      />
    </li>
  );
}
