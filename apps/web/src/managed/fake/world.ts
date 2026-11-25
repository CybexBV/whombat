/**
 * The fake managed world (development and e2e, `VITE_WHOMBAT_FAKE=1`, AP-15): a fake control API and fake
 * appliances speaking session protocol v1 (`@whombat/client/fake`), serving the mock world (`@whombat/fixtures`)
 * as the appliance's data. Loaded only in fake builds (dynamic import); the hosted production build never
 * contains it (the build refuses VITE_WHOMBAT_FAKE in production mode).
 *
 * State that must survive a reload (who claimed what, enrolled keys, recovery kit, pairing) lives in
 * localStorage under `whombat:fake-world`. `window.__WHOMBAT_FAKE__` exposes faults and the other devices'
 * actions to the e2e suite.
 */
import {
  backupPlacesFixture,
  createFakeBackupPlaces,
  type FakeBackupPlaces,
} from '@whombat/client/backup-places/fake';
import { createFakeDesk, type FakeDesk, type FakeDeskSnapshot } from '@whombat/client/desk/fake';
import {
  createFakeAppliance,
  createFakeBackupLook,
  type FakeAppliance,
  type FakeBackupLook,
  type FakeHandler,
} from '@whombat/client/fake';
import {
  createFakeBluetooth,
  createFakeMail,
  createFakeNetwork,
  createFakeTailscale,
  type FakeBluetooth,
  type FakeBluetoothSnapshot,
  type FakeMachine,
  type FakeMail,
  type FakeNetwork,
  type FakeNetworkSnapshot,
  type FakeTailscale,
  fakeHardware,
} from '@whombat/client/host/fake';
import {
  type AndroidDownload,
  type ApplianceSummary,
  type BillingView,
  type ControlApi,
  ControlError,
  type ControlOrg,
  type ControlSession,
  controlTickets,
  LINK_ORG_NAME,
  type LinkAccount,
  type LinkedBox,
  newPhoneHandoffKey,
  type PhoneHandoffView,
  parsePhoneSignInLink,
  phoneHandoffMac,
  type SignupInfo,
} from '@whombat/client/managed';
import {
  createFakeRemoteHelp,
  type FakeRemoteHelp,
  type FakeRemoteHelpSnapshot,
} from '@whombat/client/remote-help/fake';
import {
  type BackupPlacesList,
  ConnectError,
  type ProviderStatus,
  type SessionConnector,
  ticketConnectError,
} from '@whombat/client/session';
import {
  applianceTermsAccepted,
  isSafeNext,
  type KitEnvelopeInput,
  linkSoldIn,
  normaliseSignupCode,
  SUBSCRIPTION_TERMS_VERSION,
  subscriptionTermsAccepted,
} from '@whombat/control-contracts';
import { canonicalJson, deriveSeedKeypair, sha256Hex, utf8ToBytes, verifyBytes } from '@whombat/core/audit';
import { BACKUP_FILE_CONTENT_TYPE } from '@whombat/core/backup';
import {
  type AnyEndpoint,
  api,
  buildPath,
  FEEDBACK_DROP_TEXT,
  type FeedbackIntegrationDetail,
  toQueryString,
} from '@whombat/core/contracts';
import { basicSnippet, cspAdvice, customLauncherSnippet } from '@whombat/core/feedback';
import { siteSigningKeyOf } from '@whombat/core/feedback/drop';
import { ownAddressNameProblem } from '@whombat/core/own-address';
import { burrow, FEEDBACK_EMBED_URL, feedbackManagedHealth, mara } from '@whombat/fixtures';
import { OWN_ADDRESS_ZONES, type OwnAddressNameVerdict } from '@whombat/protocol';
import {
  type ClaimConfirmTags,
  claimBackoffSeconds,
  claimConfirmEqual,
  claimPakeResponder,
  formatScreenSignInLetters,
  generateClaimLetters,
  generateScreenSignInLetters,
  localClaimPakeResponder,
  screenSignInPakeResponder,
} from '@whombat/protocol/claim';
import type { DirectIdentity } from '@whombat/protocol/direct';
import {
  boxPasskeyRegisterChallengeBase64url,
  claimSecretHash,
  claimVerifier,
  DIAGNOSTIC_BUNDLE_FORMAT,
  DIAGNOSTICS_MAX_BUNDLES,
  DIAGNOSTICS_TTL_S,
  DIAGNOSTICS_WINDOW_S,
  diagnosticBundleBytes,
  type HostMetricsInput,
  kitMaterialOf,
  type LinkSummary,
  localLinkFor,
  type OwnerPasskeyRecord,
  PASSKEYS_PER_ACCOUNT_MAX,
  pairingFingerprint,
  passkeyEnrollChallengeBase64url,
  passkeyLinkChallenge,
  passkeyRegisterChallengeBase64url,
  passkeyUserHandleBase64url,
  RECOVERY_KIT_CONFIRM_PURPOSE,
  RECOVERY_ROTATE_PURPOSE,
  REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE,
  remoteHelpTranscriptName,
  SCREEN_SIGNIN_TTL_S,
  verifyOwnerPasskey,
  verifyRecoveryStatement,
} from '@whombat/protocol/session';
import { peerIdFromEd25519PublicKey } from '@whombat/secure-channel';
import { photoRefusal, readPhotoBody, withPhotos } from '../../app/avatarFixtures';
import { backupsSeeded, createBackupWorld } from '../../app/backupFixtures';
import {
  createFakeBackupOptions,
  type FakeBackupOptions,
  type FakeBackupPatch,
} from '../../app/backupOptionsFixtures';
import { type DeskFixtureKind, deskFixtureKind, deskSeed } from '../../app/deskFixtures';
import { createFilesWorld, type MessageLike } from '../../app/filesFixtures';
import { createWebFixtureFetch, FIXTURE_BASE_URL, powerSeeded } from '../../app/fixtureFetch';
import { hostMetricsFixture, hostPowerFixture } from '../../app/hostFixtures';
import { machineFixtureKind } from '../../app/machineFixtures';
import { ownRoute } from '../boxEnv';
import type { ConnectTarget } from '../connect';
import { createFakeAi, FAKE_AI_OPS, type FakeAi, type FakeAiSnapshot, sessionAnswer } from './ai';
import { createFakeCollabHub } from './collab';
import { createFakeConsoles } from './console';
import {
  backupEligible,
  clientData,
  type FakeControlPasskey,
  type FakeWhombatPasskey,
  passkeySummary,
} from './passkeys';

/**
 * The session-native sign-in ops and their `signins.*` twins (`PROVIDER_OP_EQUIVALENTS`, CT-70): the fake answers both
 * from one place, as the runtime does. Their inputs are flat (ids and body fields together).
 */
const PROVIDER_OPS: Record<string, string> = {
  'providers.list': 'signins.list',
  'providers.login.start': 'signins.loginStart',
  'providers.login.status': 'signins.loginStatus',
  'providers.login.submit': 'signins.loginSubmit',
  'providers.login.cancel': 'signins.loginCancel',
  'providers.logout': 'signins.logout',
  'providers.org.list': 'signins.orgList',
  'providers.org.login.start': 'signins.orgLoginStart',
  'providers.org.remove': 'signins.orgRemove',
};

/**
 * A deterministic, valid Ed25519 PeerId for a fake appliance (its "content identity"): the public key of a key
 * derived from the name — a real curve point, as the strict checks of secure-channel 0.5.1 require.
 */
async function peerIdFor(name: string): Promise<string> {
  const { publicKey } = deriveSeedKeypair(`fake:${name}`, 'whombat-fake-world');
  return peerIdFromEd25519PublicKey(
    Uint8Array.from(publicKey.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
  );
}

const DEVICES = {
  fresh: 'dev_7KQ2M4XD',
  used: 'dev_3RTN8CVB',
  contested: 'dev_5HJK2LPQ',
  mismatched: 'dev_9WER6TYU',
  /** A second box to claim, as after a retired Whombat is replaced (AP-697). */
  spare: 'dev_6NBX3QWT',
  /**
   * A community box (HE-58; AP-5430): no control, claimed on its own page (`box()`, the box target's fake), a new device
   * added with the links it makes. Never nearby, never in control's list.
   */
  community: 'dev_2CMTY8WB',
  /**
   * A box set up at its own address (own-address.md, A3): commercial, claimed on its own page with the claim link on its
   * screen, linked to the account with a code, opened with its own passkey. Listed at control once linked, by name only.
   */
  own: 'dev_4WNBX8QA',
} as const;

/** The boxes control knows (cards, consoles a claim through control reads): all but the community and A3 boxes. */
type ControlBox = Exclude<keyof typeof DEVICES, 'community' | 'own'>;

/** The A3 box's address, and the claim link's secret its screen shows. */
export const FAKE_OWN_HOST = 'maple-otter-river.dev.whombat.app';
/** The owner's box passkey under the first address, once the A3 box changed it (`ownRenamed`). */
const FAKE_MOVED_PASSKEY = 'moved-passkey-under-the-old-address';
/** The code a box shows while Whombat Link starts (4.4). */
export const FAKE_LINK_CODE = 'KXQM-PRTV';
export const FAKE_OWN_CLAIM_LINK = 'kxmprt';

/** 128-bit claim secrets: 26 base32 characters (RFC 4648 alphabet, `ClaimSecret`). */
const SECRETS = {
  fresh: 'HQ4TZZPM2WXA7KCEB3NRDS5FGY',
  used: 'PL2M4QZX7VNR3TCDEFGHJKLMNA',
  contested: 'MN7B5VCX2ZAS4DFGHJKLQWERTY',
  mismatched: 'QA3S7DFG6HJK2LZXCVBNMQWERT',
  spare: 'TB6W2ZQK4MXNA7PCDEHJRS3VGF',
  community: 'CM4TZZPM2WXA7KCEB3NRDS5FGQ',
  own: 'WN4TZZPM2WXA7KCEB3NRDS5FGQ',
} as const;

/**
 * The lookup numbers control leased to the unclaimed boxes (CC-03): their "waiting to be claimed" presence, which
 * `claims.nearby` needs. Never shown (CC-13); the used box has none.
 */
const LOOKUPS: Partial<Record<keyof typeof DEVICES, string>> = {
  fresh: '4821',
  contested: '3107',
  mismatched: '5530',
  spare: '6214',
};

export interface FakeCard {
  device: string;
  secret: string;
  /** The older QR text (`WHOMBAT1:<device>:<fingerprint>:<secret>`), still read. */
  qr: string;
  /** What the card's QR code encodes: the claim link with everything in the fragment. */
  link: string;
}

/** What an unclaimed box's console shows (CC-08, CC-13): its code, which is only the four letters. */
export interface FakeConsole {
  code: string;
  letters: string;
}

/** What a claimed box's screen shows while a device waits to sign in there (BX-06): the panel's facts. */
export interface FakeScreenSignIn {
  /** `KXQ MTR`, as the screen shows it. */
  code: string;
  letters: string;
  /** Whose device it is (the account's name). */
  name: string;
  /** The new device's label, as it asked. */
  device: string;
  expiresAt: string;
}

/**
 * The appliance's one account: Mara's, whose Whombat it is (Whombat one-person.md OP-01; AP-5676). An account made on a
 * development box (`enroll.dev`) is hers too (its principal is Mara's, fixtures).
 */
function accountOf(a: ApplianceState, accountId: string) {
  if (accountId === LOCAL.id) return { name: mara.name, email: mara.email, principalId: mara.id };
  const made = a.accounts?.[accountId];
  if (made) return { name: made.name, email: made.email, principalId: mara.id };
  return null;
}

interface EndpointRecord {
  accountId: string;
  label: string;
  platform: 'web' | 'android' | 'ios';
  createdAt: string;
  revokedAt: string | null;
  /** Revocation told to the device (it connected since): `applied`. */
  applied: boolean;
}

interface ApplianceState {
  device: string;
  name: string;
  /** A community box (CT-1300): `welcome.edition`, the claim on its page, its links, mail and Web Push (AP-5430). */
  edition?: 'community';
  /**
   * Set up at its own address (A3): its host, the claim link's secret while unclaimed, the account it is linked to, the
   * owner's switch, the box passkeys' random user ids per account, and its certificate watch's findings.
   */
  own?: {
    host: string;
    claimLink: string | null;
    linkedTo: string | null;
    reachable: boolean;
    users: Record<string, string>;
    foreign?: boolean;
    missed?: boolean;
    /** The address it had before a rename, while it still works (4.16). */
    leaving?: { host: string; until: string } | null;
    /** Names this box had (`ownAddress.check` says `yours`). */
    had?: string[];
    /** Renamed just now: the first status after says it is getting its certificate. */
    starting?: boolean;
  };
  /** Whombat Link as the box knows it (4.4, whombat-link.md); absent: off. */
  link?: LinkSummary;
  /** The update channel (4.4); absent: production. */
  channel?: 'production' | 'development';
  /** Phone push tokens handed to the box (`push.token.set`, 4.4), by endpoint. */
  pushTokens?: Record<string, string>;
  /** Device links (`enroll.link.*`, CT-1305); the fake keeps the secret, the runtime its hash. */
  deviceLinks?: { secret: string; accountId: string; expiresAt: string; used: boolean }[];
  /** Browsers registered for the box's own Web Push (`devices.register`, CT-1307). */
  pushDevices?: { id: string; accountId: string; token: string }[];
  claimedBy: string | null;
  competing: boolean;
  /** The console letters and the lookup lease (never shown, CC-13) while unclaimed (CC-01, CC-03). */
  letters?: string;
  lookup?: string | null;
  /** Wrong claim confirmations in the window, and when `enroll.claim.begin` is accepted again (CC-07). */
  claimFailures?: number;
  claimBackoffUntil?: number | null;
  /** endpoint peerId → record */
  endpoints: Record<string, EndpointRecord>;
  kit: {
    publicKey: string | null;
    kitId: string | null;
    challenge: string | null;
    confirmed: boolean;
    /** A rotation's new key waits for its kit to be confirmed (CT-45); the previous key still works until then. */
    rotationPending?: boolean;
    /** The kit's account (recovery enrolls only into this account, CT-45); the claimer unless a fault says else. */
    owner?: string;
  };
  pairing: {
    pairingId: string;
    code: string;
    endpoint: string;
    label: string;
    platform?: 'web' | 'android' | 'ios';
    state: 'pending' | 'approved' | 'denied';
  }[];
  /** Diagnostic bundles (CT-52): the summary and the stored document. */
  diagnostics?: {
    summary: Record<string, unknown> & { bundleId: string; downloads: number };
    bundle: unknown;
  }[];
  /** The running release's client security floor (CT-53). */
  clientFloor?: Record<string, number> | null;
  /**
   * Google connect on a managed Whombat (AG-14): the started connect (its state and return path), the returns that
   * came back over the session, and whether the viewer's account is connected.
   */
  google?: {
    pending: { state: string; returnTo: string } | null;
    finishes: { code: string | null; state: string; error: string | null }[];
    connected: boolean;
  };
  /** A service's sign-in finished over the session (`connections.finishOAuth`): what came back, in order. */
  oauthFinishes?: { code: string | null; state: string; iss: string | null }[];
  /** Accounts a development box let in (`enroll.dev`); Mara's own otherwise. */
  accounts?: Record<string, { name: string; email: string }>;
  /**
   * The box's own screen (desk-display-web.md AP-3012): its world (`deskFixtures.ts`; null a VM without a display) and
   * the pairing and choices that survive a reload. Absent: `VITE_FIXTURE_DESK`.
   */
  desk?: { kind: DeskFixtureKind | null; snapshot: FakeDeskSnapshot | null };
  /**
   * The machine's network, hardware report and Bluetooth (hardware-support-web.md AP-3231, bluetooth-web.md AP-3717):
   * its kind (`machineFixtures.ts`; null: none, the ops answer `not_managed`) and the Wi-Fi and paired devices that
   * survive a reload. Absent: `VITE_FIXTURE_MACHINE`.
   */
  machine?: {
    kind: FakeMachine | null;
    network: FakeNetworkSnapshot | null;
    bluetooth?: FakeBluetoothSnapshot | null;
  };
  /**
   * Remote help (remote-help.md AP-4447): the grant, the visits and their command lines, the image's environment. Absent:
   * a local image with a support key and nobody let in yet.
   */
  remoteHelp?: FakeRemoteHelpSnapshot;
  /** Push refs the appliance handed out (`push.resolve`, CT-49): ref → what it is about. */
  pushRefs?: Record<string, { burrow: string; link: Record<string, unknown> }>;
  backup: 'unprotected' | 'pending' | 'protected' | 'stale' | 'failing';
  /** The manager's journal state (MA-11 names). */
  update: FakeUpdate['state'];
  /** The update facts of contracts 0.22 (CT-138): why it waits, the last failure's detail, the last update. */
  updateFacts?: Omit<FakeUpdate, 'state'>;
  backupRepo?: string;
  /** Its backup places as last changed (backup-places.md AP-6716); the fixture's until then. */
  backupPlaces?: BackupPlacesList;
  /** The kind of the destination set up (CT-142). */
  backupKind?: string;
  /** What the destination was set up with, for the kit's backup section (the fake keeps it; a box seals it). */
  backupCredentials?: Record<string, string>;
  /** Members a newer appliance adds to the kit's backup section (`faults.backupMaterial`). */
  backupMaterialExtra?: Record<string, unknown>;
  /**
   * A Whombat from before the passkey (`faults.beforePasskey`): its status has no `bringBack`, so its recovery kit
   * still holds the backups' key and the apps show the kit's rows.
   */
  beforePasskey?: boolean;
  /** The agent's credential source as RUNS ON last set it (`agent.setCredentialSource`). */
  credentialSource?: unknown;
  /** Sign-ins and installed clients (`signins.*`, `clients.*`; `./ai.ts`). */
  ai?: FakeAiSnapshot;
  /**
   * GitHub connected for the burrow with the person's own GitHub sign-in (essentials item 6, CT-181): the login it acts as.
   * A managed box has no host gh, so `github.status` says `via: 'signin'`.
   */
  githubConnectedAs?: string | null;
  /** The appliance licence as the runtime computes it (LC-09); `none`: a runtime before contracts 0.10. */
  licence?: FakeLicence;
  /**
   * Website feedback (Whombat FD-25): `available` (default) through the encrypted drop; `unsupported` when the
   * manager or Whombat's cloud can't carry it; `none`: a runtime before contracts 0.13 (no delivery in health).
   */
  feedbackDrop?: FakeFeedbackDrop;
  /** Passkeys that open this Whombat (PK-06), and the person's “Only passkeys that stay on one device” (PK-07). */
  passkeys?: FakeWhombatPasskey[];
  passkeysDeviceBoundOnly?: boolean;
  /** Endpoint PeerId → the passkey that let it in (`current` in `passkeys.list`). */
  enrolledWith?: Record<string, string>;
}

export type FakeFeedbackDrop = 'available' | 'unsupported' | 'none';

/** An update as `appliance.status.update` reports it (`faults.update`). */
export interface FakeUpdate {
  state:
    | 'Healthy'
    | 'Assigned'
    | 'Downloading'
    | 'Verified'
    | 'Staged'
    | 'WaitingForSafeBoundary'
    | 'Activating'
    | 'Verifying'
    | 'Failed'
    | 'RolledBack'
    | 'Quarantined'
    | 'ForwardRepairRequired';
  current?: string;
  candidate?: string | null;
  waiting?: { reason: string; since: string; blockers: { kind: string; count: number }[] };
  failureDetail?: Record<string, unknown>;
  lastUpdate?: { release: string; from: string | null; at: string };
  /** Ask before updating (Whombat ask-before-updating.md): absent, the box's manager can't hold updates (no switch). */
  askFirst?: boolean;
}

/** The fake SFTP server's host key (trusted on first use when none is given). */
const FAKE_HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeNasHostKeyForTheFakeWorld0123456789ab';
/** The box's SFTP key as the kit carries it (OpenSSH PEM). */
const FAKE_SFTP_PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBGYWtlV2hvbWJhdEJhY2t1cEtleUZvclRoZUZha2VXb3JsZAAAAJg=\n-----END OPENSSH PRIVATE KEY-----';

/** What the fake SFTP server's host key reads as (`hostKeyFingerprint`). */
export const FAKE_HOST_KEY_FINGERPRINT = 'SHA256:Zk3uFakeNasHostKeyFingerprint8xY2pQ1mN0rT5vW7';

/** The release the fake appliances run. */
export const FAKE_RELEASE = '2026.9.2';

/** The community box's Web Push key (a valid P-256 point's shape: 87 base64url characters). */
const FAKE_VAPID_KEY = `B${'A'.repeat(86)}`;

/** The fake appliance's site key pin (`data-key`, FD-07): the fingerprint of a fixed signing seed. */
const FAKE_SITE_KEY = siteSigningKeyOf(new Uint8Array(32).fill(7)).fingerprint;
/** Health warnings a managed Whombat never raises (it has no public address or widget build of its own). */
const SELF_HOSTED_WARNINGS = new Set(['public_url_missing', 'public_url_not_https', 'widget_not_built']);

/**
 * A feedback integration's detail as a managed runtime sends it (Whombat FD-26, FD-37; the fixtures are a
 * self-hosted Whombat's): snippets from the embed origin with the site key, health with the drop's delivery.
 */
function managedFeedbackDetail(body: unknown, mode: FakeFeedbackDrop): void {
  const d = body as Partial<FeedbackIntegrationDetail> | null;
  if (!d?.integration || !d.snippets || !d.health || mode === 'none') return;
  const warnings = d.health.warnings.filter((w) => !SELF_HOSTED_WARNINGS.has(w.code));
  if (mode === 'unsupported') {
    d.health = {
      ...d.health,
      warnings: [...warnings, { code: 'drop_unsupported', message: FEEDBACK_DROP_TEXT.unsupported }],
      delivery: { mode: 'drop', publishedAt: null, lastCollectedAt: null, notFiled7d: 0, expired7d: 0 },
    };
    return;
  }
  const i = d.integration;
  const input = {
    publicUrl: FEEDBACK_EMBED_URL,
    embedUrl: FEEDBACK_EMBED_URL,
    siteKey: FAKE_SITE_KEY,
    siteId: i.siteId,
    theme: i.theme,
    position: i.position,
    launcher: i.launcher,
    launcherLabel: i.launcherLabel,
  };
  d.snippets = { basic: basicSnippet(input), custom: customLauncherSnippet(input), csp: cspAdvice(input) };
  const enabled = i.intake === 'enabled';
  d.health = {
    ...d.health,
    publicUrl: FEEDBACK_EMBED_URL,
    warnings: enabled ? [...warnings, ...feedbackManagedHealth.warnings] : warnings,
    delivery: enabled
      ? feedbackManagedHealth.delivery
      : { mode: 'drop', publishedAt: null, lastCollectedAt: null, notFiled7d: 0, expired7d: 0 },
  };
}

/**
 * The licence states the fake appliance can be in (`faults.licence`): each maps to `licenceStatus`'s state and reason.
 * `refreshTo`: what “Check again” renews to; `renewFails`: it can't reach control.
 */
export interface FakeLicence {
  kind:
    | 'active'
    | 'trial'
    | 'past_due'
    | 'payment'
    | 'not_renewed'
    | 'no_licence'
    | 'cancelled'
    | 'expired'
    | 'none';
  refreshTo?: FakeLicence['kind'];
  renewFails?: boolean;
  limits?: { connectors: number | null };
}

const LICENCE_STATES: Record<Exclude<FakeLicence['kind'], 'none'>, { state: string; reason: string }> = {
  active: { state: 'licensed', reason: 'active' },
  trial: { state: 'licensed', reason: 'trial' },
  past_due: { state: 'licensed', reason: 'past_due' },
  payment: { state: 'grace', reason: 'payment' },
  not_renewed: { state: 'grace', reason: 'not_renewed' },
  no_licence: { state: 'grace', reason: 'no_licence' },
  cancelled: { state: 'lapsed', reason: 'cancelled' },
  expired: { state: 'lapsed', reason: 'expired' },
};

/** Whombat Link as control keeps it for the account, as much as the account site sees. */
interface FakeLink {
  plan: LinkAccount['plan'];
  boxes: LinkedBox[];
  /** Codes boxes show (`link.begin`): the box's device and name, when it ends, used or not. */
  codes: { code: string; device: string; name: string | null; expiresAt: number; used: boolean }[];
  /** The account's Link org exists (made by the first confirm): the session lists it. */
  org: boolean;
  /** Checkout opened (by the month or the year, with a typed code): Stripe's webhook arrives `lagMs` later. */
  pending: { at: number; interval?: 'month' | 'year' } | null;
  /** Whether Stripe has the subscription, when a test says so; else a card on file means it does. */
  stripe?: boolean;
  /** A payment page open elsewhere (another tab or device): its interval and when it closes (epoch seconds). */
  openPage?: { interval: 'month' | 'year'; until: number } | null;
  /** The account accepted the Subscription Terms at a checkout or the portal (a confirm's are in `terms`). */
  termsAccepted?: boolean;
  /** Another payment page is being opened (`checkout_busy`). */
  busy?: boolean;
  /** The Subscription Terms version each confirm was sent with (null: none). */
  terms?: (string | null)[];
  lagMs?: number;
  /** Payments aren't set up (`manual_billing`). */
  manual?: boolean;
  /** A card was added in Checkout: the free month's two-box limit is gone. */
  card?: boolean;
  /** Boxes linked from now on wait for their address (`starting`) until `linkAddress` gives it. */
  addressLater?: boolean;
  /** The names people chose at confirm (`link.confirm`'s `label`), by device, until the box gets its address. */
  wanted?: Record<string, string>;
  /** A name another account's box takes between the check and the confirm (`label_taken` at confirm). */
  takenMeanwhile?: string | null;
}

interface WorldState {
  signedIn: boolean;
  /** Servers turned on by the e2e suite (`servers(true)`). */
  servers?: boolean;
  /** A new cloud account has no organization until it names one (control `POST /v1/orgs`). */
  org: { orgId: string; name: string } | null;
  appliances: Record<string, ApplianceState>;
  lastLink: string | null;
  /** The boxes `claims.nearby` finds on this browser's network (CC-04). */
  nearby?: string[];
  /** The open box drawn as its own page would be (`boxPage`, AP-5325). */
  boxPage?: boolean;
  /** The box target's page as the plain-HTTP local-network page, not secure (`insecurePage`, AP-5428). */
  insecurePage?: boolean;
  /** Faults that must survive a reload. */
  providers?: Record<string, ProviderStatus[]>;
  majors?: Record<string, number[]>;
  /** What control says each release brought (`rollout.releaseSummary`, CT-138); a release without one is a 404. */
  releaseSummaries?: Record<string, string>;
  /** The APK control hands out (CT-191); absent: `FAKE_APK`, null: none published. */
  androidApk?: AndroidDownload | null;
  /** A directory that lies (AP-64): the content PeerId control reports instead of the box's own. */
  lies?: Record<string, string>;
  /**
   * Whombats an operator retired (CL-91, AP-697): the directory lists them `retired`, control refuses their tickets
   * (404 `device_not_found`), they aren't nearby and can't be claimed.
   */
  retired?: string[];
  /**
   * Whombats control no longer holds for the organization (released, the organization deleted; AP-697): not listed,
   * their tickets refused like a retired one's. The box keeps its accounts.
   */
  released?: string[];
  /** Control refuses the next claims / account deletions with this reason (LC-15, LC-16, CT-78). */
  claimRefusal?: 'self_install_not_allowed' | 'devices_allowed_reached' | null;
  deleteRefusal?: 'org_has_devices' | 'subscription_live' | null;
  /** The appliance terms version each claim was started with (LC-18). */
  claimTerms?: string[];
  /** The cloud account was deleted (a new sign-in starts a new one). */
  deleted?: boolean;
  /** Control's signup settings (BL-25); `open` and `manual` unless a test says otherwise, like control's default. */
  signup?: { mode: SignupInfo['mode']; billing: SignupInfo['billing']; trialDays: number };
  /** The org's subscription (BL-13…BL-18), created with the org. */
  billing?: FakeBilling;
  /** Whombat Link at the account site (LNK-13, LNK-35): the account's plan, its boxes and the codes boxes show. */
  link?: FakeLink;
  /** Who joined the waitlist (BL-23). */
  waitlist?: { email: string; company: string | null; note: string | null }[];
  /** Invite codes control would accept (canonical), and which one carries a plan (BL-22). */
  signupCodes?: { code: string; plan: string | null; used: boolean }[];
  /** The terms version and code each org creation was sent with. */
  created?: { terms: string; code: string | null }[];
  /** Whombats that had a free trial in another org (BL-17). */
  trialUsed?: string[];
  /** The passkeys control keeps for Mara's account (CL-11, CL-117). */
  controlPasskeys?: FakeControlPasskey[];
  /** The passkey-locked recovery kits control keeps for the account (backup-options.md AP-6815). */
  kitEnvelopes?: (KitEnvelopeInput & { id: string; createdAt: string; whombatName?: string | null })[];
  /** Link codes control made for the account (`orgs.createWhombatLink`); the fake keeps the code, control its hash. */
  whombatLinks?: { code: string; expiresAt: string; used: boolean }[];
  /** The box target's page shows the A3 box at its own address instead of the community box. */
  ownBox?: boolean;
  /** The host that page stands for, when not the box's first address (its old or its new one after a rename). */
  ownPageHost?: string | null;
  /** `ownAddress.rename` refuses with this code. */
  ownRenameRefusal?: string | null;
  /** Faults that survive a reload: a sign-in challenge not bound to the device, control refusing registrations. */
  passkeyFaults?: { challenge?: string | null; controlDown?: boolean; enrollDown?: boolean };
}

/** The org's subscription in the fake world: what `billing.view` answers, plus a checkout still on its way. */
export interface FakeBilling {
  provider: 'stripe' | 'manual';
  plan: { id: string; name: string } | null;
  state: BillingView['state'];
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  paid: number;
  setupRequired: boolean;
  trialAvailable: boolean;
  manual: boolean;
  /** Stripe's webhook for a finished checkout, applied `lagMs` after it (BL-16: webhooks can lag). */
  pending?: { plan: string; whombats: number; at: number } | null;
  /** How long that webhook takes (default 3 s). */
  lagMs?: number;
  /** How often the Billing page asked (`billing.view`). */
  views?: number;
}

/** The one public plan control lists (BL-02, BL-11): €49 per Whombat a month (Whombat one-person.md OP-18). */
const PLANS: SignupInfo['plans'] = [
  {
    id: 'whombat',
    name: 'Whombat',
    amountCents: 4900,
    currency: 'eur',
    interval: 'month',
    limits: { connectors: null },
  },
];

/** A valid invite code of the fake world (`7KQ2-M4XD`), and one that carries a manual plan (`TEAM-2026`). */
const SIGNUP_CODES = [
  { code: '7KQ2M4XD', plan: null, used: false },
  { code: 'TEAM2026', plan: 'whombat', used: false },
];

const STORAGE = 'whombat:fake-world';
const ORG: ControlOrg = { orgId: 'org_burrowhq', name: 'Burrow HQ' };
/** The letters of a box's link code (`LINK_CODE_RE`). */
const LINK_LETTERS = 'ABCDEFGHJKMNPQRTVWXY';
/** Addresses control draws for linked boxes (example words). */
const FAKE_LINK_LABELS = ['calm-otter-reef', 'brave-heron-dune', 'quiet-maple-cove'];

/** Names other people's Whombats have in the fake world: “That name is taken.” */
export const FAKE_TAKEN_NAMES: readonly string[] = ['office', 'garden'];

/** `link.name.check` and the box's `ownAddress.check` in the fake world: the rules control keeps, and names in use. */
function fakeNameCheck(
  name: string,
  l: Pick<FakeLink, 'boxes' | 'wanted'>,
  own?: { label: string; had: readonly string[] },
): { name: string; verdict: OwnAddressNameVerdict; host?: string } {
  const problem = ownAddressNameProblem(name);
  if (problem) return { name, verdict: problem };
  if (own?.had.includes(name)) return { name, verdict: 'yours', host: `${name}.${OWN_ADDRESS_ZONES.prod}` };
  const used =
    FAKE_TAKEN_NAMES.includes(name) ||
    l.boxes.some((b) => b.label === name) ||
    Object.values(l.wanted ?? {}).includes(name) ||
    own?.label === name;
  return used
    ? { name, verdict: 'taken' }
    : { name, verdict: 'free', host: `${name}.${OWN_ADDRESS_ZONES.prod}` };
}
const CLOUD = { accountId: 'acc_mara', email: mara.email, name: mara.name };
/** The appliance-local account Mara claims as (same id as the fixtures' account). */
const LOCAL = { id: 'acc_mara', name: mara.name };

function initial(): WorldState {
  const blank = (device: string, name: string): ApplianceState => ({
    device,
    name,
    claimedBy: null,
    competing: false,
    letters: newLetters(),
    lookup:
      LOOKUPS[
        (Object.keys(DEVICES) as (keyof typeof DEVICES)[]).find((k) => DEVICES[k] === device) ?? 'fresh'
      ] ?? null,
    claimFailures: 0,
    claimBackoffUntil: null,
    endpoints: {},
    kit: { publicKey: null, kitId: null, challenge: null, confirmed: false },
    pairing: [],
    backup: 'unprotected',
    update: 'Healthy',
  });
  const used = blank(DEVICES.used, 'Studio Whombat');
  used.claimedBy = 'acc_someoneelse';
  used.lookup = null;
  const contested = blank(DEVICES.contested, 'Whombat');
  contested.competing = true;
  const community: ApplianceState = {
    ...blank(DEVICES.community, 'Whombat'),
    edition: 'community',
    lookup: null,
  };
  const own: ApplianceState = {
    ...blank(DEVICES.own, 'Whombat'),
    lookup: null,
    own: { host: FAKE_OWN_HOST, claimLink: FAKE_OWN_CLAIM_LINK, linkedTo: null, reachable: true, users: {} },
  };
  return {
    signedIn: false,
    org: null,
    lastLink: null,
    nearby: [DEVICES.fresh],
    appliances: {
      [DEVICES.fresh]: blank(DEVICES.fresh, 'Burrow HQ'),
      [DEVICES.used]: used,
      [DEVICES.contested]: contested,
      [DEVICES.mismatched]: blank(DEVICES.mismatched, 'Whombat'),
      [DEVICES.spare]: blank(DEVICES.spare, 'New Whombat'),
      [DEVICES.community]: community,
      [DEVICES.own]: own,
    },
  };
}

function load(): WorldState {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) return JSON.parse(raw) as WorldState;
  } catch {
    // start fresh
  }
  return initial();
}

const json = (status: number, body: unknown) => ({ status, body });
/** `list` with `item` in it (`on`) or not. */
const toggled = (list: string[] | undefined, item: string, on: boolean) => [
  ...(list ?? []).filter((x) => x !== item),
  ...(on ? [item] : []),
];
const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  json(status, { error: { code, message, ...(details && { details }) } });

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Fresh console letters (CC-01), never the same as the ones before. */
function newLetters(before?: string): string {
  for (;;) {
    const l = generateClaimLetters(randomBytes);
    if (l !== before) return l;
  }
}

function randomCode(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  const n = (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0;
  const digits = String(n % 100_000_000).padStart(8, '0');
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/** The A3 box's `OwnAddressSummary` (4.3): a certificate for two more months, checked an hour ago. */
function ownAddressOf(own: NonNullable<ApplianceState['own']>) {
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const leaving = own.leaving && Date.parse(own.leaving.until) > Date.now() ? own.leaving : null;
  return {
    host: own.host,
    url: `https://${own.host}/`,
    state: own.starting ? 'starting' : 'ready',
    reachable: own.reachable,
    ...(leaving && {
      leaving: { host: leaving.host, url: `https://${leaving.host}/`, until: leaving.until },
    }),
    certificateEndsAt: at(24 * 60),
    watch: {
      lastCheckAt: at(-1),
      missed: own.missed ? [{ from: at(-24 * 5), to: at(-24 * 4) }] : [],
      foreign: own.foreign
        ? [
            {
              spkiSha256: 'ab'.repeat(32),
              names: [own.host],
              notBefore: at(-3),
              notAfter: at(24 * 6),
              firstSeenAt: at(-2),
            },
          ]
        : [],
    },
  };
}

function b64url(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fakeEndpoint(label: string): EndpointRecord {
  return {
    accountId: LOCAL.id,
    label,
    platform: 'web',
    createdAt: new Date().toISOString(),
    revokedAt: null,
    applied: false,
  };
}

function hex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A phone sign-in handoff as the fake control keeps it (CT-190). */
interface FakeHandoff {
  handoffId: string;
  token: string;
  tokenExpiresAt: number;
  expiresAt: number;
  state: PhoneHandoffView['state'];
  report: PhoneHandoffView['report'];
}

/** A QR code's token works 5 minutes; its handoff lives 15 (`PHONE_HANDOFF_TOKEN_TTL_S`, `PHONE_HANDOFF_TTL_S`). */
const PHONE_TOKEN_MS = 300_000;
const PHONE_HANDOFF_MS = 900_000;

/** The APK the fake control hands out (CT-191); `androidDownload(null)` takes it away. */
const FAKE_APK: AndroidDownload = {
  version: '0.16.0',
  versionCode: 16000,
  size: 41_234_567,
  sha256: 'a3f1c9d27b6e4f80a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
  publishedAt: '2026-09-30T12:00:00.000Z',
  url: 'https://api.whombat.com/v1/downloads/android/whombat-0.16.0.apk',
};

export interface FakeFaults {
  reset(): void;
  /** Servers (the hosts fixtures) in this world from the next load on, as `VITE_FIXTURE_HOSTS=1` does. */
  servers(on: boolean): void;
  /** Consoles opened over the session's console stream since the page loaded (contracts 0.80.1). */
  consolesOpened(): number;
  /** The appliance's AI side (sign-ins, consoles, clients): install faults, expire a console, … */
  ai(device: string): FakeAi;
  cards(): Record<ControlBox, FakeCard>;
  /** What each unclaimed box's console shows now (the letters rotate after a wrong try). */
  consoles(): Record<ControlBox, FakeConsole | null>;
  /** The boxes `claims.nearby` finds (by key: `fresh`, `contested`, `mismatched`); none with `[]`. */
  nearby(keys: (keyof typeof DEVICES)[]): void;
  /** `enroll.claim.begin` is refused for this long (CC-07 backoff). */
  claimBackoff(device: string, seconds: number): void;
  /** What the box's screen shows for a device signing in there (BX-06), or null. */
  screenSignIn(device: string): FakeScreenSignIn | null;
  /** The box writes no console file (no screen to show a code on): `screen_unavailable` (BX-02). */
  noScreen(device: string, value: boolean): void;
  /** The code showing runs out now (`screen_signin_missing` on the next try). */
  expireScreenSignIn(device: string): void;
  /** The magic link the last sign-in request "emailed". */
  lastLink(): string | null;
  controlDown(value: boolean): void;
  relayDown(value: boolean): void;
  /** Draw the open box as its own local-network page would (AP-5325); taken at the next load. */
  boxPage(value: boolean): void;
  /**
   * The community box (AP-5430): what its screen shows while unclaimed (null once claimed), the box page as plain HTTP,
   * the last device link it made.
   */
  communityLetters(): string | null;
  insecurePage(value: boolean): void;
  /**
   * The box target's page shows the A3 box at its own address (own-address.md) from the next load: its claim link's
   * secret while unclaimed, and what its certificate watch found (`foreign`, `missed`).
   */
  ownBox(value: boolean, watch?: { foreign?: boolean; missed?: boolean }): void;
  /**
   * The A3 box changed its address to `<label>.whombat.app` (4.16): its first address is the leaving one for `days`
   * more, the account's box passkey stays under it, and the page stands at `page` (`old`: the leaving address, with
   * the moved banner; `new`: the new one, with the passkeys section's prompt). Null puts the first address back.
   */
  ownRenamed(change: { label: string; days?: number; page?: 'old' | 'new' } | null): void;
  /** `ownAddress.rename` refuses with this code (`rename_limit`, `label_taken`, …); null: it works. */
  ownRenameRefusal(code: string | null): void;
  /**
   * Whombat Link's state on the box target's box (4.4), or on `device` when given: `grace` ends in a week, `on` may run
   * its free month.
   */
  linkState(state: LinkSummary['state'], extra?: Partial<LinkSummary>, device?: string): void;
  ownClaimLink(): string | null;
  /** The four letters the A3 box's screen shows while unclaimed. */
  ownLetters(): string | null;
  /** The newest link code control made for the account. */
  lastWhombatLink(): string | null;
  /** A link code as the account's page would make it (the box target has no account page). */
  makeWhombatLink(): string;
  /** The A3 box claimed and linked to Mara's account already (the hosted list's view of it). */
  ownLinked(): void;
  lastLocalLink(): string | null;
  applianceOffline(device: string, value: boolean): void;
  dropConnections(device: string): void;
  loseResults(device: string, n?: number): void;
  swallowRequests(device: string, n?: number): void;
  slowAccept(device: string, ms: number): void;
  /** The appliance speaks only these protocol majors from now on. */
  protocol(device: string, majors: number[]): void;
  /** Another of the person's devices revokes this browser's key. */
  revokeEndpoint(device: string, peerId: string): void;
  /** A new device asks to pair; returns the code it shows. */
  requestPairing(device: string, label?: string): string;
  /** A trusted device approves this browser's pending pairing request. */
  approveMyPairing(device: string): void;
  /** The kit belongs to another account (recovery into the session's account is refused). */
  kitOwner(device: string, accountId: string): void;
  /** The kit was saved but never confirmed. */
  kitUnconfirmed(device: string): void;
  /** The running release's client floor (CT-53); null lifts it. Refused at the next connection. */
  clientFloor(device: string, floor: Record<string, number> | null): void;
  /** The stored diagnostic bundle changes under its recorded hash (the preview must be refused). */
  tamperDiagnostics(device: string): void;
  /** Another device takes over a pending code after it was looked up (the approval must be refused, CT-46). */
  hijackPairing(device: string, code: string): void;
  /** The appliance sends a push about `link`; returns its opaque ref (what a tap carries). */
  pushRef(device: string, link: Record<string, unknown>): string;
  providers(device: string, rows: ProviderStatus[]): void;
  backup(device: string, state: ApplianceState['backup']): void;
  /** The update as `appliance.status` reports it: journal state and the 0.22 facts (waiting, failure, last update). */
  update(device: string, value: FakeUpdate): void;
  /** What control says a release brought (`rollout.releaseSummary`); null forgets it (a 404). */
  releaseSummary(release: string, summary: string | null): void;
  /** Members a newer appliance adds to `backup.recoveryMaterial` (the kit can't carry what it doesn't know). */
  backupMaterial(device: string, extra: Record<string, unknown> | null): void;
  /** The box runs a version from before the passkey: no `bringBack`, its recovery kit holds the backups' key. */
  beforePasskey(device: string): void;
  /**
   * A passkey-locked kit control keeps for another, retired Whombat named `name` (backup-options.md AP-6815): what
   * “Is this a new Whombat?” finds. Its envelope opens with no passkey (the fake has no PRF).
   */
  kitEnvelope(name: string): void;
  /** The box's backup service in a state review shots need (backups v2: a restore that stops, copies found nearby). */
  backupOptions(device: string, patch: FakeBackupPatch): void;
  /** Another device of this account, on a platform only a newer app knows (a security view, AP-266). */
  newerDevice(device: string, platform: string): void;
  publish(device: string, topic: string, event: { type: string; [k: string]: unknown }): void;
  /** The appliance's copy of a canvas, as JSON text. */
  canvas(canvasId: string): string;
  state(): WorldState;
  /** How many times the sign-in token was exchanged since this page loaded. */
  verifyCalls(): number;
  /**
   * The directory lies about this device (AP-64): `true` reports an impostor's identity, a string that PeerId, `false`
   * the truth again. Only control's list changes; the box keeps its identity. Survives a reload.
   */
  lieAbout(device: string, value: boolean | string): void;
  /** The box's real identity. */
  peerOf(device: string): string | null;
  /**
   * An operator retires this Whombat (AP-697): listed `retired`, its tickets refused (404 `device_not_found`), not
   * nearby, not claimable; `false` undoes it. Connections already open stay until they drop (`dropConnections`).
   * Survives a reload.
   */
  retire(device: string, value?: boolean): void;
  /** Control no longer holds this Whombat for the organization (AP-697): not listed, its tickets refused. */
  release(device: string, value?: boolean): void;
  /** The appliance's licence state from now on (`none`: a runtime without licences). */
  licence(device: string, value: FakeLicence | FakeLicence['kind']): void;
  /** Control refuses claims with this reason (null: no more). */
  claimRefusal(reason: WorldState['claimRefusal']): void;
  /** The box's own screen from now on (`deskFixtures.ts`; null: a VM without a display). */
  desk(device: string, kind: DeskFixtureKind | null): void;
  /** The letters the box's screen shows while the person pairs it, or null. */
  deskLetters(device: string): string | null;
  /** Someone at the box's screen presses “Confirm on your phone” (DK-04). */
  deskRequestUnlock(device: string): void;
  /** The box's machine from now on (`machineFixtures.ts`: `z13`, `vm`, `nodriver`; null: none). */
  machine(device: string, kind: FakeMachine | null): void;
  /** The machine's cable plugged in or out (without it a join to a network without internet goes back). */
  machineCable(device: string, plugged: boolean): void;
  /** The machine's Wi-Fi as it is now (the network in use and the saved ones), or null without a machine. */
  machineNetwork(device: string): FakeNetworkSnapshot | null;
  /** The machine's paired Bluetooth devices as they are now, or null without a machine. */
  machineBluetooth(device: string): FakeBluetoothSnapshot | null;
  /** The person finished Tailscale's sign-in page (AP-5326): it comes on. */
  tailscaleSignedIn(device: string): void;
  /** Tailscale's state on the box now. */
  tailscaleState(device: string): string;
  /** Whether the person let the box's screen in. */
  deskUnlocked(device: string): boolean;
  /**
   * Whombat support connects to the box (remote-help.md AP-4447): a visit by `who` (Support) with the demo steps; its id,
   * or null while remote help is off.
   */
  remoteHelpVisit(device: string, who?: string): string | null;
  /** Support leaves (the newest visit). */
  remoteHelpLeave(device: string): void;
  /** The image's `whombat.environment` (`prod`: a help code, no Forever) and whether a support key is pinned. */
  remoteHelpBox(device: string, box: { environment?: 'local' | 'dev' | 'prod'; available?: boolean }): void;
  /** Remote help as the box keeps it now. */
  remoteHelp(device: string): FakeRemoteHelpSnapshot;
  /** Control refuses account deletion with this reason (null: no more). */
  deleteRefusal(reason: WorldState['deleteRefusal']): void;
  /** The appliance terms version each claim was started with. */
  claimTerms(): string[];
  /** The identity a lying directory reports. */
  impostorPeer(): string;
  /** Every connection this page attempted since it loaded (device, pinned identity, channel). */
  connects(): { device: string; peerId: string; channel: string }[];
  /** What `connections.finishGoogle` received on this Whombat (AG-14). */
  googleFinishes(device: string): { code: string | null; state: string; error: string | null }[];
  /** What `connections.finishOAuth` received on this Whombat (a service's sign-in). */
  oauthFinishes(device: string): { code: string | null; state: string; iss: string | null }[];
  /** Website feedback through the drop: available, unsupported by the cloud, or a runtime without it (FD-25). */
  feedbackDrop(device: string, value: FakeFeedbackDrop): void;
  /** Control's signup settings from now on (BL-25): mode, billing provider, trial days. */
  signup(value: Partial<NonNullable<WorldState['signup']>>): void;
  /** Change the org's subscription (as an operator or Stripe would). */
  billing(patch: Partial<FakeBilling>): void;
  /** The account already has an organization from before Whombat Link (the e2e journeys' starting point). */
  existingOrg(name?: string): void;
  /** A box turns Whombat Link on (`link.begin`): the code its screen shows. */
  linkCode(name?: string | null): string;
  /** Change the account's Link plan (as Stripe, the trial job or an operator would). */
  linkPlan(patch: Partial<LinkAccount['plan']> & { manual?: boolean }): void;
  /** The Subscription Terms version each `link.confirm` was sent with (null: none), oldest first. */
  linkTerms(): (string | null)[];
  /** Another payment page is being opened from now on (`checkout_busy`), or not. */
  checkoutBusy(on: boolean): void;
  /** The account forgets every Subscription Terms acceptance (an account from before control asked for them). */
  linkTermsForget(): void;
  /** Whether Stripe has the Link subscription from now on (null: a card on file says so). */
  linkStripe(on: boolean | null): void;
  /** A payment page is open for this interval for half an hour (as if opened in another tab), or none. */
  paymentPageOpen(interval: 'month' | 'year' | null): void;
  /** Change one of the account's Link boxes (its state, grace end, address). */
  linkBox(device: string, patch: Partial<LinkedBox>): void;
  /** Boxes linked from now on wait for their own address, as a real box does for a minute or two. */
  linkAddressLater(on: boolean): void;
  /** Every box still waiting gets its address now. */
  linkAddress(): void;
  /** How long Stripe's webhook takes after a checkout (default 3 s). */
  checkoutLag(ms: number): void;
  /** This Whombat already had a free trial in another org (BL-17). */
  trialUsed(device: string): void;
  /** The APK control hands out from now on (CT-191); null: none published. */
  androidDownload(value: AndroidDownload | null): void;
  /** Every phone sign-in handoff this page made (CT-190), oldest first. */
  phoneHandoffs(): { handoffId: string; state: PhoneHandoffView['state'] }[];
  /**
   * A phone scans the QR code (`link`, or the one on screen) and redeems its token: the handoff says `scanned`. False
   * when the code is unknown, used or expired.
   */
  phoneScan(link?: string): boolean;
  /**
   * The phone reports back (AP-527): a code that names a Whombat gets a real pending pairing there (`Pixel 9`, Android)
   * and a report with its code, fingerprint and the MAC under the code's key; returns the pairing code. `kind:
   * 'signed_in'` (or a code without a Whombat) reports that nothing is left to do. `tamper` forges the report: a MAC
   * under another key, or another device's fingerprint (with a valid MAC).
   */
  phoneReport(
    link?: string,
    options?: { label?: string; kind?: 'pairing' | 'signed_in'; tamper?: 'mac' | 'fingerprint' },
  ): string | null;
  /** The newest handoff's 15 minutes are over (control forgets it). */
  expirePhoneHandoff(): void;
  /** Whether the phone that reported by QR code was let in anywhere. */
  phoneLetIn(): boolean;
  /** Who joined the waitlist. */
  waitlist(): NonNullable<WorldState['waitlist']>;
  /** The terms version and code each org creation was sent with. */
  created(): NonNullable<WorldState['created']>;
  /** The passkeys a Whombat keeps (removed ones too), and control's. */
  passkeys(device: string): FakeWhombatPasskey[];
  controlPasskeys(): FakeControlPasskey[];
  /** Control's next sign-in options carry this challenge instead of the one bound to the device (PK-03). */
  passkeyChallenge(challenge: string | null): void;
  /** Control refuses the next passkey registrations (PK-06's rollback). */
  controlPasskeyDown(value: boolean): void;
  /** The Whombat answers `enroll.passkey` with an error the app has no words for (AP-806: a sign-in stopped halfway). */
  passkeyEnrollDown(value: boolean): void;
  /** Another device of Mara's signs in with her newest passkey now (PK-09): returns its endpoint PeerId. */
  passkeySignInElsewhere(device: string, label?: string): string;
}

export interface FakeWorld {
  control: ControlApi;
  connector(target: ConnectTarget): SessionConnector;
  faults: FakeFaults;
  /**
   * The open box as its own page would show it (`boxPage(true)`, AP-5325): what that page goes without, said there.
   * The hosted fake build only stands in for the page's words; the box's page itself is the `box` target.
   */
  page(): { kind: 'box'; secure: boolean } | undefined;
  /**
   * The community box as the box target's page reaches it (`BoxEnvironment`, AP-5430): its `/v1/direct` answer and its
   * direct socket, pinned like the real one.
   */
  box(): {
    identity(): Promise<DirectIdentity | null>;
    connector(target: { peerId: string; key: { peerId: string } }): SessionConnector;
    secure(): boolean;
    /** The own-address host the page stands in for (the A3 box), or null. */
    ownAddress(): string | null;
  };
}

export async function createFakeWorld(): Promise<FakeWorld> {
  let state = load();
  const save = () => localStorage.setItem(STORAGE, JSON.stringify(state));
  save();
  const peers: Record<string, string> = {};
  for (const d of Object.values(DEVICES)) peers[d] = await peerIdFor(d);
  /** A phone that asks to pair (a valid PeerId, like every endpoint). */
  const otherPeer = await peerIdFor('hugos-phone');
  const strangerPeer = await peerIdFor('strangers-phone');
  let controlDown = false;
  let verifyCalls = 0;
  /** Passkeys (PK-04, PK-06): control's challenges and the Whombats' begins, in memory like the real ones' TTLs. */
  const authChallenges = new Map<string, string>();
  let registerChallenge: { challenge: string; appliance: string; ownerHandle?: string } | null = null;
  const passkeyBegins = new Map<string, { nonce: string; accountId: string; ownerHandle?: string }>();
  const rpId = () => window.location.hostname;
  /** Phone sign-in handoffs (CT-190), in memory: a reload starts without them, like a fresh QR code. */
  const handoffs = new Map<string, FakeHandoff>();
  /** The handoff as control sees it now: the token runs out unused (expired), the handoff after 15 minutes (gone). */
  const liveHandoff = (handoffId: string): FakeHandoff | null => {
    const h = handoffs.get(handoffId);
    if (!h || Date.now() >= h.expiresAt) return null;
    if (h.state === 'waiting' && Date.now() >= h.tokenExpiresAt) h.state = 'expired';
    return h;
  };
  /** The link the fake phone scanned last (the page shows no code once it is scanned). */
  let lastScanned: string | null = null;
  /** The link the page shows as its QR code (the fake phone “scans” it), or the one given. */
  const shownLink = (link?: string) => {
    const text =
      link ??
      document.querySelector<HTMLElement>('[data-phone-link]')?.getAttribute('data-phone-link') ??
      lastScanned ??
      '';
    return parsePhoneSignInLink(text, [window.location.origin]);
  };
  const handoffFor = (link?: string): FakeHandoff | null => {
    const parsed = shownLink(link);
    const h = parsed && [...handoffs.values()].find((x) => x.token === parsed.token);
    return h ? liveHandoff(h.handoffId) : null;
  };
  /** The phone that signs in by QR code and asks to be let in. */
  const qrPhonePeer = await peerIdFor('pixel-by-qr-code');
  let relayDown = false;
  /** The community box (AP-5430): its local claim starts and begins per session, its mail server, its last link. */
  const localStarts = new Map<string, string>();
  const localBegins = new Map<string, { claimId: string; tags: ClaimConfirmTags }>();
  /** Claim ids whose proofs checked out (`enroll.claim.local.prove`): the one claim each may make. */
  const localProofs = new Map<string, string>();
  const mails = new Map<string, FakeMail>();
  const mailFor = (device: string) => {
    let m = mails.get(device);
    if (!m) {
      m = createFakeMail('none');
      mails.set(device, m);
    }
    return m;
  };
  let lastLocalLink: string | null = null;
  /** The community box's direct ways: the page this world runs in (its links open here). */
  const communityRoutes = () => [ownRoute()];
  const offline = new Set<string>();
  const impostorPeer = await peerIdFor('impostor-appliance');
  /** Every connection this page attempted since it loaded: which device, pinned to which identity, on which channel. */
  const connects: { device: string; peerId: string; channel: string }[] = [];
  /** Files (AP-779): shared with the fixture layer, so an upload of this world can be saved into Files. */
  const filesWorld = createFilesWorld({ seed: import.meta.env.VITE_FIXTURE_FILES === '1' });
  /** Backup files (AP-1205): shared with the fixture layer, which answers `backups.*`; the streams carry the bytes. */
  const backupWorld = createBackupWorld({ seed: backupsSeeded(undefined) });
  // Servers (the hosts fixtures, AP-1340) on when the build asks (VITE_FIXTURE_HOSTS) or the e2e suite turned them on.
  const fixtures = createWebFixtureFetch({
    signedIn: true,
    filesWorld,
    backupWorld,
    ...(state.servers ? { hosts: true } : {}),
  });
  /** Consoles over the session (contracts 0.80.1): a tiny shell behind each `hosts.createConsole` token. */
  const consolesWorld = createFakeConsoles();
  const attachments = new Map<
    string,
    { name: string; contentType: string; size: number; bytes: Uint8Array | null; conversationId?: string }
  >();
  /** People's photos (CT-265, PA-07): person id → the attachment URL the session streams. */
  const photos = new Map<string, string>();
  const fakes = new Map<string, FakeAppliance>();
  /**
   * Each appliance's AI side, for Mara: Claude Code installed (the only client, ChatGPT needs none); only
   * sign-ins and installed clients survive a reload (`ApplianceState.ai`).
   */
  const ais = new Map<string, FakeAi>();
  const aiFor = (device: string): FakeAi => {
    let ai = ais.get(device);
    if (!ai) {
      const restore = state.appliances[device]?.ai;
      ai = createFakeAi({ installed: { claude: '2.1.278' }, ...(restore && { restore }) });
      ais.set(device, ai);
    }
    return ai;
  };
  /**
   * Each box's own screen (desk-display-web.md AP-3012): `desk.*` answered by `createFakeDesk`, its pairing and
   * choices kept in `ApplianceState.desk`, every change a `desk.changed` to Mara and the paired person.
   */
  const desks = new Map<string, FakeDesk>();
  const deskKind = (device: string) => {
    const a = state.appliances[device];
    return a?.desk ? a.desk.kind : deskFixtureKind();
  };
  const deskFor = (device: string): FakeDesk => {
    const known = desks.get(device);
    if (known) return known;
    const kind = deskKind(device);
    const seed = deskSeed(kind, Date.now());
    const kept = state.appliances[device]?.desk;
    const desk = createFakeDesk({ ...seed, initial: kept ? kept.snapshot : seed.initial });
    desk.onChange(() => {
      const a = state.appliances[device];
      if (a) a.desk = { kind, snapshot: desk.snapshot() };
      save();
      const people = new Set([mara.id, desk.snapshot().paired?.personId ?? mara.id]);
      for (const id of people) fakes.get(device)?.publish(`me:${id}`, { type: 'desk.changed' });
    });
    desks.set(device, desk);
    if (kind === 'request' && !kept) desk.requestUnlock();
    return desk;
  };
  /**
   * Each box's machine (hardware-support-web.md AP-3231): `host.network`, `host.wifi.*` and `host.cable.set` answered by
   * `createFakeNetwork`, its Wi-Fi kept in `ApplianceState.machine`; `host.hardware` the machine's report.
   */
  const networks = new Map<string, FakeNetwork>();
  const machineKind = (device: string): FakeMachine | null => {
    const a = state.appliances[device];
    return a?.machine ? a.machine.kind : machineFixtureKind();
  };
  const networkFor = (device: string): FakeNetwork | null => {
    const kind = machineKind(device);
    if (!kind) return null;
    const known = networks.get(device);
    if (known) return known;
    const kept = state.appliances[device]?.machine?.network ?? null;
    const network = createFakeNetwork({ machine: kind, initial: kept?.machine === kind ? kept : null });
    network.onChange(() => {
      const a = state.appliances[device];
      if (a) a.machine = { ...a.machine, kind, network: network.snapshot() };
      save();
    });
    networks.set(device, network);
    return network;
  };
  /**
   * Each box's Bluetooth (bluetooth-web.md AP-3717): `host.bluetooth*` answered by `createFakeBluetooth` on the machine's
   * kind, its paired devices kept in `ApplianceState.machine`.
   */
  const bluetooths = new Map<string, FakeBluetooth>();
  const bluetoothFor = (device: string): FakeBluetooth | null => {
    const kind = machineKind(device);
    if (!kind) return null;
    const known = bluetooths.get(device);
    if (known) return known;
    const kept = state.appliances[device]?.machine?.bluetooth ?? null;
    const bluetooth = createFakeBluetooth({ machine: kind, initial: kept?.machine === kind ? kept : null });
    bluetooth.onChange(() => {
      const a = state.appliances[device];
      if (a)
        a.machine = {
          ...a.machine,
          kind,
          network: a.machine?.network ?? null,
          bluetooth: bluetooth.snapshot(),
        };
      save();
    });
    bluetooths.set(device, bluetooth);
    return bluetooth;
  };
  /** Each box's Tailscale (AP-5326): off until the person turns it on; in memory (a reload starts it off). */
  const tailscales = new Map<string, FakeTailscale>();
  const tailscaleFor = (device: string): FakeTailscale => {
    const known = tailscales.get(device);
    if (known) return known;
    const t = createFakeTailscale('off');
    tailscales.set(device, t);
    return t;
  };
  /**
   * Each box's remote help (remote-help.md AP-4447): `remoteHelp.*` answered by `createFakeRemoteHelp`, kept in
   * `ApplianceState.remoteHelp`; the passkey assertion checked against the begun choice and the session's key.
   */
  const remoteHelps = new Map<string, FakeRemoteHelp>();
  const remoteHelpFor = (device: string): FakeRemoteHelp => {
    const known = remoteHelps.get(device);
    if (known) return known;
    const remote = createFakeRemoteHelp({
      initial: state.appliances[device]?.remoteHelp ?? null,
      rpId,
      onChange: (snapshot) => {
        const a = state.appliances[device];
        if (a) a.remoteHelp = snapshot;
        save();
      },
    });
    remoteHelps.set(device, remote);
    return remote;
  };
  /**
   * Backup places (backup-places.md AP-6716): the fixture's, with blackbox only ready while nothing backs the box up;
   * a place set up becomes the box's destination, and the list is kept with the box.
   */
  const backupPlaces = new Map<string, FakeBackupPlaces>();
  const backupPlacesFor = (device: string): FakeBackupPlaces => {
    const known = backupPlaces.get(device);
    if (known) return known;
    const a = state.appliances[device];
    const fixture = backupPlacesFixture();
    // The fixture's place is in use only when the backups go to it: a destination typed in by hand is no place.
    const inPlace = fixture.places.some(
      (p) => p.state === 'in_use' && !!p.address && !!a?.backupRepo?.includes(`//${p.address}:`),
    );
    const initial: BackupPlacesList =
      a?.backupPlaces ??
      (inPlace
        ? fixture
        : {
            currentPlaceId: null,
            places: fixture.places.map((p) =>
              p.state === 'in_use' ? { ...p, state: 'ready' as const, kept: null, location: null } : p,
            ),
          });
    const places = createFakeBackupPlaces({ initial, setupMs: 1200, moveMs: 3000 });
    backupPlaces.set(device, places);
    return places;
  };
  /**
   * Backup options, the list of backups and bringing a Whombat back (backup-options.md AP-6815): the fixture's, per box,
   * backed up once a place or a kit's backups are its destination.
   */
  const backupOptions = new Map<string, FakeBackupOptions>();
  const backupOptionsFor = (device: string): FakeBackupOptions => {
    const known = backupOptions.get(device);
    if (known) return known;
    // A new box: no passkey holds its backups' key until the person touches one (backup-passkey.md).
    const made = createFakeBackupOptions({
      appliance: device,
      appliancePeerId: peers[device],
      restoreStageMs: 2500,
      bringBackAtStart: 'needs_passkey',
    });
    backupOptions.set(device, made);
    return made;
  };
  /** Getting one thing back from a backup (backup-look.md AP-6940), per box. */
  const backupLooks = new Map<string, FakeBackupLook>();
  const backupLookFor = (device: string): FakeBackupLook => {
    let made = backupLooks.get(device);
    if (!made) {
      made = createFakeBackupLook({ openMs: 2500 });
      backupLooks.set(device, made);
    }
    return made;
  };
  const collab = createFakeCollabHub();
  /** Live `enroll.claim.begin`s per session (device and endpoint), as the runtime keeps them (CC-07). */
  const claimBegins = new Map<string, { claimId: string; method: 'code' | 'card'; tags: ClaimConfirmTags }>();
  /**
   * The screen sign-in (BX-02…BX-05): one per box, in memory as the runtime keeps it, its live begins per session, the
   * wrong guesses (the runtime keeps those in its database) and the boxes without a screen.
   */
  const screenSignIns = new Map<
    string,
    {
      signinId: string;
      letters: string;
      peer: string;
      accountId: string;
      label: string;
      platform: 'web' | 'android' | 'ios';
      expiresAt: number;
    }
  >();
  const screenBegins = new Map<string, { signinId: string; letters: string; tags: ClaimConfirmTags }>();
  const screenFailures = new Map<string, { count: number; until: number | null }>();
  const noScreen = new Set<string>();
  /** A live sign-in of this box (an expired one is gone). */
  const liveScreenSignIn = (device: string) => {
    const live = screenSignIns.get(device);
    if (live && live.expiresAt <= Date.now()) screenSignIns.delete(device);
    return screenSignIns.get(device) ?? null;
  };
  const keyOf = (device: string) =>
    (Object.keys(DEVICES) as (keyof typeof DEVICES)[]).find((k) => DEVICES[k] === device) ?? 'fresh';
  /** An enrolled answer for an endpoint the box never recorded (the mismatched box's lie). */
  const enrolledAs = (a: ApplianceState, peerId: string, label: string) => ({
    ...enrolled({ ...a, endpoints: { ...a.endpoints, [peerId]: fakeEndpoint(label) } }, peerId),
  });

  const endpointsById = new Map<string, AnyEndpoint>();
  for (const group of Object.values(api))
    for (const ep of Object.values(group as Record<string, AnyEndpoint>)) endpointsById.set(ep.id, ep);

  async function viaFixtures(ep: AnyEndpoint, input: { params?: unknown; query?: unknown; body?: unknown }) {
    const url = `${FIXTURE_BASE_URL}${ep.base}${buildPath(ep.path, (input.params ?? {}) as Record<string, string>)}${toQueryString((input.query ?? {}) as Record<string, unknown>)}`;
    const res = await fixtures(url, {
      method: ep.method,
      headers: { 'content-type': 'application/json' },
      ...(ep.method === 'GET' || input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  function summary(a: ApplianceState, peerId: string, me: string) {
    const e = a.endpoints[peerId] as EndpointRecord;
    return {
      endpointId: `end_${peerId.slice(-10)}`,
      peerId,
      label: e.label,
      platform: e.platform,
      accountId: e.accountId,
      createdAt: e.createdAt,
      lastSeenAt: peerId === me ? new Date().toISOString() : e.createdAt,
      current: peerId === me,
      revokedAt: e.revokedAt,
      revocation: e.revokedAt ? (e.applied ? 'applied' : 'pending') : 'none',
    };
  }

  /** A bundle as the runtime builds it: one allowlisted section per chosen scope (CT-52), fixture values. */
  function diagnosticBundle(device: string, bundleId: string, scopes: string[]) {
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const sections: Record<string, unknown> = {
      versions: {
        runtimeVersion: '1.3.0',
        schemaVersion: 33,
        protocol: { major: 1, minor: 0 },
        releaseId: 'rt-2026.09.25-1',
        providers: [{ provider: 'claude', version: '2.1.0' }],
      },
      health: {
        status: 'ok',
        uptimeS: 86400,
        checks: [
          { name: 'db', ok: true },
          { name: 'sessionEndpoint', ok: true },
        ],
        external: [{ name: 'relay', state: 'ok' }],
        draining: false,
        quarantined: false,
        claimed: true,
        claimReported: true,
        recovery: { enrolled: true, kitVerified: true },
        revocations: { pending: 0, applied: 0 },
        providers: [{ provider: 'claude', authMode: 'subscription', kind: 'account', state: 'ready' }],
      },
      updates: {
        state: 'Healthy',
        current: 'rt-2026.09.25-1',
        knownGood: 'rt-2026.09.25-1',
        candidate: null,
        hold: false,
        readOnly: false,
        failure: null,
        deferredReason: null,
        lastCheckedAt: createdAt,
        clientFloor: null,
      },
      backup: {
        state: 'unprotected',
        lastSuccessAt: null,
        ageS: null,
        coverage: [],
        unprotected: ['database'],
        relogin: [],
        lastFailure: null,
        recoverable: false,
      },
      connectivity: {
        relay: 'connected',
        lastConnectedAt: createdAt,
        lastErrorCode: null,
        activeSessions: 1,
        counters: {
          relayConnects: 3,
          relayDisconnects: 2,
          sessionsOpened: 12,
          sessionsRefusedVersion: 0,
          handshakeFailures: 0,
        },
      },
      errors: {
        entries: [{ code: 'unavailable', appCode: null, op: 'messages.send', count: 2, lastAt: createdAt }],
        truncated: false,
      },
    };
    return {
      format: DIAGNOSTIC_BUNDLE_FORMAT,
      bundleId,
      appliance: peers[device] as string,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + DIAGNOSTICS_TTL_S * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
      windowS: DIAGNOSTICS_WINDOW_S,
      scopes,
      ...Object.fromEntries(scopes.map((sc) => [sc, sections[sc]])),
    };
  }

  function enrolled(a: ApplianceState, peerId: string) {
    const accountId = a.endpoints[peerId]?.accountId ?? LOCAL.id;
    const acc = accountOf(a, accountId);
    return {
      accountId,
      name: acc?.name ?? LOCAL.name,
      // The session's account is the person's (`owner` true on the wire; nobody else signs in, OP-01).
      owner: true,
      principals: [{ burrowId: burrow.id, principalId: acc?.principalId ?? mara.id }],
      endpoint: summary(a, peerId, peerId),
      authzGeneration: 1,
    };
  }

  /** message id → attachment ids (the fixture world keeps no files). */
  const messageFiles = new Map<string, string[]>();
  /** Each file says whether it is in its conversation's Files (contracts 0.59 CT-312, AP-834). */
  function withFiles(m: { id: string; attachments?: unknown[] }) {
    const ids = messageFiles.get(m.id);
    if (!ids) return;
    m.attachments = ids.flatMap((id) => {
      const f = attachments.get(id);
      return f ? [{ ...attachmentOf(id, f), inFiles: !!filesWorld.find(id) }] : [];
    });
  }
  /** Whether an upload went out on a message (then it is a message's file, not an unsent upload). */
  const sentOnMessage = (attachmentId: string) =>
    [...messageFiles.values()].some((ids) => ids.includes(attachmentId));

  /**
   * After a message's file went into Files or left it: the message again for everyone in the conversation
   * (`message.updated`, its files' `inFiles` as they are now) and the conversation's Files (`files.changed`), as the
   * runtime sends them (CT-312).
   */
  async function announceMessageFile(device: string, attachmentId: string) {
    const known = filesWorld.messageOf(attachmentId);
    if (!known) return;
    const read = await viaFixtures(api.messages.get, {
      params: { burrow: burrow.slug, messageId: known.id },
    });
    const message =
      read.status === 200
        ? (read.body as { message: { id: string; attachments?: unknown[] } }).message
        : known;
    withFiles(message);
    const fake = fakeFor(device);
    fake.publish(`conv:${known.conversationId}`, { type: 'message.updated', message });
    fake.publish(`me:${mara.id}`, { type: 'files.changed', conversationId: known.conversationId });
  }

  function attachmentOf(id: string, f: { name: string; contentType: string; size: number }) {
    return {
      id,
      name: f.name,
      contentType: f.contentType,
      size: f.size,
      url: `/api/v1/burrows/${burrow.slug}/attachments/${id}`,
      kind: f.contentType.startsWith('image/')
        ? 'image'
        : f.contentType.startsWith('text/')
          ? 'text'
          : 'file',
      width: null,
      height: null,
    };
  }

  /** `licenceStatus`'s answer as the runtime would give it (LC-09, CT-77), from the fault's kind. */
  function licenceView(a: ApplianceState) {
    // A community box has no licence (HE-58), as a development runtime has none.
    if (a.edition === 'community') return undefined;
    const l = a.licence ?? { kind: 'active' as const };
    if (l.kind === 'none') return undefined;
    const { state: st, reason } = LICENCE_STATES[l.kind];
    const day = 86_400_000;
    const t = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();
    const token = l.kind !== 'no_licence';
    const limits = l.limits ?? { connectors: 3 };
    return {
      state: st,
      reason,
      plan: token ? (l.kind === 'trial' ? 'trial' : 'whombat') : null,
      limits: token ? { devices: 3, ...limits } : null,
      renewedAt: token ? at(st === 'licensed' ? t - day : t - 20 * day) : null,
      expiresAt: token ? at(st === 'licensed' ? t + 13 * day : t - 6 * day) : null,
      graceEndsAt: l.kind === 'cancelled' ? null : at(st === 'licensed' ? t + 43 * day : t + 24 * day),
      effectiveAt: at(t),
      usage: { connectors: 0 },
      checkedAt: at(t),
    };
  }

  /** The runtime's licence refusals (LC-10): a lapsed box refuses agent turns; limits refuse adding. */
  function licenceRefusal(a: ApplianceState, adding?: 'connectors') {
    const v = licenceView(a);
    if (!v) return null;
    if (v.state === 'lapsed')
      return err(403, 'licence.lapsed', 'The subscription ended, so your agent and automations are paused.');
    const allowed = adding ? v.limits?.[adding] : null;
    if (adding && typeof allowed === 'number' && v.usage[adding] >= allowed)
      return err(403, 'licence.limit', 'The plan’s limit is reached.', { limit: adding, allowed });
    return null;
  }

  function handlerFor(device: string): FakeHandler {
    return async (op, raw, context) => {
      const a = state.appliances[device];
      if (!a) return err(404, 'not_found', 'No such appliance.');
      const me = context.endpointId;
      const input = raw as Record<string, unknown> & { params?: Record<string, string>; body?: unknown };
      const now = new Date().toISOString();
      // The AI side (CT-70…CT-72): `signins.*` / `clients.*`, and the session-native `providers.*` twins.
      const aiOp = PROVIDER_OPS[op] ?? (FAKE_AI_OPS.has(op) ? op : null);
      if (aiOp) {
        const ai = aiFor(device);
        const native = aiOp !== op;
        const flat = input as Record<string, unknown>;
        const answer = await ai.call(
          aiOp,
          (native ? flat : (input.params ?? {})) as Record<string, string>,
          (native ? {} : (input as { query?: Record<string, unknown> }).query) ?? {},
          (native ? flat : (input.body ?? {})) as Record<string, unknown>,
        );
        a.ai = ai.snapshot();
        save();
        if (answer) return sessionAnswer(answer);
      }
      // The box's own screen (contracts 0.100, desk-display-web.md AP-3012): the person's.
      if (op.startsWith('desk.')) {
        const who = accountOf(a, a.endpoints[me]?.accountId ?? '');
        if (!who) return err(403, 'forbidden', 'Not on this Whombat.');
        return deskFor(device).call(op, raw, { personId: who.principalId, name: who.name });
      }
      // Backup options and bringing a Whombat back (backup-options.md AP-6815).
      {
        const options = backupOptionsFor(device);
        options.follow(a.backup, a.backupRepo ?? null);
        const answer = options.call(op, raw);
        if (answer) {
          const r = await answer;
          if (r.status < 300 && op === 'backup.adopt') {
            // Joining the old Whombat's backups makes them this box's destination.
            const material = kitMaterialOf(String((raw as { kit?: unknown }).kit ?? ''));
            a.backup = 'protected';
            a.backupRepo = material?.repository ?? 'rest:http://10.100.1.30:8747/whombat-home/';
            a.backupKind = 'rest';
            save();
          }
          return json(r.status, r.body);
        }
      }
      // Getting one thing back from a backup (backup-look.md AP-6940).
      {
        const answer = backupLookFor(device).call(op, raw);
        if (answer) {
          const r = await answer;
          return json(r.status, r.body);
        }
      }
      // Backup places (backup-places.md AP-6716): a place set up is where the backups go.
      {
        const answer = backupPlacesFor(device).call(op, raw);
        if (answer) {
          const r = await answer;
          if (r.status < 300 && (op === 'backup.usePlace' || op === 'backup.placeCheck')) {
            const snapshot = backupPlacesFor(device).snapshot();
            const place = snapshot.places.find((p) => p.id === snapshot.currentPlaceId);
            a.backup = 'protected';
            a.backupRepo = `rest:http://${place?.address ?? '10.100.1.30'}:8747/whombat-home-3fkq/`;
            a.backupKind = 'rest';
          }
          if (op !== 'backup.places' && op !== 'backup.placeByHand') {
            a.backupPlaces = backupPlacesFor(device).snapshot();
            save();
          }
          return json(r.status, r.body);
        }
      }
      // Remote help (contracts 0.120, AP-4447): the person, with their passkeys on this Whombat.
      if (op.startsWith('remoteHelp.')) {
        const accountId = a.endpoints[me]?.accountId ?? '';
        const who = accountOf(a, accountId);
        if (!who) return err(403, 'forbidden', 'Not on this Whombat.');
        const r = remoteHelpFor(device).call(op, raw, {
          accountId,
          name: who.name,
          endpoint: me,
          passkeys: (a.passkeys ?? [])
            .filter((p) => p.accountId === accountId && !p.removed)
            .map((p) => p.id),
        });
        return json(r.status, r.body);
      }
      // The machine (contracts 0.102, AP-3231): a box without one answers as a Whombat without a manager.
      if (
        op === 'host.hardware' ||
        op === 'host.network' ||
        op.startsWith('host.wifi.') ||
        op === 'host.cable.set'
      ) {
        const network = networkFor(device);
        if (!network) {
          if (op === 'host.hardware') return json(200, { hardware: null, reason: 'not_managed' });
          if (op === 'host.network') return json(200, { network: null, reason: 'not_managed' });
          if (op === 'host.wifi.scan') return json(200, { scan: null, reason: 'not_managed' });
          return err(403, 'not_allowed', 'This Whombat has no Wi-Fi.', { code: 'no_wifi' });
        }
        if (op === 'host.hardware')
          return json(200, { hardware: fakeHardware(machineKind(device) as FakeMachine) });
        const r = network.call(op, raw);
        return json(r.status, r.body);
      }
      // Tailscale (CT-1254, AP-5326): off until the person signs it in.
      if (op === 'host.tailscale' || op.startsWith('host.tailscale.')) {
        const r = tailscaleFor(device).call(op, raw);
        return r ? json(r.status, r.body) : err(404, 'unknown_op', `No operation ${op}`);
      }
      // Bluetooth (contracts 0.109, AP-3717): a box without a machine answers as one without the service.
      if (op === 'host.bluetooth' || op.startsWith('host.bluetooth.')) {
        const bluetooth = bluetoothFor(device);
        if (!bluetooth) {
          if (op === 'host.bluetooth') return json(200, { bluetooth: null, reason: 'not_managed' });
          if (op === 'host.bluetooth.scan') return json(200, { scan: null, reason: 'not_managed' });
          return err(403, 'not_allowed', 'This Whombat has no Bluetooth.', { code: 'no_bluetooth' });
        }
        const r = bluetooth.call(op, raw);
        return json(r.status, r.body);
      }
      // The box's own mail server (CT-1308, AP-5405): on a community box (a commercial one has none to set).
      if (op.startsWith('host.mail')) {
        const who = accountOf(a, a.endpoints[me]?.accountId ?? '');
        const r = mailFor(device).call(op, raw, { email: who?.email || mara.email });
        return r ? json(r.status, r.body) : err(404, 'unknown_op', `No operation ${op}`);
      }
      switch (op) {
        /* Whombat Link, Reach and Updates (4.4, whombat-link.md). */
        case 'reach.get':
        case 'link.on':
        case 'link.off':
        case 'link.mail.set':
        case 'updates.channel.get':
        case 'updates.channel.set':
        case 'push.token.set':
        case 'push.token.clear': {
          if (!a.endpoints[me]?.accountId) return err(403, 'forbidden', 'Enrolled devices only.');
          // The owner's email choices (4.15): the box's defaults until changed.
          const link: LinkSummary = {
            mail: { offline: true, notifications: false },
            ...(a.link ?? { state: 'off', since: now }),
          };
          if (op === 'link.mail.set') {
            const mail = link.mail ?? { offline: true, notifications: false };
            a.link = {
              ...link,
              mail: {
                offline: typeof input.offline === 'boolean' ? input.offline : mail.offline,
                notifications:
                  typeof input.notifications === 'boolean' ? input.notifications : mail.notifications,
              },
            };
            save();
            return json(200, { link: a.link });
          }
          if (op === 'reach.get') {
            const t = tailscaleFor(device).call('host.tailscale', {});
            const tailscale = (t?.body as { tailscale?: unknown } | undefined)?.tailscale ?? null;
            return json(200, { link, ownAddress: a.own ? ownAddressOf(a.own) : null, tailscale });
          }
          if (op === 'link.on') {
            a.link =
              link.state === 'on' || link.state === 'grace'
                ? link
                : {
                    state: 'starting',
                    since: now,
                    pending: {
                      code: FAKE_LINK_CODE,
                      url: 'https://app.whombat.com/link',
                      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                    },
                  };
            save();
            return json(200, { link: a.link });
          }
          if (op === 'link.off') {
            a.link = { state: 'off', since: now };
            save();
            return json(200, { link: a.link });
          }
          if (op === 'updates.channel.set') {
            const next = input.channel === 'development' ? 'development' : 'production';
            const leaving = a.channel === 'development' && next === 'production';
            a.channel = next;
            save();
            return json(200, { channel: next, ...(leaving && { staysOn: 'whombat-20261118.2' }) });
          }
          if (op === 'updates.channel.get') return json(200, { channel: a.channel ?? 'production' });
          if (op === 'push.token.set') {
            const token = (input.token as { token?: string } | undefined)?.token ?? '';
            a.pushTokens = { ...a.pushTokens, [me]: token };
            save();
            return json(200, { registered: link.state === 'on' || link.state === 'grace' });
          }
          if (a.pushTokens) delete a.pushTokens[me];
          save();
          return json(200, { ok: true });
        }
        /* The account's other Whombats (4.14), for the menu under the box's name: the world's other linked boxes. */
        case 'link.whombats': {
          if (!a.endpoints[me]?.accountId) return err(403, 'forbidden', 'Enrolled devices only.');
          const running = (l: LinkSummary | undefined) =>
            l?.state === 'on' || l?.state === 'grace' || l?.state === 'starting';
          if (!running(a.link)) return json(200, { whombats: [] });
          const whombats = Object.values(state.appliances)
            .filter((o) => o.device !== device && running(o.link))
            .map((o) => ({
              device: o.device,
              name: o.name || null,
              state: o.link?.state ?? 'on',
              host: o.own?.host ?? null,
              lastSeenAt: now,
            }));
          return json(200, { whombats });
        }
        /* The box's own address (4.3, own-address.md): its state, the switch, linking, its own passkeys. */
        case 'ownAddress.status':
        case 'ownAddress.reach.set': {
          if (!a.endpoints[me]?.accountId) return err(403, 'forbidden', 'Enrolled devices only.');
          if (op === 'ownAddress.status' && !a.own) return json(200, { ownAddress: null });
          if (!a.own) return err(503, 'unavailable', 'No own address.', { code: 'own_address_unavailable' });
          if (op === 'ownAddress.reach.set') {
            a.own.reachable = input.on === true;
            save();
          }
          const summary = ownAddressOf(a.own);
          // Its new certificate came a moment after the rename.
          if (a.own.starting) {
            a.own.starting = false;
            save();
          }
          return json(200, { ownAddress: summary });
        }
        /* Changing it (4.16): owners only, as the reach switch. */
        case 'ownAddress.check':
        case 'ownAddress.rename': {
          const accountId = a.endpoints[me]?.accountId;
          // The box's one person is its owner.
          if (!accountId) return err(403, 'forbidden', 'Enrolled devices only.');
          if (!a.own) return err(503, 'unavailable', 'No own address.', { code: 'own_address_unavailable' });
          const label = String(input.label ?? '');
          const current = a.own.host.split('.')[0] ?? '';
          const others = {
            boxes: Object.values(state.appliances).flatMap((o) =>
              o !== a && o.own ? [{ label: o.own.host.split('.')[0] ?? null }] : [],
            ),
          } as Pick<FakeLink, 'boxes'>;
          const check = fakeNameCheck(label, others, { label: current, had: a.own.had ?? [] });
          if (op === 'ownAddress.check')
            return json(200, { label, verdict: check.verdict, ...(check.host && { host: check.host }) });
          const refusal =
            state.ownRenameRefusal ??
            (check.verdict === 'free' || check.verdict === 'yours' ? null : `label_${check.verdict}`);
          if (refusal) {
            const kind =
              refusal === 'rename_limit'
                ? [429, 'rate_limited']
                : refusal === 'label_invalid'
                  ? [400, 'validation_failed']
                  : refusal === 'label_reserved' || refusal === 'link_off'
                    ? [403, 'not_allowed']
                    : refusal === 'label_taken'
                      ? [409, 'conflict']
                      : [503, 'unavailable'];
            return err(kind[0] as number, kind[1] as string, 'Refused.', { code: refusal });
          }
          const old = a.own.host;
          // An address already leaving keeps its date; the one in between stops at once.
          a.own.leaving ??= { host: old, until: new Date(Date.now() + 30 * 86_400_000).toISOString() };
          if (a.own.leaving.host === check.host) a.own.leaving = null;
          a.own.had = [...new Set([...(a.own.had ?? []), current])];
          a.own.host = check.host ?? `${label}.${OWN_ADDRESS_ZONES.prod}`;
          a.own.starting = true;
          save();
          return json(200, { ownAddress: ownAddressOf(a.own) });
        }
        case 'account.link.lookup':
        case 'account.link': {
          if (!a.endpoints[me]?.accountId) return err(403, 'forbidden', 'Enrolled devices only.');
          const code = (state.whombatLinks ?? []).find((l) => l.code === input.code);
          if (!code || (op === 'account.link' && code.used && a.own?.linkedTo !== CLOUD.accountId))
            return err(404, 'not_found', 'No such code.', { code: 'link_code_invalid' });
          if (Date.parse(code.expiresAt) <= Date.now())
            return err(410, 'expired', 'The code ran out.', { code: 'link_code_expired' });
          if (op === 'account.link.lookup')
            return json(200, { email: CLOUD.email, expiresAt: code.expiresAt });
          code.used = true;
          if (a.own) a.own.linkedTo = CLOUD.accountId;
          save();
          return json(200, { email: CLOUD.email, linkedAt: now });
        }
        // The box only logs why making a passkey failed: nothing to keep here.
        case 'boxPasskey.failed':
          return json(200, { ok: true });
        case 'boxPasskey.register.begin': {
          const accountId = a.endpoints[me]?.accountId;
          const acc = accountId ? accountOf(a, accountId) : null;
          if (!accountId || !acc) return err(403, 'forbidden', 'Enrolled devices only.');
          if (!a.own) return err(503, 'unavailable', 'No own address.', { code: 'own_address_unavailable' });
          // The page at the address the box is leaving: new passkeys only at the current one.
          if (state.ownBox && a.own.leaving?.host === (state.ownPageHost ?? FAKE_OWN_HOST))
            return err(409, 'conflict', 'The address moved.', { code: 'address_moved', host: a.own.host });
          const nonce = hex(32);
          const userId = a.own.users[accountId] ?? b64url(32);
          a.own.users[accountId] = userId;
          save();
          passkeyBegins.set(`${device}|${me}|box`, { nonce, accountId });
          const rp = a.own.host;
          return json(200, {
            nonce,
            rpId: rp,
            user: { id: userId, name: a.name, displayName: `${a.name} · your Whombat` },
            excludeCredentialIds: (a.passkeys ?? [])
              .filter((p) => p.accountId === accountId && !p.removed && p.rpId === rp)
              .map((p) => p.id),
            challenge: boxPasskeyRegisterChallengeBase64url({
              nonce,
              appliance: peers[device] as string,
              rpId: rp,
            }),
          });
        }
        case 'boxPasskey.register': {
          const begin = passkeyBegins.get(`${device}|${me}|box`);
          passkeyBegins.delete(`${device}|${me}|box`);
          const r = input as unknown as {
            nonce: string;
            name: string;
            response: { id: string; response: { clientDataJSON: string; authenticatorData?: string } };
          };
          const data = clientData(r.response.response.clientDataJSON);
          const invalid = () =>
            err(403, 'forbidden', 'The passkey didn’t verify.', { code: 'passkey_invalid' });
          if (!begin || !a.own || begin.nonce !== r.nonce || data?.type !== 'webauthn.create')
            return invalid();
          if (
            data.challenge !==
            boxPasskeyRegisterChallengeBase64url({
              nonce: begin.nonce,
              appliance: peers[device] as string,
              rpId: a.own.host,
            })
          )
            return invalid();
          if ((a.passkeys ?? []).some((p) => p.id === r.response.id))
            return err(409, 'conflict', 'That passkey is here already.', { code: 'passkey_exists' });
          const passkey: FakeWhombatPasskey = {
            id: r.response.id,
            name: r.name,
            accountId: begin.accountId,
            createdAt: now,
            lastUsedAt: null,
            synced: backupEligible(r.response.response.authenticatorData),
            removed: false,
            rpId: a.own.host,
          };
          a.passkeys = [...(a.passkeys ?? []), passkey];
          save();
          return json(200, passkeySummary(passkey, accountOf(a, begin.accountId)?.name ?? '', false));
        }
        case 'boxPasskey.enroll.begin': {
          if (!a.own) return err(503, 'unavailable', 'No own address.', { code: 'own_address_unavailable' });
          const nonce = hex(32);
          passkeyBegins.set(`${device}|${me}|join`, { nonce, accountId: '' });
          return json(200, { nonce, rpId: a.own.host, timeoutMs: 120_000 });
        }
        case 'boxPasskey.enroll': {
          const begin = passkeyBegins.get(`${device}|${me}|join`);
          passkeyBegins.delete(`${device}|${me}|join`);
          const r = input as unknown as {
            nonce: string;
            response: { id: string; response: { clientDataJSON: string; userHandle?: string } };
            endpoint: { label: string; platform: 'web' | 'android' | 'ios' };
          };
          const invalid = () =>
            err(403, 'forbidden', 'The passkey didn’t verify.', { code: 'passkey_invalid' });
          const p = (a.passkeys ?? []).find((x) => x.id === r.response.id && !x.removed);
          const data = clientData(r.response.response.clientDataJSON);
          if (
            !begin ||
            !a.own ||
            begin.nonce !== r.nonce ||
            !p ||
            p.rpId !== a.own.host ||
            data?.type !== 'webauthn.get' ||
            data.challenge !== passkeyEnrollChallengeBase64url({ nonce: r.nonce, endpoint: me })
          )
            return invalid();
          if (a.endpoints[me] && !a.endpoints[me]?.revokedAt)
            return err(409, 'conflict', 'This endpoint key is already enrolled.', {
              code: 'endpoint_enrolled',
            });
          a.endpoints[me] = {
            accountId: p.accountId,
            label: r.endpoint.label,
            platform: r.endpoint.platform,
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          p.lastUsedAt = now;
          save();
          return json(200, enrolled(a, me));
        }
        /* The claim on a community box's own page (CT-1301; AP-5430), the runtime's checks in its order. */
        case 'enroll.claim.local.start': {
          if (a.edition !== 'community' && !a.own)
            return err(403, 'not_allowed', 'Claimed through control.', { code: 'claim_local_unavailable' });
          if (a.claimedBy) return err(409, 'claim_used', 'This Whombat is already claimed.');
          // At its own address only with the claim link from its screen (never counted toward the backoff).
          if (a.own && input.link !== a.own.claimLink)
            return err(403, 'forbidden', 'Open the link on this Whombat’s screen.', { code: 'claim_link' });
          if (a.claimBackoffUntil && a.claimBackoffUntil > Date.now())
            return err(429, 'claim_backoff', 'Too many wrong claim attempts.', {
              code: 'claim_backoff',
              retryAt: new Date(a.claimBackoffUntil).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            });
          if (!a.letters) return err(503, 'claim_not_ready', 'No claim code yet.');
          const claimId = `lcl_${b64url(12)}`;
          localStarts.set(`${device}|${me}`, claimId);
          return json(200, { claimId, expiresAt: new Date(Date.now() + 300_000).toISOString() });
        }
        case 'enroll.claim.local.begin': {
          if (localStarts.get(`${device}|${me}`) !== input.claimId)
            return err(409, 'conflict', 'Start the claim again.', { code: 'claim_start_missing' });
          if (a.claimedBy) return err(409, 'claim_used', 'This Whombat is already claimed.');
          const r = localClaimPakeResponder(
            {
              password: a.letters as string,
              appliancePeerId: peers[device] as string,
              clientPeerId: me,
              claimId: input.claimId as string,
            },
            input.share as string,
            randomBytes,
          );
          localBegins.set(`${device}|${me}`, { claimId: input.claimId as string, tags: r.tags });
          return json(200, { share: r.share });
        }
        /* The proofs alone: the letters are checked here, before the person is named. */
        case 'enroll.claim.local.prove': {
          const begun = localBegins.get(`${device}|${me}`);
          localBegins.delete(`${device}|${me}`);
          localProofs.delete(`${device}|${me}`);
          if (!begun || begun.claimId !== input.claimId)
            return err(409, 'claim_begin_missing', 'Begin the claim again.');
          if (a.claimedBy) return err(409, 'claim_used', 'This Whombat is already claimed.');
          if (!claimConfirmEqual(begun.tags.client, input.confirm as string)) {
            a.claimFailures = (a.claimFailures ?? 0) + 1;
            a.letters = newLetters(a.letters);
            const wait = claimBackoffSeconds(a.claimFailures);
            a.claimBackoffUntil = wait > 0 ? Date.now() + wait * 1000 : null;
            save();
            return err(403, 'claim_invalid', 'Those letters aren’t right.');
          }
          localStarts.delete(`${device}|${me}`);
          localProofs.set(`${device}|${me}`, begun.claimId);
          return json(200, { confirm: begun.tags.appliance });
        }
        case 'enroll.claim.local': {
          if (input.confirm !== undefined)
            return err(503, 'unavailable', 'Update the Whombat app, then try again.', {
              code: 'claim_update_app',
            });
          const proved = localProofs.get(`${device}|${me}`);
          localProofs.delete(`${device}|${me}`);
          if (proved !== input.claimId)
            return err(409, 'conflict', 'Enter the letters again.', { code: 'claim_proof_missing' });
          if (a.claimedBy) return err(409, 'claim_used', 'This Whombat is already claimed.');
          const endpoint = input.endpoint as { label: string; platform: 'web' | 'android' | 'ios' };
          // The person claims it: the fixture burrow's (its data is Mara's).
          a.claimedBy = LOCAL.id;
          a.letters = undefined;
          if (a.own) a.own.claimLink = null;
          a.claimFailures = 0;
          a.claimBackoffUntil = null;
          a.endpoints[me] = {
            accountId: LOCAL.id,
            label: endpoint.label,
            platform: endpoint.platform,
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          save();
          return json(200, enrolled(a, me));
        }
        /* Device links (CT-1305): one live link per account, five minutes, once. */
        case 'enroll.link.create': {
          const accountId = a.endpoints[me]?.accountId;
          if (!accountId) return err(403, 'forbidden', 'Enrolled devices only.');
          if (a.edition !== 'community' && !a.own)
            return err(503, 'unavailable', 'No direct way for a link.', { code: 'link_unavailable' });
          const secret = b64url(24);
          const expiresAt = new Date(Date.now() + 300_000).toISOString();
          a.deviceLinks = [
            ...(a.deviceLinks ?? []).filter((l) => l.accountId !== accountId),
            { secret, accountId, expiresAt, used: false },
          ];
          save();
          const link = localLinkFor({
            kind: 'device',
            appliance: peers[device] as string,
            secret,
            routes: communityRoutes(),
            ...(a.own && { own: `https://${a.own.host}/` }),
          });
          lastLocalLink = link;
          return json(200, { linkId: `dln_${hex(6)}`, secret, expiresAt, link });
        }
        case 'enroll.link.accept': {
          const l = (a.deviceLinks ?? []).find((x) => x.secret === input.secret);
          if (!l) return err(403, 'forbidden', 'No such link.', { code: 'link_invalid' });
          if (l.used) return err(409, 'conflict', 'Used already.', { code: 'link_used' });
          if (Date.parse(l.expiresAt) <= Date.now())
            return err(410, 'expired', 'The link ran out.', { code: 'link_expired' });
          if (a.endpoints[me] && !a.endpoints[me]?.revokedAt)
            return err(409, 'endpoint_enrolled', 'This endpoint key is already enrolled.');
          const endpoint = input.endpoint as { label: string; platform: 'web' | 'android' | 'ios' };
          a.endpoints[me] = {
            accountId: l.accountId,
            label: endpoint.label,
            platform: endpoint.platform,
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          l.used = true;
          save();
          return json(200, enrolled(a, me));
        }
        /* The box's own Web Push (CT-1307): a community box has a key; a commercial one tells browsers through control. */
        case 'devices.vapidKey':
          return a.edition === 'community'
            ? json(200, { publicKey: FAKE_VAPID_KEY })
            : err(403, 'not_allowed', 'No Web Push key here.', { code: 'push.web_unavailable' });
        case 'devices.register': {
          const accountId = a.endpoints[me]?.accountId;
          if (!accountId || a.edition !== 'community')
            return err(403, 'not_allowed', 'No Web Push here.', { code: 'push.web_unavailable' });
          const body = input.body as { token: string; platform: 'web'; provider: 'webpush' };
          const id = `dev_${hex(6)}`;
          a.pushDevices = [
            ...(a.pushDevices ?? []).filter((d) => d.token !== body.token),
            { id, accountId, token: body.token },
          ];
          save();
          return json(201, {
            device: {
              id,
              accountId,
              platform: body.platform,
              provider: body.provider,
              token: body.token,
              name: null,
              liveActivityToken: null,
              createdAt: now,
              lastSeenAt: null,
            },
          });
        }
        // The real box writes them into its log; the fake one has none.
        case 'devices.reportErrors':
          return json(200, { ok: true });
        case 'devices.remove': {
          const id = (input.params as { deviceId?: string } | undefined)?.deviceId;
          a.pushDevices = (a.pushDevices ?? []).filter((d) => d.id !== id);
          save();
          return json(200, { ok: true });
        }
        case 'enroll.claim.begin': {
          // The responder of the claim PAKE (CC-06, CC-07), as the runtime runs it.
          if (a.claimedBy) return err(409, 'claim_used', 'This Whombat is already claimed.');
          if (a.claimBackoffUntil && a.claimBackoffUntil > Date.now())
            return err(429, 'claim_backoff', 'Too many wrong claim attempts.', {
              code: 'claim_backoff',
              retryAt: new Date(a.claimBackoffUntil).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            });
          const method = input.method as 'code' | 'card';
          const k = keyOf(device);
          if (method === 'code' && !a.letters) return err(503, 'claim_not_ready', 'No claim code yet.');
          const r = claimPakeResponder(
            {
              method,
              password: method === 'code' ? (a.letters as string) : claimSecretHash(device, SECRETS[k]),
              deviceId: device,
              appliancePeerId: peers[device] as string,
              clientPeerId: me,
              claimId: input.claimId as string,
            },
            input.share as string,
            randomBytes,
          );
          claimBegins.set(`${device}|${me}`, { claimId: input.claimId as string, method, tags: r.tags });
          return json(200, { share: r.share });
        }
        case 'enroll.claim': {
          if (a.claimedBy) return err(409, 'claim_used', 'This Whombat is already claimed.');
          const begun = claimBegins.get(`${device}|${me}`);
          if (!begun || begun.claimId !== input.claimId || begun.method !== input.method)
            return err(409, 'claim_begin_missing', 'Begin the claim again.');
          claimBegins.delete(`${device}|${me}`);
          const endpoint = input.endpoint as { label: string; platform: 'web' };
          // Something that isn't this box answers: it says yes without its key (the client must catch it).
          if (keyOf(device) === 'mismatched')
            return json(200, {
              ...enrolledAs(a, me, endpoint.label),
              recoveryKitRequired: false,
              confirm: b64url(32),
            });
          if (!claimConfirmEqual(begun.tags.client, input.confirm as string)) {
            // One wrong guess: new letters at once, and the backoff counts it (CC-07).
            a.claimFailures = (a.claimFailures ?? 0) + 1;
            if (begun.method === 'code') a.letters = newLetters(a.letters);
            const wait = claimBackoffSeconds(a.claimFailures);
            a.claimBackoffUntil = wait > 0 ? Date.now() + wait * 1000 : null;
            save();
            return err(403, 'claim_invalid', 'That claim code isn’t right.');
          }
          a.claimedBy = LOCAL.id;
          a.letters = undefined;
          a.lookup = null;
          a.claimFailures = 0;
          a.claimBackoffUntil = null;
          a.endpoints[me] = {
            accountId: LOCAL.id,
            label: endpoint.label,
            platform: 'web',
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          save();
          // No kit at the claim any more (BX-01): the runtime answers false.
          return json(200, { ...enrolled(a, me), recoveryKitRequired: false, confirm: begun.tags.appliance });
        }
        case 'enroll.screen.request': {
          // Ask the box to show a code for this device (BX-02): a new request replaces the one showing.
          if (!a.claimedBy || noScreen.has(device))
            return err(503, 'screen_unavailable', 'This Whombat has no screen to show a code on.');
          if (a.endpoints[me] && !a.endpoints[me].revokedAt)
            return err(409, 'endpoint_enrolled', 'This device is let in already.');
          // The box is one person's: the code lets this device in to their account (CT-1509).
          const accountId = a.claimedBy;
          const endpoint = input.endpoint as { label: string; platform: 'web' | 'android' | 'ios' };
          const signin = {
            signinId: `ssi_${hex(8)}`,
            letters: generateScreenSignInLetters(randomBytes),
            peer: me,
            accountId,
            label: endpoint.label,
            platform: endpoint.platform,
            expiresAt: Date.now() + SCREEN_SIGNIN_TTL_S * 1000,
          };
          screenSignIns.set(device, signin);
          return json(200, {
            signinId: signin.signinId,
            expiresAt: new Date(signin.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          });
        }
        case 'enroll.screen.begin': {
          // CPace step 1 with the letters (BX-03): only from the key that asked, while the code shows.
          const live = liveScreenSignIn(device);
          if (!live || live.signinId !== input.signinId || live.peer !== me)
            return err(409, 'screen_signin_missing', 'No code is showing for this device.');
          const failures = screenFailures.get(device);
          if (failures?.until && failures.until > Date.now())
            return err(429, 'screen_backoff', 'Too many wrong codes.', {
              code: 'screen_backoff',
              retryAt: new Date(failures.until).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            });
          let r: ReturnType<typeof screenSignInPakeResponder>;
          try {
            r = screenSignInPakeResponder(
              {
                password: live.letters,
                deviceId: device,
                appliancePeerId: peers[device] as string,
                clientPeerId: me,
                signinId: live.signinId,
              },
              input.share as string,
              randomBytes,
            );
          } catch {
            return err(400, 'screen_share_invalid', 'That share isn’t valid.');
          }
          screenBegins.set(`${device}|${me}`, {
            signinId: live.signinId,
            letters: live.letters,
            tags: r.tags,
          });
          return json(200, { share: r.share });
        }
        case 'enroll.screen': {
          // CPace step 2 (BX-03): the tag first; a wrong one is one guess, new letters, and ends the begin.
          const begun = screenBegins.get(`${device}|${me}`);
          screenBegins.delete(`${device}|${me}`);
          const live = liveScreenSignIn(device);
          if (!begun || begun.signinId !== input.signinId || !live || live.letters !== begun.letters)
            return err(409, 'screen_begin_missing', 'Begin again.');
          if (!claimConfirmEqual(begun.tags.client, input.confirm as string)) {
            const count = (screenFailures.get(device)?.count ?? 0) + 1;
            const wait = claimBackoffSeconds(count);
            screenFailures.set(device, { count, until: wait > 0 ? Date.now() + wait * 1000 : null });
            live.letters = generateScreenSignInLetters(randomBytes);
            return err(403, 'screen_code_invalid', 'That isn’t it.');
          }
          screenSignIns.delete(device);
          screenFailures.delete(device);
          a.endpoints[me] = {
            accountId: live.accountId,
            label: live.label,
            platform: live.platform,
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          save();
          return json(200, { ...enrolled(a, me), confirm: begun.tags.appliance });
        }
        case 'enroll.pair.request': {
          const endpoint = input.endpoint as { label: string; platform: 'web' | 'android' | 'ios' };
          const code = randomCode();
          const pairingId = `pair_${hex(6)}`;
          a.pairing.push({
            pairingId,
            code,
            endpoint: me,
            label: endpoint.label,
            platform: endpoint.platform,
            state: 'pending',
          });
          save();
          return json(200, { pairingId, code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
        }
        case 'enroll.pair.status': {
          const r = a.pairing.find((p) => p.pairingId === input.pairingId);
          if (!r) return json(200, { state: 'expired' });
          return json(200, {
            state: r.state,
            ...(r.state === 'approved' && { enrolled: enrolled(a, r.endpoint) }),
          });
        }
        case 'enroll.pair.lookup': {
          const r = a.pairing.find((p) => p.code === input.code && p.state === 'pending');
          if (!r) return err(404, 'pairing_code_invalid', 'No pending pairing with that code.');
          return json(200, {
            pairingId: r.pairingId,
            label: r.label,
            platform: r.platform ?? 'android',
            fingerprint: pairingFingerprint(r.endpoint),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        }
        case 'enroll.pair.approve': {
          const r = a.pairing.find((p) => p.code === input.code && p.state === 'pending');
          if (!r) return err(404, 'pairing_code_invalid', 'No pending pairing with that code.');
          // CT-46: only the device the approver looked up (and compared) can be let in.
          if (input.fingerprint !== pairingFingerprint(r.endpoint))
            return err(
              409,
              'pairing_fingerprint_mismatch',
              'The fingerprint doesn’t match the device that asked with this code.',
            );
          r.state = input.approve ? 'approved' : 'denied';
          if (input.approve)
            a.endpoints[r.endpoint] = {
              accountId: LOCAL.id,
              label: r.label,
              platform: r.platform ?? 'android',
              createdAt: now,
              revokedAt: null,
              applied: false,
            };
          save();
          return json(200, {
            state: r.state,
            ...(input.approve ? { endpoint: summary(a, r.endpoint, me) } : {}),
          });
        }
        case 'recovery.kit.register': {
          // Only while no (confirmed) key exists; replacing one is `recovery.kit.rotate` (CT-45).
          if (a.kit.confirmed)
            return err(409, 'recovery_key_exists', 'This Whombat has a recovery key already.');
          a.kit = {
            publicKey: input.recoveryPublicKey as string,
            kitId: `kit_${hex(4)}`,
            challenge: hex(16),
            confirmed: false,
          };
          save();
          return json(200, {
            kitId: a.kit.kitId,
            challenge: a.kit.challenge,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
        case 'recovery.kit.rotate': {
          const current = a.kit.publicKey;
          const statement = {
            purpose: RECOVERY_ROTATE_PURPOSE,
            appliance: peers[device],
            newRecoveryPublicKey: input.newRecoveryPublicKey,
          };
          if (
            !current ||
            !verifyBytes(input.currentKeySignature as string, utf8ToBytes(canonicalJson(statement)), current)
          )
            return err(400, 'recovery_rotation_invalid', 'That isn’t the current recovery key.');
          a.kit = {
            publicKey: input.newRecoveryPublicKey as string,
            kitId: `kit_${hex(4)}`,
            challenge: hex(16),
            confirmed: false,
            rotationPending: true,
          };
          save();
          return json(200, {
            kitId: a.kit.kitId,
            challenge: a.kit.challenge,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
        case 'recovery.kit.confirm': {
          if (!a.kit.publicKey || input.kitId !== a.kit.kitId)
            return err(404, 'not_found', 'That kit is gone.');
          const message = utf8ToBytes(
            canonicalJson({
              purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
              appliance: peers[device],
              kitId: a.kit.kitId,
              challenge: a.kit.challenge,
            }),
          );
          if (!verifyBytes(input.signature as string, message, a.kit.publicKey))
            return err(400, 'kit_mismatch', 'That isn’t the kit this Whombat made.');
          a.kit.confirmed = true;
          a.kit.rotationPending = false;
          save();
          return json(200, { confirmed: true, confirmedAt: now });
        }
        case 'recovery.enroll': {
          // The runtime's order (MA-19a, CT-45): a confirmed kit, its key's signature over a statement bound to this
          // appliance and this session's own key, recent, and only into the kit's account.
          const r = input as unknown as {
            statement: { appliance: string; endpoint: string; accountId: string; issuedAt: string };
            signature: string;
            endpoint: { label: string; platform: 'web' | 'android' | 'ios' };
          };
          if (!a.kit.publicKey)
            return err(403, 'recovery_key_missing', 'This appliance has no recovery key.');
          if (!a.kit.confirmed)
            return err(
              403,
              'recovery_kit_unverified',
              'The recovery kit was never confirmed, so it can’t add devices.',
            );
          if (r.statement.appliance !== peers[device] || r.statement.endpoint !== me)
            return err(
              403,
              'recovery_statement_mismatch',
              'The statement is for another appliance or device.',
            );
          if (Math.abs(Date.now() - Date.parse(r.statement.issuedAt)) > 5 * 60_000)
            return err(403, 'recovery_statement_expired', 'The recovery statement is too old.');
          if (!verifyRecoveryStatement(r.statement as never, r.signature, a.kit.publicKey))
            return err(403, 'recovery_signature_invalid', 'The recovery signature doesn’t match.');
          if (r.statement.accountId !== (a.kit.owner ?? LOCAL.id))
            return err(
              403,
              'recovery_not_kit_owner',
              'A recovery kit adds devices only to the account that set it up.',
            );
          a.endpoints[me] = {
            accountId: LOCAL.id,
            label: r.endpoint.label,
            platform: r.endpoint.platform,
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          save();
          return json(200, enrolled(a, me));
        }
        case 'diagnostics.create': {
          const list = a.diagnostics ?? [];
          if (list.length >= DIAGNOSTICS_MAX_BUNDLES)
            return err(409, 'diagnostics_limit', 'There are already 10 diagnostic bundles.');
          const scopes = input.scopes as string[];
          const bundleId = `dgb_${hex(6)}`;
          const bundle = diagnosticBundle(device, bundleId, scopes);
          const bytes = diagnosticBundleBytes(bundle);
          const entry = {
            summary: {
              bundleId,
              scopes,
              createdAt: bundle.createdAt,
              expiresAt: bundle.expiresAt,
              createdBy: a.endpoints[me]?.accountId ?? LOCAL.id,
              size: bytes.byteLength,
              sha256: sha256Hex(bytes),
              downloads: 0,
              lastDownloadedAt: null,
            },
            bundle,
          };
          a.diagnostics = [...list, entry];
          save();
          return json(200, entry.summary);
        }
        case 'diagnostics.preview': {
          const d = (a.diagnostics ?? []).find((x) => x.summary.bundleId === input.bundleId);
          if (!d) return err(404, 'not_found', 'That bundle is gone.');
          return json(200, { summary: d.summary, bundle: d.bundle });
        }
        case 'diagnostics.list':
          return json(200, { bundles: (a.diagnostics ?? []).map((d) => d.summary) });
        case 'diagnostics.delete': {
          const before = (a.diagnostics ?? []).length;
          a.diagnostics = (a.diagnostics ?? []).filter((x) => x.summary.bundleId !== input.bundleId);
          save();
          return json(200, { deleted: a.diagnostics.length < before });
        }
        // GitHub through a person's own sign-in (CT-181, AP-493): sign in (the AI side's `github` sign-in), then connect.
        case 'github.status':
        case 'github.connect': {
          const login = aiFor(device).githubLogin();
          if (op === 'github.connect') {
            if (!login) return err(403, 'forbidden', 'Sign in to GitHub first, then connect it.');
            a.githubConnectedAs = login;
            save();
          }
          const connected = a.githubConnectedAs ?? null;
          return json(200, {
            mode: 'gh',
            via: 'signin',
            connected: connected !== null,
            login: connected,
            error: null,
            fix: null,
            note: null,
            canConnect: connected === null && login !== null,
            signInNeeded: connected === null && login === null,
            polledAt: null,
          });
        }
        /* Passkeys that open this Whombat (PK-04…PK-08): the checks of PK-05 / PK-D03 without the signature. */
        case 'passkey.register.begin': {
          const accountId = a.endpoints[me]?.accountId;
          const acc = accountId ? accountOf(a, accountId) : null;
          if (!accountId || !acc) return err(403, 'forbidden', 'Enrolled devices only.');
          const own = (a.passkeys ?? []).filter((p) => p.accountId === accountId && !p.removed);
          if (own.length >= PASSKEYS_PER_ACCOUNT_MAX)
            return err(409, 'conflict', 'The account already has 20 passkeys on this Whombat.', {
              code: 'passkey_limit',
            });
          const nonce = hex(32);
          const ownerHandle = input.ownerHandle as string | undefined;
          passkeyBegins.set(`${device}|${me}`, { nonce, accountId, ownerHandle });
          return json(200, {
            applianceNonce: nonce,
            endpoint: me,
            rpId: rpId(),
            user: {
              id: ownerHandle ?? passkeyUserHandleBase64url(peers[device] as string),
              name: acc.email || CLOUD.email,
              displayName: a.name,
            },
            excludeCredentialIds: ownerHandle ? [] : own.map((p) => p.id),
          });
        }
        case 'passkey.register': {
          const begin = passkeyBegins.get(`${device}|${me}`);
          passkeyBegins.delete(`${device}|${me}`);
          const r = input as unknown as {
            controlNonce: string;
            name: string;
            response: { id: string; response: { clientDataJSON: string; authenticatorData?: string } };
          };
          const data = clientData(r.response.response.clientDataJSON);
          // One answer for every failed check (Whombat PK-D04): `forbidden` + `passkey_invalid`.
          const invalid = () =>
            err(403, 'forbidden', 'The passkey didn’t verify.', { code: 'passkey_invalid' });
          if (!begin || !data || data.type !== 'webauthn.create') return invalid();
          const expected = passkeyRegisterChallengeBase64url({
            controlNonce: r.controlNonce,
            applianceNonce: begin.nonce,
            appliance: peers[device] as string,
          });
          if (data.challenge !== expected) return invalid();
          if ((a.passkeys ?? []).some((p) => p.id === r.response.id))
            return err(409, 'conflict', 'That passkey is here already.', { code: 'passkey_exists' });
          const synced = backupEligible(r.response.response.authenticatorData);
          if (synced && a.passkeysDeviceBoundOnly)
            return err(403, 'not_allowed', 'Only passkeys that stay on one device.', {
              code: 'passkey_not_allowed',
            });
          const passkey: FakeWhombatPasskey = {
            id: r.response.id,
            name: r.name,
            accountId: begin.accountId,
            createdAt: now,
            lastUsedAt: null,
            synced,
            removed: false,
            ...(begin.ownerHandle && { ownerHandle: begin.ownerHandle, publicKey: 'AQID' }),
          };
          a.passkeys = [...(a.passkeys ?? []), passkey];
          save();
          return json(200, passkeySummary(passkey, accountOf(a, begin.accountId)?.name ?? '', false));
        }
        case 'passkey.link': {
          const begin = passkeyBegins.get(`${device}|${me}`);
          passkeyBegins.delete(`${device}|${me}`);
          const r = input as unknown as {
            record: OwnerPasskeyRecord;
            name: string;
            response: { id: string; response: { clientDataJSON: string } };
          };
          const record = begin?.ownerHandle ? verifyOwnerPasskey(r.record, begin.ownerHandle) : null;
          const data = clientData(r.response.response.clientDataJSON);
          if (
            !begin ||
            !record?.appliances.includes(peers[device] as string) ||
            r.response.id !== record.credentialId ||
            data?.type !== 'webauthn.get' ||
            data.challenge !==
              passkeyLinkChallenge({
                nonce: begin.nonce,
                appliance: peers[device] as string,
                endpoint: me,
                record,
              })
          )
            return err(403, 'forbidden', 'The passkey didn’t verify.', { code: 'passkey_invalid' });
          let passkey = a.passkeys?.find((p) => p.id === record.credentialId);
          if (!passkey) {
            passkey = {
              id: record.credentialId,
              name: r.name,
              accountId: begin.accountId,
              ownerHandle: record.userHandle,
              publicKey: record.publicKey,
              createdAt: now,
              lastUsedAt: null,
              synced: true,
              removed: false,
            };
            a.passkeys = [...(a.passkeys ?? []), passkey];
          }
          passkey.removed = false;
          save();
          return json(200, passkeySummary(passkey, accountOf(a, begin.accountId)?.name ?? '', false));
        }
        case 'passkeys.list': {
          const live = (a.passkeys ?? []).filter((p) => !p.removed);
          return json(200, {
            passkeys: [...live]
              .reverse()
              .map((p) =>
                passkeySummary(
                  p,
                  accountOf(a, p.accountId)?.name ?? p.accountId,
                  a.enrolledWith?.[me] === p.id,
                ),
              ),
            policy: { deviceBoundOnly: a.passkeysDeviceBoundOnly === true },
          });
        }
        case 'passkey.remove': {
          const p = (a.passkeys ?? []).find((x) => x.id === input.id && !x.removed);
          if (!p) return err(404, 'not_found', 'No such passkey.');
          p.removed = true;
          save();
          return json(200, { ok: true });
        }
        case 'passkeys.policy': {
          a.passkeysDeviceBoundOnly = input.deviceBoundOnly === true;
          save();
          return json(200, { ok: true });
        }
        case 'enroll.passkey': {
          const r = input as unknown as {
            nonce: string;
            response: { id: string; response: { clientDataJSON: string; userHandle?: string } };
            endpoint: { label: string; platform: 'web' | 'android' | 'ios' };
          };
          // One answer for every failed check (Whombat PK-D04): `forbidden` + `passkey_invalid`.
          const invalid = () =>
            err(403, 'forbidden', 'The passkey didn’t verify.', { code: 'passkey_invalid' });
          if (state.passkeyFaults?.enrollDown) return err(400, 'invalid_input', 'Invalid input.');
          const peer = peers[device] as string;
          const p = (a.passkeys ?? []).find((x) => x.id === r.response.id && !x.removed);
          if (!p || !accountOf(a, p.accountId)) return invalid();
          if (r.response.response.userHandle !== (p.ownerHandle ?? passkeyUserHandleBase64url(peer)))
            return invalid();
          const data = clientData(r.response.response.clientDataJSON);
          if (
            data?.type !== 'webauthn.get' ||
            data.challenge !== passkeyEnrollChallengeBase64url({ nonce: r.nonce, endpoint: me })
          )
            return invalid();
          if (p.synced && a.passkeysDeviceBoundOnly)
            return err(403, 'not_allowed', 'Only passkeys that stay on one device.', {
              code: 'passkey_not_allowed',
            });
          if (a.endpoints[me] && !a.endpoints[me]?.revokedAt)
            return err(409, 'conflict', 'This endpoint key is already enrolled.', {
              code: 'endpoint_enrolled',
            });
          a.endpoints[me] = {
            accountId: p.accountId,
            label: r.endpoint.label,
            platform: r.endpoint.platform,
            createdAt: now,
            revokedAt: null,
            applied: false,
          };
          p.lastUsedAt = now;
          a.enrolledWith = { ...a.enrolledWith, [me]: p.id };
          save();
          return json(200, enrolled(a, me));
        }
        case 'push.resolve': {
          // The same answer for unknown and forbidden refs (CT-49).
          const hit = a.pushRefs?.[input.ref as string];
          if (!hit) return err(404, 'not_found', 'Not found.');
          return json(200, hit);
        }
        case 'endpoints.list':
          return json(200, {
            endpoints: Object.keys(a.endpoints).map((peer) => summary(a, peer, me)),
          });
        case 'endpoints.revoke': {
          const peer = Object.keys(a.endpoints).find((p) => `end_${p.slice(-10)}` === input.endpointId);
          const e = peer ? a.endpoints[peer] : undefined;
          if (!peer || !e) return err(404, 'not_found', 'No such device.');
          e.revokedAt = now;
          save();
          fakes.get(device)?.dropEndpoint(peer, 'revoked');
          return json(200, { endpoint: summary(a, peer, me), authzGeneration: 2 });
        }
        case 'licence.status': {
          const v = licenceView(a);
          if (!v) return err(404, 'unknown_op', 'No operation licence.status');
          return json(200, { licence: v });
        }
        // Ask before updating (Whombat ask-before-updating.md): the fixture box's manager keeps the switch and the yes.
        case 'appliance.update.ask': {
          if (a.updateFacts?.askFirst === undefined)
            return err(501, 'not_implemented', 'This Whombat can’t hold updates for you yet.');
          const askFirst = input.askFirst === true;
          const owner = a.updateFacts.waiting?.reason === 'owner';
          a.updateFacts = {
            ...a.updateFacts,
            askFirst,
            ...(owner && !askFirst ? { waiting: undefined } : {}),
          };
          if (owner && !askFirst) a.update = 'Activating';
          save();
          return json(200, { askFirst });
        }
        case 'appliance.update.install': {
          const facts = a.updateFacts;
          if (facts?.waiting?.reason !== 'owner' || facts.candidate !== input.release)
            return err(409, 'conflict', 'That update isn’t waiting for you any more.');
          a.updateFacts = { ...facts, waiting: undefined };
          a.update = 'Activating';
          save();
          return json(200, { release: input.release });
        }
        case 'licence.refresh': {
          const v = licenceView(a);
          if (!v) return err(404, 'unknown_op', 'No operation licence.refresh');
          const l = a.licence ?? { kind: 'active' as const };
          if (l.renewFails)
            return err(503, 'licence.renew_failed', 'Couldn’t renew.', { reason: 'unreachable' });
          if (l.refreshTo) a.licence = { ...l, kind: l.refreshTo, refreshTo: undefined };
          save();
          return json(200, { licence: licenceView(a) });
        }
        case 'host.metrics': // How the box is doing (box-status.md AP-1147): the fixture box's manager (BS-06).
          {
            // A box with its own screen is a laptop: its battery too (desk-display-web.md AP-3021).
            const power = powerSeeded({ desk: deskKind(device) ?? false });
            const t = Date.now();
            return json(
              200,
              hostMetricsFixture(
                input as unknown as HostMetricsInput,
                t,
                power && hostPowerFixture(power, t),
              ),
            );
          }
        case 'appliance.status': {
          const pending = Object.values(a.endpoints).filter((e) => e.revokedAt && !e.applied).length;
          const applied = Object.values(a.endpoints).filter((e) => e.revokedAt && e.applied).length;
          return json(200, {
            claimed: a.claimedBy !== null,
            claimReported: true,
            recovery: {
              enrolled: a.kit.publicKey !== null,
              kitVerified: a.kit.confirmed,
              rotationPending: a.kit.rotationPending === true,
            },
            revocationsPending: pending,
            revocationsApplied: applied,
            ...(a.own && { ownAddress: ownAddressOf(a.own) }),
            ...(licenceView(a) ? { licence: licenceView(a) } : {}),
            clientFloor: a.clientFloor
              ? { web: 0, android: 0, ios: 0, desktop: 0, cli: 0, ...a.clientFloor }
              : null,
            draining: false,
            policy: {
              trusted_access: {
                available: false,
                reason: 'Agents on a managed Whombat always work in their sandbox.',
              },
              feedback_intake:
                (a.feedbackDrop ?? 'available') === 'available'
                  ? { available: true, reason: FEEDBACK_DROP_TEXT.policy }
                  : {
                      available: false,
                      reason:
                        a.feedbackDrop === 'unsupported'
                          ? FEEDBACK_DROP_TEXT.unsupported
                          : 'Website feedback forms aren’t available on a managed Whombat yet.',
                    },
            },
            backup: {
              state: a.backup,
              lastSuccessAt:
                a.backup === 'protected' || a.backup === 'stale' || a.backup === 'failing'
                  ? new Date(Date.now() - (a.backup === 'protected' ? 5 : 80) * 3600_000).toISOString()
                  : null,
              ageS:
                a.backup === 'protected'
                  ? 5 * 3600
                  : a.backup === 'stale' || a.backup === 'failing'
                    ? 80 * 3600
                    : null,
              coverage:
                a.backup === 'unprotected' || a.backup === 'pending'
                  ? []
                  : [
                      'database',
                      'memory',
                      'attachments',
                      'packs',
                      'home',
                      'workspaces',
                      'configuration',
                      'provider-sessions',
                      'recovery-references',
                    ],
              unprotected:
                a.backup === 'unprotected' || a.backup === 'pending'
                  ? ['database', 'attachments', 'workspaces']
                  : ['identity'],
              relogin: a.backup === 'unprotected' || a.backup === 'pending' ? [] : ['provider-sessions'],
              lastFailure:
                a.backup === 'failing'
                  ? {
                      at: new Date(Date.now() - 3600_000).toISOString(),
                      stage: 'upload',
                      reason: 'The backup destination didn’t answer.',
                    }
                  : null,
              recoverable: a.backup === 'protected' || a.backup === 'stale',
              // Where bringing it back stands (backup-passkey.md BPK-08), as its backup service's summary says. A
              // Whombat from before the passkey doesn't know it.
              ...(a.beforePasskey
                ? {}
                : {
                    bringBack: (() => {
                      const options = backupOptionsFor(device);
                      options.follow(a.backup, a.backupRepo ?? null);
                      return options.bringBack();
                    })(),
                  }),
            },
            appliance: {
              peerId: peers[device],
              runtimeVersion: '2026.9.2',
              schemaVersion: 118,
              protocol: { major: 1, minor: 0 },
            },
            update: {
              state: a.update,
              current: a.updateFacts?.current ?? FAKE_RELEASE,
              candidate:
                a.updateFacts?.candidate !== undefined
                  ? a.updateFacts.candidate
                  : a.update === 'Healthy'
                    ? null
                    : '2026.9.3',
              lastCheckedAt: now,
              deferredReason: a.update === 'WaitingForSafeBoundary' ? 'task_running' : null,
              failure:
                a.updateFacts?.failureDetail && typeof a.updateFacts.failureDetail.code === 'string'
                  ? a.updateFacts.failureDetail.code
                  : a.update === 'Failed'
                    ? 'health_check_failed'
                    : null,
              ...(a.updateFacts?.waiting && { waiting: a.updateFacts.waiting }),
              ...(a.updateFacts?.failureDetail && { failureDetail: a.updateFacts.failureDetail }),
              ...(a.updateFacts?.lastUpdate && { lastUpdate: a.updateFacts.lastUpdate }),
              ...(a.updateFacts?.askFirst !== undefined && { askFirst: a.updateFacts.askFirst }),
            },
            providers: state.providers?.[device] ?? [
              {
                provider: 'claude',
                authMode: 'subscription',
                state: 'ready',
                explanation: null,
              },
            ],
          });
        }
        case 'backup.configureDestination': {
          const repo = String(input.repository ?? '');
          const kind = repo.startsWith('rest:')
            ? 'rest'
            : repo.startsWith('s3:')
              ? 's3'
              : repo.startsWith('sftp:')
                ? 'sftp'
                : repo === 'disk:'
                  ? 'disk'
                  : null;
          // The backup service's sentences for the person, as the runtime passes them on.
          if (!kind || repo.includes('unreachable'))
            return err(
              409,
              'backup_destination_failed',
              'Whombat couldn’t reach the destination. Check the address and that it’s online (connection refused).',
            );
          if (
            kind === 's3' &&
            (!input.s3AccessKeyId || !input.s3SecretAccessKey || input.s3AccessKeyId === 'AKIAWRONG')
          )
            return err(
              409,
              'backup_destination_failed',
              'The bucket refused the key. Check the access key and the secret key (403 Forbidden).',
            );
          if (kind === 'sftp' && !input.sftpUser)
            return err(
              409,
              'backup_destination_failed',
              'The server refused this Whombat’s key: add it to the user’s authorized_keys.',
            );
          a.backup = 'protected';
          a.backupRepo = repo;
          a.backupKind = kind;
          a.backupCredentials = Object.fromEntries(
            (
              [
                'restUser',
                'restPassword',
                's3AccessKeyId',
                's3SecretAccessKey',
                's3Region',
                'sftpUser',
              ] as const
            )
              .filter((k) => typeof input[k] === 'string' && input[k])
              .map((k) => [k, String(input[k])]),
          );
          if (kind === 'sftp')
            a.backupCredentials.sftpHostKey =
              typeof input.sftpHostKey === 'string' && input.sftpHostKey ? input.sftpHostKey : FAKE_HOST_KEY;
          save();
          return json(200, {
            repositoryId: `repo_${hex(6)}`,
            appendOnly: kind === 'rest' ? 'verified' : kind === 'disk' ? 'unknown' : 'not-enforced',
            generation: 1,
            kind,
            ...(kind === 'sftp' && { hostKeyFingerprint: FAKE_HOST_KEY_FINGERPRINT }),
          });
        }
        case 'backup.sshPublicKey':
          return json(200, {
            publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeWhombatBackupKey${device.replace(/\W/g, '')} whombat-backup@${device}`,
            fingerprint: 'SHA256:q3v7Hn0YmFakeBackupKeyFingerprintW1ab2cd3ef4',
          });
        case 'backup.runNow':
          if (a.backup === 'unprotected')
            return err(409, 'backup_unprotected', 'Set up a destination first.');
          return json(200, {
            ok: true,
            verified: true,
            id: `chk_${hex(6)}`,
            seq: 1,
            snapshotId: hex(8),
            manifestSha256: hex(32),
            createdAt: now,
            schemaVersion: 118,
          });
        case 'backup.recoveryMaterial':
          if (!a.backupRepo) return err(409, 'backup_unprotected', 'No destination.');
          return json(200, {
            kind: 'whombat.backup-recovery-material/1',
            applianceId: device,
            generation: 1,
            createdAt: now,
            repository: a.backupRepo,
            ...a.backupCredentials,
            ...(a.backupKind === 'sftp' && {
              sftpPrivateKey: FAKE_SFTP_PRIVATE_KEY,
            }),
            ...(a.backupMaterialExtra ?? {}),
            repositoryPassword: `rp-${hex(12)}`,
            repositoryId: 'repo_fake',
            manifestKey: `ed25519:${btoa(hex(16))}`,
          });
        case 'connectors.status': {
          // A Google app is set up; the redirect URI is the hosted UI's route (AG-14).
          const origin = globalThis.location?.origin ?? 'http://localhost:5180';
          const at = new Date().toISOString();
          const connected = a.google?.connected ?? false;
          return json(200, {
            mode: 'real',
            google: {
              app: {
                provider: 'google',
                configured: true,
                source: 'settings',
                clientIdHint: '1234567890ab…',
                secretSet: true,
                userType: 'external',
                updatedAt: at,
              },
              setup: {
                redirectUri: `${origin}/connect/google`,
                enableApisUrl: 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com',
                links: {
                  createProject: 'https://console.cloud.google.com/projectcreate',
                  consentScreen: 'https://console.cloud.google.com/auth/branding',
                  audience: 'https://console.cloud.google.com/auth/audience',
                  createClient: 'https://console.cloud.google.com/auth/clients/create',
                },
                scopes: [],
                appName: 'Whombat',
                supportEmail: null,
                authorizedDomain: new URL(origin).hostname,
              },
              tested: connected,
            },
            canConfigure: true,
            connections: connected
              ? [
                  {
                    id: 'con_fakegoogle1',
                    provider: 'google',
                    email: 'mara@example.com',
                    name: 'Mara Okafor',
                    services: ['mail', 'calendar'],
                    status: 'active',
                    reauthReason: null,
                    checks: [
                      { service: 'mail', state: 'ok' },
                      { service: 'calendar', state: 'ok' },
                    ],
                    checkedAt: at,
                    createdAt: at,
                    updatedAt: at,
                    lastUsedAt: null,
                  },
                ]
              : [],
          });
        }
        case 'connections.startGoogle': {
          // Google's consent is skipped: the browser goes straight to the hosted UI's return, as Google would send it.
          const body = input.body as { returnTo: string };
          const googleState = `oas_${hex(8)}`;
          a.google = {
            finishes: [],
            connected: false,
            ...a.google,
            pending: { state: googleState, returnTo: body.returnTo },
          };
          save();
          const origin = globalThis.location?.origin ?? 'http://localhost:5180';
          return json(200, {
            authorizeUrl: `${origin}/connect/google?code=4%2F0fake-code&state=${googleState}&scope=email`,
          });
        }
        case 'connections.finishGoogle': {
          const body = input.body as { code?: string; state: string; error?: string };
          const google = a.google ?? { pending: null, finishes: [], connected: false };
          google.finishes.push({ code: body.code ?? null, state: body.state, error: body.error ?? null });
          const pending = google.pending;
          const result =
            !pending || pending.state !== body.state
              ? 'connect_error=invalid_state'
              : body.error
                ? 'connect_error=access_denied'
                : 'connected=google';
          if (result === 'connected=google') google.connected = true;
          google.pending = null;
          a.google = google;
          save();
          const back = pending?.returnTo ?? '/';
          return json(200, { returnPath: `${back}${back.includes('?') ? '&' : '?'}${result}` });
        }
        case 'connections.finishOAuth': {
          const body = input.body as { code?: string; state: string; iss?: string };
          a.oauthFinishes = [
            ...(a.oauthFinishes ?? []),
            { code: body.code ?? null, state: body.state, iss: body.iss ?? null },
          ];
          save();
          // Any sign-in this fake started is Cloudflare's; a state it never made is refused, as the box does.
          return json(200, {
            returnPath: body.state.startsWith('oas_')
              ? '/settings?tab=connections&connection=cloudflare&connected=cloudflare'
              : '/connections?connect_error=invalid_state',
            connectionId: null,
          });
        }
        case 'agent.get': {
          // Settings → Agent carries the credential source (CT-39): what this fake appliance stored for the agent.
          const r = await viaFixtures(api.agent.get, input);
          const agent = (r.body as { agent?: { runtime?: Record<string, unknown> } } | undefined)?.agent;
          if (r.status === 200 && agent?.runtime && a.credentialSource !== undefined)
            agent.runtime.credentialSource = a.credentialSource;
          return r;
        }
        case 'agent.setCredentialSource': {
          a.credentialSource = (input.body as { source: unknown }).source;
          save();
          const profile = await viaFixtures(api.agent.get, { params: input.params });
          const agentId = (profile.body as { agent: { id: string } }).agent.id;
          return json(200, { agentId, eventId: null });
        }
        case 'uploads.create': {
          const body = input.body as {
            name: string;
            contentType: string;
            size: number;
            conversationId: string;
          };
          const id = `att_${hex(6)}`;
          const meta = {
            name: body.name,
            contentType: body.contentType || 'application/octet-stream',
            size: body.size,
          };
          attachments.set(id, { ...meta, bytes: null, conversationId: body.conversationId });
          return json(201, {
            attachment: attachmentOf(id, meta),
            uploadUrl: '',
            method: 'PUT',
            headers: {},
            maxBytes: 25 * 1024 * 1024,
          });
        }
        case 'me.setAvatar': {
          // The viewer's photo (CT-265): checked as the runtime does, kept as an attachment every member may read.
          const read = readPhotoBody(input.body);
          if ('refused' in read) return photoRefusal(read.refused);
          if (read.image) {
            const id = `att_${hex(6)}`;
            const meta = { name: 'photo', contentType: read.image.type, size: read.image.bytes.byteLength };
            attachments.set(id, { ...meta, bytes: read.image.bytes });
            photos.set(mara.id, attachmentOf(id, meta).url);
          } else photos.delete(mara.id);
          const account = ((await viaFixtures(api.me.get, {})).body as { account: unknown }).account;
          return json(200, { account, people: [withPhotos({ ...mara, avatarUrl: null }, photos)] });
        }
        case 'files.save': {
          const body = input.body as { attachmentId: string; folder?: string };
          const f = attachments.get(body.attachmentId);
          // An unsent upload of the viewer's goes into its conversation's Files (CT-274, FS-04).
          if (f?.conversationId && !sentOnMessage(body.attachmentId) && !filesWorld.find(body.attachmentId)) {
            const file = filesWorld.save(
              attachmentOf(body.attachmentId, f) as never,
              f.conversationId,
              body.folder ?? '',
              mara.id,
            );
            return json(200, { file: withPhotos(file, photos) });
          }
          // A message's file (0.59, CT-312): an agent's comes into Files, a removed one comes back, one already there is
          // answered as it is; the message says so to everyone.
          const saved = filesWorld.saveFromMessage(body.attachmentId, mara.id);
          if (!saved) return err(404, 'not_found', 'That upload isn’t here.');
          if (saved.added) await announceMessageFile(device, body.attachmentId);
          return json(200, { file: withPhotos(saved.file, photos) });
        }
        case 'files.remove': {
          // A message's file leaves Files only (FS-06): its message offers Save to Files again (CT-312).
          const attachmentId = String(input.params?.attachmentId);
          const onMessage = !!filesWorld.find(attachmentId)?.messageId;
          const r = await viaFixtures(api.files.remove, input);
          if (r.status < 300 && onMessage) await announceMessageFile(device, attachmentId);
          return r;
        }
        case 'uploads.discard':
          attachments.delete(String(input.params?.attachmentId));
          return json(200, { ok: true });
        case 'messages.send': {
          // A message to or mentioning an agent starts a turn: refused while lapsed, not posted (LC-10).
          const text = String((input.body as { text?: string } | undefined)?.text ?? '');
          if (text.includes('@')) {
            const refused = licenceRefusal(a);
            if (refused) return refused;
          }
          const r = await viaFixtures(api.messages.send, input);
          const ids = (input.body as { attachmentIds?: string[] } | undefined)?.attachmentIds ?? [];
          if (ids.length && r.status < 300) {
            const m = (r.body as { message: MessageLike }).message;
            messageFiles.set(m.id, ids);
            // A person's files are in Files with their message (CT-312).
            for (const id of ids) {
              const f = attachments.get(id);
              if (f) filesWorld.sent(attachmentOf(id, f) as never, m, mara.id);
            }
            withFiles(m);
          }
          return r;
        }
        default: {
          const ep = endpointsById.get(op);
          if (!ep) return err(404, 'not_found', `No operation ${op}`);
          // Without the drop a managed runtime refuses intake, and a new integration starts with intake on (Whombat
          // FD-25, MR-05).
          if (
            ((op === 'feedback.setIntake' &&
              (input.body as { enabled?: boolean } | undefined)?.enabled === true) ||
              op === 'feedback.createIntegration') &&
            (a.feedbackDrop ?? 'available') !== 'available'
          )
            return err(
              403,
              'not_allowed',
              a.feedbackDrop === 'unsupported'
                ? FEEDBACK_DROP_TEXT.unsupported
                : 'Public feedback intake is unavailable on a managed appliance.',
              {
                code: 'managed.feedback_intake',
                managed: true,
                reason: 'feedbackIntake',
              },
            );
          const r = await viaFixtures(ep, input);
          // Every person in every answer wears their photo (CT-265).
          if (r.status < 300) withPhotos(r.body, photos);
          // A community box sends Web Push itself, and email once the person set a mail server (CT-1307, CT-1308).
          if (r.status < 300 && ep === api.conversations.bootstrap && a.edition === 'community')
            (r.body as { capabilities?: unknown }).capabilities = {
              webPush: true,
              emailNotifications: mailFor(device).settings() !== null,
            };
          if (r.status < 300 && op.startsWith('feedback.'))
            managedFeedbackDetail(r.body, a.feedbackDrop ?? 'available');
          // The fixture world doesn't store attachments: add them back on every read of a message.
          if (r.status < 300 && op.startsWith('messages.')) {
            const b = r.body as {
              message?: unknown;
              messages?: unknown[];
              replies?: unknown[];
              root?: unknown;
            };
            for (const m of [b.message, b.root, ...(b.messages ?? []), ...(b.replies ?? [])])
              if (m && typeof m === 'object') withFiles(m as { id: string; attachments?: unknown[] });
          }
          return r;
        }
      }
    };
  }

  function fakeFor(device: string): FakeAppliance {
    const existing = fakes.get(device);
    if (existing) return existing;
    const community = state.appliances[device]?.edition === 'community';
    const fake = createFakeAppliance({
      handle: handlerFor(device),
      applianceId: peers[device] as string,
      ...(community && {
        edition: 'community' as const,
        direct: { port: 4480, lan: ['127.0.0.1'], tailscale: null, routes: communityRoutes() },
      }),
      admit: ({ endpointId }) => {
        const e = state.appliances[device]?.endpoints[endpointId];
        if (!e) return 'not_enrolled';
        if (e.revokedAt) {
          // The device connected again: it is now told (applied).
          e.applied = true;
          save();
          return 'revoked';
        }
        const ap = state.appliances[device];
        const acc = ap ? accountOf(ap, e.accountId) : null;
        return {
          account: {
            id: e.accountId,
            name: acc?.name ?? LOCAL.name,
            owner: true,
            principals: [{ burrowId: burrow.id, principalId: acc?.principalId ?? mara.id }],
          },
        };
      },
      ...(state.appliances[device]?.clientFloor && {
        clientFloor: state.appliances[device]?.clientFloor ?? {},
      }),
      exports: async (op, input, who) => {
        const a = state.appliances[device];
        // A visit's command line (remote-help.md AP-4447).
        if (
          op === 'remoteHelp.transcript' &&
          a &&
          accountOf(a, a.endpoints[who.endpointId]?.accountId ?? '')
        ) {
          const visitId = (input as { visitId?: string }).visitId ?? '';
          const bytes = remoteHelpFor(device).transcript(visitId);
          return bytes
            ? {
                contentType: REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE,
                name: remoteHelpTranscriptName(visitId),
                bytes,
              }
            : null;
        }
        const d = a?.diagnostics?.find(
          (x) => x.summary.bundleId === (input as { bundleId?: string }).bundleId,
        );
        if (op !== 'diagnostics.download' || !a || !d) return null;
        d.summary.downloads += 1;
        d.summary.lastDownloadedAt = new Date().toISOString();
        save();
        return {
          contentType: 'application/json',
          name: `whombat-diagnostics-${d.summary.bundleId}.json`,
          bytes: diagnosticBundleBytes(d.bundle),
        };
      },
      resources: async (ref) => {
        if (ref.kind === 'backup-file') {
          const file = await backupWorld.resource(ref.backupFileId);
          return file
            ? {
                meta: {
                  contentType: BACKUP_FILE_CONTENT_TYPE,
                  size: file.bytes.byteLength,
                  name: file.name,
                  sha256: null,
                },
                bytes: file.bytes,
              }
            : null;
        }
        if (ref.kind !== 'attachment') return null;
        const f = attachments.get(ref.attachmentId);
        if (!f?.bytes) return null;
        return {
          meta: { contentType: f.contentType, size: f.bytes.byteLength, name: f.name, sha256: null },
          bytes: f.bytes,
        };
      },
      collab: (document, send) => collab.open(document, send),
      console: (target, io) => consolesWorld.open(target, io),
      completeUpload: async ({ attachmentId, bytes, target }) => {
        if (target.type === 'backup-file') return backupWorld.completeUpload(target.stagedBackupId, bytes);
        const f = attachments.get(attachmentId);
        if (!f) return null;
        f.bytes = bytes;
        f.size = bytes.byteLength;
        return { attachment: attachmentOf(attachmentId, f) };
      },
      latencyMs: 5,
    });
    const majors = state.majors?.[device];
    if (majors) fake.faults.majors(majors);
    fakes.set(device, fake);
    return fake;
  }

  const cloudSession = (): ControlSession => ({
    account: CLOUD,
    orgs: [
      ...(state.org ? [{ ...state.org }] : []),
      // The account's hidden Link org, as control lists it (CL-175).
      ...(state.link?.org ? [{ orgId: 'org_link', name: LINK_ORG_NAME, link: true }] : []),
    ],
  });
  /** The account's Link: none until a box shows a code or the account subscribes. */
  const linkNow = (): FakeLink => {
    state.link ??= {
      plan: {
        state: 'none',
        trialEndsAt: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        trialAvailable: true,
        boxes: 0,
      },
      boxes: [],
      codes: [],
      org: false,
      pending: null,
    };
    const l = state.link;
    // Stripe's webhook for a finished Checkout (CL-176): trialing for what is left of the free month, else active.
    if (l.pending && Date.now() - l.pending.at >= (l.lagMs ?? 3_000)) {
      const trialLeft = l.plan.state === 'trialing' ? l.plan.trialEndsAt : null;
      const fresh = l.plan.trialAvailable;
      const end = trialLeft ?? nowS() + 30 * DAY;
      Object.assign(l.plan, {
        state: trialLeft || fresh ? 'trialing' : 'active',
        trialEndsAt: trialLeft || fresh ? end : null,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: false,
        trialAvailable: false,
        interval: l.pending.interval ?? 'month',
      });
      for (const b of l.boxes) if (b.state === 'ended' || b.state === 'grace') linkOn(b);
      l.pending = null;
      l.card = true;
      save();
    }
    l.plan.boxes = l.boxes.filter((b) => b.state !== 'off').length;
    return l;
  };
  const linkOn = (b: LinkedBox) => {
    Object.assign(b, { state: 'on', since: nowS(), graceEndsAt: null });
    if (!b.label && linkNow().addressLater) Object.assign(b, { state: 'starting' });
    else if (!b.label) {
      const l = linkNow();
      const wanted = l.wanted?.[b.device];
      const taken = l.boxes.filter((x) => x.label).length;
      b.label = wanted ?? FAKE_LINK_LABELS[taken % FAKE_LINK_LABELS.length] ?? 'calm-otter-reef';
      b.host = `${b.label}.${OWN_ADDRESS_ZONES.prod}`;
      if (wanted && l.wanted) delete l.wanted[b.device];
    }
  };
  /** The account has accepted some Subscription Terms (at a confirm, a checkout or the portal), as control asks. */
  const termsAccepted = (l: FakeLink) => l.termsAccepted === true || (l.terms ?? []).some((v) => v !== null);
  /** Checkout and the portal: the terms sent are recorded; none sent while none were ever accepted is refused. */
  const acceptTerms = (l: FakeLink, terms: { version: string } | undefined) => {
    if (terms && !subscriptionTermsAccepted(terms.version))
      throw new ControlError('terms_outdated', 'The terms have changed.');
    if (terms) {
      l.termsAccepted = true;
      save();
    } else if (!termsAccepted(l))
      throw new ControlError('terms_required', 'Accept the Whombat Subscription Terms first.');
  };
  /** Stripe has the Link subscription: what a test says, else a card on file (Checkout finished, or the plan says so). */
  const stripeHas = (l: FakeLink) => l.stripe ?? (l.card === true || l.plan.cardOnFile === true);
  const linkRuns = (l: FakeLink) =>
    l.plan.state === 'trialing' ||
    l.plan.state === 'active' ||
    l.plan.state === 'past_due' ||
    l.plan.state === 'comp';
  const linkAccount = (): LinkAccount => {
    const l = linkNow();
    // A card on file: Checkout finished (a Stripe subscription); a test may set the plan's own. A control on 4.6 always
    // says the discount (null: none).
    return structuredClone({
      plan: { cardOnFile: l.card === true, discount: null, ...l.plan },
      boxes: l.boxes,
    });
  };
  const liveCode = (code: string) => {
    const c = linkNow().codes.find((x) => x.code === code);
    if (!c || c.expiresAt <= nowS()) throw new ControlError('link_code_invalid', 'That code isn’t valid.');
    return c;
  };
  const DAY = 86_400;
  const nowS = () => Math.floor(Date.now() / 1000);
  const signup = () => state.signup ?? { mode: 'open' as const, billing: 'manual' as const, trialDays: 14 };
  /** Control's boxes: the community box is never control's (HE-58). */
  const claimedCount = () =>
    Object.values(state.appliances).filter((a) => a.claimedBy === LOCAL.id && a.edition !== 'community')
      .length;
  /** Stripe's webhook for a finished checkout arrives `lagMs` after it (BL-16). */
  const settle = (b: FakeBilling) => {
    const p = b.pending;
    if (!p || Date.now() - p.at < (b.lagMs ?? 3_000)) return;
    const plan = PLANS.find((x) => x.id === p.plan);
    const trial = b.trialAvailable;
    const end = nowS() + (trial ? signup().trialDays * DAY : 30 * DAY);
    Object.assign(b, {
      plan: plan ? { id: plan.id, name: plan.name } : null,
      state: trial ? 'trialing' : 'active',
      trialEndsAt: trial ? end : null,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      paid: p.whombats,
      setupRequired: false,
      trialAvailable: false,
      pending: null,
    });
    save();
  };
  const billingNow = (): FakeBilling => {
    if (!state.org) throw new ControlError('not_found', 'No such org.');
    // An org from before billing (a saved world) gets what a new one would.
    state.billing ??= newBilling(null);
    const b = state.billing;
    settle(b);
    return b;
  };
  const viewOf = (b: FakeBilling): BillingView => ({
    org: ORG.orgId,
    provider: b.provider,
    plan: b.plan,
    state: b.state,
    trialEndsAt: b.state === 'trialing' ? b.trialEndsAt : null,
    currentPeriodEnd: b.currentPeriodEnd,
    cancelAtPeriodEnd: b.cancelAtPeriodEnd,
    whombats: { claimed: claimedCount(), paid: b.paid },
    setupRequired: b.setupRequired,
    trialAvailable: b.trialAvailable,
    manual: b.manual,
  });
  const manageable = (): FakeBilling => {
    const b = billingNow();
    if (b.manual) throw new ControlError('manual_billing', 'Your plan is managed by Whombat.');
    return b;
  };
  /** What a new org gets (BL-13): waiting for a plan with Stripe, a trial of the plan without, a code's plan. */
  const newBilling = (codePlan: string | null): FakeBilling => {
    const base = { cancelAtPeriodEnd: false, pending: null, views: 0 };
    if (codePlan)
      return {
        ...base,
        provider: 'manual',
        plan: { id: codePlan, name: codePlan === 'whombat' ? 'Whombat' : codePlan },
        state: 'active',
        trialEndsAt: null,
        currentPeriodEnd: null,
        paid: 1,
        setupRequired: false,
        trialAvailable: false,
        manual: true,
      };
    if (signup().billing === 'stripe')
      return {
        ...base,
        provider: 'stripe',
        plan: null,
        state: 'cancelled',
        trialEndsAt: null,
        currentPeriodEnd: null,
        paid: 0,
        setupRequired: true,
        trialAvailable: true,
        manual: false,
      };
    const end = nowS() + signup().trialDays * DAY;
    return {
      ...base,
      provider: 'manual',
      plan: { id: 'whombat', name: 'Whombat' },
      state: 'trialing',
      trialEndsAt: end,
      currentPeriodEnd: end,
      paid: 1,
      setupRequired: false,
      trialAvailable: false,
      manual: true,
    };
  };
  const guard = () => {
    if (controlDown) throw new ControlError('unavailable', 'Couldn’t reach Whombat. Check your connection.');
  };
  /** Retired by an operator, or no longer the organization's (AP-697). */
  const isRetired = (device: string) => (state.retired ?? []).includes(device);
  const isReleased = (device: string) => (state.released ?? []).includes(device);
  const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 30));

  const control: ControlApi = {
    async session() {
      guard();
      return later(state.signedIn ? cloudSession() : null);
    },
    async requestSignInLink(_email, next) {
      guard();
      // Control's format: the token in the fragment (control src/auth/magic-link.ts); `next` only when given and safe.
      const nextPart = next && isSafeNext(next) ? `&next=${encodeURIComponent(next)}` : '';
      state.lastLink = `/auth/verify#token=${hex(16)}${nextPart}`;
      save();
      await later(null);
    },
    async passkeyAuthenticateOptions(endpoint) {
      guard();
      const nonce = hex(32);
      const challenge =
        state.passkeyFaults?.challenge ?? passkeyEnrollChallengeBase64url({ nonce, endpoint });
      const challengeId = `wac_${hex(8)}`;
      authChallenges.set(challengeId, challenge);
      return later({
        challengeId,
        nonce,
        options: { challenge, rpId: rpId(), timeout: 60_000, userVerification: 'required' },
      });
    },
    async passkeyAuthenticateVerify(challengeId, response) {
      guard();
      const challenge = authChallenges.get(challengeId);
      authChallenges.delete(challengeId);
      const r = response as { id?: string; response?: { clientDataJSON?: string } };
      const data = clientData(r.response?.clientDataJSON);
      const passkey = (state.controlPasskeys ?? []).find((p) => p.id === r.id);
      if (!challenge || !data || data.type !== 'webauthn.get' || data.challenge !== challenge || !passkey)
        throw new ControlError('passkey_invalid', 'This passkey isn’t known here.');
      passkey.lastUsedAt = new Date().toISOString();
      state.signedIn = true;
      save();
      return later(cloudSession());
    },
    async passkeyRegisterOptions({ appliance, applianceNonce, ownerHandle }) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      // An account passkey (own-address.md): it opens no Whombat.
      if (!appliance || !applianceNonce) {
        const challenge = b64url(32);
        registerChallenge = { challenge, appliance: '' };
        return later({
          options: {
            rp: { id: rpId(), name: 'Whombat' },
            user: { id: b64url(32), name: CLOUD.email, displayName: 'Whombat account' },
            challenge,
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            timeout: 60_000,
            attestation: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          },
        });
      }
      const device = Object.keys(peers).find((d) => peers[d] === appliance);
      const box = device ? state.appliances[device] : undefined;
      if (!box?.claimedBy) throw new ControlError('not_found', 'No such Whombat in your organizations.');
      const controlNonce = hex(32);
      const challenge = passkeyRegisterChallengeBase64url({ controlNonce, applianceNonce, appliance });
      registerChallenge = { challenge, appliance, ownerHandle };
      return later({
        controlNonce,
        options: {
          rp: { id: rpId(), name: 'Whombat' },
          user: {
            id: ownerHandle ?? passkeyUserHandleBase64url(appliance),
            name: CLOUD.email,
            displayName: box.name,
          },
          challenge,
          pubKeyCredParams: [
            { type: 'public-key', alg: -8 },
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: 60_000,
          attestation: 'none',
          excludeCredentials: (state.controlPasskeys ?? [])
            .filter((p) => (ownerHandle ? p.owner?.userHandle === ownerHandle : p.appliance === appliance))
            .map((p) => ({ id: p.id, type: 'public-key' })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        },
      });
    },
    async passkeyRegisterVerify({ name, response, ownerRecord }) {
      guard();
      if (state.passkeyFaults?.controlDown) throw new ControlError('unavailable', 'Couldn’t reach Whombat.');
      const r = response as { id?: string; response?: { clientDataJSON?: string } };
      const data = clientData(r.response?.clientDataJSON);
      const pending = registerChallenge;
      registerChallenge = null;
      if (!pending || !data || data.challenge !== pending.challenge || typeof r.id !== 'string')
        throw new ControlError('passkey_invalid', 'The passkey didn’t verify.');
      state.controlPasskeys = [
        ...(state.controlPasskeys ?? []),
        {
          id: r.id,
          name,
          appliance: pending.ownerHandle || !pending.appliance ? null : pending.appliance,
          ...(ownerRecord && { owner: ownerRecord }),
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      ];
      save();
      return later({ id: r.id, name });
    },
    async passkeys() {
      guard();
      return later([...(state.controlPasskeys ?? [])]);
    },
    async putPasskeyOwner(id, record) {
      guard();
      const p = state.controlPasskeys?.find((p) => p.id === id);
      if (!p?.owner || !verifyOwnerPasskey(record, p.owner.userHandle))
        throw new ControlError('passkey_invalid', 'The shared passkey didn’t verify.');
      if (record.signature !== p.owner.signature && record.revision !== p.owner.revision + 1)
        throw new ControlError('claim_competing', 'The passkey changed. Try again.');
      p.owner = record;
      save();
    },
    async retirePasskey(id, input) {
      guard();
      const old = state.controlPasskeys?.find((p) => p.id === id);
      const replacement = state.controlPasskeys?.find((p) => p.id === input.replacementId)?.owner;
      const peers = old?.owner?.appliances ?? (old?.appliance ? [old.appliance] : []);
      if (
        !old ||
        !replacement ||
        id === input.replacementId ||
        (old.owner?.revision ?? null) !== input.expectedRevision ||
        peers.some(
          (peer) => !input.checkedAppliances.includes(peer) || !replacement.appliances.includes(peer),
        ) ||
        state.kitEnvelopes?.some((kit) => kit.credentialId === id)
      )
        throw new ControlError('claim_competing', 'The older passkey is still needed.');
      state.controlPasskeys = state.controlPasskeys?.filter((p) => p.id !== id);
      save();
    },
    async kitEnvelopes() {
      guard();
      const deviceOf = (peer: string) => Object.keys(peers).find((d) => peers[d] === peer) ?? null;
      return later(
        (state.kitEnvelopes ?? [])
          .map((e) => {
            const device = deviceOf(e.appliance);
            return {
              ...e,
              whombatName: e.whombatName ?? (device ? (state.appliances[device]?.name ?? null) : null),
              retired: device ? isRetired(device) : true,
            };
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    },
    async putKitEnvelope(input) {
      guard();
      const device = Object.keys(peers).find((d) => peers[d] === input.appliance);
      if (!device || state.appliances[device]?.claimedBy !== LOCAL.id)
        throw new ControlError('not_found', 'No such Whombat.');
      const id = `kit_${hex(6)}`;
      const retiredPeers = new Set((state.retired ?? []).map((d) => peers[d]));
      state.kitEnvelopes = [
        // A kit for a Whombat that isn't retired forgets those kept for retired ones (control CL-150).
        ...(state.kitEnvelopes ?? []).filter(
          (e) =>
            !(e.appliance === input.appliance && e.credentialId === input.credentialId) &&
            (isRetired(device) || !retiredPeers.has(e.appliance)),
        ),
        { ...input, id, createdAt: new Date().toISOString() },
      ];
      save();
      return later({ id });
    },
    async deleteKitEnvelope(id) {
      guard();
      state.kitEnvelopes = (state.kitEnvelopes ?? []).filter((e) => e.id !== id);
      save();
      await later(null);
    },
    async deletePasskey(id) {
      guard();
      const before = state.controlPasskeys ?? [];
      if (!before.some((p) => p.id === id)) throw new ControlError('not_found', 'No such passkey.');
      state.controlPasskeys = before.filter((p) => p.id !== id);
      save();
      await later(null);
    },
    async verifySignIn(token) {
      verifyCalls += 1;
      guard();
      if (!/^[A-Za-z0-9_-]{22,}$/.test(token))
        throw new ControlError('invalid_link', 'That sign-in link doesn’t work any more.');
      state.signedIn = true;
      save();
      return later(cloudSession());
    },
    async signOut() {
      state.signedIn = false;
      save();
    },
    async deleteAccount(email) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      if (email.trim().toLowerCase() !== CLOUD.email)
        throw new ControlError('email_mismatch', 'That isn’t it.');
      if (state.deleteRefusal) throw new ControlError(state.deleteRefusal, 'Refused.');
      // The org is the account's (CT-1560): one that still holds a Whombat can't go with it.
      if (Object.values(state.appliances).some((a) => a.claimedBy === LOCAL.id && a.edition !== 'community'))
        throw new ControlError('org_has_devices', 'The organization still has a Whombat.');
      state.signedIn = false;
      state.org = null;
      state.deleted = true;
      save();
      await later(null);
    },
    async createOrg({ name, terms, code }) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      // Control accepts the current Subscription Terms and the ones before (BL-21) and a code by its canonical form
      // (CT-107).
      if (!subscriptionTermsAccepted(terms.version))
        throw new ControlError('terms_outdated', 'The terms have changed.');
      const canonical = code ? normaliseSignupCode(code) : null;
      if (code && !/^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/.test(code))
        throw new ControlError('invalid_link', 'The code isn’t normalised.');
      state.signupCodes ??= SIGNUP_CODES.map((c) => ({ ...c }));
      const codes = state.signupCodes;
      const found = canonical ? codes.find((c) => c.code === canonical && !c.used) : undefined;
      if (code && !found) throw new ControlError('signup_code_invalid', 'That code doesn’t work.');
      if (!code && signup().mode !== 'open')
        throw new ControlError('signup_code_required', 'An invite code is needed.');
      if (found) found.used = true;
      state.created = [...(state.created ?? []), { terms: terms.version, code: code ?? null }];
      state.org = { orgId: ORG.orgId, name };
      state.billing = newBilling(found?.plan ?? null);
      save();
      return later({ orgId: ORG.orgId, name });
    },
    async signupInfo() {
      guard();
      const { mode, billing, trialDays } = signup();
      return later({ mode, billing, trialDays, termsVersion: SUBSCRIPTION_TERMS_VERSION, plans: PLANS });
    },
    async joinWaitlist({ email, company, note }) {
      guard();
      if (signup().mode !== 'waitlist') throw new ControlError('waitlist_closed', 'The waitlist is closed.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
        throw new ControlError('invalid_link', 'That email address isn’t valid.');
      const address = email.trim().toLowerCase();
      if (!(state.waitlist ?? []).some((w) => w.email === address))
        state.waitlist = [
          ...(state.waitlist ?? []),
          { email: address, company: company?.trim() || null, note: note?.trim() || null },
        ];
      save();
      await later(null);
    },
    async billing() {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      const b = billingNow();
      b.views = (b.views ?? 0) + 1;
      save();
      return later(viewOf(b));
    },
    async billingCheckout(_orgId, { plan, whombats }) {
      guard();
      const b = manageable();
      if (!b.setupRequired && b.state !== 'cancelled')
        throw new ControlError('subscription_exists', 'You already have a subscription.');
      if (!PLANS.some((p) => p.id === plan)) throw new ControlError('plan_unavailable', 'No such plan.');
      if (whombats < 1 || whombats > 50) throw new ControlError('invalid_link', 'Between 1 and 50.');
      // Stripe Checkout “completes” at once and sends the browser back (BL-15); its webhook comes a bit later.
      b.pending = { plan, whombats, at: Date.now() };
      save();
      return later({ url: `${location.origin}/billing?checkout=done` });
    },
    async billingPortal() {
      guard();
      const b = manageable();
      if (b.setupRequired) throw new ControlError('no_subscription', 'No subscription yet.');
      return later({ url: `${location.origin}/billing` });
    },
    async billingWhombats(_orgId, count) {
      guard();
      const b = manageable();
      if (b.setupRequired || b.state === 'cancelled')
        throw new ControlError('no_subscription', 'No subscription yet.');
      if (count < claimedCount()) throw new ControlError('whombats_below_claimed', 'More are claimed.');
      b.paid = count;
      save();
      return later(viewOf(b));
    },
    async billingStartNow() {
      guard();
      const b = manageable();
      if (b.setupRequired) throw new ControlError('no_subscription', 'No subscription yet.');
      if (b.state !== 'trialing') throw new ControlError('not_trialing', 'The trial has ended.');
      Object.assign(b, { state: 'active', trialEndsAt: null, currentPeriodEnd: nowS() + 30 * DAY });
      save();
      return later(viewOf(b));
    },
    async linkLookup(code) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      const c = liveCode(code);
      const l = linkNow();
      return later({
        code,
        name: c.name,
        expiresAt: c.expiresAt,
        linked: c.used,
        trial: !linkRuns(l) && l.plan.trialAvailable,
        termsVersion: SUBSCRIPTION_TERMS_VERSION,
        chooseName: !c.used,
      });
    },
    async linkNameCheck(name) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      // No box is asking at setup: never `yours`.
      const r = fakeNameCheck(name, linkNow());
      return later({ ...r, verdict: r.verdict === 'yours' ? 'taken' : r.verdict });
    },
    async linkConfirm(code, terms, label) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      const c = liveCode(code);
      const l = linkNow();
      // Checked again, as control does inside the confirm: nothing is linked when the name can't be had.
      if (label && !l.boxes.some((b) => b.device === c.device)) {
        if (label === l.takenMeanwhile) throw new ControlError('label_taken', 'That name is taken.');
        const verdict = fakeNameCheck(label, l).verdict;
        if (verdict === 'taken') throw new ControlError('label_taken', 'That name is taken.');
        if (verdict === 'reserved') throw new ControlError('label_reserved', 'That name isn’t available.');
        if (verdict === 'invalid') throw new ControlError('label_invalid', 'That isn’t a name.');
        l.wanted = { ...l.wanted, [c.device]: label };
      }
      if (terms && !subscriptionTermsAccepted(terms.version))
        throw new ControlError('terms_outdated', 'The terms have changed.');
      if (!terms && !termsAccepted(l))
        throw new ControlError('terms_required', 'Accept the Whombat Subscription Terms first.');
      l.terms = [...(l.terms ?? []), terms?.version ?? null];
      let box = l.boxes.find((b) => b.device === c.device);
      if (!box) {
        if (!linkRuns(l) && l.plan.trialAvailable)
          Object.assign(l.plan, {
            state: 'trialing',
            trialEndsAt: nowS() + 30 * DAY,
            currentPeriodEnd: nowS() + 30 * DAY,
            trialAvailable: false,
          });
        else if (
          l.plan.state === 'trialing' &&
          !l.pending &&
          !l.card &&
          l.boxes.filter((b) => b.state !== 'off').length >= 2
        )
          throw new ControlError('link_trial_boxes', 'Add a card to link more than two Whombats.');
        box = {
          device: c.device,
          name: c.name,
          state: 'ended',
          since: nowS(),
          graceEndsAt: null,
          label: null,
          host: null,
          lastSeenAt: nowS(),
        };
        l.boxes.unshift(box);
        if (linkRuns(l)) linkOn(box);
        c.used = true;
        l.org = true;
      }
      save();
      return later(structuredClone(box));
    },
    async linkAccount() {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      return later(linkAccount());
    },
    async linkRemove(device) {
      guard();
      const l = linkNow();
      if (!l.boxes.some((b) => b.device === device)) throw new ControlError('not_found', 'No such Whombat.');
      l.boxes = l.boxes.filter((b) => b.device !== device);
      save();
      return later(linkAccount());
    },
    async linkCheckout(input = {}) {
      guard();
      const l = linkNow();
      // Codes go in the payment page's own field; only an old tab still sends one.
      if ((input as { promotionCode?: string }).promotionCode)
        throw new ControlError('promotion_code_on_payment_page', 'Enter the code on the payment page.');
      // Link is sold in EU countries only, as control says before any page opens.
      if (input.country && !linkSoldIn(input.country))
        throw new ControlError('link_country', 'Whombat Link is sold in EU countries only for now.');
      if (l.manual) throw new ControlError('manual_billing', 'Nothing to pay.');
      acceptTerms(l, input.terms);
      if (l.busy) throw new ControlError('checkout_busy', 'Another billing change is running.');
      // Link is paid for each Whombat linked: no page for none.
      if (l.boxes.filter((b) => b.state !== 'off').length === 0)
        throw new ControlError(
          'link_no_boxes',
          'Link a Whombat first: Whombat Link is paid for each Whombat linked.',
        );
      // Stripe's live subscription comes first: there is nothing to start paying for.
      if (stripeHas(l) || l.pending) throw new ControlError('subscription_exists', 'You already subscribe.');
      // An open page answers the same interval again; another interval waits until it closes, as control says.
      const open = l.openPage && l.openPage.until > nowS() ? l.openPage : null;
      if (open && open.interval !== (input.interval ?? 'month')) {
        const until = `${new Date(open.until * 1000).toISOString().slice(11, 16)} UTC`;
        throw new ControlError(
          'checkout_busy',
          `A payment page is already open for your Whombat Link until ${until}. Finish it there, or ask again after that.`,
        );
      }
      l.openPage = null;
      // Stripe Checkout “completes” at once and sends the browser back; its webhook comes a bit later.
      l.pending = { at: Date.now(), ...(input.interval && { interval: input.interval }) };
      l.org = true;
      save();
      return later({ url: `${location.origin}/billing?checkout=done` });
    },
    async linkPortal(terms) {
      guard();
      const l = linkNow();
      if (l.manual) throw new ControlError('manual_billing', 'Payments aren’t set up.');
      acceptTerms(l, terms);
      if (l.busy) throw new ControlError('checkout_busy', 'Another billing change is running.');
      // The portal is only for a subscription Stripe has: the free month and free time are control's own until paid.
      if (!stripeHas(l)) throw new ControlError('no_subscription', 'No subscription yet.');
      return later({ url: `${location.origin}/account` });
    },
    async appliances(orgId) {
      guard();
      if (!state.org || orgId !== state.org.orgId) return [];
      const list: ApplianceSummary[] = Object.values(state.appliances)
        .filter(
          (a) =>
            a.claimedBy === LOCAL.id &&
            a.edition !== 'community' &&
            (!a.own || a.own.linkedTo === CLOUD.accountId) &&
            !isReleased(a.device),
        )
        .map((a) => ({
          ...(a.own && { ownAddress: true }),
          device: a.device,
          orgId: ORG.orgId,
          name: a.name,
          state: isRetired(a.device) ? 'retired' : 'claimed',
          contentPeerId: state.lies?.[a.device] ?? (peers[a.device] as string),
          lastSeenAt: offline.has(a.device)
            ? Math.floor(Date.now() / 1000) - 7200
            : Math.floor(Date.now() / 1000),
          revocationsPending: Object.values(a.endpoints).filter((e) => e.revokedAt && !e.applied).length,
        }));
      return later(list);
    },
    async renameAppliance({ orgId, device, name }) {
      guard();
      const a = state.appliances[device];
      if (!state.org || orgId !== state.org.orgId || !a || a.claimedBy !== LOCAL.id || isReleased(device))
        throw new ControlError('not_found', 'No such appliance.');
      a.name = name;
      save();
      const [named] = (await control.appliances(orgId)).filter((x) => x.device === device);
      return later(named as ApplianceSummary);
    },
    async createWhombatLink(orgId, terms) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      if (!state.org || orgId !== state.org.orgId) throw new ControlError('not_found', 'No such org.');
      if (!applianceTermsAccepted(terms.version))
        throw new ControlError('terms_required', 'Accept the current terms.');
      const letters = 'ABCDEFGHJKMNPQRTVWXY';
      const pick = () => letters[Math.floor(Math.random() * letters.length)];
      const code = `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      state.whombatLinks = [...(state.whombatLinks ?? []).slice(-2), { code, expiresAt, used: false }];
      save();
      return later({ code, expiresAt });
    },
    async nearbyClaims(orgId) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      if (!state.org || orgId !== state.org.orgId) return later([]);
      const seen = Math.floor(Date.now() / 1000) - 20;
      return later(
        (state.nearby ?? [])
          .map((d) => state.appliances[d])
          .filter(
            (a): a is ApplianceState =>
              !!a && !a.claimedBy && !!a.lookup && !offline.has(a.device) && !isRetired(a.device),
          )
          .map((a) => ({
            device: a.device,
            model: 'wb-mini-1',
            registeredAt: seen - 86_400,
            lastSeenAt: seen,
          })),
      );
    },
    async startClaim(input) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      // Control accepts the current appliance terms and the ones before (LC-18, CL-44) and records them on the claim.
      if (!input.terms || !applianceTermsAccepted(input.terms.version))
        throw new ControlError('terms_required', 'Accept the current appliance terms.');
      if (state.claimRefusal === 'self_install_not_allowed')
        throw new ControlError('self_install_not_allowed', 'Self-installed Whombats aren’t in this plan.');
      if (state.claimRefusal === 'devices_allowed_reached')
        throw new ControlError('devices_allowed_reached', 'Your plan covers 1 Whombats.', { allowed: 1 });
      // Stripe billing (BL-13, BL-17, BL-18): a plan first, one trial per Whombat, and no more than paid for.
      const b = state.billing;
      if (b && b.provider === 'stripe') {
        settle(b);
        if (b.setupRequired || b.state === 'cancelled')
          throw new ControlError('billing_setup_required', 'Choose a plan first.');
        if (b.state === 'trialing' && (state.trialUsed ?? []).includes(input.device))
          throw new ControlError('trial_used_device', 'This Whombat already had a trial.', {
            canStartNow: true,
          });
        if (claimedCount() >= b.paid)
          throw new ControlError('devices_allowed_reached', `Your plan covers ${b.paid} Whombats.`, {
            allowed: b.paid,
          });
      }
      state.claimTerms = [...(state.claimTerms ?? []), input.terms.version];
      save();
      let a: ApplianceState | undefined;
      if (input.method === 'card') {
        a = state.appliances[input.device];
        // Control refuses a retired box like an unknown one (`device_not_found`, AP-697).
        if (!a || isRetired(a.device))
          throw new ControlError('not_found', 'There’s no Whombat with that code.');
        // Control checks the card's proof against the verifier provisioning registered (CT-43).
        if (input.claimProof !== claimVerifier(input.device, SECRETS[keyOf(input.device)]))
          throw new ControlError('claim_invalid', 'That claim code isn’t right.');
      } else {
        // Only a box `claims.nearby` would list for this caller right now (CC-13: no other code form).
        // Control can't check the letters.
        a = state.appliances[input.device];
        if (!a || a.claimedBy || !a.lookup || !(state.nearby ?? []).includes(a.device))
          throw new ControlError('device_not_nearby', 'That device isn’t on your network.');
      }
      if (a.competing)
        throw new ControlError('claim_competing', 'Someone else is claiming this Whombat right now.');
      if (a.claimedBy && a.claimedBy !== LOCAL.id)
        throw new ControlError('already_claimed', 'Someone already claimed this Whombat.');
      return later({
        claim: {
          claim: `clm_${hex(8)}`,
          device: a.device,
          method: input.method,
          contentPeerId: peers[a.device] as string,
          expiresAt: Math.floor(Date.now() / 1000) + 900,
        },
        ticket: { ticket: `fake.${a.device}`, relayUrl: 'wss://relay.fake/v1/connect' },
      });
    },
    async ticket({ device }) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      // Retired, or not the organization's any more: control's one 404 for both (`tickets/client.ts`, AP-693).
      if (isRetired(device) || isReleased(device))
        throw new ControlError(
          'not_found',
          'No such appliance in this organization.',
          {},
          'device_not_found',
        );
      return { ticket: `fake.${device}`, relayUrl: 'wss://relay.fake/v1/connect' };
    },
    async pushRegister() {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      return later({ handle: `ph_${hex(16)}` });
    },
    async pushUnregister() {
      guard();
    },
    // The fake world has no push service: browser notifications stay off in it.
    async pushVapidKey() {
      guard();
      return null;
    },
    // Phone sign-in by QR code (CT-190, AP-527): handoffs as control keeps them; the fake phone is `phoneScan` /
    // `phoneReport` below.
    async createPhoneHandoff() {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      const now = Date.now();
      const h: FakeHandoff = {
        handoffId: `ph_${hex(8)}`,
        token: b64url(32),
        tokenExpiresAt: now + PHONE_TOKEN_MS,
        expiresAt: now + PHONE_HANDOFF_MS,
        state: 'waiting',
        report: null,
      };
      handoffs.set(h.handoffId, h);
      return later({
        handoffId: h.handoffId,
        token: h.token,
        expiresAt: new Date(h.tokenExpiresAt).toISOString(),
      });
    },
    async phoneHandoff(handoffId) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      const h = liveHandoff(handoffId);
      if (!h) throw new ControlError('not_found', 'Not found.');
      return later({
        handoffId,
        state: h.state,
        expiresAt: new Date(h.expiresAt).toISOString(),
        report: h.report,
      });
    },
    async redeemPhoneHandoff(token) {
      guard();
      const h = [...handoffs.values()].find((x) => x.token === token);
      if (!h || !liveHandoff(h.handoffId) || h.state !== 'waiting')
        throw new ControlError('invalid_link', 'This sign-in code has expired or was already used.');
      h.state = 'scanned';
      return later({ session: cloudSession(), handoffId: h.handoffId });
    },
    async reportPhoneHandoff(handoffId, report) {
      guard();
      const h = liveHandoff(handoffId);
      if (!h) throw new ControlError('not_found', 'Not found.');
      if (h.state === 'expired') throw new ControlError('handoff_expired', 'This sign-in took too long.');
      h.report = report;
      h.state = report.kind === 'pairing' ? 'ready' : 'done';
      await later(null);
    },
    async androidDownload() {
      guard();
      return later(state.androidApk === undefined ? FAKE_APK : state.androidApk);
    },
    async releaseSummary(release) {
      guard();
      if (!state.signedIn) throw new ControlError('signed_out', 'Sign in again.');
      const summary = state.releaseSummaries?.[release];
      return summary === undefined ? null : { release, summary, publishedAt: nowS() - 2 * DAY };
    },
  };

  const cards = () => {
    const card = (k: keyof typeof DEVICES): FakeCard => ({
      device: DEVICES[k],
      secret: SECRETS[k].match(/.{1,4}/g)?.join(' ') ?? SECRETS[k],
      qr: `WHOMBAT1:${DEVICES[k]}:ABCDE-FGHIJ-KLMNO-PQRST-UVWXY:${SECRETS[k]}`,
      link: `${location.origin}/claim#v=1&d=${DEVICES[k]}&p=${peers[DEVICES[k]]}&s=${SECRETS[k]}`,
    });
    return {
      fresh: card('fresh'),
      used: card('used'),
      contested: card('contested'),
      mismatched: card('mismatched'),
      spare: card('spare'),
    };
  };

  const consoles = () => {
    const view = (k: keyof typeof DEVICES): FakeConsole | null => {
      const a = state.appliances[DEVICES[k]];
      if (!a || a.claimedBy || !a.letters || !a.lookup) return null;
      return { code: a.letters, letters: a.letters };
    };
    return {
      fresh: view('fresh'),
      used: view('used'),
      contested: view('contested'),
      mismatched: view('mismatched'),
      spare: view('spare'),
    };
  };

  const world: FakeWorld = {
    control,
    page: () => (state.boxPage ? { kind: 'box', secure: false } : undefined),
    box: () => {
      // The community box, or the A3 box at its own address (`faults.ownBox`).
      const device = () => (state.ownBox ? DEVICES.own : DEVICES.community);
      return {
        identity: async () => {
          const a = state.appliances[device()];
          if (!a || offline.has(device())) return null;
          return {
            v: 1,
            appliance: peers[device()] as string,
            edition: a.edition ?? 'commercial',
            claimed: !!a.claimedBy,
          };
        },
        connector: (target) => ({
          async connect(request) {
            const d = device();
            connects.push({ device: d, peerId: target.peerId, channel: 'direct' });
            if (offline.has(d)) throw new ConnectError('offline', 'Couldn’t reach this Whombat.');
            if (peers[d] !== target.peerId)
              throw new ConnectError('identity_mismatch', 'This isn’t the Whombat this page pinned.');
            // A direct connection: the box decides the channel (enrolled keys get the app's).
            return fakeFor(d)
              .connectorFor({ endpointId: target.key.peerId, channel: 'app' })
              .connect(request);
          },
        }),
        secure: () => !state.insecurePage && window.isSecureContext,
        ownAddress: () => (state.ownBox ? (state.ownPageHost ?? FAKE_OWN_HOST) : null),
      };
    },
    connector(target) {
      // Control's tickets as the real connector asks for them (AP-693), one source per session.
      const tickets = controlTickets(control, target);
      return {
        async connect(request) {
          connects.push({ device: target.device, peerId: target.peerId, channel: target.channel });
          if (!state.signedIn) throw new ConnectError('ticket_denied', 'Signed out.');
          // Control down is “offline”; a retired Whombat, or one control doesn't list, says so (AP-693).
          await tickets({ channel: target.channel, class: request.class }).catch((error: unknown) => {
            throw ticketConnectError(error);
          });
          if (relayDown) throw new ConnectError('offline', 'Couldn’t reach Whombat.');
          if (!state.appliances[target.device] || offline.has(target.device))
            throw new ConnectError('appliance_offline', 'The appliance is not connected.');
          // The handshake proves the appliance's identity; the pin must match before anything is sent.
          if (peers[target.device] !== target.peerId)
            throw new ConnectError('identity_mismatch', 'This isn’t the appliance on the claim card.');
          return fakeFor(target.device)
            .connectorFor({ endpointId: target.key.peerId, channel: target.channel })
            .connect(request);
        },
      };
    },
    faults: {
      ai: (device) => aiFor(device),
      reset() {
        ais.clear();
        remoteHelps.clear();
        state = initial();
        save();
        offline.clear();
        controlDown = false;
        relayDown = false;
      },
      cards,
      consoles,
      nearby(keys) {
        state.nearby = keys.map((k) => DEVICES[k]);
        save();
      },
      claimBackoff(device, seconds) {
        const a = state.appliances[device];
        if (a) a.claimBackoffUntil = Date.now() + seconds * 1000;
        save();
      },
      screenSignIn(device) {
        const live = liveScreenSignIn(device);
        const a = state.appliances[device];
        if (!live || !a) return null;
        return {
          code: formatScreenSignInLetters(live.letters),
          letters: live.letters,
          name: accountOf(a, live.accountId)?.name ?? live.accountId,
          device: live.label,
          expiresAt: new Date(live.expiresAt).toISOString(),
        };
      },
      noScreen(device, value) {
        if (value) noScreen.add(device);
        else noScreen.delete(device);
      },
      expireScreenSignIn(device) {
        screenSignIns.delete(device);
      },
      lastLink: () => state.lastLink,
      passkeys: (device) => [...(state.appliances[device]?.passkeys ?? [])],
      controlPasskeys: () => [...(state.controlPasskeys ?? [])],
      passkeyChallenge(challenge) {
        state.passkeyFaults = { ...state.passkeyFaults, challenge };
        save();
      },
      passkeySignInElsewhere(device, label = 'Pixel 9 · Android app') {
        const a = state.appliances[device];
        const p = [...(a?.passkeys ?? [])].reverse().find((x) => !x.removed);
        if (!a || !p) return '';
        const now = new Date().toISOString();
        a.endpoints[strangerPeer] = { ...fakeEndpoint(label), accountId: p.accountId, platform: 'android' };
        p.lastUsedAt = now;
        a.enrolledWith = { ...a.enrolledWith, [strangerPeer]: p.id };
        save();
        return strangerPeer;
      },
      controlPasskeyDown(value) {
        state.passkeyFaults = { ...state.passkeyFaults, controlDown: value };
        save();
      },
      passkeyEnrollDown(value) {
        state.passkeyFaults = { ...state.passkeyFaults, enrollDown: value };
        save();
      },
      controlDown(v) {
        controlDown = v;
      },
      communityLetters: () => {
        const a = state.appliances[DEVICES.community];
        return a && !a.claimedBy ? (a.letters ?? null) : null;
      },
      insecurePage(v) {
        state.insecurePage = v;
        save();
      },
      ownBox(v, watch = {}) {
        state.ownBox = v;
        const own = state.appliances[DEVICES.own]?.own;
        if (own) Object.assign(own, { foreign: watch.foreign === true, missed: watch.missed === true });
        save();
      },
      ownRenamed(change) {
        const a = state.appliances[DEVICES.own];
        const own = a?.own;
        if (!a || !own) return;
        if (!change) {
          Object.assign(own, { host: FAKE_OWN_HOST, leaving: null, starting: false });
          state.ownPageHost = null;
          a.passkeys = (a.passkeys ?? []).filter((p) => p.id !== FAKE_MOVED_PASSKEY);
          return save();
        }
        const host = `${change.label}.${OWN_ADDRESS_ZONES.prod}`;
        const until = new Date(Date.now() + (change.days ?? 30) * 86_400_000).toISOString();
        Object.assign(own, { host, leaving: { host: FAKE_OWN_HOST, until }, starting: false });
        own.had = [...new Set([...(own.had ?? []), FAKE_OWN_HOST.split('.')[0] ?? ''])];
        state.ownPageHost = change.page === 'new' ? host : FAKE_OWN_HOST;
        // The owner's box passkey from before the change, under the old address.
        const owner = a.claimedBy;
        if (owner && !(a.passkeys ?? []).some((p) => p.id === FAKE_MOVED_PASSKEY))
          a.passkeys = [
            ...(a.passkeys ?? []),
            {
              id: FAKE_MOVED_PASSKEY,
              name: 'Chrome on this Mac',
              accountId: owner,
              createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
              lastUsedAt: null,
              synced: true,
              removed: false,
              rpId: FAKE_OWN_HOST,
            },
          ];
        save();
      },
      ownRenameRefusal(code) {
        state.ownRenameRefusal = code;
        save();
      },
      linkState(linkState, extra = {}, device) {
        const a = state.appliances[device ?? (state.ownBox ? DEVICES.own : DEVICES.community)];
        if (!a) return;
        const at = new Date().toISOString();
        a.link = {
          state: linkState,
          since: at,
          ...(linkState === 'grace' && { graceEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }),
          ...(linkState === 'starting' && {
            pending: {
              code: FAKE_LINK_CODE,
              url: 'https://app.whombat.com/link',
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          }),
          ...extra,
        };
        save();
      },
      ownClaimLink: () => state.appliances[DEVICES.own]?.own?.claimLink ?? null,
      ownLetters: () => {
        const a = state.appliances[DEVICES.own];
        return a && !a.claimedBy ? (a.letters ?? null) : null;
      },
      lastWhombatLink: () => state.whombatLinks?.at(-1)?.code ?? null,
      makeWhombatLink: () => {
        const code = 'KXQM-PRTV';
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        state.whombatLinks = [...(state.whombatLinks ?? []), { code, expiresAt, used: false }];
        save();
        return code;
      },
      ownLinked: () => {
        const a = state.appliances[DEVICES.own];
        if (!a?.own) return;
        a.claimedBy = LOCAL.id;
        a.letters = undefined;
        a.name = 'Home';
        a.own.claimLink = null;
        a.own.linkedTo = CLOUD.accountId;
        save();
      },
      lastLocalLink: () => lastLocalLink,
      boxPage(v) {
        state.boxPage = v;
        save();
      },
      relayDown(v) {
        relayDown = v;
        if (v) for (const f of fakes.values()) f.faults.dropAll('offline');
      },
      applianceOffline(device, v) {
        if (v) offline.add(device);
        else offline.delete(device);
        if (v) fakes.get(device)?.faults.dropAll('appliance_offline');
      },
      dropConnections: (device) => fakes.get(device)?.faults.dropAll('lost'),
      loseResults: (device, n = 1) => fakeFor(device).faults.loseResults(n),
      swallowRequests: (device, n = 1) => fakeFor(device).faults.swallowRequests(n),
      slowAccept: (device, ms) => fakeFor(device).faults.slowAccept(ms),
      protocol(device, majors) {
        state.majors = { ...state.majors, [device]: majors };
        save();
        fakeFor(device).faults.majors(majors);
        fakeFor(device).faults.dropAll('lost');
      },
      revokeEndpoint(device, peerId) {
        const e = state.appliances[device]?.endpoints[peerId];
        if (e) e.revokedAt = new Date().toISOString();
        save();
        fakes.get(device)?.dropEndpoint(peerId, 'revoked');
      },
      requestPairing(device, label = 'Hugo’s phone') {
        const a = state.appliances[device];
        if (!a) return '';
        const code = randomCode();
        a.pairing.push({
          pairingId: `pair_${hex(6)}`,
          code,
          endpoint: otherPeer,
          label,
          platform: 'android',
          state: 'pending',
        });
        save();
        return code;
      },
      approveMyPairing(device) {
        const a = state.appliances[device];
        const r = a?.pairing.find((p) => p.state === 'pending' && p.endpoint !== otherPeer);
        if (!a || !r) return;
        r.state = 'approved';
        a.endpoints[r.endpoint] = {
          accountId: LOCAL.id,
          label: r.label,
          platform: 'web',
          createdAt: new Date().toISOString(),
          revokedAt: null,
          applied: false,
        };
        save();
      },
      kitOwner(device, accountId) {
        const a = state.appliances[device];
        if (a) a.kit.owner = accountId;
        save();
      },
      kitUnconfirmed(device) {
        const a = state.appliances[device];
        if (a) a.kit.confirmed = false;
        save();
      },
      clientFloor(device, floor) {
        const a = state.appliances[device];
        if (a) a.clientFloor = floor;
        save();
        fakeFor(device).faults.clientFloor(floor);
        fakeFor(device).faults.dropAll('lost');
      },
      tamperDiagnostics(device) {
        const d = state.appliances[device]?.diagnostics?.at(-1);
        if (d)
          (d.bundle as { scopes: string[] }).scopes = [
            ...(d.bundle as { scopes: string[] }).scopes,
          ].reverse();
        if (d) (d.bundle as Record<string, unknown>).windowS = 1;
        save();
      },
      hijackPairing(device, code) {
        const r = state.appliances[device]?.pairing.find((p) => p.code === code && p.state === 'pending');
        if (r) r.endpoint = strangerPeer;
        save();
      },
      pushRef(device, link) {
        const a = state.appliances[device];
        if (!a) return '';
        const ref = hex(11);
        a.pushRefs = { ...a.pushRefs, [ref]: { burrow: burrow.slug, link } };
        save();
        return ref;
      },
      providers(device, rows) {
        state.providers = { ...state.providers, [device]: rows };
        save();
      },
      backup(device, s) {
        const a = state.appliances[device];
        if (a) a.backup = s;
        save();
      },
      update(device, value) {
        const a = state.appliances[device];
        if (!a) return;
        const { state: journal, ...facts } = value;
        a.update = journal;
        a.updateFacts = facts;
        save();
      },
      newerDevice(device, platform) {
        const a = state.appliances[device];
        if (!a) return;
        a.endpoints[`12D3KooWNewerDevice${'N'.repeat(33)}`] = {
          ...fakeEndpoint('Vision Pro'),
          platform: platform as EndpointRecord['platform'],
        };
        save();
      },
      backupMaterial(device, extra) {
        const a = state.appliances[device];
        if (a) a.backupMaterialExtra = extra ?? undefined;
        save();
      },
      beforePasskey(device) {
        const a = state.appliances[device];
        if (a) a.beforePasskey = true;
        save();
      },
      kitEnvelope(name) {
        state.kitEnvelopes = [
          ...(state.kitEnvelopes ?? []),
          {
            id: `kit_${hex(6)}`,
            appliance: peers[DEVICES.used] as string,
            credentialId: 'fakeCredential0',
            salt: 'c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ',
            envelope: 'wbkit1.bm9uY2U.Y2lwaGVy',
            generation: 2,
            createdAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
            whombatName: name,
          },
        ];
        save();
      },
      backupOptions(device, patch) {
        backupOptionsFor(device).set(patch);
      },
      releaseSummary(release, summary) {
        const all = { ...state.releaseSummaries };
        if (summary === null) delete all[release];
        else all[release] = summary;
        state.releaseSummaries = all;
        save();
      },
      publish: (device, topic, event) => fakeFor(device).publish(topic, event),
      licence(device, value) {
        const a = state.appliances[device];
        if (a) a.licence = typeof value === 'string' ? { kind: value } : value;
        save();
      },
      desk(device, kind) {
        const a = state.appliances[device];
        if (!a) return;
        a.desk = { kind, snapshot: deskSeed(kind, Date.now()).initial };
        desks.delete(device);
        save();
        if (kind === 'request') deskFor(device).requestUnlock();
      },
      machine(device, kind) {
        const a = state.appliances[device];
        if (!a) return;
        a.machine = { kind, network: null, bluetooth: null };
        networks.delete(device);
        bluetooths.delete(device);
        save();
      },
      machineCable: (device, plugged) => networkFor(device)?.plugCable(plugged),
      machineNetwork: (device) => networkFor(device)?.snapshot() ?? null,
      machineBluetooth: (device) => bluetoothFor(device)?.snapshot() ?? null,
      tailscaleSignedIn: (device) => tailscaleFor(device).signedIn(),
      tailscaleState: (device) => tailscaleFor(device).status().state,
      deskLetters: (device) => deskFor(device).letters(),
      deskRequestUnlock: (device) => deskFor(device).requestUnlock(),
      deskUnlocked: (device) => deskFor(device).unlocked(),
      remoteHelpVisit: (device, who) => remoteHelpFor(device).visit(who ? { who } : {}),
      remoteHelpLeave: (device) => remoteHelpFor(device).leave(),
      remoteHelpBox(device, box) {
        const remote = remoteHelpFor(device);
        if (box.environment) remote.setEnvironment(box.environment);
        if (box.available !== undefined) remote.setAvailable(box.available);
      },
      remoteHelp: (device) => remoteHelpFor(device).snapshot(),
      claimRefusal(reason) {
        state.claimRefusal = reason;
        save();
      },
      deleteRefusal(reason) {
        state.deleteRefusal = reason;
        save();
      },
      claimTerms: () => state.claimTerms ?? [],
      lieAbout(device, value) {
        const lies = { ...state.lies };
        if (value) lies[device] = value === true ? impostorPeer : value;
        else delete lies[device];
        state.lies = lies;
        save();
      },
      peerOf: (device) => peers[device] ?? null,
      retire(device, value = true) {
        state.retired = toggled(state.retired, device, value);
        save();
      },
      release(device, value = true) {
        state.released = toggled(state.released, device, value);
        save();
      },
      impostorPeer: () => impostorPeer,
      connects: () => [...connects],
      googleFinishes: (device) => state.appliances[device]?.google?.finishes ?? [],
      oauthFinishes: (device) => state.appliances[device]?.oauthFinishes ?? [],
      feedbackDrop(device, value) {
        const a = state.appliances[device];
        if (a) a.feedbackDrop = value;
        save();
      },
      signup(value) {
        state.signup = { ...signup(), ...value };
        save();
      },
      billing(patch) {
        if (state.billing) Object.assign(state.billing, patch);
        save();
      },
      checkoutLag(ms) {
        if (state.billing) state.billing.lagMs = ms;
        if (state.link) state.link.lagMs = ms;
        save();
      },
      existingOrg(name = ORG.name) {
        state.org = { orgId: ORG.orgId, name };
        state.billing ??= newBilling(null);
        save();
      },
      linkCode(name = null) {
        const l = linkNow();
        const letters = () =>
          Array.from({ length: 4 }, () => LINK_LETTERS[Math.floor(Math.random() * LINK_LETTERS.length)]).join(
            '',
          );
        const code = `${letters()}-${letters()}`;
        l.codes.push({
          code,
          device: `dev_${hex(4).toUpperCase()}`,
          name,
          expiresAt: nowS() + 900,
          used: false,
        });
        save();
        return code;
      },
      linkPlan({ manual, ...patch }) {
        const l = linkNow();
        Object.assign(l.plan, patch);
        if (manual !== undefined) l.manual = manual;
        save();
      },
      linkTerms: () => [...(linkNow().terms ?? [])],
      checkoutBusy(on) {
        linkNow().busy = on;
        save();
      },
      paymentPageOpen(interval) {
        linkNow().openPage = interval ? { interval, until: nowS() + 31 * 60 } : null;
        save();
      },
      linkStripe(on) {
        const l = linkNow();
        if (on === null) delete l.stripe;
        else l.stripe = on;
        save();
      },
      linkTermsForget() {
        const l = linkNow();
        l.terms = [];
        l.termsAccepted = false;
        save();
      },
      linkBox(device, patch) {
        const b = linkNow().boxes.find((x) => x.device === device);
        if (b) Object.assign(b, patch);
        save();
      },
      linkAddressLater(on) {
        linkNow().addressLater = on;
        save();
      },
      linkAddress() {
        const l = linkNow();
        const later = l.addressLater;
        l.addressLater = false;
        for (const b of l.boxes) if (b.state === 'starting') linkOn(b);
        l.addressLater = later;
        save();
      },
      trialUsed(device) {
        state.trialUsed = [...(state.trialUsed ?? []), device];
        save();
      },
      androidDownload(value) {
        state.androidApk = value;
        save();
      },
      phoneHandoffs: () => [...handoffs.values()].map((h) => ({ handoffId: h.handoffId, state: h.state })),
      phoneScan(link) {
        const h = handoffFor(link);
        if (h?.state !== 'waiting') return false;
        h.state = 'scanned';
        lastScanned =
          link ??
          document.querySelector<HTMLElement>('[data-phone-link]')?.getAttribute('data-phone-link') ??
          null;
        return true;
      },
      phoneReport(link, options = {}) {
        const parsed = shownLink(link);
        const h = handoffFor(link);
        if (!parsed || !h) return null;
        if (options.kind === 'signed_in' || !parsed.appliance) {
          h.report = { kind: 'signed_in' };
          h.state = 'done';
          return null;
        }
        // A real pending pairing on the Whombat the code names, as the app asks for it (`enroll.pair.request`).
        const a = state.appliances[parsed.appliance.device];
        if (!a) return null;
        const code = randomCode();
        a.pairing.push({
          pairingId: `pair_${hex(6)}`,
          code,
          endpoint: qrPhonePeer,
          label: options.label ?? 'Pixel 9',
          platform: 'android',
          state: 'pending',
        });
        save();
        const fingerprint =
          options.tamper === 'fingerprint'
            ? pairingFingerprint(strangerPeer)
            : pairingFingerprint(qrPhonePeer);
        const key = options.tamper === 'mac' ? newPhoneHandoffKey() : parsed.key;
        h.report = {
          kind: 'pairing',
          code,
          fingerprint,
          mac: phoneHandoffMac(key, h.handoffId, code, fingerprint),
        };
        h.state = 'ready';
        return code;
      },
      expirePhoneHandoff() {
        const h = [...handoffs.values()].at(-1);
        if (h) h.expiresAt = Date.now();
      },
      phoneLetIn: () =>
        Object.values(state.appliances).some((a) =>
          a.pairing.some((p) => p.endpoint === qrPhonePeer && p.state === 'approved'),
        ),
      waitlist: () => state.waitlist ?? [],
      created: () => state.created ?? [],
      canvas: (canvasId) => collab.snapshot(canvasId),
      servers(on) {
        state.servers = on;
        save();
      },
      consolesOpened: () => consolesWorld.opened(),
      state: () => state,
      verifyCalls: () => verifyCalls,
    },
  };
  (globalThis as { __WHOMBAT_FAKE__?: FakeFaults }).__WHOMBAT_FAKE__ = world.faults;
  return world;
}
