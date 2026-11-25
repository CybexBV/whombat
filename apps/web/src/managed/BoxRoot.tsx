/**
 * The box's own page (HE-50; hermes-engine-app.md AP-5322): what a box serves on its direct ways — HTTPS on its own
 * address and its Tailscale name, `localhost` on a developer's machine (never plain HTTP) — talking only to its own
 * origin's direct socket: no cloud account, no control, no relay.
 *
 * It learns the box's identity from the box (`GET /v1/direct`, Whombat direct-connection.md DC-08) and pins it on first
 * use (`box`); a later page that names another identity is the hard stop. Its key is this origin's own, one script
 * can't read (`keys.ts`; docs/decisions/direct-connection.md). A browser the box doesn't know yet is let in
 * like any new device: paired from a device that's in already — or, on a development runtime from the machine itself,
 * `enroll.dev` (HE-49, CT-1257). Once in, it is the burrow app over the same session as everywhere (`ApplianceApp`).
 * A browser can instead show the box's screen for everyone (*Use as a screen*, desk-display-web.md AP-5961), with a key
 * of its own for that.
 */

import {
  COMMUNITY_TEXT,
  COPY,
  claimSecretOfPath,
  claimSecretOfTyped,
  createRegistry,
  type GoogleReturn,
  isCommunity,
  joinWithBoxPasskey,
  type KnownAppliance,
  LINK_TEXT,
  type LocalLinkParts,
  linkErrorText,
  OWN_ADDRESS_TEXT,
  type OwnClaimPrefill,
  type OwnClaimProbe,
  ownAddressText,
  ownClaimHere,
  PasskeyCancelled,
  passkeyErrorOf,
  pinnedRecord,
  probeOwnClaim,
  readGoogleReturn,
  readLocalLink,
  readOwnClaimPrefill,
  recoveryEnrollRequest,
  recoveryErrorKey,
  tailscalePageName,
} from '@whombat/client/managed';
import {
  type ApplianceSession,
  createSecureSession,
  OperationError,
  sessionOps,
} from '@whombat/client/session';
import type { DirectIdentity } from '@whombat/protocol/direct';
import { pairingFingerprint } from '@whombat/protocol/session';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ApplianceApp } from './ApplianceApp';
import { BoxSetup } from './BoxSetup';
import type { BoxEnvironment } from './boxEnv';
import { WEB_CLIENT } from './connect';
import {
  deleteEndpointKey,
  type EndpointKey,
  EndpointKeyUnavailableError,
  type EndpointKeyUnavailableReason,
  browserLabel as label,
  loadOrCreateEndpointKey,
  watchEndpointKeyDeletion,
} from './keys';
import styles from './managed.module.css';
import { PASSKEYS } from './passkeyEnv';
import { ScreenModeRoot, screenModeOn, startScreenMode } from './ScreenModeRoot';
import {
  ConnectionGate,
  ErrorLine,
  Field,
  IdentityStopScreen,
  PairScreen,
  RecoverScreen,
  ScreenSignInScreen,
} from './screens';

export { boxIdentity, ownRoute } from './boxEnv';

/** A page on the developer's own machine (`localhost`, a loopback address), where `enroll.dev` may answer (DC-17). */
export function onThisMachine(hostname: string = window.location.hostname): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\./.test(hostname);
}

/** Where the setup hands over to the app: Connect your AI (first-day.md). */
const CONNECT_AI_PATH = '/connect-ai';

/** The box's record on this page (one box per origin). */
const registry = () => createRegistry('box');
const BOX_ORG = 'box';

/** A device link the box made, opened on this page (`/add-device` with its fragment; AP-5425, AP-5675). */
function linkOnThisPage(): LocalLinkParts | null {
  return readLocalLink(window.location.href);
}

/** Leaves the link's page for the app's own (the fragment's secret is spent, AP-5425). */
function leaveLinkPage() {
  if (linkOnThisPage()) window.history.replaceState(null, '', '/');
}

/** The claim link's secret when this page was opened from the box's screen (`/c/<secret>`, own-address.md). */
function claimLinkOnThisPage(): string | null {
  return claimSecretOfPath(window.location.pathname);
}

/**
 * The name and email the account site sent along in the fragment (“Claim it now”), read once per page load and taken
 * out of the address at once, so they don't stay in it or in its history entry.
 */
let claimPrefill: OwnClaimPrefill | null = null;
function takeClaimPrefill(): OwnClaimPrefill | null {
  const read = readOwnClaimPrefill(window.location);
  if (read) {
    claimPrefill = read;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    keepSetupWay({ fromLink: read.fromLink ?? false, knowsAccount: Boolean(read.email) });
  }
  return claimPrefill;
}

/**
 * Which steps the setup counted (from the link page, with the account's email), kept for this tab so Set up your AI
 * counts the same after a reload. A convenience: without it the count is still four, with other steps' names.
 */
const SETUP_WAY_KEY = 'whombat:setup-way';
type SetupWay = { fromLink: boolean; knowsAccount: boolean };

function keepSetupWay(way: SetupWay) {
  try {
    window.sessionStorage.setItem(SETUP_WAY_KEY, JSON.stringify(way));
  } catch {
    // Blocked site data: the count after a reload names the other way's steps.
  }
}

function setupWay(): SetupWay {
  if (claimPrefill)
    return { fromLink: claimPrefill.fromLink ?? false, knowsAccount: Boolean(claimPrefill.email) };
  try {
    const kept = JSON.parse(
      window.sessionStorage.getItem(SETUP_WAY_KEY) ?? 'null',
    ) as Partial<SetupWay> | null;
    return { fromLink: kept?.fromLink === true, knowsAccount: kept?.knowsAccount === true };
  } catch {
    return { fromLink: false, knowsAccount: false };
  }
}

/**
 * A service's sign-in that came back to this page (`/connect/<service>?code=…&state=…`): a box at its own address is
 * where the service sends the browser back to. Google and Microsoft come back to the hosted app, never here.
 */
function connectReturnOnThisPage(): GoogleReturn | null {
  const back = readGoogleReturn(window.location);
  return back?.provider === 'connection' ? back : null;
}

/** Leaves the claim link's page once it is spent (the secret changes after a claim). */
function leaveClaimLinkPage() {
  if (claimLinkOnThisPage()) window.history.replaceState(null, '', '/');
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  /**
   * No key to use on this page: the browser can't keep one (`unsupported`, a secure page without WebCrypto Ed25519),
   * or it holds an older software key this page mustn't use (`weakKey`; forgetting this browser starts it again).
   */
  | { kind: 'unsupported'; reason: EndpointKeyUnavailableReason }
  | { kind: 'changed' }
  | { kind: 'signout-failed' }
  | { kind: 'enrol'; key: EndpointKey; known: KnownAppliance; box: DirectIdentity }
  | { kind: 'open'; key: EndpointKey; known: KnownAppliance; box: DirectIdentity }
  /** *Use as a screen* (desk-display-web.md AP-5961): this browser shows the box's screen for everyone. */
  | { kind: 'screen'; known: KnownAppliance };

/** The box's page: `env` is where the box comes from (`loadBoxEnvironment`, once per page). */
export function BoxRoot({ env }: { env: BoxEnvironment }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // What the claim's letters screen says after the box was asked again in the middle of a claim.
  const [claimNotice, setClaimNotice] = useState<string | null>(null);
  // Out of the address before anything else reads it, whether or not the box still needs claiming.
  useState(takeClaimPrefill);
  const [connectReturn, setConnectReturn] = useState(connectReturnOnThisPage);
  // The code and state leave the address bar and its history at once: they go only to this box, over its session.
  useEffect(() => {
    if (connectReturnOnThisPage()) window.history.replaceState(null, '', '/');
  }, []);

  const clearEnrollment = useCallback(() => {
    const r = registry();
    for (const known of r.list()) r.put({ ...known, enrolled: false });
    setPhase({ kind: 'loading' });
  }, []);

  const signOut = useCallback(async () => {
    clearEnrollment();
    try {
      await deleteEndpointKey();
      setAttempt((n) => n + 1);
    } catch {
      setPhase({ kind: 'signout-failed' });
    }
  }, [clearEnrollment]);

  useEffect(
    () =>
      watchEndpointKeyDeletion(() => {
        clearEnrollment();
        setAttempt((n) => n + 1);
      }),
    [clearEnrollment],
  );

  useEffect(() => {
    void attempt;
    let live = true;
    (async () => {
      const box = await env.identity();
      if (!live) return;
      if (!box) return setPhase({ kind: 'unreachable' });
      const peerId = box.appliance;
      const r = registry();
      const pinned = r.get(peerId) ?? r.list()[0];
      if (pinned && pinned.peerId !== peerId) return setPhase({ kind: 'changed' });
      const known =
        pinned ?? pinnedRecord({ device: peerId, orgId: BOX_ORG, name: null, peerId, source: 'box' });
      if (!pinned) r.put(known);
      let key: EndpointKey;
      try {
        key = await loadOrCreateEndpointKey();
      } catch (error) {
        if (!live) return;
        if (error instanceof EndpointKeyUnavailableError)
          return setPhase({ kind: 'unsupported', reason: error.reason });
        throw error;
      }
      if (!live) return;
      // A browser left showing the box's screen shows it again (its own key, not the person's).
      if (screenModeOn(peerId) && !linkOnThisPage()) return setPhase({ kind: 'screen', known });
      // An enrolled browser that opens a link goes on into the app: the link isn't for it.
      if (known.enrolled) leaveLinkPage();
      setPhase({ kind: known.enrolled ? 'open' : 'enrol', key, known, box });
    })();
    return () => {
      live = false;
    };
  }, [attempt, env]);

  const enrolled = useCallback((phase: Extract<Phase, { kind: 'enrol' }>, accountId: string | null) => {
    const next = { ...phase.known, enrolled: true, ...(accountId && { accountId }) };
    registry().put(next);
    leaveLinkPage();
    leaveClaimLinkPage();
    setPhase({ kind: 'open', key: phase.key, known: next, box: { ...phase.box, claimed: true } });
  }, []);

  if (phase.kind === 'loading') return null;
  if (phase.kind === 'unsupported' && phase.reason === 'weakKey')
    return (
      <ConnectionGate
        title={COPY.connection.weakKeyTitle}
        text={COPY.connection.weakKey}
        actions={
          <Button variant="primary" size="lg" onClick={() => void signOut()}>
            {COPY.connection.weakKeyForget}
          </Button>
        }
      />
    );
  if (phase.kind === 'unsupported')
    return (
      <ConnectionGate
        title={COPY.connection.signedOutTitle}
        text={COPY.connection.unsupported}
        actions={null}
      />
    );
  if (phase.kind === 'signout-failed')
    return (
      <ConnectionGate
        title="Couldn’t sign out"
        text="This browser couldn’t forget its sign-in. Try again, or clear this site’s stored data."
        actions={
          <Button variant="primary" size="lg" onClick={() => void signOut()}>
            {COPY.connection.retry}
          </Button>
        }
      />
    );
  if (phase.kind === 'screen') {
    const peerId = phase.known.peerId;
    return (
      <ScreenModeRoot
        whombat={peerId}
        connect={(key) =>
          createSecureSession({
            connector: env.connector({ peerId, key }),
            client: WEB_CLIENT,
            expect: 'any',
          })
        }
        onLeave={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (phase.kind === 'unreachable')
    return (
      <ConnectionGate
        title={BOX_TEXT.unreachableTitle}
        text={BOX_TEXT.unreachable}
        actions={
          <Button variant="primary" size="lg" onClick={() => setAttempt((n) => n + 1)}>
            {COPY.connection.retry}
          </Button>
        }
      />
    );
  if (phase.kind === 'changed')
    return (
      <IdentityStopScreen
        stop="changed"
        onBack={() => setAttempt((n) => n + 1)}
        onForget={() => {
          registry().clear();
          setAttempt((n) => n + 1);
        }}
      />
    );
  if (phase.kind === 'enrol') {
    const community = isCommunity(phase.box.edition);
    // Nobody claimed this box yet: a page it served claims it, in the one setup (whombat-link.md LNK-40). A box
    // claimed through the Whombat app (the shared route) says so, and gets today's page (`fallback`).
    if (phase.box.claimed === false && !linkOnThisPage())
      return (
        <ClaimGate
          // Asked again: the setup starts over from what the box says now.
          key={attempt}
          env={env}
          keyPair={phase.key}
          known={phase.known}
          onClaimed={(accountId) => {
            const next = { ...phase.known, enrolled: true, accountId };
            registry().put(next);
            setPhase({ ...phase, known: next });
          }}
          onDone={() => {
            // Connect your AI, the setup's last step, in the app itself (first-day.md).
            window.history.replaceState(null, '', CONNECT_AI_PATH);
            enrolled(phase, phase.known.accountId ?? null);
          }}
          onOther={() => {
            setClaimNotice(null);
            setAttempt((n) => n + 1);
          }}
          notice={claimNotice}
          onReread={(text) => {
            setClaimNotice(text);
            setAttempt((n) => n + 1);
          }}
          fallback={
            <BoxEnrol
              env={env}
              keyPair={phase.key}
              known={phase.known}
              community={community}
              onEnrolled={(accountId) => enrolled(phase, accountId)}
              onUseAsScreen={() => {
                startScreenMode(phase.known.peerId);
                setPhase({ kind: 'screen', known: phase.known });
              }}
            />
          }
        />
      );
    return (
      <BoxEnrol
        env={env}
        keyPair={phase.key}
        known={phase.known}
        community={community}
        onEnrolled={(accountId) => enrolled(phase, accountId)}
        onUseAsScreen={() => {
          startScreenMode(phase.known.peerId);
          setPhase({ kind: 'screen', known: phase.known });
        }}
      />
    );
  }
  const { key, known, box } = phase;
  return (
    <ApplianceApp
      key={`${known.device}|${key.peerId}`}
      env={{ connector: (t) => env.connector({ peerId: t.peerId, key: t.key }) }}
      orgId={BOX_ORG}
      orgName={null}
      appliance={known}
      keyPair={key}
      onSignOut={() => void signOut()}
      onSwitch={() => setAttempt((n) => n + 1)}
      onNotEnrolled={() => {
        registry().put({ ...known, enrolled: false });
        setAttempt((n) => n + 1);
      }}
      // The box's own page has no recovery kit journey and no bring back of its own: their buttons are hidden.
      onSetUpAgain={async () => {
        registry().put({ ...known, enrolled: false });
        setAttempt((n) => n + 1);
      }}
      onForget={() => void signOut()}
      onGone={() => setAttempt((n) => n + 1)}
      onAccount={(accountId) => registry().put({ ...known, enrolled: true, accountId })}
      hasOthers={false}
      page={{
        kind: 'box',
        secure: env.secure(),
        atAddress: (env.ownAddress?.() ?? null) !== null,
        host: env.ownAddress?.() ?? null,
        ...setupWay(),
      }}
      edition={box.edition ?? 'commercial'}
      connectReturn={connectReturn}
      onConnectReturned={() => setConnectReturn(null)}
    />
  );
}

/**
 * A browser the box doesn't know yet: the enrollment session on this origin's socket, then
 * - a device link the box made, opened here (AP-5425): it adds this browser to the person's account;
 * - else pairing from a device that's in already (the code and this browser's fingerprint, approved there) — on a
 *   community box after a line that says how to add this device;
 * - or the six letters the box shows on its own screen (signin-at-box.md BX-02): at the box's own address a new
 *   address has none of the person's passkeys, and nothing else may be signed in yet;
 * - or, on a development runtime from this machine, a name and an email (`enroll.dev`).
 */
function BoxEnrol({
  env,
  keyPair,
  known,
  community,
  onEnrolled,
  onUseAsScreen,
}: {
  env: BoxEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  community: boolean;
  onEnrolled: (accountId: string | null) => void;
  onUseAsScreen: () => void;
}) {
  const [session, setSession] = useState<ApplianceSession | null>(null);
  const [link, setLink] = useState(linkOnThisPage);
  // On the developer's own machine the development sign-in first, pairing a click away (HE-49); a community box
  // first says how people get in there (AP-5425).
  // At the box's own address its own passkey comes first (own-address.md); pairing a click away.
  const ownHost = env.ownAddress?.() ?? null;
  const [way, setWay] = useState<'dev' | 'welcome' | 'pair' | 'passkey' | 'recover' | 'screen'>(() =>
    ownHost ? 'passkey' : onThisMachine() ? 'dev' : community ? 'welcome' : 'pair',
  );
  useEffect(() => {
    const s = createSecureSession({
      connector: env.connector({ peerId: known.peerId, key: keyPair }),
      client: WEB_CLIENT,
      expect: 'any',
    });
    s.connect();
    setSession(s);
    return () => s.close();
  }, [env, known.peerId, keyPair]);
  if (!session) return null;
  const back = () => {
    leaveLinkPage();
    setLink(null);
  };
  if (link) {
    // The link names the box it is for: another box's link isn't sent here (AP-5425).
    if (link.appliance !== known.peerId)
      return (
        <ConnectionGate
          title={LINK_TEXT.errors.notThisBox}
          text={LINK_TEXT.errors.invalid}
          actions={
            <Button variant="primary" size="lg" onClick={back}>
              {COPY.connection.back}
            </Button>
          }
        />
      );
    // A box with its own address: only continue if it was started there or in the app (design §7.3).
    const address = link.own ? ownAddressText(link.own) : ownHost;
    return (
      <DeviceLinkScreen
        session={session}
        secret={link.secret}
        onEnrolled={onEnrolled}
        onBack={back}
        tip={address ? OWN_ADDRESS_TEXT.onlyContinue(address) : DEVICE_LINK_TIP}
      />
    );
  }
  if (way === 'passkey' && ownHost)
    return (
      <BoxPasskeyJoin
        session={session}
        keyPair={keyPair}
        onEnrolled={onEnrolled}
        onPair={() => setWay('pair')}
        onScreen={() => setWay('screen')}
        onRecover={() => setWay('recover')}
      />
    );
  if (way === 'screen')
    return (
      <ScreenSignInScreen
        deps={{
          session,
          // The box's own page has no directory: the box says which device it is when it shows the letters.
          device: null,
          appliancePeerId: known.peerId,
          clientPeerId: keyPair.peerId,
          endpoint: { label: label(), platform: 'web' },
        }}
        onDone={(step) =>
          onEnrolled(step.kind === 'enrolled' ? step.output.accountId : (known.accountId ?? null))
        }
        onBack={() => setWay(ownHost ? 'passkey' : community ? 'welcome' : 'pair')}
      />
    );
  // The recovery key lets this browser in too (own-address.md): the kit file names the account.
  if (way === 'recover')
    return (
      <RecoverScreen
        device={null}
        knownAccountId={known.accountId ?? null}
        onSubmit={async (input) => {
          if (input.kit?.appliancePeerId && input.kit.appliancePeerId !== known.peerId)
            return COPY.recover.otherWhombat;
          try {
            const done = await sessionOps.recoveryEnroll(
              session,
              recoveryEnrollRequest({
                secretKeyHex: input.secretKeyHex,
                appliancePeerId: known.peerId,
                endpointPeerId: keyPair.peerId,
                accountId: input.accountId,
                endpoint: { label: label(), platform: 'web' },
              }),
            );
            onEnrolled(done.accountId);
            return null;
          } catch (error) {
            return COPY.recover.errors[recoveryErrorKey(error)];
          }
        }}
        onBack={() => setWay(ownHost ? 'passkey' : community ? 'welcome' : 'pair')}
      />
    );
  if (way === 'dev')
    return (
      <DevEnrol
        session={session}
        onEnrolled={onEnrolled}
        onPair={() => setWay(community ? 'welcome' : 'pair')}
      />
    );
  if (way === 'welcome') return <CommunityWelcome onPair={() => setWay('pair')} />;
  return (
    <PairScreen
      session={session}
      label={label()}
      fingerprint={pairingFingerprint(keyPair.peerId)}
      onApproved={onEnrolled}
      onScreen={() => setWay('screen')}
      onUseAsScreen={onUseAsScreen}
      {...(!community && { onRecover: () => setWay('recover') })}
    />
  );
}

/** Under a device link (AP-5675): it works once, and it comes from one of the person's own devices. */
const DEVICE_LINK_TIP = 'The link works once, for 5 minutes. Only use a link you made on your own device.';

/** A device link opened here (`/add-device#…`, CT-1305): this browser joins the account that made it. */
function DeviceLinkScreen({
  session,
  secret,
  onEnrolled,
  onBack,
  tip,
}: {
  session: ApplianceSession;
  secret: string;
  onEnrolled: (accountId: string | null) => void;
  onBack: () => void;
  tip: string;
}) {
  const t = LINK_TEXT.device;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await sessionOps.linkAccept(session, {
        secret,
        endpoint: { label: label(), platform: 'web' },
      });
      onEnrolled(done.accountId);
    } catch (err) {
      setError(linkErrorText(err));
      setBusy(false);
    }
  };
  return (
    <AuthLayout kicker={COMMUNITY_TEXT.welcome.kicker} title={t.title} sub={t.sub} tip={tip}>
      <form className={styles.form} onSubmit={(e) => void join(e)}>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {busy ? t.joining : t.join}
          </Button>
          <Button variant="link" onClick={onBack}>
            {COPY.connection.back}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * An unclaimed box: claimed on a page it served (`probeOwnClaim`: the box takes a claim here). At its own address without
 * the claim link, the page says where to find it; a box with the shared route (claimed through the Whombat app) gets
 * today's page (`fallback`).
 */
function ClaimGate({
  env,
  keyPair,
  known,
  onClaimed,
  onDone,
  onOther,
  notice,
  onReread,
  fallback,
}: {
  env: BoxEnvironment;
  keyPair: EndpointKey;
  known: KnownAppliance;
  onClaimed: (accountId: string) => void;
  onDone: () => void;
  /** Someone else claimed it meanwhile: ask the box again. */
  onOther: () => void;
  /** What the letters screen says first (the box was asked again in the middle of a claim). */
  notice: string | null;
  /** A claim lost its connection or its proof: ask the box again, then the letters with `text`. */
  onReread: (text: string) => void;
  fallback: ReactNode;
}) {
  const [probe, setProbe] = useState<OwnClaimProbe | null>(null);
  const [claimLink, setClaimLink] = useState(claimLinkOnThisPage);
  // The claim link typed on this page (the box's address opened without it): a refusal now means it was wrong.
  const [typed, setTyped] = useState(false);
  const [prefill] = useState(takeClaimPrefill);
  const ownHost = env.ownAddress?.() ?? null;
  useEffect(() => {
    let live = true;
    const s = createSecureSession({
      connector: env.connector({ peerId: known.peerId, key: keyPair }),
      client: WEB_CLIENT,
      expect: 'any',
      // At the box's own address the claim link gets this session a place kept for the visitor who has it.
      claimLink,
    });
    s.connect();
    // The probe's session ends once it answered: the box takes one unknown device's session per address at a time,
    // and the setup opens its own.
    probeOwnClaim(s, claimLink).then((p) => {
      s.close();
      if (live) setProbe(p);
    });
    return () => {
      live = false;
      s.close();
    };
  }, [env, known.peerId, keyPair, claimLink]);
  useEffect(() => {
    if (probe === 'claimed') onOther();
  }, [probe, onOther]);
  if (probe === null || probe === 'claimed') return null;
  if (probe === 'needs_link')
    return (
      <ClaimLinkForm
        wrong={typed}
        onLink={(secret) => {
          // The page becomes the claim link's own, as if opened from the screen; the box is asked again with it.
          window.history.replaceState(null, '', `/c/${secret}`);
          setTyped(true);
          setProbe(null);
          setClaimLink(secret);
        }}
      />
    );
  if (!ownClaimHere(probe)) return <>{fallback}</>;
  return (
    <BoxSetup
      env={env}
      keyPair={keyPair}
      known={known}
      atAddress={ownHost !== null}
      claimLink={claimLink}
      prefill={prefill}
      // Too many tries on the letters showing: the setup stays, and says what to do at the box.
      notice={probe === 'new_letters' ? COMMUNITY_TEXT.claim.errors.newLetters : notice}
      onReread={onReread}
      tailscaleName={tailscalePageName(window.location.hostname)}
      onClaimed={(accountId) => {
        leaveClaimLinkPage();
        onClaimed(accountId);
      }}
      onTaken={onOther}
      onDone={onDone}
    />
  );
}

/**
 * The box's address opened without its claim link (from Your Whombats, or typed without `/c/…`): the six letters after
 * `/c/` on its screen are asked here, so nobody has to type the whole address again. A wrong one is the box's to count,
 * as a wrong link in the address is.
 */
function ClaimLinkForm({ wrong, onLink }: { wrong: boolean; onLink: (secret: string) => void }) {
  const t = OWN_ADDRESS_TEXT.openOnScreen;
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(wrong ? t.wrong : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const secret = claimSecretOfTyped(value);
    if (!secret) return setProblem(t.notLetters);
    setProblem(null);
    onLink(secret);
  };
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.typeSub} tip={COMMUNITY_TEXT.claim.tip}>
      <form className={styles.form} onSubmit={submit}>
        <Field label={t.label}>
          {(id) => (
            <Input
              id={id}
              size="lg"
              className={styles.codeInput}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t.placeholder}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setProblem(null);
              }}
              autoFocus
            />
          )}
        </Field>
        <ErrorLine text={problem} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={!value.trim()}>
            {t.next}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * At the box's own address, a browser it doesn't know (design §7.3): its own passkey lets this browser in
 * (`boxPasskey.enroll`, bound to this browser's key). Pairing stays a click away.
 */
function BoxPasskeyJoin({
  session,
  keyPair,
  onEnrolled,
  onPair,
  onScreen,
  onRecover,
}: {
  session: ApplianceSession;
  keyPair: EndpointKey;
  onEnrolled: (accountId: string | null) => void;
  onPair: () => void;
  /** The letters on the box's own screen: the way in when this address has none of the person's passkeys yet. */
  onScreen: () => void;
  onRecover: () => void;
}) {
  const t = OWN_ADDRESS_TEXT.join;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await joinWithBoxPasskey({
        session,
        platform: PASSKEYS,
        endpointPeerId: keyPair.peerId,
        endpoint: { label: label(), platform: 'web' },
      });
      onEnrolled(done.accountId);
    } catch (e) {
      if (!(e instanceof PasskeyCancelled)) setError(passkeyErrorOf(e) === 'unsupported' ? t.none : t.failed);
      setBusy(false);
    }
  };
  const w = COMMUNITY_TEXT.welcome;
  return (
    <AuthLayout kicker={w.kicker} title={w.title} sub={w.sub} tip={w.tip}>
      <div className={styles.form}>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void join()}>
            {busy ? t.signingIn : t.use}
          </Button>
          <Button variant="link" onClick={onScreen}>
            {COPY.screen.use}
          </Button>
          <Button variant="link" onClick={onPair}>
            {w.pair}
          </Button>
          <Button variant="link" onClick={onRecover}>
            {COPY.recover.entry}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

/** A claimed community box, a browser it doesn't know and no link (AP-5425): how the person adds it. */
function CommunityWelcome({ onPair }: { onPair: () => void }) {
  const t = COMMUNITY_TEXT.welcome;
  return (
    <AuthLayout kicker={t.kicker} title={t.title} sub={t.sub} tip={t.tip}>
      <div className={styles.actions}>
        <Button variant="secondary" size="lg" onClick={onPair}>
          {t.pair}
        </Button>
      </div>
    </AuthLayout>
  );
}

/** `enroll.dev` (HE-49): the developer's name and email; a box that isn't a development runtime refuses it. */
function DevEnrol({
  session,
  onEnrolled,
  onPair,
}: {
  session: ApplianceSession;
  onEnrolled: (accountId: string | null) => void;
  onPair: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await sessionOps.enrollDev(session, {
        account: { name: name.trim(), email: email.trim() },
        endpoint: { label: label(), platform: 'web' },
      });
      onEnrolled(done.accountId ?? null);
    } catch (e) {
      setError(
        e instanceof OperationError && e.code === 'forbidden' ? BOX_TEXT.devRefused : BOX_TEXT.devFailed,
      );
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      kicker={BOX_TEXT.devKicker}
      title={BOX_TEXT.devTitle}
      sub={BOX_TEXT.devSub}
      tip={BOX_TEXT.devTip}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={BOX_TEXT.devName}>
          {(id) => (
            <Input
              id={id}
              size="lg"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={BOX_TEXT.devEmail}>
          {(id) => (
            <Input
              id={id}
              type="email"
              size="lg"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <ErrorLine text={error} />
        <div className={styles.actions}>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !name.trim() || !email.trim()}>
            {BOX_TEXT.devGo}
          </Button>
          <Button variant="ghost" size="lg" type="button" onClick={onPair}>
            {BOX_TEXT.devPair}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

/** The box page's own words (AP-5322). */
export const BOX_TEXT = {
  unreachableTitle: 'Can’t reach this Whombat',
  unreachable: 'This page couldn’t reach the Whombat that served it. Check that it’s on and try again.',
  devKicker: 'DEVELOPMENT',
  devTitle: 'Sign in on this machine',
  devSub: 'A development Whombat lets this browser in with a name and an email.',
  devTip: 'A real Whombat never does: there, a device that’s in already lets this browser in.',
  devName: 'Name',
  devEmail: 'Email',
  devGo: 'Sign in',
  devPair: 'Pair with another device',
  devRefused: 'This Whombat isn’t a development one, so it lets devices in only by pairing.',
  devFailed: 'That didn’t work. Try again.',
} as const;
