/**
 * Connect {Name} on the phone (phone-connect.md PC-01, PC-03, PC-05, PC-10, PC-11; AP-2903…AP-2915): a connectable
 * catalog entry's form, the web's steps form (CS-50, `SetupForm`) word for word in Add a server's layout. (1) Where is
 * it? — the address, read when the field is left (`connections.identify`): the address to use, the service and its
 * version, a certificate of its own to compare and trust; (2) What may agents do? — Look only or Manage; (3) How should
 * Whombat sign in? — the entry's sign-ins as radio cards (sign in once first and recommended: account, password, the
 * code when asked; a key made by hand with the guided steps, Copy, Open {Name} and Paste from the clipboard; an OAuth
 * client; no sign-in). More options holds the name and the fingerprint. The Whombat's refusals bring the
 * web's buttons (Add this network, Use this fingerprint, the choice list, the code, the switch to a token made by hand).
 * Sign-ins elsewhere (PC-05): on a managed Whombat OAuth starts over the session and the provider's page opens in the
 * browser, coming back through the `/connect/` App Link; a self-hosted Whombat's web page opens instead; Nextcloud's
 * login and the service's own sign-in page (“Sign in with Plex”, connection-signin-android.md AP-3950) open in the
 * browser while this screen waits. A code the service asks for comes with the challenge it belongs to (UniFi's emailed
 * code, AP-3955), and a session that asks for a two-step code once gets the code under its password (Synology, AP-3956).
 * Once connected, “{label} connected.” and the connection's page replaces this one (PC-10). Secrets live in this
 * screen's state only: never in params, the saved place or the cache.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  accessChoices,
  addressReasonOf,
  asksAccess,
  asServerNote,
  authNameOf,
  CATALOG_REASON_TEXT,
  CONNECT_FORM_TEXT,
  type ConnectDraft,
  type ConnectProblem,
  codeShown,
  connectableEntry,
  connectBase,
  connectionWords,
  connectProblem,
  connectReturnTo,
  connectsHere,
  createBody,
  draftProblems,
  elsewhereLevelNote,
  fixedAccountOf,
  guidedSteps,
  httpWarning,
  identifiedFields,
  identifies,
  identifyNote,
  initialFields,
  limitNote,
  NO_PROBLEM,
  nameHelp,
  oauthStartBody,
  ownsAuth,
  PLACED_FIELDS,
  probeNote,
  recommended,
  type SignInChoice,
  secretWords,
  serviceLoginBody,
  signInChoices,
  signInNote,
  signingInText,
  visibleFields,
} from '@whombat/client/connections';
import { useCatalogConnections, useConnectionsCatalog, useConnectionWrite } from '@whombat/client/react';
import { connectAccessOf, connectReturnPathOf, thingId } from '@whombat/core';
import { api, type IdentifyConnectionResponse, type ProbeConnectionResponse } from '@whombat/core/contracts';
import {
  type CatalogEntry,
  type ConnectionAccessLevel,
  defaultConnectionLabel,
  fieldProblem,
  resolveTokenUrl,
  suggestedAccess,
} from '@whombat/core/domain';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrow } from '../data/BurrowProvider';
import {
  CONNECT_SCREEN_TEXT,
  catalogConnectErrorText,
  connectGate,
  elsewhereWay,
  fixButtons,
  keptChallenge,
  opensItself,
  opensMore,
  type PendingLogin,
  probedChoice,
  signsInElsewhere,
  stepHeaders,
  submitLabel,
  waitsHere,
} from '../data/connectForm';
import { connectionLogo, connectionsWebPath } from '../data/connections';
import { useAgentWords } from '../data/useAgent';
import { useWebUrl } from '../data/useWebUrl';
import { holdPhoneConnect } from '../managed/connectReturn';
import { useManaged } from '../managed/context';
import { OFFER_LINK } from '../managed/useReach';
import { connectErrorOf, linkedAddress } from '../navigation/connectionLinks';
import { openAppUrl } from '../navigation/hooks';
import { appScreenUrlForPath, type RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import { FormField, FormMessage } from '../ui/formField';
import { BackBar, Screen } from '../ui/headers';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { Button, ErrorState, SkeletonRows } from '../ui/primitives';
import { RadioCards } from '../ui/radioCards';
import { AppSetup } from './connect/AppSetup';
import {
  Busy,
  backUnder,
  CertificateNote,
  Footer,
  FoundNote,
  type GuidedMethod,
  GuidedToken,
  GuideSteps,
  LoginWaitView,
  MoreToggle,
  Note,
  openOutside,
  Panel,
  PLAIN_INPUT,
  pasteFill,
  StepHeader,
  TextLink,
  Title,
} from './connect/parts';
import { useLoginWait } from './connect/useLoginWait';
import { showNotice } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Connect'>;

export function ConnectScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { slug } = useBurrow();
  const { catalogId } = route.params;
  // The screen under this one (a link opened it from anywhere): its name on “‹ …”.
  const [back] = useState(() => route.params.back ?? backUnder(navigation.getState(), route.key));
  const entry = connectableEntry(catalogId);
  const catalog = useConnectionsCatalog({}, { retry: false });
  const list = useCatalogConnections({ params: { burrow: slug } }, { retry: false });
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Connections'));
  const url = linkedAddress(route.params.url) ?? undefined;
  // A sign-in elsewhere that came back refused (`connect_error=`): said above the form, once.
  const [returned, setReturned] = useState(() => catalogConnectErrorText(connectErrorOf(route.params.error)));
  useEffect(() => {
    const text = catalogConnectErrorText(connectErrorOf(route.params.error));
    if (text) {
      setReturned(text);
      navigation.setParams({ error: undefined });
    }
  }, [route.params.error, navigation]);

  if (!entry)
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        <ErrorState text={CONNECT_SCREEN_TEXT.unknown} />
      </Screen>
    );

  const status = catalog.data?.entries.find((e) => e.catalogId === entry.id);
  const appMethod = entry.signIn.find((m) => m.kind === 'app_oauth');
  const gate = list.data || list.error ? connectGate({ entry, status, offerLink: OFFER_LINK }) : null;
  // The level the assistant's card chose (`&access=`); else the form chooses by risk.
  const access = connectAccessOf(route.params.access) ?? undefined;
  const returnTo = connectReturnPathOf(route.params.returnTo) ?? undefined;
  // Proxmox VE, its Backup Server and Unraid: Add as a server first (connect-in-chat.md).
  const server = asServerNote(entry, url);
  const appSetup =
    appMethod && status?.app ? <AppSetup entry={entry} method={appMethod} app={status.app} /> : null;
  const top = (
    <>
      {appSetup}
      {server ? (
        <View style={{ gap: 6 }}>
          <Text size={15} weight={600}>
            {server.title}
          </Text>
          <Note>{server.text}</Note>
          <Button
            label={server.label}
            onPress={() => navigation.navigate('AddServer', { address: server.address, back: entry.name })}
          />
        </View>
      ) : null}
    </>
  );

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      {/* The keyboard pushes the footer up, so the button stays in sight while a password is typed (AP-1697). */}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        {!list.data && !list.error ? (
          <Panel footer={null}>
            <Header entry={entry} />
            <SkeletonRows count={3} lines={2} label={CONNECT_SCREEN_TEXT.loading} />
          </Panel>
        ) : gate ? (
          <Panel footer={null}>
            <Header entry={entry} />
            {appSetup}
            {returned ? <FormMessage text={returned} /> : null}
            <Note>{gate}</Note>
            {addressReasonOf(status) === 'needs_secure_address' ? (
              // One way forward: This Whombat → About → REACH, where Tailscale (and Link) are turned on.
              <Button
                label={CATALOG_REASON_TEXT.needsSecureAddressAction}
                variant="secondary"
                onPress={() => navigation.navigate('WhombatAbout', { at: 'reach' })}
              />
            ) : addressReasonOf(status) === 'needs_mac' ? (
              // Find My reads through a Mac: Add a server, where the Mac is added (findmy-connection.md §1.2).
              <Button
                label={CATALOG_REASON_TEXT.needsMacAction}
                variant="secondary"
                onPress={() => navigation.navigate('AddServer', { back: entry.name })}
              />
            ) : null}
          </Panel>
        ) : (
          <ConnectForm
            key={`${entry.id} ${url ?? ''}`}
            slug={slug}
            entry={entry}
            initialUrl={url}
            {...(access ? { initialAccess: access } : {})}
            {...(returnTo ? { returnTo } : {})}
            notice={returned}
            top={top}
            bottomInset={insets.bottom}
            onConnected={(connectionId, label) => {
              showNotice(CONNECT_FORM_TEXT.connected(label));
              const target = returnTo ? appScreenUrlForPath(returnTo) : null;
              if (target && openAppUrl(target)) return;
              navigation.replace('Thing', {
                thingId: thingId('connection', connectionId),
                title: label,
                back,
              });
            }}
          />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The logo and “Connect {Name}”, the entry's line and its documentation. */
function Header({ entry }: { entry: CatalogEntry }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ConnectionLogo logo={connectionLogo(entry.id, entry.name)} />
        <Title>{CONNECT_SCREEN_TEXT.title(entry.name)}</Title>
      </View>
      <Text size={14} lh={1.45} color={theme.colors.ink2}>
        {entry.description}
      </Text>
      {entry.docsUrl ? (
        <TextLink
          label={CONNECT_SCREEN_TEXT.documentation}
          external
          onPress={() => openOutside(entry.docsUrl)}
        />
      ) : null}
    </View>
  );
}

function ConnectForm({
  slug,
  entry,
  initialUrl,
  initialAccess,
  returnTo,
  notice,
  top,
  bottomInset,
  onConnected,
}: {
  slug: string;
  entry: CatalogEntry;
  /** `&url=` (Found on your network, CS-51): filled in and identified at once. */
  initialUrl?: string;
  /** `&access=` (the assistant's card); left out, chosen by risk (`suggestedAccess`). */
  initialAccess?: ConnectionAccessLevel;
  /** Where to return once connected (e.g. back to the chat thread that opened this form). */
  returnTo?: string;
  /** A sign-in elsewhere's refusal, said once above the form. */
  notice: string | null;
  /** The entry's app (Dropbox, PC-07), and Add as a server for an entry looked after best as one. */
  top: ReactNode;
  bottomInset: number;
  onConnected: (connectionId: string, label: string) => void;
}) {
  const theme = useTheme();
  const managed = useManaged();
  const webUrl = useWebUrl();
  const assistant = useAgentWords();
  const words = connectionWords(assistant.name);
  // The steps, sign in once, Look only and the guided token (CS-50, AP-843).
  // Signing in on the service's own page (Plex's) where the runtime has it; an older one offers the entry's token (CT-744).
  const list = useCatalogConnections({ params: { burrow: slug } }, { retry: false });
  const create = useConnectionWrite(api.connections.create, slug);
  const startOAuth = useConnectionWrite(api.connections.startOAuth, slug);
  const startNextcloud = useConnectionWrite(api.connections.startNextcloud, slug);
  const startService = useConnectionWrite(api.connections.startServiceLogin, slug);
  const update = useConnectionWrite(api.connections.update, slug);
  const probe = useConnectionWrite(api.connections.probe, slug);
  const identify = useConnectionWrite(api.connections.identify, slug);
  const allowNetwork = useConnectionWrite(api.connections.allowNetwork, slug);
  const choices = useMemo(() => signInChoices(entry), [entry]);
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
  /**
   * The sealed challenge that code belongs to (UniFi's emailed code, SG-06; AP-3955), sent back with it. Forgotten when the
   * account, the password or the sign-in changes, or it connected.
   */
  const [challenge, setChallenge] = useState<string | null>(null);
  // Look only or Manage by risk unless the link said (connect-in-chat.md): Manage for lights, Look only for a NAS.
  const [access, setAccess] = useState<ConnectionAccessLevel>(() => initialAccess ?? suggestedAccess(entry));
  const [authName, setAuthName] = useState<string>(() => authNameOf(choice));
  const [problem, setProblem] = useState<ConnectProblem>(NO_PROBLEM);
  const [probed, setProbed] = useState<ProbeConnectionResponse | null>(null);
  /** Nextcloud's login or the service's own page, open in the browser while this screen waits. */
  const [login, setLogin] = useState<PendingLogin | null>(null);
  const [identified, setIdentified] = useState<IdentifyConnectionResponse | null>(null);
  // The next steps open once the address is identified (or has a default, or isn't identified at all).
  const [revealed, setRevealed] = useState(() => !identifies(entry) || !!urlField?.default);
  const [more, setMore] = useState(false);
  /** The address last identified (or being identified), so one address is asked once. */
  const asked = useRef<{ url: string; done: boolean } | null>(null);
  const scroll = useRef<ScrollView | null>(null);
  const shown = visibleFields(entry, choice, fields);
  const methodFields = shown.filter((f) => !PLACED_FIELDS.has(f.id));
  const busy =
    create.isPending ||
    startOAuth.isPending ||
    startNextcloud.isPending ||
    startService.isPending ||
    allowNetwork.isPending ||
    identify.isPending;
  const warning = httpWarning(fields, choice.kind, method, entry.id);
  const sameServiceExists = (list.data?.connections ?? []).some((c) => c.catalogId === entry.id);
  const placeholderLabel = defaultConnectionLabel(entry, fields, {
    onlyOne: !sameServiceExists && entry.category !== 'custom',
  });
  const ownAuth = ownsAuth(entry, method);
  const fixedAccount = fixedAccountOf(method);
  const showCode = codeShown(method, codeAsked !== null);
  const way = elsewhereWay(!!managed, webUrl('/'));

  function pick(next: number) {
    setIndex(next);
    setAuthName(authNameOf(choices[next] ?? choice));
    setProblem(NO_PROBLEM);
    setCodeAsked(null);
    setCode('');
    setChallenge(null);
  }

  function setField(id: string, value: string) {
    setFields((f) => ({ ...f, [id]: value }));
    clearProblem(id);
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
    const address = raw.trim();
    if (!address) {
      setProblem({ ...NO_PROBLEM, fields: { url: `${urlField?.label ?? 'Address'} is needed.` } });
      return;
    }
    // An address with its scheme is checked here first (TrueNAS refuses `http://`): its reason under the field.
    const local =
      urlField && /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? fieldProblem(urlField, address) : null;
    if (local) {
      asked.current = null;
      setProblem({ ...NO_PROBLEM, fields: { url: local } });
      return;
    }
    if (asked.current?.url === address) {
      if (asked.current.done) setRevealed(true);
      return;
    }
    asked.current = { url: address, done: false };
    setProblem(NO_PROBLEM);
    try {
      const result = await identify.mutateAsync({ body: { catalogId: entry.id, url: address } });
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the address the screen opened with
  useEffect(() => {
    if (initialUrl && identifies(entry)) void runIdentify(initialUrl);
  }, []);

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

  // The code the service asked for appears under the password: brought into sight (CS-03).
  useEffect(() => {
    if (codeAsked === null) return;
    const t = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 250);
    return () => clearTimeout(t);
  }, [codeAsked]);

  function show(p: ConnectProblem) {
    setProblem(p);
    if (p.secondFactor) setCodeAsked(p.secondFactor);
    setChallenge((c) => keptChallenge(p, c));
    if (opensMore(p.fields)) setMore(true);
  }

  /** Connects with the form's fields, or with `current` when a button just changed them (“Use this fingerprint”). */
  async function connect(current: Record<string, string> = fields) {
    if (busy) return;
    if (!revealed) return runIdentify();
    const local = draftProblems(entry, choice, shown, draft(current));
    if (Object.keys(local).length) {
      setProblem({ ...NO_PROBLEM, fields: local });
      if (opensMore(local)) setMore(true);
      return;
    }
    setProblem(NO_PROBLEM);
    try {
      if (connectsHere(choice)) {
        const result = await create.mutateAsync({
          params: { burrow: slug },
          body: createBody(entry, choice, shown, draft(current)),
        });
        if (result.status !== 'ok') {
          setProblem({ ...NO_PROBLEM, message: CONNECT_FORM_TEXT.notThrough });
          return;
        }
        // The secrets go with the connection: the form doesn't keep them.
        setSecret('');
        setPassword('');
        setCode('');
        setChallenge(null);
        onConnected(result.data.connection.id, result.data.connection.label);
      } else if (method.kind === 'nextcloud_login') {
        const result = await startNextcloud.mutateAsync({
          params: { burrow: slug },
          body: connectBase(entry, shown, draft(current)),
        });
        if (result.status !== 'ok') {
          setProblem({ ...NO_PROBLEM, message: CONNECT_FORM_TEXT.notThrough });
          return;
        }
        setLogin({ kind: 'nextcloud', flow: result.data });
        if (opensItself(way)) openOutside(result.data.loginUrl);
      } else if (method.kind === 'service_login') {
        // The service's own sign-in page (SG-01, SG-02): the level goes with the start and is set on save.
        const result = await startService.mutateAsync({
          params: { burrow: slug },
          body: serviceLoginBody(entry, shown, draft(current)),
        });
        if (result.status !== 'ok') {
          setProblem({ ...NO_PROBLEM, message: CONNECT_FORM_TEXT.notThrough });
          return;
        }
        setLogin({ kind: 'service', flow: result.data, name: entry.name });
        if (opensItself(way)) openOutside(result.data.loginUrl);
      } else if (way === 'web') {
        // A self-hosted Whombat: its web page, where the sign-in starts and comes back (its cookie route; PC-05).
        openOutside(webUrl(connectionsWebPath(slug, entry.id)));
      } else if (way === 'none' || !managed) {
        setProblem({ ...NO_PROBLEM, message: CONNECT_SCREEN_TEXT.demo });
      } else if (method.kind === 'ha_oauth' || method.kind === 'mcp_oauth' || method.kind === 'app_oauth') {
        const target = connectReturnTo(entry.id, slug, returnTo);
        holdPhoneConnect({ device: managed.applianceId, flow: 'connection' });
        const result = await startOAuth.mutateAsync({
          params: { burrow: slug },
          body: oauthStartBody(entry, shown, draft(current), method.kind, target),
        });
        if (result.status === 'ok') openOutside(result.data.authorizeUrl);
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
      showNotice(CONNECT_FORM_TEXT.networkAdded(problem.network.cidr, problem.network.port));
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
    const address = fields.url?.trim() ?? '';
    const p = urlField ? fieldProblem(urlField, address) : null;
    if (p) {
      setProblem({ ...NO_PROBLEM, fields: { url: p } });
      return;
    }
    setProblem(NO_PROBLEM);
    try {
      const result = await probe.mutateAsync({ body: { catalogId: entry.id, fields: { url: address } } });
      if (result.status !== 'ok') return;
      setProbed(result.data);
      const next = probedChoice(choices, result.data);
      if (next !== null) pick(next);
    } catch (err) {
      setProblem(connectProblem(err));
    }
  }

  /** A paste or a picked file for the guided token (CS-15): fills what it finds, says what it filled. */
  function fill(m: GuidedMethod, text: string): string | null {
    const found = pasteFill(entry, m, text);
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
    return found.text;
  }

  // Nextcloud's login or the service's own page is open in the browser: ask until it hands over (CX-11, SG-02). Nextcloud's
  // gets the level asked once it connects (CT-314); the service's own page took it with the start (CT-738).
  useLoginWait(slug, login, {
    onConnected: async (c) => {
      if (login?.kind === 'nextcloud' && access === 'read' && c.access !== 'read')
        await update
          .mutateAsync({ params: { burrow: slug, connectionId: c.id }, body: { access: 'read' } })
          .catch(() => undefined);
      onConnected(c.id, c.label);
    },
    onFailed: (message) => {
      setLogin(null);
      setProblem({ ...NO_PROBLEM, message });
    },
  });

  if (login)
    return (
      <Panel footer={null}>
        <Header entry={entry} />
        <LoginWaitView login={login} onCancel={() => setLogin(null)} />
      </Panel>
    );

  const certificate =
    identified?.certificate && !identified.certificate.trusted ? identified.certificate : null;
  const pinned = !!certificate && fields.fingerprint === certificate.sha256;
  const note = identified ? identifyNote(entry, identified) : null;
  const headers = stepHeaders(entry, { steps: true, revealed, words, identified });
  const fixes = fixButtons(entry, problem, choices, index);
  const levelNote = elsewhereLevelNote(entry, choice, access);
  const limit = limitNote(entry, method, words);
  const elsewhere = !connectsHere(choice) && !waitsHere(choice);

  const where = urlField ? (
    <View style={{ gap: 12 }}>
      <FormField
        label={urlField.label}
        value={fields.url ?? ''}
        onChangeText={(v) => setField('url', v)}
        placeholder={urlField.placeholder}
        hint={urlField.help}
        error={problem.fields.url}
        mono
        keyboardType="url"
        returnKeyType="next"
        maxLength={300}
        onBlur={() => {
          if (identifies(entry) && fields.url?.trim()) void runIdentify();
        }}
        onSubmitEditing={() => {
          if (identifies(entry)) void runIdentify();
        }}
        {...PLAIN_INPUT}
      />
      {entry.id === 'custom_mcp' ? (
        <Button
          label={CONNECT_FORM_TEXT.checkAddress}
          variant="secondary"
          disabled={probe.isPending || busy}
          onPress={() => void runProbe()}
        />
      ) : null}
      {probed ? <Note tone={probeNote(probed).tone}>{probeNote(probed).text}</Note> : null}
      {identify.isPending ? <Busy text={CONNECT_FORM_TEXT.identifying} /> : null}
      {note && !identify.isPending ? <FoundNote note={note} /> : null}
      {certificate && !identify.isPending ? (
        <CertificateNote
          entry={entry}
          sha256={certificate.sha256}
          canPin={!!certField}
          pinned={pinned}
          onTrust={() => setField('fingerprint', certificate.sha256)}
          onUndo={() => setField('fingerprint', '')}
        />
      ) : null}
    </View>
  ) : null;

  const accessStep = (
    <View style={{ gap: 10 }}>
      <RadioCards
        label={words.mayDoQuestion}
        value={access}
        onChange={setAccess}
        disabled={busy}
        options={accessChoices(entry).map((a) => ({
          value: a.value,
          title: a.label,
          line: words.access(a.text),
        }))}
      />
      {limit ? <Note>{limit}</Note> : null}
    </View>
  );

  // The code: sign in once's (CS-03), or a session's two-step code once the service asked (Synology, SG-09; AP-3956).
  const codeField = showCode ? (
    <FormField
      // A code the service asked for takes the focus (CS-03).
      key={codeAsked === null ? 'optional' : 'asked'}
      autoFocus={codeAsked !== null}
      label={codeAsked === null ? CONNECT_FORM_TEXT.codeOptional : CONNECT_FORM_TEXT.code}
      value={code}
      onChangeText={(v) => {
        setCode(v);
        clearProblem('code');
      }}
      placeholder={CONNECT_FORM_TEXT.codePlaceholder}
      hint={codeAsked ?? CONNECT_FORM_TEXT.codeHelp}
      error={problem.fields.code}
      keyboardType="number-pad"
      autoComplete="one-time-code"
      textContentType="oneTimeCode"
      maxLength={12}
      returnKeyType="go"
      onSubmitEditing={() => void connect()}
    />
  ) : null;

  const signIn = (
    <View style={{ gap: 14 }}>
      {choices.length > 1 ? (
        <RadioCards
          label={CONNECT_FORM_TEXT.howSignsIn}
          value={index}
          onChange={pick}
          disabled={busy}
          options={choices.map((ch) => ({
            value: ch.index,
            title: ch.label,
            tag: recommended(ch) ? CONNECT_FORM_TEXT.recommended : null,
            line: signInNote(entry, ch.method),
          }))}
        />
      ) : null}
      {choices.length === 1 && method.kind === 'password' ? <Note>{method.creates}</Note> : null}
      {/* One sign-in elsewhere: its line, so the step isn't empty (the web's card line, AP-2903). */}
      {choices.length === 1 && signsInElsewhere(choice) && !waitsHere(choice) ? (
        <Note>{signInNote(entry, method)}</Note>
      ) : null}
      {method.kind === 'password' ? (
        <>
          {/* No account (T3 Code's pairing code, Whombat t3code.md T3-02): the secret alone. */}
          {!method.account ? null : fixedAccount ? (
            <View style={{ gap: 4 }}>
              <Text size={13} weight={500} color={theme.colors.ink2}>
                {method.account.label}
              </Text>
              <Text size={15} mono>
                {fixedAccount}
              </Text>
              {method.account.help ? <Note>{method.account.help}</Note> : null}
            </View>
          ) : (
            <FormField
              label={method.account.label}
              value={account}
              onChangeText={(v) => {
                setAccount(v);
                setChallenge(null);
                clearProblem('account');
              }}
              placeholder={method.account.placeholder}
              hint={method.account.help}
              error={problem.fields.account}
              returnKeyType="next"
              {...PLAIN_INPUT}
            />
          )}
          {/* A secret with its own name (T3 Code's pairing code): the steps to make one, like a token's. */}
          <GuideSteps
            label={CONNECT_FORM_TEXT.making(secretWords(method).label)}
            steps={guidedSteps(entry, secretWords(method), fields)}
          />
          <FormField
            label={method.secret?.label ?? CONNECT_FORM_TEXT.password}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              setChallenge(null);
              clearProblem('password');
            }}
            placeholder={method.secret?.placeholder}
            hint={method.secret?.help ?? CONNECT_FORM_TEXT.passwordHelp}
            error={problem.fields.password}
            secret
            maxLength={1024}
            returnKeyType="go"
            onSubmitEditing={() => void connect()}
          />
          {codeField}
        </>
      ) : null}
      {method.kind === 'token' || method.kind === 'client_credentials' ? (
        <GuidedToken
          key={choice.index}
          entry={entry}
          method={method}
          fields={fields}
          access={asksAccess(choice) ? access : 'manage'}
          pasteLabel={CONNECT_SCREEN_TEXT.paste(entry.name)}
          openLabel={CONNECT_SCREEN_TEXT.open(entry.name)}
          onPaste={(text) => fill(method, text)}
        />
      ) : null}
      {methodFields.map((f) =>
        // A select with its own choices (Find My's Read in the background): radio cards, as a service's choices.
        f.kind === 'select' && f.options ? (
          <View key={f.id} style={{ gap: 8 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {f.label.toUpperCase()}
            </Text>
            <RadioCards
              label={f.label}
              value={fields[f.id] ?? f.default ?? ''}
              onChange={(v) => setField(f.id, v)}
              disabled={busy}
              options={f.options.map((o) => ({ value: o.value, title: o.label }))}
            />
            {problem.fields[f.id] ? <FormMessage text={problem.fields[f.id] ?? null} /> : null}
            {f.help ? <Note>{f.help}</Note> : null}
          </View>
        ) : (
          <FormField
            key={f.id}
            label={f.label}
            value={fields[f.id] ?? ''}
            onChangeText={(v) => setField(f.id, v)}
            placeholder={f.placeholder}
            hint={f.help}
            error={problem.fields[f.id]}
            multiline={!!f.guide}
            mono={f.kind === 'url'}
            keyboardType={f.kind === 'url' ? 'url' : 'default'}
            {...PLAIN_INPUT}
          />
        ),
      )}
      {ownAuth && method.kind === 'token' ? (
        <FormField
          label={
            method.auth.type === 'query' ? CONNECT_FORM_TEXT.parameterName : CONNECT_FORM_TEXT.headerName
          }
          value={authName}
          onChangeText={(v) => {
            setAuthName(v);
            clearProblem('authName');
          }}
          hint={method.auth.type === 'query' ? CONNECT_FORM_TEXT.parameterHelp : CONNECT_FORM_TEXT.headerHelp}
          error={problem.fields.authName}
          mono
          {...PLAIN_INPUT}
        />
      ) : null}
      {method.kind === 'token' || method.kind === 'client_credentials' ? (
        <View style={{ gap: 2 }}>
          <FormField
            label={method.secretLabel}
            value={secret}
            onChangeText={(v) => {
              setSecret(v);
              clearProblem('secret');
            }}
            placeholder={method.secretPlaceholder ?? ''}
            hint={method.steps.length ? undefined : method.secretHelp}
            error={problem.fields.secret}
            secret
            maxLength={8192}
          />
          {!method.steps.length && method.kind === 'token' && resolveTokenUrl(entry, fields) ? (
            <TextLink
              label={CONNECT_SCREEN_TEXT.open(entry.name)}
              external
              onPress={() => openOutside(resolveTokenUrl(entry, fields))}
            />
          ) : null}
        </View>
      ) : null}
      {method.kind === 'token' ? codeField : null}
      {method.kind === 'nextcloud_login' ? <Note>{CONNECT_FORM_TEXT.nextcloudPhone}</Note> : null}
      {method.kind === 'service_login' ? (
        <Note>{CONNECT_FORM_TEXT.serviceLoginPhone(entry.name)}</Note>
      ) : null}
      {method.kind === 'ha_oauth' ? <Note>{CONNECT_FORM_TEXT.homeAssistant}</Note> : null}
      {elsewhere && way === 'web' ? <Note>{CONNECT_SCREEN_TEXT.onTheWeb}</Note> : null}
      {levelNote ? <Note>{levelNote}</Note> : null}
    </View>
  );

  const bodies = { where, access: accessStep, signIn };

  return (
    <Panel
      scrollRef={scroll}
      footer={
        <Footer bottomInset={bottomInset}>
          {problem.message ? (
            <View style={{ gap: 8 }}>
              {problem.choice ? <Note>{problem.message}</Note> : <FormMessage text={problem.message} />}
              {fixes.map((f) => (
                <Button
                  key={f.kind}
                  label={f.label}
                  variant="secondary"
                  disabled={busy}
                  onPress={() =>
                    f.kind === 'network'
                      ? void addNetwork()
                      : f.kind === 'fingerprint'
                        ? void pinCertificate()
                        : pick(f.index)
                  }
                />
              ))}
            </View>
          ) : null}
          {create.isPending && method.kind === 'password' ? (
            <Busy text={signingInText(entry, method)} />
          ) : null}
          <Button
            label={submitLabel(entry, choice, revealed)}
            size="lg"
            busy={busy}
            disabled={!!problem.choice && !fields[problem.choice.field]}
            onPress={() => void connect()}
          />
        </Footer>
      }
    >
      <Header entry={entry} />
      {top}
      {notice ? <FormMessage text={notice} /> : null}
      {headers.map((h) => (
        <View key={h.step} style={{ gap: 12 }}>
          <StepHeader number={h.number} title={h.title} done={h.done} />
          {bodies[h.step]}
        </View>
      ))}
      {revealed ? (
        <View style={{ gap: 12 }}>
          <MoreToggle
            open={more}
            summary={CONNECT_FORM_TEXT.moreSummary(label.trim() || placeholderLabel)}
            onPress={() => setMore((m) => !m)}
          />
          {more ? (
            <View style={{ gap: 16 }}>
              <FormField
                label={CONNECT_FORM_TEXT.name}
                value={label}
                onChangeText={(v) => {
                  setLabel(v);
                  clearProblem('label');
                }}
                placeholder={placeholderLabel}
                hint={nameHelp(entry, words)}
                error={problem.fields.label}
                maxLength={80}
              />
              {certField && shown.some((f) => f.id === 'fingerprint') ? (
                <FormField
                  label={certField.label}
                  value={fields.fingerprint ?? ''}
                  onChangeText={(v) => setField('fingerprint', v)}
                  placeholder={certField.placeholder}
                  hint={certField.help}
                  error={problem.fields.fingerprint}
                  mono
                  {...PLAIN_INPUT}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
      {revealed && warning ? <Note tone="warn">{warning}</Note> : null}
      {problem.choice ? (
        <View style={{ gap: 8 }}>
          <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
            {(
              entry.fields.find((f) => f.id === problem.choice?.field)?.label ?? CONNECT_FORM_TEXT.chooseOne
            ).toUpperCase()}
          </Text>
          <RadioCards
            label={
              entry.fields.find((f) => f.id === problem.choice?.field)?.label ?? CONNECT_FORM_TEXT.chooseOne
            }
            value={fields[problem.choice.field] ?? ''}
            onChange={(v) => setFields((f) => ({ ...f, [problem.choice?.field ?? '']: v }))}
            options={problem.choice.options.map((o) => ({ value: o.value, title: o.label }))}
          />
        </View>
      ) : null}
    </Panel>
  );
}
