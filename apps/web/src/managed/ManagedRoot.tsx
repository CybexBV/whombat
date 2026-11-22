/**
 * The hosted UI in managed mode (`VITE_WHOMBAT_TRANSPORT=session`, AP-20…AP-22): cloud sign-in, the appliance
 * list, claim, recovery kit, pairing — and once an appliance is open and this browser is trusted there, the
 * regular app over an end-to-end session with it (`ApplianceApp`). Paths it owns: `/auth/verify`, `/appliances`,
 * `/claim` (what the Whombat's screen and its card's QR code open; also `/appliances/claim`),
 * `/appliances/:device/recovery-kit`, `/appliances/:device/pair`, `/appliances/:device/screen` (signing in at the box's
 * screen, BX-02), `/appliances/:device/recover`, the add-a-device link's journey (`add`) and
 * `/appliances/:device/setup` / `identity-changed`; every other path belongs to the burrow app of the open appliance.
 *
 * The appliance identity (MA-24, AP-63…): a session is only ever opened with the PeerId this browser pinned from a
 * party that already trusts the appliance (the claim, a recovery kit or an add-a-device link; no invites or links to
 * get back in since one-person.md AP-5674).
 * The directory is compared with the pin, never copied into it. One exception: the screen sign-in of a browser without
 * a pin connects with the directory's PeerId for that exchange only, and pins it once the box's tag proved it (BX-03).
 */

import {
  ADD_DEVICE_PATH,
  APPLIANCE_TERMS_VERSION,
  type ApplianceRegistry,
  type ApplianceSummary,
  type ClaimRequest,
  COPY,
  type ControlSession,
  claimAppliance,
  claimErrorText,
  claimRefusalOf,
  createRegistry,
  deleteAccountErrorKey,
  finishGoogleConnection,
  forgetAppliance,
  forgetEnrollments,
  type GoneReason,
  type GoogleReturn,
  goneNotice,
  googleFinishStep,
  heldGoogleConnect,
  holdGoogleConnect,
  hostedOrgOf,
  isManagedConnectionReturn,
  isNotNearby,
  isRetired,
  journeyDevice,
  type KnownAppliance,
  linkCodeOf,
  linkPagePath,
  looksNearbyFirst,
  type NearbyClaimStep,
  nearbyClaimStep,
  openDecision,
  PASSKEY_COPY,
  PASSKEY_PREPARED_MS,
  PasskeyCancelled,
  type PasskeySignInOutcome,
  PHONE_SIGNIN_PATH,
  PinConflictError,
  type PinSource,
  type PreparedPasskeySignIn,
  pairingFingerprint,
  parseAddDeviceLink,
  parseApplianceLinkPath,
  parseSetupLink,
  passkeyErrorOf,
  passkeyFailureDetail,
  passkeySignIn,
  pinnedRecord,
  preparePasskeySignIn,
  readVerifyFragment as readFragment,
  readGoogleReturn,
  recoverAppliance,
  renameErrorText,
  type ScreenSignInStep,
  screenSignedInRecord,
  screenSignInPeer,
  trustDecision,
  verifyOnce,
  WHOMBAT_LINK_TEXT,
  withConnectError,
} from '@whombat/client/managed';
import { useDirectoryEntry, useLeaveWhenGone, useOpenWhenLetIn } from '@whombat/client/managed/react';
import {
  type ApplianceSession,
  ConnectError,
  type ConnectionState,
  createSecureSession,
} from '@whombat/client/session';
import { managedGoogleRedirectPath } from '@whombat/core/domain';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearOpenTimings } from '../app/openTiming';
import { ThemeProvider } from '../app/theme';
import { Button } from '../components/Button';
import { AccountMobilePage, PhoneLinkPage, PublicMobilePage } from '../features/mobile';
import { LEGAL_PAGES, LegalPage } from '../legal/LegalPage';
import { ApplianceApp } from './ApplianceApp';
import { BringBackFlow } from './BringBack';
import { type ConnectTarget, type ManagedEnvironment, WEB_CLIENT } from './connect';
import { forgetHeld, forgetHeldFor, held } from './held';
import {
  browserLabel,
  deleteEndpointKey,
  type EndpointKey,
  EndpointKeyUnavailableError,
  endpointKeysSupportedCheck,
  loadOrCreateEndpointKey,
} from './keys';
import { LinkAccountFlow, LinkCodeFlow, LinkSignedOutScreen } from './LinkAccount';
import { LinkWhombatScreen } from './LinkWhombat';
import { PASSKEY_NUDGE, PASSKEYS, webAuthnExists } from './passkeyEnv';
import { signInFailure } from './passkeys';
import { createOpening, prepareOpening } from './prepareOpening';
import {
  AppliancesScreen,
  ClaimFoundScreen,
  ClaimLookingScreen,
  ClaimNoneScreen,
  ClaimPickScreen,
  ClaimRefusalNotice,
  ConnectionGate,
  DeleteAccountScreen,
  type IdentityStop,
  IdentityStopScreen,
  type KitInput,
  PairScreen,
  PasskeyProgressScreen,
  type PasskeySignIn,
  PasskeyStopScreen,
  ProtectScreen,
  RecoverScreen,
  RecoveryKitScreen,
  ScreenSignInScreen,
  SetupScreen,
  SignInScreen,
  VerifyScreen,
} from './screens';
import { localPushStore } from './webPush';

/** `location.pathname` that follows pushState and popstate. */
function useLocation(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const on = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', on);
    window.addEventListener('whombat:navigate', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('whombat:navigate', on);
    };
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new Event('whombat:navigate'));
  }, []);
  return [path, navigate];
}

/** The demo world (docs/app/decisions/look-around.md): its chunks, with the mock world's, load only when opened. */
const DemoWorld = lazy(() => import('./DemoWorld').then((m) => ({ default: m.DemoWorld })));

/** The magic link's fragment (`#token=…&next=…`), when this page is `/auth/verify`. */
export function readVerifyFragment(
  loc: Pick<Location, 'pathname' | 'hash'> = window.location,
): { token: string; next: string } | null {
  return readFragment(loc);
}

/**
 * The links this browser holds until their journeys end (`held.ts`, AP-591): an add-a-device link (AP-66), a card's
 * claim secret (AP-47) and a `/signup` invite code (AP-161).
 */
export { heldSignupCode, holdSignupCode, SIGNUP_CODE_HELD_MS } from './held';
export { verifyOnce };

/** An enrollment-channel session for claim, pairing and recovery. */
function enrollSession(env: ManagedEnvironment, target: Omit<ConnectTarget, 'channel'>): ApplianceSession {
  return createSecureSession({
    connector: env.connector({ ...target, channel: 'enroll' }),
    client: WEB_CLIENT,
    expect: 'any',
    backoff: { initialMs: 500, maxMs: 5000 },
  });
}

export function ManagedRoot({ env }: { env: ManagedEnvironment }) {
  const [path, navigate] = useLocation();
  const [cloud, setCloud] = useState<ControlSession | null | 'loading'>('loading');
  const [key, setKey] = useState<EndpointKey | null | 'unsupported' | 'weakKey'>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // “Look around without a Whombat” from the sign-in page (docs/app/decisions/look-around.md); Leave comes back.
  const [lookAround, setLookAround] = useState(false);

  useEffect(() => {
    env.control.session().then(setCloud, () => setCloud(null));
    endpointKeysSupportedCheck().then((ok) => {
      if (!ok) setKey('unsupported');
      // The same key loaded again (StrictMode runs this twice) keeps its object: a new object would restart the
      // appliance session under an App built on the first one (rc 0.5.2 device run).
      else
        loadOrCreateEndpointKey().then(
          (k) => setKey((prev) => (prev && typeof prev !== 'string' && prev.peerId === k.peerId ? prev : k)),
          // An older software key in this browser is refused, not used or quietly replaced (keys.ts).
          (e) =>
            setKey(
              e instanceof EndpointKeyUnavailableError && e.reason === 'weakKey' ? 'weakKey' : 'unsupported',
            ),
        );
    });
  }, [env]);

  // The magic link lands here: control puts the token in the fragment (`/auth/verify#token=…&next=…`) so it
  // never reaches a server log; read it once and take it out of the address bar and history.
  const url = new URL(path, window.location.origin);
  // Google's `code` and `state` leave the address bar below; the location read before still has them. They go only
  // to the Whombat that started the connect: never on into a sign-in link's `next` or anywhere else.
  if (
    url.pathname === managedGoogleRedirectPath ||
    url.pathname === '/connect/microsoft' ||
    isManagedConnectionReturn(url.pathname)
  )
    url.search = '';
  const [verify, setVerify] = useState(() => readVerifyFragment());
  // Google's answer to a connect (AG-14): `code` and `state` leave the address bar and history at once; they are
  // only ever sent to the Whombat that started the connect, over its session.
  const [googleBack] = useState<GoogleReturn | null>(() => {
    const back = readGoogleReturn(window.location);
    if (back)
      window.history.replaceState(
        null,
        '',
        back.provider === 'microsoft'
          ? '/connect/microsoft'
          : back.provider === 'connection'
            ? window.location.pathname
            : managedGoogleRedirectPath,
      );
    return back;
  });
  // A link's fragment: keep what it holds, drop it from the address bar and history.
  useState(() => {
    const add = parseAddDeviceLink(window.location.href, [window.location.origin]);
    // A new link is a new hold with a new expiry. One that can't be stored isn't held (an older one doesn't stand in
    // for it); its fragment still leaves the address bar.
    if (add) held.addDevice.hold(add);
    // A card's claim secret (`/claim#…`) and an invite code (`/signup#…`) are no longer used here (Whombat Link,
    // link-account-site.md): they only leave the address bar and history.
    const dropped = ['/claim', '/signup'].includes(window.location.pathname) && window.location.hash !== '';
    if (add || dropped) window.history.replaceState(null, '', window.location.pathname);
  });
  useEffect(() => {
    if (!verify) return;
    window.history.replaceState(null, '', '/auth/verify');
    let live = true;
    // One request per one-use token, however often the effect runs (StrictMode runs it twice).
    verifyOnce(env, verify.token).then(
      (s) => {
        if (!live) return;
        setCloud(s);
        navigate(verify.next);
        // Used: a later sign-out (or account deletion) shows the sign-in page, not “Signing you in…”.
        setVerify(null);
      },
      () => live && setVerifyError(COPY.signIn.badLink),
    );
    return () => {
      live = false;
    };
  }, [verify, env, navigate]);

  // Set up again after this browser was removed (AP-39): the revoked key is discarded and a new one made.
  const rekey = useCallback(async () => {
    await deleteEndpointKey();
    setKey(await loadOrCreateEndpointKey().catch(() => 'unsupported' as const));
  }, []);

  // Passkeys (PK-04, AP-792): control's options made ready ahead, the flow, and where it ends.
  const prepared = useRef<PreparedPasskeySignIn | null>(null);
  const [passkeyStep, setPasskeyStep] = useState<{ opening: { name: string | null } | null } | null>(null);
  const [passkeyStop, setPasskeyStop] = useState<Extract<PasskeySignInOutcome, { kind: 'setup' }> | null>(
    null,
  );
  /** What the list says after a passkey that couldn't open a Whombat (not in the organization, retired). */
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);
  const endpointKey = key && typeof key !== 'string' ? key : null;
  const preparePasskey = useCallback(() => {
    if (!endpointKey) return;
    const p = prepared.current;
    if (p && p.endpoint === endpointKey.peerId && Date.now() - p.at < PASSKEY_PREPARED_MS) return;
    preparePasskeySignIn(env.control, endpointKey.peerId).then(
      (next) => {
        prepared.current = next;
      },
      // The click asks again (and says what's wrong then).
      () => {},
    );
  }, [env, endpointKey]);
  const runPasskey = useCallback(
    async (request: { conditional?: boolean; signal?: AbortSignal } = {}) => {
      if (!endpointKey) return;
      let outcome: PasskeySignInOutcome;
      // A passkey came back from the browser (the autofill's failures before that are said nowhere, AP-804).
      let picked = false;
      try {
        outcome = await passkeySignIn(
          {
            control: env.control,
            platform: PASSKEYS,
            endpoint: { peerId: endpointKey.peerId, label: browserLabel(), platform: 'web' },
            registryFor: (accountId) => createRegistry(accountId),
            openEnroll: (t) => openEnrollSession(env, { ...t, key: endpointKey }),
            // Only once the Whombat is asked: until then the screen that started it says what fails.
            onStep: (step, appliance) => {
              if (step === 'signing_in') picked = true;
              if (step === 'opening') setPasskeyStep({ opening: { name: appliance?.name ?? null } });
            },
          },
          { prepared: prepared.current, ...request },
        );
      } catch (error) {
        setPasskeyStep(null);
        // A dismissed prompt left the challenge unused: the next click uses it.
        if (!(error instanceof PasskeyCancelled)) prepared.current = null;
        // Its Whombat is gone: the next Whombat this browser opens offers a new passkey.
        if (passkeyErrorOf(error) === 'gone') PASSKEY_NUDGE.owe();
        if (passkeyErrorOf(error) === 'failed')
          console.warn('passkey: sign-in failed', passkeyFailureDetail(error));
        throw signInFailure(error, request, picked);
      }
      prepared.current = null;
      setPasskeyStep(null);
      setCloud(outcome.session);
      const at = (device: string, journey: string) => `/appliances/${encodeURIComponent(device)}/${journey}`;
      switch (outcome.kind) {
        case 'open':
          return navigate('/');
        case 'changed':
          return navigate(at(outcome.device, 'identity-changed'));
        case 'setup':
          setPasskeyStop(outcome);
          return;
        case 'not_in_org':
          setPasskeyNote(PASSKEY_COPY.notInOrg);
          return navigate('/appliances');
        case 'retired':
          PASSKEY_NUDGE.owe();
          setPasskeyNote(PASSKEY_COPY.retired(outcome.name));
          return navigate('/appliances');
        default:
          return navigate('/appliances');
      }
    },
    [env, endpointKey, navigate],
  );
  const passkeySignInProps = useMemo<PasskeySignIn | undefined>(
    () =>
      webAuthnExists()
        ? { prepare: preparePasskey, signIn: runPasskey, conditional: () => PASSKEYS.supportsConditional() }
        : undefined,
    [preparePasskey, runPasskey],
  );
  useEffect(() => {
    if (url.pathname !== '/appliances') setPasskeyNote(null);
  }, [url.pathname]);

  const signOut = useCallback(async () => {
    await env.control.signOut().catch(() => {});
    // Held links, cards and invite codes are this browser's user's, not the next one's (AP-161, AP-591).
    forgetHeld();
    setCloud(null);
    navigate('/');
  }, [env, navigate]);

  // The Android APK, public (CT-191): the phone sign-in link's landing offers it too.
  const loadAndroid = useCallback(() => env.control.androidDownload(), [env]);

  // The legal pages are public (LC-17): the claim screens link to them.
  const legal = LEGAL_PAGES[url.pathname];
  if (legal) return <LegalPage text={legal} />;
  // A phone sign-in QR code opened in a browser (AP-526): public, and never redeemed here; its fragment stays on this
  // page (never a sign-in's `next`).
  if (url.pathname === PHONE_SIGNIN_PATH) return <PhoneLinkPage loadDownload={loadAndroid} />;
  // The waitlist and invite codes went with open sign-up (Whombat Link, LNK-31): their old links show the sign-in.
  if (verify && (cloud === 'loading' || !cloud || verifyError)) return <VerifyScreen error={verifyError} />;
  if (cloud === 'loading' || key === null) return null;
  if (key === 'weakKey')
    return (
      <ConnectionGate
        title={COPY.connection.weakKeyTitle}
        text={COPY.connection.weakKey}
        actions={
          <Button variant="primary" size="lg" onClick={() => void rekey()}>
            {COPY.connection.weakKeyForget}
          </Button>
        }
      />
    );
  if (key === 'unsupported')
    return (
      <ConnectionGate
        title={COPY.connection.signedOutTitle}
        text={COPY.connection.unsupported}
        actions={null}
      />
    );
  if (passkeyStep) return <PasskeyProgressScreen opening={passkeyStep.opening} />;
  if (passkeyStop && cloud) {
    const stop = passkeyStop;
    const leave = (to: string) => {
      setPasskeyStop(null);
      navigate(to);
    };
    return (
      <PasskeyStopScreen
        text={PASSKEY_COPY.errors[stop.reason]}
        onOtherWay={() => leave(`/appliances/${encodeURIComponent(stop.known.device)}/pair`)}
        onBack={() => leave('/appliances')}
      />
    );
  }
  // “Mobile app” signed out (AP-526): the download for anyone (the phone app's “Update the app” opens it).
  if (!cloud && url.pathname === '/mobile')
    return <PublicMobilePage loadDownload={loadAndroid} onSignIn={() => navigate('/')} />;
  // Link your Whombat signed out (LNK-13): the code and an email address in one form; the sign-in link comes back
  // here with the code.
  if (!cloud && url.pathname === '/link')
    return (
      <LinkSignedOutScreen
        initialCode={linkCodeOf(url.search)}
        onSend={(email, code) => env.control.requestSignInLink(email, linkPagePath(code))}
      />
    );
  if (!cloud) {
    // The demo world: its own chunks, loaded only now.
    if (lookAround)
      return (
        <Suspense fallback={null}>
          <DemoWorld onLeave={() => setLookAround(false)} />
        </Suspense>
      );
    // Back to where this page was after signing in (an app path; the control client sends it only when it passes
    // the contract's `isSafeNext`, CT-48). From the start page: the list, which is Your Whombats for an account whose
    // Whombats this site doesn't open.
    const next = ['/', '/auth/verify', '/signup', '/waitlist'].includes(url.pathname)
      ? undefined
      : url.pathname + url.search;
    return (
      <SignInScreen
        onSend={(email) => env.control.requestSignInLink(email, next)}
        {...(passkeySignInProps && { passkey: passkeySignInProps })}
        onLookAround={() => setLookAround(true)}
      />
    );
  }
  // The organization whose Whombats this site still opens; an account with only its Link org (or none) has Your
  // Whombats and `/link` (LNK-35).
  const org = hostedOrgOf(cloud.orgs);
  if (!org)
    return (
      <AccountOnly
        env={env}
        cloud={cloud}
        path={url.pathname}
        search={url.search}
        navigate={navigate}
        signOut={() => void signOut()}
      />
    );
  if (url.pathname === '/signup' || url.pathname === '/waitlist')
    return <GoTo navigate={navigate} to="/account" />;
  return (
    <SignedIn
      // A new key (set up again, AP-39) starts the signed-in tree afresh: nothing holds the old key, and React
      // never compares the old and the new one (a WebCrypto identity refuses to show its private half).
      key={key.peerId}
      env={env}
      cloud={cloud}
      orgId={org.orgId}
      keyPair={key}
      path={url.pathname}
      search={url.search}
      navigate={navigate}
      signOut={() => void signOut()}
      rekey={rekey}
      googleBack={googleBack}
      note={passkeyNote}
      {...(passkeySignInProps && { onPasskey: () => runPasskey() })}
    />
  );
}

/**
 * Signed in without an organization this site opens Whombats of (Whombat Link, LNK-35): Your Whombats with the Link
 * subscription, `/link`, the phone's QR code, and deleting the account.
 */
function AccountOnly({
  env,
  cloud,
  path,
  search,
  navigate,
  signOut,
}: {
  env: ManagedEnvironment;
  cloud: ControlSession;
  path: string;
  search: string;
  navigate: (to: string) => void;
  signOut: () => void;
}) {
  const account = accountRoute({ env, cloud, path, search, navigate, signOut });
  if (account) return account;
  if (path === '/mobile')
    return <AccountMobilePage control={env.control} onBack={() => navigate('/account')} />;
  if (path === '/account/delete')
    return (
      <DeleteAccountScreen
        email={cloud.account.email}
        onBack={() => navigate('/account')}
        onDelete={async (typed) => {
          try {
            await env.control.deleteAccount(typed);
          } catch (e) {
            return COPY.account.errors[deleteAccountErrorKey(e)];
          }
          forgetHeld();
          signOut();
          return null;
        }}
      />
    );
  return <GoTo navigate={navigate} to="/account" />;
}

/** Your Whombats (`/account`, and `/billing` where Stripe sends the browser back) and `/link`; null elsewhere. */
function accountRoute({
  env,
  cloud,
  path,
  search,
  navigate,
  signOut,
  onOpenHere,
}: {
  env: ManagedEnvironment;
  cloud: ControlSession;
  path: string;
  search: string;
  navigate: (to: string) => void;
  signOut: () => void;
  onOpenHere?: () => void;
}): React.ReactElement | null {
  if (path === '/account' || path === '/billing')
    return (
      <LinkAccountFlow
        control={env.control}
        session={cloud}
        {...(env.billingRedirectOrigins && { billingRedirectOrigins: env.billingRedirectOrigins })}
        onLink={() => navigate('/link')}
        {...(onOpenHere && { onOpenHere })}
        onSignOut={signOut}
        onDeleteAccount={() => navigate('/account/delete')}
      />
    );
  if (path === '/link')
    return (
      <LinkCodeFlow
        // A new code in the address starts the page afresh.
        key={search}
        control={env.control}
        session={cloud}
        initialCode={linkCodeOf(search)}
        {...(env.billingRedirectOrigins && { billingRedirectOrigins: env.billingRedirectOrigins })}
        onAccount={() => navigate('/account')}
      />
    );
  return null;
}

function SignedIn({
  env,
  cloud,
  orgId,
  keyPair,
  path,
  search,
  navigate,
  signOut: leaveAccount,
  rekey,
  googleBack,
  note,
  onPasskey,
}: {
  env: ManagedEnvironment;
  cloud: ControlSession;
  orgId: string;
  keyPair: EndpointKey;
  path: string;
  search: string;
  navigate: (to: string) => void;
  signOut: () => void;
  rekey: () => Promise<void>;
  /** What Google put on `/connect/google`, taken off the address bar (AG-14). */
  googleBack: GoogleReturn | null;
  /** What the list says after a passkey sign-in that couldn't open a Whombat. */
  note: string | null;
  /** “Use a passkey” on Set up this device (PK-04): the same sign-in as the signed-out page. */
  onPasskey?: () => Promise<void>;
}) {
  const registry = useMemo(() => createRegistry(cloud.account.accountId), [cloud.account.accountId]);
  const preparing = useMemo(
    () =>
      prepareOpening((appliance) =>
        createOpening({
          env,
          orgId,
          appliance,
          keyPair,
          direct: () => registry.get(appliance.device)?.direct,
        }),
      ),
    [env, orgId, keyPair, registry],
  );
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') preparing.clear();
    };
    window.addEventListener('pagehide', preparing.clear);
    document.addEventListener('visibilitychange', hide);
    return () => {
      preparing.clear();
      clearOpenTimings();
      window.removeEventListener('pagehide', preparing.clear);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [preparing]);
  useEffect(() => {
    if (
      path.startsWith('/appliances/') ||
      path === '/billing' ||
      path === '/account' ||
      path === '/link' ||
      path === '/account/delete'
    )
      preparing.clear();
  }, [path, preparing]);
  const signOut = () => {
    preparing.clear();
    clearOpenTimings();
    leaveAccount();
  };
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
    if (path === '/appliances') refresh();
  }, [path, refresh]);

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

  // No Whombats yet: look for one on this network before showing the empty list, and claim it straight away when
  // there is one (AP-75). Once per visit; what was found goes to the claim, so it doesn't ask again.
  const org = cloud.orgs.find((o) => o.orgId === orgId);
  const lookedNearby = useRef(false);
  const [lookingNearby, setLookingNearby] = useState(false);
  const [foundNearby, setFoundNearby] = useState<NearbyClaimStep | null>(null);
  const pathNow = useRef(path);
  pathNow.current = path;
  useEffect(() => {
    if (path !== '/appliances' || lookedNearby.current || !looksNearbyFirst(appliances)) return;
    lookedNearby.current = true;
    setLookingNearby(true);
    env.control
      .nearbyClaims(orgId)
      .then(
        (boxes) => {
          if (boxes.length === 0 || pathNow.current !== '/appliances') return;
          setFoundNearby(nearbyClaimStep(boxes));
          navigate('/appliances/claim');
        },
        // Not found or not reachable: the list says how to claim one.
        () => {},
      )
      .finally(() => setLookingNearby(false));
  }, [path, appliances, env, orgId, navigate]);
  useEffect(() => {
    if (path === '/appliances') setFoundNearby(null);
  }, [path]);

  // Why the list opened in place of a Whombat (AP-694): shown until the list is left.
  const [gone, setGone] = useState<{ device: string; reason: GoneReason; name: string | null } | null>(null);
  useEffect(() => {
    if (path !== '/appliances') setGone(null);
  }, [path]);
  // Once the list is there, by the directory's name (a Whombat claimed here has none in this browser's record).
  const notice =
    gone && (appliances || listError)
      ? goneNotice(gone.reason, appliances?.find((a) => a.device === gone.device)?.name ?? gone.name)
      : note;

  /**
   * A Whombat that can't be opened any more (AP-694): retired, or not this organization's. It isn't reopened by itself
   * (the last used is cleared; the record stays, so the list shows a retired one until it's forgotten), and the list
   * says why, in place of the page that tried to open it.
   */
  const leave = (device: string, reason: GoneReason, name: string | null) => {
    if (registry.lastUsed() === device) registry.setLastUsed(null);
    setGone({ device, reason, name });
    replaceWith('/appliances');
  };

  const at = (device: string, journey: string) => `/appliances/${encodeURIComponent(device)}/${journey}`;
  const recoverPath = (device: string) => at(device, 'recover');

  const prepare = (a: ApplianceSummary) => {
    const decision = openDecision(registry.get(a.device), a.contentPeerId);
    if (isRetired(a) || decision.kind !== 'proceed' || !decision.known.enrolled) {
      preparing.clear();
      return;
    }
    preparing.prepare(decision.known);
    // Load the same chunk the router will use, while the secure connection is opening.
    void import('../features/chats/ChatRoomScreen').catch(() => {});
  };

  // Opening from the list (AP-64): the directory is only compared with this browser's pin. A retired Whombat has no
  // Open (AP-695).
  const open = (a: ApplianceSummary) => {
    if (isRetired(a)) {
      preparing.clear();
      return;
    }
    const decision = openDecision(registry.get(a.device), a.contentPeerId);
    if (decision.kind === 'unpinned' || decision.kind === 'changed') {
      preparing.clear();
      return navigate(at(a.device, decision.kind === 'unpinned' ? 'setup' : 'identity-changed'));
    }
    preparing.select(decision.known);
    registry.put({ ...decision.known, name: a.name });
    registry.setLastUsed(a.device);
    navigate('/');
  };

  /** This browser forgets a Whombat: its record, held links and push handle. */
  const forgetHere = (device: string) => {
    preparing.clear();
    registry.remove(device);
    forgetHeldFor(device);
    // Only tidying the local list (the Whombat won't wake this browser any more): a storage failure changes nothing.
    void forgetAppliance(localPushStore(), device).catch(() => {});
  };
  /** Forget a Whombat on this browser (the way out of a hard stop), then the list. */
  const forget = (device: string) => {
    forgetHere(device);
    navigate('/appliances');
  };

  const kitMatch = /^\/appliances\/([^/]+)\/recovery-kit$/.exec(path);
  const protectMatch = /^\/appliances\/([^/]+)\/protect$/.exec(path);
  const startMatch = /^\/appliances\/([^/]+)\/start$/.exec(path);
  // Bringing a Whombat back from its app (Backups): where a restore stands, or later on a Whombat that started fresh. A
  // path, not a query: the app's router drops a query it doesn't know on the way out.
  const bringBackMatch = /^\/appliances\/([^/?]+)\/bring-back(\/later)?(?:\?.*)?$/.exec(path);
  const pairDevice = journeyDevice(path, /^\/appliances\/([^/]+)\/pair$/);
  const recoverDevice = journeyDevice(path, /^\/appliances\/([^/]+)\/recover$/);
  const setupDevice = journeyDevice(path, /^\/appliances\/([^/]+)\/setup$/);
  const screenDevice = journeyDevice(path, /^\/appliances\/([^/]+)\/screen$/);
  // An old link to *Use as a screen* over the hosted app goes back to pairing (DK-150).
  const displayDevice = journeyDevice(path, /^\/appliances\/([^/]+)\/display$/);
  const changedDevice = journeyDevice(path, /^\/appliances\/([^/]+)\/identity-changed$/);
  const addDevice = journeyDevice(path, ADD_DEVICE_PATH);
  const deepLink = parseApplianceLinkPath(path);

  /** A new key, enrolled nowhere (AP-39): every known Whombat asks again and holds no notification handle. */
  const freshKey = async () => {
    forgetEnrollments(registry);
    const push = localPushStore();
    for (const a of registry.list()) await forgetAppliance(push, a.device).catch(() => {});
    await rekey();
  };

  if (path === '/appliances')
    return (
      <AppliancesScreen
        session={cloud}
        // Still looking nearby: no “No Whombats yet” for a moment that may turn into the claim.
        appliances={lookingNearby ? null : appliances}
        // What this browser couldn't store (storage full or off) it keeps for this page only; the person is told this
        // browser can't keep it, so a Whombat that asks to be set up again after a reload is no surprise (AP-594).
        error={listError ?? (registry.saved() ? null : COPY.connection.unsupported)}
        notice={notice}
        // A retired Whombat is listed while this browser remembers it, and forgotten at once: it can't be used again.
        remembers={(device) => registry.get(device) !== undefined}
        onForget={(a) => {
          forgetHere(a.device);
          setGone(null);
          bump((n) => n + 1);
        }}
        onOpen={open}
        onPrepare={prepare}
        onClaim={() => navigate('/appliances/claim')}
        onSignOut={signOut}
        // Not let in here (never, or no longer): the recovery kit can let this device in (AP-41). Never into a retired
        // Whombat.
        canRecover={(a) => !isRetired(a) && !registry.get(a.device)?.enrolled}
        onRecover={(a) => {
          const decision = openDecision(registry.get(a.device), a.contentPeerId);
          navigate(decision.kind === 'changed' ? at(a.device, 'identity-changed') : recoverPath(a.device));
        }}
        onDeleteAccount={() => navigate('/account/delete')}
        // Your Whombats with Whombat Link (LNK-35), and linking one by the code on its screen (LNK-13).
        onLinkAccount={() => navigate('/account')}
        // Naming a Whombat (AP-3086); the menu and the list show it from then on.
        onRename={rename}
        onLinkWhombat={() => navigate('/link')}
      />
    );
  const account = accountRoute({
    env,
    cloud,
    path,
    search,
    navigate,
    signOut,
    onOpenHere: () => navigate('/appliances'),
  });
  if (account) return account;
  if (path === '/appliances/link')
    return (
      <LinkWhombatScreen
        control={env.control}
        orgId={orgId}
        platform={webAuthnExists() ? PASSKEYS : null}
        onBack={() => navigate('/appliances')}
      />
    );
  if (path === managedGoogleRedirectPath || path === '/connect/microsoft' || isManagedConnectionReturn(path))
    return <GoogleReturnFlow env={env} keyPair={keyPair} registry={registry} back={googleBack} />;
  if (path === '/account/delete')
    return (
      <DeleteAccountScreen
        email={cloud.account.email}
        onBack={() => navigate('/appliances')}
        onDelete={async (typed) => {
          try {
            await env.control.deleteAccount(typed);
          } catch (e) {
            return COPY.account.errors[deleteAccountErrorKey(e)];
          }
          // Gone at control: this browser forgets what it kept for the account (AP-73). The endpoint key stays: it
          // belongs to this browser, not to the account.
          const push = localPushStore();
          for (const a of registry.list()) await forgetAppliance(push, a.device).catch(() => {});
          registry.clear();
          forgetHeld();
          signOut();
          return null;
        }}
      />
    );
  if (path === '/appliances/claim' || path === '/claim')
    return (
      <ClaimFlow
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        cloud={cloud}
        found={foundNearby}
        onClaimed={(device, name, peerId, accountId) => {
          held.claimCard.clear();
          // The claim is the one source that may replace a pin: CPace proved this identity (AP-63, AP-68).
          registry.put(
            { device, orgId, name, peerId, pinSource: 'claim', enrolled: true, kitPending: false, accountId },
            { replacePin: true },
          );
          registry.setLastUsed(device);
          // A new Whombat or one brought back (backup-options.md AP-6830); then where backups go (UP-F1, AP-260) and
          // the Whombat: no recovery kit at the claim any more (BX-01).
          navigate(`/appliances/${device}/start`);
        }}
      />
    );
  if (startMatch?.[1]) {
    const known = registry.get(decodeURIComponent(startMatch[1]));
    if (!known) return <GoTo navigate={navigate} to="/appliances" />;
    return (
      <StartFlow
        env={env}
        keyPair={keyPair}
        known={known}
        email={cloud.account.email}
        onFresh={() => navigate(at(known.device, 'protect'))}
        onOpenChat={() => navigate('/chat')}
        onList={() => navigate('/appliances')}
      />
    );
  }
  if (bringBackMatch?.[1]) {
    const known = registry.get(decodeURIComponent(bringBackMatch[1]));
    if (!known) return <GoTo navigate={navigate} to="/appliances" />;
    return (
      <StartFlow
        env={env}
        keyPair={keyPair}
        known={known}
        email={cloud.account.email}
        later={bringBackMatch[2] ? 'replace' : 'resume'}
        onFresh={() => navigate('/settings?tab=appliance&section=backups')}
        onOpenChat={() => navigate('/chat')}
        onList={() => navigate('/settings?tab=appliance&section=backups')}
      />
    );
  }
  if (protectMatch?.[1]) {
    const known = registry.get(decodeURIComponent(protectMatch[1]));
    if (!known) return <GoTo navigate={navigate} to="/appliances" />;
    // Then Connect your AI, the claim's last step, in the Whombat itself (first-day.md).
    return <ProtectFlow env={env} keyPair={keyPair} known={known} onDone={() => navigate('/connect-ai')} />;
  }
  // “Make a kit” from Settings · This Whombat (BX-01): no longer a step of the claim.
  if (kitMatch?.[1]) {
    const known = registry.get(decodeURIComponent(kitMatch[1]));
    if (!known) return <GoTo navigate={navigate} to="/appliances" />;
    return (
      <KitFlow
        env={env}
        keyPair={keyPair}
        known={known}
        onDone={() => {
          registry.put({ ...known, kitPending: false });
          navigate('/');
        }}
      />
    );
  }
  if (setupDevice)
    return (
      <SetupScreen
        onLink={(text) => {
          const ok = parseSetupLink(text, [window.location.origin]) !== null;
          // The link opens like any link to this page: its fragment is held and dropped from the address bar.
          if (ok) window.location.assign(text.trim());
          return ok;
        }}
        onKit={() => navigate(recoverPath(setupDevice))}
        onBack={() => navigate('/appliances')}
        onScreen={() => navigate(at(setupDevice, 'screen'))}
        {...(onPasskey && { onPasskey })}
      />
    );
  if (screenDevice) {
    const known = registry.get(screenDevice) ?? null;
    return (
      <ScreenFlow
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        device={screenDevice}
        known={known}
        onBack={() => navigate(at(screenDevice, known ? 'pair' : 'setup'))}
        onList={() => navigate('/appliances')}
        onForget={() => forget(screenDevice)}
        onGone={(reason, name) => leave(screenDevice, reason, name)}
        onDone={(step, entry, peerId) => {
          let record: KnownAppliance;
          if (step.kind === 'already') {
            // Let in already, nothing checked: only a browser that pinned this Whombat opens it.
            if (!known) return COPY.claim.errors.failed;
            record = { ...known, enrolled: true };
          } else
            record = screenSignedInRecord({
              known,
              device: screenDevice,
              orgId,
              name: entry.name,
              peerId,
              accountId: step.output.accountId,
            });
          try {
            registry.put(record);
          } catch (e) {
            // Another tab pinned something else meanwhile: the hard stop, nothing opens.
            if (e instanceof PinConflictError) return 'changed';
            throw e;
          }
          registry.setLastUsed(record.device);
          PASSKEY_NUDGE.due(record.device, keyPair.peerId);
          navigate('/');
          return null;
        }}
      />
    );
  }
  // *Use as a screen* is the box's own page's (BoxRoot): over the hosted app a screen would have to keep a cloud
  // session to get its tickets, so a kitchen tablet would hold the person's account (Whombat desk-display.md DK-150).
  if (displayDevice) return <GoTo navigate={navigate} to={at(displayDevice, 'pair')} />;
  if (changedDevice)
    return (
      <IdentityStopScreen
        stop="changed"
        onBack={() => navigate('/appliances')}
        {...(registry.get(changedDevice) ? { onForget: () => forget(changedDevice) } : {})}
      />
    );
  if (pairDevice) {
    const known = registry.get(pairDevice);
    // Not pinned: never ask to be let in over the directory's identity (AP-64).
    if (!known) return <GoTo navigate={navigate} to={at(pairDevice, 'setup')} />;
    return (
      <PairFlow
        env={env}
        keyPair={keyPair}
        known={known}
        onApproved={(accountId) => {
          registry.put({ ...known, enrolled: true, ...(accountId && { accountId }) });
          PASSKEY_NUDGE.due(known.device, keyPair.peerId);
          navigate('/');
        }}
        onRecover={() => navigate(recoverPath(known.device))}
        onScreen={() => navigate(at(known.device, 'screen'))}
        onGone={(reason) => leave(known.device, reason, known.name)}
        {...(onPasskey && { onPasskey })}
      />
    );
  }
  if (deepLink)
    return (
      <DeepLinkFlow
        env={env}
        orgId={orgId}
        device={deepLink.device}
        path={deepLink.path}
        known={registry.get(deepLink.device) ?? null}
        onOpen={(k) => registry.setLastUsed(k.device)}
        onRetired={(name) => leave(deepLink.device, 'retired', name)}
        navigate={navigate}
      />
    );
  const linkFlow = (device: string, source: PinSource, named: string | null | undefined) => ({
    env,
    orgId,
    device,
    source,
    named,
    registry,
    onForget: () => forget(device),
    onSetup: () => navigate(at(device, 'setup')),
  });
  if (addDevice) {
    const link = held.addDevice.read();
    const forgetLink = () => held.addDevice.clear((v) => v.device === addDevice);
    return (
      <LinkTrust
        {...linkFlow(addDevice, 'add-link', link?.device === addDevice ? link.peerId : undefined)}
        notInOrg={COPY.recover.notInOrg}
        title={COPY.setup.title}
        onBack={() => {
          forgetLink();
          navigate('/appliances');
        }}
      >
        {(known) => (
          <GoTo
            navigate={(to) => {
              forgetLink();
              registry.setLastUsed(known.device);
              navigate(to);
            }}
            // Pinned from the link: now the pairing (code + fingerprint) lets this browser in.
            to={known.enrolled ? '/' : at(known.device, 'pair')}
          />
        )}
      </LinkTrust>
    );
  }
  if (recoverDevice)
    return (
      <RecoverFlow
        env={env}
        orgId={orgId}
        keyPair={keyPair}
        device={recoverDevice}
        known={registry.get(recoverDevice) ?? null}
        onBack={() => navigate('/appliances')}
        onForget={() => forget(recoverDevice)}
        onRecovered={(k) => {
          registry.put(k);
          registry.setLastUsed(k.device);
          PASSKEY_NUDGE.due(k.device, keyPair.peerId);
          navigate('/');
        }}
      />
    );

  const last = registry.lastUsed();
  const active = last ? registry.get(last) : undefined;
  // “Mobile app” without a Whombat open (AP-521): the QR code signs the phone in to the account only.
  if (path === '/mobile' && !active)
    return <AccountMobilePage control={env.control} onBack={() => navigate('/appliances')} />;
  if (!active) return <GoTo navigate={navigate} to="/appliances" />;
  if (!active.enrolled)
    return <GoTo navigate={navigate} to={`/appliances/${encodeURIComponent(active.device)}/pair`} />;
  return (
    <ApplianceApp
      key={`${active.device}|${keyPair.peerId}`}
      env={env}
      orgId={orgId}
      orgName={org?.name ?? null}
      appliance={active}
      keyPair={keyPair}
      takePrepared={preparing.take}
      onSignOut={signOut}
      onSwitch={() => navigate('/appliances')}
      onNotEnrolled={() => {
        registry.put({ ...active, enrolled: false });
        bump((n) => n + 1);
      }}
      onKit={() => navigate(`/appliances/${encodeURIComponent(active.device)}/recovery-kit`)}
      onBringBack={(later) => navigate(at(active.device, later ? 'bring-back/later' : 'bring-back'))}
      onDirect={(direct) => registry.put({ ...active, direct })}
      {...(env.fakePage?.() && { page: env.fakePage() })}
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
            }),
            client: WEB_CLIENT,
            expect: 'app',
          });
        },
        // Already at `/`, opening sets the last used without a new path: render again to open it (AP-3082).
        open: (a) => {
          open(a);
          bump((n) => n + 1);
        },
        claim: () => navigate('/appliances/claim'),
      }}
      onAccount={(accountId) => {
        const k = registry.get(active.device);
        if (k && k.accountId !== accountId) registry.put({ ...k, accountId });
      }}
      onSetUpAgain={async (then) => {
        // The revoked key can't be let in again: a new one, then pairing or the recovery kit.
        await freshKey();
        navigate(
          then === 'recover'
            ? recoverPath(active.device)
            : `/appliances/${encodeURIComponent(active.device)}/pair`,
        );
      }}
    />
  );
}

/* Google's return on a managed Whombat (AG-14) ---------------------------------------------------------------- */

/** This tab's `sessionStorage`, reached when used: reaching it may throw (a sandboxed frame, storage turned off). */
const tabStorage = () => window.sessionStorage;

/** Goes to `to` in place of this entry (the return route is never a place to come back to). */
function replaceWith(to: string) {
  window.history.replaceState(null, '', to);
  window.dispatchEvent(new Event('whombat:navigate'));
}

/**
 * `/connect/google`: reopens the Whombat that started the connect (held in this tab, else the last one used), sends
 * Google's answer with `connections.finishGoogle` over its session, and goes where it answers: the DM where the
 * assistant posts the result, or Settings → Connections, with `connected=google` or `connect_error=…`.
 */
function GoogleReturnFlow({
  env,
  keyPair,
  registry,
  back: raw,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  registry: ApplianceRegistry;
  back: GoogleReturn | null;
}) {
  const [started] = useState(() => heldGoogleConnect(tabStorage));
  // A catalog connection's sign-in that came back to Google's route (AP-766): the held connect says which it was.
  const back =
    started?.flow === 'connection' && raw && !raw.provider
      ? { ...raw, provider: 'connection' as const }
      : raw;
  const device = started?.device ?? registry.lastUsed();
  const known = device ? registry.get(device) : undefined;
  const returnTo = started?.returnTo ?? '/';
  const done = useCallback(
    (to: string) => {
      holdGoogleConnect(tabStorage, null);
      if (known) registry.setLastUsed(known.device);
      replaceWith(to);
    },
    [known, registry],
  );
  const lost = !back?.state || !known?.enrolled;
  useEffect(() => {
    // Opened again without Google's answer (a reload), or for a Whombat this browser can't open: nothing to finish.
    if (!lost) return;
    holdGoogleConnect(tabStorage, null);
    if (!known?.enrolled) replaceWith('/appliances');
    else replaceWith(back ? withConnectError(returnTo, 'invalid_state') : returnTo);
  }, [lost, known, back, returnTo]);
  if (lost || !back || !known) return null;
  return (
    <GoogleFinish env={env} keyPair={keyPair} known={known} back={back} returnTo={returnTo} onDone={done} />
  );
}

function GoogleFinish({
  env,
  keyPair,
  known,
  back,
  returnTo,
  onDone,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  back: GoogleReturn;
  returnTo: string;
  onDone: (to: string) => void;
}) {
  const session = useAppSession(env, keyPair, known, 'app');
  // The code is single use: it is sent once, whatever StrictMode or a reconnect does.
  const sent = useRef(false);
  useEffect(() => {
    if (!session) return;
    const step = (state: ConnectionState) => {
      const next = googleFinishStep(state, sent.current);
      if (next === 'wait') return;
      // Sent, or given up on: either way the code goes no further.
      sent.current = true;
      if (next === 'give_up') onDone(withConnectError(returnTo, 'exchange_failed'));
      else
        finishGoogleConnection(session, back).then(onDone, () =>
          onDone(withConnectError(returnTo, 'exchange_failed')),
        );
    };
    step(session.state());
    return session.onState(step);
  }, [session, back, returnTo, onDone]);
  return (
    <ConnectionGate
      title={
        back.provider === 'microsoft'
          ? 'Connecting Microsoft 365…'
          : back.provider === 'connection'
            ? 'Connecting…'
            : 'Connecting Google…'
      }
      text={`Finishing on ${known.name ?? 'your Whombat'}. This takes a moment.`}
      actions={null}
    />
  );
}

function GoTo({ navigate, to }: { navigate: (to: string) => void; to: string }) {
  useEffect(() => navigate(to), [navigate, to]);
  return null;
}

/* Claim (CC-09, CC-13, AP-47, AP-50): the box on this network and its letters, or the card ---------------------- */

type ClaimStep = NearbyClaimStep | { kind: 'looking' };

/** Opens an enrollment session and waits until its handshake is done (the pinned PeerId answered). */
function openEnrollSession(env: ManagedEnvironment, target: Omit<ConnectTarget, 'channel'>) {
  const session = enrollSession(env, target);
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

/**
 * The claim at this site (CC-09, CC-13), kept in phase 1 of Whombat Link for a Whombat on the release before it, which
 * still registers at control: found on this network, its letters. The card's claim and the business plan's refusals
 * went with Link (LNK-31, LNK-35): a refusal says what it is, without a way to a plan.
 */
function ClaimFlow({
  env,
  orgId,
  keyPair,
  cloud,
  found,
  onClaimed,
}: {
  env: ManagedEnvironment;
  orgId: string;
  keyPair: EndpointKey;
  cloud: ControlSession;
  /** What the list already found on this network (AP-75): shown at once, without asking again. */
  found: NearbyClaimStep | null;
  onClaimed: (device: string, name: string | null, peerId: string, accountId: string) => void;
}) {
  const [step, setStep] = useState<ClaimStep>(found ?? { kind: 'looking' });
  const handedOver = useRef(found);
  /** Bumped by “Look again”: asks `claims.nearby` once more. */
  const [search, setSearch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    // The list found it just now (AP-75): no need to ask until “Look again”.
    if (search === 0 && handedOver.current) return;
    let live = true;
    // Unclaimed boxes on this network (CC-04). Anything that goes wrong here means: we couldn't find it (CC-13).
    const done = (next: ClaimStep) => {
      if (!live) return;
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
    setRefused(null);
    setStep(next);
  };

  const onClaim = async (request: ClaimRequest, typedName: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setRefused(null);
    try {
      const r = await claimAppliance({
        control: env.control,
        orgId,
        request,
        openSession: (t) =>
          openEnrollSession(env, { orgId, device: t.device, peerId: t.peerId, key: keyPair }),
        // The claim button stays disabled until the terms are ticked (LC-18).
        terms: { version: APPLIANCE_TERMS_VERSION },
        clientPeerId: keyPair.peerId,
        account: { name: cloud.account.name ?? typedName, email: cloud.account.email },
        endpoint: { label: browserLabel(), platform: 'web' },
      });
      // Only now, with the appliance's confirmation checked, is its PeerId pinned (CC-07).
      onClaimed(r.device, null, r.peerId, r.accountId);
    } catch (e) {
      if (isNotNearby(e)) {
        // The box isn't on this network (any more): we couldn't find it; look again (CC-13).
        setStep({ kind: 'none' });
        return;
      }
      const refusal = claimRefusalOf(e);
      if (refusal) {
        setRefused(
          refusal.kind === 'billing'
            ? WHOMBAT_LINK_TEXT.claimNoPlan
            : refusal.kind === 'trial_used'
              ? COPY.claim.trialUsed
              : refusal.allowed === null || refusal.allowed === undefined
                ? COPY.claim.errors.devices_allowed_reached
                : COPY.claim.errors.devices_allowed(refusal.allowed),
        );
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
    notice: refused ? <ClaimRefusalNotice text={refused} /> : null,
    onClaim: (r: ClaimRequest, name: string) => void onClaim(r, name),
  };
  const lookAgain = () => {
    go({ kind: 'looking' });
    setSearch((n) => n + 1);
  };
  if (step.kind === 'looking') return <ClaimLookingScreen />;
  if (step.kind === 'found')
    return (
      <ClaimFoundScreen
        key={step.box.device}
        {...common}
        box={step.box}
        onNotThisOne={() => go({ kind: 'none' })}
      />
    );
  if (step.kind === 'pick')
    return (
      <ClaimPickScreen
        boxes={step.boxes}
        onPick={(box) => go({ kind: 'found', box })}
        onNone={() => go({ kind: 'none' })}
      />
    );
  return <ClaimNoneScreen onLookAgain={lookAgain} />;
}

/* Recovery kit over the app channel -------------------------------------------------------------------------- */

/** A session that lives while the screen is mounted (created in the effect, so StrictMode's re-run is safe). */
function useAppSession(
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
      client: WEB_CLIENT,
      expect: channel === 'app' ? 'app' : 'any',
    });
    s.connect();
    setSession(s);
    return () => {
      s.close();
      setSession((current) => (current === s ? null : current));
    };
  }, [env, keyPair, orgId, device, peerId, channel]);
  return session;
}

function KitFlow({
  env,
  keyPair,
  known,
  onDone,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: { orgId: string; device: string; peerId: string; name: string | null };
  onDone: () => void;
}) {
  const session = useAppSession(env, keyPair, known, 'app');
  if (!session) return null;
  return (
    <RecoveryKitScreen
      session={session}
      applianceName={known.name ?? known.device}
      device={known.device}
      appliancePeerId={known.peerId}
      control={env.control}
      platform={webAuthnExists() ? PASSKEYS : null}
      onDone={onDone}
    />
  );
}

/** “Is this a new Whombat?” right after the claim, and bringing one back (backup-options.md AP-6830). */
function StartFlow({
  env,
  keyPair,
  known,
  email,
  later,
  onFresh,
  onOpenChat,
  onList,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: { orgId: string; device: string; peerId: string; name?: string | null };
  email: string;
  /**
   * From the app's Backups: `resume` where a restore stands (finish it, try again), `replace` to bring one back on a
   * Whombat that started fresh. Absent: right after the claim.
   */
  later?: 'resume' | 'replace';
  onFresh: () => void;
  onOpenChat: () => void;
  onList: () => void;
}) {
  const session = useAppSession(env, keyPair, known, 'app');
  if (!session) return null;
  return (
    <BringBackFlow
      session={session}
      control={env.control}
      platform={webAuthnExists() ? PASSKEYS : null}
      email={email}
      thisPeerId={known.peerId}
      thisName={known.name ?? null}
      device={known.device}
      {...(later ? { later } : {})}
      onFresh={onFresh}
      onOpenChat={onOpenChat}
      onList={onList}
    />
  );
}

function ProtectFlow({
  env,
  keyPair,
  known,
  onDone,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: { orgId: string; device: string; peerId: string };
  onDone: () => void;
}) {
  const session = useAppSession(env, keyPair, known, 'app');
  if (!session) return null;
  return <ProtectScreen session={session} onDone={onDone} />;
}

function PairFlow({
  env,
  keyPair,
  known,
  onApproved,
  onRecover,
  onScreen,
  onGone,
  onPasskey,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  known: { orgId: string; device: string; peerId: string };
  onApproved: (accountId: string | null) => void;
  onRecover: () => void;
  /** “Use its screen” (BX-02). */
  onScreen: () => void;
  /** The Whombat was retired, or isn't this organization's any more: nothing to ask (AP-694). */
  onGone: (reason: GoneReason) => void;
  /** A passkey for this Whombat sets this device up too (AP-806), as on Set up this device. */
  onPasskey?: () => Promise<void>;
}) {
  const session = useAppSession(env, keyPair, known, 'enroll');
  useLeaveWhenGone(session, onGone);
  useOpenWhenLetIn(session, onApproved);
  if (!session) return null;
  return (
    <PairScreen
      session={session}
      label={browserLabel()}
      fingerprint={pairingFingerprint(keyPair.peerId)}
      onApproved={onApproved}
      onRecover={onRecover}
      onScreen={onScreen}
      {...(onPasskey && { onPasskey })}
    />
  );
}

/**
 * Signing in at the box's screen (BX-02, BX-03; AP-3510), from “Let this device in” (pinned: its pin) or “Set up this
 * device” (no pin: the directory's identity, for this exchange only). A pin that differs from the directory is the hard
 * stop before anything is asked. `onDone` pins and opens; it answers words for a dead end, `changed` for the hard stop.
 */
function ScreenFlow({
  env,
  orgId,
  keyPair,
  device,
  known,
  onBack,
  onList,
  onForget,
  onGone,
  onDone,
}: {
  env: ManagedEnvironment;
  orgId: string;
  keyPair: EndpointKey;
  device: string;
  known: KnownAppliance | null;
  /** Where the flow was opened from (pairing, or Set up this device). */
  onBack: () => void;
  /** The list: where a dead end goes. */
  onList: () => void;
  onForget: () => void;
  onGone: (reason: GoneReason, name: string | null) => void;
  onDone: (
    step: Extract<ScreenSignInStep, { kind: 'enrolled' | 'already' }>,
    entry: ApplianceSummary,
    peerId: string,
  ) => string | null;
}) {
  const entry = useDirectoryEntry(env, orgId, device);
  const [stop, setStop] = useState<string | null>(null);
  const gate = (text: string) => (
    <ConnectionGate
      title={COPY.screen.title}
      text={text}
      actions={
        <Button variant="secondary" size="lg" onClick={onList}>
          {COPY.connection.back}
        </Button>
      }
    />
  );
  if (entry === null) return null;
  // Not this organization's, or retired (AP-694): nothing to ask there.
  if (entry === 'missing' || entry === 'unreachable') return gate(COPY.recover.notInOrg);
  if (isRetired(entry)) return gate(goneNotice('retired', entry.name));
  const peer = screenSignInPeer(known?.peerId, entry.contentPeerId);
  if (peer.kind === 'changed' || stop === 'changed')
    return <IdentityStopScreen stop="changed" onBack={onList} {...(known ? { onForget } : {})} />;
  if (stop) return gate(stop);
  return (
    <ScreenSession
      env={env}
      keyPair={keyPair}
      target={{ orgId, device, peerId: peer.peerId }}
      onBack={onBack}
      onGone={(reason) => onGone(reason, entry.name ?? known?.name ?? null)}
      onDone={(step) => setStop(onDone(step, entry, peer.peerId))}
    />
  );
}

function ScreenSession({
  env,
  keyPair,
  target,
  onBack,
  onGone,
  onDone,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  target: { orgId: string; device: string; peerId: string };
  onBack: () => void;
  onGone: (reason: GoneReason) => void;
  onDone: (step: Extract<ScreenSignInStep, { kind: 'enrolled' | 'already' }>) => void;
}) {
  const session = useAppSession(env, keyPair, target, 'enroll');
  useLeaveWhenGone(session, onGone);
  if (!session) return null;
  return (
    <ScreenSignInScreen
      deps={{
        session,
        device: target.device,
        appliancePeerId: target.peerId,
        clientPeerId: keyPair.peerId,
        endpoint: { label: browserLabel(), platform: 'web' },
      }}
      onDone={onDone}
      onBack={onBack}
    />
  );
}

/**
 * A link that names the Whombat's identity (add a device; AP-66, AP-67), checked against this
 * browser's pin and the directory before anything is sent (AP-64): a new pin is stored from the link, a mismatch is a
 * hard stop, and without link or pin the person is shown how to set up.
 * `named`: the link's identity; null for a link from before AP-67; undefined when no link is held.
 */
function LinkTrust({
  env,
  orgId,
  device,
  source,
  named,
  registry,
  notInOrg,
  title,
  onBack,
  onForget,
  onSetup,
  children,
}: {
  env: ManagedEnvironment;
  orgId: string;
  device: string;
  source: PinSource;
  named: string | null | undefined;
  registry: ApplianceRegistry;
  notInOrg: string;
  title: string;
  onBack: () => void;
  onForget: () => void;
  onSetup: () => void;
  children: (known: KnownAppliance) => React.ReactElement;
}) {
  const entry = useDirectoryEntry(env, orgId, device);
  const known = registry.get(device) ?? null;
  // A retired Whombat is never pinned or asked (AP-694).
  const decision =
    entry && typeof entry === 'object' && !isRetired(entry)
      ? trustDecision({ pinned: known?.peerId ?? null, named: named ?? null, directory: entry.contentPeerId })
      : null;
  const pinNow = decision?.kind === 'pin' && decision.isNew && typeof entry === 'object' ? entry : null;
  const [pinned, setPinned] = useState<KnownAppliance | null>(null);
  useEffect(() => {
    if (!pinNow || decision?.kind !== 'pin') return;
    // Pinned from the link (made by a device that trusts this Whombat), never from the directory.
    const record = pinnedRecord({ device, orgId, name: pinNow.name, peerId: decision.peerId, source });
    registry.put(record);
    setPinned(record);
  }, [pinNow, decision, device, orgId, source, registry]);

  const gate = (text: string) => (
    <ConnectionGate
      title={title}
      text={text}
      actions={
        <Button variant="secondary" size="lg" onClick={onBack}>
          {COPY.connection.back}
        </Button>
      }
    />
  );
  if (entry === null) return null;
  if (entry === 'missing' || entry === 'unreachable') return gate(notInOrg);
  if (isRetired(entry)) return gate(goneNotice('retired', entry.name));
  if (!decision) return null;
  if (decision.kind === 'changed')
    return <IdentityStopScreen stop="changed" onBack={onBack} onForget={onForget} />;
  if (decision.kind === 'mismatch') return <IdentityStopScreen stop="link" onBack={onBack} />;
  if (decision.kind === 'missing') return <GoTo navigate={onSetup} to="" />;
  const target = decision.isNew ? pinned : known;
  return target ? children(target) : null;
}

/**
 * A link that names an appliance (MR-45: `/appliances/<device>/<path>`): that Whombat is selected when this browser
 * pinned it and the directory agrees (AP-64), then its path opens; a Whombat this browser isn't let in to asks first.
 * Not pinned: set up this device. Pinned and different: the hard stop.
 */
function DeepLinkFlow({
  env,
  orgId,
  device,
  path,
  known,
  onOpen,
  onRetired,
  navigate,
}: {
  env: ManagedEnvironment;
  orgId: string;
  device: string;
  path: string;
  known: KnownAppliance | null;
  onOpen: (k: KnownAppliance) => void;
  /** The directory lists it retired: the list, which says so (AP-694). */
  onRetired: (name: string | null) => void;
  navigate: (to: string) => void;
}) {
  const entry = useDirectoryEntry(env, orgId, device);
  const opened = useRef(onOpen);
  opened.current = onOpen;
  const retired = useRef(onRetired);
  retired.current = onRetired;
  useEffect(() => {
    if (!entry) return;
    const base = `/appliances/${encodeURIComponent(device)}`;
    const go = (k: KnownAppliance) => {
      opened.current(k);
      navigate(k.enrolled ? `${path}${window.location.search}` : `${base}/pair`);
    };
    if (entry === 'missing') return navigate('/appliances');
    // Control is unreachable: a pinned Whombat still opens (its session checks the pin); nothing else does.
    if (entry === 'unreachable') return known ? go(known) : navigate('/appliances');
    if (isRetired(entry)) return retired.current(entry.name ?? known?.name ?? null);
    const decision = openDecision(known, entry.contentPeerId);
    if (decision.kind === 'unpinned') return navigate(`${base}/setup`);
    if (decision.kind === 'changed') return navigate(`${base}/identity-changed`);
    go(decision.known);
  }, [entry, known, device, path, navigate]);
  return null;
}

/**
 * Recovery with the kit (AP-41, AP-65), with this browser's (new) key. The kit (or the typed key) is checked against
 * this browser's pin and the directory first; only then does an enrollment session open, pinned to the identity this
 * browser had or the kit names. A version 1 kit or a typed key needs a pin already.
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
  if (entry === null) return null;
  // Not this organization's, or retired (AP-694): no kit lets a device in there.
  if (entry === 'missing' || entry === 'unreachable' || isRetired(entry))
    return (
      <ConnectionGate
        title={COPY.recover.title}
        text={typeof entry === 'object' ? goneNotice('retired', entry.name) : COPY.recover.notInOrg}
        actions={
          <Button variant="secondary" size="lg" onClick={onBack}>
            {COPY.connection.back}
          </Button>
        }
      />
    );
  const changed = known && known.peerId !== entry.contentPeerId;
  if (stop || changed)
    return (
      <IdentityStopScreen
        stop={stop ?? 'changed'}
        onBack={onBack}
        {...(known && (stop ?? 'changed') === 'changed' ? { onForget } : {})}
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
      endpoint: { label: browserLabel(), platform: 'web' },
      openSession: (peerId) => openEnrollSession(env, { orgId, device, peerId, key: keyPair }),
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
      onSubmit={submit}
      onBack={onBack}
    />
  );
}

export function ManagedApp({ env }: { env: ManagedEnvironment }) {
  return (
    <ThemeProvider>
      <ManagedRoot env={env} />
    </ThemeProvider>
  );
}
