/**
 * The appliance's own audit events (the signed appliance log): ids, labels and fingerprints only, never secrets.
 * Provider sign-ins go through the `signins.*` ops (`api.signins`, CT-70).
 */
import { AuthModeName, SignInProvider, Timestamp } from '@whombat/core/domain';
import { AccountId } from '@whombat/core/ids';
import { z } from 'zod';

/* Appliance audit events (signed appliance log; ids, labels and fingerprints only, never secrets) ------------ */

export const APPLIANCE_EVENT_TYPES = [
  'appliance.claimed',
  'endpoint.enrolled',
  'endpoint.revoked',
  'endpoint.renamed',
  'pairing.approved',
  'pairing.rejected',
  'recovery.enrolled',
  'recovery.kit_verified',
  'recovery.used',
  'backup.destination_set',
  'backup.recovery_material_viewed',
  'backup.run_requested',
  // The passkey as the key to the backups (Whombat backup-passkey.md): a passkey's backup key kept or removed
  // (`{credentialId, accountId}`). Never the key.
  'backup.passkey_key_set',
  'backup.passkey_key_verified',
  'backup.passkey_key_removed',
  // The copy somewhere else (Whombat offsite-copy.md): the second place set or forgotten (`{provider, display}`). Never
  // the key.
  'backup.offsite_set',
  'backup.offsite_removed',
  'provider.signed_in',
  'provider.signed_out',
  // Diagnostic bundles (CT-52; `DiagnosticsAuditPayload`).
  'diagnostics.created',
  'diagnostics.downloaded',
  'diagnostics.deleted',
  'diagnostics.expired',
  // The appliance licence (LC-09; `LicenceAuditPayload`).
  'licence.state_changed',
  // Passkeys (0.50, CT-282; `PasskeyAuditPayload`, `PasskeysPolicyAuditPayload`). A device a passkey enrolled is
  // `endpoint.enrolled` with `via: 'passkey'` and the credential id. A device let in at the box's screen (0.106,
  // CT-627) is `endpoint.enrolled` with `via: 'screen'` (`ENDPOINT_ENROLLED_VIA`); no event of its own.
  'passkey.registered',
  'passkey.removed',
  'passkeys.policy_changed',
  // The box's Wi-Fi (0.102, CT-571; `NetworkAuditPayload`): a join that committed, a forget. Never the passphrase.
  'network.wifi_joined',
  'network.wifi_forgotten',
  // Wi-Fi only or the cable again (3.13, CT-1642; `CableAuditPayload`): a cable change the manager took.
  'network.cable_set',
  // The box's Bluetooth (0.109, CT-677; `BluetoothAuditPayload`): a pairing that reached `done`, a device removed.
  // Never the device's address (BT-10).
  'bluetooth.device_paired',
  'bluetooth.device_removed',
  // Remote help (0.120, CT-936; `RemoteHelpOnAuditPayload`, `RemoteHelpOffAuditPayload`, `RemoteHelpVisitAuditPayload`):
  // turned on or changed, off (and why), a visit. Never a help code or a certificate.
  'remote_help.on',
  'remote_help.off',
  'remote_help.visit',
  // Tailscale for This Whombat (1.1, CT-1306; `TailscaleAuditPayload`): an owner turned it on (and with which login
  // server), off (and whether the box left the tailnet), or asked for a fresh sign-in.
  'tailscale.on',
  'tailscale.off',
  'tailscale.sign_in',
  // Ask before updating (4.2; `UpdateAskAuditPayload`, `UpdateApprovedAuditPayload`): the owner turned it on or off, or
  // approved the release that waited for them.
  'update.ask_set',
  'update.approved',
  // Whombat Link and the update channel (4.4; `LinkAuditPayload`, `UpdateChannelAuditPayload`): the owner turned Link
  // on or off, control moved it (grace, ended, on again), the owner chose a channel.
  'link.on',
  'link.off',
  'link.state_changed',
  'update.channel_set',
  // Email through Whombat Link (4.15; `LinkMailAuditPayload`): the owner changed either choice.
  'link.mail_set',
  // The owner's own mail server (1.1, CT-1308; `MailAuditPayload`): set or replaced, removed. Never the password.
  'mail.set',
  'mail.removed',
  // Written until 3.0 (CT-1505): invites, owners and owner-assisted re-enrolment went. Kept so a signed appliance log
  // that has them stays readable (CT-1247's rule); nothing writes them.
  'invite.created',
  'invite.revoked',
  'owner.granted',
  'owner.revoked',
  'reenroll.created',
  'reenroll.accepted',
  'reenroll.completed',
  'reenroll.denied',
  'reenroll.revoked',
] as const;
export const ApplianceEventType = z.enum(APPLIANCE_EVENT_TYPES);
export type ApplianceEventType = z.infer<typeof ApplianceEventType>;

/** Payload of `provider.signed_in` / `provider.signed_out`: the person's account, which provider (OP-09). */
export const ProviderAuditPayload = z.object({
  provider: SignInProvider,
  authMode: AuthModeName,
  accountId: AccountId,
  verified: z.enum(['valid', 'unverified']).optional(),
  expiresAt: Timestamp.nullable().optional(),
  login: z.string().max(100).optional(),
});
