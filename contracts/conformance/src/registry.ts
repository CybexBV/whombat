/**
 * The cross-language registry: every schema exported to JSON Schema (`schema/`) and Go (`go/`). Each must stay
 * inside the supported subset (docs/contracts/cross-language.md); `checkSubset` enforces it.
 */

import {
  ClaimVerifierRegistration,
  NativePushRegistration,
  PushVapidKey,
  WebPushRegistration,
} from '@whombat/control-contracts';
import {
  DEVICE_OPS,
  type DeviceOp,
  DeviceRegistration,
  DeviceRegistrationResponse,
  DeviceRequestEnvelope,
} from '@whombat/control-contracts/device';
import * as local from '@whombat/control-contracts/local';
import {
  AdmissionClaims,
  AdmissionHeader,
  AdmissionJwk,
  AdmissionJwks,
  DirectDownstreamMessage,
  DirectHello,
  DirectIdentity,
  DirectUpstreamMessage,
  DirectWelcome,
  Ed25519Jwk,
  LicenceClaims,
  LicenceHeader,
  LicenceKeySet,
  LicenceLimits,
  LicenceStatusResult,
  RelayDownstreamMessage,
  RelayDrain,
  RelayDrainReason,
  RelayHello,
  RelayIncoming,
  RelayLease,
  RelayReady,
  RelayRefuse,
  RelayRenew,
  RelayRenewed,
  RelayRenewRefused,
  RelayUpstreamMessage,
  RelayWelcome,
} from '@whombat/protocol';
import {
  AssignmentKeys,
  AssignmentPayload,
  ClientBundle,
  ClientChannelPayload,
  HealthEvidence,
  ProductManifest,
  ReleaseTuple,
  SignedAssignment,
  SignedClientChannel,
  UpdateJournalRecord,
} from '@whombat/release';
import type { z } from 'zod';

/** Go package a schema lives in. */
export type GoPackage = 'protocol' | 'release' | 'device' | 'local';
export const GO_PACKAGES: readonly GoPackage[] = ['protocol', 'release', 'device', 'local'];

export interface Entry {
  name: string;
  schema: z.ZodType;
  go: GoPackage;
}

const pascal = (op: string) =>
  op
    .split(/[._-]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

const LOCAL_SCHEMAS = [
  'RuntimeTicketRequest',
  'RuntimeTicketResponse',
  'RuntimeClaimedRequest',
  'RuntimeRevocationRequest',
  'RuntimePushRequest',
  'RuntimePushResponse',
  'LocalOk',
  'LocalError',
  'RuntimeHealth',
  'DrainRequest',
  'DrainStatus',
  'ResumeRequest',
  'ResumeResponse',
  'ClaimWindowRequest',
  'ClaimLookupLeaseRequest',
  'ConsoleState',
  'FactsRequest',
  'AdminOk',
  'BackupServiceStatus',
  'UpdateFacts',
  'CheckpointRequest',
  'CheckpointResult',
  'UpdateStatusResponse',
  // Ask before updating on the manager socket (4.2).
  'UpdateAskRequest',
  'UpdateAskResponse',
  'UpdateApproveRequest',
  'UpdateApproveResponse',
  // Check for updates on the manager socket (4.19).
  'UpdateCheckRequest',
  'UpdateCheckResponse',
  'MaintenanceLockRequest',
  'MaintenanceLock',
  'MaintenanceUnlockRequest',
  'NetworkCandidate',
  'NetworkSubmitResponse',
  'NetworkStatus',
  'RuntimeFacts',
  'LocalClient',
  'LocalClientsStatus',
  'ClientInstallRequest',
  'ClientRemoveRequest',
  'ClientsPushRequest',
  'LicenceRenewNowRequest',
  'LicenceRenewNowResult',
  'LicencePushRequest',
  'LocalLicenceStatus',
  'LicencePushResponse',
  'RuntimeFeedbackCardsRequest',
  'RuntimeFeedbackCardsResponse',
  'RuntimeFeedbackPullRequest',
  'RuntimeFeedbackPullResponse',
  'RuntimeFeedbackAckRequest',
  'RuntimeFeedbackAckResponse',
  'RuntimeFeedbackReportersRequest',
  'RuntimeFeedbackReportersResponse',
  'RuntimeKitEnvelopesRequest',
  'RuntimeKitEnvelopesResponse',
  // The own address (4.3; Whombat own-address.md).
  'RuntimeAccountLinkLookupRequest',
  'RuntimeAccountLinkLookupResponse',
  'RuntimeAccountLinkRequest',
  'RuntimeAccountLinkResponse',
  'RuntimeKitCredentialsRequest',
  'RuntimeKitCredentialsResponse',
  'OwnAddressStateRequest',
  'OwnAddressRegisterRequest',
  'OwnAddressCertRequest',
  'OwnAddressCtRequest',
  'OwnAddressCheckRequest',
  'OwnAddressCheckResponse',
  'OwnAddressRenameRequest',
  'OwnAddressStateResponse',
  'OwnAddressCertResponse',
  'OwnAddressCtResponse',
  'RuntimeSharePutRequest',
  'RuntimeSharePutResponse',
  'RuntimeShareDeleteRequest',
  'RuntimeShareDeleteResponse',
  'RuntimeShareViewsRequest',
  'RuntimeShareViewsResponse',
  // Reports to the Whombat Team (4.18, team-reports.md).
  'RuntimeTeamReportsListRequest',
  'RuntimeTeamReportsListResponse',
  'RuntimeTeamReportsGetRequest',
  'RuntimeTeamReportsGetResponse',
  'RuntimeTeamReportsCreateRequest',
  'RuntimeTeamReportsCreateResponse',
  'RuntimeTeamReportsReplyRequest',
  'RuntimeTeamReportsReplyResponse',
  'RuntimeTeamReportsActRequest',
  'RuntimeTeamReportsActResponse',
  'HostMetricsRequest',
  'HostMetricsResponse',
  // The desk socket (0.100, CT-528…CT-531).
  'DeskState',
  'DeskTalk',
  'DeskRequest',
  'DeskAck',
  'DeskUnlockRequest',
  'DeskUnlockAnswer',
  'DeskPhoneUnlockAnswer',
  'DeskTouchAnswer',
  'DeskDecideRequest',
  'DeskTalkRequest',
  'DeskTalkStarted',
  'DeskTalkRef',
  // 0.108 (CT-663, CT-664).
  'DeskDecideAnswer',
  'DeskTalkSession',
  // A server's own screen (0.115, CT-863, CT-864).
  'DeskServersAnswer',
  'DeskServerRequest',
  'DeskServerPage',
  // Quieting a look (0.122, CT-1065).
  'DeskLookQuietRequest',
  // The step the assistant offers on a look (3.5).
  'DeskLookFixRequest',
  // Talk's voice typing (3.3).
  'DeskHearRequest',
  'DeskHeard',
  // Screens of widgets (3.6): a widget's picture, the page's outputs and sizes.
  'DeskImageRequest',
  'DeskSizeRequest',
  // The voice socket (0.100, CT-532).
  'VoiceHealth',
  'VoiceSttRequest',
  'VoiceSttAnswer',
  'VoiceTtsRequest',
  'VoiceTtsAnswer',
  // Voice typing (3.1).
  'VoiceGpu',
  'VoiceTranscribeRequest',
  'VoiceTranscribeAnswer',
  'VoiceModelState',
  'VoiceModelsState',
  'VoiceModelRequest',
  // The presence socket (0.103, CT-597).
  'PresenceHealth',
  'PresenceWatchRequest',
  'PresenceWatch',
  'PresenceStopRequest',
  'PresenceAck',
  // The box's hardware and network on the manager socket (0.102, CT-573).
  'HostHardwareRequest',
  'HostHardwareResponse',
  'NetworkStateRequest',
  'NetworkStateResponse',
  'WifiScanRequest',
  'WifiScanResponse',
  'WifiJoinRequest',
  'WifiForgetRequest',
  'WifiChangeResponse',
  // Wi-Fi only on the manager socket (3.13, CT-1644).
  'CableSetRequest',
  'CableChangeResponse',
  // Tailscale on the manager socket (1.0, CT-1255).
  'TailscaleStateRequest',
  'TailscaleStateResponse',
  'TailscaleOnRequest',
  'TailscaleOffRequest',
  'TailscaleSignInRequest',
  'TailscaleCertRequest',
  'TailscaleCertResponse',
  // The tailnet's other devices (3.11, CT-1635).
  'TailscalePeersRequest',
  'TailscalePeersResponse',
  // Whombat Link and the update channel on the manager socket (4.4; Whombat whombat-link.md).
  'LinkStateRequest',
  'LinkStateResponse',
  'LinkOnRequest',
  'LinkOffRequest',
  'LinkClaimRequest',
  // The account's other Whombats (4.14).
  'RuntimeLinkWhombatsRequest',
  'RuntimeLinkWhombatsResponse',
  // Email through Whombat Link (4.15).
  'RuntimeLinkMailSetRequest',
  'RuntimeLinkMailSetResponse',
  'RuntimeMailSendRequest',
  'RuntimeMailSendResponse',
  'UpdateChannelRequest',
  'UpdateChannelSetRequest',
  'UpdateChannelResponse',
  'RuntimePushRegisterRequest',
  'RuntimePushRegisterResponse',
  'RuntimePushUnregisterRequest',
  'RuntimePushUnregisterResponse',
  // The network on the desk socket (0.102, CT-574).
  'DeskNetworkAnswer',
  'DeskWifiScanAnswer',
  'DeskWifiJoinRequest',
  'DeskWifiForgetRequest',
  'DeskWifiChangeAnswer',
  // The Bluetooth socket (0.109, CT-680, CT-681).
  'BluetoothStateAnswer',
  'BluetoothScanRequest',
  'BluetoothScanAnswer',
  'BluetoothDeviceRequest',
  'BluetoothConfirmRequest',
  'BluetoothCancelRequest',
  'BluetoothPairingAnswer',
  'BluetoothDeviceAnswer',
  'BluetoothAck',
  // Bluetooth on the desk socket (0.109, CT-684).
  'DeskBluetoothAnswer',
  'DeskBluetoothScanAnswer',
  'DeskBluetoothDeviceRequest',
  'DeskBluetoothConfirmRequest',
  'DeskBluetoothCancelRequest',
  'DeskBluetoothPairingAnswer',
  'DeskBluetoothDeviceAnswer',
  // The support socket (0.120, CT-938…CT-941).
  'SupportState',
  'SupportGrantRequest',
  'SupportStopRequest',
  'SupportVisitsAnswer',
  'SupportEventsAnswer',
] as const;

export const REGISTRY: readonly Entry[] = [
  { name: 'RelayHello', schema: RelayHello, go: 'protocol' },
  { name: 'RelayWelcome', schema: RelayWelcome, go: 'protocol' },
  { name: 'RelayIncoming', schema: RelayIncoming, go: 'protocol' },
  { name: 'RelayRefuse', schema: RelayRefuse, go: 'protocol' },
  { name: 'RelayDrain', schema: RelayDrain, go: 'protocol' },
  { name: 'RelayReady', schema: RelayReady, go: 'protocol' },
  { name: 'RelayDrainReason', schema: RelayDrainReason, go: 'protocol' },
  // The lease and its renewal on the control connection (4.5; Whombat whombat-link.md LNK-34).
  { name: 'RelayLease', schema: RelayLease, go: 'protocol' },
  { name: 'RelayRenew', schema: RelayRenew, go: 'protocol' },
  { name: 'RelayRenewed', schema: RelayRenewed, go: 'protocol' },
  { name: 'RelayRenewRefused', schema: RelayRenewRefused, go: 'protocol' },
  { name: 'RelayUpstreamMessage', schema: RelayUpstreamMessage, go: 'protocol' },
  { name: 'RelayDownstreamMessage', schema: RelayDownstreamMessage, go: 'protocol' },
  // The box's direct listener (HE-50, CT-1250).
  { name: 'DirectHello', schema: DirectHello, go: 'protocol' },
  { name: 'DirectWelcome', schema: DirectWelcome, go: 'protocol' },
  { name: 'DirectUpstreamMessage', schema: DirectUpstreamMessage, go: 'protocol' },
  { name: 'DirectDownstreamMessage', schema: DirectDownstreamMessage, go: 'protocol' },
  // Which box answers on a direct way, and its edition (1.1, CT-1300, CT-1301).
  { name: 'DirectIdentity', schema: DirectIdentity, go: 'protocol' },
  { name: 'AdmissionHeader', schema: AdmissionHeader, go: 'protocol' },
  { name: 'AdmissionClaims', schema: AdmissionClaims, go: 'protocol' },
  { name: 'Ed25519Jwk', schema: Ed25519Jwk, go: 'protocol' },
  { name: 'AdmissionJwk', schema: AdmissionJwk, go: 'protocol' },
  { name: 'AdmissionJwks', schema: AdmissionJwks, go: 'protocol' },
  { name: 'LicenceHeader', schema: LicenceHeader, go: 'protocol' },
  { name: 'LicenceLimits', schema: LicenceLimits, go: 'protocol' },
  { name: 'LicenceClaims', schema: LicenceClaims, go: 'protocol' },
  { name: 'LicenceKeySet', schema: LicenceKeySet, go: 'protocol' },
  { name: 'LicenceStatusResult', schema: LicenceStatusResult, go: 'protocol' },
  { name: 'ReleaseTuple', schema: ReleaseTuple, go: 'release' },
  { name: 'ProductManifest', schema: ProductManifest, go: 'release' },
  { name: 'HealthEvidence', schema: HealthEvidence, go: 'release' },
  { name: 'UpdateJournalRecord', schema: UpdateJournalRecord, go: 'release' },
  { name: 'AssignmentPayload', schema: AssignmentPayload, go: 'release' },
  { name: 'SignedAssignment', schema: SignedAssignment, go: 'release' },
  { name: 'AssignmentKeys', schema: AssignmentKeys, go: 'release' },
  { name: 'ClientBundle', schema: ClientBundle, go: 'release' },
  { name: 'ClientChannelPayload', schema: ClientChannelPayload, go: 'release' },
  { name: 'SignedClientChannel', schema: SignedClientChannel, go: 'release' },
  { name: 'DeviceRequestEnvelope', schema: DeviceRequestEnvelope, go: 'device' },
  { name: 'ClaimVerifierRegistration', schema: ClaimVerifierRegistration, go: 'device' },
  { name: 'NativePushRegistration', schema: NativePushRegistration, go: 'device' },
  { name: 'WebPushRegistration', schema: WebPushRegistration, go: 'device' },
  { name: 'PushVapidKey', schema: PushVapidKey, go: 'device' },
  { name: 'DeviceRegistration', schema: DeviceRegistration, go: 'device' },
  { name: 'DeviceRegistrationResponse', schema: DeviceRegistrationResponse, go: 'device' },
  ...(Object.entries(DEVICE_OPS) as [DeviceOp, { body: z.ZodType; response: z.ZodType }][]).flatMap(
    ([op, { body, response }]) => [
      { name: `${pascal(op)}Request`, schema: body, go: 'device' as const },
      { name: `${pascal(op)}Response`, schema: response, go: 'device' as const },
    ],
  ),
  ...LOCAL_SCHEMAS.map((name) => ({
    name,
    schema: new Map(Object.entries(local)).get(name) as z.ZodType,
    go: 'local' as const,
  })),
];

export const registryEntry = (name: string): Entry => {
  const entry = REGISTRY.find((e) => e.name === name);
  if (!entry) throw new Error(`no registry entry ${name}`);
  return entry;
};
