/**
 * The connect form as steps (Whombat connections-setup.md CS-50; contracts 0.61.0, CT-314; app AP-843…AP-847), on a
 * runtime with `connections.sign_in_once`: (1) Where is it? — the address, identified as it is entered
 * (`connections.identify`: the address to use, the service and its version, and a certificate of its own to compare and
 * trust before any password is typed, CS-05); cloud services skip it. (2) How should Whombat sign in? — the entry's
 * sign-ins as radio cards, Sign in once first and recommended (the account, the password, a second factor's code when
 * the service asks, CS-03), the token made by hand with numbered steps, values to copy, the level's link and one paste
 * box that fills the fields (CS-15), Nextcloud's login and the OAuth sign-ins as before, and — on a runtime with
 * `connections.service_login` — signing in on the service's own page in a new tab (Plex's; Whombat connection-signin.md
 * SG-01, SG-05; AP-3911), polled as Nextcloud's. A code the service asks for belongs to its challenge (UniFi's, SG-06) and
 * goes back with it; a session's two-step code (Synology, SG-09) is asked once the service does. What may the agent do? — Look only
 * or Manage (CS-10) — comes before the sign-in, which depends on it (AP-844); an entry only automations use (a report
 * tracker, Whombat TA-02) has no such step. Who it’s for and the name wait under More options. Settings' card with the Google
 * page's numbered step rows.
 */
import {
  accessChoices,
  asksAccess,
  asksTwoStepCode,
  authNameOf,
  CONNECT_FORM_TEXT,
  type ConnectDraft,
  codeShown,
  connectBase,
  connectReturnTo,
  createBody,
  draftProblems,
  elsewhereLevelNote,
  filledText,
  fixedAccountOf,
  guidedLink,
  guidedSteps,
  guideLabel,
  identifiedFields,
  identifies,
  identifyNote,
  initialFields,
  limitNote,
  nameHelp,
  ownsAuth,
  PLACED_FIELDS,
  pasteLabel,
  readPaste,
  recommended,
  SETUP_STEP_TITLES,
  type SetupStep,
  secretWords,
  serviceLoginBody,
  setupSteps,
  signInNote,
  signingInText,
  takesPaste,
  trustText,
} from '@whombat/client/connections';
import { holdGoogleConnect } from '@whombat/client/managed';
import { useConnectionWrite } from '@whombat/client/react';
import {
  api,
  type IdentifyConnectionResponse,
  type ProbeConnectionResponse,
  type StartNextcloudLoginResponse,
} from '@whombat/core/contracts';
import {
  type CatalogEntry,
  type CatalogSignIn,
  type ConnectionAccessLevel,
  fieldProblem,
  resolveTokenUrl,
  suggestedAccess,
} from '@whombat/core/domain';
import { ChevronRight } from 'lucide-react';
import { type DragEvent, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useManaged } from '../../app/providers';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { StatusDot } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import k from './Catalog.module.css';
import { ExternalLink, Field, GuideSteps } from './CatalogParts';
import c from './Connectors.module.css';
import {
  NextcloudWait,
  openLoginPage,
  openLoginTab,
  ProbeNote,
  pointLoginTab,
  type ServiceLoginStarted,
  ServiceLoginWait,
  usePreparedServiceLogin,
} from './ConnectParts';
import {
  type ConnectProblem,
  connectButtonText,
  connectProblem,
  httpWarning,
  NO_PROBLEM,
  type SignInChoice,
  signInChoices,
  switchText,
  visibleFields,
} from './catalog';
import { useAutomaticLabel } from './useAutomaticLabel';
import { useConnectionWords } from './useConnectionWords';
import { useOpenConnection } from './useOpenConnection';

type GuidedMethod = Extract<CatalogSignIn, { kind: 'token' | 'client_credentials' }>;

export function SetupForm({
  burrow,
  entry,
  initialUrl,
  initialAccess,
  leave,
}: {
  burrow: string;
  entry: CatalogEntry;
  /** `&url=` (Found on your network, CS-51): filled in and identified at once. */
  initialUrl?: string;
  /** `&access=` (the assistant's card, connect-in-chat.md); left out, chosen by risk (`suggestedAccess`). */
  initialAccess?: ConnectionAccessLevel;
  leave: (url: string) => void;
}) {
  const ids = useId();
  const toast = useToast();
  const openConnection = useOpenConnection();
  const managed = useManaged();
  const create = useConnectionWrite(api.connections.create, burrow);
  const startOAuth = useConnectionWrite(api.connections.startOAuth, burrow);
  const startNextcloud = useConnectionWrite(api.connections.startNextcloud, burrow);
  const startService = useConnectionWrite(api.connections.startServiceLogin, burrow);
  const probe = useConnectionWrite(api.connections.probe, burrow);
  const identify = useConnectionWrite(api.connections.identify, burrow);
  const allowNetwork = useConnectionWrite(api.connections.allowNetwork, burrow);
  // Signing in on the service's own page (CT-744).
  const choices = signInChoices(entry);
  // The assistant by its name in the assistant shell (less-is-more.md AP-1802).
  const words = useConnectionWords(burrow);
  const steps = setupSteps(entry);
  const urlField = entry.fields.find((f) => f.id === 'url');
  const certField = entry.fields.find((f) => f.id === 'fingerprint');
  const [index, setIndex] = useState(0);
  const choice = choices[index] ?? (choices[0] as SignInChoice);
  const method = choice.method;
  const [fields, setFields] = useState<Record<string, string>>(() => initialFields(entry, initialUrl));
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  /** The service asked for a second factor's code (CS-03): its words. The password stays typed for the second request. */
  const [codeAsked, setCodeAsked] = useState<string | null>(null);
  /** The sealed challenge the code answers (SG-06, AP-3909): sent back with it, forgotten when the sign-in changes. */
  const [challenge, setChallenge] = useState<string | null>(null);
  // Look only or Manage by risk unless the link said (connect-in-chat.md): Manage for lights, Look only for a NAS.
  const [access, setAccess] = useState<ConnectionAccessLevel>(() => initialAccess ?? suggestedAccess(entry));
  const [authName, setAuthName] = useState<string>(() => authNameOf(choice));
  const [problem, setProblem] = useState<ConnectProblem>(NO_PROBLEM);
  const [probed, setProbed] = useState<ProbeConnectionResponse | null>(null);
  const [login, setLogin] = useState<StartNextcloudLoginResponse | null>(null);
  const [service, setService] = useState<ServiceLoginStarted | null>(null);
  const [identified, setIdentified] = useState<IdentifyConnectionResponse | null>(null);
  // Steps 2 and 3 open once the address is identified (or has a default, or isn't identified at all).
  const [revealed, setRevealed] = useState(() => !identifies(entry) || !!urlField?.default);
  const [more, setMore] = useState(false);
  /** The address last identified (or being identified), so one address is asked once. */
  const asked = useRef<{ url: string; done: boolean } | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const shown = visibleFields(entry, choice);
  const methodFields = shown.filter((f) => !PLACED_FIELDS.has(f.id));
  const busy =
    create.isPending ||
    startOAuth.isPending ||
    startNextcloud.isPending ||
    startService.isPending ||
    allowNetwork.isPending ||
    identify.isPending;
  const warning = httpWarning(fields, choice.kind, method, entry.id);
  const placeholderLabel = useAutomaticLabel(burrow, entry, fields);
  // A Custom entry names its own header or query parameter (CT-269: `auth` checked with `tokenAuthProblem`).
  const ownAuth = ownsAuth(entry, method);
  const fixedAccount = fixedAccountOf(method);
  const showCode = codeShown(method, codeAsked !== null);
  // The service's own page is made ready while the form is filled in, so the click opens it directly.
  const prepared = usePreparedServiceLogin(
    burrow,
    method.kind === 'service_login' &&
      revealed &&
      !service &&
      !Object.keys(draftProblems(entry, choice, shown, draft(fields))).length
      ? serviceLoginBody(entry, shown, draft(fields))
      : null,
  );

  function pick(next: number) {
    setIndex(next);
    setAuthName(authNameOf(choices[next] ?? choice));
    setProblem(NO_PROBLEM);
    setCodeAsked(null);
    setChallenge(null);
    setCode('');
  }

  function setField(id: string, value: string) {
    setFields((f) => ({ ...f, [id]: value }));
    if (problem.fields[id]) setProblem((p) => ({ ...p, fields: { ...p.fields, [id]: '' } }));
    if (id === 'url') {
      setProbed(null);
      setIdentified(null);
    }
  }

  function clearProblem(id: string) {
    if (problem.fields[id]) setProblem((p) => ({ ...p, fields: { ...p.fields, [id]: '' } }));
  }

  /** What is at the address (CS-13): the address to use, the service, its certificate. Asked once per address. */
  async function runIdentify(raw: string = fields.url ?? '') {
    const url = raw.trim();
    if (!url) {
      setProblem({ ...NO_PROBLEM, fields: { url: `${urlField?.label ?? 'Address'} is needed.` } });
      return;
    }
    // An address with its scheme is checked here first (TrueNAS refuses `http://`, contracts 0.97 CT-474): its reason
    // under the field, before anything is asked of it. A bare host gets the entry's scheme from the Whombat.
    const local = urlField && /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? fieldProblem(urlField, url) : null;
    if (local) {
      asked.current = null;
      setProblem({ ...NO_PROBLEM, fields: { url: local } });
      return;
    }
    if (asked.current?.url === url) {
      if (asked.current.done) setRevealed(true);
      return;
    }
    asked.current = { url, done: false };
    setProblem(NO_PROBLEM);
    try {
      const result = await identify.mutateAsync({ body: { catalogId: entry.id, url } });
      if (result.status !== 'ok') {
        asked.current = null;
        return;
      }
      asked.current = { url: result.data.url, done: true };
      setIdentified(result.data);
      // A home-network server's own certificate is trusted at once; Undo takes it back.
      setFields((f) => identifiedFields(entry, f, result.data));
      setRevealed(true);
    } catch (err) {
      asked.current = null;
      const p = connectProblem(err);
      setProblem(p);
      // Only a refused or unreadable address holds the form back; anything else, the person can still go on.
      if (!p.network && !p.fields.url) setRevealed(true);
    }
  }

  // Found on your network sends the address along (`&url=`): what it is shows at once (CS-51).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the address the page opened with
  useEffect(() => {
    if (initialUrl && identifies(entry)) void runIdentify(initialUrl);
  }, []);

  useEffect(() => {
    if (codeAsked !== null) codeInput.current?.focus();
  }, [codeAsked]);

  /** What the person typed and picked, as the shared rules read it. */
  function draft(current: Record<string, string>): ConnectDraft {
    return {
      fields: current,
      secret,
      account,
      password,
      code,
      codeAsked: codeAsked !== null,
      challenge,
      authName,
      label,
      access,
    };
  }

  function show(p: ConnectProblem) {
    setProblem(p);
    if (p.secondFactor) setCodeAsked(p.secondFactor);
    if (p.challenge) setChallenge(p.challenge);
    if (p.fields.label || p.fields.fingerprint) setMore(true);
  }

  /** Connects with the form's fields, or with `current` when a button just changed them (“Use this fingerprint”). */
  async function connect(current: Record<string, string> = fields) {
    if (!revealed) return runIdentify();
    const local = draftProblems(entry, choice, shown, draft(current));
    if (Object.keys(local).length) {
      setProblem({ ...NO_PROBLEM, fields: local });
      if (local.label || local.fingerprint) setMore(true);
      return;
    }
    setProblem(NO_PROBLEM);
    const body = connectBase(entry, shown, draft(current));
    if (method.kind === 'service_login') {
      // Made ready before the click: its page opens in the click itself.
      const ready = prepared.take(serviceLoginBody(entry, shown, draft(current)));
      if (ready) {
        openLoginPage(ready.loginUrl);
        setService({ login: ready, tab: null });
        return;
      }
    }
    try {
      if (
        method.kind === 'token' ||
        method.kind === 'none' ||
        method.kind === 'password' ||
        method.kind === 'client_credentials'
      ) {
        const result = await create.mutateAsync({
          params: { burrow },
          body: createBody(entry, choice, shown, draft(current)),
        });
        if (result.status !== 'ok') {
          setProblem({ ...NO_PROBLEM, message: CONNECT_FORM_TEXT.notThrough });
          return;
        }
        setSecret('');
        setPassword('');
        setCode('');
        setChallenge(null);
        toast.show(CONNECT_FORM_TEXT.connected(result.data.connection.label));
        openConnection(entry.id, result.data.connection.id);
      } else if (method.kind === 'nextcloud_login') {
        // The login opens in a new tab: opened now, while the click still counts, and pointed at Nextcloud once known.
        const tab = window.open('about:blank', '_blank');
        try {
          const result = await startNextcloud.mutateAsync({ params: { burrow }, body });
          if (result.status !== 'ok') throw new Error('not started');
          if (tab) {
            tab.opener = null;
            tab.location.href = result.data.loginUrl;
          }
          setLogin(result.data);
        } catch (err) {
          tab?.close();
          throw err;
        }
      } else if (method.kind === 'service_login') {
        // The service's own page (SG-01): the tab opens in the click, then goes to the page the start names.
        const tab = openLoginTab();
        try {
          const result = await startService.mutateAsync({
            params: { burrow },
            body: serviceLoginBody(entry, shown, draft(current)),
          });
          if (result.status !== 'ok') throw new Error('not started');
          setService({ login: result.data, tab: pointLoginTab(tab, result.data.loginUrl) });
        } catch (err) {
          tab?.close();
          throw err;
        }
      } else {
        const returnTo = connectReturnTo(entry.id, burrow);
        // On a managed Whombat the sign-in comes back to the hosted UI (AP-766): which Whombat started it is held here.
        if (
          managed &&
          !holdGoogleConnect(() => sessionStorage, {
            device: managed.applianceId,
            returnTo,
            flow: 'connection',
          })
        ) {
          setProblem({ ...NO_PROBLEM, message: CONNECT_FORM_TEXT.cantStart });
          return;
        }
        const result = await startOAuth.mutateAsync({
          params: { burrow },
          body: { ...body, method: method.kind, returnTo },
        });
        if (result.status === 'ok') leave(result.data.authorizeUrl);
      }
    } catch (err) {
      // A session's password keeps the server's words for a refusal (AP-3805).
      show(connectProblem(err, undefined, method));
    }
  }

  async function addNetwork() {
    if (!problem.network) return;
    try {
      const result = await allowNetwork.mutateAsync({
        body: { cidr: problem.network.cidr, port: problem.network.port, note: entry.name },
      });
      if (result.status !== 'ok') return;
      toast.show(CONNECT_FORM_TEXT.networkAdded(problem.network.cidr, problem.network.port));
      if (revealed) await connect();
      else {
        asked.current = null;
        await runIdentify();
      }
    } catch (err) {
      show(connectProblem(err));
    }
  }

  /** Pins the certificate the server presented on connect (CT-313) and connects again. */
  async function pinCertificate() {
    if (!problem.certificate) return;
    const pinned = { ...fields, fingerprint: problem.certificate };
    setFields(pinned);
    await connect(pinned);
  }

  async function runProbe() {
    const url = fields.url?.trim() ?? '';
    const p = urlField ? fieldProblem(urlField, url) : null;
    if (p) {
      setProblem({ ...NO_PROBLEM, fields: { url: p } });
      return;
    }
    setProblem(NO_PROBLEM);
    try {
      const result = await probe.mutateAsync({ body: { catalogId: entry.id, fields: { url } } });
      if (result.status !== 'ok') return;
      setProbed(result.data);
      const want =
        result.data.needs === 'open' ? 'none' : result.data.needs === 'oauth' ? 'mcp_oauth' : 'token';
      const next = choices.findIndex((ch) => ch.kind === want);
      if (result.data.needs !== 'unreachable' && next >= 0) pick(next);
    } catch (err) {
      setProblem(connectProblem(err));
    }
  }

  /** A paste or a dropped file in the guided token's box (CS-15): fills what it finds, says what it filled. */
  function fill(m: GuidedMethod, text: string): string | null {
    const found = readPaste(entry, m, text);
    if (!found) return null;
    if (Object.keys(found.fields).length) setFields((f) => ({ ...f, ...found.fields }));
    if (found.secret) setSecret(found.secret);
    setProblem((p) => ({
      ...p,
      fields: Object.fromEntries(
        Object.entries(p.fields).filter(
          ([id]) => !(id in found.fields) && !(id === 'secret' && found.secret),
        ),
      ),
    }));
    return filledText(found.filled);
  }

  if (service)
    return (
      <ServiceLoginWait
        burrow={burrow}
        entry={entry}
        started={service}
        onCancel={() => setService(null)}
        onFailed={(message) => {
          setService(null);
          setProblem({ ...NO_PROBLEM, message });
        }}
      />
    );

  if (login)
    return (
      <NextcloudWait
        burrow={burrow}
        entry={entry}
        login={login}
        access={access}
        onCancel={() => setLogin(null)}
        onFailed={(message) => {
          setLogin(null);
          setProblem({ ...NO_PROBLEM, message });
        }}
      />
    );

  const certificate =
    identified?.certificate && !identified.certificate.trusted ? identified.certificate : null;
  const pinned = !!certificate && fields.fingerprint === certificate.sha256;
  const note = identified ? identifyNote(entry, identified) : null;
  const instead = problem.switchTo ? choices.findIndex((ch) => ch.kind === problem.switchTo) : -1;

  // Sign in once's code (CS-03), or a session's two-step code once the service asked (SG-09, AP-3906).
  const codeField = (
    <Field
      id={`${ids}-code`}
      label={codeAsked === null ? CONNECT_FORM_TEXT.codeOptional : CONNECT_FORM_TEXT.code}
      help={codeAsked ?? CONNECT_FORM_TEXT.codeHelp}
      problem={problem.fields.code}
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
          clearProblem('code');
        }}
        invalid={!!problem.fields.code}
      />
    </Field>
  );

  const stepBody: Record<SetupStep, ReactNode> = {
    where: urlField ? (
      <>
        <Field
          id={`${ids}-url`}
          label={urlField.label}
          help={urlField.help}
          problem={problem.fields.url}
          after={
            entry.id === 'custom_mcp' ? (
              <Button
                variant="secondary"
                size="md"
                type="button"
                disabled={probe.isPending || busy}
                onClick={() => void runProbe()}
              >
                {CONNECT_FORM_TEXT.checkAddress}
              </Button>
            ) : null
          }
        >
          <Input
            id={`${ids}-url`}
            size="md"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder={urlField.placeholder}
            value={fields.url ?? ''}
            onChange={(e) => setField('url', e.target.value)}
            onBlur={(e) => {
              if (identifies(entry) && e.target.value.trim()) void runIdentify(e.target.value);
            }}
            invalid={!!problem.fields.url}
          />
        </Field>
        {probed && <ProbeNote probed={probed} />}
        {identify.isPending && (
          <span className={k.busy} role="status">
            <span className={k.spinner} aria-hidden="true" />
            {CONNECT_FORM_TEXT.identifying}
          </span>
        )}
        {note && !identify.isPending && (
          <div className={k.found} role="status">
            <StatusDot tone={note.tone} size={8} label={null} />
            <span className={k.foundText}>
              <span className={k.foundTitle}>{note.title}</span>
              <span className={c.meta}>{note.text}</span>
            </span>
          </div>
        )}
        {certificate && !identify.isPending && (
          <CertificateNote
            entry={entry}
            sha256={certificate.sha256}
            canPin={!!certField}
            pinned={pinned}
            onTrust={() => setField('fingerprint', certificate.sha256)}
            onUndo={() => setField('fingerprint', '')}
          />
        )}
      </>
    ) : null,
    signIn: (
      <>
        {choices.length > 1 && (
          <fieldset className={k.fieldset}>
            <legend className={c.srOnly}>{CONNECT_FORM_TEXT.howSignsIn}</legend>
            <div className={k.scopes}>
              {choices.map((ch) => (
                <label key={ch.index} className={k.scope}>
                  <input
                    type="radio"
                    name={`${ids}-method`}
                    className={k.radio}
                    value={ch.index}
                    checked={index === ch.index}
                    disabled={busy}
                    onChange={() => pick(ch.index)}
                  />
                  <span className={k.scopeText}>
                    <span className={k.titleLine}>
                      <span className={k.scopeTitle}>{ch.label}</span>
                      {recommended(ch) && <Tag tone="brand">{CONNECT_FORM_TEXT.recommended}</Tag>}
                    </span>
                    <span className={c.meta}>{signInNote(entry, ch.method)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className={k.method} data-plain={choices.length === 1 || undefined}>
          {choices.length === 1 && method.kind === 'password' && (
            <p className={c.stepText}>{method.creates}</p>
          )}
          {method.kind === 'password' && (
            <>
              {/* No account (T3 Code's pairing code, Whombat t3code.md T3-02): the secret alone. */}
              {!method.account ? null : fixedAccount ? (
                <div className={k.field}>
                  <span className={c.fieldLabel}>{method.account.label.toUpperCase()}</span>
                  <span className={k.mono}>{fixedAccount}</span>
                  {method.account.help && <p className={c.hint}>{method.account.help}</p>}
                </div>
              ) : (
                <Field
                  id={`${ids}-account`}
                  label={method.account.label}
                  help={method.account.help}
                  problem={problem.fields.account}
                >
                  <Input
                    id={`${ids}-account`}
                    size="md"
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="none"
                    placeholder={method.account.placeholder}
                    value={account}
                    onChange={(e) => {
                      setAccount(e.target.value);
                      setChallenge(null);
                      clearProblem('account');
                    }}
                    invalid={!!problem.fields.account}
                  />
                </Field>
              )}
              {/* A secret with its own name (T3 Code's pairing code): the steps to make one, like a token's. */}
              <GuideSteps
                label={CONNECT_FORM_TEXT.making(secretWords(method).label)}
                steps={guidedSteps(entry, secretWords(method), fields)}
              />
              <Field
                id={`${ids}-password`}
                label={method.secret?.label ?? CONNECT_FORM_TEXT.password}
                help={method.secret?.help ?? CONNECT_FORM_TEXT.passwordHelp}
                problem={problem.fields.password}
              >
                <Input
                  id={`${ids}-password`}
                  size="md"
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={method.secret?.placeholder}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setChallenge(null);
                    clearProblem('password');
                  }}
                  invalid={!!problem.fields.password}
                />
              </Field>
              {showCode && codeField}
            </>
          )}
          {(method.kind === 'token' || method.kind === 'client_credentials') && (
            <GuidedToken
              key={choice.index}
              ids={ids}
              entry={entry}
              method={method}
              fields={fields}
              access={asksAccess(choice) ? access : 'manage'}
              onPaste={(text) => fill(method, text)}
            />
          )}
          {methodFields.map((f) => (
            <Field
              key={f.id}
              id={`${ids}-${f.id}`}
              label={f.label}
              help={f.help}
              problem={problem.fields[f.id]}
            >
              {f.guide ? (
                <textarea
                  id={`${ids}-${f.id}`}
                  className={k.textarea}
                  rows={4}
                  placeholder={f.placeholder}
                  value={fields[f.id] ?? ''}
                  onChange={(e) => setField(f.id, e.target.value)}
                  aria-invalid={problem.fields[f.id] ? true : undefined}
                />
              ) : (
                <Input
                  id={`${ids}-${f.id}`}
                  size="md"
                  type={f.kind === 'url' ? 'url' : 'text'}
                  inputMode={f.kind === 'url' ? 'url' : undefined}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={fields[f.id] ?? ''}
                  onChange={(e) => setField(f.id, e.target.value)}
                  invalid={!!problem.fields[f.id]}
                />
              )}
            </Field>
          ))}
          {ownAuth && method.kind === 'token' && (
            <Field
              id={`${ids}-auth`}
              label={
                method.auth.type === 'query' ? CONNECT_FORM_TEXT.parameterName : CONNECT_FORM_TEXT.headerName
              }
              help={
                method.auth.type === 'query' ? CONNECT_FORM_TEXT.parameterHelp : CONNECT_FORM_TEXT.headerHelp
              }
              problem={problem.fields.authName}
            >
              <Input
                id={`${ids}-auth`}
                size="md"
                spellCheck={false}
                autoComplete="off"
                value={authName}
                onChange={(e) => setAuthName(e.target.value)}
                invalid={!!problem.fields.authName}
              />
            </Field>
          )}
          {(method.kind === 'token' || method.kind === 'client_credentials') && (
            <Field
              id={`${ids}-secret`}
              label={method.secretLabel}
              help={method.steps.length ? undefined : method.secretHelp}
              problem={problem.fields.secret}
              link={
                !method.steps.length && method.kind === 'token' && resolveTokenUrl(entry, fields) ? (
                  <ExternalLink href={resolveTokenUrl(entry, fields) as string}>
                    Open {entry.name}
                  </ExternalLink>
                ) : null
              }
            >
              <Input
                id={`${ids}-secret`}
                size="md"
                type="password"
                spellCheck={false}
                autoComplete="new-password"
                placeholder={method.secretPlaceholder ?? ''}
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  clearProblem('secret');
                }}
                invalid={!!problem.fields.secret}
              />
            </Field>
          )}
          {asksTwoStepCode(method) && showCode && codeField}
          {method.kind === 'nextcloud_login' && <p className={c.stepText}>{CONNECT_FORM_TEXT.nextcloud}</p>}
          {method.kind === 'service_login' && (
            <p className={c.stepText}>{CONNECT_FORM_TEXT.serviceLogin(entry.name)}</p>
          )}
          {method.kind === 'ha_oauth' && <p className={c.stepText}>{CONNECT_FORM_TEXT.homeAssistant}</p>}
          {elsewhereLevelNote(entry, choice, access) && (
            <p className={c.hint}>{elsewhereLevelNote(entry, choice, access)}</p>
          )}
        </div>
      </>
    ),
    access: (
      <>
        <fieldset className={k.fieldset}>
          <legend className={c.srOnly}>{words.mayDoQuestion}</legend>
          <div className={k.scopes}>
            {accessChoices(entry)
              .map((a) => ({ ...a, text: words.access(a.text) }))
              .map((a) => (
                <label key={a.value} className={k.scope}>
                  <input
                    type="radio"
                    name={`${ids}-access`}
                    className={k.radio}
                    value={a.value}
                    checked={access === a.value}
                    disabled={busy}
                    onChange={() => setAccess(a.value)}
                  />
                  <span className={k.scopeText}>
                    <span className={k.scopeTitle}>{a.label}</span>
                    <span className={c.meta}>{a.text}</span>
                  </span>
                </label>
              ))}
          </div>
        </fieldset>
        {limitNote(entry, method, words) && (
          <p className={`${c.hint} ${k.narrow}`}>{limitNote(entry, method, words)}</p>
        )}
      </>
    ),
  };

  const open = revealed ? steps : steps.filter((s) => s === 'where');

  return (
    <form
      className={k.setup}
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void connect();
      }}
    >
      <ol className={c.steps} aria-label={`Connect ${entry.name}`}>
        {open.map((step, i) => (
          <li key={step} className={c.step}>
            <span className={c.stepMark}>
              <span
                className={c.stepNumber}
                data-done={(step === 'where' && note?.tone === 'ok') || undefined}
                aria-hidden="true"
              >
                {i + 1}
              </span>
            </span>
            <div className={c.stepMain}>
              <h3 className={c.stepTitle}>
                <span className={c.srOnly}>Step {i + 1}: </span>
                {step === 'access' ? words.mayDoQuestion : SETUP_STEP_TITLES[step]}
              </h3>
              <div className={k.stepBody}>{stepBody[step]}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className={k.setupFoot}>
        {revealed && (
          <div className={k.more}>
            <div className={k.moreHead}>
              <button
                type="button"
                className={k.moreToggle}
                aria-expanded={more}
                aria-controls={`${ids}-more`}
                onClick={() => setMore((m) => !m)}
              >
                <Icon icon={ChevronRight} size={15} />
                {CONNECT_FORM_TEXT.moreOptions}
              </button>
              {!more && (
                <span className={c.meta}>
                  {CONNECT_FORM_TEXT.moreSummary(label.trim() || placeholderLabel)}
                </span>
              )}
            </div>
            {more && (
              <div id={`${ids}-more`} className={k.moreBody}>
                <Field
                  id={`${ids}-label`}
                  label={CONNECT_FORM_TEXT.name}
                  help={nameHelp(entry, words)}
                  problem={problem.fields.label}
                >
                  <Input
                    id={`${ids}-label`}
                    size="md"
                    autoComplete="off"
                    placeholder={placeholderLabel}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    invalid={!!problem.fields.label}
                  />
                </Field>
                {certField && shown.some((f) => f.id === 'fingerprint') && (
                  <Field
                    id={`${ids}-fingerprint`}
                    label={certField.label}
                    help={certField.help}
                    problem={problem.fields.fingerprint}
                  >
                    <Input
                      id={`${ids}-fingerprint`}
                      size="md"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={certField.placeholder}
                      value={fields.fingerprint ?? ''}
                      onChange={(e) => setField('fingerprint', e.target.value)}
                      invalid={!!problem.fields.fingerprint}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        )}

        {revealed && warning && <p className={k.warn}>{warning}</p>}

        {problem.choice && (
          <fieldset className={k.fieldset}>
            <legend className={c.fieldLabel}>
              {(
                entry.fields.find((f) => f.id === problem.choice?.field)?.label ?? CONNECT_FORM_TEXT.chooseOne
              ).toUpperCase()}
            </legend>
            <div className={k.scopes}>
              {problem.choice.options.map((o) => (
                <label key={o.value} className={k.scope}>
                  <input
                    type="radio"
                    name={`${ids}-choice`}
                    className={k.radio}
                    value={o.value}
                    checked={fields[problem.choice?.field ?? ''] === o.value}
                    onChange={() => setFields((f) => ({ ...f, [problem.choice?.field ?? '']: o.value }))}
                  />
                  <span className={k.scopeText}>
                    <span className={k.scopeTitle}>{o.label}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {problem.message && (
          <div className={k.problem} role="alert">
            <p className={problem.choice ? c.stepText : c.error}>{problem.message}</p>
            {problem.network && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => void addNetwork()}
              >
                {CONNECT_FORM_TEXT.addNetwork}
              </Button>
            )}
            {problem.certificate && certField && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => void pinCertificate()}
              >
                {CONNECT_FORM_TEXT.useFingerprint}
              </Button>
            )}
            {problem.switchTo && instead >= 0 && instead !== index && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => pick(instead)}
              >
                {switchText(problem.switchTo, entry)}
              </Button>
            )}
          </div>
        )}

        <div className={c.formActions}>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy || (!!problem.choice && !fields[problem.choice.field])}
          >
            {revealed ? connectButtonText(entry, choice) : CONNECT_FORM_TEXT.continue}
          </Button>
          {create.isPending && method.kind === 'password' && (
            <span className={k.busy} role="status">
              <span className={k.spinner} aria-hidden="true" />
              {signingInText(entry, method)}
            </span>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * A certificate of the server's own (CS-05): its fingerprint to compare with what the service shows, and Trust this
 * certificate, which fills the entry's fingerprint field. Entries that can't pin one only say it can't be verified.
 */
function CertificateNote({
  entry,
  sha256,
  canPin,
  pinned,
  onTrust,
  onUndo,
}: {
  entry: CatalogEntry;
  sha256: string;
  canPin: boolean;
  pinned: boolean;
  onTrust: () => void;
  onUndo: () => void;
}) {
  if (pinned)
    return (
      <div className={k.trusted}>
        <StatusDot tone="ok" size={7} label={null} />
        <span>{CONNECT_FORM_TEXT.trusted}</span>
        <Button variant="ghost" size="sm" onClick={onUndo}>
          {CONNECT_FORM_TEXT.undo}
        </Button>
      </div>
    );
  return (
    <div className={k.cert}>
      <p className={c.stepText}>
        {canPin ? CONNECT_FORM_TEXT.ownCertificate : CONNECT_FORM_TEXT.unverifiable}
      </p>
      <code className={k.fingerprint}>{sha256}</code>
      {canPin && (
        <>
          <p className={c.hint}>{trustText(entry)}</p>
          <Button variant="secondary" size="sm" onClick={onTrust}>
            {CONNECT_FORM_TEXT.trust}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * Making the token by hand, guided (CS-15): the numbered steps with values to copy, “Open {Name}” where the key is made
 * (the level's link fills the service's form), and one box to paste the dialog or drop the file into.
 */
function GuidedToken({
  ids,
  entry,
  method,
  fields,
  access,
  onPaste,
}: {
  ids: string;
  entry: CatalogEntry;
  method: GuidedMethod;
  fields: Readonly<Record<string, string>>;
  access: ConnectionAccessLevel;
  onPaste: (text: string) => string | null;
}) {
  const [text, setText] = useState('');
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const steps = guidedSteps(entry, method, fields);
  const link = guidedLink(entry, method, access, fields);
  const label = pasteLabel(entry);

  function take(value: string) {
    if (!value.trim()) return;
    const filled = onPaste(value);
    setText('');
    setNote(filled ? { text: filled, ok: true } : { text: CONNECT_FORM_TEXT.pasteNothing, ok: false });
  }

  async function takeFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 64_000) {
      setNote({ text: CONNECT_FORM_TEXT.fileTooBig, ok: false });
      return;
    }
    take(await f.text());
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) void takeFile(dropped);
    else take(event.dataTransfer.getData('text/plain'));
  }

  if (!steps.length && !method.paste.length) return null;
  return (
    <>
      <GuideSteps label={guideLabel(method)} steps={steps} />
      {link && (
        <ButtonLink
          className={k.guideLink}
          variant="secondary"
          size="sm"
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          iconEnd={<Icon name="external" size={13} />}
        >
          Open {entry.name}
          <span className={c.srOnly}> (opens in a new tab)</span>
        </ButtonLink>
      )}
      {/* A session's password is the person's own: nothing to paste (AP-3807). */}
      {takesPaste(method) && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the text box and the button are the keyboard way
        <div
          className={k.paste}
          data-over={over || undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <textarea
            id={`${ids}-paste`}
            className={k.pasteArea}
            rows={2}
            aria-label={label}
            placeholder={label}
            spellCheck={false}
            autoComplete="off"
            value={text}
            onPaste={(e) => {
              e.preventDefault();
              take(e.clipboardData.getData('text/plain'));
            }}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => take(text)}
          />
          <div className={k.pasteFoot}>
            <button type="button" className={c.fileButton} onClick={() => file.current?.click()}>
              {CONNECT_FORM_TEXT.chooseFile}
            </button>
            {note && (
              <p className={k.pasteNote} data-tone={note.ok ? undefined : 'bad'} role="status">
                {note.text}
              </p>
            )}
          </div>
          <input
            ref={file}
            type="file"
            className={c.srOnly}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void takeFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      )}
    </>
  );
}
