import {
  AccountLinkInput,
  AccountLinkLookupInput,
  AccountLinkLookupOutput,
  AccountLinkOutput,
  BackupPasskeyVerifyBeginInput,
  BackupPasskeyVerifyBeginOutput,
  BackupPasskeyVerifyConfirmInput,
  BoxPasskeyEnrollBeginOutput,
  BoxPasskeyEnrollInput,
  BoxPasskeyRegisterBeginOutput,
  BoxPasskeyRegisterInput,
  EnrollClaimLocalStartInput,
  LinkOutput,
  OwnAddressReachSetInput,
  OwnAddressReachSetOutput,
  OwnAddressStatusOutput,
  PasskeyLinkInput,
  PasskeyRegisterBeginInput,
  PushTokenSetInput,
  PushTokenSetOutput,
  ReachGetOutput,
  UpdatesChannelOutput,
  UpdatesChannelSetInput,
} from '@whombat/protocol/session';
/**
 * Managed-appliance operations for the UI (AP-18): typed calls of the protocol's session-native operations
 * (`enroll.*`, `recovery.*`, `endpoints.*` from `@whombat/protocol/session`, validated with its schemas on the
 * way out, and decoded tolerantly on the way in: an item carrying something only a newer app knows is left
 * out, not the whole answer, AP-255), including `appliance.status` (claim, recovery kit, revocations, backups, updates, managed
 * policy, provider sign-ins, versions).
 */

import {
  DeskCatalog,
  DeskPreview,
  DeskScreen,
  DeskScreenDetail,
  DeskScreensList,
  REMOTE_HELP_LIMITS,
  VoiceTyping,
} from '@whombat/core/domain';
import {
  ApplianceStatusOutput,
  ApplianceUpdateAskInput,
  ApplianceUpdateAskOutput,
  ApplianceUpdateInstallInput,
  ApplianceUpdateInstallOutput,
  BACKUP_LIST_PAGE,
  BackupAdoptInput,
  BackupAdoptOutput,
  BackupCheckInput,
  BackupCheckOutput,
  BackupCheckpointsInput,
  BackupCheckpointsOutput,
  BackupConfigureDestinationInput,
  BackupConfigureDestinationOutput,
  BackupFindKitsOutput,
  BackupFinishRestoreInput,
  BackupFinishRestoreOutput,
  BackupForgetPlaceInput,
  BackupForgetPlaceOutput,
  BackupLetAssistantSetUpInput,
  BackupLetAssistantSetUpOutput,
  BackupLookBringInput,
  BackupLookBringOutput,
  BackupLookCloseOutput,
  BackupLookContentsInput,
  BackupLookContentsOutput,
  BackupLookInput,
  BackupLookOutput,
  BackupMoveLocalOutput,
  BackupOverviewOutput,
  BackupPaperCopyConfirmInput,
  BackupPaperCopyConfirmOutput,
  BackupPasskeyKeyOutput,
  BackupPasskeyKeyRemoveInput,
  BackupPasskeyKeySetInput,
  BackupPlaceByHandInput,
  BackupPlaceByHandOutput,
  BackupPlaceCheckInput,
  BackupPlaceCheckOutput,
  BackupPlacesOutput,
  BackupPolicyOutput,
  BackupRecoveryMaterial,
  BackupRemoveLocalOutput,
  BackupRestoreInput,
  BackupRestoreOutput,
  BackupRestoreStateOutput,
  BackupRunNowOutput,
  BackupSetPolicyInput,
  BackupSetPolicyOutput,
  BackupSshPublicKey,
  BackupStatusOutput,
  BackupUsePlaceInput,
  BackupUsePlaceOutput,
  DESK_VOICE_SAMPLE_WAV_MAX_BYTES,
  DeskAnswerUnlockInput,
  DeskAnswerUnlockOutput,
  DeskPairInput,
  DeskPreviewInput,
  DeskScreenAddInput,
  DeskScreenGetInput,
  DeskScreenRemoveInput,
  DeskScreenTryInput,
  DeskScreenTryOutput,
  DeskScreenUpdateInput,
  DeskScreenViews,
  DeskScreenViewsInput,
  DeskSetNameInput,
  DeskSetPinInput,
  DeskSetScreenInput,
  DeskStartPairingOutput,
  DeskTryOnScreenInput,
  DeskTryOnScreenOutput,
  DeskUpdateInput,
  DeskVoiceSample,
  DeskVoiceSampleInput,
  DeskWidgetsInput,
  DiagnosticsCreateInput,
  DiagnosticsCreateOutput,
  DiagnosticsDeleteOutput,
  DiagnosticsListOutput,
  DiagnosticsPreviewOutput,
  EndpointsListOutput,
  EndpointsRevokeOutput,
  EnrollClaimBeginInput,
  EnrollClaimBeginOutput,
  EnrollClaimInput,
  EnrollClaimLocalBeginInput,
  EnrollClaimLocalBeginOutput,
  EnrollClaimLocalInput,
  EnrollClaimLocalProveInput,
  EnrollClaimLocalProveOutput,
  EnrollClaimLocalStartOutput,
  EnrollClaimOutput,
  EnrollDevInput,
  EnrollDisplayRequestInput,
  EnrollDisplayRequestOutput,
  EnrollDisplayStatusInput,
  EnrollDisplayStatusOutput,
  EnrolledOutput as EnrolledOutputSchema,
  EnrollLinkAcceptInput,
  EnrollLinkCreateOutput,
  EnrollPairApproveInput,
  EnrollPairApproveOutput,
  EnrollPairLookupOutput,
  EnrollPairRequestInput,
  EnrollPairRequestOutput,
  EnrollPairStatusOutput,
  EnrollPasskeyInput,
  EnrollScreenBeginInput,
  EnrollScreenBeginOutput,
  EnrollScreenInput,
  EnrollScreenOutput,
  EnrollScreenRequestInput,
  EnrollScreenRequestOutput,
  HostBluetoothCancelInput,
  HostBluetoothConfirmInput,
  HostBluetoothDeviceInput,
  HostBluetoothDeviceOutput,
  HostBluetoothOutput,
  HostBluetoothPairingOutput,
  HostBluetoothScanOutput,
  HostCableChangeOutput,
  HostCableSetInput,
  HostHardwareOutput,
  HostMailOutput,
  HostMailSetInput,
  HostMailTestInput,
  HostMailTestOutput,
  HostMetricsInput,
  HostMetricsOutput,
  HostNetworkOutput,
  HostTailscaleChangeOutput,
  HostTailscaleOffInput,
  HostTailscaleOnInput,
  HostTailscaleOutput,
  HostWifiChangeOutput,
  HostWifiForgetInput,
  HostWifiJoinInput,
  HostWifiScanOutput,
  LicenceRefreshOutput,
  LicenceStatusOutput,
  OkOutput,
  PasskeyRegisterBeginOutput,
  PasskeyRegisterInput,
  PasskeyRegisterOutput,
  PasskeyRemoveInput,
  PasskeysListOutput,
  PasskeysPolicyInput,
  PushHandlesSetInput,
  PushResolveInput,
  PushResolveOutput,
  RecoveryEnrollInput,
  RecoveryKitConfirmOutput,
  RecoveryKitRegisterOutput,
  RecoveryKitRotateInput,
  RemoteHelpConfirmBeginInput,
  RemoteHelpConfirmBeginOutput,
  RemoteHelpStartInput,
  RemoteHelpState,
  RemoteHelpTranscriptInput,
  RemoteHelpVisitsInput,
  RemoteHelpVisitsOutput,
  ScreenImage,
  ScreenImageInput,
  ScreenLock,
  ScreenLockInput,
  ScreenStateInput,
  ScreenStateOutput,
  ScreenUnlockInput,
  SESSION_OPERATIONS,
  VoiceModelInput,
  VoiceUpdateInput,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { issuesToFields, NeedsNewerAppError } from '../http/errors';
import { isStrictSessionOp } from '../strict';
import { decodeForUi, noteSkipped, noteStrict } from '../tolerant';
import { type ExportFile, readExportFile } from './resources';
import { type ApplianceSession, type CallOptions, StreamError } from './types';

/** A session-native operation answered with an error (`code` is the protocol's or the application's). */
export class OperationError extends Error {
  override name = 'OperationError';
  constructor(
    readonly op: string,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The most backups bring back reads after joining an earlier Whombat's (newest first). */
const ADOPT_LIST_READ_MAX = 1_000;

async function run<O extends z.ZodType>(
  session: ApplianceSession,
  op: string,
  input: unknown,
  output: O,
  options: CallOptions & { read?: boolean } = {},
): Promise<z.output<O>> {
  const mutating = options.read ? false : (SESSION_OPERATIONS.get(op)?.mutating ?? true);
  const r = await session.invoke(op, input, { ...options, mutating });
  if (r.status >= 200 && r.status < 300) {
    if (isStrictSessionOp(op)) {
      // A security view (AP-266): decoded strictly; a mismatch says the app needs an update.
      const parsed = output.safeParse(r.body);
      noteStrict(op, !parsed.success);
      if (!parsed.success) throw new NeedsNewerAppError(op, issuesToFields(parsed.error.issues), r.body);
      return parsed.data;
    }
    const decoded = decodeForUi(output, r.body);
    if (!decoded.ok) throw decoded.error;
    noteSkipped(op, decoded.skipped);
    return decoded.data;
  }
  const error = (r.body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)
    ?.error;
  throw new OperationError(
    op,
    r.status,
    error?.code ?? 'failed',
    error?.message ?? 'Failed.',
    error?.details,
  );
}

/**
 * A session op that changes nothing, read through an export stream because its answer can be larger than one session
 * message (64 KiB): `open{spec: {kind: 'export', op, input}}`, the stream's UTF-8 JSON decoded as `run` decodes an
 * answer, at most `maxBytes`. A refusal is the stream's `stream_refused` with the reason's code in `details.code`
 * (CT-21): thrown as the `OperationError` the op would have answered, so its words are the same. A stream that broke
 * (lost, damaged, too large, cancelled) throws as it did.
 */
async function exportRun<O extends z.ZodType>(
  session: ApplianceSession,
  op: string,
  input: unknown,
  output: O,
  maxBytes: number,
  options: { signal?: AbortSignal } = {},
): Promise<z.output<O>> {
  const file = await exportFile(session, op, input, maxBytes, options);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(file.bytes));
  } catch {
    throw new StreamError('integrity', `${op} didn’t answer JSON.`);
  }
  const decoded = decodeForUi(output, body);
  if (!decoded.ok) throw decoded.error;
  noteSkipped(op, decoded.skipped);
  return decoded.data;
}

/**
 * A session op's file read whole through an export stream, at most `maxBytes` (`readExportFile`: checked against what
 * the appliance announced). A refusal is thrown as the `OperationError` the op would have answered (CT-21).
 */
async function exportFile(
  session: ApplianceSession,
  op: string,
  input: unknown,
  maxBytes: number,
  options: { signal?: AbortSignal } = {},
): Promise<ExportFile> {
  try {
    const stream = await session.openResource(
      { kind: 'export', op, input },
      options.signal ? { signal: options.signal } : {},
    );
    return await readExportFile(stream, maxBytes);
  } catch (error) {
    const reason = (error as { details?: { code?: unknown } } | null)?.details?.code;
    if (error instanceof StreamError && typeof reason === 'string')
      throw new OperationError(op, 409, 'stream_refused', error.message, error.details);
    throw error;
  }
}

/** The most `desk.voiceSample`'s JSON can be: the WAV's 1 MiB in base64, and the braces around it. */
const DESK_VOICE_SAMPLE_JSON_MAX_BYTES = Math.ceil(DESK_VOICE_SAMPLE_WAV_MAX_BYTES / 3) * 4 + 1024;

/** The most `screen.image`'s JSON can be: the contract's base64 and the braces around it. */
const SCREEN_IMAGE_JSON_MAX_BYTES = 4_500_000 + 1024;

/**
 * The recovery kit's backup section as the appliance hands it (`backup.recoveryMaterial`, contracts 0.5, 0.22 CT-142,
 * and `head` since 0.22.3), with nothing else: read strictly, so no credential a restore needs is silently left out
 * of a kit (AP-265).
 */
export const KitMaterial = BackupRecoveryMaterial.strict();

/** The recovery kit's backup section (`KitMaterial`). */
export type KitBackup = z.output<typeof KitMaterial>;

type ClaimBeginInput = z.input<typeof EnrollClaimBeginInput>;
type ClaimInput = z.input<typeof EnrollClaimInput>;
/** A device link the box made (`enroll.link.create`, CT-1305): shown once, good for `DEVICE_LINK_TTL_S`. */
export type DeviceLinkCreated = z.output<typeof EnrollLinkCreateOutput>;
export type EnrolledOutput = z.output<typeof EnrollClaimOutput>;
/** `enroll.screen`'s answer: enrolled, with the box's confirmation tag (BX-03). */
export type ScreenEnrolledOutput = z.output<typeof EnrollScreenOutput>;
/** The device behind a pairing code, as the approving device shows it (CT-46). */
export type PairLookupOutput = z.output<typeof EnrollPairLookupOutput>;
export type DiagnosticBundleSummary = z.output<typeof DiagnosticsCreateOutput>;
export type EndpointSummary = z.output<typeof EndpointsListOutput>['endpoints'][number];
export type ApplianceStatus = z.output<typeof ApplianceStatusOutput>;
/** What Settings → This Whombat → Subscription shows (LC-13); null on an unclaimed appliance. */
export type LicenceView = NonNullable<z.output<typeof LicenceStatusOutput>['licence']>;

export const sessionOps = {
  /**
   * Claim, step 1 (CC-07): this side's CPace share for control's claim; the appliance answers its own. Ephemeral: no
   * receipt, never resent. Use the ceremony (`runClaimCeremony`), not this directly.
   */
  claimBegin: (s: ApplianceSession, input: ClaimBeginInput, o?: CallOptions) =>
    run(s, 'enroll.claim.begin', EnrollClaimBeginInput.parse(input), EnrollClaimBeginOutput, o),
  /**
   * Claim, step 2 (CC-07): the client's confirmation tag; enrolls this endpoint key as the person's. The answer's
   * `confirm` must be checked against the appliance's tag before anything is trusted (`runClaimCeremony`).
   */
  claim: (s: ApplianceSession, input: ClaimInput, o?: CallOptions) =>
    run(s, 'enroll.claim', EnrollClaimInput.parse(input), EnrollClaimOutput, o),
  /*
   * The claim on a community box's own page (CT-1301; HE-59): the box's own claim id, CPace with the four letters on its
   * screen bound to both Noise keys, the proofs, then the person's account. Use the ceremony (`runLocalClaim`), not
   * these directly.
   */
  /** Step 0: the box's claim id for this key (ephemeral; refusals say whether a claim can start). */
  claimLocalStart: (
    s: ApplianceSession,
    input: z.input<typeof EnrollClaimLocalStartInput> = {},
    o?: CallOptions,
  ) =>
    run(
      s,
      'enroll.claim.local.start',
      EnrollClaimLocalStartInput.parse(input),
      EnrollClaimLocalStartOutput,
      o,
    ),
  /** Step 1: this side's share; the box answers its own (ephemeral, never resent). */
  claimLocalBegin: (
    s: ApplianceSession,
    input: z.input<typeof EnrollClaimLocalBeginInput>,
    o?: CallOptions,
  ) =>
    run(
      s,
      'enroll.claim.local.begin',
      EnrollClaimLocalBeginInput.parse(input),
      EnrollClaimLocalBeginOutput,
      o,
    ),
  /** Step 2: the client's tag alone; the answer's `confirm` must be the box's tag before anything else is sent. */
  claimLocalProve: (
    s: ApplianceSession,
    input: z.input<typeof EnrollClaimLocalProveInput>,
    o?: CallOptions,
  ) =>
    run(
      s,
      'enroll.claim.local.prove',
      EnrollClaimLocalProveInput.parse(input),
      EnrollClaimLocalProveOutput,
      o,
    ),
  /** Step 3: the person's account, once, on the session whose proofs both checked out. */
  claimLocal: (
    s: ApplianceSession,
    input: Omit<z.input<typeof EnrollClaimLocalInput>, 'confirm'>,
    o?: CallOptions,
  ) => run(s, 'enroll.claim.local', EnrollClaimLocalInput.parse(input), EnrolledOutputSchema, o),
  /*
   * Signing in at the box's screen (Whombat signin-at-box.md BX-02…BX-05; contracts 0.106.0): the box shows six letters
   * on its own screen for this device, the person types them here, and CPace bound to both Noise keys lets this device
   * in to the person's account. Use the step machine (`screen-signin.ts`), not these directly.
   */
  /** Ask the box to show a code for this device (ephemeral: no receipt, never resent). */
  screenRequest: (s: ApplianceSession, input: z.input<typeof EnrollScreenRequestInput>, o?: CallOptions) =>
    run(s, 'enroll.screen.request', EnrollScreenRequestInput.parse(input), EnrollScreenRequestOutput, o),
  /** CPace step 1 with the typed letters: this side's share, the box answers its own (ephemeral). */
  screenBegin: (s: ApplianceSession, input: z.input<typeof EnrollScreenBeginInput>, o?: CallOptions) =>
    run(s, 'enroll.screen.begin', EnrollScreenBeginInput.parse(input), EnrollScreenBeginOutput, o),
  /**
   * CPace step 2: the client's tag lets this device in (never retried by itself). The answer's `confirm` must be the
   * box's tag before anything is trusted or pinned.
   */
  screenEnroll: (s: ApplianceSession, input: z.input<typeof EnrollScreenInput>, o?: CallOptions) =>
    run(s, 'enroll.screen', EnrollScreenInput.parse(input), EnrollScreenOutput, o),
  pairRequest: (s: ApplianceSession, input: z.input<typeof EnrollPairRequestInput>, o?: CallOptions) =>
    run(s, 'enroll.pair.request', EnrollPairRequestInput.parse(input), EnrollPairRequestOutput, o),
  pairStatus: (s: ApplianceSession, pairingId: string, o?: CallOptions) =>
    run(s, 'enroll.pair.status', { pairingId }, EnrollPairStatusOutput, o),
  /**
   * On a trusted endpoint: which device shows this code (label, platform, fingerprint), before approving it
   * (CT-46). A query.
   */
  pairLookup: (s: ApplianceSession, code: string, o?: CallOptions) =>
    run(s, 'enroll.pair.lookup', { code }, EnrollPairLookupOutput, o),
  /**
   * On a trusted endpoint: approve (or deny) the code the new endpoint shows, with the fingerprint
   * `pairLookup` returned (`pairing_fingerprint_mismatch` when the code now belongs to another device).
   */
  pairApprove: (s: ApplianceSession, input: z.input<typeof EnrollPairApproveInput>, o?: CallOptions) =>
    run(s, 'enroll.pair.approve', EnrollPairApproveInput.parse(input), EnrollPairApproveOutput, o),
  recoveryKitRegister: (s: ApplianceSession, recoveryPublicKey: string, o?: CallOptions) =>
    run(s, 'recovery.kit.register', { recoveryPublicKey }, RecoveryKitRegisterOutput, o),
  recoveryKitConfirm: (s: ApplianceSession, input: { kitId: string; signature: string }, o?: CallOptions) =>
    run(s, 'recovery.kit.confirm', input, RecoveryKitConfirmOutput, o),
  /** The recovery ceremony (CT-45): lets this endpoint in to the person's account (`recoveryEnrollRequest`, AP-41). */
  recoveryEnroll: (s: ApplianceSession, input: z.input<typeof RecoveryEnrollInput>, o?: CallOptions) =>
    run(s, 'recovery.enroll', RecoveryEnrollInput.parse(input), EnrolledOutputSchema, o),
  endpointsList: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'endpoints.list', {}, EndpointsListOutput, o),
  endpointsRename: (s: ApplianceSession, input: { endpointId: string; label: string }, o?: CallOptions) =>
    run(s, 'endpoints.rename', input, OkOutput, o),
  applianceStatus: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'appliance.status', {}, ApplianceStatusOutput, o),
  /** “Ask before updating” on or off (Whombat ask-before-updating.md): the setting the box's manager now keeps. */
  applianceUpdateAsk: (s: ApplianceSession, askFirst: boolean, o?: CallOptions) =>
    run(s, 'appliance.update.ask', ApplianceUpdateAskInput.parse({ askFirst }), ApplianceUpdateAskOutput, o),
  /** The owner's yes to the update waiting for them (`update.candidate`); `conflict` when it no longer waits. */
  applianceUpdateInstall: (s: ApplianceSession, release: string, o?: CallOptions) =>
    run(
      s,
      'appliance.update.install',
      ApplianceUpdateInstallInput.parse({ release }),
      ApplianceUpdateInstallOutput,
      o,
    ),
  /**
   * How the box is doing (Whombat box-status.md BS-06, CT-334): one range's points, or with `since` only the
   * points from then on (a live view's next poll), with the latest sample, the disks and 30 days of traffic. `metrics`
   * null with `reason` `unavailable` when the manager doesn't answer. Runtimes with the `host.metrics` feature; on a
   * self-hosted server use `hostMetricsLoader`, which doesn't ask (there is no manager).
   */
  hostMetrics: (s: ApplianceSession, input: z.input<typeof HostMetricsInput>, o?: CallOptions) =>
    run(s, 'host.metrics', HostMetricsInput.parse(input), HostMetricsOutput, o),
  /*
   * The machine itself (Whombat hardware-support.md HD-03, HD-05, HD-06; contracts 0.102, features
   * `host.hardware` and `host.network`): the hardware report, the network the box uses, the Wi-Fi networks in range,
   * and joining or forgetting one — a guarded change the app follows by asking `host.network` again every 2 s while it
   * runs (`createNetworkPoller`). `reason` `not_managed` without a manager, `unavailable` when it doesn't answer.
   */
  hostHardware: (s: ApplianceSession, o?: CallOptions) => run(s, 'host.hardware', {}, HostHardwareOutput, o),
  hostNetwork: (s: ApplianceSession, o?: CallOptions) => run(s, 'host.network', {}, HostNetworkOutput, o),
  /* Tailscale on the box (CT-1253, CT-1254; HE-51). */
  hostTailscale: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'host.tailscale', {}, HostTailscaleOutput, { ...o, read: true }),
  /** `loginServer` (CT-1306): absent keeps the box's, null is Tailscale's own, another signs out of the tailnet first. */
  hostTailscaleOn: (s: ApplianceSession, input: z.input<typeof HostTailscaleOnInput> = {}, o?: CallOptions) =>
    run(s, 'host.tailscale.on', HostTailscaleOnInput.parse(input), HostTailscaleChangeOutput, o),
  hostTailscaleOff: (s: ApplianceSession, input: z.input<typeof HostTailscaleOffInput>, o?: CallOptions) =>
    run(s, 'host.tailscale.off', HostTailscaleOffInput.parse(input), HostTailscaleChangeOutput, o),
  hostTailscaleSignIn: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'host.tailscale.signIn', {}, HostTailscaleChangeOutput, o),
  /* The box's own mail server (CT-1308; HE-61): read, set (a `secret` op), test to the person, remove. */
  hostMail: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'host.mail', {}, HostMailOutput, { ...o, read: true }),
  hostMailSet: (s: ApplianceSession, input: z.input<typeof HostMailSetInput>, o?: CallOptions) =>
    run(s, 'host.mail.set', HostMailSetInput.parse(input), HostMailOutput, o),
  hostMailTest: (s: ApplianceSession, input: z.input<typeof HostMailTestInput> = {}, o?: CallOptions) =>
    run(s, 'host.mail.test', HostMailTestInput.parse(input), HostMailTestOutput, o),
  hostMailRemove: (s: ApplianceSession, o?: CallOptions) => run(s, 'host.mail.remove', {}, HostMailOutput, o),
  /** Waits for a fresh scan (the manager up to 10 s). */
  hostWifiScan: (s: ApplianceSession, o?: CallOptions) => run(s, 'host.wifi.scan', {}, HostWifiScanOutput, o),
  /** A `secret` op: the passphrase travels only inside the session. Refusals: `no_wifi`, `busy`, `invalid_passphrase`. */
  hostWifiJoin: (s: ApplianceSession, input: z.input<typeof HostWifiJoinInput>, o?: CallOptions) =>
    run(s, 'host.wifi.join', HostWifiJoinInput.parse(input), HostWifiChangeOutput, o),
  /** Refusals: `no_wifi`, `busy`, `in_use` (the only working connection), `not_saved`. */
  hostWifiForget: (s: ApplianceSession, ssid: string, o?: CallOptions) =>
    run(s, 'host.wifi.forget', HostWifiForgetInput.parse({ ssid }), HostWifiChangeOutput, o),
  /**
   * Wi-Fi only (`wifi`, the cable switched off) or the cable again (contracts 3.13; Whombat network-move.md),
   * guarded like a join and followed the same way. Refusals: `busy`, `no_wifi`, `not_connected`, `no_cable`, `unchanged`.
   */
  hostCableSet: (s: ApplianceSession, use: z.input<typeof HostCableSetInput>['use'], o?: CallOptions) =>
    run(s, 'host.cable.set', HostCableSetInput.parse({ use }), HostCableChangeOutput, o),
  /*
   * Bluetooth (Whombat bluetooth.md BT-02…BT-07; contracts 0.109, feature `host.bluetooth`): the adapter, the
   * paired devices, what the box finds while it looks and the pairing that runs — followed by asking `host.bluetooth`
   * every second while it looks or pairs (`createBluetoothPoller`). `reason` `not_managed` without the Bluetooth
   * service, `unavailable` when it doesn't answer. Refusals in `details.code`: `no_bluetooth`, `busy`, `not_found`,
   * `not_paired`, `unavailable`.
   */
  hostBluetooth: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'host.bluetooth', {}, HostBluetoothOutput, o),
  /** Starts looking for a minute, or keeps looking a minute more (BT-07). */
  hostBluetoothScan: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'host.bluetooth.scan', {}, HostBluetoothScanOutput, o),
  /** Stops looking and pairs in the background (90 s); `busy` while another pairing runs. */
  hostBluetoothPair: (s: ApplianceSession, address: string, o?: CallOptions) =>
    run(s, 'host.bluetooth.pair', HostBluetoothDeviceInput.parse({ address }), HostBluetoothPairingOutput, o),
  /** The answer to “Does {name} show {code}?” (phase `confirm`). */
  hostBluetoothConfirm: (
    s: ApplianceSession,
    input: { pairingId: string; accept: boolean },
    o?: CallOptions,
  ) =>
    run(s, 'host.bluetooth.confirm', HostBluetoothConfirmInput.parse(input), HostBluetoothPairingOutput, o),
  hostBluetoothCancel: (s: ApplianceSession, pairingId: string, o?: CallOptions) =>
    run(
      s,
      'host.bluetooth.cancel',
      HostBluetoothCancelInput.parse({ pairingId }),
      HostBluetoothPairingOutput,
      o,
    ),
  /** Waits until it connected (up to 15 s): the device as it is then. */
  hostBluetoothConnect: (s: ApplianceSession, address: string, o?: CallOptions) =>
    run(
      s,
      'host.bluetooth.connect',
      HostBluetoothDeviceInput.parse({ address }),
      HostBluetoothDeviceOutput,
      o,
    ),
  hostBluetoothDisconnect: (s: ApplianceSession, address: string, o?: CallOptions) =>
    run(
      s,
      'host.bluetooth.disconnect',
      HostBluetoothDeviceInput.parse({ address }),
      HostBluetoothDeviceOutput,
      o,
    ),
  /** Removes the pairing (it has to be paired again, BT-05): `{ok: true}`. */
  hostBluetoothForget: (s: ApplianceSession, address: string, o?: CallOptions) =>
    run(s, 'host.bluetooth.forget', HostBluetoothDeviceInput.parse({ address }), OkOutput, o),
  /*
   * The box's own screen as a desk display (Whombat desk-display.md DK-02…DK-07, DK-12; contracts 0.100, feature
   * `desk`): what Settings sees, pairing with the letters the screen shows and a PIN, the PIN and choices, unpairing and
   * answering the screen's unlock request.
   */
  deskGet: (s: ApplianceSession, o?: CallOptions) => run(s, 'desk.get', {}, DeskScreen, o),
  /** The screen shows four letters for 10 minutes (DK-02). */
  deskStartPairing: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'desk.startPairing', {}, DeskStartPairingOutput, o),
  /** A `secret` op: the PIN travels only inside the session. `wrong_code` carries `triesLeft`. */
  deskPair: (s: ApplianceSession, input: z.input<typeof DeskPairInput>, o?: CallOptions) =>
    run(s, 'desk.pair', DeskPairInput.parse(input), DeskScreen, o),
  /** A new PIN (a `secret` op). */
  deskSetPin: (s: ApplianceSession, pin: string, o?: CallOptions) =>
    run(s, 'desk.setPin', DeskSetPinInput.parse({ pin }), DeskScreen, o),
  /** The screen's choices (DK-03, DK-07, DK-09); only what changes. */
  deskUpdate: (s: ApplianceSession, input: z.input<typeof DeskUpdateInput>, o?: CallOptions) =>
    run(s, 'desk.update', DeskUpdateInput.parse(input), DeskScreen, o),
  /** Turns the screen off on runtimes with the switch (0.101, DK-20); unpairs on older ones. */
  deskUnpair: (s: ApplianceSession, o?: CallOptions) => run(s, 'desk.unpair', {}, DeskScreen, o),
  /**
   * Show Whombat on this screen (0.101, DK-20): on pairs the screen to the caller without letters or a PIN
   * (`no_screen` when none is connected), off ends the pairing and its PIN and keeps it off.
   */
  deskSetScreen: (s: ApplianceSession, on: boolean, o?: CallOptions) =>
    run(s, 'desk.setScreen', DeskSetScreenInput.parse({ on }), DeskScreen, o),
  /** Settings' preview (3.2, DK-123): the calm glance with `show` (the saved choices when absent) for `scenario`. */
  deskPreview: (s: ApplianceSession, input: z.input<typeof DeskPreviewInput>, o?: CallOptions) =>
    run(s, 'desk.preview', DeskPreviewInput.parse(input), DeskPreview, o),
  /** *Try it on the screen* (3.2, DK-124): the screen shows the preview for a minute. */
  deskTryOnScreen: (s: ApplianceSession, input: z.input<typeof DeskTryOnScreenInput>, o?: CallOptions) =>
    run(s, 'desk.tryOnScreen', DeskTryOnScreenInput.parse(input), DeskTryOnScreenOutput, o),
  /** The Whombat's name for the screen's top bar (3.2, DK-119). */
  deskSetName: (s: ApplianceSession, name: string, o?: CallOptions) =>
    run(s, 'desk.setName', DeskSetNameInput.parse({ name }), DeskScreen, o),
  /** Unlock (or keep locked) the screen that asked (DK-04); `request_expired` after its 2 minutes. */
  deskAnswerUnlock: (s: ApplianceSession, input: z.input<typeof DeskAnswerUnlockInput>, o?: CallOptions) =>
    run(s, 'desk.answerUnlock', DeskAnswerUnlockInput.parse(input), DeskAnswerUnlockOutput, o),
  /**
   * *Listen* (0.105, CT-612): the screen's sample sentence said in `voice` by the box, as base64 WAV.
   * Larger than a session message, so read through an export stream; `no_voice` for a voice the screen doesn't list or
   * a box that can't speak now.
   */
  deskVoiceSample: (
    s: ApplianceSession,
    input: z.input<typeof DeskVoiceSampleInput>,
    o: { signal?: AbortSignal } = {},
  ) =>
    exportRun(
      s,
      'desk.voiceSample',
      DeskVoiceSampleInput.parse(input),
      DeskVoiceSample,
      DESK_VOICE_SAMPLE_JSON_MAX_BYTES,
      o,
    ),
  /*
   * Screens of widgets (3.6; Whombat desk-display.md DK-126…DK-149): Settings → Screens and the editor, on the person's
   * session behind feature `desk`.
   */
  /** Every screen, the box's own first, and whether another can be added. */
  deskScreens: (s: ApplianceSession, o?: CallOptions) => run(s, 'desk.screens', {}, DeskScreensList, o),
  /** One screen with its layout and its choices for *What’s going on* and *Servers*; `unknown_screen` when gone. */
  deskScreenGet: (s: ApplianceSession, screen: string, o?: CallOptions) =>
    run(s, 'desk.screen.get', DeskScreenGetInput.parse({ screen }), DeskScreenDetail, o),
  /** A screen's name, pop-ups, layout (whole; `bad_layout`) or choices. */
  deskScreenUpdate: (s: ApplianceSession, input: z.input<typeof DeskScreenUpdateInput>, o?: CallOptions) =>
    run(s, 'desk.screen.update', DeskScreenUpdateInput.parse(input), DeskScreenDetail, o),
  /** The views of any widgets as that screen would draw them now (the editor's live preview). */
  deskScreenViews: (s: ApplianceSession, input: z.input<typeof DeskScreenViewsInput>, o?: CallOptions) =>
    run(s, 'desk.screen.views', DeskScreenViewsInput.parse(input), DeskScreenViews, o),
  /** *Try on the screen*: that screen shows the draft for a minute. */
  deskScreenTry: (s: ApplianceSession, input: z.input<typeof DeskScreenTryInput>, o?: CallOptions) =>
    run(s, 'desk.screen.try', DeskScreenTryInput.parse(input), DeskScreenTryOutput, o),
  /** *Add a screen* with the six letters a device shows (a `secret` op); `wrong_code`, `pairing_expired`, `screens_full`. */
  deskScreenAdd: (s: ApplianceSession, input: z.input<typeof DeskScreenAddInput>, o?: CallOptions) =>
    run(s, 'desk.screen.add', DeskScreenAddInput.parse(input), DeskScreenDetail, o),
  /** *Remove*: a device's screen ends at once, a monitor's forgets its layout. */
  deskScreenRemove: (s: ApplianceSession, screen: string, o?: CallOptions) =>
    run(s, 'desk.screen.remove', DeskScreenRemoveInput.parse({ screen }), OkOutput, o),
  /** *Add a widget*: every group, or one thing's widgets read now. */
  deskWidgets: (s: ApplianceSession, input: z.input<typeof DeskWidgetsInput>, o?: CallOptions) =>
    run(s, 'desk.widgets', DeskWidgetsInput.parse(input), DeskCatalog, o),
  /*
   * A device becoming a screen (3.6, DK-146), on the enrol channel: the six letters it shows, and whether the person
   * typed them yet.
   */
  /** Ephemeral: no receipt, never resent. */
  enrollDisplayRequest: (
    s: ApplianceSession,
    input: z.input<typeof EnrollDisplayRequestInput>,
    o?: CallOptions,
  ) =>
    run(s, 'enroll.display.request', EnrollDisplayRequestInput.parse(input), EnrollDisplayRequestOutput, o),
  enrollDisplayStatus: (s: ApplianceSession, requestId: string, o?: CallOptions) =>
    run(
      s,
      'enroll.display.status',
      EnrollDisplayStatusInput.parse({ requestId }),
      EnrollDisplayStatusOutput,
      o,
    ),
  /*
   * A screen elsewhere (3.6, DK-146), on the screen channel: only its own state, its lock and its pictures.
   */
  /** What it draws, or `{same}` when nothing changed since `known`; its size keeps Settings' picture of it right. */
  screenState: (s: ApplianceSession, input: z.input<typeof ScreenStateInput>, o?: CallOptions) =>
    run(s, 'screen.state', ScreenStateInput.parse(input), ScreenStateOutput, o),
  /** The PIN (a `secret` op); a wrong one answers the lock with fewer tries, or a backoff. */
  screenUnlock: (s: ApplianceSession, pin: string, o?: CallOptions) =>
    run(s, 'screen.unlock', ScreenUnlockInput.parse({ pin }), ScreenLock, o),
  screenLock: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'screen.lock', ScreenLockInput.parse({}), ScreenLock, o),
  /**
   * A picture one of its views names. A picture is small, so it comes as an answer; one larger than a session message
   * (`too_large` with `use_export_stream`) is read through an export stream as the protocol says.
   */
  screenImage: async (
    s: ApplianceSession,
    input: z.input<typeof ScreenImageInput>,
    o: { signal?: AbortSignal } = {},
  ) => {
    const parsed = ScreenImageInput.parse(input);
    try {
      return await run(s, 'screen.image', parsed, ScreenImage, o);
    } catch (error) {
      const tooLarge =
        error instanceof OperationError &&
        error.code === 'too_large' &&
        (error.details as { code?: unknown } | undefined)?.code === 'use_export_stream';
      if (!tooLarge) throw error;
      return exportRun(s, 'screen.image', parsed, ScreenImage, SCREEN_IMAGE_JSON_MAX_BYTES, o);
    }
  },
  /*
   * Voice typing (contracts 3.1; docs/decisions/dictation.md): what Settings and the composers see, its settings, and
   * downloading or removing a speech model. A box without it answers `unknown_op`. The recording itself is an upload
   * (`voice/api.ts`).
   */
  voiceGet: (s: ApplianceSession, o?: CallOptions) => run(s, 'voice.get', {}, VoiceTyping, o),
  voiceUpdate: (s: ApplianceSession, input: z.input<typeof VoiceUpdateInput>, o?: CallOptions) =>
    run(s, 'voice.update', VoiceUpdateInput.parse(input), VoiceTyping, o),
  /** *Download* and *Try again*. */
  voiceFetchModel: (s: ApplianceSession, input: z.input<typeof VoiceModelInput>, o?: CallOptions) =>
    run(s, 'voice.fetchModel', VoiceModelInput.parse(input), VoiceTyping, o),
  /** *Remove*: `conflict` with `details.code: 'in_use'` for a model the settings need. */
  voiceRemoveModel: (s: ApplianceSession, input: z.input<typeof VoiceModelInput>, o?: CallOptions) =>
    run(s, 'voice.removeModel', VoiceModelInput.parse(input), VoiceTyping, o),
  /* The appliance licence (LC-08, LC-13, CT-77): the state, and “Check again”. */
  licenceStatus: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'licence.status', {}, LicenceStatusOutput, o),
  /** Asks the manager to renew now; a renewal that couldn't reach control is `licence.renew_failed`. */
  licenceRefresh: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'licence.refresh', {}, LicenceRefreshOutput, o),
  /* Backups (CT-30). */
  backupStatus: (s: ApplianceSession, o?: CallOptions) => run(s, 'backup.status', {}, BackupStatusOutput, o),
  /** A `secret` op: the receipt keeps no digest of the input (credentials). */
  backupConfigure: (
    s: ApplianceSession,
    input: z.input<typeof BackupConfigureDestinationInput>,
    o?: CallOptions,
  ) =>
    run(
      s,
      'backup.configureDestination',
      BackupConfigureDestinationInput.parse(input),
      BackupConfigureDestinationOutput,
      o,
    ),
  /**
   * The kit's backup section (a query: its secrets never land in a receipt), strictly (AP-265): a member this app
   * doesn't know would be missing from the kit, so it's a `NeedsNewerAppError` instead.
   */
  backupRecoveryMaterial: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.recoveryMaterial', {}, KitMaterial, o),
  backupRunNow: (s: ApplianceSession, o?: CallOptions) => run(s, 'backup.runNow', {}, BackupRunNowOutput, o),
  /**
   * The key this Whombat uses for an SFTP destination (CT-142), made on the first call: the person adds `publicKey` to
   * the server's `authorized_keys`. Runtimes before contracts 0.22 answer `unknown_op`.
   */
  backupSshPublicKey: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.sshPublicKey', {}, BackupSshPublicKey, o),
  /*
   * Backup places (Whombat backup-places.md): a NAS or server that keeps this Whombat's backups. Boxes from before
   * answer `unknown_op`.
   */
  backupPlaces: (s: ApplianceSession, o?: CallOptions) => run(s, 'backup.places', {}, BackupPlacesOutput, o),
  /** Sets the place up and points the backups at it; `move` once the person confirmed moving them. */
  backupUsePlace: (s: ApplianceSession, input: z.input<typeof BackupUsePlaceInput>, o?: CallOptions) =>
    run(s, 'backup.usePlace', BackupUsePlaceInput.parse(input), BackupUsePlaceOutput, o),
  /** The app to paste on a NAS Whombat can't set up itself (a query: its bcrypt line never lands in a receipt). */
  backupPlaceByHand: (s: ApplianceSession, placeId: string, o?: CallOptions) =>
    run(s, 'backup.placeByHand', BackupPlaceByHandInput.parse({ placeId }), BackupPlaceByHandOutput, o),
  /** “Check it” after setting it up by hand: sets the destination when it answers. */
  backupPlaceCheck: (s: ApplianceSession, input: z.input<typeof BackupPlaceCheckInput>, o?: CallOptions) =>
    run(s, 'backup.placeCheck', BackupPlaceCheckInput.parse(input), BackupPlaceCheckOutput, o),
  backupForgetPlace: (s: ApplianceSession, input: z.input<typeof BackupForgetPlaceInput>, o?: CallOptions) =>
    run(s, 'backup.forgetPlace', BackupForgetPlaceInput.parse(input), BackupForgetPlaceOutput, o),
  /*
   * Backup options, the list and bringing a Whombat back (Whombat backup-options.md). Boxes from before answer
   * `unknown_op`; the screens then show what they showed before.
   */
  /**
   * The Backups page in one answer (CT-1691): status, places, the first page of backups with the space, the options;
   * `unknown_op` from a box from before (then the four reads below).
   */
  backupOverview: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.overview', {}, BackupOverviewOutput, o),
  /** One page of the list, newest first (CT-1690): `cursor` is the last page's `nextCursor`. */
  backupCheckpoints: (
    s: ApplianceSession,
    o?: CallOptions,
    page: z.input<typeof BackupCheckpointsInput> = {},
  ) => run(s, 'backup.checkpoints', BackupCheckpointsInput.parse(page), BackupCheckpointsOutput, o),
  backupPolicy: (s: ApplianceSession, o?: CallOptions) => run(s, 'backup.policy', {}, BackupPolicyOutput, o),
  backupSetPolicy: (s: ApplianceSession, input: z.input<typeof BackupSetPolicyInput>, o?: CallOptions) =>
    run(s, 'backup.setPolicy', BackupSetPolicyInput.parse(input), BackupSetPolicyOutput, o),
  /** Restores one backup on the side to prove it works; the result shows on the backup. */
  backupCheck: (s: ApplianceSession, checkpointId: string, o?: CallOptions) =>
    run(s, 'backup.check', BackupCheckInput.parse({ checkpointId }), BackupCheckOutput, o),
  /*
   * Getting one thing back from a backup (Whombat backup-look.md): open it for reading, list what is in it, bring the
   * picked things back (only adds), close it. A box from before answers `unknown_op`.
   */
  backupLook: (s: ApplianceSession, checkpointId: string, o?: CallOptions) =>
    run(s, 'backup.look', BackupLookInput.parse({ checkpointId }), BackupLookOutput, o),
  backupLookContents: (
    s: ApplianceSession,
    input: z.input<typeof BackupLookContentsInput>,
    o?: CallOptions,
  ) => run(s, 'backup.lookContents', BackupLookContentsInput.parse(input), BackupLookContentsOutput, o),
  backupLookBring: (s: ApplianceSession, input: z.input<typeof BackupLookBringInput>, o?: CallOptions) =>
    run(s, 'backup.lookBring', BackupLookBringInput.parse(input), BackupLookBringOutput, o),
  backupLookClose: (s: ApplianceSession, lookId: string, o?: CallOptions) =>
    run(s, 'backup.lookClose', { lookId }, BackupLookCloseOutput, o),
  backupMoveLocal: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.moveLocal', {}, BackupMoveLocalOutput, o),
  backupRemoveLocal: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.removeLocal', {}, BackupRemoveLocalOutput, o),
  /**
   * A `secret` op: the kit never lands in a receipt. `replace`: the person confirmed this Whombat's own backups give way
   * (bringing one back later, CT-1693).
   */
  backupAdopt: async (
    s: ApplianceSession,
    kit: string,
    o?: CallOptions,
    options: { replace?: boolean } = {},
  ): Promise<z.output<typeof BackupAdoptOutput>> => {
    const first = await run(
      s,
      'backup.adopt',
      BackupAdoptInput.parse({ kit, ...(options.replace ? { replace: true } : {}) }),
      BackupAdoptOutput,
      o,
    );
    // The answer holds the newest page (it must fit one message); the rest is the list of the backups it joined.
    let checkpoints = first.checkpoints;
    let cursor = first.nextCursor ?? null;
    while (cursor && checkpoints.length < ADOPT_LIST_READ_MAX) {
      const page = await run(
        s,
        'backup.checkpoints',
        BackupCheckpointsInput.parse({ cursor, limit: BACKUP_LIST_PAGE }),
        BackupCheckpointsOutput,
      );
      checkpoints = checkpoints.concat(page.checkpoints);
      cursor = page.nextCursor ?? null;
    }
    return { ...first, checkpoints, nextCursor: cursor };
  },
  /** Starts the restore; the runtime stops for most of it, so the session drops and comes back. */
  backupRestore: (s: ApplianceSession, checkpointId: string, o?: CallOptions) =>
    run(s, 'backup.restore', BackupRestoreInput.parse({ checkpointId }), BackupRestoreOutput, o),
  backupRestoreState: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.restoreState', {}, BackupRestoreStateOutput, o),
  /**
   * The one answer after a restore (CT-1692): gone or lost. Safe to call again: it carries on where it stopped. The two
   * old checks go along for a box from before, which still asks for them.
   */
  backupFinishRestore: (
    s: ApplianceSession,
    input: z.input<typeof BackupFinishRestoreInput>,
    o?: CallOptions,
  ) =>
    run(
      s,
      'backup.finishRestore',
      BackupFinishRestoreInput.parse({
        oldWhombat: input.oldWhombat,
        signInsChecked: true,
        devicesReviewed: true,
      }),
      BackupFinishRestoreOutput,
      o,
    ),
  /** The claim's “Let {assistant} set it up” (CT-1694): the person's yes, which the assistant carries out later. */
  backupLetAssistantSetUp: (s: ApplianceSession, placeId?: string, o?: CallOptions) =>
    run(
      s,
      'backup.letAssistantSetUp',
      BackupLetAssistantSetUpInput.parse(placeId ? { placeId } : {}),
      BackupLetAssistantSetUpOutput,
      o,
    ),
  /** A `secret` op: this Whombat's backup key from one of the person's passkeys (Whombat backup-passkey.md). */
  backupPasskeyKeySet: (
    s: ApplianceSession,
    input: z.input<typeof BackupPasskeyKeySetInput>,
    o?: CallOptions,
  ) => run(s, 'backup.passkeyKey.set', BackupPasskeyKeySetInput.parse(input), BackupPasskeyKeyOutput, o),
  backupPasskeyVerifyBegin: (s: ApplianceSession, credentialId: string, o?: CallOptions) =>
    run(
      s,
      'backup.passkeyKey.verifyBegin',
      BackupPasskeyVerifyBeginInput.parse({ credentialId }),
      BackupPasskeyVerifyBeginOutput,
      o,
    ),
  backupPasskeyVerifyConfirm: (s: ApplianceSession, proof: string, o?: CallOptions) =>
    run(
      s,
      'backup.passkeyKey.verifyConfirm',
      BackupPasskeyVerifyConfirmInput.parse({ proof }),
      BackupPasskeyKeyOutput,
      o,
    ),
  backupPasskeyKeyRemove: (s: ApplianceSession, credentialId: string, o?: CallOptions) =>
    run(
      s,
      'backup.passkeyKey.remove',
      BackupPasskeyKeyRemoveInput.parse({ credentialId }),
      BackupPasskeyKeyOutput,
      o,
    ),
  /** The person printed or saved the paper copy of the backup details at that generation. */
  backupPaperCopyConfirm: (
    s: ApplianceSession,
    input: z.input<typeof BackupPaperCopyConfirmInput>,
    o?: CallOptions,
  ) =>
    run(
      s,
      'backup.paperCopy.confirm',
      BackupPaperCopyConfirmInput.parse(input),
      BackupPaperCopyConfirmOutput,
      o,
    ),
  /** On a new Whombat: envelopes kept next to backups on this network (may take a minute). */
  backupFindKits: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'backup.findKits', {}, BackupFindKitsOutput, o),
  endpointsRevoke: (s: ApplianceSession, endpointId: string, o?: CallOptions) =>
    run(s, 'endpoints.revoke', { endpointId }, EndpointsRevokeOutput, o),
  /** This endpoint's opaque push handle from control (MA-10, MA-18): the appliance asks control to wake it. */
  pushHandlesSet: (s: ApplianceSession, handle: string, o?: CallOptions) =>
    run(s, 'push.handles.set', PushHandlesSetInput.parse({ handle }), OkOutput, o),
  pushHandlesClear: (s: ApplianceSession, o?: CallOptions) => run(s, 'push.handles.clear', {}, OkOutput, o),
  /** A tapped notification's opaque ref → the burrow and link it is about (CT-49; `not_found` otherwise). */
  pushResolve: (s: ApplianceSession, ref: string, o?: CallOptions) =>
    run(s, 'push.resolve', PushResolveInput.parse({ ref }), PushResolveOutput, o),
  /*
   * A device of your own by QR code or link (CT-1305; HE-60): the device you use makes the link (one per account, five
   * minutes), the new one opens it and is let in to the same account over the box's direct ways.
   */
  linkCreate: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'enroll.link.create', {}, EnrollLinkCreateOutput, o),
  /** The new device, enrollment channel (a `secret` op). */
  linkAccept: (s: ApplianceSession, input: z.input<typeof EnrollLinkAcceptInput>, o?: CallOptions) =>
    run(s, 'enroll.link.accept', EnrollLinkAcceptInput.parse(input), EnrolledOutputSchema, o),
  /* Diagnostic bundles (CT-52). Downloads are export streams (`downloadDiagnostics`). */
  diagnosticsCreate: (s: ApplianceSession, input: z.input<typeof DiagnosticsCreateInput>, o?: CallOptions) =>
    run(s, 'diagnostics.create', DiagnosticsCreateInput.parse(input), DiagnosticsCreateOutput, o),
  diagnosticsPreview: (s: ApplianceSession, bundleId: string, o?: CallOptions) =>
    run(s, 'diagnostics.preview', { bundleId }, DiagnosticsPreviewOutput, o),
  diagnosticsList: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'diagnostics.list', {}, DiagnosticsListOutput, o),
  diagnosticsDelete: (s: ApplianceSession, bundleId: string, o?: CallOptions) =>
    run(s, 'diagnostics.delete', { bundleId }, DiagnosticsDeleteOutput, o),
  /**
   * Replace the recovery key (CT-45): the current key signs the new one (`recoveryRotationSignature`); confirm the
   * new kit as usual. A `secret` op.
   */
  recoveryKitRotate: (
    s: ApplianceSession,
    input: { newRecoveryPublicKey: string; currentKeySignature: string },
    o?: CallOptions,
  ) => run(s, 'recovery.kit.rotate', RecoveryKitRotateInput.parse(input), RecoveryKitRegisterOutput, o),
  /* Passkeys that open the Whombat (PK-04…PK-08, CT-281; runtimes with the `passkeys` feature). */
  /**
   * Enrollment channel: lets this endpoint in with a passkey assertion bound to its key (`passkeyEnrollChallenge`);
   * the Whombat verifies it itself. Use `passkeySignIn`, not this directly.
   */
  enrollPasskey: (s: ApplianceSession, input: z.input<typeof EnrollPasskeyInput>, o?: CallOptions) =>
    run(s, 'enroll.passkey', EnrollPasskeyInput.parse(input), EnrolledOutputSchema, o),
  /**
   * Enrollment channel, a development runtime only (CT-1257, HE-49): lets this browser on the developer's own machine in
   * as the account with `email` (made with `name` when new). Any other box: `dev_only`.
   */
  enrollDev: (s: ApplianceSession, input: z.input<typeof EnrollDevInput>, o?: CallOptions) =>
    run(s, 'enroll.dev', EnrollDevInput.parse(input), EnrolledOutputSchema, o),
  /** Registration, step 1: the Whombat's nonce, RP ID, user and the account's credentials (ephemeral). */
  passkeyRegisterBegin: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'passkey.register.begin', {}, PasskeyRegisterBeginOutput, o),
  passkeySharedBegin: (s: ApplianceSession, ownerHandle: string, o?: CallOptions) =>
    run(
      s,
      'passkey.register.begin',
      PasskeyRegisterBeginInput.parse({ ownerHandle }),
      PasskeyRegisterBeginOutput,
      o,
    ),
  passkeyLink: (s: ApplianceSession, input: z.input<typeof PasskeyLinkInput>, o?: CallOptions) =>
    run(s, 'passkey.link', PasskeyLinkInput.parse(input), PasskeyRegisterOutput, o),
  /** Registration, step 3: the Whombat verifies and stores the new passkey for the caller's account. */
  passkeyRegister: (s: ApplianceSession, input: z.input<typeof PasskeyRegisterInput>, o?: CallOptions) =>
    run(s, 'passkey.register', PasskeyRegisterInput.parse(input), PasskeyRegisterOutput, o),
  /** The person's passkeys and the device-bound setting; a security view, read strictly. */
  passkeysList: (s: ApplianceSession, o?: CallOptions) => run(s, 'passkeys.list', {}, PasskeysListOutput, o),
  passkeyRemove: (s: ApplianceSession, id: string, o?: CallOptions) =>
    run(s, 'passkey.remove', PasskeyRemoveInput.parse({ id }), OkOutput, o),
  /** “Only passkeys that stay on one device” (PK-07). */
  passkeysPolicy: (s: ApplianceSession, deviceBoundOnly: boolean, o?: CallOptions) =>
    run(s, 'passkeys.policy', PasskeysPolicyInput.parse({ deviceBoundOnly }), OkOutput, o),
  /*
   * Box passkeys (4.3; Whombat own-address.md): RP ID the box's own host, nonces and checks the box's own. Use the
   * ceremonies (`managed/box-passkeys.ts`), not these directly.
   */
  /** Joining, step 1 (enrolled or not, any session; ephemeral): the box's nonce and its RP ID. */
  boxPasskeyEnrollBegin: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'boxPasskey.enroll.begin', {}, BoxPasskeyEnrollBeginOutput, o),
  /** Joining, step 2: lets this session's device in with the assertion bound to its key. */
  boxPasskeyEnroll: (s: ApplianceSession, input: z.input<typeof BoxPasskeyEnrollInput>, o?: CallOptions) =>
    run(s, 'boxPasskey.enroll', BoxPasskeyEnrollInput.parse(input), EnrolledOutputSchema, o),
  /** Making one, step 1 (enrolled; ephemeral): what `navigator.credentials.create` needs. */
  boxPasskeyRegisterBegin: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'boxPasskey.register.begin', {}, BoxPasskeyRegisterBeginOutput, o),
  /** Making one, step 2: the box checks and keeps it for the caller's account. */
  boxPasskeyRegister: (
    s: ApplianceSession,
    input: z.input<typeof BoxPasskeyRegisterInput>,
    o?: CallOptions,
  ) => run(s, 'boxPasskey.register', BoxPasskeyRegisterInput.parse(input), PasskeyRegisterOutput, o),
  /* The box's own address (4.3): a box before 4.3 answers `unknown_op` (no own address yet). */
  /** Its address, certificate and certificate watch; null when it has none. */
  ownAddressStatus: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'ownAddress.status', {}, OwnAddressStatusOutput, o),
  /** The owner's switch “Reach my Whombat's page from anywhere”. */
  ownAddressReachSet: (s: ApplianceSession, on: boolean, o?: CallOptions) =>
    run(s, 'ownAddress.reach.set', OwnAddressReachSetInput.parse({ on }), OwnAddressReachSetOutput, o),
  /*
   * Whombat Link, Reach and Updates (4.4; docs/decisions/whombat-link.md): a box before 4.4 answers `unknown_op`, which
   * the apps read as “no Link or channel on this Whombat yet”.
   */
  /** How this Whombat is reached: Link, its own address and Tailscale (each null when it can't have it). */
  reachGet: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'reach.get', {}, ReachGetOutput, { ...o, read: true }),
  /** The owner turns Link on: the box answers `starting` with the code to type at the account site. */
  linkOn: (s: ApplianceSession, o?: CallOptions) => run(s, 'link.on', {}, LinkOutput, o),
  /** The owner turns Link off. */
  linkOff: (s: ApplianceSession, o?: CallOptions) => run(s, 'link.off', {}, LinkOutput, o),
  /** Which channel this Whombat takes its updates from. */
  updatesChannelGet: (s: ApplianceSession, o?: CallOptions) =>
    run(s, 'updates.channel.get', {}, UpdatesChannelOutput, { ...o, read: true }),
  /** The owner chooses Production or Development. */
  updatesChannelSet: (s: ApplianceSession, channel: 'production' | 'development', o?: CallOptions) =>
    run(s, 'updates.channel.set', UpdatesChannelSetInput.parse({ channel }), UpdatesChannelOutput, o),
  /** The phone hands its APNs or FCM token to the box, which sends its pushes through Link. */
  pushTokenSet: (s: ApplianceSession, token: z.input<typeof PushTokenSetInput>['token'], o?: CallOptions) =>
    run(s, 'push.token.set', PushTokenSetInput.parse({ token }), PushTokenSetOutput, o),
  /** This device wants no more pushes through the box (signed out). */
  pushTokenClear: (s: ApplianceSession, o?: CallOptions) => run(s, 'push.token.clear', {}, OkOutput, o),
  /** Whose account a link code belongs to, before linking (a read: nothing is used up). */
  accountLinkLookup: (s: ApplianceSession, code: string, o?: CallOptions) =>
    run(s, 'account.link.lookup', AccountLinkLookupInput.parse({ code }), AccountLinkLookupOutput, o),
  /** Links this Whombat to the code's account (owners). */
  accountLink: (s: ApplianceSession, code: string, o?: CallOptions) =>
    run(s, 'account.link', AccountLinkInput.parse({ code }), AccountLinkOutput, o),
  /*
   * Remote help (Whombat remote-help.md RH-01…RH-09; contracts 0.120, feature `remote_help`; app remote-help.md
   * AP-4441): the state, turning it on (a passkey assertion bound to the choice, `remoteHelp.confirmBegin`, or none for
   * the person without a passkey), Stop, what support did, and a visit's command line as text. A security view: read
   * strictly (AP-266). Refusals in `details.code`: `remote_help_unavailable`, `forever_not_allowed`, `passkey_required`,
   * `passkey_failed`, `remote_help_busy`. Use `turnOnRemoteHelp` (managed/remote-help.ts), not start directly.
   */
  remoteHelpGet: (s: ApplianceSession, o?: CallOptions) => run(s, 'remoteHelp.get', {}, RemoteHelpState, o),
  remoteHelpConfirmBegin: (
    s: ApplianceSession,
    input: z.input<typeof RemoteHelpConfirmBeginInput>,
    o?: CallOptions,
  ) =>
    run(
      s,
      'remoteHelp.confirmBegin',
      RemoteHelpConfirmBeginInput.parse(input),
      RemoteHelpConfirmBeginOutput,
      o,
    ),
  remoteHelpStart: (s: ApplianceSession, input: z.input<typeof RemoteHelpStartInput>, o?: CallOptions) =>
    run(s, 'remoteHelp.start', RemoteHelpStartInput.parse(input), RemoteHelpState, o),
  /** Idempotent: Stop never asks for anything (RH-04). */
  remoteHelpStop: (s: ApplianceSession, o?: CallOptions) => run(s, 'remoteHelp.stop', {}, RemoteHelpState, o),
  /** The newest visits first, `limit` (1..20) before `before`. */
  remoteHelpVisits: (
    s: ApplianceSession,
    input: z.input<typeof RemoteHelpVisitsInput> = {},
    o?: CallOptions,
  ) => run(s, 'remoteHelp.visits', RemoteHelpVisitsInput.parse(input), RemoteHelpVisitsOutput, o),
  /**
   * A visit's command-line record (text/plain, ANSI already taken out by the runtime) through an export stream, at most
   * `REMOTE_HELP_LIMITS.transcriptBytesPerVisit`; `not_found` when the visit has none.
   */
  remoteHelpTranscript: (s: ApplianceSession, visitId: string, o: { signal?: AbortSignal } = {}) =>
    exportFile(
      s,
      'remoteHelp.transcript',
      RemoteHelpTranscriptInput.parse({ visitId }),
      REMOTE_HELP_LIMITS.transcriptBytesPerVisit,
      o,
    ),
};

export type RemoteHelpConfirmBegin = z.output<typeof RemoteHelpConfirmBeginOutput>;
export type PasskeysList = z.output<typeof PasskeysListOutput>;
export type OwnAddressSummary = NonNullable<z.output<typeof OwnAddressStatusOutput>['ownAddress']>;
export type BoxPasskeyRegisterBegin = z.output<typeof BoxPasskeyRegisterBeginOutput>;

export type ProviderStatus = ApplianceStatus['providers'][number];
export type BackupDestinationInput = z.input<typeof BackupConfigureDestinationInput>;
export type BackupPlacesList = z.output<typeof BackupPlacesOutput>;
export type BackupPlaceByHand = z.output<typeof BackupPlaceByHandOutput>;
export type BackupDestinationResult = z.output<typeof BackupConfigureDestinationOutput>;
export type BackupStatus = ApplianceStatus['backup'];
