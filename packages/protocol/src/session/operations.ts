/**
 * The typed operation allowlist (MA-08): `request.op` names either an existing REST contract as
 * `<area>.<action>` — the key path of `api.<area>.<action>` in `@whombat/core/contracts` — or a session-native
 * operation (enrollment, recovery, endpoint trust). Specs are derived from the contracts, never copied: an
 * `api` operation's input is `{params, query, body}` validated by the endpoint's own schemas, and its output
 * is the endpoint's `response` schema.
 */
import { type AnyEndpoint, ApprovalRequiredBody, api } from '@whombat/core/contracts';
import {
  DeskCatalog,
  DeskPreview,
  DeskScreen,
  DeskScreenDetail,
  DeskScreensList,
  VoiceTyping,
} from '@whombat/core/domain';
import { z } from 'zod';
import {
  BackupConfigureDestinationInput,
  BackupConfigureDestinationOutput,
  BackupRecoveryMaterial,
  BackupRecoveryMaterialInput,
  BackupRunNowInput,
  BackupRunNowOutput,
  BackupSshPublicKey,
  BackupSshPublicKeyInput,
  BackupStatusInput,
  BackupStatusOutput,
} from './backup.js';
import {
  BackupLookBringInput,
  BackupLookBringOutput,
  BackupLookCloseInput,
  BackupLookCloseOutput,
  BackupLookContentsInput,
  BackupLookContentsOutput,
  BackupLookInput,
  BackupLookOutput,
} from './backup-look.js';
import {
  BackupAdoptInput,
  BackupAdoptOutput,
  BackupCheckInput,
  BackupCheckOutput,
  BackupCheckpointsInput,
  BackupCheckpointsOutput,
  BackupFinishRestoreInput,
  BackupFinishRestoreOutput,
  BackupLetAssistantSetUpInput,
  BackupLetAssistantSetUpOutput,
  BackupMoveLocalInput,
  BackupMoveLocalOutput,
  BackupOverviewInput,
  BackupOverviewOutput,
  BackupPolicyInput,
  BackupPolicyOutput,
  BackupRemoveLocalInput,
  BackupRemoveLocalOutput,
  BackupRestoreInput,
  BackupRestoreOutput,
  BackupRestoreStateInput,
  BackupRestoreStateOutput,
  BackupSetPolicyInput,
  BackupSetPolicyOutput,
} from './backup-options.js';
import {
  BackupFindKitsInput,
  BackupFindKitsOutput,
  BackupPaperCopyConfirmInput,
  BackupPaperCopyConfirmOutput,
  BackupPasskeyKeyOutput,
  BackupPasskeyKeyRemoveInput,
  BackupPasskeyKeySetInput,
  BackupPasskeyVerifyBeginInput,
  BackupPasskeyVerifyBeginOutput,
  BackupPasskeyVerifyConfirmInput,
} from './backup-passkey.js';
import {
  BackupForgetPlaceInput,
  BackupForgetPlaceOutput,
  BackupPlaceByHandInput,
  BackupPlaceByHandOutput,
  BackupPlaceCheckInput,
  BackupPlaceCheckOutput,
  BackupPlacesInput,
  BackupPlacesOutput,
  BackupUsePlaceInput,
  BackupUsePlaceOutput,
} from './backup-places.js';
import {
  HostBluetoothCancelInput,
  HostBluetoothConfirmInput,
  HostBluetoothDeviceInput,
  HostBluetoothDeviceOutput,
  HostBluetoothInput,
  HostBluetoothOutput,
  HostBluetoothPairingOutput,
  HostBluetoothScanInput,
  HostBluetoothScanOutput,
} from './bluetooth.js';
import {
  BoxPasskeyEnrollBeginInput,
  BoxPasskeyEnrollBeginOutput,
  BoxPasskeyEnrollInput,
  BoxPasskeyRegisterBeginInput,
  BoxPasskeyRegisterBeginOutput,
  BoxPasskeyRegisterInput,
} from './box-passkeys.js';
import { requestDigest } from './commands.js';
import {
  DeskAnswerUnlockInput,
  DeskAnswerUnlockOutput,
  DeskGetInput,
  DeskPairInput,
  DeskPreviewInput,
  DeskSetNameInput,
  DeskSetPinInput,
  DeskSetScreenInput,
  DeskStartPairingInput,
  DeskStartPairingOutput,
  DeskTryOnScreenInput,
  DeskTryOnScreenOutput,
  DeskUnpairInput,
  DeskUpdateInput,
  DeskVoiceSample,
  DeskVoiceSampleInput,
} from './desk.js';
import {
  DeskScreenAddInput,
  DeskScreenGetInput,
  DeskScreenRemoveInput,
  DeskScreensInput,
  DeskScreenTryInput,
  DeskScreenTryOutput,
  DeskScreenUpdateInput,
  DeskScreenViews,
  DeskScreenViewsInput,
  DeskWidgetsInput,
  EnrollDisplayRequestInput,
  EnrollDisplayRequestOutput,
  EnrollDisplayStatusInput,
  EnrollDisplayStatusOutput,
  ScreenImage,
  ScreenImageInput,
  ScreenLock,
  ScreenLockInput,
  ScreenStateInput,
  ScreenStateOutput,
  ScreenUnlockInput,
} from './desk-screens.js';
import {
  DiagnosticBundle,
  DiagnosticsCreateInput,
  DiagnosticsCreateOutput,
  DiagnosticsDeleteOutput,
  DiagnosticsDownloadInput,
  DiagnosticsListInput,
  DiagnosticsListOutput,
  DiagnosticsPreviewOutput,
  DiagnosticsRefInput,
} from './diagnostics.js';
import {
  ApplianceStatusInput,
  ApplianceStatusOutput,
  ApplianceUpdateAskInput,
  ApplianceUpdateAskOutput,
  ApplianceUpdateInstallInput,
  ApplianceUpdateInstallOutput,
  EndpointsListInput,
  EndpointsListOutput,
  EndpointsRenameInput,
  EndpointsRevokeInput,
  EndpointsRevokeOutput,
  EnrollClaimBeginInput,
  EnrollClaimBeginOutput,
  EnrollClaimInput,
  EnrollClaimLocalBeginInput,
  EnrollClaimLocalBeginOutput,
  EnrollClaimLocalInput,
  EnrollClaimLocalProveInput,
  EnrollClaimLocalProveOutput,
  EnrollClaimLocalStartInput,
  EnrollClaimLocalStartOutput,
  EnrollClaimOutput,
  EnrollDevInput,
  EnrolledOutput,
  EnrollLinkAcceptInput,
  EnrollLinkCreateInput,
  EnrollLinkCreateOutput,
  EnrollPairApproveInput,
  EnrollPairApproveOutput,
  EnrollPairLookupInput,
  EnrollPairLookupOutput,
  EnrollPairRequestInput,
  EnrollPairRequestOutput,
  EnrollPairStatusInput,
  EnrollPairStatusOutput,
  EnrollScreenBeginInput,
  EnrollScreenBeginOutput,
  EnrollScreenInput,
  EnrollScreenOutput,
  EnrollScreenRequestInput,
  EnrollScreenRequestOutput,
  OkOutput,
  PushHandlesClearInput,
  PushHandlesSetInput,
  PushResolveInput,
  PushResolveOutput,
  RecoveryEnrollInput,
  RecoveryKitConfirmInput,
  RecoveryKitConfirmOutput,
  RecoveryKitRegisterInput,
  RecoveryKitRegisterOutput,
  RecoveryKitRotateInput,
} from './enrollment.js';
import { HostHardwareInput, HostHardwareOutput } from './hardware.js';
import { HostMetricsInput, HostMetricsOutput } from './host.js';
import {
  LicenceRefreshInput,
  LicenceRefreshOutput,
  LicenceStatusInput,
  LicenceStatusOutput,
} from './licence.js';
import {
  HostMailInput,
  HostMailOutput,
  HostMailRemoveInput,
  HostMailSetInput,
  HostMailTestInput,
  HostMailTestOutput,
} from './mail.js';
import {
  HostCableChangeOutput,
  HostCableSetInput,
  HostNetworkInput,
  HostNetworkOutput,
  HostWifiChangeOutput,
  HostWifiForgetInput,
  HostWifiJoinInput,
  HostWifiScanInput,
  HostWifiScanOutput,
} from './network.js';
import { type OperationRetry, type OperationSafety, operationSafety } from './operation-safety.js';
import {
  AccountLinkInput,
  AccountLinkLookupInput,
  AccountLinkLookupOutput,
  AccountLinkOutput,
  OwnAddressReachSetInput,
  OwnAddressReachSetOutput,
  OwnAddressStatusInput,
  OwnAddressStatusOutput,
} from './own-address.js';
import {
  EnrollPasskeyInput,
  PasskeyLinkInput,
  PasskeyRegisterBeginInput,
  PasskeyRegisterBeginOutput,
  PasskeyRegisterInput,
  PasskeyRegisterOutput,
  PasskeyRemoveInput,
  PasskeysListInput,
  PasskeysListOutput,
  PasskeysPolicyInput,
} from './passkeys.js';
import {
  LinkMailSetInput,
  LinkOffInput,
  LinkOnInput,
  LinkOutput,
  LinkWhombatsInput,
  LinkWhombatsOutput,
  PushTokenClearInput,
  PushTokenSetInput,
  PushTokenSetOutput,
  ReachGetInput,
  ReachGetOutput,
  UpdatesChannelGetInput,
  UpdatesChannelOutput,
  UpdatesChannelSetInput,
} from './reach.js';
import {
  RemoteHelpConfirmBeginInput,
  RemoteHelpConfirmBeginOutput,
  RemoteHelpGetInput,
  RemoteHelpStartInput,
  RemoteHelpState,
  RemoteHelpStopInput,
  RemoteHelpTranscript,
  RemoteHelpTranscriptInput,
  RemoteHelpVisitsInput,
  RemoteHelpVisitsOutput,
} from './remote-help.js';
import {
  HostTailscaleChangeOutput,
  HostTailscaleInput,
  HostTailscaleOffInput,
  HostTailscaleOnInput,
  HostTailscaleOutput,
  HostTailscaleSignInInput,
} from './tailscale.js';
import { VoiceDutchInput, VoiceGetInput, VoiceModelInput, VoiceUpdateInput } from './voice.js';

type Api = typeof api;
/** `burrows.list`, `messages.send`, … — every `api.<area>.<action>`. */
export type ApiOpName = { [A in keyof Api]: `${A & string}.${keyof Api[A] & string}` }[keyof Api];
/** The endpoint behind an `ApiOpName`. */
export type ApiOpEndpoint<Op extends ApiOpName> =
  Op extends `${infer A extends keyof Api & string}.${infer K}`
    ? K extends keyof Api[A]
      ? Api[A][K]
      : never
    : never;

/**
 * Who may call an operation:
 * - `app`: enrolled endpoints (the normal case; the keys engine decides the rest);
 * - `enroll`: also unenrolled endpoints (claim, pairing, device links, recovery, passkeys, the box's screen), rate- and
 *   size-bounded.
 * - `screen` (3.6): only a screen's endpoint (a tablet or computer that became a screen, Whombat DK-146), and nothing
 *   else is open to it.
 */
export type OperationChannel = 'app' | 'enroll' | 'screen';

export interface OperationSpec {
  op: string;
  source: 'api' | 'session';
  input: z.ZodType;
  output: z.ZodType;
  /** Writes (commits through the pipeline); the appliance answers `accepted` after the commit. */
  mutating: boolean;
  channel: OperationChannel;
  /** `export`: the output is bytes, not JSON (it can only be read through an `export` stream). */
  transfer: 'none' | 'export';
  /**
   * Readable through `open{spec: {kind: 'export', op, input}}`: every non-mutating op (its `result` streamed as
   * bytes, e.g. when it would exceed 64 KiB) and the `exportOp`s.
   */
  exportable: boolean;
  /** A mutating op that produces an export (`diagnostics.download`); only as an export stream. */
  exportOp: boolean;
  /**
   * Ephemeral (`enroll.claim.begin`, `enroll.screen.request`, `enroll.screen.begin`, …): no durable
   * effect, so no `accepted`, no receipt and no idempotency; never queued or resent by clients; rate-limited
   * (`EPHEMERAL_MAX_PER_MINUTE`, and on the enrollment channel also the unenrolled budget).
   */
  ephemeral: boolean;
  /**
   * The input or the result carries a secret (CT-44, MA-19f): the receipt keeps neither an input digest
   * (`receiptDigest` covers the op only) nor the result (`{state, kind}` only); nothing of either is logged. A retry
   * with the same request id after a lost answer gets `error{code: 'unknown_outcome'}` (never the stored result) and
   * the client asks `status` — `outcome{redacted: true}` — then fetches state or repeats the op with a new id.
   */
  secret: boolean;
  /**
   * Irreversible or high-impact (CT-194, `OPERATION_SAFETY`): a merge, a removal, a revocation, a decision. A client
   * never sends it again by itself after an ambiguous delivery, whatever `retry` says; a person decides.
   */
  destructive: boolean;
  /**
   * What makes asking again after a lost answer safe (CT-194, `OperationRetry`): `safe` (nothing durable happens),
   * `receipt` (the same request may be resent after `status` answered `not_found`, if it was never acknowledged) or
   * `never`. Client-local advice
   * taken from `OPERATION_SAFETY`: never sent, never authorization, and it makes nothing idempotent — the runtime's
   * receipts do that.
   */
  retry: OperationRetry;
  /** The REST contract, for `api` operations. */
  endpoint?: AnyEndpoint;
}

/**
 * An op's classification (`OPERATION_SAFETY`, CT-194). One the table lacks — impossible past typecheck, which requires
 * an entry per op — counts as a read when it doesn't mutate and as a mutation never resent when it does.
 */
function safetyOf(op: string, mutating: boolean): OperationSafety {
  return operationSafety(op) ?? { destructive: false, retry: mutating ? 'never' : 'safe' };
}

/** Input of an `api` operation: the endpoint's params, query and body. */
export function apiOperationInput(endpoint: AnyEndpoint) {
  return z.strictObject({
    params: endpoint.params.prefault({}),
    query: endpoint.query.prefault({}),
    // A body that accepts `undefined` (GET/DELETE: `NoBody`) may be absent from the JSON.
    body: endpoint.body.safeParse(undefined).success ? endpoint.body.optional() : endpoint.body,
  });
}

export type ApiOperationInput<Op extends ApiOpName> = {
  params: z.input<ApiOpEndpoint<Op>['params']>;
  query?: z.input<ApiOpEndpoint<Op>['query']>;
  body?: z.input<ApiOpEndpoint<Op>['body']>;
};

/**
 * `api` ops whose input or result carries a secret (CT-44): connector app secrets, tokens; provider keys
 * and device codes, and the sign-in console's input and output, which may carry what a person typed (CT-70, CT-71);
 * a guide form's values (the Google client secret) and Google's authorization code (CT-81); a Vault entry's secret as
 * it is added or replaced (0.14, vault.md VT-58) and an SSH private key as it is imported to replace one (0.32,
 * VT-S03; an import at create is `vault.create`); an automation's new webhook secret, shown once (0.29.1, CT-195 —
 * managed runtimes refuse `automations.webhook` over a session, so this only keeps a future one from storing it); a
 * backup file's password (0.79, CT-335); a server's password as Whombat signs in to it once to install its agent
 * (0.85, CT-377).
 */
export const SECRET_API_OPS: readonly string[] = [
  'vault.create',
  'vault.setSecret',
  'vault.replaceSshKey',
  // 3.14 (Whombat vault-simplify.md): a website login's authenticator key as it is set.
  'vault.setTotp',
  'connectors.setMicrosoftApp',
  'connections.finishMicrosoft',
  'connectors.setGoogleApp',
  'connections.finishGoogle',
  // 0.48 (Whombat connections-catalog.md CX-16, CT-272): a connection's token as it is added or replaced, an OAuth
  // code, and an `app_oauth` entry's client secret.
  'connections.create',
  'connections.setSecret',
  'connections.finishOAuth',
  'connectors.setApp',
  // 0.97 (CT-483, Whombat connections-more.md CM-20): a mailbox's password as it is connected over IMAP and SMTP.
  'connectors.imapConnect',
  'guides.act',
  'canvases.collabToken',
  'devices.register',
  'devices.update',
  'signins.loginStart',
  'signins.loginSubmit',
  'signins.orgLoginStart',
  'signins.consoleRead',
  'signins.consoleWrite',
  'automations.webhook',
  // 0.79 (CT-335, Whombat backup-file.md BF-06): a backup file's password, as the file is made, opened and restored.
  'backups.create',
  'backups.inspect',
  'backups.restore',
  // 0.80 (CT-339): a server's install command carries its one-time enrollment token; a console session its token.
  'hosts.createEnrollment',
  'hosts.createConsole',
  // 0.85 (CT-377, Whombat server-signin.md SI-03): the password of a server Whombat signs in to once.
  'hosts.startInstall',
  // A Mac's password for its screen, as it is set on the Mac (Whombat macos-servers.md).
  'hosts.screen',
  // 0.124 (CT-1171): the API key of the model on the person's network, as it is set and as a draft is tested.
  'burrows.setLocalModel',
  'burrows.testLocalModel',
  // The Brave Search key for the agent's web search (Whombat web-search.md).
  'burrows.setWebSearch',
];

/**
 * Mutating `api` ops whose output is an export (read only through an export stream). None since 2.0 (CT-1418): Add
 * skills' preview (`skills.importPreview`, 0.125–1.1, CT-1217) went with imports, and Hermes's hub preview
 * (`skills.hubPreview`) is a read. Test sign-in (`vault.testSignIn`) was one until it went with Whombat's browser
 * (CT-1235), `packs.export` until 0.113 (CT-817). The mechanism stays for the next one.
 */
export const EXPORT_OPS: readonly string[] = [];

/**
 * Reads whose answer can be larger than one CONTROL message (`SESSION_MAX_RESULT_BYTES`, 64 KiB; 2.0, CT-1418): a client
 * reads them through an export stream (`open{spec: {kind: 'export', op, input}}`, as any read may be) from the start,
 * instead of asking and getting `too_large` / `use_export_stream`. Settings → Skills: the library (a Whombat's list was
 * 71.5 KB), one skill's text (Hermes's `SKILL.md` goes to 100,000 characters), one of its files, a hub search (50
 * results) and a hub preview (a `SKILL.md` and up to 50 findings). Every other skills op answers one row or less. A
 * Mac's screenshot (`hosts.screenLook`) too, Find My's maps and a Find My timeline.
 */
export const EXPORT_READ_OPS: readonly string[] = [
  // A Mac's screenshot (Whombat macos-servers.md): hundreds of kilobytes.
  'hosts.screenLook',
  // Find My on a Mac's page: the Mac's map picture and Find My's own map of one person.
  'hosts.findMyMap',
  'hosts.findMyPicture',
  // A Find My timeline: a week of several people's days, and the Mac's map of one person's day.
  'connections.findMyTimeline',
  'connections.findMyTimelineMap',
  'skills.library',
  'skills.librarySkill',
  'skills.librarySkillFile',
  'skills.hubSearch',
  'skills.hubPreview',
];

function apiSpec(op: string, endpoint: AnyEndpoint): OperationSpec {
  const mutating = endpoint.method !== 'GET';
  const exportOp = EXPORT_OPS.includes(op);
  return {
    op,
    source: 'api',
    input: apiOperationInput(endpoint),
    // Mutations through the keys engine may also answer 202 (`result.kind: approval_required`).
    output: endpoint.response,
    mutating,
    channel: 'app',
    transfer: endpoint.contentType === 'application/json' ? 'none' : 'export',
    exportable: !mutating || exportOp,
    exportOp,
    ephemeral: false,
    secret: SECRET_API_OPS.includes(op),
    ...safetyOf(op, mutating),
    endpoint,
  };
}

/** Every `api.<area>.<action>` as an operation spec (derived from `@whombat/core/contracts`). */
export const API_OPERATIONS: ReadonlyMap<string, OperationSpec> = new Map(
  Object.entries(api as unknown as Record<string, Record<string, AnyEndpoint>>).flatMap(([area, group]) =>
    Object.entries(group).map(([action, endpoint]) => {
      const op = `${area}.${action}`;
      return [op, apiSpec(op, endpoint)] as const;
    }),
  ),
);

/** A session-native operation's spec; `op` stays a literal, so `SessionOpName` names every one of them. */
const session = <const Op extends string>(
  op: Op,
  input: z.ZodType,
  output: z.ZodType,
  channel: OperationChannel,
  mutating = true,
  ephemeral = false,
  secret = false,
): OperationSpec & { op: Op } => ({
  op,
  source: 'session',
  input,
  output,
  mutating,
  channel,
  transfer: 'none',
  exportable: !mutating && !ephemeral,
  exportOp: false,
  ephemeral,
  secret,
  ...safetyOf(op, mutating),
});

/** A session-native export op: mutating (audited), read only through an export stream, never as a `request`. */
const sessionExport = <const Op extends string>(
  op: Op,
  input: z.ZodType,
  output: z.ZodType,
): OperationSpec & { op: Op } => ({
  ...session(op, input, output, 'app'),
  transfer: 'export',
  exportable: true,
  exportOp: true,
});

const SESSION_SPECS = [
  // The claim PAKE (CC-07, CT-61): `begin` is ephemeral (session state only), `enroll.claim` commits the person.
  session('enroll.claim.begin', EnrollClaimBeginInput, EnrollClaimBeginOutput, 'enroll', true, true),
  session('enroll.claim', EnrollClaimInput, EnrollClaimOutput, 'enroll'),
  // The claim on the box's own page: a box claimed on its own pages only. `start`, `begin`
  // and `prove` are ephemeral (session state only), `enroll.claim.local` commits the person like `enroll.claim`.
  session(
    'enroll.claim.local.start',
    EnrollClaimLocalStartInput,
    EnrollClaimLocalStartOutput,
    'enroll',
    true,
    true,
  ),
  session(
    'enroll.claim.local.begin',
    EnrollClaimLocalBeginInput,
    EnrollClaimLocalBeginOutput,
    'enroll',
    true,
    true,
  ),
  session(
    'enroll.claim.local.prove',
    EnrollClaimLocalProveInput,
    EnrollClaimLocalProveOutput,
    'enroll',
    true,
    true,
  ),
  session('enroll.claim.local', EnrollClaimLocalInput, EnrolledOutput, 'enroll'),
  session(
    'enroll.pair.request',
    EnrollPairRequestInput,
    EnrollPairRequestOutput,
    'enroll',
    true,
    false,
    true,
  ),
  session('enroll.pair.status', EnrollPairStatusInput, EnrollPairStatusOutput, 'enroll', false),
  session('enroll.pair.lookup', EnrollPairLookupInput, EnrollPairLookupOutput, 'app', false),
  session('enroll.pair.approve', EnrollPairApproveInput, EnrollPairApproveOutput, 'app'),
  session(
    'recovery.kit.register',
    RecoveryKitRegisterInput,
    RecoveryKitRegisterOutput,
    'app',
    true,
    false,
    true,
  ),
  session('recovery.kit.rotate', RecoveryKitRotateInput, RecoveryKitRegisterOutput, 'app', true, false, true),
  session('recovery.kit.confirm', RecoveryKitConfirmInput, RecoveryKitConfirmOutput, 'app'),
  session('recovery.enroll', RecoveryEnrollInput, EnrolledOutput, 'enroll'),
  // Adding a device of your own by a link or QR code (1.1, CT-1305; Whombat HE-60): both carry the one-time secret.
  session('enroll.link.create', EnrollLinkCreateInput, EnrollLinkCreateOutput, 'app', true, false, true),
  session('enroll.link.accept', EnrollLinkAcceptInput, EnrolledOutput, 'enroll', true, false, true),
  // Passkeys that open the Whombat (0.50, CT-281): the Whombat verifies them itself. `begin` is ephemeral (session
  // state only, like `enroll.claim.begin`).
  session('enroll.passkey', EnrollPasskeyInput, EnrolledOutput, 'enroll'),
  session('passkey.register.begin', PasskeyRegisterBeginInput, PasskeyRegisterBeginOutput, 'app', true, true),
  session('passkey.link', PasskeyLinkInput, PasskeyRegisterOutput, 'app'),
  session('passkey.register', PasskeyRegisterInput, PasskeyRegisterOutput, 'app'),
  session('passkeys.list', PasskeysListInput, PasskeysListOutput, 'app', false),
  session('passkey.remove', PasskeyRemoveInput, OkOutput, 'app'),
  session('passkeys.policy', PasskeysPolicyInput, OkOutput, 'app'),
  // Box passkeys (4.3; Whombat own-address.md): RP ID the box's own host, nonces the box's own. The begins are ephemeral
  // (session state only); joining works on any session, before enrolment too.
  session(
    'boxPasskey.enroll.begin',
    BoxPasskeyEnrollBeginInput,
    BoxPasskeyEnrollBeginOutput,
    'enroll',
    true,
    true,
  ),
  session('boxPasskey.enroll', BoxPasskeyEnrollInput, EnrolledOutput, 'enroll'),
  session(
    'boxPasskey.register.begin',
    BoxPasskeyRegisterBeginInput,
    BoxPasskeyRegisterBeginOutput,
    'app',
    true,
    true,
  ),
  session('boxPasskey.register', BoxPasskeyRegisterInput, PasskeyRegisterOutput, 'app'),
  // The box's own address (4.3): its state, the owner's switch, and linking the box to the person's account by a code.
  session('ownAddress.status', OwnAddressStatusInput, OwnAddressStatusOutput, 'app', false),
  session('ownAddress.reach.set', OwnAddressReachSetInput, OwnAddressReachSetOutput, 'app'),
  session('account.link.lookup', AccountLinkLookupInput, AccountLinkLookupOutput, 'app', false),
  session('account.link', AccountLinkInput, AccountLinkOutput, 'app'),
  // Sign in at the box's screen (0.106, CT-622): the request and the begin are ephemeral (memory only, like
  // `enroll.claim.begin`), `enroll.screen` lets the device in like `enroll.claim`.
  session('enroll.screen.request', EnrollScreenRequestInput, EnrollScreenRequestOutput, 'enroll', true, true),
  session('enroll.screen.begin', EnrollScreenBeginInput, EnrollScreenBeginOutput, 'enroll', true, true),
  session('enroll.screen', EnrollScreenInput, EnrollScreenOutput, 'enroll'),
  // Development enrolment (1.0, CT-1257; Whombat HE-49): a development runtime only, from the machine itself.
  session('enroll.dev', EnrollDevInput, EnrolledOutput, 'enroll'),
  session('endpoints.list', EndpointsListInput, EndpointsListOutput, 'app', false),
  session('endpoints.rename', EndpointsRenameInput, OkOutput, 'app'),
  session('endpoints.revoke', EndpointsRevokeInput, EndpointsRevokeOutput, 'app'),
  session('push.handles.set', PushHandlesSetInput, OkOutput, 'app'),
  session('push.handles.clear', PushHandlesClearInput, OkOutput, 'app'),
  session('push.resolve', PushResolveInput, PushResolveOutput, 'app', false),
  session('appliance.status', ApplianceStatusInput, ApplianceStatusOutput, 'app', false),
  // “Ask before updating” and the owner's approval of the update waiting for them (4.2; Whombat
  // ask-before-updating.md): the box's manager keeps the setting and holds the update until it is approved.
  session('appliance.update.ask', ApplianceUpdateAskInput, ApplianceUpdateAskOutput, 'app'),
  session('appliance.update.install', ApplianceUpdateInstallInput, ApplianceUpdateInstallOutput, 'app'),
  // Reach and Updates (4.4; Whombat whombat-link.md): how the box is reached, Whombat Link on or off, the update
  // channel, and a phone's push token registered through the box.
  session('reach.get', ReachGetInput, ReachGetOutput, 'app', false),
  session('link.on', LinkOnInput, LinkOutput, 'app'),
  session('link.off', LinkOffInput, LinkOutput, 'app'),
  // The owner's choices for email through Whombat Link (4.15).
  session('link.mail.set', LinkMailSetInput, LinkOutput, 'app'),
  // The account's other Whombats, for the menu under the box's name (4.14).
  session('link.whombats', LinkWhombatsInput, LinkWhombatsOutput, 'app', false),
  session('updates.channel.get', UpdatesChannelGetInput, UpdatesChannelOutput, 'app', false),
  session('updates.channel.set', UpdatesChannelSetInput, UpdatesChannelOutput, 'app'),
  session('push.token.set', PushTokenSetInput, PushTokenSetOutput, 'app'),
  session('push.token.clear', PushTokenClearInput, OkOutput, 'app'),
  // How the box is doing (CT-334, Whombat box-status.md BS-01): the manager's measurements.
  session('host.metrics', HostMetricsInput, HostMetricsOutput, 'app', false),
  // The box's hardware and network (0.102, CT-563, CT-568; Whombat hardware-support.md HD-03, HD-06): the
  // manager's report and its guarded Wi-Fi changes. A join carries the passphrase: secret (CT-44).
  session('host.hardware', HostHardwareInput, HostHardwareOutput, 'app', false),
  session('host.network', HostNetworkInput, HostNetworkOutput, 'app', false),
  session('host.wifi.scan', HostWifiScanInput, HostWifiScanOutput, 'app', false),
  session('host.wifi.join', HostWifiJoinInput, HostWifiChangeOutput, 'app', true, false, true),
  session('host.wifi.forget', HostWifiForgetInput, HostWifiChangeOutput, 'app'),
  // Wi-Fi only, or the cable again (3.13, CT-1642; network-move.md NM-01).
  session('host.cable.set', HostCableSetInput, HostCableChangeOutput, 'app'),
  // The box's Bluetooth (0.109, CT-676; Whombat bluetooth.md BT-02…BT-05): the Bluetooth service's state,
  // looking, the one pairing and the paired devices.
  session('host.bluetooth', HostBluetoothInput, HostBluetoothOutput, 'app', false),
  session('host.bluetooth.scan', HostBluetoothScanInput, HostBluetoothScanOutput, 'app', false),
  session('host.bluetooth.pair', HostBluetoothDeviceInput, HostBluetoothPairingOutput, 'app'),
  session('host.bluetooth.confirm', HostBluetoothConfirmInput, HostBluetoothPairingOutput, 'app'),
  session('host.bluetooth.cancel', HostBluetoothCancelInput, HostBluetoothPairingOutput, 'app'),
  session('host.bluetooth.connect', HostBluetoothDeviceInput, HostBluetoothDeviceOutput, 'app'),
  session('host.bluetooth.disconnect', HostBluetoothDeviceInput, HostBluetoothDeviceOutput, 'app'),
  session('host.bluetooth.forget', HostBluetoothDeviceInput, OkOutput, 'app'),
  // Tailscale for This Whombat (1.0, CT-1254; Whombat HE-51): the manager drives it.
  session('host.tailscale', HostTailscaleInput, HostTailscaleOutput, 'app', false),
  session('host.tailscale.on', HostTailscaleOnInput, HostTailscaleChangeOutput, 'app'),
  session('host.tailscale.off', HostTailscaleOffInput, HostTailscaleChangeOutput, 'app'),
  session('host.tailscale.signIn', HostTailscaleSignInInput, HostTailscaleChangeOutput, 'app'),
  // The person's own mail server (1.1, CT-1308; Whombat HE-61). `set` and `test` may carry the password.
  session('host.mail', HostMailInput, HostMailOutput, 'app', false),
  session('host.mail.set', HostMailSetInput, HostMailOutput, 'app', true, false, true),
  session('host.mail.test', HostMailTestInput, HostMailTestOutput, 'app', true, false, true),
  session('host.mail.remove', HostMailRemoveInput, HostMailOutput, 'app'),
  // Backup (MR-19). `recoveryMaterial` is a query so its secrets never land in a receipt.
  session('backup.status', BackupStatusInput, BackupStatusOutput, 'app', false),
  session(
    'backup.configureDestination',
    BackupConfigureDestinationInput,
    BackupConfigureDestinationOutput,
    'app',
    true,
    false,
    true,
  ),
  session('backup.recoveryMaterial', BackupRecoveryMaterialInput, BackupRecoveryMaterial, 'app', false),
  // The box's SFTP key (CT-142): a query, made on the first call; public, so not secret.
  session('backup.sshPublicKey', BackupSshPublicKeyInput, BackupSshPublicKey, 'app', false),
  session('backup.runNow', BackupRunNowInput, BackupRunNowOutput, 'app'),
  // Backup places (Whombat backup-places.md): a NAS or server that keeps this Whombat's backups. `placeByHand` is a
  // query whose answer holds the user's bcrypt line, so nothing of it lands in a receipt.
  session('backup.places', BackupPlacesInput, BackupPlacesOutput, 'app', false),
  session('backup.usePlace', BackupUsePlaceInput, BackupUsePlaceOutput, 'app'),
  session('backup.placeByHand', BackupPlaceByHandInput, BackupPlaceByHandOutput, 'app', false),
  session('backup.placeCheck', BackupPlaceCheckInput, BackupPlaceCheckOutput, 'app'),
  session('backup.forgetPlace', BackupForgetPlaceInput, BackupForgetPlaceOutput, 'app'),
  // Backup options, the list of backups and bringing a Whombat back (Whombat backup-options.md). `adopt` carries the
  // recovery kit (secret); `restore` stops the runtime for a while.
  session('backup.checkpoints', BackupCheckpointsInput, BackupCheckpointsOutput, 'app', false),
  session('backup.policy', BackupPolicyInput, BackupPolicyOutput, 'app', false),
  session('backup.setPolicy', BackupSetPolicyInput, BackupSetPolicyOutput, 'app'),
  session('backup.check', BackupCheckInput, BackupCheckOutput, 'app'),
  session('backup.moveLocal', BackupMoveLocalInput, BackupMoveLocalOutput, 'app'),
  session('backup.removeLocal', BackupRemoveLocalInput, BackupRemoveLocalOutput, 'app'),
  session('backup.adopt', BackupAdoptInput, BackupAdoptOutput, 'app', true, false, true),
  session('backup.restore', BackupRestoreInput, BackupRestoreOutput, 'app'),
  session('backup.restoreState', BackupRestoreStateInput, BackupRestoreStateOutput, 'app', false),
  session('backup.finishRestore', BackupFinishRestoreInput, BackupFinishRestoreOutput, 'app'),
  // Backups v2 (CT-1691, CT-1694): the Backups page in one read, and the claim's “Let {assistant} set it up”.
  session('backup.overview', BackupOverviewInput, BackupOverviewOutput, 'app', false),
  session('backup.letAssistantSetUp', BackupLetAssistantSetUpInput, BackupLetAssistantSetUpOutput, 'app'),
  // The passkey as the key to the backups (Whombat backup-passkey.md). `set` carries the backup key (secret); finding
  // envelopes on the network is a read.
  session(
    'backup.passkeyKey.set',
    BackupPasskeyKeySetInput,
    BackupPasskeyKeyOutput,
    'app',
    true,
    false,
    true,
  ),
  session(
    'backup.passkeyKey.verifyBegin',
    BackupPasskeyVerifyBeginInput,
    BackupPasskeyVerifyBeginOutput,
    'app',
    true,
    true,
    true,
  ),
  session(
    'backup.passkeyKey.verifyConfirm',
    BackupPasskeyVerifyConfirmInput,
    BackupPasskeyKeyOutput,
    'app',
    true,
    true,
    true,
  ),
  session('backup.passkeyKey.remove', BackupPasskeyKeyRemoveInput, BackupPasskeyKeyOutput, 'app'),
  session('backup.paperCopy.confirm', BackupPaperCopyConfirmInput, BackupPaperCopyConfirmOutput, 'app'),
  session('backup.findKits', BackupFindKitsInput, BackupFindKitsOutput, 'app', false),
  // Getting one thing back from a backup (Whombat backup-look.md): opening one for reading and listing it are reads
  // (opening the same backup again answers the same look); bringing things back only adds.
  session('backup.look', BackupLookInput, BackupLookOutput, 'app', false),
  session('backup.lookContents', BackupLookContentsInput, BackupLookContentsOutput, 'app', false),
  session('backup.lookBring', BackupLookBringInput, BackupLookBringOutput, 'app'),
  session('backup.lookClose', BackupLookCloseInput, BackupLookCloseOutput, 'app'),
  // The appliance licence (LC-08, CT-77): the state and “Check again”.
  session('licence.status', LicenceStatusInput, LicenceStatusOutput, 'app', false),
  session('licence.refresh', LicenceRefreshInput, LicenceRefreshOutput, 'app'),
  // Customer-approved diagnostic bundles (CT-52).
  session('diagnostics.create', DiagnosticsCreateInput, DiagnosticsCreateOutput, 'app'),
  session('diagnostics.preview', DiagnosticsRefInput, DiagnosticsPreviewOutput, 'app', false),
  sessionExport('diagnostics.download', DiagnosticsDownloadInput, DiagnosticBundle),
  session('diagnostics.list', DiagnosticsListInput, DiagnosticsListOutput, 'app', false),
  session('diagnostics.delete', DiagnosticsRefInput, DiagnosticsDeleteOutput, 'app'),
  // Remote help (0.120, CT-933; Whombat remote-help.md RH-02…RH-07). `confirmBegin` is ephemeral (its nonce
  // lives in the session, like `passkey.register.begin`); `start` is secret (its answer holds a prod box's help code,
  // which no receipt keeps, CT-44); the transcript is an export (text).
  session('remoteHelp.get', RemoteHelpGetInput, RemoteHelpState, 'app', false),
  session(
    'remoteHelp.confirmBegin',
    RemoteHelpConfirmBeginInput,
    RemoteHelpConfirmBeginOutput,
    'app',
    true,
    true,
  ),
  session('remoteHelp.start', RemoteHelpStartInput, RemoteHelpState, 'app', true, false, true),
  session('remoteHelp.stop', RemoteHelpStopInput, RemoteHelpState, 'app'),
  session('remoteHelp.visits', RemoteHelpVisitsInput, RemoteHelpVisitsOutput, 'app', false),
  sessionExport('remoteHelp.transcript', RemoteHelpTranscriptInput, RemoteHelpTranscript),
  // The desk screen (0.100, CT-523; Whombat desk-display.md DK-02, DK-04): pairing and the PIN are secret (CT-44).
  session('desk.get', DeskGetInput, DeskScreen, 'app', false),
  session('desk.startPairing', DeskStartPairingInput, DeskStartPairingOutput, 'app'),
  session('desk.pair', DeskPairInput, DeskScreen, 'app', true, false, true),
  session('desk.setPin', DeskSetPinInput, DeskScreen, 'app', true, false, true),
  session('desk.update', DeskUpdateInput, DeskScreen, 'app'),
  session('desk.unpair', DeskUnpairInput, DeskScreen, 'app'),
  session('desk.answerUnlock', DeskAnswerUnlockInput, DeskAnswerUnlockOutput, 'app'),
  // 0.101 (CT-540; DK-20): the switch.
  session('desk.setScreen', DeskSetScreenInput, DeskScreen, 'app'),
  // 0.105 (CT-612; DK-51): *Listen*, read through an export stream (larger than a message).
  session('desk.voiceSample', DeskVoiceSampleInput, DeskVoiceSample, 'app', false),
  // 3.2 (CT-1626…CT-1628; DK-119, DK-123, DK-124): Settings → Screen's preview, *Try it on the screen*, the name.
  session('desk.preview', DeskPreviewInput, DeskPreview, 'app', false),
  session('desk.tryOnScreen', DeskTryOnScreenInput, DeskTryOnScreenOutput, 'app'),
  session('desk.setName', DeskSetNameInput, DeskScreen, 'app'),
  // Screens of widgets (3.6): Settings → Screens and the editor.
  session('desk.screens', DeskScreensInput, DeskScreensList, 'app', false),
  session('desk.screen.get', DeskScreenGetInput, DeskScreenDetail, 'app', false),
  session('desk.screen.update', DeskScreenUpdateInput, DeskScreenDetail, 'app'),
  session('desk.screen.views', DeskScreenViewsInput, DeskScreenViews, 'app', false),
  session('desk.screen.try', DeskScreenTryInput, DeskScreenTryOutput, 'app'),
  session('desk.screen.add', DeskScreenAddInput, DeskScreenDetail, 'app', true, false, true),
  session('desk.screen.remove', DeskScreenRemoveInput, OkOutput, 'app'),
  session('desk.widgets', DeskWidgetsInput, DeskCatalog, 'app', false),
  // A device becoming a screen (3.6): the letters are ephemeral (memory only), the status reads.
  session(
    'enroll.display.request',
    EnrollDisplayRequestInput,
    EnrollDisplayRequestOutput,
    'enroll',
    true,
    true,
  ),
  session('enroll.display.status', EnrollDisplayStatusInput, EnrollDisplayStatusOutput, 'enroll', false),
  // A screen elsewhere (3.6): only its own state, its lock and its pictures.
  session('screen.state', ScreenStateInput, ScreenStateOutput, 'screen', false),
  session('screen.unlock', ScreenUnlockInput, ScreenLock, 'screen', true, true, true),
  session('screen.lock', ScreenLockInput, ScreenLock, 'screen', true, true),
  session('screen.image', ScreenImageInput, ScreenImage, 'screen', false),
  // Voice typing (3.1; Whombat dictation.md) and opt-in Dutch voice: settings are one commit each; recording is an upload.
  session('voice.get', VoiceGetInput, VoiceTyping, 'app', false),
  session('voice.update', VoiceUpdateInput, VoiceTyping, 'app'),
  session('voice.fetchModel', VoiceModelInput, VoiceTyping, 'app'),
  session('voice.removeModel', VoiceModelInput, VoiceTyping, 'app'),
  session('voice.setDutchVoice', VoiceDutchInput, VoiceTyping, 'app'),
];

/** `enroll.claim`, `backup.runNow`, … — every session-native operation (`SESSION_OPERATIONS`). */
export type SessionOpName = (typeof SESSION_SPECS)[number]['op'];
/** Every operation a session request may name: `api.<area>.<action>` key paths and the session-native ops. */
export type OperationName = ApiOpName | SessionOpName;

/**
 * Session-native operations (MA-04, MA-10): enrollment, recovery, endpoints, push handle, status, licence, the
 * desk screen (0.100), the box's hardware and network (0.102), its Bluetooth (0.109), remote help (0.120), Tailscale
 * (1.0), the claim on the box's own page, device links and the person's mail server (1.1).
 */
export const SESSION_OPERATIONS: ReadonlyMap<string, OperationSpec> = new Map(
  SESSION_SPECS.map((s) => [s.op, s] as const),
);

/**
 * `api` operations that never go over the session: none since 1.1 (CT-1307), when `devices.vapidKey` came over the
 * session for the box's own Web Push. Kept as the place a later one would go.
 */
export const SESSION_EXCLUDED_API_OPS: readonly string[] = [];

export class OperationAllowlist {
  private readonly specs: ReadonlyMap<string, OperationSpec>;

  constructor(specs: Iterable<OperationSpec>) {
    const map = new Map<string, OperationSpec>();
    for (const spec of specs) {
      if (map.has(spec.op)) throw new Error(`duplicate operation ${spec.op}`);
      map.set(spec.op, spec);
    }
    this.specs = map;
  }

  get(op: string): OperationSpec | undefined {
    return this.specs.get(op);
  }

  has(op: string): boolean {
    return this.specs.has(op);
  }

  get ops(): string[] {
    return [...this.specs.keys()].sort();
  }

  /**
   * Resolves a request's `op` for a session: `unknown_op` when not allowlisted, `enrollment_required` when an
   * unenrolled endpoint asks for an `app` operation. A screen's endpoint (`screen`) resolves only `screen` operations,
   * and nobody else does.
   */
  resolve(
    op: string,
    session: { enrolled: boolean; screen?: boolean },
  ): { ok: true; spec: OperationSpec } | { ok: false; code: 'unknown_op' | 'enrollment_required' } {
    const spec = this.specs.get(op);
    if (!spec) return { ok: false, code: 'unknown_op' };
    // A screen's endpoint sees only the `screen` channel, and only it does; anything else is as if it didn't exist.
    if (session.screen === true)
      return spec.channel === 'screen' ? { ok: true, spec } : { ok: false, code: 'unknown_op' };
    if (spec.channel === 'screen') return { ok: false, code: 'unknown_op' };
    if (!session.enrolled && spec.channel !== 'enroll') return { ok: false, code: 'enrollment_required' };
    return { ok: true, spec };
  }
}

/**
 * Builds an allowlist from the contracts. Default: every `api` operation except `SESSION_EXCLUDED_API_OPS`,
 * plus every session-native operation. `only` narrows the `api` operations to a list; `exclude` removes more.
 * Names that don't exist throw (a typo must not silently widen or narrow the surface).
 */
export function createOperationAllowlist(
  options: { only?: readonly string[]; exclude?: readonly string[] } = {},
) {
  const known = (op: string) => {
    if (!API_OPERATIONS.has(op) && !SESSION_OPERATIONS.has(op)) throw new Error(`unknown operation ${op}`);
    return op;
  };
  const exclude = new Set([...SESSION_EXCLUDED_API_OPS, ...(options.exclude ?? []).map(known)]);
  const apiOps = options.only
    ? options.only.map(known).filter((op) => API_OPERATIONS.has(op))
    : [...API_OPERATIONS.keys()];
  const specs: OperationSpec[] = [];
  for (const op of apiOps) if (!exclude.has(op)) specs.push(API_OPERATIONS.get(op) as OperationSpec);
  for (const [op, spec] of SESSION_OPERATIONS) if (!exclude.has(op)) specs.push(spec);
  return new OperationAllowlist(specs);
}

/** The digest a receipt binds a request id to: `requestDigest`, or over the op alone for `secret` ops. */
export function receiptDigest(spec: Pick<OperationSpec, 'op' | 'secret'>, input: unknown): string {
  return requestDigest(spec.op, spec.secret ? null : input);
}

/** Output schema of a `result`: the operation's output, or core's `ApprovalRequiredBody` for `approval_required`. */
export function resultOutputSchema(spec: OperationSpec, kind: 'ok' | 'approval_required'): z.ZodType {
  return kind === 'ok' ? spec.output : ApprovalRequiredBody;
}
