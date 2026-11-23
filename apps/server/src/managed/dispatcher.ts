/**
 * The allowlisted session dispatcher (MA-08, MA-09; docs/decisions/managed-runtime.md MR-05, MR-06).
 *
 * A session `request{id, op, input, deadlineMs}` names one operation of `@whombat/protocol`'s allowlist
 * (`createOperationAllowlist`): an `api.<area>.<action>` REST contract with input `{params, query?, body?}`, or a
 * session-native op (enrollment, recovery, endpoints, providers, backup). An `api` op runs
 * the very handler REST registers (`ROUTES`), in-process, with the session's account as the caller: the same Zod
 * parsing, the same `burrowAccess` membership check, the same commit pipeline. Nothing is proxied: there is no
 * URL, header or port in a request, the runner protocol, MCP and admin endpoints are not contract `api` ops, and
 * what managed mode disables is excluded with its explanation.
 *
 * Mutations are durable commands (`receipts.ts`): `accepted` is sent after the command's first transaction
 * commits, a retry never executes twice, cancellation and deadlines only prevent execution before that commit — or
 * before an external effect the command ran ahead of it (docs/decisions/command-safety.md CS-01), which pins it.
 * Reads run directly. The session re-checks its principal before every request.
 */

import {
  type BackupServiceStatus,
  summarizeBackup,
  summarizeUpdate,
  type UpdateFacts,
} from '@whombat/control-contracts/local';
import { newId } from '@whombat/core';
import {
  assistantAccessFor,
  BackupScope,
  createOperationAllowlist,
  EPHEMERAL_MAX_PER_MINUTE,
  type OperationAllowlist,
  type OperationSpec,
  RETRYABLE_ERROR_CODES,
  receiptDigest,
  SESSION_PROTOCOL,
  type SessionErrorCode,
  SessionErrorCode as SessionErrorCodeSchema,
} from '@whombat/protocol/session';
import { type BurrowAccess, burrowAccess, type RequestAuth } from '../auth/request';
import { answerFor } from '../automations/older-apps';
import { BACKUP_PLACE_HANDLERS } from '../backup-places/ops';
import { type CommandScope, CommandStopped, type EffectEnd, runInCommandScope } from '../commit/scope';
import type { Tx } from '../db/client';
import { binarySchema } from '../db/migrate';
import { DESK_SESSION_HANDLERS } from '../desk/ops';
import type { ScreenSessions } from '../desk/screen-sessions';
import type { DeskService } from '../desk/service';
import { errorForLog, sqlState } from '../lib/db-errors';
import { ApiError, UnknownOutcomeError, unauthorized, validationError } from '../lib/errors';
import { OutcomeReply, Raw, type RouteDef } from '../routes/define';
import { ROUTES } from '../routes/index';
import type { Services } from '../services';
import { buildInfo } from '../version';
import { VOICE_SESSION_HANDLERS } from '../voice/ops';
import { forAssistant } from './acting-assistant';
import { BACKUP_HANDLERS, type BackupPort } from './backup';
import { BACKUP_KEY_HANDLERS, withBringBack } from './backup-key';
import { BACKUP_LOOK_HANDLERS } from './backup-look';
import { BACKUP_OPTIONS_HANDLERS } from './backup-options';
import { boxBackupStatus } from './box-backup';
import { BOX_PASSKEY_SESSION_HANDLERS } from './box-passkeys';
import type { SessionScope } from './claim';
import type { DiagnosticsService } from './diagnostics';
import { DIRECT_SESSION_HANDLERS } from './direct/ops';
import type { TailscaleService } from './direct/tailscale';
import { PAGE_PASSKEY_OPS, passkeysWorkHere } from './direct/transport';
import { DISPLAY_SESSION_HANDLERS } from './display';
import { applianceHermes } from './hermes-version';
import {
  type HostBluetoothService,
  hostBluetoothCancelOp,
  hostBluetoothConfirmOp,
  hostBluetoothConnectOp,
  hostBluetoothDisconnectOp,
  hostBluetoothForgetOp,
  hostBluetoothOp,
  hostBluetoothPairOp,
  hostBluetoothScanOp,
} from './host-bluetooth';
import { type HostHardwareService, hostHardwareOp } from './host-hardware';
import { type HostMetricsService, hostMetricsOp } from './host-metrics';
import {
  type HostNetworkService,
  hostCableSetOp,
  hostNetworkOp,
  hostWifiForgetOp,
  hostWifiJoinOp,
  hostWifiScanOp,
} from './host-network';
import type { LicenceService } from './licence';
import type { LinkEmail } from './link/mail';
import { LINK_SESSION_HANDLERS } from './link/ops';
import type { PushTokens } from './link/push-tokens';
import type { LinkService } from './link/service';
import { LOCAL_SESSION_HANDLERS } from './local-ops';
import type { ManagedExplanation } from './ops';
import { OWN_ADDRESS_SESSION_HANDLERS } from './own-address/ops';
import type { OwnAddressService } from './own-address/state';
import { feedbackIntakeGuard, managedPolicy, managedRefusal, passkeysUnavailableHere } from './policy';
import type { ManagerPort } from './ports';
import { RunnerBridgeError } from './providers/bridge';
import { PROVIDER_SESSION_HANDLERS } from './providers/handlers';
import { providerLogins, signInsAvailable } from './providers/service';
import { resolvePushRef } from './push';
import {
  type CommandOutcome,
  type CommandReceipts,
  type ExecuteAnswer,
  REDACTED_COMPLETION,
  unknownOutcome,
} from './receipts';
import { REMOTE_HELP_SESSION_HANDLERS, type RemoteHelpService } from './remote-help';
import { SessionOpError } from './session-error';
import { assistantPrincipal, isScreenSession, type SessionPrincipal, type TrustService } from './trust';
import { UPDATE_ASK_SESSION_HANDLERS } from './update-ask';

/**
 * Contract `api` ops that never run over a session, with the explanation (docs/managed/parity-inventory.md §4).
 * `devices.vapidKey` runs over the session since contracts 1.1 (CT-1307): the box's own Web Push key.
 */
export const SESSION_DENIED: Readonly<Record<string, ManagedExplanation | 'local'>> = {
  // The manager asks the admin socket for health, never through a session.
  'health.get': 'local',
  // Inbound webhooks don't exist on an appliance.
  'automations.webhook': 'automationWebhooks',
};

/** Ops the protocol allows that this appliance also excludes. */
const EXCLUDED: readonly string[] = ['health.get', 'automations.webhook'];

export interface SessionOpContext {
  principal: SessionPrincipal;
  services: Services;
  trust: TrustService;
  facts: ApplianceFacts;
  /** The backup service's local API (managed appliances with a backup service). */
  backup?: BackupPort | undefined;
  /** The manager, where there is one. */
  manager?: ManagerPort | undefined;
  /** Diagnostic bundles (CT-52). */
  diagnostics: DiagnosticsService | undefined;
  /** This session's own state (the live claim begin); null outside a session. */
  session: SessionScope | null;
  /** The appliance licence (LC-08, LC-09); absent where no runtime built one. */
  licence: LicenceService | undefined;
  /** The manager's measurements of the box (box-status.md BS-06); absent where no manager measures it. */
  host: HostMetricsService | undefined;
  /** The box's hardware report and network (hardware-support-server.md HD-S02, HD-S04); absent without a manager. */
  hardware: HostHardwareService | undefined;
  network: HostNetworkService | undefined;
  /** The box's Bluetooth (bluetooth-server.md BT-S02); absent without a Bluetooth service. */
  bluetooth: HostBluetoothService | undefined;
  /** The desk screen (desk-display-server.md DK-S17); absent where the runtime runs no desk socket. */
  desk: DeskService | undefined;
  /** Screens elsewhere (desk-display.md DK-146): their store and locks; absent where there are no screens. */
  screens: ScreenSessions | undefined;
  /** Remote help (remote-help-server.md RH-S02); absent where the runtime has no support service. */
  remoteHelp: RemoteHelpService | undefined;
  /** Tailscale for This Whombat (direct-connection.md DC-13); absent where no boot made one. */
  tailscale: TailscaleService | undefined;
  /** The box's own address (own-address.md); absent on a box without one (community, tests). */
  ownAddress?: OwnAddressService | null | undefined;
  /** Whombat Link as the manager last said it (whombat-link.md); absent where no runtime built it. */
  link?: LinkService | undefined;
  /** Phones' own push tokens, registered at control while Link runs (LNK-36). */
  pushTokens?: PushTokens | undefined;
  /** Email through Whombat Link: the owner's choices (link-email.md). */
  linkEmail?: LinkEmail | undefined;
}

/**
 * What the runtime knows only from the manager (backup service and updates), pushed through the admin socket
 * (`POST /facts`, CT-23), plus this runtime's identity (`appliance.status.appliance`, CT-24).
 */
export interface ApplianceFacts {
  appliance: {
    peerId: string;
    runtimeVersion: string;
    schemaVersion: number | null;
    protocol: { major: number; minor: number };
  };
  backup: BackupServiceStatus | null;
  update: UpdateFacts | null;
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type SessionHandler = (ctx: SessionOpContext, input: any) => Promise<unknown>;

const identityOf = (p: SessionPrincipal) => ({ peerId: p.peerId, publicKey: p.publicKey });

/** What the allowlist asks of a session: enrolled, and whether it is a screen's (only the `screen` channel). */
const sessionOf = (p: SessionPrincipal) => ({
  enrolled: p.endpoint !== null || p.assistant !== undefined,
  screen: isScreenSession(p),
});

/**
 * `appliance.status.providers` (contracts 0.4.0): each model provider the runner reported, with its state and the
 * explanation people see. Per-identity provider logins (MA-10) are a later workstream: until then a provider the
 * runner can't use reads `not_signed_in`, and nothing falls back to another login.
 */
async function providerRows(c: SessionOpContext) {
  const status = c.services.runtime.setupStatus();
  const rows = status.providers.map((p) => {
    const ready = p.state === 'ready' && !p.sandboxProblem;
    return {
      provider: p.provider,
      authMode: 'subscription' as const,
      ownerAccountId: null as string | null,
      // A sandbox the provider can't use is `gated`: a managed appliance never runs a turn without it.
      state: ready ? 'ready' : p.sandboxProblem ? 'gated' : p.state === 'error' ? 'outage' : 'not_signed_in',
      explanation: ready
        ? null
        : (p.sandboxProblem ?? p.detail ?? 'Sign in to this provider on the appliance.'),
    };
  });
  return rows;
}

/**
 * The sign-in rows `appliance.status` shows (PV-05): per account where this runtime holds sign-ins (`signInsAvailable`,
 * SUB-56) and they can be read now; otherwise — and when the runner doesn't answer — the runner's setup as before.
 */
async function applianceProviderRows(c: SessionOpContext) {
  const logins = providerLogins(c.services);
  if (!signInsAvailable(c.services.config) || !logins.readable) return providerRows(c);
  return logins.statusRows(c.principal).catch(() => providerRows(c));
}

const diag = (c: SessionOpContext): DiagnosticsService => {
  if (!c.diagnostics) throw new ApiError('not_implemented', 'Diagnostics aren’t available here.');
  return c.diagnostics;
};

/** Session-native and extension ops → the trust service. */

/** The backup summary of `appliance.status`, with where bringing the box back stands (backup-passkey.md). */
async function applianceBackup(c: SessionOpContext) {
  const status = (await boxBackupStatus(c.services)) ?? c.facts.backup;
  return withBringBack(c.services, summarizeBackup(status, BackupScope.options), status);
}
export const SESSION_HANDLERS: Readonly<Record<string, SessionHandler>> = {
  'enroll.claim.begin': (c, i) => c.trust.claimBegin(identityOf(c.principal), c.session, i),
  'enroll.claim': (c, i) => c.trust.claim(identityOf(c.principal), c.session, i),
  // Sign in at the box (signin-at-box BX-02…BX-07): the code on its screen, then the claim's CPace.
  'enroll.screen.request': (c, i) => c.trust.screen.request(identityOf(c.principal), i),
  'enroll.screen.begin': (c, i) => c.trust.screen.begin(identityOf(c.principal), c.session, i),
  'enroll.screen': (c, i) => c.trust.screen.confirm(identityOf(c.principal), c.session, i),
  'enroll.pair.request': (c, i) => c.trust.pairRequest(identityOf(c.principal), i, c.session?.transport),
  'enroll.pair.status': (c, i) => c.trust.pairStatus(identityOf(c.principal), i),
  'enroll.pair.approve': (c, i) => c.trust.pairApprove(c.principal, i),
  'enroll.pair.lookup': (c, i) => c.trust.pairLookup(c.principal, i),
  'diagnostics.create': (c, i) => diag(c).create(c.principal, i),
  'diagnostics.preview': (c, i) => diag(c).preview(c.principal, i),
  'diagnostics.list': (c) => diag(c).list(c.principal),
  'diagnostics.delete': (c, i) => diag(c).delete(c.principal, i),
  'recovery.kit.register': (c, i) => c.trust.kitRegister(c.principal, i),
  'recovery.kit.rotate': (c, i) => c.trust.kitRotate(c.principal, i),
  'recovery.kit.confirm': (c, i) => c.trust.kitConfirm(c.principal, i),
  'recovery.enroll': (c, i) => c.trust.recoveryEnroll(identityOf(c.principal), i),
  // Passkeys that open this Whombat (docs/decisions/passkeys.md PK-05…PK-08).
  'enroll.passkey': (c, i) => c.trust.passkeys.enroll(identityOf(c.principal), i),
  'passkey.register.begin': (c, i) => c.trust.passkeys.registerBegin(c.principal, c.session, i),
  'passkey.link': (c, i) => c.trust.passkeys.link(c.principal, c.session, i),
  'passkey.register': (c, i) => c.trust.passkeys.register(c.principal, c.session, i),
  'passkeys.list': (c) => c.trust.passkeys.list(c.principal),
  'passkey.remove': (c, i) => c.trust.passkeys.remove(c.principal, i),
  'passkeys.policy': (c, i) => c.trust.passkeys.setPolicy(c.principal, i),
  'endpoints.list': (c) => c.trust.endpointsList(c.principal),
  'endpoints.revoke': (c, i) => c.trust.endpointsRevoke(c.principal, i),
  'endpoints.rename': (c, i) => c.trust.endpointsRename(c.principal, i),
  'push.handles.set': (c, i) => c.trust.setPushHandle(c.principal, i.handle),
  'push.handles.clear': (c) => c.trust.setPushHandle(c.principal, null),
  'push.resolve': (c, i) => {
    if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
    return resolvePushRef(c.services, c.principal.account.id, i.ref);
  },
  // The appliance licence (CT-77): the state and “Check again” (LC-08).
  'licence.status': async (c) => ({ licence: (await c.licence?.view()) ?? null }),
  // The licence is inert (whombat-link.md LNK-04): nothing to renew; `licence.status` still answers.
  'licence.refresh': async () => {
    throw new ApiError('not_allowed', 'This Whombat has no licence to check.');
  },
  'appliance.status': async (c) => ({
    ...(await c.trust.applianceStatus()),
    // Null while unclaimed (CT-77); absent only from runtimes before 0.10.0 and self-hosted servers.
    licence: (await c.licence?.view()) ?? null,
    // The Hermes Agent the assistant runs on, as its ready runner reported it (null while unknown).
    appliance: { ...c.facts.appliance, hermes: applianceHermes(c.services.runtime.setupStatus().hermes) },
    // Per-account provider sign-ins and their states (managed-providers.md PV-05), when the appliance has them: its own
    // root, or the runner's through the sign-in bridge (SUB-56; the appliance gives the root to the runner alone).
    providers: await applianceProviderRows(c),
    draining: c.services.maintenance.draining,
    policy: managedPolicy(c.services),
    // The backup service's own status when the manager doesn't forward it (its facts carry none): reading only the facts
    // said “Backups aren’t set up” on a box that backs up every few hours. No backup service at all reads `unprotected`:
    // never "enabled" without a destination.
    backup: await applianceBackup(c),
    update: summarizeUpdate(c.facts.update),
    // Its own address (own-address.md): null while it has none; absent from runtimes before 4.3.
    ownAddress: c.trust.ownAddress?.summary() ?? null,
  }),
  // How the box is doing, for the person (docs/decisions/box-status.md BS-06): the manager's measurements.
  'host.metrics': (c, i) => hostMetricsOp(c, i),
  // The box's hardware and network, for the person (docs/decisions/hardware-support.md HD-03, HD-06; HD-S02, HD-S04).
  'host.hardware': (c) => hostHardwareOp(c),
  'host.network': (c) => hostNetworkOp(c),
  'host.wifi.scan': (c) => hostWifiScanOp(c),
  'host.wifi.join': (c, i) => hostWifiJoinOp(c, i),
  'host.wifi.forget': (c, i) => hostWifiForgetOp(c, i),
  // Wi-Fi only or the cable again, the servers moving with the box (network-move.md NM-01, NM-05).
  'host.cable.set': (c, i) => hostCableSetOp(c, i),
  // The box's Bluetooth, for the person (docs/decisions/bluetooth.md BT-02…BT-08; bluetooth-server.md BT-S03).
  'host.bluetooth': (c) => hostBluetoothOp(c),
  'host.bluetooth.scan': (c) => hostBluetoothScanOp(c),
  'host.bluetooth.pair': (c, i) => hostBluetoothPairOp(c, i),
  'host.bluetooth.confirm': (c, i) => hostBluetoothConfirmOp(c, i),
  'host.bluetooth.cancel': (c, i) => hostBluetoothCancelOp(c, i),
  'host.bluetooth.connect': (c, i) => hostBluetoothConnectOp(c, i),
  'host.bluetooth.disconnect': (c, i) => hostBluetoothDisconnectOp(c, i),
  'host.bluetooth.forget': (c, i) => hostBluetoothForgetOp(c, i),
};

/**
 * Session-native reads served only through an export stream (`open{export}`, `resources.ts`; desk-display-server.md
 * DK-S54): their answer is always larger than a session message, so a `request` for one is refused with
 * `use_export_stream` before it runs. Every other session-native op stays a `request` only (MR-19: backup and
 * recovery material are not exportable).
 */
export const SESSION_EXPORT_OPS: ReadonlySet<string> = new Set(['desk.voiceSample']);

/**
 * Session-native reads that stay a `request`, and come through an export stream too when the answer outgrows a session
 * message (`too_large`, `use_export_stream`): a screen's pictures (desk-display.md DK-142).
 */
export const SESSION_EXPORT_READS: ReadonlySet<string> = new Set(['screen.image']);

/** Begins whose nonce lives on the connection (PK-06; remote-help-server.md RH-S04): no receipt, never resent. */
const SESSION_BEGIN_OPS: ReadonlySet<string> = new Set([
  'passkey.register.begin',
  'remoteHelp.confirmBegin',
  'backup.passkeyKey.verifyBegin',
  'backup.passkeyKey.verifyConfirm',
]);

/**
 * Ephemeral ops on the enrollment channel (`enroll.claim.begin`, the screen sign-in's request and begin): no receipt,
 * never resent, but enrollment requests — the unenrolled budget applies, and not while the runtime drains (they
 * record attempts or put a code on the box's screen).
 */
const ENROLL_EPHEMERAL: ReadonlySet<string> = new Set([
  'enroll.claim.begin',
  // The claim on a box's own page: the start, the begin and the proofs keep session state only.
  'enroll.claim.local.start',
  'enroll.claim.local.begin',
  'enroll.claim.local.prove',
  'enroll.screen.request',
  'enroll.screen.begin',
  // A device becoming a screen (desk-display.md DK-146): its letters live in memory.
  'enroll.display.request',
]);

/**
 * A screen's lock and unlock (desk-display.md DK-138): memory only, so no receipt (a screen keeps none under the
 * person's account), never resent; the ephemeral budget.
 */
const SCREEN_EPHEMERAL: ReadonlySet<string> = new Set(['screen.unlock', 'screen.lock']);

/**
 * A screen's reads per key and minute: its page asks for its state every 3 to 10 seconds (sooner after a touch) and
 * loads its pictures, well within these; a page asking far more costs a refusal, not a resolve and a write each time.
 */
export const SCREEN_READS_PER_MINUTE: Readonly<Record<string, number>> = {
  'screen.state': 60,
  'screen.image': 300,
};

/**
 * The channel a session's principal may use: a screen's endpoint only `screen`, everyone else anything but it. The
 * allowlist decides first (`resolve`); every op runs past this again, so a way in that skipped `resolve` still can't
 * cross it.
 */
function checkChannel(spec: OperationSpec, principal: SessionPrincipal): void {
  if (isScreenSession(principal) !== (spec.channel === 'screen'))
    throw new SessionOpError('unknown_op', `No operation ${spec.op}.`);
}

/** The appliance's allowlist: the protocol's minus what this appliance also excludes. */
export function buildAllowlist(): OperationAllowlist {
  return createOperationAllowlist({ exclude: EXCLUDED });
}

/**
 * Runs an allowlisted `api` op's REST handler in-process as `account` (MR-05): the input guards, the same
 * `burrowAccess` membership check, the handler, and — outside production — its answer checked against the contract.
 * Refusals are thrown (`ApiError`, `OutcomeReply`). The session's `runApi` and tests' in-process caller share it.
 */
export async function runApiHandler(
  services: Services,
  def: RouteDef,
  op: string,
  account: RequestAuth['account'],
  input: { params: unknown; query?: unknown; body?: unknown },
): Promise<{ body: unknown; raw: Raw | null }> {
  const ep = def.endpoint;
  if (ep.auth === 'runner') throw new Error(`${ep.id} requires the runner's HTTP listener`);
  const guard = await managedInputGuard(services, op, input);
  if (guard) throw guard;
  if (!account) throw unauthorized();
  const auth: RequestAuth = { account };
  const params = (input.params ?? {}) as Record<string, unknown>;
  const access =
    typeof params.burrow === 'string'
      ? await burrowAccess(services, auth, params.burrow)
      : (undefined as unknown as BurrowAccess);
  const result = await def.handler({
    params: params as never,
    query: (input.query ?? {}) as never,
    body: input.body as never,
    auth,
    access,
    services,
  });
  if (result instanceof Raw) return { body: result.body, raw: result };
  if (services.config.NODE_ENV !== 'production') {
    const check = ep.response.safeParse(result);
    if (!check.success)
      throw new ApiError('internal', `Response for ${ep.id} does not match the contract.`, {
        details: { issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
      });
  }
  return { body: result, raw: null };
}

/**
 * Guards on op input a managed appliance refuses. Feedback intake runs through the encrypted drop (feedback-drop
 * FD-25, superseding MR-05's unconditional `setIntake` guard): refused only while the drop can't deliver.
 */
async function managedInputGuard(
  services: Services,
  op: string,
  input: { body?: unknown; params?: unknown },
): Promise<ApiError | null> {
  const body = (input.body ?? {}) as Record<string, unknown>;
  return feedbackIntakeGuard(services, op, body);
}

export interface SessionRequest {
  id: string;
  op: string;
  input: unknown;
}

/** What a request answers with. `accepted` precedes the result of a command once it committed. */
export interface RequestSink {
  accepted(at: Date): void;
  result(answer: RequestAnswer): void;
}

export type ErrorAnswer = {
  type: 'error';
  code: SessionErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
  fields?: Record<string, string[]>;
  replayed: boolean;
};

export type RequestAnswer =
  | { type: 'result'; kind: 'ok' | 'approval_required'; output: unknown; replayed: boolean }
  | ErrorAnswer
  /**
   * `outcome{state: completed, redacted: true}` (CT-195): the command committed, its result isn't kept — the process
   * that ran it died before storing it (CS-06), or its handler failed after the commit reading it back (CS-05).
   */
  | { type: 'redacted' };

/** Per-request control: cancellation before accept, and the deadline. */
export class RequestControl {
  cancelled = false;
  constructor(
    readonly deadlineAt: Date | null,
    /** The session's own state (the connection's), for ops that keep some (`enroll.claim.begin`). */
    readonly session: SessionScope | null = null,
  ) {}
}

export class DeadlineExceeded extends CommandStopped {
  constructor() {
    super('deadline exceeded before the command was accepted');
  }
}
export class CancelledBeforeAccept extends CommandStopped {
  constructor() {
    super('cancelled before the command was accepted');
  }
}

/** A per-endpoint token bucket for unenrolled sessions (`ENROLL_MAX_REQUESTS_PER_MINUTE`). */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (this.buckets.size > 10_000) this.buckets.clear();
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

export function errorOf(
  code: string,
  message: string,
  extra: { details?: unknown; fields?: Record<string, string[]> } = {},
): ErrorAnswer {
  const parsed = SessionErrorCodeSchema.safeParse(code);
  const c: SessionErrorCode = parsed.success ? parsed.data : 'internal';
  return {
    type: 'error',
    code: c,
    message: message.slice(0, 1000),
    retryable: RETRYABLE_ERROR_CODES.has(c),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.fields ? { fields: extra.fields } : {}),
    replayed: false,
  };
}

export function errorAnswer(err: unknown, services: Services): ErrorAnswer {
  if (err instanceof UnknownOutcomeError) return errorOf('unknown_outcome', err.message);
  if (err instanceof SessionOpError)
    return errorOf(err.code, err.message, err.details !== undefined ? { details: err.details } : {});
  // Without the runner's answer: not done (`unavailable`), or maybe done (`unknown_outcome`), CS-04b.
  if (err instanceof RunnerBridgeError)
    return errorOf(err.sessionCode, err.message, { details: err.toBody().error.details });
  if (err instanceof ApiError) {
    const body = err.toBody().error;
    return errorOf(body.code, body.message, {
      ...(body.details !== undefined ? { details: body.details } : {}),
      ...(body.fields ? { fields: body.fields } : {}),
    });
  }
  if (err instanceof DeadlineExceeded)
    return errorOf('deadline_exceeded', 'The deadline passed before it was accepted. Nothing was done.');
  if (err instanceof CancelledBeforeAccept)
    return errorOf('cancelled', 'Cancelled before it was accepted. Nothing was done.');
  if (sqlState(err) === '25006')
    return errorOf('unavailable', 'This appliance is read-only for now. Try again after the update.');
  // A failed database statement carries its values (a name, an email): only its class and error code are logged.
  services.log.error(errorForLog(err), 'session request failed');
  return errorOf('internal', 'Something went wrong on the appliance.');
}

function toOutcome(answer: RequestAnswer): CommandOutcome {
  if (answer.type === 'result') return { kind: 'result', resultKind: answer.kind, output: answer.output };
  if (answer.type === 'error') {
    const { type: _t, replayed: _r, ...rest } = answer;
    return { kind: 'error', ...rest };
  }
  return REDACTED_COMPLETION;
}

/**
 * Errors that mean reading a command's result back failed, not that a later step refused (CS-05): an unexpected failure
 * (`internal`, the contract check included) or the object it just wrote not found — and only while the command reads
 * its result back (CS-12: after a pipeline command committed `ok`, or a handler's `readingBack()`, with no write or
 * external effect since).
 */
const READ_BACK_FAILURES: ReadonlySet<string> = new Set(['internal', 'not_found']);

/**
 * The receipt principals of a session (CS-04): its account, then its pre-enrollment `peer:<peerId>`. A screen's session
 * has no account: it can never find the person's commands by their request ids.
 */
export function receiptPrincipals(principal: SessionPrincipal): string[] {
  const peer = `peer:${principal.peerId}`;
  return principal.account && !isScreenSession(principal) ? [principal.account.id, peer] : [peer];
}

/** A command's external effects so far (CS-01, CS-05). */
class Effects {
  private readonly list: { label: string; pins: boolean; state: 'running' | EffectEnd }[] = [];
  /** `pins`: a non-idempotent effect before the commit. */
  start(label: string, pins: boolean): void {
    this.list.push({ label, pins, state: 'running' });
  }
  end(label: string, end: EffectEnd): void {
    if (end === 'undone') {
      for (const e of this.list) if (e.label === label && e.state !== 'refused') e.state = 'undone';
      return;
    }
    const running = this.list.findLast((e) => e.label === label && e.state === 'running');
    if (running) running.state = end;
  }
  /** A pinning one is running or acted: the command is past its point of no return. */
  get mayHaveActed(): boolean {
    return this.list.some((e) => e.pins && (e.state === 'running' || e.state === 'acted'));
  }
}

export function fromOutcome(outcome: CommandOutcome, replayed: boolean): RequestAnswer {
  if (outcome.kind === 'result')
    return {
      type: 'result',
      kind: outcome.resultKind,
      output: outcome.redacted ? null : outcome.output,
      replayed,
    };
  const { kind: _k, ...rest } = outcome;
  return { type: 'error', ...(rest as Omit<ErrorAnswer, 'type' | 'replayed'>), replayed };
}

/** Errors a retry with the same request id should get again (the request itself was refused). */
export function isFinalError(code: string): boolean {
  return (
    !RETRYABLE_ERROR_CODES.has(code as SessionErrorCode) && !['deadline_exceeded', 'cancelled'].includes(code)
  );
}

export class SessionDispatcher {
  readonly allowlist: OperationAllowlist;
  /** The backup service's local API, when this appliance has one. */
  backup: BackupPort | undefined;
  /** The manager (a restore starts and ends through it; backup-options.md BKO-11). */
  manager: ManagerPort | undefined;
  /** Backup and update status the manager reported (`POST /facts`), and this runtime's identity. */
  facts: ApplianceFacts;
  private readonly routes: Map<string, RouteDef>;
  private readonly limiter: RateLimiter;
  /** Diagnostic bundles (the runtime sets them). */
  diagnostics: DiagnosticsService | undefined;
  /** The appliance licence (the runtime sets it). */
  licence: LicenceService | undefined;
  /** The manager's measurements of the box (the runtime sets them). */
  host: HostMetricsService | undefined;
  /** The box's hardware report and network (the runtime sets them). */
  hardware: HostHardwareService | undefined;
  network: HostNetworkService | undefined;
  /** The box's Bluetooth (the runtime sets it when there is a Bluetooth service). */
  bluetooth: HostBluetoothService | undefined;
  /** The desk screen (the boot sets it when the desk socket runs). */
  desk: DeskService | undefined;
  /** Screens elsewhere (the boot sets them with the desk, when the screens' store is there). */
  screens: ScreenSessions | undefined;
  /** Remote help (the runtime sets it when there is a support service). */
  remoteHelp: RemoteHelpService | undefined;
  /** Tailscale for This Whombat (the boot sets it). */
  tailscale: TailscaleService | undefined;
  /** Whombat Link and phones' push tokens (the runtime sets them). */
  link: LinkService | undefined;
  pushTokens: PushTokens | undefined;
  linkEmail: LinkEmail | undefined;
  private readonly ephemeralLimiter: RateLimiter;
  /** Per screen op of `SCREEN_READS_PER_MINUTE`, per key. */
  private readonly screenLimiters: ReadonlyMap<string, RateLimiter>;

  constructor(
    private readonly services: Services,
    private readonly trust: TrustService,
    private readonly receipts: CommandReceipts,
    routes: readonly RouteDef[] = ROUTES,
  ) {
    this.allowlist = buildAllowlist();
    const build = buildInfo();
    this.facts = {
      backup: null,
      update: null,
      appliance: {
        peerId: trust.appliancePeerId,
        runtimeVersion: build.version,
        schemaVersion: build.schema ? binarySchema().version : null,
        protocol: SESSION_PROTOCOL,
      },
    };
    this.routes = new Map(routes.filter((r) => r.stub === undefined).map((r) => [r.endpoint.id, r]));
    this.limiter = new RateLimiter(20, () => services.clock().getTime());
    this.ephemeralLimiter = new RateLimiter(EPHEMERAL_MAX_PER_MINUTE, () => services.clock().getTime());
    this.screenLimiters = new Map(
      Object.entries(SCREEN_READS_PER_MINUTE).map(([op, n]) => [
        op,
        new RateLimiter(n, () => services.clock().getTime()),
      ]),
    );
  }

  /** The op names this principal may call. */
  allowedOps(principal: SessionPrincipal): string[] {
    return this.allowlist.ops.filter((op) => this.allowlist.resolve(op, sessionOf(principal)).ok);
  }

  /** The spec of an op this principal may call, or the error to answer. */
  resolve(
    principal: SessionPrincipal,
    op: string,
  ): { ok: true; spec: OperationSpec } | { ok: false; answer: RequestAnswer } {
    const resolved = this.allowlist.resolve(op, sessionOf(principal));
    if (resolved.ok) return resolved;
    const denied = SESSION_DENIED[op];
    if (resolved.code === 'unknown_op' && denied && denied !== 'local')
      return { ok: false, answer: errorAnswer(managedRefusal(denied), this.services) };
    return {
      ok: false,
      answer: errorOf(
        resolved.code,
        resolved.code === 'enrollment_required'
          ? 'Enroll this device before using the appliance.'
          : `No operation ${op}.`,
      ),
    };
  }

  /** Runs one request and answers through `sink`. `control` lets the session cancel it before it is accepted. */
  async handle(
    principal: SessionPrincipal,
    request: SessionRequest,
    sink: RequestSink,
    control: RequestControl,
  ): Promise<void> {
    let answer: RequestAnswer;
    try {
      answer = await this.#handle(principal, request, sink, control);
    } catch (err) {
      answer = errorAnswer(err, this.services);
    }
    // Every refused passkey enrollment says why in the log (PK-D10): codes and fields only, no input.
    if (request.op === 'enroll.passkey' && answer.type === 'error')
      this.services.log.info(
        {
          code: answer.code,
          detail: (answer.details as { code?: unknown } | undefined)?.code ?? null,
          fields: answer.fields ? Object.keys(answer.fields) : null,
          message: answer.message.slice(0, 200),
          peer: principal.peerId.slice(-8),
        },
        'passkey: an enroll was refused',
      );
    sink.result(answer);
  }

  async #handle(
    principal: SessionPrincipal,
    request: SessionRequest,
    sink: RequestSink,
    control: RequestControl,
  ): Promise<RequestAnswer> {
    const resolved = this.resolve(principal, request.op);
    if (!resolved.ok) return resolved.answer;
    const spec = resolved.spec;
    if (ENROLL_EPHEMERAL.has(spec.op)) {
      // Ephemeral (no receipt, never resent), but an enrollment request: the unenrolled budget applies, and it
      // records an attempt (MR-26) or shows a code on the screen, so not while the runtime drains.
      if (!principal.endpoint && !this.limiter.take(principal.peerId))
        return errorOf('rate_limited', 'Too many requests. Wait a minute.');
      if (!(await this.services.maintenance.opened()))
        return errorOf('unavailable', 'The appliance is getting ready for an update. Try again in a moment.');
      return this.run(spec, principal, request.input, control.session);
    }
    if (SESSION_BEGIN_OPS.has(spec.op) || SCREEN_EPHEMERAL.has(spec.op)) {
      // Ephemeral (its nonce lives on this connection, PK-06, RH-S04; a screen's lock): no receipt, the ephemeral
      // budget.
      if (!this.ephemeralLimiter.take(principal.peerId))
        return errorOf('rate_limited', 'Too many requests. Wait a minute.');
      return this.run(spec, principal, request.input, control.session);
    }
    if (!principal.endpoint && !principal.assistant && !this.limiter.take(principal.peerId))
      return errorOf('rate_limited', 'Too many requests. Wait a minute.');
    // Both carry `details.code: use_export_stream` (MR-08, MD-14), as an answer too large for a message does: the
    // one code a client falls back on.
    if (spec.transfer === 'export')
      return errorOf('bad_request', `Open an export stream for ${spec.op}; its output is a file.`, {
        details: { code: 'use_export_stream' },
      });
    // A mutating op whose answer is an export (Test sign-in's screenshot; CT-125): only as a stream.
    if (spec.exportOp || (spec.source === 'session' && SESSION_EXPORT_OPS.has(spec.op)))
      return errorOf(
        'bad_request',
        `Open an export stream for ${spec.op}; its answer is larger than a message.`,
        { details: { code: 'use_export_stream' } },
      );
    if (control.deadlineAt && control.deadlineAt <= this.services.clock())
      return errorAnswer(new DeadlineExceeded(), this.services);
    if (!spec.mutating) return this.run(spec, principal, request.input, control.session);

    if (!(await this.services.maintenance.opened()))
      return errorOf('unavailable', 'The appliance is getting ready for an update. Try again in a moment.');
    // A request this device made before it was enrolled keeps its `peer:` receipt (CS-04) — only an op the enrollment
    // channel allows can have one, so only those look for it.
    const beforeEnrollment = this.allowlist.resolve(request.op, { enrolled: false }).ok;
    const key = await this.receipts.keyFor(
      beforeEnrollment ? receiptPrincipals(principal) : receiptPrincipals(principal).slice(0, 1),
      request.op,
      request.id,
    );
    let acceptedSent = false;
    const answer: ExecuteAnswer = await this.receipts.execute(
      key,
      // `secret` ops (an invite secret, a pairing code, a provider token, backup credentials …): the
      // receipt keeps neither a digest of the input nor the result (CT-44, MA-19f).
      receiptDigest(spec, request.input),
      { endpointId: principal.endpoint?.id ?? null, deadlineAt: control.deadlineAt, secret: spec.secret },
      async () => {
        const effects = new Effects();
        /** The command's result is decided and only read back since (CS-12). */
        let readBack = false;
        let deferredResult = false;
        /** A cancel or a passed deadline stops the command until it committed or acted outside the database. */
        const stopIfCancelled = () => {
          if (scope.accepted || effects.mayHaveActed) return;
          if (control.cancelled) throw new CancelledBeforeAccept();
          if (control.deadlineAt && control.deadlineAt <= this.services.clock()) throw new DeadlineExceeded();
        };
        const scope: CommandScope & { active: boolean; accepted: boolean } = {
          active: true,
          accepted: false,
          op: spec.op,
          beforeCommit: async (tx: Tx) => {
            // Past an external effect the commit records it, whatever happened to the request (CS-01).
            stopIfCancelled();
            await this.receipts.markAccepted(tx, key);
            if (deferredResult) await this.receipts.markPendingResult(tx, key);
          },
          afterCommit: () => {
            if (scope.accepted) return;
            scope.accepted = true;
            this.receipts.accepted(key);
          },
          beforeEffect: async (label, { idempotent }) => {
            readBack = false;
            if (scope.accepted) {
              effects.start(label, false);
              return;
            }
            if (idempotent) {
              effects.start(label, false);
              return;
            }
            // Nothing is started for a request already cancelled or past its deadline.
            stopIfCancelled();
            // Marked first: a mark that fails leaves nothing started (the effect doesn't run), CS-13.
            await this.receipts.markEffect(key, label);
            effects.start(label, true);
          },
          afterEffect: (label, end) => effects.end(label, end),
          beforeWrite: () => {
            readBack = false;
          },
          resultDecided: () => {
            readBack = true;
          },
          deferResult: () => {
            deferredResult = true;
            readBack = false;
          },
        };
        let result: RequestAnswer;
        try {
          result = await runInCommandScope(scope, () =>
            this.run(spec, principal, request.input, control.session),
          );
        } finally {
          scope.active = false;
        }
        if (!scope.accepted) {
          if (result.type === 'result') {
            // A command that wrote nothing through the pipeline: accepted as it finishes.
            scope.accepted = true;
            this.receipts.accepted(key);
            return { state: 'completed', outcome: toOutcome(result) };
          }
          if (effects.mayHaveActed) {
            // It acted outside the database and recorded nothing: an unknown outcome, never run again (CS-02).
            if (result.type === 'error' && result.code !== 'unknown_outcome')
              this.services.log.warn(
                { op: spec.op, code: result.code },
                'command failed after an external effect, before its commit',
              );
            return {
              state: 'rejected',
              outcome:
                result.type === 'error' && result.code === 'unknown_outcome'
                  ? toOutcome(result)
                  : unknownOutcome(),
            };
          }
          // Nothing committed: a refused input or permission (final for this id), or a cancel, deadline or
          // failure before commit (the same id may run again).
          const final = result.type === 'error' && isFinalError(result.code);
          return { state: final ? 'rejected' : 'not_executed', outcome: toOutcome(result) };
        }
        if (result.type === 'error' && READ_BACK_FAILURES.has(result.code) && readBack) {
          // Its writes landed; reading the result back failed: done, its answer isn't kept (CS-05).
          this.services.log.warn(
            { op: spec.op, code: result.code },
            'command committed, then failed reading its result',
          );
          return { state: 'completed', outcome: REDACTED_COMPLETION };
        }
        return { state: result.type === 'result' ? 'completed' : 'rejected', outcome: toOutcome(result) };
      },
      () => {
        if (acceptedSent) return;
        acceptedSent = true;
        sink.accepted(this.services.clock());
      },
    );
    if (answer.kind === 'mismatch')
      return errorOf('idempotency_mismatch', 'That request id was already used for a different request.');
    if (answer.outcome.kind === 'result' && answer.outcome.redacted) {
      // A retry of a finished secret op: its result wasn't kept (CT-44).
      if (spec.secret && answer.replayed)
        return errorOf(
          'unknown_outcome',
          'This was already done, and its answer isn’t kept because it held a secret. Check the current state, or do it again as a new request.',
        );
      // Committed, its result gone (CS-05, CS-06): done, check the current state.
      return { type: 'redacted' };
    }
    return fromOutcome(answer.outcome, answer.replayed);
  }

  /** Executes one op as the principal (no receipt): an allowlisted REST handler in-process, or an appliance op. */
  async run(
    spec: OperationSpec,
    principal: SessionPrincipal,
    rawInput: unknown,
    session: SessionScope | null = null,
  ): Promise<RequestAnswer> {
    try {
      // Nothing of the input is read for a session on the wrong channel.
      checkChannel(spec, principal);
      const parsed = spec.input.safeParse(rawInput ?? {});
      if (!parsed.success) throw validationError(parsed.error, 'The request input is not valid.');
      if (spec.source === 'session') {
        const output = await this.runSession(spec, principal, parsed.data, session);
        return { type: 'result', kind: 'ok', output, replayed: false };
      }
      const out = await this.runApi(
        spec,
        principal,
        parsed.data as { params: unknown; query?: unknown; body?: unknown },
      );
      return { type: 'result', kind: 'ok', output: out.body, replayed: false };
    } catch (err) {
      if (err instanceof OutcomeReply) {
        if (err.status === 202)
          return { type: 'result', kind: 'approval_required', output: err.body, replayed: false };
        const body = err.body as { error: { message: string }; keyNeeded?: unknown; eventId?: unknown };
        return errorOf('blocked', body.error.message, {
          details: { keyNeeded: body.keyNeeded, eventId: body.eventId },
        });
      }
      return errorAnswer(err, this.services);
    }
  }

  /**
   * Runs a session-native op's handler with its parsed input as the principal; refusals are thrown. Shared by requests
   * and export streams (`SESSION_EXPORT_OPS`).
   */
  async runSession(
    spec: OperationSpec,
    principal: SessionPrincipal,
    input: unknown,
    session: SessionScope | null = null,
  ): Promise<unknown> {
    checkChannel(spec, principal);
    // A screen's reads, as a request or an export stream alike.
    if (this.screenLimiters.get(spec.op)?.take(principal.peerId) === false)
      throw new SessionOpError('rate_limited', 'Too many requests. Wait a minute.');
    const handler =
      SESSION_HANDLERS[spec.op] ??
      BACKUP_HANDLERS[spec.op] ??
      BACKUP_OPTIONS_HANDLERS[spec.op] ??
      BACKUP_LOOK_HANDLERS[spec.op] ??
      BACKUP_KEY_HANDLERS[spec.op] ??
      BACKUP_PLACE_HANDLERS[spec.op] ??
      PROVIDER_SESSION_HANDLERS[spec.op] ??
      DISPLAY_SESSION_HANDLERS[spec.op] ??
      DESK_SESSION_HANDLERS[spec.op] ??
      VOICE_SESSION_HANDLERS[spec.op] ??
      REMOTE_HELP_SESSION_HANDLERS[spec.op] ??
      (DIRECT_SESSION_HANDLERS as Readonly<Record<string, SessionHandler>>)[spec.op] ??
      (UPDATE_ASK_SESSION_HANDLERS as Readonly<Record<string, SessionHandler>>)[spec.op] ??
      (LOCAL_SESSION_HANDLERS as Readonly<Record<string, SessionHandler>>)[spec.op] ??
      (OWN_ADDRESS_SESSION_HANDLERS as Readonly<Record<string, SessionHandler>>)[spec.op] ??
      (LINK_SESSION_HANDLERS as Readonly<Record<string, SessionHandler>>)[spec.op] ??
      (BOX_PASSKEY_SESSION_HANDLERS as Readonly<Record<string, SessionHandler>>)[spec.op];
    if (!handler) throw new ApiError('not_implemented', `${spec.op} isn’t available on this appliance yet.`);
    // A page the box serves can't run a passkey ceremony (direct-connection.md DC-11): say so rather than fail later.
    // A community box's passkeys work only on its Tailscale page while that has HTTPS (HE-S230).
    if (PAGE_PASSKEY_OPS.has(spec.op) && !passkeysWorkHere(session?.transport, this.trust.relyingParty()))
      throw passkeysUnavailableHere(this.trust.community);
    return handler(
      {
        principal,
        services: this.services,
        trust: this.trust,
        facts: this.facts,
        backup: this.backup,
        manager: this.manager,
        diagnostics: this.diagnostics,
        session,
        licence: this.licence,
        host: this.host,
        hardware: this.hardware,
        network: this.network,
        bluetooth: this.bluetooth,
        desk: this.desk,
        screens: this.screens,
        remoteHelp: this.remoteHelp,
        tailscale: this.tailscale,
        ownAddress: this.trust.ownAddress,
        link: this.link,
        pushTokens: this.pushTokens,
        linkEmail: this.linkEmail,
      },
      input,
    );
  }

  /**
   * Runs a REST handler with parsed `{params, query, body}` as the session's account. Returns the body (`raw` for
   * CSV and other non-JSON bodies) — shared by requests and export streams.
   */
  async runApi(
    spec: OperationSpec,
    principal: SessionPrincipal,
    input: { params: unknown; query?: unknown; body?: unknown },
  ): Promise<{ body: unknown; raw: Raw | null }> {
    checkChannel(spec, principal);
    const ep = spec.endpoint;
    const def = ep ? this.routes.get(ep.id) : undefined;
    if (!ep || !def)
      throw new ApiError('not_implemented', `${spec.op} isn’t available on this appliance yet.`);
    const out = await runApiHandler(this.services, def, spec.op, principal.account, input);
    // An older app gets what its contracts read (`automations/older-apps.ts`).
    return out.raw ? out : { ...out, body: answerFor(ep.id, out.body, principal.protocolMinor) };
  }

  /**
   * Runs one op for the assistant acting for `account` (docs/decisions/assistant-settings.md): the same request path as
   * the person's device (receipt, drain, the handler, the commit pipeline), only for an op the settings map lets the
   * assistant read or change with this input (a guarded part, like a connection's address, stays the person's). The
   * settings tools decide whether it may (the key, the person's yes) before calling this.
   */
  async runForAssistant(
    account: NonNullable<SessionPrincipal['account']>,
    agentId: string,
    op: string,
    input: unknown,
    deadlineMs = 60_000,
  ): Promise<RequestAnswer> {
    const access = assistantAccessFor(op, input);
    if (access !== 'read' && access !== 'change' && access !== 'ask')
      return errorOf('forbidden', `${op} isn’t the assistant’s to run.`);
    let answer: RequestAnswer | null = null;
    // What the op records may say the assistant asked (a changed setting, service-settings.md SST-04).
    await forAssistant(agentId, () =>
      this.handle(
        assistantPrincipal(account, agentId),
        { id: newId('event'), op, input },
        { accepted: () => {}, result: (a) => (answer = a) },
        new RequestControl(new Date(this.services.clock().getTime() + deadlineMs)),
      ),
    );
    return answer ?? errorOf('internal', 'No answer.');
  }

  /** `status{id}` for an ambiguous outcome; an enrolled device also finds what it asked before (CS-04). */
  status(principal: SessionPrincipal, requestId: string) {
    return this.receipts.status(receiptPrincipals(principal), requestId);
  }
}
