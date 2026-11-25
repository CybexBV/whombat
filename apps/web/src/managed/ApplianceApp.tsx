/**
 * The burrow app over an end-to-end session with one appliance (AP-10…AP-17): the secure session (app channel,
 * pinned to the appliance identity), the app's services on it (client, realtime over subscriptions, decrypted
 * resources, command states), the cache scope guard (clears on account/permission change, revocation, sign-out),
 * the quiet connection strip and the full-page states a session can end in.
 */

import {
  appPath,
  createClient,
  itemsNeedNewerApp,
  leftOut,
  PART_NEEDS_NEWER_APP,
  withBurrow,
} from '@whombat/client';
import {
  COPY,
  fingerprintOf,
  finishGoogleConnection,
  type GoneReason,
  type GoogleReturn,
  goneOf,
  googleFinishStep,
  heldGoogleConnect,
  holdGoogleConnect,
  type KnownAppliance,
  type ManagedWhombats,
  pushKindOf,
  pushTarget,
  resolvePushRef,
  withConnectError,
} from '@whombat/client/managed';
import {
  type ApplianceSession,
  type ConnectionState,
  clearable,
  createScopeGuard,
  type DisconnectReason,
  type ScopeGuard,
  scopeFromInfo,
} from '@whombat/client/session';
import type { LinkRef } from '@whombat/core';
import type { DirectAddresses, Edition } from '@whombat/protocol/session';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { App } from '../app/App';
import { type AppServices, createAppServices, type ManagedContext } from '../app/services';
import { Button } from '../components/Button';
import { clearSvgCache } from '../features/messaging/attachmentSource';
import { clearDrafts } from '../features/messaging/ConversationRoom';
import { resetUploads } from '../features/messaging/useUploads';
import type { ManagedEnvironment } from './connect';
import type { EndpointKey } from './keys';
import styles from './managed.module.css';
import { PASSKEYS, webAuthnExists } from './passkeyEnv';
import { createOpening, type Opening } from './prepareOpening';
import { ConnectionGate, IdentityStopScreen } from './screens';
import { createBoxWebPush, createManagedWebPush, readPushTap } from './webPush';

export interface ApplianceAppProps {
  /** Claim the connection prepared for this pinned appliance, if it is still available. */
  takePrepared?: (appliance: KnownAppliance) => Opening | undefined;
  /** Where its connections come from; the box's own page has no control (no push through it, no other Whombats). */
  env: Pick<ManagedEnvironment, 'connector'> & { control?: ManagedEnvironment['control'] };
  orgId: string;
  /** The organization's name: a new burrow starts with it (AP-75). */
  orgName: string | null;
  appliance: KnownAppliance;
  keyPair: EndpointKey;
  onSignOut: () => void;
  onSwitch: () => void;
  onNotEnrolled: () => void;
  /** “Make a kit” (a Whombat from before the passkey); absent: hidden. */
  onKit?: () => void;
  /** Bringing a Whombat back (`ManagedContext.onBringBack`); absent: hidden. */
  onBringBack?: (later: boolean) => void;
  /** This device was removed: a new key, then ask to be let in again (AP-39) or use the recovery kit (AP-41). */
  onSetUpAgain: (then: 'pair' | 'recover') => Promise<void>;
  /** Forget this Whombat on this device (after the hard stop of an identity that doesn't match, AP-64). */
  onForget: () => void;
  /**
   * Control ended the session for good because this Whombat can't be opened any more (AP-694): retired, or not this
   * organization's. The list says why.
   */
  onGone: (reason: GoneReason) => void;
  /** The account this device acts as there (remembered for recovery, AP-41). */
  onAccount: (accountId: string) => void;
  /** The box's direct ways changed (`welcome.direct`): remember them for the next connection (HE-50). */
  onDirect?: (direct: DirectAddresses | null) => void;
  /** Other Whombats this device knows (they'll ask to let it in again too). */
  hasOthers: boolean;
  /** The burrow name's menu (whombat-switcher.md AP-3080); none on the box's own page. */
  whombats?: ManagedWhombats;
  /** The box's own page (AP-5325): what it can't do is said plainly. */
  page?: ManagedContext['page'];
  /**
   * The box's edition as its page learnt it before connecting (`DirectIdentity.edition`, CT-1300); each session's
   * `welcome.edition` says it too (AP-5400, AP-5429).
   */
  edition?: Edition;
  /**
   * A service's sign-in that came back to the box's own page (`/connect/<service>` at its own address): finished over
   * this session before the app shows, then `onConnectReturned` with the address set to where the box answered.
   */
  connectReturn?: GoogleReturn | null;
  onConnectReturned?: () => void;
}

export function ApplianceApp({
  takePrepared,
  env,
  orgId,
  orgName,
  appliance,
  keyPair,
  onSignOut,
  onSwitch,
  onNotEnrolled,
  onKit,
  onBringBack,
  onSetUpAgain,
  onForget,
  onGone,
  onAccount,
  onDirect,
  hasOthers,
  whombats,
  page,
  edition,
  connectReturn,
  onConnectReturned,
}: ApplianceAppProps) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [state, setState] = useState<ConnectionState>({ status: 'idle' });
  // Callbacks may change identity between renders; the session lives as long as this component (keyed by
  // appliance and key), so it reads the latest ones.
  const callbacks = useRef({ onSignOut, onSwitch, onKit, onBringBack, whombats });
  callbacks.current = { onSignOut, onSwitch, onKit, onBringBack, whombats };
  const current = useRef(appliance);
  current.current = appliance;
  const currentOrgName = useRef(orgName);
  currentOrgName.current = orgName;
  const { device, peerId } = appliance;

  // A new session only for another appliance, identity or key (device and peerId stand for the appliance).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const s = createSetup({
      opening: takePrepared?.(current.current),
      env,
      orgId,
      orgName: currentOrgName.current,
      appliance: current.current,
      keyPair,
      onSignOut: () => callbacks.current.onSignOut(),
      onSwitch: () => callbacks.current.onSwitch(),
      ...(onKit && { onKit: () => callbacks.current.onKit?.() }),
      ...(onBringBack && { onBringBack: (later: boolean) => callbacks.current.onBringBack?.(later) }),
      direct: () => current.current.direct,
      page,
      edition,
      whombats: whombats && {
        list: () => callbacks.current.whombats?.list() ?? Promise.resolve([]),
        known: (d) => callbacks.current.whombats?.known(d),
        connect: (d) => callbacks.current.whombats?.connect?.(d) ?? null,
        open: (a) => {
          callbacks.current.whombats?.open(a);
        },
        claim: () => callbacks.current.whombats?.claim(),
      },
    });
    // What the last Whombat sent doesn't count for this one (AP-266).
    leftOut.reset();
    const offGuard = s.guard.watch(s.raw, orgId);
    const offState = s.raw.onState(setState);
    // A prepared session may already have welcomed us before the app mounted.
    const initial = s.raw.state();
    if (initial.status === 'open') s.guard.enter(scopeFromInfo(orgId, initial.info));
    setState(initial);
    s.raw.connect();
    // The photos' connection beside it, so the first faces don't wait for a second handshake (open-speed.md AP-4406).
    s.raw.warmBulk?.();
    const wake = () => {
      if (document.visibilityState !== 'hidden') s.raw.reconnectNow();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    setSetup(s);
    return () => {
      offGuard();
      offState();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      s.raw.close();
      // Leaving this appliance (switch, sign-out): nothing of it stays in memory.
      void s.guard.clearAll('signed_out');
      setSetup((current) => (current === s ? null : current));
    };
  }, [env, orgId, device, peerId, keyPair]);

  useEffect(() => {
    if (state.status === 'closed' && state.reason === 'not_enrolled') onNotEnrolled();
  }, [state, onNotEnrolled]);
  // Retired, or not this organization's any more (AP-694): back to the list, which says so.
  const gone = goneOf(state);
  const goneCb = useRef(onGone);
  goneCb.current = onGone;
  useEffect(() => {
    if (gone) goneCb.current(gone);
  }, [gone]);
  // The ways in, as each welcome says them: kept with the box for the next connection (AP-5302).
  const direct = state.status === 'open' ? state.info.direct : undefined;
  const directKey = direct === undefined ? null : JSON.stringify(direct);
  const directCb = useRef(onDirect);
  directCb.current = onDirect;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `directKey` stands for `direct`.
  useEffect(() => {
    if (direct !== undefined && directKey !== JSON.stringify(current.current.direct ?? null))
      directCb.current?.(direct);
  }, [directKey]);
  const accountId = state.status === 'open' ? state.info.account?.id : undefined;
  const accountCb = useRef(onAccount);
  accountCb.current = onAccount;
  useEffect(() => {
    if (accountId) accountCb.current(accountId);
  }, [accountId]);

  // A browser notification was clicked (`/?push=<kind>&ref=<ref>`): once connected, ask the appliance what its ref
  // is about (`push.resolve`, CT-49) and open it; the push itself names only a kind and an opaque ref.
  const opened = state.status === 'open';
  const tapHandled = useRef(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  useEffect(() => {
    if (!opened || !setup || tapHandled.current) return;
    const tap = readPushTap(window.location.search);
    if (!tap) return;
    tapHandled.current = true;
    void resolvePushTap(setup, tap).then(({ path, note }) => {
      window.history.replaceState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
      if (note) setPushNote(note);
    });
  }, [opened, setup]);
  useEffect(() => {
    if (!pushNote) return;
    const t = setTimeout(() => setPushNote(null), 8000);
    return () => clearTimeout(t);
  }, [pushNote]);

  // A sign-in that came back here: its code is single use, so it is sent once, whatever StrictMode or a reconnect does.
  const returnSent = useRef(false);
  const returnedCb = useRef(onConnectReturned);
  returnedCb.current = onConnectReturned;
  useEffect(() => {
    if (!connectReturn || !setup) return;
    const fallback = heldGoogleConnect(tabStorage)?.returnTo ?? '/connections';
    const done = (to: string) => {
      holdGoogleConnect(tabStorage, null);
      window.history.replaceState(null, '', to);
      returnedCb.current?.();
    };
    if (!connectReturn.state) {
      if (!returnSent.current) done(withConnectError(fallback, 'invalid_state'));
      returnSent.current = true;
      return;
    }
    const step = (s: ConnectionState) => {
      const next = googleFinishStep(s, returnSent.current);
      if (next === 'wait') return;
      returnSent.current = true;
      if (next === 'give_up') done(withConnectError(fallback, 'exchange_failed'));
      else
        finishGoogleConnection(setup.raw, connectReturn).then(done, () =>
          done(withConnectError(fallback, 'exchange_failed')),
        );
    };
    step(setup.raw.state());
    return setup.raw.onState(step);
  }, [connectReturn, setup]);

  if (state.status === 'closed')
    return (
      <Gate
        reason={state.reason}
        onSwitch={onSwitch}
        onSignOut={onSignOut}
        onSetUpAgain={onSetUpAgain}
        onForget={onForget}
        hasOthers={hasOthers}
      />
    );
  if (!setup) return null;
  if (connectReturn)
    return (
      <ConnectionGate
        title="Connecting…"
        text={`Finishing on ${appliance.name ?? 'your Whombat'}. This takes a moment.`}
        actions={null}
      />
    );
  return (
    <>
      <div className={styles.strips}>
        <ConnectionStrip state={state} onRetry={() => setup.raw.reconnectNow()} />
        <LeftOutStrip />
        {pushNote && (
          <div className={styles.banner} role="status" aria-live="polite">
            <span>{pushNote}</span>
          </div>
        )}
      </div>
      {/* `App` keeps the services it first got (its router is built on them): a new setup is a new App. */}
      <App key={setup.id} services={setup.services} />
    </>
  );
}

/**
 * Nothing left out silently (AP-266): list items only a newer app can show (“1 item needs a newer version of the
 * app.”), or a security view's answer this app can't read (“Part of this page needs a newer version of the app.”),
 * with Reload. Counts the answers on screen now; gone when they read fine again.
 */
export function LeftOutStrip() {
  const now = useSyncExternalStore(leftOut.subscribe, leftOut.get, leftOut.get);
  const text = now.needsNewer ? PART_NEEDS_NEWER_APP : now.items > 0 ? itemsNeedNewerApp(now.items) : null;
  if (!text) return null;
  return (
    <div className={`${styles.banner} ${styles.bannerWarn}`} role="status" data-testid="left-out-strip">
      <span>{text}</span>
      <Button variant="ghost" size="xs" onClick={() => window.location.reload()}>
        {RELOAD}
      </Button>
    </div>
  );
}

const RELOAD = 'Reload';

/**
 * Where a clicked browser notification leads: the link its ref resolves to; the inbox with a quiet note when the
 * appliance doesn't find it (gone, or no longer visible to this person); by its kind over the inbox only when the
 * appliance predates `push.resolve`. Burrow-less paths naming their burrow (`?burrow=`, AP-365): a push may be about
 * another burrow than the open one.
 */
async function resolvePushTap(
  setup: Setup,
  tap: { kind: string; ref: string },
): Promise<{ path: string; note?: string }> {
  const open = await resolvePushRef(setup.raw, tap.ref);
  if (open.to === 'link') return { path: withBurrow(appPath(open.link), open.burrow) };
  if (open.to === 'by_kind') return { path: await resolveByKind(setup.services, tap) };
  const burrow = await setup.services.client.me
    .get({})
    .then((me) => me.memberships[0]?.burrowSlug ?? null)
    .catch(() => null);
  // The web's inbox is Needs you (the burrow's asks).
  return {
    path: burrow ? withBurrow('/log?kind=asks', burrow) : '/',
    ...(open.missing && { note: COPY.push.notFound }),
  };
}

/** The fallback for an appliance without `push.resolve`: the newest unread inbox row of the push's kind. */
async function resolveByKind(services: AppServices, tap: { kind: string; ref: string }): Promise<string> {
  try {
    const me = await services.client.me.get({});
    const burrow = me.memberships[0]?.burrowSlug;
    if (!burrow) return '/';
    const inbox = await services.client.notifications.inbox({ params: { burrow }, query: { filter: 'all' } });
    const target = pushTarget(
      pushKindOf(tap.kind),
      burrow,
      inbox.sections.flatMap((s) => s.items),
    );
    if (target.to === 'item') {
      void services.client.notifications
        .markRead({ params: { burrow }, body: { ids: [target.item.id] } })
        .catch(() => {});
      return withBurrow(appPath(target.item.link as LinkRef), burrow);
    }
    return withBurrow(target.to === 'appliance' ? '/settings?tab=appliance' : '/', burrow);
  } catch {
    return '/';
  }
}

interface Setup {
  /** Tells setups apart (a new one mounts a new `App`). */
  id: number;
  raw: ApplianceSession;
  services: AppServices;
  guard: ScopeGuard;
}

let setups = 0;

/** This tab's storage, where a sign-in's start is held (reaching it may throw). */
const tabStorage = () => window.sessionStorage;

function createSetup(input: {
  opening?: Opening;
  env: ApplianceAppProps['env'];
  orgId: string;
  orgName: string | null;
  appliance: KnownAppliance;
  keyPair: EndpointKey;
  onSignOut: () => void;
  onSwitch: () => void;
  onKit?: () => void;
  onBringBack?: (later: boolean) => void;
  whombats: ManagedWhombats | undefined;
  /** The box's direct ways as last remembered (read on every connection). */
  direct: () => DirectAddresses | null | undefined;
  page: ManagedContext['page'];
  edition: Edition | undefined;
}): Setup {
  const { env, orgId, appliance, keyPair } = input;
  const { session: raw, timing } = input.opening ?? createOpening(input);
  timing.mark('selected');
  const services = createAppServices({
    session: raw,
    managed: {
      applianceId: appliance.device,
      applianceName: appliance.name,
      deviceFingerprint: keyPair.fingerprint,
      appliancePeerId: appliance.peerId,
      applianceFingerprint: fingerprintOf(appliance.peerId),
      // No kit step since BX-01: an old record's `true` asks for nothing (AP-3506).
      kitPending: false,
      ...(input.onKit && { onKit: input.onKit }),
      ...(input.onBringBack && { onBringBack: input.onBringBack }),
      signOut: input.onSignOut,
      switchAppliance: input.onSwitch,
      ...(input.whombats && { whombats: input.whombats }),
      ...(env.control
        ? {
            push: createManagedWebPush({ control: env.control, session: raw, device: appliance.device }),
            control: env.control,
          }
        : // The box's own page: notifications from the box itself where the page is secure (HE-61, AP-5428).
          input.page?.secure && { push: createBoxWebPush({ client: createClient({ session: raw }) }) }),
      orgId,
      orgName: input.orgName,
      // Passkeys belong to the hosted app's name: never on the box's own page (DC-11).
      passkeys: !input.page && webAuthnExists() ? PASSKEYS : null,
      devicePeerId: keyPair.peerId,
      ...(input.page && { page: input.page }),
      ...(input.edition && { edition: input.edition }),
    },
  });
  services.openTiming = timing;
  // Everything cached from this appliance (AP-17): queries, decrypted files and SVGs, command states, drafts, chips.
  const guard = createScopeGuard([
    clearable(services.queryClient),
    services.resources ?? { clear: () => {} },
    clearable(services.commands),
    { clear: () => resetUploads() },
    { clear: () => clearDrafts() },
    { clear: () => clearSvgCache() },
  ]);
  return { id: ++setups, raw, services, guard };
}

/** Quiet one-line strip while not connected; nothing when open (and nothing for invisible rekeys). */
export function ConnectionStrip({ state, onRetry }: { state: ConnectionState; onRetry: () => void }) {
  const [shown, setShown] = useState(false);
  const trouble = state.status === 'reconnecting' && state.reason !== 'rekey';
  useEffect(() => {
    if (!trouble) {
      setShown(false);
      return;
    }
    // Brief blips stay invisible.
    const t = setTimeout(() => setShown(true), 1500);
    return () => clearTimeout(t);
  }, [trouble]);
  if (!trouble || !shown || state.status !== 'reconnecting') return null;
  const text =
    state.reason === 'offline'
      ? COPY.connection.offline
      : state.reason === 'appliance_offline'
        ? COPY.connection.applianceOffline
        : state.reason === 'appliance_unlisted'
          ? COPY.connection.unlisted
          : state.reason === 'busy'
            ? COPY.connection.busy
            : COPY.connection.reconnecting;
  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <span>{text}</span>
      <Button variant="ghost" size="xs" onClick={onRetry}>
        {COPY.connection.retry}
      </Button>
    </div>
  );
}

function Gate({
  reason,
  onSwitch,
  onSignOut,
  onSetUpAgain,
  onForget,
  hasOthers,
}: {
  reason: DisconnectReason;
  onSwitch: () => void;
  onSignOut: () => void;
  onSetUpAgain: (then: 'pair' | 'recover') => Promise<void>;
  onForget: () => void;
  hasOthers: boolean;
}) {
  const back = (
    <Button variant="secondary" size="lg" onClick={onSwitch}>
      {COPY.connection.back}
    </Button>
  );
  switch (reason) {
    case 'client_too_old':
      return (
        <ConnectionGate
          title={COPY.connection.clientTooOldTitle}
          text={COPY.connection.clientTooOld}
          actions={
            <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
              {COPY.connection.reload}
            </Button>
          }
        />
      );
    case 'client_below_floor':
      // Below the appliance's security floor (CT-53): only a newer build of this page helps.
      return (
        <ConnectionGate
          title={COPY.connection.belowFloorTitle}
          text={COPY.connection.belowFloor}
          actions={
            <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
              {COPY.connection.reload}
            </Button>
          }
        />
      );
    case 'appliance_too_old':
      return (
        <ConnectionGate
          title={COPY.connection.applianceTooOldTitle}
          text={COPY.connection.applianceTooOld}
          actions={back}
        />
      );
    case 'identity_mismatch':
      // What answered isn't the identity this browser pinned: the hard stop, never a new pin (AP-64).
      return <IdentityStopScreen stop="changed" onBack={onSwitch} onForget={onForget} />;
    case 'revoked':
      // A revoked key stays revoked (MA-04 §6): being let in again needs a new key (AP-39).
      return (
        <ConnectionGate
          title={COPY.connection.revokedTitle}
          text={
            hasOthers
              ? `${COPY.connection.revoked} ${COPY.connection.revokedOthers}`
              : COPY.connection.revoked
          }
          actions={
            <>
              <SetUpAgain onSetUpAgain={onSetUpAgain} />
              <Button variant="secondary" size="lg" onClick={() => void onSetUpAgain('recover')}>
                {COPY.recover.entry}
              </Button>
              {back}
            </>
          }
        />
      );
    case 'ticket_denied':
      return (
        <ConnectionGate
          title={COPY.connection.signedOutTitle}
          text={COPY.connection.signedOut}
          actions={
            <Button variant="primary" size="lg" onClick={onSignOut}>
              {COPY.connection.signIn}
            </Button>
          }
        />
      );
    default:
      // `not_enrolled` goes to pairing, a retired or departed Whombat to the list (AP-694); `closed` is our own doing.
      return null;
  }
}

function SetUpAgain({ onSetUpAgain }: { onSetUpAgain: (then: 'pair') => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      size="lg"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onSetUpAgain('pair').catch(() => setBusy(false));
      }}
    >
      {busy ? COPY.connection.settingUp : COPY.connection.setUpAgain}
    </Button>
  );
}
