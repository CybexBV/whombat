/**
 * A community Whombat on the phone, without a cloud account (Whombat hermes-engine.md HE-58…HE-60; hermes-engine-app.md
 * AP-5471, AP-5472): **Add this phone with a link** — the QR code your other device shows, or the link from it — then,
 * over an enrollment session straight to the box (its local network or Tailscale name from the link, pinned to the
 * PeerId the link names), the device link adds this phone to your account. Once in, the box is remembered
 * in the phone's community registry and opens on its direct ways only — never the relay, never control — now and on
 * later launches, as `ApplianceRoot` in its community shape.
 *
 * There are no Android App Links for a box's own page (an address on a home network or a tailnet can't be verified for
 * an app), so a link reaches the app by scanning its QR code or pasting it (AP-5471).
 */
import {
  type ApplianceRegistry,
  type ControlApi,
  forgetEnrollments,
  joinWithLink,
  type KnownAppliance,
  knownSummaries,
  LINK_TEXT,
  type LocalLinkParts,
  linkErrorText,
  pairingFingerprint,
} from '@whombat/client/managed';
import { type ApplianceSession, type ConnectionState, createSecureSession } from '@whombat/client/session';
import { DIRECT_PATH, DirectIdentity } from '@whombat/protocol/direct';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler } from 'react-native';
import { WhombatLive } from '../../modules/whombat-live';
import { UpdateRow } from '../settings/UpdateCard';
import { Button, Loading } from '../ui/primitives';
import { ApplianceRoot } from './ApplianceRoot';
import {
  addressRecord,
  type BoxAddress,
  boxAddressOrigin,
  COMMUNITY_ORG,
  communityRecord,
  linkAddresses,
  onLocalNetwork,
  PHONE_COMMUNITY_TEXT,
  readBoxAddress,
  scannedLocalLink,
} from './community';
import { APP_BUILD } from './config';
import type { createLinkBus, createPushTaps } from './context';
import { type EndpointKey, type ManagedEnvironment, PHONE_PLATFORM, phoneClient, phoneLabel } from './env';
import { LocalClaim } from './LocalClaim';
import { QrScanner } from './QrScanner';
import { ScreenSignInSteps } from './ScreenSignInScreens';
import { PairScreen } from './screens';
import { Card, ErrorLine, Field, Frame, Note, Row } from './ui';
import { useAppUpdate } from './useAppUpdate';

const P = PHONE_COMMUNITY_TEXT;

export type CommunityRoute =
  | { name: 'join'; note?: string | null }
  | { name: 'link'; link: LocalLinkParts }
  /** A box's address typed on the first screen (LNK-08). */
  | { name: 'address'; address: BoxAddress }
  | { name: 'open' };

export interface CommunityAppProps {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  /** The community boxes this phone knows (`COMMUNITY_REGISTRY`). */
  registry: ApplianceRegistry;
  start: CommunityRoute;
  /** Back to the first screen (signed out of this box here; it stays known). */
  onLeave: () => void;
  /** This phone's key was removed there: a new key (the box is joined again with a new link, AP-39). */
  rekey: () => Promise<void>;
  taps: ReturnType<typeof createPushTaps>;
  links: ReturnType<typeof createLinkBus>;
  addSignOutTask: (task: (session: ApplianceSession | null) => Promise<void>) => () => void;
}

export function CommunityApp(props: CommunityAppProps) {
  const { env, keyPair, registry, onLeave } = props;
  const [route, setRoute] = useState<CommunityRoute>(props.start);
  const [, bump] = useState(0);
  const join = useCallback((note?: string | null) => setRoute({ name: 'join', note: note ?? null }), []);

  // Android back: out of a link to the scanner, out of the scanner to the first screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'link' || route.name === 'address') {
        join();
        return true;
      }
      if (route.name === 'join') {
        onLeave();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [route, join, onLeave]);

  if (route.name === 'join')
    return (
      <JoinLinkScreen
        note={route.note ?? null}
        onLink={(link) => setRoute({ name: 'link', link })}
        onBack={onLeave}
      />
    );
  if (route.name === 'link')
    return (
      <LinkJoinFlow
        key={`${route.link.appliance}|${route.link.secret}`}
        env={env}
        keyPair={keyPair}
        link={route.link}
        onBack={() => join()}
        onJoined={(accountId) => {
          const known = registry.get(route.link.appliance);
          // The pin is the link's PeerId, which is also the record's device id: a record for it never disagrees.
          registry.put({
            ...communityRecord(route.link, true, accountId),
            ...(known?.name && { name: known.name }),
          });
          registry.setLastUsed(route.link.appliance);
          setRoute({ name: 'open' });
        }}
      />
    );

  if (route.name === 'address')
    return (
      <AddressJoinFlow
        key={`${route.address.host}:${route.address.port}`}
        env={env}
        keyPair={keyPair}
        address={route.address}
        onBack={onLeave}
        onJoined={(record, accountId) => {
          const known = registry.get(record.device);
          registry.put({
            ...record,
            enrolled: true,
            ...(accountId && { accountId }),
            ...(known?.name && { name: known.name }),
          });
          registry.setLastUsed(record.device);
          setRoute({ name: 'open' });
        }}
      />
    );

  const last = registry.lastUsed();
  const active = last ? registry.get(last) : undefined;
  if (!active?.enrolled) return <GoJoin go={() => join()} />;
  const leave = () => {
    registry.setLastUsed(null);
    void WhombatLive.clearStatusWidget().catch(() => {});
    onLeave();
  };
  return (
    <ApplianceRoot
      key={`${active.device}|${keyPair.peerId}`}
      community
      env={env}
      orgId={COMMUNITY_ORG}
      orgName={null}
      appliance={active}
      keyPair={keyPair}
      email=""
      taps={props.taps}
      links={props.links}
      addSignOutTask={props.addSignOutTask}
      onSignOut={leave}
      onSwitch={leave}
      onNotEnrolled={() => {
        registry.put({ ...active, enrolled: false });
        bump((n) => n + 1);
        join();
      }}
      // A community box has no recovery kit journey and no bring back of its own here: their buttons are hidden.
      onForget={() => {
        registry.remove(active.device);
        void WhombatLive.clearStatusWidget(active.device).catch(() => {});
        join();
      }}
      onGone={() => leave()}
      hasOthers={registry.list().some((a) => a.device !== active.device)}
      // The switcher lists the Whombats this phone knows (LNK-43): no account's list behind them.
      whombats={{
        list: async () => knownSummaries(registry.list()),
        known: (device) => registry.get(device),
        open: (a) => {
          registry.setLastUsed(a.device);
          bump((n) => n + 1);
        },
        claim: () => join(),
        local: true,
      }}
      onDirect={(direct) => {
        const k = registry.get(active.device);
        if (k) registry.put({ ...k, direct });
      }}
      onAccount={(accountId) => {
        const k = registry.get(active.device);
        if (k && k.accountId !== accountId) registry.put({ ...k, accountId });
      }}
      onSetUpAgain={async () => {
        // A removed phone's key stays removed: a new key, and a new link from another of your devices (AP-39).
        forgetEnrollments(registry);
        registry.setLastUsed(null);
        void WhombatLive.clearStatusWidget().catch(() => {});
        await props.rekey();
        join();
      }}
    />
  );
}

function GoJoin({ go }: { go: () => void }) {
  useEffect(() => go(), [go]);
  return null;
}

/** Scan the box's QR code or paste its link (AP-5471). */
export function JoinLinkScreen({
  note,
  onLink,
  onBack,
}: {
  note: string | null;
  onLink: (link: LocalLinkParts) => void;
  onBack: () => void;
}) {
  const t = P.join;
  const [scanning, setScanning] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    const read = scannedLocalLink(text);
    if ('link' in read) onLink(read.link);
    else setError(read.problem);
  };
  return (
    <Frame
      kicker={t.kicker}
      title={t.title}
      sub={t.sub}
      tip={t.tip}
      back={{ label: t.back, onPress: onBack }}
    >
      <Note text={note} />
      <Button
        label={t.scan}
        size="lg"
        wrap
        onPress={() => {
          setError(null);
          setScanning(true);
        }}
      />
      <Field
        label={t.paste}
        hint={t.pasteHint}
        value={text}
        onChangeText={(v) => {
          setText(v);
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        onSubmitEditing={go}
      />
      <ErrorLine text={error} />
      <Button label={t.go} variant="secondary" size="lg" disabled={!text.trim()} onPress={go} />
      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onDenied={() => {
          setScanning(false);
          setError(t.denied);
        }}
        title={t.scanTitle}
        closeLabel={t.scanClose}
        escapeLabel={t.pasteInstead}
        onScanned={(scanned) => {
          const read = scannedLocalLink(scanned);
          if (!('link' in read)) return t.scanWrong;
          setScanning(false);
          onLink(read.link);
          return null;
        }}
      />
    </Frame>
  );
}

/**
 * An enrollment session straight to the box a link names (its ways from the link, pinned to its PeerId; AP-5472):
 * open, still reaching it, or not reachable from here (another network, Tailscale off) with Try again.
 */
function useLinkSession(env: ManagedEnvironment, keyPair: EndpointKey, link: LocalLinkParts) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<ApplianceSession | null>(null);
  const [state, setState] = useState<ConnectionState>({ status: 'idle' });
  const direct = useMemo(() => linkAddresses(link.routes), [link]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` starts a fresh session (Try again).
  useEffect(() => {
    const s = createSecureSession({
      connector: env.connector({
        orgId: COMMUNITY_ORG,
        device: link.appliance,
        peerId: link.appliance,
        channel: 'enroll',
        key: keyPair,
        direct: () => direct,
        own: () => link.own,
        directOnly: true,
      }),
      client: phoneClient(APP_BUILD),
      expect: 'any',
      backoff: { initialMs: 500, maxMs: 5000 },
    });
    const off = s.onState(setState);
    s.connect();
    setSession(s);
    return () => {
      off();
      s.close();
      setSession((c) => (c === s ? null : c));
    };
  }, [env, keyPair, link, direct, attempt]);
  const reach: 'reaching' | 'open' | 'unreachable' =
    state.status === 'open'
      ? 'open'
      : state.status === 'closed' || (state.status === 'reconnecting' && state.attempt >= 2)
        ? 'unreachable'
        : 'reaching';
  return { session, reach, retry: () => setAttempt((n) => n + 1) };
}

function LinkJoinFlow({
  env,
  keyPair,
  link,
  onBack,
  onJoined,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  link: LocalLinkParts;
  onBack: () => void;
  onJoined: (accountId: string) => void;
}) {
  const { session, reach, retry } = useLinkSession(env, keyPair, link);
  if (!session || reach === 'reaching')
    return (
      <Frame kicker={P.join.kicker} title={P.reaching} back={{ label: P.join.back, onPress: onBack }}>
        <Loading />
      </Frame>
    );
  if (reach === 'unreachable')
    return (
      <Frame
        kicker={P.join.kicker}
        title={P.unreachableTitle}
        sub={P.unreachable}
        back={{ label: P.join.back, onPress: onBack }}
      >
        <Button label={P.tryAgain} size="lg" onPress={retry} />
      </Frame>
    );
  return <DeviceJoinScreen session={session} link={link} onBack={onBack} onJoined={onJoined} />;
}

/** A device link (`enroll.link.accept`, CT-1305): one tap adds this phone to the account that made the code. */
function DeviceJoinScreen({
  session,
  link,
  onBack,
  onJoined,
}: {
  session: ApplianceSession;
  link: LocalLinkParts;
  onBack: () => void;
  onJoined: (accountId: string) => void;
}) {
  const t = P.device;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const joined = await joinWithLink(session, link, { label: phoneLabel(), platform: PHONE_PLATFORM });
      onJoined(joined.accountId);
    } catch (e) {
      setError(linkErrorText(e));
      setBusy(false);
    }
  };
  return (
    <Frame
      kicker={t.kicker}
      title={t.title}
      sub={t.sub}
      tip={t.tip}
      back={{ label: P.join.back, onPress: onBack }}
    >
      <ErrorLine text={error} />
      <Button
        label={busy ? LINK_TEXT.device.joining : LINK_TEXT.device.join}
        size="lg"
        busy={busy}
        onPress={() => void add()}
      />
    </Frame>
  );
}

/**
 * “Update available” on the first screen: a newer build of this app is out. A phone that has no Whombat yet never came
 * past a screen that says so, and this is where a Whombat is claimed or joined: with an old build that can go wrong in
 * ways the newer one closed. Nothing on the iPhone (TestFlight updates it) and while this build is the newest.
 */
export function FirstScreenUpdate({ control }: { control: ControlApi }) {
  const update = useAppUpdate(control);
  if (!update) return null;
  return (
    <Card>
      <UpdateRow first update={update} />
    </Card>
  );
}

/** What the first screen offers for community boxes (AP-5471): the ones this phone joined, each one tap. */
export function knownCommunityBoxes(registry: ApplianceRegistry): KnownAppliance[] {
  return registry.list().filter((a) => a.enrolled);
}

/**
 * A new install's first screen (LNK-44, LNK-08): no cloud account is needed to use a Whombat. Scan the QR code the
 * box's page shows (its device link, with its ways in), or type its address; the Whombats this phone joined open with
 * one tap. Phones signed in through the cloud keep their way (`onSignIn`). No price, no sign-up and nothing to buy.
 * “Look around without a Whombat” opens the demo world (`onLookAround`, look-around.md).
 */
export function JoinStartScreen({
  boxes,
  notice,
  onOpen,
  onLink,
  onAddress,
  onSignIn,
  onLookAround,
}: {
  /** Above everything else: a newer build of this app is out (`FirstScreenUpdate`). */
  notice?: ReactNode;
  boxes: readonly { device: string; name: string | null }[];
  onOpen: (device: string) => void;
  onLink: (link: LocalLinkParts) => void;
  onAddress: (address: BoxAddress) => void;
  onSignIn: () => void;
  onLookAround?: () => void;
}) {
  const t = P.start;
  const [scanning, setScanning] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    const address = readBoxAddress(text);
    if (address) onAddress(address);
    else setError(t.bad);
  };
  return (
    <Frame title={t.title} sub={t.sub} tip={t.tip}>
      {notice}
      {boxes.length > 0 ? (
        <Card label={P.signIn.known}>
          {boxes.map((b, i) => (
            <Row
              key={b.device}
              first={i === 0}
              dot="ok"
              dotLabel={P.signIn.openMeta}
              title={b.name ?? P.signIn.unnamed}
              meta={P.signIn.openMeta}
              action={
                <Button
                  label="Open"
                  variant="secondary"
                  accessibilityLabel={P.signIn.open(b.name ?? P.signIn.unnamed)}
                  onPress={() => onOpen(b.device)}
                />
              }
            />
          ))}
        </Card>
      ) : null}
      <Button
        label={t.scan}
        size="lg"
        onPress={() => {
          setError(null);
          setScanning(true);
        }}
      />
      <Field
        label={t.address}
        hint={t.addressHint}
        placeholder={t.placeholder}
        value={text}
        onChangeText={(v) => {
          setText(v);
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        onSubmitEditing={go}
      />
      <ErrorLine text={error} />
      {/* Large text wraps the longer labels rather than cutting them: this is the first screen everyone sees. */}
      <Button label={t.go} variant="secondary" size="lg" disabled={!text.trim()} onPress={go} wrap />
      <Button label={t.signIn} variant="quiet" onPress={onSignIn} wrap />
      {onLookAround ? <Button label={t.lookAround} variant="quiet" onPress={onLookAround} wrap /> : null}
      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onDenied={() => {
          setScanning(false);
          setError(P.join.denied);
        }}
        title={P.join.scanTitle}
        closeLabel={P.join.scanClose}
        escapeLabel={P.join.pasteInstead}
        onScanned={(scanned) => {
          const read = scannedLocalLink(scanned);
          if (!('link' in read)) return P.join.scanWrong;
          setScanning(false);
          onLink(read.link);
          return null;
        }}
      />
    </Frame>
  );
}

/**
 * Joining at a typed address (LNK-08): the box names itself there (`GET /v1/direct` over HTTPS, or plain HTTP at its
 * address on this network) and is pinned on first use, as its own page pins it; then, over an enrollment session to
 * that address, a device already in approves this phone (pairing), or the box's own screen shows a code for it. Nobody
 * claimed it yet: at its address on this network the phone claims it with the letters on its screen;
 * elsewhere its page does.
 */
function AddressJoinFlow({
  env,
  keyPair,
  address,
  onBack,
  onJoined,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  address: BoxAddress;
  onBack: () => void;
  onJoined: (record: KnownAppliance, accountId: string | null) => void;
}) {
  const t = P.address;
  const [attempt, setAttempt] = useState(0);
  const [found, setFound] = useState<DirectIdentity | 'failed' | null>(null);
  // What the letters screen says after the box was asked again in the middle of a claim.
  const [claimNotice, setClaimNotice] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again (Try again).
  useEffect(() => {
    let live = true;
    setFound(null);
    fetch(`${boxAddressOrigin(address)}${DIRECT_PATH}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        const parsed = res.ok ? DirectIdentity.safeParse(await res.json()) : null;
        if (live) setFound(parsed?.success ? parsed.data : 'failed');
      })
      .catch(() => live && setFound('failed'));
    return () => {
      live = false;
    };
  }, [address, attempt]);
  // One record per answer, so a session to it isn't opened again whenever this screen draws.
  const record = useMemo(() => {
    if (!found || found === 'failed') return null;
    const at = addressRecord(address, found.appliance);
    // Claimed here with the letters on its screen, which only the box showing them can answer.
    return found.claimed === false ? { ...at, pinSource: 'claim' as const } : at;
  }, [address, found]);
  const back = { label: P.join.back, onPress: onBack };
  if (found === null)
    return (
      <Frame kicker={t.kicker} title={t.reaching} back={back}>
        <Loading />
      </Frame>
    );
  if (found === 'failed')
    return (
      <Frame kicker={t.kicker} title={P.unreachableTitle} sub={t.unreachable} back={back}>
        <Button label={P.tryAgain} size="lg" onPress={() => setAttempt((n) => n + 1)} />
      </Frame>
    );
  if (!record) return null;
  if (found.claimed === false && onLocalNetwork(address))
    return (
      <LocalClaim
        env={env}
        keyPair={keyPair}
        record={record}
        notice={claimNotice}
        onBack={onBack}
        onClaimed={(accountId) => onJoined(record, accountId)}
        // Claimed by someone else meanwhile: ask the box again, which now offers this phone a way in.
        onTaken={() => {
          setClaimNotice(null);
          setAttempt((n) => n + 1);
        }}
        // The connection or the proof was lost: ask the box again. Still nobody's, the letters come back and say why;
        // claimed meanwhile, the box offers this phone a way in.
        onReread={(text) => {
          setClaimNotice(text);
          setAttempt((n) => n + 1);
        }}
      />
    );
  if (found.claimed === false)
    return <Frame kicker={t.kicker} title={P.start.title} sub={t.notSetUp} back={back} />;
  return <AddressPair env={env} keyPair={keyPair} record={record} onBack={onBack} onJoined={onJoined} />;
}

function AddressPair({
  env,
  keyPair,
  record,
  onBack,
  onJoined,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  record: KnownAppliance;
  onBack: () => void;
  onJoined: (record: KnownAppliance, accountId: string | null) => void;
}) {
  const [session, setSession] = useState<ApplianceSession | null>(null);
  const [screen, setScreen] = useState(false);
  useEffect(() => {
    const s = createSecureSession({
      connector: env.connector({
        orgId: COMMUNITY_ORG,
        device: record.device,
        peerId: record.peerId,
        channel: 'enroll',
        key: keyPair,
        direct: () => record.direct ?? null,
        own: () => record.ownAddress ?? undefined,
        directOnly: true,
      }),
      client: phoneClient(APP_BUILD),
      expect: 'any',
      backoff: { initialMs: 500, maxMs: 5000 },
    });
    s.connect();
    setSession(s);
    return () => s.close();
  }, [env, keyPair, record]);
  if (!session)
    return (
      <Frame kicker={P.address.kicker} title={P.address.reaching}>
        <Loading />
      </Frame>
    );
  if (screen)
    return (
      <ScreenSignInSteps
        session={session}
        device={record.device}
        appliancePeerId={record.peerId}
        clientPeerId={keyPair.peerId}
        endpoint={{ label: phoneLabel(), platform: PHONE_PLATFORM }}
        onBack={() => setScreen(false)}
        onIn={(accountId) => onJoined(record, accountId)}
        onAlready={() => onJoined(record, null)}
      />
    );
  return (
    <PairScreen
      session={session}
      label={phoneLabel()}
      platform={PHONE_PLATFORM}
      fingerprint={pairingFingerprint(keyPair.peerId)}
      onApproved={(accountId) => onJoined(record, accountId)}
      onBack={onBack}
      onScreen={() => setScreen(true)}
    />
  );
}
