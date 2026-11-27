/**
 * The burrow app over an end-to-end session with one appliance (AP-10…AP-17, AP-27): the secure session (app
 * channel, pinned to the appliance identity), the typed client and realtime on it — so every existing screen
 * (inbox, DMs, channels, approvals, runs) works unchanged, with no legacy HTTP — the cache scope guard (clears
 * queries and decrypted files on account/permission change, revocation, sign-out, switch), push for this
 * appliance, a quiet connection strip, and the full-page states a session can end in.
 */
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createClient,
  itemsNeedNewerApp,
  leftOut,
  PART_NEEDS_NEWER_APP,
  type Realtime,
  TAILSCALE_TEXT,
  type WhombatClient,
} from '@whombat/client';
import {
  type ApplianceSummary,
  type ControlApi,
  clearPush,
  fingerprintOf,
  forgetAppliance,
  type GoneReason,
  goneOf,
  type KnownAppliance,
  linkBannerView,
  type ManagedWhombats,
  ownAddressToKeep,
  PASSKEY_COPY,
  passkeyName,
  REACH_TEXT,
  readOwnAddress,
  readReach,
} from '@whombat/client/managed';
import { useOnePasskeySetup } from '@whombat/client/managed/react';
import { refetchOwedReads } from '@whombat/client/query';
import { useMe, useWhombat, WhombatClientProvider } from '@whombat/client/react';
import {
  type ApplianceSession,
  type ConnectionState,
  clearable,
  createScopeGuard,
  createSecureSession,
  createSessionRealtime,
  type OwnAddressSummary,
  type ScopeGuard,
  scopeFromInfo,
  scopeKey,
  sessionOps,
} from '@whombat/client/session';
import { api, DEFAULT_AGENT_NAME, ONBOARDING_STEP_COUNT } from '@whombat/core';
import type { DirectAddresses, ReachGetOutput } from '@whombat/protocol/session';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState, Linking, View } from 'react-native';
import type { Sha256 } from '../../modules/whombat-crypto';
import { WhombatLive } from '../../modules/whombat-live';
import { BurrowProvider } from '../data/BurrowProvider';
import { pickBurrow } from '../data/config';
import { OutboxProvider, useOutboxWaiting } from '../data/OutboxProvider';
import { createQueryPersister, QUERY_CACHE_NAME, type QueryPersister } from '../data/queryPersist';
import { deviceBox } from '../data/secureBoxNative';
import { wipeShares } from '../data/shareInbox';
import { SYNC_LOG_NAME, type SyncEntry, syncLog, watchReads } from '../data/syncLog';
import { createNoteSender, noteLine } from '../errors/errorNotes';
import { errorNotes, noteListenerError } from '../errors/nativeErrorNotes';
import { sharedFiles } from '../lib/sharedCache';
import { LiveActivityBridge } from '../live/LiveActivityBridge';
import { StatusWidgetBridge } from '../live/StatusWidgetBridge';
import { RootNavigator } from '../navigation/RootNavigator';
import { prefetchNavigation } from '../navigation/useNavigationPersistence';
import { phoneNotifications } from '../push/phoneNotifications';
import { AccountThemeProvider } from '../settings/accountTheme';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Screen, ScreenStripContext } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { StartHold } from '../ui/StartHold';
import type { AppUpdateSource } from './appUpdate';
import {
  createBackgroundRelease,
  createBoxReach,
  createFreshness,
  type Freshness,
  retryFailedReads,
} from './background';
import { useDeliverBackupKey } from './backupPasskey';
import { APP_BUILD } from './config';
import {
  BurrowSwitchContext,
  type LinkBus,
  ManagedContext,
  type ManagedContextValue,
  type PushTaps,
} from './context';
import { COPY } from './copy';
import { type EndpointKey, type ManagedEnvironment, phoneClient, phoneLabel } from './env';
import { expoFileApi } from './expoFiles';
import { clearResourceFiles } from './files';
import { checkedNativeSha256 } from './nativeCrypto';
import { PASSKEY_NUDGE, PASSKEYS } from './passkeyEnv';
import { clearBoxPush } from './push';
import { readBackCopy } from './readBackCopy';
import { GateScreen, IdentityStopScreen } from './screens';
import { UpdateAppButton } from './UpdateAppButton';
import { ErrorLine, Field, Frame } from './ui';
import { useAppUpdate } from './useAppUpdate';
import { pushStore, useManagedPush } from './usePush';
import { useTailscaleTurnOn } from './useReach';
import { VersionGate } from './VersionGate';
import { useWhatsNewNotice, WhatsNewNoticeView } from './WhatsNewNotice';
import { stripNotices } from './whatsNew';

const REAL_CLOCK = () => new Date();

/** A live activity on screen is fed only through the connection (a managed Whombat sends no live pushes, NT-13). */
const liveActivityShown = async () => (await WhombatLive.active()).length > 0;

interface Setup {
  raw: ApplianceSession;
  session: ApplianceSession;
  client: WhombatClient;
  realtime: Realtime;
  queryClient: QueryClient;
  guard: ScopeGuard;
  /** The last-seen burrow, kept on the device between launches (AP-717). */
  persister: QueryPersister;
  /** Where this Whombat's data is kept on the device (`managed:<org>/<Whombat>`). */
  storageScope: string;
  freshness: Freshness;
  /** Messages wait in the outbox: the connection is kept in the background to send them (AP-925). */
  holds: { outbox: boolean };
}

/** The storage scope of a Whombat's data on the device: the account isn't known before the session opens. */
export function storageScopeOf(orgId: string, device: string): string {
  return `managed:${orgId}/${device}`;
}

function nativeHash(): { sha256?: () => Sha256 } {
  const sha256 = checkedNativeSha256();
  return sha256 ? { sha256 } : {};
}

function createSetup(input: {
  env: ManagedEnvironment;
  orgId: string;
  appliance: KnownAppliance;
  keyPair: EndpointKey;
  /** The box's direct ways as last remembered (read on every connection, HE-50). */
  direct: () => DirectAddresses | null | undefined;
  /** The box's own address as last remembered (own-address.md): dialed before the direct ways. */
  own: () => string | null | undefined;
  /** A community box: its direct ways only, never the relay (AP-5472). */
  community: boolean;
}): Setup {
  // What the last Whombat sent doesn't count for this one (AP-266).
  leftOut.reset();
  const raw = createSecureSession({
    connector: input.env.connector({
      orgId: input.orgId,
      device: input.appliance.device,
      peerId: input.appliance.peerId,
      channel: 'app',
      key: input.keyPair,
      direct: input.direct,
      own: input.own,
      ...(input.community && { directOnly: true }),
    }),
    client: phoneClient(APP_BUILD),
    // A listener that throws is noted for the box's log; the session and the other listeners go on.
    onListenerError: noteListenerError,
    // Downloads and uploads hash every byte: the phone's own SHA-256 when it matches the pure-JS one.
    ...nativeHash(),
  });
  const realtime = createSessionRealtime(raw, { onListenerError: noteListenerError });
  // Back in the foreground or online again, a read is refetched only when it may have missed a change: while the live
  // updates kept up or resumed where they left off, realtime kept it current. One that failed is asked again on coming
  // back, as before. Getting online in the background waits for the foreground.
  const freshness = createFreshness(raw, realtime);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1,
        refetchOnWindowFocus: (query) =>
          query.state.status === 'error' || freshness.missed(query.state.dataUpdatedAt),
        refetchOnReconnect: (query) =>
          focusManager.isFocused() && freshness.missed(query.state.dataUpdatedAt),
      },
    },
  });
  const client = createClient({ session: raw });
  // Everything cached from this appliance (AP-17): queries, decrypted files, shared copies, live notifications, and what
  // is kept on the device (the last-seen burrow and the outbox, AP-717: every Whombat's, and their key).
  const guard = createScopeGuard([
    clearable(queryClient),
    { clear: () => clearResourceFiles(expoFileApi) },
    { clear: () => sharedFiles.clear() },
    { clear: () => phoneNotifications.endAll() },
    { clear: () => WhombatLive.clearStatusWidget(input.appliance.device) },
    { clear: () => deviceBox().wipe() },
    // A share waiting to be sent, and its copies in the cache (MX-07).
    { clear: () => wipeShares() },
    // This phone's sync log names conversations: it goes with the rest.
    { clear: () => syncLog.clear() },
  ]);
  const storageScope = storageScopeOf(input.orgId, input.appliance.device);
  const persister = createQueryPersister({
    qc: queryClient,
    box: deviceBox(),
    scope: storageScope,
    account: () => {
      const scope = guard.scope();
      return scope ? scopeKey(scope) : null;
    },
    log: syncLog.note,
  });
  return {
    raw,
    session: raw,
    client,
    realtime,
    queryClient,
    guard,
    persister,
    storageScope,
    freshness,
    holds: { outbox: false },
  };
}

export interface ApplianceRootProps {
  env: ManagedEnvironment;
  orgId: string;
  /** The organization's name: a new burrow starts with it (AP-75). */
  orgName: string | null;
  appliance: KnownAppliance;
  keyPair: EndpointKey;
  email: string;
  onSignOut: () => void;
  onSwitch: () => void;
  /** This phone isn't (or no longer) enrolled there: ask to be let in. */
  onNotEnrolled: () => void;
  /** “Make a kit” (a Whombat from before the passkey); absent: hidden. */
  onKit?: () => void;
  /** Bringing a Whombat back (`ManagedContextValue.onBringBack`); absent: hidden. */
  onBringBack?: (later: boolean) => void;
  taps: PushTaps;
  links: LinkBus;
  /** Work sign-out does while this session still works (the appliance forgets the push handle). */
  addSignOutTask: (task: (session: ApplianceSession | null) => Promise<void>) => () => void;
  /** This phone was removed: a new key, then ask to be let in again (AP-39) or use the recovery kit (AP-41). */
  onSetUpAgain: (then: 'pair' | 'recover') => Promise<void>;
  /** Forget this Whombat on this phone (after the hard stop of an identity that doesn't match, AP-64). */
  onForget: () => void;
  /**
   * Control ended the session for good because this Whombat can't be opened any more (AP-696): retired, or not this
   * organization's. The list says why.
   */
  onGone: (reason: GoneReason) => void;
  /** The account this phone acts as there (remembered for recovery, AP-41). */
  onAccount: (accountId: string) => void;
  /** The box's direct ways changed (`welcome.direct`): remember them for the next connection (HE-50). */
  onDirect: (direct: DirectAddresses | null) => void;
  /**
   * The box's own address changed (a rename, or its move to `whombat.app`): remember `https://<host>/` for the next
   * connection, which dials it first. The old one keeps working for 30 days, so nothing breaks meanwhile.
   */
  onOwnAddress?: (url: string) => void;
  /** Other Whombats this phone knows (they'll ask to let it in again too). */
  hasOthers: boolean;
  /** Switch Whombat's sheet (whombat-switcher.md AP-3084). */
  whombats: ManagedWhombats;
  /**
   * A community box (HE-58; AP-5470, AP-5472): reached on its direct ways only, with no control behind it — no push
   * registration, licence strip, passkey nudge or app-update check through control.
   */
  community?: boolean;
}

export function ApplianceRoot(props: ApplianceRootProps) {
  const { env, orgId, appliance, keyPair } = props;
  const [setup, setSetup] = useState<Setup | null>(null);
  const [state, setState] = useState<ConnectionState>({ status: 'idle' });
  const callbacks = useRef(props);
  callbacks.current = props;
  const current = useRef(appliance);
  current.current = appliance;
  const { device, peerId } = appliance;

  // A new session only for another appliance or key (device and peerId stand for the appliance).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const s = createSetup({
      env,
      orgId,
      appliance: current.current,
      keyPair,
      direct: () => current.current.direct,
      own: () => current.current.ownAddress,
      community: callbacks.current.community === true,
    });
    const offGuard = s.guard.watch(s.raw, orgId);
    const offState = s.raw.onState(setState);
    // Box reads run while the connection is open, or while the phone says it is online (the connection is then on its
    // way): a Wi-Fi without internet still reaches the box on its direct way. Another network dials now, or checks an
    // open connection, whose socket may be tied to the old one. Its listener comes before the one that asks the owed
    // reads as the connection opens, so they find the reads online and don't wait paused.
    const reach = createBoxReach({ session: s.raw, setOnline: (on) => onlineManager.setOnline(on) });
    // This phone's sync log (`data/syncLog.ts`): the reads worth knowing about, the connection and the app coming and
    // going; the notes of earlier runs come back from the device, and go there with the copy on the way out.
    const offReads = watchReads(s.queryClient.getQueryCache(), syncLog);
    // A read on screen that failed is asked again 30 s after it failed, while the app is in the foreground.
    const stopRetry = retryFailedReads(s.queryClient, { foreground: () => focusManager.isFocused() });
    let lastStatus: string | null = null;
    const offNotes = s.raw.onState((next) => {
      if (next.status === lastStatus) return;
      lastStatus = next.status;
      const why = 'reason' in next ? ` · ${next.reason}` : '';
      syncLog.note(`connection ${next.status}${why}`);
    });
    void deviceBox()
      .load<SyncEntry[]>(s.storageScope, SYNC_LOG_NAME)
      .then((saved) => saved && syncLog.prepend(saved))
      .catch(() => {});
    const saveNotes = () =>
      void deviceBox()
        .save(s.storageScope, SYNC_LOG_NAME, syncLog.entries())
        .catch(() => {});
    s.raw.connect();
    // The last-seen burrow first (AP-717): the app opens with it while the session comes up. Kept only for the account
    // (and permissions) it was saved under: a session that opens as another drops it.
    let restored: string | null = null;
    let stopPersist = () => {};
    const dropForeign = () => {
      const scope = s.guard.scope();
      if (!restored || !scope || scopeKey(scope) === restored) return;
      restored = null;
      s.queryClient.clear();
      void deviceBox()
        .remove(s.storageScope, QUERY_CACHE_NAME)
        .catch(() => {});
    };
    let open = false;
    // An error that stopped the app (or a page) since the last session goes to the box's log as one opens, a page's
    // at once while one is open (`errors/errorNotes.ts`).
    const sendNotes = createNoteSender(errorNotes, (notes) =>
      s.client.request(api.devices.reportErrors, { body: { notes } }),
    );
    // Each also goes into this phone's sync log, which the person can share from About: a note exists there even
    // when no session opens to send it.
    for (const note of errorNotes.pending()) syncLog.note(noteLine(note));
    const offErrorNotes = errorNotes.onAdd(() => {
      const newest = errorNotes.pending().at(-1);
      if (newest) syncLog.note(noteLine(newest));
      if (open) void sendNotes();
    });
    const offForeign = s.raw.onState((next) => {
      const opened = next.status === 'open' && !open;
      open = next.status === 'open';
      if (next.status !== 'open') return;
      dropForeign();
      // What is on screen and owed a read (the saved copy, a read that failed while the connection was down) is asked
      // as the connection opens, not on its next retry or the next return to the app.
      if (opened) void refetchOwedReads(s.queryClient);
      if (opened) void sendNotes();
    });
    // The saved place loads alongside it (AP-923), so the navigator finds it read.
    prefetchNavigation(s.storageScope);
    const stopReadBack = readBackCopy(
      s.persister.restore().catch(() => null),
      1500,
      {
        restored(account, late) {
          if (late) syncLog.note('copy read back after the first screen');
          restored = account;
          dropForeign();
        },
        ready() {
          dropForeign();
          stopPersist = s.persister.start();
          setSetup(s);
        },
      },
    );
    // Back in the foreground or back online: reconnect now (a fresh handshake), instead of waiting out the backoff, and
    // after a while away check a connection that says it is open. In the background the connection is let go after a
    // grace, unless work is under way, messages wait to be sent or a live activity is on screen (AP-925); what is kept on
    // the device is saved at once.
    const release = createBackgroundRelease({
      session: s.raw,
      keep: async () => s.holds.outbox || (await liveActivityShown()),
    });
    const appState = AppState.addEventListener('change', (next) => {
      syncLog.note(`app ${next}`);
      if (next === 'active') release.foreground();
      focusManager.setFocused(next === 'active');
      if (next === 'background') {
        release.background();
        void s.persister.flush();
        saveNotes();
      }
    });
    const offNet = NetInfo.addEventListener((n) => reach.net(n));
    const offSignOut = callbacks.current.addSignOutTask(async () => {
      // A phone that joined without a cloud account handed its token to the box: the box forgets it (LNK-36).
      if (callbacks.current.community) return clearBoxPush(s.raw.state().status === 'open' ? s.raw : null);
      await clearPush(env.control, pushStore, s.raw.state().status === 'open' ? s.raw : null);
    });
    return () => {
      stopReadBack();
      stopPersist();
      offReads();
      stopRetry();
      offNotes();
      offForeign();
      offErrorNotes();
      offGuard();
      offState();
      appState.remove();
      release.dispose();
      s.freshness.dispose();
      offNet();
      reach.dispose();
      offSignOut();
      s.raw.close();
      // Leaving this appliance (switch, sign-out): nothing of it stays on the phone.
      void s.guard.clearAll('signed_out');
      setSetup((c) => (c === s ? null : c));
    };
  }, [env, orgId, device, peerId, keyPair]);

  const accountId = state.status === 'open' ? state.info.account?.id : undefined;
  useEffect(() => {
    if (accountId) callbacks.current.onAccount(accountId);
  }, [accountId]);

  // The box's direct ways (`welcome.direct`, HE-50): remembered for the next connection when they change.
  const direct = state.status === 'open' ? state.info.direct : undefined;
  const directKey = direct === undefined ? null : JSON.stringify(direct);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `directKey` stands for `direct`.
  useEffect(() => {
    if (direct === undefined || directKey === JSON.stringify(current.current.direct ?? null)) return;
    current.current = { ...current.current, direct };
    callbacks.current.onDirect(direct);
  }, [directKey]);

  useEffect(() => {
    if (state.status !== 'closed') return;
    if (state.reason === 'not_enrolled') callbacks.current.onNotEnrolled();
    if (state.reason === 'revoked') void forgetAppliance(pushStore, device).catch(() => {});
    // Retired, or not this organization's any more (AP-696): back to the list, which says so.
    const gone = goneOf(state);
    if (gone) callbacks.current.onGone(gone);
  }, [state, device]);

  // The box's current own address, as it says each time the connection opens (and as This Whombat → About reads it):
  // kept when it differs from the one this phone has, so a rename or a move reaches the next connection.
  const keepOwnAddress = useCallback((own: Pick<OwnAddressSummary, 'host' | 'url'> | null) => {
    const url = ownAddressToKeep(current.current.ownAddress, own);
    if (!url) return;
    current.current = { ...current.current, ownAddress: url };
    callbacks.current.onOwnAddress?.(url);
  }, []);
  const opened = state.status === 'open';
  useEffect(() => {
    if (!setup || !opened) return;
    let live = true;
    readOwnAddress(setup.raw).then(
      (own) => live && keepOwnAddress(own),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [setup, opened, keepOwnAddress]);

  if (state.status === 'closed') return <Gate state={state} {...props} />;
  if (!setup)
    return (
      <StartHold>
        <Screen>
          <Loading />
        </Screen>
      </StartHold>
    );
  return (
    <QueryClientProvider client={setup.queryClient}>
      <WhombatClientProvider client={setup.client} realtime={setup.realtime}>
        <Shell setup={setup} state={state} keepOwnAddress={keepOwnAddress} {...props} />
      </WhombatClientProvider>
    </QueryClientProvider>
  );
}

function Shell({
  setup,
  state,
  keepOwnAddress,
  ...props
}: ApplianceRootProps & {
  setup: Setup;
  state: ConnectionState;
  keepOwnAddress: (own: Pick<OwnAddressSummary, 'host' | 'url'> | null) => void;
}) {
  // A box this phone joined without a cloud account (its record says so): no control behind it here. The edition in
  // the welcome no longer decides it: every box is the same image now (whombat-link.md LNK-01).
  const community = props.community === true;
  const push = useManagedPush({
    control: props.env.control,
    session: setup.raw,
    device: props.appliance.device,
    connection: state,
    via: community ? 'box' : 'control',
  });
  const lastScope = useRef(`${props.orgId}/${props.appliance.device}`);
  if (state.status === 'open') {
    const scope = scopeFromInfo(props.orgId, state.info);
    if (scope) lastScope.current = scopeKey(scope);
  }
  const cacheScope = lastScope.current;
  // The journeys out read the latest callbacks (they are new functions on every render of the root).
  const cb = useRef(props);
  cb.current = props;
  const hasKit = !!props.onKit;
  const hasBringBack = !!props.onBringBack;
  const actions = useMemo(
    () => ({
      ...(hasKit && { onKit: () => cb.current.onKit?.() }),
      ...(hasBringBack && { onBringBack: (later: boolean) => cb.current.onBringBack?.(later) }),
      switchAppliance: () => cb.current.onSwitch(),
      whombats: {
        list: () => cb.current.whombats.list(),
        known: (device: string) => cb.current.whombats.known(device),
        connect: (device: string) => cb.current.whombats.connect?.(device) ?? null,
        open: (a: ApplianceSummary) => cb.current.whombats.open(a),
        get claim() {
          return cb.current.whombats.claim;
        },
        get local() {
          return cb.current.whombats.local;
        },
      },
      signOut: () => cb.current.onSignOut(),
      ownAddressSeen: keepOwnAddress,
    }),
    [hasKit, hasBringBack, keepOwnAddress],
  );
  const { appliance, keyPair, email, taps } = props;
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);
  const value = useMemo<ManagedContextValue>(
    () => ({
      session: setup.raw,
      connection: state,
      applianceId: appliance.device,
      applianceName: appliance.name,
      applianceFingerprint: fingerprintOf(appliance.peerId),
      appliancePeerId: appliance.peerId,
      deviceFingerprint: keyPair.fingerprint,
      devicePeerId: keyPair.peerId,
      email,
      cacheScope,
      push,
      taps,
      showNote: setNote,
      links: props.links,
      ...(!community && { control: props.env.control }),
      updates: props.env.control,
      orgId: props.orgId,
      community,
      ...actions,
    }),
    [
      setup,
      state,
      appliance,
      keyPair,
      email,
      cacheScope,
      push,
      taps,
      actions,
      props.links,
      props.env,
      props.orgId,
      community,
    ],
  );
  // The strip, the passkey nudge and the update notice are asked for here, once for the app; every screen shows the
  // same view of them (AP-931).
  const line = useStrip({ state, session: setup.raw, updates: props.env.control, note });
  const nudge = usePasskeyNudge({
    session: setup.raw,
    control: community ? null : props.env.control,
    appliance,
    whombats: actions.whombats,
    endpoint: keyPair.peerId,
    open: state.status === 'open',
    me: state.status === 'open' ? (state.info.account?.id ?? null) : null,
  });
  const open = state.status === 'open';
  // “Whombat updated” once after each update of this Whombat (its device id keeps what this phone saw).
  const whatsNew = useWhatsNewNotice({ session: setup.raw, cacheScope, whombat: appliance.device, open });
  // A passkey sign-in's backup key, handed to the Whombat now its session is open (backup-passkey.md).
  useDeliverBackupKey(setup.raw, appliance.device, open);
  const strip = useMemo(() => {
    // After an update, once: under the passkey nudge when that shows too, never waiting for it.
    const shows = stripNotices({ open, nudge: Boolean(nudge), whatsNew: Boolean(whatsNew) });
    return (
      <>
        {line ? <StripLine line={line} onRetry={() => setup.raw.reconnectNow()} /> : null}
        {shows.nudge && nudge ? <PasskeyNudgeView nudge={nudge} /> : null}
        {shows.whatsNew && whatsNew ? <WhatsNewNoticeView notice={whatsNew} /> : null}
      </>
    );
  }, [line, nudge, whatsNew, open, setup]);
  return (
    <ManagedContext.Provider value={value}>
      <ScreenStripContext.Provider value={strip}>
        <OutboxProvider
          key={setup.storageScope}
          scope={setup.storageScope}
          connected={state.status === 'open'}
        >
          <OutboxHold holds={setup.holds} />
          <ManagedBurrow orgName={props.orgName}>
            <AccountThemeProvider>
              <RootNavigator persistScope={setup.storageScope} />
            </AccountThemeProvider>
          </ManagedBurrow>
        </OutboxProvider>
      </ScreenStripContext.Provider>
    </ManagedContext.Provider>
  );
}

/** Messages waiting in the outbox keep the connection in the background (AP-925). */
function OutboxHold({ holds }: { holds: Setup['holds'] }) {
  const waiting = useOutboxWaiting();
  useEffect(() => {
    holds.outbox = waiting;
  }, [holds, waiting]);
  return null;
}

/**
 * The burrow of this account on the appliance (its first membership, or the one a link opened, AP-366), then its
 * bootstrap. Another burrow is another app underneath (keyed), so its screens start afresh.
 */
function ManagedBurrow({ orgName, children }: { orgName: string | null; children: ReactNode }) {
  const me = useMe({});
  const [wanted, setWanted] = useState<string | null>(null);
  const memberships = me.data?.memberships;
  const membership = memberships ? pickBurrow(memberships, wanted) : null;
  const switchTo = useCallback(
    (slug: string) => {
      if (!memberships?.some((m) => m.burrowSlug === slug)) return false;
      setWanted(slug);
      return true;
    },
    [memberships],
  );
  if (!me.data)
    return (
      <Screen>
        {me.error ? (
          <ErrorState
            text="Your Whombat didn’t load. Try again in a moment."
            onRetry={() => void me.refetch()}
          />
        ) : (
          <StartHold>
            <Loading />
          </StartHold>
        )}
      </Screen>
    );
  if (!membership) return <FirstBurrow suggestedName={orgName} onCreated={() => void me.refetch()} />;
  return (
    <BurrowSwitchContext.Provider value={switchTo}>
      <BurrowProvider
        key={membership.burrowSlug}
        slug={membership.burrowSlug}
        mode="managed"
        clock={REAL_CLOCK}
        renderState={({ error, retry }) => (
          <Screen>
            {error ? (
              <ErrorState text="Your Whombat didn’t load. Try again in a moment." onRetry={retry} />
            ) : (
              <StartHold>
                <Loading />
              </StartHold>
            )}
          </Screen>
        )}
      >
        <LiveActivityBridge />
        <StatusWidgetBridge />
        {children}
      </BurrowProvider>
    </BurrowSwitchContext.Provider>
  );
}

/**
 * A freshly claimed Whombat has no burrow yet: you name one here (onboarding's step 1, the web's words; the other
 * steps — Set up your AI, Meet your agent — are the web's, Whombat one-agent.md OA-13; app AP-4963), starting with the
 * organization's name (AP-75). The tip is the agent's, Dusty until the Whombat exists.
 */
function FirstBurrow({ suggestedName, onCreated }: { suggestedName: string | null; onCreated: () => void }) {
  const { client } = useWhombat();
  const [name, setName] = useState(suggestedName?.trim() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.burrows.create({ body: { name: name.trim() } });
      onCreated();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 409 ? 'That name is already taken.' : 'That didn’t work. Try again.');
      setBusy(false);
    }
  };
  return (
    <Frame
      kicker={`STEP 1 OF ${ONBOARDING_STEP_COUNT}`}
      title="Name your Whombat"
      sub="This is where you and your assistant work. It shows at the top of the sidebar."
      tip={`Hi, I’m ${DEFAULT_AGENT_NAME}. I’ll stick around in case you get stuck.`}
    >
      <Field label="Its name" value={name} onChangeText={setName} autoCapitalize="words" maxLength={60} />
      <ErrorLine text={error} />
      <Button label="Continue" size="lg" busy={busy} disabled={!name.trim()} onPress={() => void create()} />
    </Frame>
  );
}

/** The first-use setup notice shares the ceremony's status, progress and result. */
interface PasskeyNudgeState {
  busy: boolean;
  label: string;
  disabled: boolean;
  said: string | null;
  add: () => void;
  later: () => void;
}

/**
 * Offer setup once per phone key and Whombat after this phone was let in another way. Completed setup or Not now
 * dismisses it. Null while it is hidden or this phone cannot use passkeys.
 */
function usePasskeyNudge({
  session,
  control,
  appliance,
  whombats,
  endpoint,
  open,
  me,
}: {
  session: ApplianceSession;
  /** Null on a community box: its passkeys don't go through control, so there's no nudge (AP-5470). */
  control: ControlApi | null;
  appliance: KnownAppliance;
  whombats: ManagedWhombats;
  endpoint: string;
  /** The session is open. */
  open: boolean;
  me: string | null;
}): PasskeyNudgeState | null {
  const due = !!PASSKEYS && !!control && open && PASSKEY_NUDGE.shows(appliance.device, endpoint);
  const [shown, setShown] = useState(false);
  const tap = useOnePasskeySetup(
    open && control && PASSKEYS
      ? {
          session,
          control,
          platform: PASSKEYS,
          appliance: appliance.peerId,
          me,
          name: passkeyName(phoneLabel()),
          whombats,
        }
      : null,
  );
  useEffect(() => {
    if (!due) return;
    let live = true;
    sessionOps.passkeysList(session).then(
      (list) => {
        if (!live) return;
        if (list.passkeys.some((p) => p.accountId === me)) PASSKEY_NUDGE.done(appliance.device, endpoint);
        else setShown(true);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [due, session, me, appliance.device, endpoint]);
  const phase = tap?.view?.phase;
  const checking = tap?.busy ?? false;
  useEffect(() => {
    if (phase !== 'ready' || checking) return;
    PASSKEY_NUDGE.done(appliance.device, endpoint);
    setShown(false);
  }, [phase, checking, appliance.device, endpoint]);
  if (!shown || !tap || !control) return null;
  return {
    busy: tap.busy,
    said: tap.note,
    label: tap.label,
    disabled: !tap.view && !tap.loadError,
    add: () => {
      void tap().then((result) => {
        if (result.complete) {
          PASSKEY_NUDGE.done(appliance.device, endpoint);
          setShown(false);
        }
      });
    },
    later: () => {
      PASSKEY_NUDGE.done(appliance.device, endpoint);
      setShown(false);
    },
  };
}

function PasskeyNudgeView({ nudge }: { nudge: PasskeyNudgeState }) {
  const theme = useTheme();
  const { busy, said } = nudge;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginTop: 4,
        marginHorizontal: 12,
        paddingLeft: 14,
        paddingRight: 4,
        paddingVertical: 4,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={13.5} lh={1.35} color={theme.colors.ink2} style={{ paddingVertical: 8 }}>
        {said ?? PASSKEY_COPY.nudge}
      </Text>
      <View style={{ flexDirection: 'row', gap: 4, justifyContent: 'flex-end' }}>
        <Button
          label={nudge.label}
          variant="secondary"
          busy={busy}
          disabled={nudge.disabled}
          onPress={nudge.add}
        />
        <Button label={PASSKEY_COPY.nudgeLater} variant="quiet" disabled={busy} onPress={nudge.later} />
      </View>
    </View>
  );
}

/**
 * The quiet strip under the status bar of every screen (`ScreenStripContext`): connection trouble (hidden for blips under 1.5 s and for rekeys),
 * a passing note (a tapped notification's item is gone), the subscription and the app's update. No kit reminder any
 * more: without a kit the box's screen lets a device back in (BX-01, AP-3526). Worked out once for the app (AP-931: the
 * subscription and the update check are asked here, not by every screen); `StripLine` only shows it.
 */
interface Strip {
  text: string;
  /** The border: the subscription's tone, or a warning when an app update is out. */
  tone: 'bad' | 'warn' | null;
  /**
   * “Try again” (connection trouble), “Update the app”, or, while Whombat Link ends or ended, “Turn on Tailscale” and
   * then Tailscale's sign-in (LNK-06a).
   */
  action: 'retry' | 'store' | 'tailscale' | 'tailscaleSignIn' | null;
  tailscale: { turnOn: () => void; signInUrl: string | null; busy: boolean };
}

function useStrip({
  state,
  session,
  updates,
  note,
}: {
  state: ConnectionState;
  session: ApplianceSession;
  /** Where a newer build of this app is announced: asked on every box, one reached directly too. */
  updates: AppUpdateSource;
  note: string | null;
}): Strip | null {
  const [shown, setShown] = useState(false);
  const trouble = state.status === 'reconnecting' && state.reason !== 'rekey';
  useEffect(() => {
    if (!trouble) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), 1500);
    return () => clearTimeout(t);
  }, [trouble]);
  const open = state.status === 'open';
  // Whombat Link ending or ended (LNK-06, LNK-06a): asked on session open and every ten minutes; what still works, and
  // Turn on Tailscale while it isn't on. The licence says nothing any more (LNK-04).
  const [reach, setReach] = useState<ReachGetOutput | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const ask = () =>
      readReach(session).then(
        (r) => live && setReach(r),
        () => {},
      );
    void ask();
    const timer = setInterval(() => void ask(), 10 * 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, session]);
  const tailscale = useTailscaleTurnOn(session);
  const linkBanner = open
    ? linkBannerView(reach && (tailscale.state ? { ...reach, tailscale: tailscale.state } : reach))
    : null;
  const banner = linkBanner ? { text: tailscale.note ?? linkBanner.text, tone: linkBanner.tone } : null;
  // Whether a newer build of this app is out (AP-701): asked as a session opens and back in front (AP-2971).
  const newer = useAppUpdate(updates, open) !== null;
  // Nothing left out silently (AP-266): items only a newer app can show, or a security view it can't read.
  const left = useSyncExternalStore(leftOut.subscribe, leftOut.get, leftOut.get);
  const leftOutText =
    state.status !== 'open'
      ? null
      : left.needsNewer
        ? PART_NEEDS_NEWER_APP
        : left.items > 0
          ? itemsNeedNewerApp(left.items)
          : null;
  const leftText = leftOutText && !newer ? `${leftOutText} ${COPY.update.soon}` : leftOutText;
  const text =
    trouble && shown && state.status === 'reconnecting'
      ? state.reason === 'offline'
        ? COPY.connection.offline
        : state.reason === 'appliance_offline'
          ? COPY.connection.applianceOffline
          : state.reason === 'appliance_unlisted'
            ? COPY.connection.unlisted
            : state.reason === 'busy'
              ? COPY.connection.busy
              : COPY.connection.reconnecting
      : note
        ? note
        : leftText
          ? leftText
          : banner
            ? banner.text
            : null;
  const leftShown = leftText !== null && text === leftText;
  // Without a newer app to get, the notice is calm: no warning border, nothing to tap (AP-701).
  const tone = banner && text === banner.text ? banner.tone : leftShown && newer ? 'warn' : null;
  const connection = !tone && text !== note && !leftShown;
  const bannerShown = banner !== null && text === banner.text;
  const action = connection
    ? 'retry'
    : newer && leftShown
      ? 'store'
      : bannerShown && tailscale.signInUrl
        ? 'tailscaleSignIn'
        : bannerShown && linkBanner?.tailscale && !tailscale.state
          ? 'tailscale'
          : null;
  const { turnOn, signInUrl, busy } = tailscale;
  return useMemo(
    () => (text ? { text, tone, action, tailscale: { turnOn, signInUrl, busy } } : null),
    [text, tone, action, turnOn, signInUrl, busy],
  );
}

function StripLine({ line, onRetry }: { line: Strip; onRetry: () => void }) {
  const theme = useTheme();
  // “Turn on Tailscale” is too long to sit beside the Link sentence on a phone: it goes under it.
  const below = line.action === 'tailscale';
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        marginTop: 4,
        marginHorizontal: 12,
        flexDirection: below ? 'column' : 'row',
        alignItems: below ? 'flex-start' : 'center',
        gap: below ? 2 : 10,
        paddingLeft: 14,
        paddingRight: 4,
        paddingBottom: below ? 8 : 0,
        minHeight: 48,
        borderRadius: 14,
        borderWidth: 1,
        borderColor:
          line.tone === 'bad'
            ? theme.colors.bad
            : line.tone === 'warn'
              ? theme.colors.warn
              : theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text
        size={13.5}
        lh={1.35}
        color={theme.colors.ink2}
        style={below ? { paddingTop: 10, paddingRight: 10 } : { flex: 1, paddingVertical: 8 }}
      >
        {line.text}
      </Text>
      {line.action === 'retry' ? (
        <Button label={COPY.connection.retry} variant="quiet" onPress={onRetry} />
      ) : line.action === 'store' ? (
        <StoreButton variant="quiet" />
      ) : line.action === 'tailscale' ? (
        // Link's actions are the one way in from away once it ends: a normal button, not the quiet one that looks off.
        <Button
          label={REACH_TEXT.tailscale.turnOn}
          variant="secondary"
          busy={line.tailscale.busy}
          onPress={line.tailscale.turnOn}
        />
      ) : line.action === 'tailscaleSignIn' ? (
        <Button
          label={TAILSCALE_TEXT.openSignIn}
          variant="secondary"
          onPress={() => void Linking.openURL(line.tailscale.signInUrl ?? '')}
        />
      ) : null}
    </View>
  );
}

function Gate({
  state,
  onSwitch,
  onSignOut,
  onSetUpAgain,
  onForget,
  hasOthers,
}: ApplianceRootProps & { state: ConnectionState }) {
  if (state.status !== 'closed') return null;
  const back = <Button label={COPY.connection.back} variant="secondary" size="lg" onPress={onSwitch} />;
  switch (state.reason) {
    case 'client_too_old':
      return <VersionGate who="client" back={back} />;
    case 'client_below_floor':
      // Below the appliance's security floor (CT-53): only a newer build of this app helps, from the store (AP-261).
      return (
        <GateScreen
          title={COPY.connection.belowFloorTitle}
          text={COPY.connection.belowFloor}
          actions={
            <>
              <StoreButton />
              {back}
            </>
          }
        />
      );
    case 'appliance_too_old':
      return <VersionGate who="appliance" back={back} />;
    case 'identity_mismatch':
      // What answered isn't the identity this phone pinned: the hard stop, never a new pin (AP-64).
      return <IdentityStopScreen stop="changed" onBack={onSwitch} onForget={onForget} />;
    case 'revoked':
      // A revoked key stays revoked (MA-04 §6): being let in again needs a new key (AP-39), as on the web.
      return (
        <GateScreen
          title={COPY.connection.revokedTitle}
          text={
            hasOthers
              ? `${COPY.connection.revoked} ${COPY.connection.revokedOthers}`
              : COPY.connection.revoked
          }
          actions={
            <>
              <SetUpAgain onSetUpAgain={onSetUpAgain} />
              <Button
                label={COPY.recover.entry}
                variant="secondary"
                size="lg"
                onPress={() => void onSetUpAgain('recover')}
              />
              {back}
            </>
          }
        />
      );
    case 'ticket_denied':
      return (
        <GateScreen
          title={COPY.connection.signedOutTitle}
          text={COPY.connection.signedOut}
          actions={<Button label={COPY.connection.signIn} size="lg" onPress={onSignOut} />}
        />
      );
    default:
      // `not_enrolled` goes to pairing at once, a retired or departed Whombat to the list (AP-696); `closed` is this
      // app's own doing.
      return (
        <Screen>
          <Loading />
        </Screen>
      );
  }
}

/** “Update the app” (AP-261): the app updates itself where it can (AP-813), else the Mobile app page (AP-537). */
function StoreButton({ variant = 'primary' }: { variant?: 'primary' | 'quiet' }) {
  return variant === 'primary' ? <UpdateAppButton size="lg" withNote /> : <UpdateAppButton variant="quiet" />;
}

function SetUpAgain({ onSetUpAgain }: { onSetUpAgain: (then: 'pair') => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label={busy ? COPY.connection.settingUp : COPY.connection.setUpAgain}
      size="lg"
      busy={busy}
      onPress={() => {
        setBusy(true);
        onSetUpAgain('pair').catch(() => setBusy(false));
      }}
    />
  );
}
