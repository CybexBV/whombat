/**
 * What a connection's screen changes on the phone (phone-connect.md PC-09, AP-2911), the web's ConnectionPage at phone
 * width: NAME with Rename, WHAT {AGENT} MAY DO with Change (Look only · Manage; raising a key made at Look only says so,
 * with Sign in again), the choices that can change later (Find My's Mac and Read in the background), the last check
 * with Check again, and SIGN-IN — a new key or password (checked before it replaces
 * the old one; an OAuth client's secret too; a session's two-step code when the service asks, Synology's, AP-3958),
 * Reconnect (a sign-in elsewhere in the browser or Nextcloud's login, on the same connection; nothing that would make a
 * second one, AP-2920), Sign in again on the service's own page (Plex's, AP-3957) or with a new code (T3 Code's pairing
 * code: the steps to make one and its field) and Remove (asked first; the Vault's sync asks in place whether the
 * entries it kept in step stay in the Vault). Before, a button opened the web page.
 */
import { disconnectQuery, ONEPASSWORD_APP_TEXT, ONEPASSWORD_DISCONNECT_OPTIONS } from '@whombat/client';
import {
  accessChoices,
  type ChoiceSetting,
  CONNECT_FORM_TEXT,
  type ConnectionWords,
  choiceSavedText,
  choiceSettings,
  codeProblem,
  codeSignInOf,
  connectionWords,
  connectProblem,
  connectReturnTo,
  guidedSteps,
  reconnectServiceLoginBody,
  SIGN_IN_AGAIN_TEXT,
  setSecretBody,
  usedByAgents,
  usedByVaultSync,
} from '@whombat/client/connections';
import { useMacChoices } from '@whombat/client/hosts/react';
import { useConnectionWrite } from '@whombat/client/react';
import {
  type CatalogEntry,
  CONNECTION_ACCESS_LABELS,
  type ConnectionAccessLevel,
  type ConnectionView,
  catalogSignIn,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { OnePasswordDisconnectChoice } from '@whombat/core/vault';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { elsewhereWay, opensItself, type PendingLogin } from '../../data/connectForm';
import {
  CONNECTION_CHANGE_TEXT,
  raisedNote,
  reconnectWay,
  removeAsk,
  replacedText,
  replaceProblem,
  signInView,
  stacksActions,
} from '../../data/connectionChange';
import { connectionsWebPath } from '../../data/connections';
import { useAgentWords } from '../../data/useAgent';
import { useWebUrl } from '../../data/useWebUrl';
import { holdPhoneConnect } from '../../managed/connectReturn';
import { useManaged } from '../../managed/context';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { FormField, FormMessage } from '../../ui/formField';
import { Button, Section } from '../../ui/primitives';
import { RadioCards } from '../../ui/radioCards';
import { showNotice } from '../feedback';
import { GuideSteps, LoginWaitView, Note, openOutside, TextLink } from './parts';
import { useLoginWait } from './useLoginWait';

/** NAME: the label, and Rename for those who may change it. */
export function NameBlock({ slug, conn }: { slug: string; conn: ConnectionView }) {
  const update = useConnectionWrite(api.connections.update, slug);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(conn.label);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    const next = label.trim();
    if (!next) return setProblem(CONNECTION_CHANGE_TEXT.giveName);
    if (next === conn.label) return setEditing(false);
    try {
      const result = await update.mutateAsync({
        params: { burrow: slug, connectionId: conn.id },
        body: { label: next },
      });
      if (result.status === 'ok') {
        setEditing(false);
        showNotice(CONNECTION_CHANGE_TEXT.renamed(result.data.connection.label));
      }
    } catch (err) {
      const p = connectProblem(err);
      setProblem(p.fields.label ?? p.message);
    }
  }

  return (
    <Section title={CONNECTION_CHANGE_TEXT.name}>
      <View style={{ padding: 14, gap: 10 }}>
        {editing ? (
          <>
            <FormField
              label={
                CONNECTION_CHANGE_TEXT.name.charAt(0) + CONNECTION_CHANGE_TEXT.name.slice(1).toLowerCase()
              }
              value={label}
              onChangeText={(v) => {
                setLabel(v);
                setProblem(null);
              }}
              error={problem}
              maxLength={80}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => void save()}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label={CONNECTION_CHANGE_TEXT.save}
                busy={update.isPending}
                onPress={() => void save()}
                style={{ flex: 1 }}
              />
              <Button
                label={CONNECTION_CHANGE_TEXT.cancel}
                variant="quiet"
                onPress={() => setEditing(false)}
                style={{ flex: 1 }}
              />
            </View>
          </>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text size={15} weight={600} style={{ flex: 1 }}>
              {conn.label}
            </Text>
            <Button
              label={CONNECTION_CHANGE_TEXT.rename}
              variant="secondary"
              onPress={() => {
                setLabel(conn.label);
                setProblem(null);
                setEditing(true);
              }}
            />
          </View>
        )}
      </View>
    </Section>
  );
}

/** WHAT {AGENT} MAY DO (CS-10, CS-11; AP-845; the agent by its name, AP-4904): the level and what it means, Change for those who may change it. */
export function LevelBlock({
  slug,
  entry,
  conn,
  onSignInAgain,
}: {
  slug: string;
  entry: CatalogEntry;
  conn: ConnectionView;
  onSignInAgain: () => void;
}) {
  const assistant = useAgentWords();
  const words: ConnectionWords = connectionWords(assistant.name);
  const update = useConnectionWrite(api.connections.update, slug);
  const [editing, setEditing] = useState(false);
  const [level, setLevel] = useState<ConnectionAccessLevel>(conn.access);
  const [raised, setRaised] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choices = accessChoices(entry).map((x) => ({ ...x, text: words.access(x.text) }));
  const current = choices.find((x) => x.value === conn.access);
  const note = raisedNote(entry, raised, conn.access);

  async function save() {
    if (level === conn.access) return setEditing(false);
    setProblem(null);
    try {
      const result = await update.mutateAsync({
        params: { burrow: slug, connectionId: conn.id },
        body: { access: level },
      });
      if (result.status === 'ok') {
        setEditing(false);
        setRaised(level === 'manage');
        showNotice(CONNECTION_CHANGE_TEXT.levelSaved(conn.label, level));
      }
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  if (!usedByAgents(entry)) return null;
  return (
    <Section title={words.mayDo}>
      <View style={{ padding: 14, gap: 10 }}>
        {editing ? (
          <>
            <RadioCards
              label={words.mayDoQuestion}
              value={level}
              onChange={setLevel}
              disabled={update.isPending}
              options={choices.map((a) => ({ value: a.value, title: a.label, line: a.text }))}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label={CONNECTION_CHANGE_TEXT.save}
                busy={update.isPending}
                onPress={() => void save()}
                style={{ flex: 1 }}
              />
              <Button
                label={CONNECTION_CHANGE_TEXT.cancel}
                variant="quiet"
                onPress={() => setEditing(false)}
                style={{ flex: 1 }}
              />
            </View>
          </>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={15} weight={600}>
                {CONNECTION_ACCESS_LABELS[conn.access]}
              </Text>
              {current ? <Note>{current.text}</Note> : null}
            </View>
            <Button
              label={CONNECTION_CHANGE_TEXT.change}
              variant="secondary"
              onPress={() => {
                setLevel(conn.access);
                setProblem(null);
                setEditing(true);
              }}
            />
          </View>
        )}
        {note ? (
          <View style={{ gap: 8 }}>
            <Note>{note}</Note>
            <Button label={CONNECTION_CHANGE_TEXT.signInAgain} variant="secondary" onPress={onSignInAgain} />
          </View>
        ) : null}
        <FormMessage text={problem} />
      </View>
    </Section>
  );
}

/**
 * The connection's choices that can change later (findmy-connection.md §2.1): a select's own options (Find My's Read in
 * the background) and the Mac of an entry checked through a Mac, among the servers that are Macs; each a section with
 * Change, radio cards and Save, as WHAT {AGENT} MAY DO. The server checks the new value as it checks a new connection.
 */
export function ChoiceBlocks({
  slug,
  entry,
  conn,
}: {
  slug: string;
  entry: CatalogEntry;
  conn: ConnectionView;
}) {
  const macs = useMacChoices(slug, entry.check?.kind === 'mac');
  const settings = choiceSettings(entry, conn.fields, macs);
  return (
    <>
      {settings.map((setting) => (
        <ChoiceBlock key={`${setting.field}-${setting.value}`} slug={slug} conn={conn} setting={setting} />
      ))}
    </>
  );
}

function ChoiceBlock({
  slug,
  conn,
  setting,
}: {
  slug: string;
  conn: ConnectionView;
  setting: ChoiceSetting;
}) {
  const update = useConnectionWrite(api.connections.update, slug);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(setting.value);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    if (value === setting.value) return setEditing(false);
    setProblem(null);
    try {
      const result = await update.mutateAsync({
        params: { burrow: slug, connectionId: conn.id },
        body: { fields: { [setting.field]: value } },
      });
      if (result.status === 'ok') {
        setEditing(false);
        showNotice(choiceSavedText(setting, value));
      }
    } catch (err) {
      const p = connectProblem(err);
      setProblem(p.fields[setting.field] ?? p.message);
    }
  }

  return (
    <Section title={setting.label}>
      <View style={{ padding: 14, gap: 10 }}>
        {editing ? (
          <>
            <RadioCards
              label={setting.label}
              value={value}
              onChange={setValue}
              disabled={update.isPending}
              options={setting.options.map((o) => ({ value: o.value, title: o.label }))}
            />
            {setting.help ? <Note>{setting.help}</Note> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button
                label={CONNECTION_CHANGE_TEXT.save}
                busy={update.isPending}
                onPress={() => void save()}
                style={{ flex: 1 }}
              />
              <Button
                label={CONNECTION_CHANGE_TEXT.cancel}
                variant="quiet"
                onPress={() => setEditing(false)}
                style={{ flex: 1 }}
              />
            </View>
          </>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text size={15} weight={600} style={{ flex: 1 }}>
              {setting.valueLabel}
            </Text>
            <Button
              label={CONNECTION_CHANGE_TEXT.change}
              variant="secondary"
              accessibilityLabel={`${CONNECTION_CHANGE_TEXT.change} ${setting.label}`}
              onPress={() => {
                setValue(setting.value);
                setProblem(null);
                setEditing(true);
              }}
            />
          </View>
        )}
        <FormMessage text={problem} />
      </View>
    </Section>
  );
}

/** The last check and Check again (CX-72). */
export function CheckRow({ slug, entry, conn }: { slug: string; entry: CatalogEntry; conn: ConnectionView }) {
  const theme = useTheme();
  const recheck = useConnectionWrite(api.connections.recheck, slug);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text size={13} color={theme.colors.mut} style={{ flex: 1 }}>
          {/* The state line above says when it was checked; this says only that it is checking now. */}
          {recheck.isPending ? CONNECTION_CHANGE_TEXT.checking(entry.name) : ''}
        </Text>
        <Button
          label={CONNECTION_CHANGE_TEXT.checkAgain}
          variant="secondary"
          disabled={recheck.isPending}
          onPress={async () => {
            setProblem(null);
            try {
              await recheck.mutateAsync({ params: { burrow: slug, connectionId: conn.id } });
            } catch (err) {
              setProblem(connectProblem(err).message);
            }
          }}
        />
      </View>
      <FormMessage text={problem} />
    </View>
  );
}

/**
 * SIGN-IN (CX-72): the sign-in and what Whombat keeps; Replace token (a session sign-in's password, an OAuth client's
 * secret) checked before it replaces the old one, Sign in again with a new code where a code made the token (T3 Code's
 * pairing code), Reconnect for a sign-in elsewhere (OAuth in the browser over the session, Nextcloud's login) on the
 * same connection, Remove. No Reconnect that would make a second connection (AP-2920).
 */
export function SignInBlock({
  slug,
  entry,
  conn,
  onRemoved,
  againAsked = 0,
  onAgainShown,
}: {
  slug: string;
  entry: CatalogEntry;
  conn: ConnectionView;
  onRemoved: () => void;
  /** Sign in again asked from the level's note (a count): the code's form opens. */
  againAsked?: number;
  /** The form asked that way is laid out: the screen brings it into sight. */
  onAgainShown?: () => void;
}) {
  const agent = useAgentWords();
  const managed = useManaged();
  const webUrl = useWebUrl();
  const setSecret = useConnectionWrite(api.connections.setSecret, slug);
  const startOAuth = useConnectionWrite(api.connections.startOAuth, slug);
  const startNextcloud = useConnectionWrite(api.connections.startNextcloud, slug);
  const startService = useConnectionWrite(api.connections.startServiceLogin, slug);
  const disconnect = useConnectionWrite(api.connections.disconnect, slug);
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecretValue] = useState('');
  /** A session's two-step code (SG-09): asked by the service (its words), typed, refused. */
  const [codeAsked, setCodeAsked] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [login, setLogin] = useState<PendingLogin | null>(null);
  // Removing the Vault's sync (1Password) asks in place what becomes of the entries it kept in step.
  const [confirming, setConfirming] = useState(false);
  const [vaultEntries, setVaultEntries] = useState<OnePasswordDisconnectChoice>('keep');
  const view = signInView(entry, conn, true, agent.Name);
  const method = catalogSignIn(entry, conn.signIn);
  // Made with a code (T3 Code's pairing code): a refusal is in that sign-in's words.
  const withCode = view.action?.kind === 'code';
  const tried = (withCode ? codeSignInOf(entry) : method) ?? undefined;
  const showPending = useRef(false);
  const busy =
    setSecret.isPending ||
    startOAuth.isPending ||
    startNextcloud.isPending ||
    startService.isPending ||
    disconnect.isPending;
  const needs = conn.status !== 'active';
  const stacked = stacksActions(view);
  const half = stacked ? undefined : { flex: 1 };
  // The demo world opens no sign-in page by itself (AP-3953).
  const opens = opensItself(elsewhereWay(!!managed, webUrl('/')));

  // Nextcloud's login or the service's own page again: asked until it hands over (CX-11, SG-02); the connection's
  // screen reads it again.
  useLoginWait(slug, login, {
    onConnected: (c) => {
      setLogin(null);
      showNotice(CONNECT_FORM_TEXT.connected(c.label));
    },
    onFailed: (message) => {
      setLogin(null);
      setProblem(message);
    },
  });

  useEffect(() => {
    if (!againAsked || !withCode) return;
    showPending.current = true;
    setReplacing(true);
  }, [againAsked, withCode]);

  function stopReplacing() {
    setReplacing(false);
    setSecretValue('');
    setCodeAsked(null);
    setCode('');
    setCodeError(null);
    setProblem(null);
  }

  async function replace() {
    const refused = replaceProblem(view, secret);
    if (refused) return setProblem(refused);
    const codeRefused = codeProblem(code, codeAsked !== null);
    if (codeRefused) return setCodeError(codeRefused);
    setProblem(null);
    setCodeError(null);
    try {
      const result = await setSecret.mutateAsync({
        params: { burrow: slug, connectionId: conn.id },
        // A code is sent as typed but for spaces around it; the server signs in with it again.
        body: setSecretBody(method, withCode ? secret.trim() : secret, code),
      });
      if (result.status === 'ok') {
        stopReplacing();
        showNotice(replacedText(entry, conn, view));
      }
    } catch (err) {
      // A session's password keeps the server's words for a refusal (AP-3805).
      const p = connectProblem(err, undefined, tried);
      // The service asks for its two-step code (Synology, SG-09): the password stays typed, the code goes with it next.
      if (p.secondFactor) return setCodeAsked(p.secondFactor);
      if (p.fields.code) return setCodeError(p.fields.code);
      setProblem(p.fields.secret ?? p.fields.password ?? p.message);
    } finally {
      // The secret went with the request: the mutation forgets its input too.
      setSecret.reset();
    }
  }

  /** Sign in again on the service's own page (Plex's, SG-02): the same connection, its level as it is. */
  async function signInAgain() {
    setProblem(null);
    try {
      const result = await startService.mutateAsync({
        params: { burrow: slug },
        body: reconnectServiceLoginBody(conn),
      });
      if (result.status !== 'ok') return;
      setLogin({ kind: 'service', flow: result.data, name: entry.name });
      if (opens) openOutside(result.data.loginUrl);
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  async function reconnect() {
    setProblem(null);
    const way = reconnectWay(conn.signIn);
    if (!way) return;
    try {
      if (way === 'nextcloud') {
        const result = await startNextcloud.mutateAsync({
          params: { burrow: slug },
          body: { fields: conn.fields, connectionId: conn.id },
        });
        if (result.status !== 'ok') return;
        setLogin({ kind: 'nextcloud', flow: result.data });
        if (opens) openOutside(result.data.loginUrl);
        return;
      }
      if (conn.signIn !== 'ha_oauth' && conn.signIn !== 'mcp_oauth' && conn.signIn !== 'app_oauth') return;
      if (!managed) return openOutside(webUrl(connectionsWebPath(slug, entry.id, conn.id)));
      holdPhoneConnect({ device: managed.applianceId, flow: 'connection' });
      const result = await startOAuth.mutateAsync({
        params: { burrow: slug },
        body: {
          catalogId: entry.id,
          method: conn.signIn,
          fields: conn.fields,
          connectionId: conn.id,
          returnTo: `${connectReturnTo(entry.id, slug)}&id=${conn.id}`,
        },
      });
      if (result.status === 'ok') openOutside(result.data.authorizeUrl);
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  /** Removes it; the Vault's sync carries the person's choice for its entries (`vaultEntries`). */
  function disconnectNow() {
    setProblem(null);
    const query = disconnectQuery(entry, vaultEntries);
    void disconnect
      .mutateAsync({ params: { burrow: slug, connectionId: conn.id }, ...(query ? { query } : {}) })
      .then(
        (result) => {
          if (result.status !== 'ok') return;
          // A Fusebox that didn't answer keeps Whombat's client: the server says so.
          const notice = (result.data as { notice?: string | null }).notice?.trim();
          showNotice(notice || CONNECTION_CHANGE_TEXT.removed(conn.label));
          onRemoved();
        },
        (err) => setProblem(connectProblem(err).message),
      );
  }

  function remove() {
    if (usedByVaultSync(entry)) {
      setVaultEntries('keep');
      setConfirming(true);
      return;
    }
    Alert.alert(CONNECTION_CHANGE_TEXT.removeNamed(conn.label), removeAsk(entry, conn, agent.Name), [
      { text: CONNECTION_CHANGE_TEXT.cancel, style: 'cancel' },
      { text: CONNECTION_CHANGE_TEXT.removeNamed(conn.label), style: 'destructive', onPress: disconnectNow },
    ]);
  }

  return (
    <Section title={CONNECTION_CHANGE_TEXT.signIn}>
      <View style={{ padding: 14, gap: 12 }}>
        {login ? (
          <LoginWaitView login={login} onCancel={() => setLogin(null)} />
        ) : (
          <>
            <View style={{ gap: 2 }}>
              <Text size={15} weight={600}>
                {view.title}
              </Text>
              {view.line ? <Note>{view.line}</Note> : null}
            </View>
            {replacing && view.action?.kind === 'code' ? (
              <View
                style={{ gap: 10 }}
                onLayout={() => {
                  if (!showPending.current) return;
                  showPending.current = false;
                  onAgainShown?.();
                }}
              >
                <GuideSteps
                  label={CONNECT_FORM_TEXT.making(view.action.secretLabel)}
                  steps={guidedSteps(entry, view.action, conn.fields)}
                />
                <FormField
                  label={view.action.secretLabel}
                  value={secret}
                  onChangeText={(v) => {
                    setSecretValue(v);
                    setProblem(null);
                  }}
                  placeholder={view.action.placeholder}
                  hint={view.action.help}
                  secret
                  autoFocus
                  maxLength={1024}
                  returnKeyType="go"
                  onSubmitEditing={() => void replace()}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button
                    label={SIGN_IN_AGAIN_TEXT.submit}
                    busy={setSecret.isPending}
                    onPress={() => void replace()}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={CONNECTION_CHANGE_TEXT.cancel}
                    variant="quiet"
                    onPress={stopReplacing}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            ) : replacing && view.action?.kind === 'replace' ? (
              <View style={{ gap: 10 }}>
                <FormField
                  label={view.action.secretLabel}
                  value={secret}
                  onChangeText={(v) => {
                    setSecretValue(v);
                    setProblem(null);
                  }}
                  hint={view.action.help}
                  secret
                  autoFocus={codeAsked === null}
                  maxLength={8192}
                />
                {codeAsked !== null ? (
                  // The code the service asked for, under the password it goes with (CS-03's field, SG-09).
                  <FormField
                    label={CONNECT_FORM_TEXT.code}
                    value={code}
                    onChangeText={(v) => {
                      setCode(v);
                      setCodeError(null);
                    }}
                    placeholder={CONNECT_FORM_TEXT.codePlaceholder}
                    hint={codeAsked}
                    error={codeError}
                    autoFocus
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    maxLength={12}
                    returnKeyType="go"
                    onSubmitEditing={() => void replace()}
                  />
                ) : null}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button
                    label={CONNECTION_CHANGE_TEXT.save}
                    busy={setSecret.isPending}
                    onPress={() => void replace()}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={CONNECTION_CHANGE_TEXT.cancel}
                    variant="quiet"
                    onPress={stopReplacing}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            ) : confirming ? (
              // Keep the entries in your Vault (the default) or Remove them too; 1Password itself never changes.
              <View style={{ gap: 10 }}>
                <Note>{removeAsk(entry, conn, agent.Name)}</Note>
                <RadioCards
                  label={ONEPASSWORD_APP_TEXT.removeChoice}
                  value={vaultEntries}
                  onChange={setVaultEntries}
                  disabled={disconnect.isPending}
                  options={ONEPASSWORD_DISCONNECT_OPTIONS.map((o) => ({ value: o.value, title: o.label }))}
                />
                <Button
                  label={CONNECTION_CHANGE_TEXT.removeNamed(conn.label)}
                  variant="secondary"
                  busy={disconnect.isPending}
                  onPress={disconnectNow}
                />
                <Button
                  label={CONNECTION_CHANGE_TEXT.cancel}
                  variant="quiet"
                  disabled={disconnect.isPending}
                  onPress={() => setConfirming(false)}
                />
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {view.again ? (
                  <Button
                    label={view.again.label}
                    variant={needs ? 'primary' : 'secondary'}
                    disabled={busy}
                    accessibilityHint="Opens in your browser"
                    onPress={() => void signInAgain()}
                  />
                ) : null}
                {/* Side by side while both fit; stacked when Replace's words are long (Synology's password, AP-3964). */}
                <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8 }}>
                  {view.action?.kind === 'replace' ? (
                    <Button
                      label={view.action.label}
                      variant={needs && !view.again ? 'primary' : 'secondary'}
                      onPress={() => setReplacing(true)}
                      style={half}
                    />
                  ) : view.action?.kind === 'code' ? (
                    <Button
                      label={view.action.label}
                      variant={view.action.needs ? 'primary' : 'secondary'}
                      disabled={busy}
                      onPress={() => setReplacing(true)}
                      style={half}
                    />
                  ) : view.action?.kind === 'reconnect' ? (
                    <Button
                      label={view.action.label}
                      variant={needs || view.action.primary ? 'primary' : 'secondary'}
                      disabled={busy}
                      onPress={() => void reconnect()}
                      style={half}
                    />
                  ) : null}
                  <Button
                    label={CONNECTION_CHANGE_TEXT.remove}
                    variant="secondary"
                    disabled={busy}
                    onPress={remove}
                    style={half}
                  />
                </View>
              </View>
            )}
            <FormMessage text={problem} />
            {entry.docsUrl && !replacing ? (
              <TextLink
                label={CONNECTION_CHANGE_TEXT.documentation(entry.name)}
                external
                onPress={() => openOutside(entry.docsUrl)}
              />
            ) : null}
          </>
        )}
      </View>
    </Section>
  );
}
