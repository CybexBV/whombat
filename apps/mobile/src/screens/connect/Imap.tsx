/**
 * Email (IMAP) on the phone (phone-connect.md PC-06, AP-2908; Whombat connections-more.md CM-19…CM-22): the web's
 * YOUR ACCOUNT card with the shared words and rules (`@whombat/client` `imap.ts`). Not connected: the address and its
 * password (masked, no autofill); Whombat finds the servers once the address rests and says them in one line with
 * Change, which opens the server fields (open from the start when nothing was found), and a known provider's hint.
 * Connected: the account, its servers and state, Change password, Disconnect (asked first), the checks and Check again.
 */
import {
  draftFromSettings,
  hintLinks,
  IMAP_COPY,
  IMAP_DISCONNECTED_TEXT,
  type ImapConnectProblem,
  imapConnectedText,
  imapConnectProblem,
  looksLikeEmail,
  MAIL_SECURITY_LABELS,
  type MailDraftField,
  type MailServersDraft,
  mailAccountLine,
  mailCheckName,
  settingsFromDraft,
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
  type ImapProviderHint,
  imapGuessSettings,
  imapServersLine,
  type MailSecurity,
} from '@whombat/core/domain';
import { formatAgo } from '@whombat/core/text';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useViewContext } from '../../data/BurrowProvider';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { FormField, FormMessage } from '../../ui/formField';
import { Button, StatusDot, toneColor } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { showFailure, showNotice } from '../feedback';
import { Busy, Footer, Note, openOutside, Panel, PLAIN_INPUT, TextLink } from './parts';

/** How long the address rests before Whombat looks for its servers (leaving the field looks at once). */
const DISCOVER_AFTER_MS = 700;

const NO_PROBLEM: ImapConnectProblem = { message: null, fields: {}, openServers: false };

/** What the servers line knows: nothing yet, or the answer for an address. */
type Found = { email: string; answer: ImapDiscoverResponse | null } | null;

export function ImapConnectForm({
  header,
  bottomInset,
  onOpenProvider,
}: {
  /** The screen's head and anything above the form. */
  header: ReactNode;
  bottomInset: number;
  /** A provider's hint names Google or Microsoft 365 instead: their screen. */
  onOpenProvider: (provider: 'google' | 'microsoft') => void;
}) {
  const theme = useTheme();
  const discover = useImapDiscover();
  const connect = useImapConnect();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [found, setFound] = useState<Found>(null);
  const [draft, setDraft] = useState<MailServersDraft | null>(null);
  const [problem, setProblem] = useState<ImapConnectProblem>(NO_PROBLEM);
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
    if (answer?.settings && answer.source !== 'guess') setDraft(null);
    else {
      const settings = answer?.settings ?? imapGuessSettings(value);
      setDraft(settings ? draftFromSettings(settings) : null);
    }
  }

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

  function openServers() {
    setDraft((open) => {
      if (open) return open;
      const from = settings ?? imapGuessSettings(email);
      return from ? draftFromSettings(from) : null;
    });
  }

  async function submit() {
    if (connect.isPending) return;
    const fields: ImapConnectProblem['fields'] = {};
    if (!looksLikeEmail(email)) fields.email = IMAP_COPY.emailMissing;
    if (!password) fields.password = IMAP_COPY.passwordMissing;
    const servers = draft ? settingsFromDraft(draft) : null;
    if (servers?.errors) Object.assign(fields, servers.errors);
    if (Object.keys(fields).length) return setProblem({ message: null, fields, openServers: false });
    setProblem(NO_PROBLEM);
    const chosen = servers?.settings ?? settings ?? undefined;
    try {
      const result = await connect.mutateAsync({
        body: { email: email.trim(), password, ...(chosen ? { settings: chosen } : {}) },
      });
      if (result.status === 'ok') {
        setPassword('');
        showNotice(imapConnectedText(result.data.email));
      }
    } catch (error) {
      const next = imapConnectProblem(error);
      setProblem(next);
      if (next.openServers) openServers();
    } finally {
      // The password went with the request: the mutation forgets its input too.
      connect.reset();
    }
  }

  const clear = (key: 'email' | 'password') => {
    if (problem.fields[key]) setProblem({ ...problem, fields: { ...problem.fields, [key]: undefined } });
  };

  return (
    <Panel
      footer={
        <Footer bottomInset={bottomInset}>
          <FormMessage text={problem.message} />
          {connect.isPending ? <Busy text={IMAP_COPY.connecting} /> : null}
          <Button
            label={IMAP_COPY.connect}
            size="lg"
            busy={connect.isPending}
            onPress={() => void submit()}
          />
        </Footer>
      }
    >
      {header}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ paddingTop: 6 }}>
          <StatusDot color={theme.colors.mut} label={ACCOUNT_NOT_CONNECTED} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={15} weight={600}>
            {IMAP_COPY.name}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {IMAP_COPY.notConnected}
          </Text>
        </View>
      </View>
      <FormField
        label={sentenceCase(IMAP_COPY.email)}
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          clear('email');
        }}
        onBlur={() => void look(email)}
        placeholder="you@example.com"
        error={problem.fields.email}
        keyboardType="email-address"
        {...PLAIN_INPUT}
      />
      <FormField
        label={sentenceCase(IMAP_COPY.password)}
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          clear('password');
        }}
        hint={IMAP_COPY.passwordHint}
        error={problem.fields.password}
        secret
        maxLength={1024}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      {looking && !current ? <Busy text={IMAP_COPY.looking} /> : null}
      {showFound && settings ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ paddingTop: 6 }}>
            <StatusDot color={theme.colors.ok} label={IMAP_COPY.found} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={15} weight={600}>
              {IMAP_COPY.found}
            </Text>
            <Text size={13} lh={1.4} mono color={theme.colors.mut}>
              {imapServersLine({ imapHost: settings.imap.host, smtpHost: settings.smtp.host })}
            </Text>
          </View>
          <TextLink label={IMAP_COPY.change} onPress={openServers} />
        </View>
      ) : null}
      {draft ? (
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
      ) : null}
      {current?.answer?.hint ? (
        <ProviderHint hint={current.answer.hint} onOpenProvider={onOpenProvider} />
      ) : null}
    </Panel>
  );
}

const ACCOUNT_NOT_CONNECTED = 'Not connected';

/** “EMAIL ADDRESS” → “Email address”: the phone's labels are in sentence case (Add a server's). */
function sentenceCase(label: string): string {
  return (
    label.charAt(0) + label.slice(1).toLowerCase().replace('(imap)', '(IMAP)').replace('(smtp)', '(SMTP)')
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
  const theme = useTheme();
  const side = (key: 'imap' | 'smtp', legend: string) => {
    const host: MailDraftField = key === 'imap' ? 'imapHost' : 'smtpHost';
    const port: MailDraftField = key === 'imap' ? 'imapPort' : 'smtpPort';
    const security: MailSecurity = key === 'imap' ? draft.imapSecurity : draft.smtpSecurity;
    return (
      <View style={{ gap: 10 }}>
        <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut} accessibilityRole="header">
          {legend}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <View style={{ flex: 2.4, minWidth: 0 }}>
            <FormField
              label={IMAP_COPY.server}
              value={draft[host]}
              onChangeText={(v) => onChange({ ...draft, [host]: v })}
              error={problems[host]}
              mono
              keyboardType="url"
              {...PLAIN_INPUT}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <FormField
              label={IMAP_COPY.port}
              value={draft[port]}
              onChangeText={(v) => onChange({ ...draft, [port]: v })}
              error={problems[port]}
              mono
              keyboardType="number-pad"
              {...PLAIN_INPUT}
            />
          </View>
        </View>
        <Segmented<MailSecurity>
          label={`${legend}: ${IMAP_COPY.security}`}
          value={security}
          onChange={(value) => onChange(withSecurity(draft, key, value))}
          options={SECURITY_OPTIONS}
        />
      </View>
    );
  };
  return (
    <View style={{ gap: 16 }}>
      {guessed ? <Note>{IMAP_COPY.guessed}</Note> : null}
      {side('imap', IMAP_COPY.incoming)}
      {side('smtp', IMAP_COPY.outgoing)}
      <FormField
        label={sentenceCase(IMAP_COPY.username)}
        value={draft.username}
        onChangeText={(v) => onChange({ ...draft, username: v })}
        placeholder={email.trim() || 'you@example.com'}
        hint={IMAP_COPY.usernameHint}
        error={problems.username}
        {...PLAIN_INPUT}
      />
    </View>
  );
}

/**
 * A known provider's hint (CM-21): an app password and where it's made, the connection to use instead, or both — Gmail's
 * Google connection and, for mail only, its app password page (SG-18d, the shared `hintLinks`; AP-3963).
 */
function ProviderHint({
  hint,
  onOpenProvider,
}: {
  hint: ImapProviderHint;
  onOpenProvider: (provider: 'google' | 'microsoft') => void;
}) {
  const { instead, page } = hintLinks(hint);
  return (
    <View style={{ gap: 2 }} accessibilityLiveRegion="polite">
      <Note>{hint.text}</Note>
      {instead ? (
        <TextLink
          label={instead.text}
          onPress={() => onOpenProvider(instead.connection === 'microsoft' ? 'microsoft' : 'google')}
        />
      ) : null}
      {page ? <TextLink label={page.text} external onPress={() => openOutside(page.url)} /> : null}
    </View>
  );
}

/* Connected ------------------------------------------------------------------------------------------- */

export function MailAccount({
  connection,
  header,
  bottomInset,
}: {
  connection: Connection;
  header: ReactNode;
  bottomInset: number;
}) {
  const theme = useTheme();
  const { now, timeZone } = useViewContext();
  const connect = useImapConnect();
  const check = useCheckConnection();
  const remove = useRemoveConnection();
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<ImapConnectProblem | null>(null);
  const active = connection.status === 'active';

  async function onPassword() {
    if (connect.isPending) return;
    if (!password) return setProblem({ ...NO_PROBLEM, fields: { password: IMAP_COPY.passwordMissing } });
    setProblem(null);
    try {
      // The servers stay as they are: only the password is new.
      const result = await connect.mutateAsync({ body: { email: connection.email, password } });
      if (result.status === 'ok') {
        setPassword('');
        setChanging(false);
        showNotice(imapConnectedText(result.data.email));
      }
    } catch (error) {
      setProblem(imapConnectProblem(error));
    } finally {
      connect.reset();
    }
  }

  function onDisconnect() {
    Alert.alert(IMAP_COPY.disconnectConfirm, IMAP_COPY.disconnectAsk, [
      { text: IMAP_COPY.cancel, style: 'cancel' },
      {
        text: IMAP_COPY.disconnectConfirm,
        style: 'destructive',
        onPress: () =>
          void remove.mutateAsync({ params: { connectionId: connection.id } }).then(
            (result) => {
              if (result.status === 'ok') showNotice(IMAP_DISCONNECTED_TEXT);
            },
            () => showFailure(IMAP_COPY.failed),
          ),
      },
    ]);
  }

  return (
    <Panel
      footer={
        changing ? (
          <Footer bottomInset={bottomInset}>
            <FormMessage text={problem?.message} />
            {connect.isPending ? <Busy text={IMAP_COPY.connecting} /> : null}
            <Button
              label={IMAP_COPY.connectAgain}
              size="lg"
              busy={connect.isPending}
              onPress={() => void onPassword()}
            />
          </Footer>
        ) : null
      }
    >
      {header}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ paddingTop: 6 }}>
          <StatusDot
            color={active ? theme.colors.ok : theme.colors.warn}
            label={active ? IMAP_COPY.connected : IMAP_COPY.needsPassword}
          />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={15} weight={600}>
            {connection.email}
          </Text>
          <Text size={13} lh={1.4} color={active ? theme.colors.mut : theme.colors.warn}>
            {mailAccountLine(connection)}
          </Text>
        </View>
      </View>
      {active && connection.checks.length > 0 ? (
        <View style={{ gap: 6 }}>
          {connection.checks.map((item) => (
            <View
              key={`${item.service}-${item.side ?? ''}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <StatusDot
                color={toneColor(theme, item.state === 'ok' ? 'ok' : item.state === 'error' ? 'bad' : 'warn')}
                label={mailCheckName(item)}
                size={7}
              />
              <Text size={13.5} weight={500}>
                {mailCheckName(item)}
              </Text>
              <Text size={13} color={theme.colors.mut} style={{ flex: 1 }}>
                {item.state === 'ok' ? 'Working' : (item.message ?? 'Couldn’t check')}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {changing ? (
        <View style={{ gap: 10 }}>
          <FormField
            label={sentenceCase(IMAP_COPY.password)}
            value={password}
            onChangeText={setPassword}
            hint={IMAP_COPY.passwordHint}
            error={problem?.fields.password}
            secret
            autoFocus
            maxLength={1024}
            returnKeyType="go"
            onSubmitEditing={() => void onPassword()}
          />
          <Button
            label={IMAP_COPY.cancel}
            variant="quiet"
            onPress={() => {
              setChanging(false);
              setPassword('');
              setProblem(null);
            }}
          />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={active ? IMAP_COPY.changePassword : IMAP_COPY.newPassword}
            variant={active ? 'secondary' : 'primary'}
            onPress={() => setChanging(true)}
            style={{ flex: 1 }}
          />
          <Button label={IMAP_COPY.disconnect} variant="secondary" onPress={onDisconnect} />
        </View>
      )}
      {active ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text size={13} color={theme.colors.mut} style={{ flex: 1 }}>
            {check.isPending
              ? IMAP_COPY.checking
              : connection.checkedAt
                ? `Checked ${formatAgo(connection.checkedAt, now, timeZone)}`
                : IMAP_COPY.notChecked}
          </Text>
          <Button
            label={IMAP_COPY.checkAgain}
            variant="secondary"
            disabled={check.isPending}
            onPress={() => check.mutate({ params: { connectionId: connection.id } })}
          />
        </View>
      ) : null}
      {problem?.message && !changing ? <FormMessage text={problem.message} /> : null}
    </Panel>
  );
}
