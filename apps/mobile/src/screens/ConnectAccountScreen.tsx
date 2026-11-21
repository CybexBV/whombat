/**
 * A builtin connection's screen on the phone (phone-connect.md PC-02, PC-05, PC-06; AP-2908…AP-2910): where Add a
 * connection's Accounts rows, the account rows of Connections and every link to `?tab=connections&connection=google`
 * (`microsoft`, `imap`, `github`, `feedback`) land, instead of the web page the managed app caught itself.
 * - **Google and Microsoft 365**: YOUR ACCOUNT — not connected, the services to tick and Connect {Name}; connected, the
 *   account and its services (or why it needs connecting again), Reconnect (the services stay; more can be ticked),
 *   Disconnect (asked first), each service's check and Check again. Signing in happens in the browser: on a managed
 *   Whombat started over the session and back through the `/connect/` App Link, on a self-hosted one on its web page.
 *   Setting up a provider's app stays on the web (once).
 * - **Email (IMAP)**: its form and account (`connect/Imap.tsx`).
 * - **GitHub and Website feedback**: what is connected, and that they are set up in Whombat on a computer.
 * The web's words (`ACCOUNT_TEXT`, `REAUTH_TEXT`, `IMAP_COPY`).
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { imapAvailable, imapConnection, problemText, withBurrow } from '@whombat/client';
import { ACCOUNT_TEXT, CONNECT_FORM_TEXT } from '@whombat/client/connections';
import {
  useCheckConnection,
  useConnectors,
  useFeedbackIntegrations,
  useGitHubStatus,
  useRemoveConnection,
  useRepos,
  useStartGoogleConnection,
  useStartMicrosoftConnection,
} from '@whombat/client/react';
import { type ConnectorService, serviceLabel } from '@whombat/core';
import { formatAgo } from '@whombat/core/text';
import { type ReactNode, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  type AccountProvider,
  accountErrorText,
  accountHead,
  accountLine,
  BUILTIN_TEXT,
  checkLine,
  disconnectAsk,
  isAccountProvider,
  providerConnectable,
  providerConnection,
  providerServices,
  reconnectServices,
} from '../data/accountConnect';
import { useBurrow, useViewContext } from '../data/BurrowProvider';
import { CONNECT_SCREEN_TEXT } from '../data/connectForm';
import { connectionLogo, connectionsWebPath } from '../data/connections';
import { useWebUrl } from '../data/useWebUrl';
import { holdPhoneConnect } from '../managed/connectReturn';
import { useManaged } from '../managed/context';
import { type AccountPage, connectErrorOf, isAccountPage } from '../navigation/connectionLinks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import { FormMessage } from '../ui/formField';
import { BackBar, Screen } from '../ui/headers';
import { Check } from '../ui/icons';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { Button, ErrorState, SkeletonRows, StatusDot, toneColor } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { AccountKeys } from './connect/AccountKeys';
import { ImapConnectForm, MailAccount } from './connect/Imap';
import { backUnder, Note, openOutside, Panel, Title } from './connect/parts';
import { showFailure, showNotice } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'ConnectAccount'>;

export function ConnectAccountScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { page } = route.params;
  const [back] = useState(() => route.params.back ?? backUnder(navigation.getState(), route.key));
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Connections'));
  // A sign-in's refusal (`connect_error=`), said once.
  const [error, setError] = useState(() => connectErrorOf(route.params.error));
  useEffect(() => {
    const code = connectErrorOf(route.params.error);
    if (code) {
      setError(code);
      navigation.setParams({ error: undefined });
    }
  }, [route.params.error, navigation]);

  if (!isAccountPage(page))
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        <ErrorState text={CONNECT_SCREEN_TEXT.unknown} />
      </Screen>
    );
  const header = <Head page={page} />;
  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <KeyboardAvoidingView style={{ flex: 1 }}>
        {isAccountProvider(page) ? (
          <ProviderAccount provider={page} header={header} error={accountErrorText(page, error)} />
        ) : page === 'imap' ? (
          <ImapPage
            header={header}
            bottomInset={insets.bottom}
            onOpenProvider={(provider) =>
              navigation.push('ConnectAccount', { page: provider, back: accountHead('imap').name })
            }
          />
        ) : page === 'github' ? (
          <GitHubPage header={header} />
        ) : (
          <FeedbackPage header={header} />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Head({ page }: { page: AccountPage }) {
  const theme = useTheme();
  const { name, description } = accountHead(page);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ConnectionLogo logo={connectionLogo(page, name)} />
        <Title>{name}</Title>
      </View>
      {description ? (
        <Text size={14} lh={1.45} color={theme.colors.ink2}>
          {description}
        </Text>
      ) : null}
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut} accessibilityRole="header">
      {children}
    </Text>
  );
}

/* Google and Microsoft 365 -------------------------------------------------------------------------------------- */

function ProviderAccount({
  provider,
  header,
  error,
}: {
  provider: AccountProvider;
  header: ReactNode;
  error: string | null;
}) {
  const theme = useTheme();
  const { slug } = useBurrow();
  const { now, timeZone } = useViewContext();
  const managed = useManaged();
  const webUrl = useWebUrl();
  const status = useConnectors({}, { retry: false });
  const startGoogle = useStartGoogleConnection(openOutside);
  const startMicrosoft = useStartMicrosoftConnection();
  const check = useCheckConnection();
  const remove = useRemoveConnection();
  const name = accountHead(provider).name;
  const connection = providerConnection(status.data, provider);
  const connectable = providerConnectable(status.data, provider);
  const [picking, setPicking] = useState(false);
  const [services, setServices] = useState<ConnectorService[]>(() => [...providerServices(provider)]);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = startGoogle.isPending || startMicrosoft.isPending;

  if (!status.data)
    return (
      <Panel footer={null}>
        {header}
        {status.error ? (
          <ErrorState text="Your connections didn’t load." onRetry={() => void status.refetch()} />
        ) : (
          <SkeletonRows count={2} lines={2} label={CONNECT_SCREEN_TEXT.loading} />
        )}
      </Panel>
    );
  if (provider === 'microsoft' && !status.data.microsoft)
    return (
      <Panel footer={null}>
        {header}
        <Note>{ACCOUNT_TEXT.microsoftUpdate}</Note>
      </Panel>
    );

  /** Starts the sign-in (PC-05): over the session on a managed Whombat, else on the Whombat's web page. */
  async function connect(picked: readonly ConnectorService[]) {
    setProblem(null);
    const returnTo = withBurrow(`/settings?tab=connections&connection=${provider}`, slug);
    if (!managed) {
      const url = webUrl(connectionsWebPath(slug, provider));
      if (url) openOutside(url);
      else setProblem(CONNECT_SCREEN_TEXT.demo);
      return;
    }
    holdPhoneConnect({ device: managed.applianceId });
    try {
      if (provider === 'google') await startGoogle.mutateAsync({ body: { services: [...picked], returnTo } });
      else {
        const result = await startMicrosoft.mutateAsync({ body: { services: [...picked], returnTo } });
        if (result.status === 'ok') openOutside(result.data.authorizeUrl);
      }
    } catch (err) {
      setProblem(problemText(err, ACCOUNT_TEXT.couldNotStart(name)));
    }
  }

  function disconnect() {
    if (!connection) return;
    Alert.alert(ACCOUNT_TEXT.disconnectNamed(name), disconnectAsk(provider), [
      { text: ACCOUNT_TEXT.cancel, style: 'cancel' },
      {
        text: ACCOUNT_TEXT.disconnectNamed(name),
        style: 'destructive',
        onPress: () =>
          void remove.mutateAsync({ params: { connectionId: connection.id } }).then(
            (result) => {
              if (result.status === 'ok') showNotice(ACCOUNT_TEXT.disconnected(name));
            },
            () => showFailure(CONNECT_FORM_TEXT.notThrough),
          ),
      },
    ]);
  }

  const active = connection?.status === 'active';
  const choosing = !connection || picking;
  return (
    <Panel footer={null}>
      {header}
      <FormMessage text={error ?? problem} />
      <SectionTitle>{ACCOUNT_TEXT.yourAccount}</SectionTitle>
      {status.data.mode === 'off' ? (
        <Note>{ACCOUNT_TEXT.off}</Note>
      ) : (
        <View style={{ gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <View style={{ paddingTop: 6 }}>
              <StatusDot
                color={!connection ? theme.colors.mut : active ? theme.colors.ok : theme.colors.warn}
                label={
                  !connection
                    ? ACCOUNT_TEXT.notConnected
                    : active
                      ? ACCOUNT_TEXT.connected
                      : ACCOUNT_TEXT.needsConnecting
                }
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={15} weight={600}>
                {connection ? `${name} · ${connection.email}` : name}
              </Text>
              <Text size={13} lh={1.4} color={connection && !active ? theme.colors.warn : theme.colors.mut}>
                {connection ? accountLine(connection, provider) : ACCOUNT_TEXT.pickServices}
              </Text>
            </View>
          </View>
          {active && connection && connection.checks.length > 0 && !picking ? (
            <View style={{ gap: 6 }}>
              {connection.checks.map((item) => {
                const line = checkLine(item, provider);
                return (
                  <View key={item.service} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <StatusDot color={toneColor(theme, line.tone)} label={line.text} size={7} />
                    <Text size={13.5} weight={500}>
                      {serviceLabel(item.service, provider)}
                    </Text>
                    <Text size={13} color={theme.colors.mut} style={{ flex: 1 }}>
                      {line.text}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
          {choosing ? (
            <View style={{ gap: 12 }}>
              <ServicePicker
                provider={provider}
                value={services}
                onChange={setServices}
                locked={connection?.services ?? []}
                disabled={!connectable || busy}
              />
              {connection ? <Note>{ACCOUNT_TEXT.keepServices}</Note> : null}
              {!connectable ? <Note>{ACCOUNT_TEXT.setUpFirst(name)}</Note> : null}
              {connectable && services.length === 0 ? <Note>{ACCOUNT_TEXT.tickOne}</Note> : null}
              <Button
                label={connection ? ACCOUNT_TEXT.continueTo(name) : ACCOUNT_TEXT.connect(name)}
                busy={busy}
                disabled={!connectable || services.length === 0}
                onPress={() => void connect(services)}
              />
              {connection ? (
                <Button label={ACCOUNT_TEXT.cancel} variant="quiet" onPress={() => setPicking(false)} />
              ) : null}
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {!connectable ? <Note>{ACCOUNT_TEXT.setUpFirst(name)}</Note> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  label={ACCOUNT_TEXT.reconnect}
                  variant={active ? 'secondary' : 'primary'}
                  disabled={!connectable || busy}
                  onPress={() => {
                    setServices(reconnectServices(connection, provider));
                    setPicking(true);
                  }}
                  style={{ flex: 1 }}
                />
                <Button label={ACCOUNT_TEXT.disconnect} variant="secondary" onPress={disconnect} />
              </View>
              {active && connection ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text size={13} color={theme.colors.mut} style={{ flex: 1 }}>
                    {check.isPending
                      ? ACCOUNT_TEXT.checking
                      : connection.checkedAt
                        ? `Checked ${formatAgo(connection.checkedAt, now, timeZone)}`
                        : ACCOUNT_TEXT.notChecked}
                  </Text>
                  <Button
                    label={ACCOUNT_TEXT.checkAgain}
                    variant="secondary"
                    disabled={check.isPending}
                    onPress={() => check.mutate({ params: { connectionId: connection.id } })}
                  />
                </View>
              ) : null}
            </View>
          )}
        </View>
      )}
      {connection && status.data.mode !== 'off' ? (
        <AccountKeys
          account={name}
          services={connection.services}
          title={(text) => <SectionTitle>{text}</SectionTitle>}
        />
      ) : null}
    </Panel>
  );
}

/** The services as checkboxes (all ticked at first, CN-04); connected ones stay ticked and fixed. */
function ServicePicker({
  provider,
  value,
  onChange,
  locked,
  disabled,
}: {
  provider: AccountProvider;
  value: readonly ConnectorService[];
  onChange: (next: ConnectorService[]) => void;
  locked: readonly ConnectorService[];
  disabled: boolean;
}) {
  const theme = useTheme();
  const all = providerServices(provider);
  return (
    <View
      accessibilityLabel="Services to connect"
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {all.map((service, i) => {
        const fixed = locked.includes(service);
        const checked = fixed || value.includes(service);
        const label = serviceLabel(service, provider);
        return (
          <Touchable
            key={service}
            disabled={fixed || disabled}
            onPress={() => onChange(all.filter((s) => (s === service ? !checked : value.includes(s))))}
            feedback="wash"
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled: fixed || disabled }}
            accessibilityLabel={label}
            style={{
              minHeight: 48,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 12,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
              opacity: fixed ? 0.6 : 1,
            }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                borderWidth: checked ? 0 : 1.5,
                borderColor: theme.colors.line2,
                backgroundColor: checked ? theme.colors.btn : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {checked ? <Check size={15} color={theme.colors.btnfg} strokeWidth={2.5} /> : null}
            </View>
            <Text size={15}>{label}</Text>
          </Touchable>
        );
      })}
    </View>
  );
}

/* Email (IMAP) ------------------------------------------------------------------------------------------------- */

function ImapPage({
  header,
  bottomInset,
  onOpenProvider,
}: {
  header: ReactNode;
  bottomInset: number;
  onOpenProvider: (provider: 'google' | 'microsoft') => void;
}) {
  const status = useConnectors({}, { retry: false });
  if (!status.data)
    return (
      <Panel footer={null}>
        {header}
        {status.error ? (
          <ErrorState text="Your connections didn’t load." onRetry={() => void status.refetch()} />
        ) : (
          <SkeletonRows count={2} lines={2} label={CONNECT_SCREEN_TEXT.loading} />
        )}
      </Panel>
    );
  const connection = imapConnection(status.data);
  if (!imapAvailable(status.data) && !connection)
    return (
      <Panel footer={null}>
        {header}
        <Note>{'Update this Whombat to connect other email.'}</Note>
      </Panel>
    );
  if (status.data.mode === 'off')
    return (
      <Panel footer={null}>
        {header}
        <Note>{ACCOUNT_TEXT.off}</Note>
      </Panel>
    );
  return connection ? (
    <MailAccount connection={connection} header={header} bottomInset={bottomInset} />
  ) : (
    <ImapConnectForm header={header} bottomInset={bottomInset} onOpenProvider={onOpenProvider} />
  );
}

/* GitHub and Website feedback ------------------------------------------------------------------------------------ */

function GitHubPage({ header }: { header: ReactNode }) {
  const theme = useTheme();
  const { slug } = useBurrow();
  const github = useGitHubStatus({ params: { burrow: slug } }, { retry: false });
  const repos = useRepos({ params: { burrow: slug } }, { retry: false });
  const gh = github.data;
  const connected = gh?.connected ?? repos.data?.githubConnected ?? false;
  const count = repos.data?.repos.length ?? 0;
  return (
    <Panel footer={null}>
      {header}
      {!gh && !github.error ? (
        <SkeletonRows count={1} lines={2} label={CONNECT_SCREEN_TEXT.loading} />
      ) : gh?.mode === 'off' ? (
        <Note>{BUILTIN_TEXT.github.off}</Note>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ paddingTop: 6 }}>
            <StatusDot
              color={connected ? (gh?.error ? theme.colors.warn : theme.colors.ok) : theme.colors.mut}
              label={connected ? ACCOUNT_TEXT.connected : ACCOUNT_TEXT.notConnected}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={15} weight={600}>
              {connected ? ACCOUNT_TEXT.connected : BUILTIN_TEXT.github.notConnected}
            </Text>
            {connected ? (
              <Text size={13} lh={1.4} mono color={theme.colors.mut}>
                {BUILTIN_TEXT.github.connected(gh?.login ?? null, count)}
              </Text>
            ) : null}
          </View>
        </View>
      )}
      <Note>{BUILTIN_TEXT.github.elsewhere}</Note>
    </Panel>
  );
}

function FeedbackPage({ header }: { header: ReactNode }) {
  const theme = useTheme();
  const { slug } = useBurrow();
  const list = useFeedbackIntegrations({ params: { burrow: slug } }, { retry: false });
  const items = list.data?.integrations ?? [];
  return (
    <Panel footer={null}>
      {header}
      {!list.data && !list.error ? (
        <SkeletonRows count={2} lines={1} label={CONNECT_SCREEN_TEXT.loading} />
      ) : items.length === 0 ? (
        <Note>{BUILTIN_TEXT.feedback.none}</Note>
      ) : (
        <View style={{ gap: 8 }}>
          {items.map(({ integration: i }) => (
            <View key={i.id} style={{ gap: 2 }}>
              <Text size={15} weight={600}>
                {i.name}
              </Text>
              {i.allowedOrigins.length ? (
                <Text size={12.5} mono color={theme.colors.mut} numberOfLines={1}>
                  {i.allowedOrigins.join(' · ')}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
      <Text size={13.5} lh={1.45} color={theme.colors.mut}>
        {BUILTIN_TEXT.feedback.elsewhere}
      </Text>
    </Panel>
  );
}
