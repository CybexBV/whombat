/**
 * The phone app (AP-27), mirroring the web's `ManagedRoot`:
 * cloud sign-in by the computer's QR code (AP-530: one scan signs in and asks the Whombat open there to let this
 * phone in) or by magic link (the link `<ui>/auth/verify#token=…` opens the app; its token is exchanged exactly
 * once), the first-run organization, the appliance list, claim, pairing, the recovery kit from This Whombat — and once an appliance
 * is open and this phone is trusted there, the regular app over an end-to-end session with it (`ApplianceRoot`).
 * Notification taps are held until an appliance is open, then resolved through its session.
 */
import {
  APPLIANCE_TERMS_VERSION,
  type ApplianceRegistry,
  type ApplianceSummary,
  androidDownloadUrl,
  type ClaimCard,
  type ClaimRequest,
  type ControlSession,
  claimAppliance,
  claimErrorText,
  clearPush,
  createRegistry,
  deleteAccountErrorKey,
  forgetAppliance,
  forgetEnrollments,
  type GoneReason,
  goneNotice,
  isNotNearby,
  isRetired,
  type KnownAppliance,
  letInAlready,
  looksNearbyFirst,
  type NearbyClaimStep,
  nearbyClaimStep,
  openDecision,
  PASSKEY_COPY,
  PasskeyError,
  type PasskeySignInOutcome,
  type PhoneSignInLink,
  pairingFingerprint,
  passkeyErrorOf,
  passkeySignIn,
  pinnedRecord,
  recoverAppliance,
  renameErrorText,
  type SetupLink,
  screenSignedInRecord,
  screenSignInPeer,
  trustDecision,
  verifyOnce,
} from '@whombat/client/managed';
import { useDirectoryEntry, useLeaveWhenGone, useOpenWhenLetIn } from '@whombat/client/managed/react';
import {
  type ApplianceSession,
  ConnectError,
  createSecureSession,
  sessionOps,
} from '@whombat/client/session';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, Linking } from 'react-native';
import { WhombatLive } from '../../modules/whombat-live';
import { WhombatUpdater } from '../../modules/whombat-updater';
import { QUERY_CACHE_NAME } from '../data/queryPersist';
import { deviceBox } from '../data/secureBoxNative';
import { LookAround } from '../demo/LookAround';
import {
  clearCloudStatusWidget,
  clearDepartingStatusWidget,
  switchActiveAppliance,
} from '../live/statusWidget';
import { prefetchNavigation } from '../navigation/useNavigationPersistence';
import { phoneNotifications } from '../push/phoneNotifications';
import { initialNotificationUrl, onNotificationTap } from '../push/taps';
import { Screen } from '../ui/headers';
import { Button, Loading } from '../ui/primitives';
import { StartHold } from '../ui/StartHold';
import { ApplianceRoot, storageScopeOf } from './ApplianceRoot';
import { AppUpdatePrompt } from './AppUpdatePrompt';
import { BringBackFlow } from './BringBack';
import {
  CommunityApp,
  type CommunityRoute,
  FirstScreenUpdate,
  JoinStartScreen,
  knownCommunityBoxes,
} from './CommunityApp';
import { ConnectAiScreen } from './ConnectAi';
import { awaitSession, type CloudSessionStore, cloudSessionStore } from './cloudSession';
import { COMMUNITY_REGISTRY, PHONE_COMMUNITY_TEXT } from './community';
import { APP_BUILD, CONTROL_URL, UI_ORIGINS } from './config';
import { asStarted, finishingDevice, pushConnectReturn, takeHeldConnect } from './connectReturn';
import { createLinkBus, createPushTaps, sendLink } from './context';
import { COPY } from './copy';
import {
  createMobileEnvironment,
  type EndpointKey,
  loadEndpointKey,
  type ManagedEnvironment,
  PHONE_PLATFORM,
  phoneClient,
  phoneLabel,
  replaceEndpointKey,
} from './env';
import { documentTextFile } from './expoStores';
import { appUrl, type IncomingLink } from './incoming';
import type { KitPrinter } from './KitWays';
import { PhoneProgressScreen } from './PhoneSignInScreens';
import { PASSKEY_NUDGE, PASSKEYS } from './passkeyEnv';
import {
  type HandoffDeps,
  type PhoneHandoff,
  type PhoneSignInError,
  type PhoneSignInView,
  redeemErrorOf,
  redeemPhoneToken,
  runPhoneHandoff,
} from './phoneSignIn';
import { ScreenSignInSteps } from './ScreenSignInScreens';
import {
  AppliancesScreen,
  ClaimCardScreen,
  ClaimFoundScreen,
  ClaimLookingScreen,
  ClaimNoneScreen,
  ClaimPickScreen,
  CreateOrgScreen,
  DeleteAccountScreen,
  GateScreen,
  type IdentityStop,
  IdentityStopScreen,
  type KitInput,
  type KitPicker,
  type KitSaver,
  PairScreen,
  PasskeyProgressScreen,
  PasskeyStopScreen,
  RecoverScreen,
  RecoveryKitScreen,
  SetupScreen,
  SignInScreen,
  VerifyScreen,
} from './screens';
import { secureStore } from './secureStore';
import { preloadedStorage } from './stores';
import { pushStore } from './usePush';

type Route =
  | { name: 'appliances' }
  /** `found`: what the empty list just found on this network (AP-75), shown without asking again. */
  | { name: 'claim'; card?: ClaimCard; found?: NearbyClaimStep }
  /**
   * Right after the claim: “Is this a new Whombat?” — Start fresh goes on to `ai`, Bring back brings an earlier
   * Whombat back from its backups (backup-options-android.md AP-6859) and then opens it.
   */
  /** Bringing a Whombat back: after the claim, or from the app's Backups (`later`: where it stands, or replacing). */
  | { name: 'restore'; device: string; later?: 'resume' | 'replace' }
  /**
   * The claim's last step, Connect your AI (Whombat first-day.md), then the Whombat. Where backups go isn't asked:
   * Needs you proposes a place (no kit step either, BX-01, AP-3525).
   */
  | { name: 'ai'; device: string }
  /** A recovery kit made from This Whombat (BX-01): back to it afterwards. */
  | { name: 'kit'; device: string }
  | { name: 'pair'; device: string }
  | { name: 'recover'; device: string }
  /** An add-a-device link: checked against the pin and the directory first (AP-64). */
  | { name: 'link'; link: SetupLink }
  /** This phone doesn't know the Whombat: the ways to set it up (AP-64). */
  | { name: 'setup'; device: string }
  /** “Use its screen” (BX-02, AP-3530): the box shows a code for this phone; `back` is where it was asked from. */
  | { name: 'screen'; device: string; back: 'pair' | 'setup' }
  /** The pin and the directory disagree: the hard stop (AP-64). */
  | { name: 'identityChanged'; device: string }
  /** Deleting the cloud account (CT-78, AP-73). */
  | { name: 'deleteAccount' }
  /** After a scan of the computer's QR code: let this phone in to the Whombat it names (AP-530). */
  | { name: 'phone'; handoff: PhoneHandoff }
  | { name: 'open' };

/** Where the signed-in tree starts after a new key remounts it (the recovery kit instead of pairing, AP-41). */
const pendingRoute = (() => {
  let value: Route | null = null;
  return {
    set: (r: Route | null) => {
      value = r;
    },
    take: () => {
      const r = value;
      value = null;
      return r;
    },
  };
})();

let registryStorage: ReturnType<typeof preloadedStorage> | null = null;
/** The registry's file, read once per app run. */
function storage() {
  registryStorage ??= preloadedStorage(documentTextFile('whombat-appliances.json'));
  return registryStorage;
}

/** The recovery kit's text through the share sheet (Files, a drive, print); the temporary copy goes afterwards. */
const shareSheetSaver: KitSaver = {
  async save(fileName, text) {
    const file = new File(Paths.cache, fileName);
    if (file.exists) file.delete();
    file.create();
    file.write(text);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/plain',
      dialogTitle: COPY.kit.title,
      UTI: 'public.plain-text',
    });
  },
  discard() {
    try {
      for (const entry of Paths.cache.list())
        if (entry instanceof File && entry.name.startsWith('whombat-recovery-kit-')) entry.delete();
    } catch {
      // already gone
    }
  },
};

/**
 * The kit's print page through the share sheet (backup-options-android.md AP-6857): a browser or a printer app opens the
 * HTML and prints it; the temporary copy goes with the kit's other files (`shareSheetSaver.discard`).
 */
const shareSheetPrinter: KitPrinter = {
  async print(fileName, html) {
    const file = new File(Paths.cache, fileName);
    if (file.exists) file.delete();
    file.create();
    file.write(html);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/html',
      dialogTitle: COPY.kit.title,
      UTI: 'public.html',
    });
  },
};

/** What the app starts loading before its first screen (`startManagedApp`). */
interface ManagedStart {
  env: ManagedEnvironment;
  /** The session kept for the next start (AP-921). */
  kept: CloudSessionStore;
  /** Control's answer about the cloud session: null is signed out; a rejection is no answer. */
  check: Promise<ControlSession | null>;
  /** The kept session, and once it is read, `keptNow`. */
  cached: Promise<ControlSession | null>;
  keptNow?: ControlSession | null;
  /** This phone's key, and once it is loaded, `keyNow`. */
  key: Promise<EndpointKey>;
  keyNow?: EndpointKey;
}

let started: ManagedStart | null = null;

/**
 * Starts what the first screen needs (AP-920), called by App.tsx while the fonts load: control's answer about the cloud
 * session, the session kept from the last run, this phone's key, and — for the Whombat the app will open with that
 * session — its last-seen burrow, saved place and what it can do (AP-2642), read ahead in the secure box. Once per
 * process.
 */
export function startManagedApp(): ManagedStart {
  if (started) return started;
  const env = createMobileEnvironment();
  // A newer app is looked for while the app isn't open too, and notified (update-check.md).
  if (PHONE_PLATFORM === 'android') WhombatUpdater.watchUpdates(androidDownloadUrl(CONTROL_URL));
  const kept = cloudSessionStore(secureStore);
  const check = env.control.session();
  const key = loadEndpointKey();
  // Both are handled where they are awaited.
  check.catch(() => {});
  key.catch(() => {});
  const s: ManagedStart = { env, kept, check, cached: kept.get(), key };
  void s.cached.then((cloud) => {
    s.keptNow = cloud;
    if (cloud) readAhead(cloud);
  });
  void key.then(
    (k) => {
      s.keyNow = k;
    },
    () => {},
  );
  started = s;
  return s;
}

/** The Whombat the app will open (the last used, this phone let in): its sealed data starts loading now (AP-920). */
function readAhead(cloud: ControlSession) {
  const org = cloud.orgs[0];
  if (!org) return;
  try {
    const registry = createRegistry(cloud.account.accountId, storage());
    const last = registry.lastUsed();
    const known = last ? registry.get(last) : undefined;
    if (!known?.enrolled) return;
    const scope = storageScopeOf(org.orgId, known.device);
    deviceBox().prefetch(scope, QUERY_CACHE_NAME);
    prefetchNavigation(scope);
  } catch {
    // Read when the Whombat opens.
  }
}

/** The pop-up for a newer app, over whatever screen is open (App.tsx draws it beside the app). */
export function ManagedUpdatePrompt() {
  return <AppUpdatePrompt control={startManagedApp().env.control} />;
}

export function ManagedApp() {
  const start = useMemo(() => startManagedApp(), []);
  const env = start.env;
  /**
   * Community Whombats this phone joined with a link (AP-5471): no cloud account, so a registry of their own. The last
   * one used opens at start, before control answers (it has nothing to say about them).
   */
  const communityRegistry = useMemo(() => createRegistry(COMMUNITY_REGISTRY, storage()), []);
  const [community, setCommunity] = useState<CommunityRoute | null>(() => {
    const last = communityRegistry.lastUsed();
    return last && communityRegistry.get(last)?.enrolled ? { name: 'open' } : null;
  });
  // The session kept from the last run first (AP-921), while control is asked. `unreachable`: control didn't answer at
  // start and nothing was kept — the saved sign-in stays; this is not a sign-out.
  const [cloud, setCloud] = useState<ControlSession | null | 'loading' | 'unreachable'>(
    () => start.keptNow ?? 'loading',
  );
  const [key, setKey] = useState<EndpointKey | null | 'error'>(() => start.keyNow ?? null);
  /** The person chose “Sign in with a Whombat account” on the first screen. */
  const [cloudSignIn, setCloudSignIn] = useState(false);
  // The demo world from the first screen (look-around.md); Leave comes back here.
  const [lookAround, setLookAround] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const taps = useMemo(() => createPushTaps(), []);
  const [tapped, setTapped] = useState(0);
  /** A link that sets this phone up, a claim link, or a link naming an appliance (MR-45). */
  const [linkIn, setLinkIn] = useState<IncomingLink | null>(null);
  const links = useMemo(() => createLinkBus(), []);
  /** A scanned (or opened) sign-in code while its token is exchanged, or what went wrong (AP-530). */
  const [phone, setPhone] = useState<{
    link: PhoneSignInLink;
    attempt: number;
    error: PhoneSignInError | null;
  } | null>(null);
  /** The exchanged code, until the signed-in tree takes it (it survives that tree's remount for a new account). */
  const [handoff, setHandoff] = useState<PhoneHandoff | null>(null);
  /** Back from a failed scan by “Sign in with email instead”. */
  const [emailFirst, setEmailFirst] = useState(false);
  /** A passkey sign-in (PK-04, AP-799): the Whombat it opens while it is asked, and where it ended. */
  const [passkeyOpening, setPasskeyOpening] = useState<{ name: string | null } | null>(null);
  const [passkeyStop, setPasskeyStop] = useState<Extract<PasskeySignInOutcome, { kind: 'setup' }> | null>(
    null,
  );
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);
  /** Bumped after a passkey sign-in: the signed-in tree starts again on the route it chose. */
  const [passkeyEpoch, setPasskeyEpoch] = useState(0);
  const signOutTasks = useRef(new Set<(s: ApplianceSession | null) => Promise<void>>());

  /** Bumped when a sign-in (a scanned code, a passkey, a link) sets the session: an older answer mustn't undo that. */
  const cloudEpoch = useRef(0);
  /** Control's last answer about the session didn't come (offline, a timeout): asked again back in the app (AP-921). */
  const noAnswer = useRef(false);
  /**
   * Control's answer about the session (AP-921, AP-922): its session, or a definite signed-out. No answer (offline, a
   * timeout, control down) keeps a session that is shown; without one it is “Couldn’t reach Whombat”.
   */
  const askCloud = useCallback((answer: Promise<ControlSession | null>) => {
    const epoch = ++cloudEpoch.current;
    return awaitSession(answer, {
      answered(s) {
        if (epoch !== cloudEpoch.current) return;
        noAnswer.current = false;
        setCloud(s);
      },
      unreachable() {
        if (epoch !== cloudEpoch.current) return;
        noAnswer.current = true;
        setCloud((c) => (c && typeof c === 'object' ? c : 'unreachable'));
      },
    });
  }, []);
  const loadCloud = useCallback(() => {
    setCloud('loading');
    askCloud(env.control.session());
  }, [env, askCloud]);
  useEffect(() => {
    const stop = askCloud(start.check);
    const epoch = cloudEpoch.current;
    // The kept session, once read (when it wasn't by the first render), unless control answered first.
    void start.cached.then((c) => {
      if (c && epoch === cloudEpoch.current)
        setCloud((now) => (now === 'loading' || now === 'unreachable' ? c : now));
    });
    start.key.then(setKey, () => setKey('error'));
    return stop;
  }, [start, askCloud]);
  // The session for the next start: kept while signed in, forgotten on a definite signed-out (AP-921).
  const prevAccountId = useRef<string | null>(null);
  useEffect(() => {
    if (cloud === null) {
      prevAccountId.current = null;
      void start.kept.clear();
      void clearCloudStatusWidget(WhombatLive);
    } else if (typeof cloud === 'object') {
      const nextAccountId = cloud.account.accountId;
      if (prevAccountId.current && prevAccountId.current !== nextAccountId) {
        void clearCloudStatusWidget(WhombatLive);
      }
      prevAccountId.current = nextAccountId;
      void start.kept.set(cloud);
    }
  }, [cloud, start]);
  // Opened with the kept session and control didn't answer: asked again on coming back to the app.
  const signedInNow = cloud !== null && typeof cloud === 'object';
  useEffect(() => {
    if (!signedInNow) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && noAnswer.current) askCloud(env.control.session());
    });
    return () => sub.remove();
  }, [signedInNow, env, askCloud]);

  const startPhone = useCallback((link: PhoneSignInLink) => {
    setHandoff(null);
    setEmailFirst(false);
    setPhone((p) => ({ link, attempt: (p?.attempt ?? 0) + 1, error: null }));
  }, []);

  // Links into the app: a magic link or the computer's sign-in code (signed in or not), a link for the signed-in
  // tree, or a tapped notification (held until an appliance is open).
  const onUrl = useCallback(
    (url: string | null) => {
      if (!url) return;
      const got = appUrl(url, UI_ORIGINS);
      if (!got) return;
      if (got.kind === 'magic') {
        setVerifyError(null);
        setVerifying(got.token);
      } else if (got.kind === 'phone') startPhone(got.link);
      else if (got.kind === 'link') setLinkIn(got.link);
      else {
        taps.push(got.tap);
        setTapped((n) => n + 1);
      }
    },
    [taps, startPhone],
  );
  useEffect(() => {
    phoneNotifications.showWhileOpen();
    void Linking.getInitialURL().then(onUrl);
    onUrl(WhombatLive.launchPushTap());
    void initialNotificationUrl().then(onUrl);
    const sub = Linking.addEventListener('url', ({ url }) => {
      // Push taps while an appliance is open reach RootNavigator's linking too; the bus hands them over once.
      onUrl(url);
    });
    const offFcm = WhombatLive.onPushTap(onUrl);
    const offIos = onNotificationTap(onUrl);
    return () => {
      sub.remove();
      offFcm();
      offIos();
    };
  }, [onUrl]);

  // One request per one-use token, however often this runs.
  useEffect(() => {
    if (!verifying) return;
    let live = true;
    verifyOnce(env, verifying).then(
      (s) => {
        if (!live) return;
        cloudEpoch.current++;
        noAnswer.current = false;
        setCloud(s);
        setVerifying(null);
      },
      () => live && setVerifyError(COPY.signIn.badLink),
    );
    return () => {
      live = false;
    };
  }, [verifying, env]);

  // The code's token becomes this phone's cloud session (once per token); another account's replaces the one here.
  const redeeming = phone && !phone.error ? phone : null;
  useEffect(() => {
    if (!redeeming) return;
    let live = true;
    const { link } = redeeming;
    redeemPhoneToken(env.control, link.token).then(
      ({ session, handoffId }) => {
        if (!live) return;
        cloudEpoch.current++;
        noAnswer.current = false;
        setVerifying(null);
        if (session.orgs.length > 0) setHandoff({ handoffId, key: link.key, appliance: link.appliance });
        // No organization yet: nothing to let in; the computer stops waiting.
        else void env.control.reportPhoneHandoff(handoffId, { kind: 'signed_in' }).catch(() => {});
        setCloud(session);
        setPhone(null);
      },
      (e) => live && setPhone((p) => (p === redeeming ? { ...p, error: redeemErrorOf(e) } : p)),
    );
    return () => {
      live = false;
    };
  }, [redeeming, env]);

  const signOut = useCallback(async () => {
    // The kept session goes first: a sign-out cut short doesn't open signed in next time (AP-921).
    void start.kept.clear();
    const capped = (work: Promise<void>) =>
      Promise.race([work.catch(() => {}), new Promise<void>((ok) => setTimeout(ok, 3000))]);
    await Promise.all([...signOutTasks.current].map((t) => capped(t(null))));
    // Also from the appliance list (no session at hand): control forgets this install's push handle.
    await capped(clearPush(env.control, pushStore));
    await capped(phoneNotifications.endAll());
    await capped(clearCloudStatusWidget(WhombatLive));
    await capped(env.control.signOut());
    setCloud(null);
  }, [env, start]);

  // Set up again after this phone was removed (AP-39): the revoked key is discarded and a new one made.
  const rekey = useCallback(async () => {
    setKey(await replaceEndpointKey());
  }, []);

  const runPasskey = useCallback(async () => {
    if (!key || key === 'error') return;
    let outcome: PasskeySignInOutcome;
    try {
      outcome = await phonePasskeySignIn(env, key, (name) => setPasskeyOpening({ name }));
    } catch (error) {
      // Its Whombat is gone: the next Whombat this phone opens offers a new passkey. One kept for that Whombat's
      // recovery kit (`kept`) says so and stays on the phone: only `gone` tells the platform to forget a passkey.
      const code = passkeyErrorOf(error);
      if (code === 'gone' || code === 'kept') PASSKEY_NUDGE.owe();
      throw error;
    } finally {
      setPasskeyOpening(null);
    }
    cloudEpoch.current++;
    noAnswer.current = false;
    setPasskeyNote(null);
    setVerifying(null);
    switch (outcome.kind) {
      case 'open':
        pendingRoute.set({ name: 'open' });
        break;
      case 'changed':
        pendingRoute.set({ name: 'identityChanged', device: outcome.device });
        break;
      case 'setup':
        setPasskeyStop(outcome);
        pendingRoute.set({ name: 'appliances' });
        break;
      case 'not_in_org':
        setPasskeyNote(PASSKEY_COPY.notInOrg);
        pendingRoute.set({ name: 'appliances' });
        break;
      case 'retired':
        PASSKEY_NUDGE.owe();
        setPasskeyNote(PASSKEY_COPY.retired(outcome.name));
        pendingRoute.set({ name: 'appliances' });
        break;
      default:
        pendingRoute.set({ name: 'appliances' });
    }
    if (outcome.kind !== 'open') void clearCloudStatusWidget(WhombatLive);
    setCloud(outcome.session);
    setPasskeyEpoch((n) => n + 1);
  }, [env, key]);
  const restartSignedIn = (route: Route) => {
    pendingRoute.set(route);
    setPasskeyStop(null);
    setPasskeyEpoch((n) => n + 1);
  };

  const addSignOutTask = useCallback((task: (s: ApplianceSession | null) => Promise<void>) => {
    signOutTasks.current.add(task);
    return () => {
      signOutTasks.current.delete(task);
    };
  }, []);

  const signedIn = cloud !== null && typeof cloud === 'object';
  if (phone)
    return (
      <PhoneProgressScreen
        view={
          phone.error
            ? { kind: 'failed', stage: 'signingIn', error: phone.error }
            : { kind: 'working', stage: 'signingIn' }
        }
        signedIn={signedIn}
        onLink={startPhone}
        onAction={(action) => {
          if (action === 'retry') return setPhone({ ...phone, attempt: phone.attempt + 1, error: null });
          setEmailFirst(action === 'email');
          // A computer's sign-in code was this person's way: go on with the cloud sign-in, not the first screen.
          setCloudSignIn(true);
          setPhone(null);
        }}
      />
    );
  if (verifying && (cloud === 'loading' || cloud === 'unreachable' || !cloud || verifyError))
    return (
      <VerifyScreen
        error={verifyError}
        onBack={() => {
          setVerifying(null);
          setVerifyError(null);
        }}
      />
    );
  if (passkeyOpening) return <PasskeyProgressScreen name={passkeyOpening.name} />;
  if (passkeyStop && signedIn) {
    const stop = passkeyStop;
    return (
      <PasskeyStopScreen
        text={PASSKEY_COPY.errors[stop.reason]}
        onOtherWay={() => restartSignedIn({ name: 'pair', device: stop.known.device })}
        onBack={() => restartSignedIn({ name: 'appliances' })}
      />
    );
  }
  if (community && key && key !== 'error')
    return (
      <CommunityApp
        key={key.peerId}
        env={env}
        keyPair={key}
        registry={communityRegistry}
        start={community}
        onLeave={() => setCommunity(null)}
        rekey={rekey}
        taps={taps}
        links={links}
        addSignOutTask={addSignOutTask}
      />
    );
  if (cloud === 'loading' || key === null)
    return (
      <StartHold>
        <Screen>
          <Loading />
        </Screen>
      </StartHold>
    );
  // Community boxes need no cloud account (AP-5471): offered on the first screen, and beside “Couldn’t reach Whombat”.
  const communityEntry = {
    boxes: knownCommunityBoxes(communityRegistry),
    onOpen: (device: string) => {
      switchActiveAppliance(communityRegistry, WhombatLive, device);
      void clearCloudStatusWidget(WhombatLive);
      setCommunity({ name: 'open' });
    },
    onJoin: () => setCommunity({ name: 'join' }),
    onLink: (link: Extract<CommunityRoute, { name: 'link' }>['link']) => setCommunity({ name: 'link', link }),
    onAddress: (address: Extract<CommunityRoute, { name: 'address' }>['address']) =>
      setCommunity({ name: 'address', address }),
  };
  if (cloud === 'unreachable')
    return (
      <GateScreen
        title={COPY.signIn.title}
        text={COPY.signIn.unreachable}
        actions={
          <>
            <Button label="Try again" size="lg" onPress={loadCloud} />
            <Button
              label={PHONE_COMMUNITY_TEXT.signIn.joinLink}
              variant="quiet"
              onPress={communityEntry.onJoin}
            />
          </>
        }
      />
    );
  if (key === 'error')
    return <GateScreen title={COPY.connection.signedOutTitle} text={COPY.connection.unsupported} />;
  // A new install starts with “Join a Whombat” (LNK-44): no cloud sign-in is needed to use one. A phone signed in
  // through the cloud kept its session and never sees this; signing in that way stays one tap away.
  if (!cloud && !cloudSignIn && lookAround) return <LookAround onLeave={() => setLookAround(false)} />;
  if (!cloud && !cloudSignIn)
    return (
      <JoinStartScreen
        // An old build is told here too, before it claims or joins anything.
        notice={<FirstScreenUpdate control={env.control} />}
        boxes={communityEntry.boxes}
        onOpen={communityEntry.onOpen}
        onLink={communityEntry.onLink}
        onAddress={communityEntry.onAddress}
        onSignIn={() => setCloudSignIn(true)}
        onLookAround={() => setLookAround(true)}
      />
    );
  if (!cloud)
    return (
      <SignInScreen
        key={emailFirst ? 'email' : 'scan'}
        initialMode={emailFirst ? 'email' : 'scan'}
        onSend={(email) => env.control.requestSignInLink(email)}
        onPhoneLink={startPhone}
        {...(PASSKEYS && { onPasskey: runPasskey })}
        community={communityEntry}
      />
    );
  const org = cloud.orgs[0];
  if (!org)
    return (
      <CreateOrgScreen
        onJoin={() => setCommunity({ name: 'join' })}
        onDone={loadCloud}
        onSignOut={() => void signOut()}
      />
    );
  return (
    <SignedIn
      // Another account or a new key (set up again) starts afresh (its first route comes from the registry).
      key={`${cloud.account.accountId}|${key.peerId}|${passkeyEpoch}`}
      env={env}
      cloud={cloud}
      orgId={org.orgId}
      keyPair={key}
      taps={taps}
      tapped={tapped}
      signOut={() => void signOut()}
      addSignOutTask={addSignOutTask}
      rekey={rekey}
      linkIn={linkIn}
      onLinkTaken={() => setLinkIn(null)}
      links={links}
      handoff={handoff}
      onHandoffTaken={() => setHandoff(null)}
      onPhoneLink={startPhone}
      note={passkeyNote}
      onNoteSeen={() => setPasskeyNote(null)}
      {...(PASSKEYS && { onPasskey: runPasskey })}
    />
  );
}

/** PK-04 on the phone: the shared flow with Credential Manager, this phone's key and label, and its registry file. */
function phonePasskeySignIn(
  env: ManagedEnvironment,
  keyPair: EndpointKey,
  onOpening: (name: string | null) => void,
): Promise<PasskeySignInOutcome> {
  if (!PASSKEYS) return Promise.reject(new PasskeyError('unsupported'));
  return passkeySignIn({
    control: env.control,
    platform: PASSKEYS,
    endpoint: { peerId: keyPair.peerId, label: phoneLabel(), platform: PHONE_PLATFORM },
    registryFor: (accountId) => {
      const reg = createRegistry(accountId, storage());
      return {
        ...reg,
        setLastUsed: (device) => switchActiveAppliance(reg, WhombatLive, device),
      };
    },
    openEnroll: (t) => openEnrollSession(env, keyPair, t),
    onStep: (step, appliance) => {
      if (step === 'opening') onOpening(appliance?.name ?? null);
    },
  });
}

function SignedIn({
  env,
  cloud,
  orgId,
  keyPair,
  taps,
  tapped,
  signOut,
  addSignOutTask,
  rekey,
  linkIn,
  onLinkTaken,
  links,
  handoff,
  onHandoffTaken,
  onPhoneLink,
  note,
  onNoteSeen,
  onPasskey,
}: {
  env: ManagedEnvironment;
  cloud: ControlSession;
  orgId: string;
  keyPair: EndpointKey;
  taps: ReturnType<typeof createPushTaps>;
  tapped: number;
  signOut: () => void;
  addSignOutTask: (task: (s: ApplianceSession | null) => Promise<void>) => () => void;
  rekey: () => Promise<void>;
  linkIn: IncomingLink | null;
  onLinkTaken: () => void;
  links: ReturnType<typeof createLinkBus>;
  /** A scanned sign-in code, exchanged: this tree starts with it (AP-530). */
  handoff: PhoneHandoff | null;
  onHandoffTaken: () => void;
  /** A code scanned here (pairing, “Scan again”): exchanged above, then back here as `handoff`. */
  onPhoneLink: (link: PhoneSignInLink) => void;
  /** What the list says after a passkey that couldn't open a Whombat. */
  note: string | null;
  onNoteSeen: () => void;
  /** “Use a passkey” on Set up this device (PK-04): the same sign-in as the signed-out screen. */
  onPasskey?: () => Promise<void>;
}) {
  const registry = useMemo(
    () => createRegistry(cloud.account.accountId, storage()),
    [cloud.account.accountId],
  );
  const [route, setRoute] = useState<Route>(() => {
    if (handoff) return { name: 'phone', handoff };
    const pending = pendingRoute.take();
    if (pending) return pending;
    const last = registry.lastUsed();
    const known = last ? registry.get(last) : undefined;
    if (!known) return { name: 'appliances' };
    return known.enrolled ? { name: 'open' } : { name: 'pair', device: known.device };
  });
  const [appliances, setAppliances] = useState<ApplianceSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [, bump] = useState(0);

  const refresh = useCallback(() => {
    env.control.appliances(orgId).then(
      (list) => {
        setAppliances(list);
        setListError(null);
      },
      () => setListError(COPY.signIn.unreachable),
    );
  }, [env, orgId]);
  useEffect(() => {
    if (route.name === 'appliances') refresh();
  }, [route.name, refresh]);

  const rename = async (a: ApplianceSummary, name: string): Promise<string | null> => {
    try {
      const named = await env.control.renameAppliance({ orgId, device: a.device, name });
      setAppliances((list) => list?.map((x) => (x.device === named.device ? named : x)) ?? list);
      const known = registry.get(named.device);
      if (known) registry.put({ ...known, name: named.name });
      return null;
    } catch (e) {
      return renameErrorText(e);
    }
  };

  // Why the list opened in place of a Whombat (AP-696): shown until the list is left.
  const [gone, setGone] = useState<{ device: string; reason: GoneReason; name: string | null } | null>(null);
  useEffect(() => {
    if (route.name !== 'appliances') setGone(null);
  }, [route.name]);
  // Once the list is there, by the directory's name (a Whombat claimed here has none in this phone's record).
  const notice =
    gone && (appliances || listError)
      ? goneNotice(gone.reason, appliances?.find((a) => a.device === gone.device)?.name ?? gone.name)
      : note;
  const noteSeen = useRef(onNoteSeen);
  noteSeen.current = onNoteSeen;
  useEffect(() => {
    if (route.name !== 'appliances') noteSeen.current();
  }, [route.name]);
  /**
   * A Whombat that can't be opened any more (AP-696): retired, or not this organization's. It isn't reopened by itself
   * (the last used is cleared; the record stays, so the list shows a retired one until it's forgotten), and the list
   * says why.
   */
  const leave = useCallback(
    (device: string, reason: GoneReason, name: string | null) => {
      if (registry.lastUsed() === device) registry.setLastUsed(null);
      void WhombatLive.clearStatusWidget(device).catch(() => {});
      setGone({ device, reason, name });
      setRoute({ name: 'appliances' });
    },
    [registry],
  );

  // No Whombats yet: look for one on this network before showing the empty list, and claim it straight away when
  // there is one (AP-75). Once per visit; what was found goes to the claim, so it doesn't ask again.
  const org = cloud.orgs.find((o) => o.orgId === orgId);
  const lookedNearby = useRef(false);
  const [lookingNearby, setLookingNearby] = useState(false);
  const routeNow = useRef(route.name);
  routeNow.current = route.name;
  useEffect(() => {
    if (route.name !== 'appliances' || lookedNearby.current || !looksNearbyFirst(appliances)) return;
    lookedNearby.current = true;
    setLookingNearby(true);
    env.control
      .nearbyClaims(orgId)
      .then(
        (boxes) => {
          if (boxes.length > 0 && routeNow.current === 'appliances')
            setRoute({ name: 'claim', found: nearbyClaimStep(boxes) });
        },
        // Not found or not reachable: the list says how to claim one.
        () => {},
      )
      .finally(() => setLookingNearby(false));
  }, [route.name, appliances, env, orgId]);

  // A notification tapped while no appliance is open: open the last one used (its session resolves the tap).
  useEffect(() => {
    if (tapped === 0 || route.name === 'open') return;
    const last = registry.lastUsed();
    const known = last ? registry.get(last) : undefined;
    if (known?.enrolled) setRoute({ name: 'open' });
  }, [tapped, route.name, registry]);

  /** This phone forgets a Whombat: its record, push handle and any home-screen widget status. */
  const forgetHere = useCallback(
    (device: string) => {
      registry.remove(device);
      // Only tidying the local list: a keystore that refuses changes nothing (AP-594).
      void forgetAppliance(pushStore, device).catch(() => {});
      void WhombatLive.clearStatusWidget(device).catch(() => {});
    },
    [registry],
  );
  /** Forget a Whombat on this phone (the way out of a hard stop), then the list. */
  const forget = useCallback(
    (device: string) => {
      forgetHere(device);
      setRoute({ name: 'appliances' });
    },
    [forgetHere],
  );

  // The computer's code, exchanged (at mount, or while this tree was open for the same account).
  const handoffTaken = useRef(onHandoffTaken);
  handoffTaken.current = onHandoffTaken;
  useEffect(() => {
    if (!handoff) return;
    handoffTaken.current();
    setRoute({ name: 'phone', handoff });
  }, [handoff]);

  // A link opened the app: a link that sets this phone up (checked against its pin first), a link naming an appliance
  // (MR-45) to that Whombat and then its path, a burrow page (AP-366) to the
  // Whombat last used and then its path (each link is used once).
  const taken = useRef(onLinkTaken);
  taken.current = onLinkTaken;
  useEffect(() => {
    if (!linkIn) return;
    taken.current();
    if (linkIn.kind === 'setup') return setRoute({ name: 'link', link: linkIn.link });
    if (linkIn.kind === 'claim')
      return setRoute(linkIn.card ? { name: 'claim', card: linkIn.card } : { name: 'claim' });
    // A provider's answer to a sign-in started on this phone (PC-05): finished at the Whombat that started it, else the
    // one last used, once its session is open (`ConnectReturnBridge`).
    if (linkIn.kind === 'connect') {
      const started = takeHeldConnect();
      const device = finishingDevice(started, registry.lastUsed());
      const known = device ? registry.get(device) : undefined;
      if (!known?.enrolled) {
        void clearDepartingStatusWidget(WhombatLive, registry.lastUsed());
        return setRoute({ name: 'appliances' });
      }
      switchActiveAppliance(registry, WhombatLive, known.device);
      pushConnectReturn({ device: known.device, back: asStarted(linkIn.back, started), entry: linkIn.entry });
      return setRoute({ name: 'open' });
    }
    if (linkIn.kind === 'path') {
      const last = registry.lastUsed();
      const lastKnown = last ? registry.get(last) : undefined;
      if (!lastKnown) return setRoute({ name: 'appliances' });
      if (!lastKnown.enrolled) return setRoute({ name: 'pair', device: lastKnown.device });
      links.push(linkIn.path);
      return setRoute({ name: 'open' });
    }
    const { device, path } = linkIn;
    const known = registry.get(device);
    const openIt = (k: KnownAppliance) => {
      const showing = registry.lastUsed();
      switchActiveAppliance(registry, WhombatLive, k.device);
      if (!k.enrolled) return setRoute({ name: 'pair', device: k.device });
      sendLink(links, path, showing, k.device);
      setRoute({ name: 'open' });
    };
    // The directory is compared with this phone's pin, never copied into it (AP-64).
    env.control.appliances(orgId).then(
      (list) => {
        const a = list.find((x) => x.device === device);
        if (!a) return setRoute({ name: 'appliances' });
        if (isRetired(a)) return leave(device, 'retired', a.name ?? known?.name ?? null);
        const decision = openDecision(known, a.contentPeerId);
        if (decision.kind === 'unpinned') {
          void clearDepartingStatusWidget(WhombatLive, registry.lastUsed(), device);
          return setRoute({ name: 'setup', device });
        }
        if (decision.kind === 'changed') {
          void clearDepartingStatusWidget(WhombatLive, registry.lastUsed(), device);
          return setRoute({ name: 'identityChanged', device });
        }
        openIt(decision.known);
      },
      // Control is unreachable: a pinned Whombat still opens (its session checks the pin); nothing else does.
      () => (known ? openIt(known) : setRoute({ name: 'appliances' })),
    );
  }, [linkIn, registry, env, orgId, links, leave]);

  // Android back: out of claim and pairing to the list, out of the kit back to the Whombat.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (
        route.name === 'claim' ||
        route.name === 'pair' ||
        route.name === 'recover' ||
        route.name === 'link' ||
        route.name === 'setup' ||
        route.name === 'identityChanged' ||
        route.name === 'deleteAccount' ||
        route.name === 'phone'
      ) {
        setRoute({ name: 'appliances' });
        return true;
      }
      if (route.name === 'kit') {
        setRoute({ name: 'open' });
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route]);

  // Opening from the list (AP-64): the directory is only compared with this phone's pin. A retired Whombat has no
  // Open (AP-696).
  const open = (a: ApplianceSummary) => {
    if (isRetired(a)) return;
    const previous = registry.lastUsed();
    const decision = openDecision(registry.get(a.device), a.contentPeerId);
    if (decision.kind === 'unpinned') {
      void clearDepartingStatusWidget(WhombatLive, previous, a.device);
      return setRoute({ name: 'setup', device: a.device });
    }
    if (decision.kind === 'changed') {
      void clearDepartingStatusWidget(WhombatLive, previous, a.device);
      return setRoute({ name: 'identityChanged', device: a.device });
    }
    registry.put({ ...decision.known, name: a.name });
    switchActiveAppliance(registry, WhombatLive, a.device);
    setRoute(decision.known.enrolled ? { name: 'open' } : { name: 'pair', device: a.device });
  };
  const toAppliances = () => setRoute({ name: 'appliances' });

  if (route.name === 'appliances')
    return (
      <AppliancesScreen
        session={cloud}
        // Still looking nearby: no “No Whombats yet” for a moment that may turn into the claim.
        appliances={lookingNearby ? null : appliances}
        error={listError}
        notice={notice}
        // A retired Whombat is listed while this phone remembers it, and forgotten at once: it can't be used again.
        remembers={(device) => registry.get(device) !== undefined}
        onForget={(a) => {
          forgetHere(a.device);
          setGone(null);
          bump((n) => n + 1);
        }}
        onOpen={open}
        onClaim={() => setRoute({ name: 'claim' })}
        onSignOut={signOut}
        onRefresh={refresh}
        // Not let in here (never, or no longer): the recovery kit can let this phone in to your account (AP-41).
        // Never into a retired Whombat.
        canRecover={(a) => !isRetired(a) && !registry.get(a.device)?.enrolled}
        onRecover={(a) => {
          const decision = openDecision(registry.get(a.device), a.contentPeerId);
          setRoute(
            decision.kind === 'changed'
              ? { name: 'identityChanged', device: a.device }
              : { name: 'recover', device: a.device },
          );
        }}
        onDeleteAccount={() => setRoute({ name: 'deleteAccount' })}
        // You name a Whombat (AP-3086); the sheet and the list show it from then on.
        onRename={rename}
      />
    );
  if (route.name === 'deleteAccount')
    return (
      <DeleteAccountScreen
        email={cloud.account.email}
        onBack={toAppliances}
        onDelete={async (typed) => {
          try {
            await env.control.deleteAccount(typed);
          } catch (e) {
            return COPY.account.errors[deleteAccountErrorKey(e)];
          }
          // Gone at control: this phone forgets what it kept for the account (AP-73); sign-out clears the push
          // handle and the live notifications. The endpoint key stays: it belongs to this phone.
          for (const a of registry.list()) await forgetAppliance(pushStore, a.device).catch(() => {});
          registry.clear();
          signOut();
          return null;
        }}
      />
    );
  if (route.name === 'claim')
    return (
      <ClaimFlow
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        cloud={cloud}
        card={route.card ?? null}
        found={route.found ?? null}
        onBack={toAppliances}
        onClaimed={(device, peerId, accountId) => {
          // The claim is the one source that may replace a pin: CPace proved this identity (AP-63, AP-68).
          registry.put(
            {
              device,
              orgId,
              name: null,
              peerId,
              pinSource: 'claim',
              enrolled: true,
              // No kit step after the claim any more (BX-01, AP-3525): the box's screen is the way back in.
              kitPending: false,
              accountId,
            },
            { replacePin: true },
          );
          switchActiveAppliance(registry, WhombatLive, device);
          setRoute({ name: 'restore', device });
        }}
      />
    );
  if (route.name === 'restore') {
    const known = registry.get(route.device);
    if (!known) return <GoTo go={toAppliances} />;
    return (
      <BringBackRoute
        env={env}
        keyPair={keyPair}
        known={known}
        email={cloud.account.email}
        {...(route.later ? { later: route.later } : {})}
        onFresh={() => setRoute(route.later ? { name: 'open' } : { name: 'ai', device: known.device })}
        onDone={(name) => {
          if (name) registry.put({ ...known, name });
          setRoute({ name: 'open' });
        }}
        onCancel={() => setRoute({ name: 'open' })}
      />
    );
  }
  if (route.name === 'ai') {
    const known = registry.get(route.device);
    if (!known) return <GoTo go={toAppliances} />;
    return (
      <ConnectAiFlow env={env} keyPair={keyPair} known={known} onDone={() => setRoute({ name: 'open' })} />
    );
  }
  if (route.name === 'kit') {
    const known = registry.get(route.device);
    if (!known) return <GoTo go={toAppliances} />;
    return (
      <KitFlow
        env={env}
        keyPair={keyPair}
        known={known}
        // An older record's `kitPending` (a claim before BX-01) means nothing any more: it is never read (AP-3525).
        onDone={() => setRoute({ name: 'open' })}
        onBack={() => setRoute({ name: 'open' })}
      />
    );
  }
  if (route.name === 'setup') {
    const device = route.device;
    return (
      <SetupScreen
        onLink={(link) => setRoute({ name: 'link', link })}
        onKit={() => setRoute({ name: 'recover', device })}
        onBack={toAppliances}
        onScreen={() => setRoute({ name: 'screen', device, back: 'setup' })}
        {...(onPasskey && { onPasskey })}
      />
    );
  }
  if (route.name === 'identityChanged') {
    const device = route.device;
    return (
      <IdentityStopScreen
        stop="changed"
        onBack={toAppliances}
        {...(registry.get(device) ? { onForget: () => forget(device) } : {})}
      />
    );
  }
  if (route.name === 'pair') {
    const known = registry.get(route.device);
    // Not pinned: never ask to be let in over the directory's identity (AP-64).
    if (!known) return <GoTo go={() => setRoute({ name: 'setup', device: route.device })} />;
    return (
      <PairFlow
        env={env}
        keyPair={keyPair}
        known={known}
        onBack={toAppliances}
        onApproved={(accountId) => {
          registry.put({ ...known, enrolled: true, ...(accountId && { accountId }) });
          PASSKEY_NUDGE.due(known.device, keyPair.peerId);
          setRoute({ name: 'open' });
        }}
        onRecover={() => setRoute({ name: 'recover', device: known.device })}
        onPhoneLink={onPhoneLink}
        onScreen={() => setRoute({ name: 'screen', device: known.device, back: 'pair' })}
        onGone={(reason) => leave(known.device, reason, known.name)}
      />
    );
  }
  if (route.name === 'screen') {
    const { device, back } = route;
    return (
      <ScreenSignInFlow
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        device={device}
        known={registry.get(device) ?? null}
        onBack={() => setRoute(back === 'pair' ? { name: 'pair', device } : { name: 'setup', device })}
        onForget={() => forget(device)}
        onGone={(reason) => leave(device, reason, registry.get(device)?.name ?? null)}
        onIn={(k) => {
          // Let in like a pairing approval: a new pin only from the box's own tag (BX-03, `screen`).
          registry.put(k);
          switchActiveAppliance(registry, WhombatLive, k.device);
          PASSKEY_NUDGE.due(k.device, keyPair.peerId);
          setRoute({ name: 'open' });
        }}
      />
    );
  }
  if (route.name === 'phone')
    return (
      <PhoneHandoffFlow
        key={route.handoff.handoffId}
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        handoff={route.handoff}
        registry={registry}
        onLink={onPhoneLink}
        onBack={toAppliances}
        onForget={forget}
        onOpen={(known) => {
          switchActiveAppliance(registry, WhombatLive, known.device);
          PASSKEY_NUDGE.due(known.device, keyPair.peerId);
          setRoute({ name: 'open' });
        }}
      />
    );
  if (route.name === 'link') {
    const { link } = route;
    return (
      <LinkTrustFlow
        key={link.device}
        env={env}
        orgId={orgId}
        link={link}
        registry={registry}
        onBack={toAppliances}
        onForget={() => forget(link.device)}
        onSetup={() => setRoute({ name: 'setup', device: link.device })}
      >
        {(known) => (
          // Pinned from the link: now the pairing (code + fingerprint) lets this phone in.
          <GoTo
            go={() => {
              switchActiveAppliance(registry, WhombatLive, known.device);
              setRoute(known.enrolled ? { name: 'open' } : { name: 'pair', device: known.device });
            }}
          />
        )}
      </LinkTrustFlow>
    );
  }
  if (route.name === 'recover') {
    const device = route.device;
    return (
      <RecoverFlow
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        device={device}
        known={registry.get(device) ?? null}
        onBack={toAppliances}
        onForget={() => forget(device)}
        onRecovered={(k) => {
          registry.put(k);
          switchActiveAppliance(registry, WhombatLive, k.device);
          PASSKEY_NUDGE.due(k.device, keyPair.peerId);
          setRoute({ name: 'open' });
        }}
      />
    );
  }

  const last = registry.lastUsed();
  const active = last ? registry.get(last) : undefined;
  if (!active) return <GoTo go={toAppliances} />;
  return (
    <ApplianceRoot
      key={`${active.device}|${keyPair.peerId}`}
      env={env}
      orgId={orgId}
      orgName={org?.name ?? null}
      appliance={active}
      keyPair={keyPair}
      email={cloud.account.email}
      taps={taps}
      links={links}
      addSignOutTask={addSignOutTask}
      onSignOut={signOut}
      onSwitch={() => {
        void clearDepartingStatusWidget(WhombatLive, active.device);
        toAppliances();
      }}
      onNotEnrolled={() => {
        registry.put({ ...active, enrolled: false });
        void clearDepartingStatusWidget(WhombatLive, active.device);
        bump((n) => n + 1);
        setRoute({ name: 'pair', device: active.device });
      }}
      onKit={() => setRoute({ name: 'kit', device: active.device })}
      onBringBack={(later) =>
        setRoute({ name: 'restore', device: active.device, later: later ? 'replace' : 'resume' })
      }
      onForget={() => forget(active.device)}
      onGone={(reason) => leave(active.device, reason, active.name)}
      hasOthers={registry.list().some((a) => a.device !== active.device)}
      whombats={{
        list: () => env.control.appliances(orgId),
        known: (device) => registry.get(device),
        connect: (device) => {
          const known = registry.get(device);
          if (!known?.enrolled) return null;
          return createSecureSession({
            connector: env.connector({
              orgId: known.orgId,
              device,
              peerId: known.peerId,
              channel: 'app',
              key: keyPair,
              direct: () => registry.get(device)?.direct,
              own: () => registry.get(device)?.ownAddress,
            }),
            client: phoneClient(APP_BUILD),
            expect: 'app',
          });
        },
        open,
        claim: () => {
          void clearDepartingStatusWidget(WhombatLive, active.device);
          setRoute({ name: 'claim' });
        },
      }}
      onDirect={(direct) => {
        const k = registry.get(active.device);
        if (k) registry.put({ ...k, direct });
      }}
      onOwnAddress={(ownAddress) => {
        const k = registry.get(active.device);
        if (k) registry.put({ ...k, ownAddress });
      }}
      onAccount={(accountId) => {
        const k = registry.get(active.device);
        if (k && k.accountId !== accountId) registry.put({ ...k, accountId });
      }}
      onSetUpAgain={async (then) => {
        // The new key is enrolled nowhere: every Whombat this phone knows asks to let it in again, and none of
        // them has its notification handle yet. The new key remounts this tree on the pairing screen (or the
        // recovery kit's, AP-41).
        forgetEnrollments(registry);
        for (const a of registry.list()) await forgetAppliance(pushStore, a.device).catch(() => {});
        await WhombatLive.clearStatusWidget().catch(() => {});
        registry.setLastUsed(active.device);
        pendingRoute.set(then === 'recover' ? { name: 'recover', device: active.device } : null);
        await rekey();
        void WhombatLive.clearStatusWidget().catch(() => {});
      }}
    />
  );
}

function GoTo({ go }: { go: () => void }) {
  useEffect(() => go(), [go]);
  return null;
}

/** An enrollment-channel session for claim and pairing; an app-channel one for the kit. */
function useFlowSession(
  env: ManagedEnvironment,
  keyPair: EndpointKey,
  known: { orgId: string; device: string; peerId: string },
  channel: 'app' | 'enroll',
): ApplianceSession | null {
  const [session, setSession] = useState<ApplianceSession | null>(null);
  const { orgId, device, peerId } = known;
  useEffect(() => {
    const s = createSecureSession({
      connector: env.connector({ orgId, device, peerId, channel, key: keyPair }),
      client: phoneClient(APP_BUILD),
      expect: channel === 'app' ? 'app' : 'any',
    });
    s.connect();
    setSession(s);
    return () => {
      s.close();
      setSession((c) => (c === s ? null : c));
    };
  }, [env, keyPair, orgId, device, peerId, channel]);
  return session;
}

/* Claim (CC-09, CC-13, AP-47, AP-50): the box on this network and its letters, or the card ---------------------- */

type ClaimStep = NearbyClaimStep | { kind: 'looking' } | { kind: 'card' };

function ClaimFlow({
  env,
  orgId,
  keyPair,
  cloud,
  card,
  found,
  onBack,
  onClaimed,
}: {
  env: ManagedEnvironment;
  orgId: string;
  keyPair: EndpointKey;
  cloud: ControlSession;
  /** The card's QR code opened the app (`…/claim#v=1&d=…&s=…`). */
  card: ClaimCard | null;
  /** What the list already found on this network (AP-75): shown at once, without asking again. */
  found: NearbyClaimStep | null;
  onBack: () => void;
  onClaimed: (device: string, peerId: string, accountId: string) => void;
}) {
  const [step, setStep] = useState<ClaimStep>(card ? { kind: 'card' } : (found ?? { kind: 'looking' }));
  /** Where “Claim with the code on its screen instead” goes back to. */
  const [codeStep, setCodeStep] = useState<ClaimStep>(found ?? { kind: 'looking' });
  const handedOver = useRef(found);
  /** Bumped by “Look again”: asks `claims.nearby` once more. */
  const [search, setSearch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The list found it just now (AP-75): no need to ask until “Look again”.
    if (search === 0 && handedOver.current) return;
    let live = true;
    // Unclaimed boxes on this network (CC-04). Anything that goes wrong here means: we couldn't find it (CC-13).
    const done = (next: ClaimStep) => {
      if (!live) return;
      setCodeStep(next);
      setStep((s) => (s.kind === 'looking' ? next : s));
    };
    env.control.nearbyClaims(orgId).then(
      (boxes) => done(nearbyClaimStep(boxes)),
      () => done({ kind: 'none' }),
    );
    return () => {
      live = false;
    };
  }, [env, orgId, search]);

  const go = (next: ClaimStep) => {
    setError(null);
    setStep(next);
  };

  const onClaim = async (request: ClaimRequest, typedName: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await claimAppliance({
        control: env.control,
        orgId,
        request,
        // The handshake proves the box on the network holds the PeerId control named; the PAKE binds it (CC-06).
        openSession: (t) => openEnrollSession(env, keyPair, { orgId, device: t.device, peerId: t.peerId }),
        // The claim button stays disabled until the terms are ticked (LC-18).
        terms: { version: APPLIANCE_TERMS_VERSION },
        clientPeerId: keyPair.peerId,
        account: { name: cloud.account.name ?? typedName, email: cloud.account.email },
        endpoint: { label: phoneLabel(), platform: PHONE_PLATFORM },
      });
      // Only now, with the appliance's confirmation checked, is its PeerId pinned (CC-07).
      onClaimed(r.device, r.peerId, r.accountId);
    } catch (e) {
      if (isNotNearby(e)) {
        // The box isn't on this network (any more): we couldn't find it; look again (CC-13).
        setStep({ kind: 'none' });
        return;
      }
      setError(claimErrorText(e, request.method));
    } finally {
      setBusy(false);
    }
  };

  const common = {
    askName: !cloud.account.name,
    busy,
    error,
    onBack,
    onClaim: (r: ClaimRequest, name: string) => void onClaim(r, name),
  };
  const toCard = () => go({ kind: 'card' });
  const lookAgain = () => {
    go({ kind: 'looking' });
    setSearch((n) => n + 1);
  };
  if (step.kind === 'looking') return <ClaimLookingScreen onBack={onBack} />;
  if (step.kind === 'found')
    return (
      <ClaimFoundScreen
        key={step.box.device}
        {...common}
        box={step.box}
        onNotThisOne={() => go({ kind: 'none' })}
        onCard={toCard}
      />
    );
  if (step.kind === 'pick')
    return (
      <ClaimPickScreen
        boxes={step.boxes}
        onPick={(box) => go({ kind: 'found', box })}
        onNone={() => go({ kind: 'none' })}
        onCard={toCard}
        onBack={onBack}
      />
    );
  if (step.kind === 'none')
    return <ClaimNoneScreen onLookAgain={lookAgain} onCard={toCard} onBack={onBack} />;
  return <ClaimCardScreen {...common} initial={card} onCode={() => go(codeStep)} />;
}

function BringBackRoute({
  env,
  keyPair,
  known,
  email,
  later,
  onFresh,
  onDone,
  onCancel,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  email: string;
  later?: 'resume' | 'replace';
  onFresh: () => void;
  onDone: (name: string | null) => void;
  /** Away from it without bringing one back (from the app's Backups). */
  onCancel: () => void;
}) {
  const session = useFlowSession(env, keyPair, known, 'app');
  if (!session)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return (
    <BringBackFlow
      session={session}
      control={env.control}
      platform={PASSKEYS}
      appliancePeerId={known.peerId}
      thisName={known.name}
      email={email}
      pickKit={documentKitPicker}
      {...(later ? { later } : {})}
      onFresh={onFresh}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

function ConnectAiFlow({
  env,
  keyPair,
  known,
  onDone,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  onDone: () => void;
}) {
  const session = useFlowSession(env, keyPair, known, 'app');
  if (!session)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return <ConnectAiScreen session={session} onDone={onDone} />;
}

function KitFlow({
  env,
  keyPair,
  known,
  onDone,
  onBack,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  onDone: () => void;
  onBack?: () => void;
}) {
  const session = useFlowSession(env, keyPair, known, 'app');
  if (!session)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return (
    <RecoveryKitScreen
      session={session}
      applianceName={known.name ?? known.device}
      device={known.device}
      appliancePeerId={known.peerId}
      saver={shareSheetSaver}
      printer={shareSheetPrinter}
      control={env.control}
      platform={PASSKEYS}
      onDone={onDone}
      {...(onBack ? { onBack } : {})}
    />
  );
}

function PairFlow({
  env,
  keyPair,
  known,
  onBack,
  onApproved,
  onRecover,
  onPhoneLink,
  onScreen,
  onGone,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  onBack: () => void;
  onApproved: (accountId: string | null) => void;
  onRecover: () => void;
  onPhoneLink: (link: PhoneSignInLink) => void;
  onScreen: () => void;
  /** The Whombat was retired, or isn't this organization's any more: nothing to ask (AP-696). */
  onGone: (reason: GoneReason) => void;
}) {
  const session = useFlowSession(env, keyPair, known, 'enroll');
  useLeaveWhenGone(session, onGone);
  useOpenWhenLetIn(session, onApproved);
  if (!session)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return (
    <PairScreen
      session={session}
      label={phoneLabel()}
      platform={PHONE_PLATFORM}
      fingerprint={pairingFingerprint(keyPair.peerId)}
      onBack={onBack}
      onApproved={onApproved}
      onRecover={onRecover}
      onPhoneLink={onPhoneLink}
      onScreen={onScreen}
    />
  );
}

/**
 * “Use its screen” (BX-02, BX-03; AP-3530…AP-3533): this phone asks for a code, the box shows six letters on its own
 * screen, they are typed here and CPace bound to both Noise keys lets the phone in. The identity is this phone's pin, or
 * without one the directory's for this exchange only — pinned (`screen`) once the box's tag matched; a pin that differs
 * from the directory is the hard stop, as everywhere (AP-64). The steps and their words are the shared machine's.
 */
function ScreenSignInFlow({
  env,
  orgId,
  keyPair,
  device,
  known,
  onBack,
  onForget,
  onGone,
  onIn,
}: {
  env: ManagedEnvironment;
  orgId: string;
  keyPair: EndpointKey;
  device: string;
  known: KnownAppliance | null;
  onBack: () => void;
  onForget: () => void;
  onGone: (reason: GoneReason) => void;
  onIn: (k: KnownAppliance) => void;
}) {
  const entry = useDirectoryEntry(env, orgId, device);
  // Android's back out of the flow from a screen that isn't one of its steps (the steps go back a step themselves).
  const out = (screen: ReactNode) => (
    <>
      <HardwareBack onBack={onBack} />
      {screen}
    </>
  );
  if (entry === null)
    return out(
      <Screen>
        <Loading />
      </Screen>,
    );
  // Not this organization's, or retired (AP-696): nothing to ask.
  if (entry === 'missing' || entry === 'unreachable' || isRetired(entry))
    return out(
      <GateScreen
        title={COPY.screen.title}
        text={typeof entry === 'object' ? goneNotice('retired', entry.name) : COPY.recover.notInOrg}
        actions={<Button label={COPY.connection.back} variant="secondary" size="lg" onPress={onBack} />}
      />,
    );
  const peer = screenSignInPeer(known?.peerId, entry.contentPeerId);
  if (peer.kind === 'changed')
    return out(<IdentityStopScreen stop="changed" onBack={onBack} {...(known ? { onForget } : {})} />);
  return (
    <ScreenSignInSession
      env={env}
      keyPair={keyPair}
      target={{ orgId, device, peerId: peer.peerId }}
      onBack={onBack}
      onGone={onGone}
      onIn={(accountId) =>
        onIn(screenSignedInRecord({ known, device, orgId, name: entry.name, peerId: peer.peerId, accountId }))
      }
      // Let in already (`endpoint_enrolled`): nothing was checked, so only a pinned record opens.
      onAlready={known ? () => onIn({ ...known, enrolled: true }) : onBack}
    />
  );
}

/**
 * Android's back while it's shown: `onBack`. The signed-in tree's own handler passes on the screen route (it returns
 * false there), so this one, or the steps' own, gets it.
 */
function HardwareBack({ onBack }: { onBack: () => void }) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back.current();
      return true;
    });
    return () => sub.remove();
  }, []);
  return null;
}

/** The enrollment session to the identity chosen above, for this flow only, under the shared steps. */
function ScreenSignInSession({
  env,
  keyPair,
  target,
  onBack,
  onGone,
  onIn,
  onAlready,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  target: { orgId: string; device: string; peerId: string };
  onBack: () => void;
  onGone: (reason: GoneReason) => void;
  onIn: (accountId: string) => void;
  onAlready: () => void;
}) {
  const session = useFlowSession(env, keyPair, target, 'enroll');
  useLeaveWhenGone(session, onGone);
  if (!session)
    return (
      <Screen>
        <HardwareBack onBack={onBack} />
        <Loading />
      </Screen>
    );
  return (
    <ScreenSignInSteps
      session={session}
      device={target.device}
      appliancePeerId={target.peerId}
      clientPeerId={keyPair.peerId}
      endpoint={{ label: phoneLabel(), platform: PHONE_PLATFORM }}
      onBack={onBack}
      onIn={onIn}
      onAlready={onAlready}
    />
  );
}

/**
 * After the computer's code signed this phone in (AP-530): the Whombat it names, checked against the pin and the
 * directory, then asked to let this phone in while the computer confirms (`runPhoneHandoff`).
 */
function PhoneHandoffFlow({
  env,
  orgId,
  keyPair,
  handoff,
  registry,
  onLink,
  onBack,
  onForget,
  onOpen,
}: {
  env: ManagedEnvironment;
  orgId: string;
  keyPair: EndpointKey;
  handoff: PhoneHandoff;
  registry: ApplianceRegistry;
  onLink: (link: PhoneSignInLink) => void;
  onBack: () => void;
  onForget: (device: string) => void;
  onOpen: (known: KnownAppliance) => void;
}) {
  const [view, setView] = useState<PhoneSignInView>({ kind: 'working', stage: 'asking' });
  const [stop, setStop] = useState<{ stop: 'changed' | 'link'; device: string; pinned: boolean } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const done = useRef({ onBack, onOpen });
  done.current = { onBack, onOpen };
  useEffect(() => {
    void attempt;
    const abort = new AbortController();
    const deps: HandoffDeps<ApplianceSession> = {
      directory: () => env.control.appliances(orgId),
      known: (device) => registry.get(device),
      pin: (record) => registry.put(record),
      report: (id, report) => env.control.reportPhoneHandoff(id, report),
      openSession: (k) => openEnrollSession(env, keyPair, { orgId, device: k.device, peerId: k.peerId }),
      letIn: (s) => letInAlready(s.state()),
      pairRequest: (s, input) => sessionOps.pairRequest(s, input),
      pairStatus: (s, id) => sessionOps.pairStatus(s, id),
      close: (s) => s.close(),
    };
    const input = {
      handoff,
      orgId,
      label: phoneLabel(),
      platform: PHONE_PLATFORM,
      fingerprint: pairingFingerprint(keyPair.peerId),
    };
    void runPhoneHandoff(deps, input, (v) => !abort.signal.aborted && setView(v), abort.signal).then(
      (outcome) => {
        if (abort.signal.aborted) return;
        if (outcome.kind === 'signedIn') done.current.onBack();
        else if (outcome.kind === 'open') {
          registry.put(outcome.known);
          done.current.onOpen(outcome.known);
        } else if (outcome.kind === 'approved') {
          const known = {
            ...outcome.known,
            enrolled: true,
            ...(outcome.accountId && { accountId: outcome.accountId }),
          };
          registry.put(known);
          done.current.onOpen(known);
        } else if (outcome.kind === 'stop') setStop(outcome);
      },
    );
    return () => abort.abort();
  }, [attempt, env, orgId, keyPair, handoff, registry]);

  if (stop)
    return (
      <IdentityStopScreen
        stop={stop.stop === 'link' ? 'code' : 'changed'}
        onBack={onBack}
        {...(stop.stop === 'changed' && stop.pinned ? { onForget: () => onForget(stop.device) } : {})}
      />
    );
  return (
    <PhoneProgressScreen
      view={view}
      signedIn
      onLink={onLink}
      onCancel={onBack}
      onAction={(action) => {
        if (action === 'retry') {
          setView({ kind: 'working', stage: 'asking' });
          setAttempt((n) => n + 1);
        } else onBack();
      }}
    />
  );
}

/**
 * A link that names the Whombat's identity (add a device; AP-66, AP-67), checked against this
 * phone's pin and the directory before anything is sent (AP-64): a new pin is stored from the link, a mismatch is a
 * hard stop, and a link without an identity is refused.
 */
function LinkTrustFlow({
  env,
  orgId,
  link,
  registry,
  onBack,
  onForget,
  onSetup,
  children,
}: {
  env: ManagedEnvironment;
  orgId: string;
  link: SetupLink;
  registry: ApplianceRegistry;
  onBack: () => void;
  onForget: () => void;
  onSetup: () => void;
  children: (known: KnownAppliance) => React.ReactElement;
}) {
  const { device } = link;
  const entry = useDirectoryEntry(env, orgId, device);
  const [pinned, setPinned] = useState<KnownAppliance | null>(null);
  const known = pinned ?? registry.get(device) ?? null;
  // A retired Whombat is never pinned or asked (AP-696).
  const decision =
    entry && typeof entry === 'object' && !isRetired(entry)
      ? trustDecision({ pinned: known?.peerId ?? null, named: link.peerId, directory: entry.contentPeerId })
      : null;
  const pinNow = decision?.kind === 'pin' && decision.isNew && typeof entry === 'object' ? entry : null;
  useEffect(() => {
    if (!pinNow || decision?.kind !== 'pin') return;
    // Pinned from the link (made by a device that trusts this Whombat), never from the directory.
    const record = pinnedRecord({
      device,
      orgId,
      name: pinNow.name,
      peerId: decision.peerId,
      source: 'add-link',
    });
    registry.put(record);
    setPinned(record);
  }, [pinNow, decision, device, orgId, registry]);

  const gate = (message: string) => (
    <GateScreen
      title={COPY.setup.title}
      text={message}
      actions={<Button label={COPY.connection.back} variant="secondary" size="lg" onPress={onBack} />}
    />
  );
  if (entry === null)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  if (entry === 'missing' || entry === 'unreachable') return gate(COPY.recover.notInOrg);
  if (isRetired(entry)) return gate(goneNotice('retired', entry.name));
  if (!decision) return null;
  if (decision.kind === 'changed')
    return <IdentityStopScreen stop="changed" onBack={onBack} onForget={onForget} />;
  if (decision.kind === 'mismatch') return <IdentityStopScreen stop="link" onBack={onBack} />;
  if (decision.kind === 'missing') return <GoTo go={onSetup} />;
  return known && !decision.isNew ? (
    children(known)
  ) : (
    <Screen>
      <Loading />
    </Screen>
  );
}

/** The saved kit through the system's document picker (Files, a drive…), read as text (AP-41). */
const documentKitPicker: KitPicker = async () => {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['text/plain', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    if ((asset.size ?? 0) > 64 * 1024) return { name: asset.name, text: '' };
    return { name: asset.name, text: await file.text() };
  } finally {
    // The picker's cache copy goes at once; the kit never stays on the phone.
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
};

/**
 * Recovery with the kit (AP-41, AP-65), with this phone's (new) key. The kit (or the typed key) is checked against this
 * phone's pin and the directory first; only then does an enrollment session open, pinned to the identity this phone
 * had or the kit names. A version 1 kit or a typed key needs a pin already.
 */
function RecoverFlow({
  env,
  orgId,
  keyPair,
  device,
  known,
  onBack,
  onForget,
  onRecovered,
}: {
  env: ManagedEnvironment;
  orgId: string;
  keyPair: EndpointKey;
  device: string;
  known: KnownAppliance | null;
  onBack: () => void;
  onForget: () => void;
  onRecovered: (k: KnownAppliance) => void;
}) {
  const entry = useDirectoryEntry(env, orgId, device);
  const [stop, setStop] = useState<IdentityStop | null>(null);
  if (entry === null)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  // Not this organization's, or retired (AP-696): no kit lets a phone in there.
  if (entry === 'missing' || entry === 'unreachable' || isRetired(entry))
    return (
      <GateScreen
        title={COPY.recover.title}
        text={typeof entry === 'object' ? goneNotice('retired', entry.name) : COPY.recover.notInOrg}
        actions={<Button label={COPY.connection.back} variant="secondary" size="lg" onPress={onBack} />}
      />
    );
  const shown = stop ?? (known && known.peerId !== entry.contentPeerId ? 'changed' : null);
  if (shown)
    return (
      <IdentityStopScreen
        stop={shown}
        onBack={onBack}
        {...(known && shown === 'changed' ? { onForget } : {})}
      />
    );

  const submit = async (input: KitInput): Promise<string | null> => {
    const result = await recoverAppliance({
      device,
      orgId,
      known,
      name: entry.name,
      directoryPeerId: entry.contentPeerId,
      namedPeerId: input.kit?.appliancePeerId ?? null,
      secretKeyHex: input.secretKeyHex,
      accountId: input.accountId,
      endpointPeerId: keyPair.peerId,
      endpoint: { label: phoneLabel(), platform: PHONE_PLATFORM },
      openSession: (peerId) => openEnrollSession(env, keyPair, { orgId, device, peerId }),
    });
    if (result.kind === 'changed' || result.kind === 'mismatch') {
      setStop(result.kind === 'changed' ? 'changed' : 'kit');
      return null;
    }
    if (result.kind === 'missing') return input.kit ? COPY.recover.oldKit : COPY.recover.typedUnknown;
    if (result.kind === 'error') return COPY.recover.errors[result.error];
    if (result.kind === 'recovered') onRecovered(result.known);
    return null;
  };
  return (
    <RecoverScreen
      device={device}
      knownAccountId={known?.accountId ?? null}
      pickKit={documentKitPicker}
      onSubmit={submit}
      onBack={onBack}
    />
  );
}

/** An enrollment-channel session, resolved once its handshake is done (the pinned identity answered). */
function openEnrollSession(
  env: ManagedEnvironment,
  keyPair: EndpointKey,
  target: { orgId: string; device: string; peerId: string },
): Promise<ApplianceSession> {
  const session = createSecureSession({
    connector: env.connector({ ...target, channel: 'enroll', key: keyPair }),
    client: phoneClient(APP_BUILD),
    expect: 'any',
    backoff: { initialMs: 500, maxMs: 5000 },
  });
  return new Promise<ApplianceSession>((resolve, reject) => {
    const off = session.onState((s) => {
      if (s.status === 'open') {
        off();
        resolve(session);
      } else if (s.status === 'closed' || (s.status === 'reconnecting' && s.attempt >= 2)) {
        off();
        session.close();
        reject(new ConnectError(s.reason));
      }
    });
    session.connect();
  });
}
