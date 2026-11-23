/**
 * Session error codes: the application's `ErrorCode` (same meaning as over REST) plus protocol codes.
 */
import { ErrorCode } from '@whombat/core/contracts';
import { ClientBuildNumber } from '@whombat/release';
import { z } from 'zod';

export const PROTOCOL_ERROR_CODES = [
  /** No common protocol major (`hello`). */
  'unsupported_version',
  /** First message was not `hello`, a message arrived out of order, or a frame broke the rules. */
  'protocol_error',
  /** A CONTROL message is not valid JSON or does not match its schema. */
  'invalid_message',
  /** `op` is not in the appliance's allowlist. */
  'unknown_op',
  /** The endpoint is not enrolled and `op` is not an enrollment/recovery operation. */
  'enrollment_required',
  /** A reused request id with a different digest (MA-09). */
  'idempotency_mismatch',
  /** The request's deadline passed before it was accepted; nothing was committed. */
  'deadline_exceeded',
  /** Cancelled before acceptance; nothing was committed. */
  'cancelled',
  /** Too many in-flight requests, open streams or subscriptions. */
  'too_many',
  /** The appliance cannot take work now (starting, draining for an update); retry later. */
  'unavailable',
  /** This endpoint or account was revoked (see the `revoked` message). */
  'revoked',
  /** A download/upload/export/collab/console stream could not be opened. */
  'stream_refused',
  /**
   * The appliance has the request id but can't give its outcome: a retry of a `secret` op whose result isn't kept
   * (CT-44: ask `status`, `outcome{redacted}`, and fetch state, or repeat the op with a new request id), or a command
   * that acted outside its commit (an outside effect) before its answer was lost, so it may have happened (CT-196).
   * For the latter `status` answers `outcome{state: rejected, error.code: unknown_outcome}`, which means unknown, not
   * rejected; a same-id retry gets `error{unknown_outcome}`. Clients never resend it by themselves and let a person
   * check the current state.
   */
  'unknown_outcome',
] as const;

type SessionErrorCodeName = (typeof ErrorCode.options)[number] | (typeof PROTOCOL_ERROR_CODES)[number];
/** `unavailable` is in both lists (REST's too since 0.80.1, CT-346, with the same meaning), so it is listed once. */
const SESSION_ERROR_CODES = [
  ...new Set<SessionErrorCodeName>([...ErrorCode.options, ...PROTOCOL_ERROR_CODES]),
] as [SessionErrorCodeName, ...SessionErrorCodeName[]];
export const SessionErrorCode = z.enum(SESSION_ERROR_CODES);
export type SessionErrorCode = z.infer<typeof SessionErrorCode>;

/** Codes after which retrying the same request id may succeed. */
export const RETRYABLE_ERROR_CODES: ReadonlySet<SessionErrorCode> = new Set<SessionErrorCode>([
  'rate_limited',
  'unavailable',
  'too_many',
  'internal',
]);

/**
 * Application error codes (CT-21). The protocol-level `error.code` stays one of `SessionErrorCode`; the
 * application's own, more specific code rides in `error.details.code`. Clients show the message and branch on
 * `details.code` when present. The set is open (a newer appliance may add codes); these are the known ones.
 */
export const APP_ERROR_CODES = {
  // Sessions and transfers.
  use_export_stream:
    'A `result` would exceed 64 KiB (`error.code: too_large`): read it through an export stream.',
  variant_unavailable:
    'A download asked for a `preview` the appliance can’t derive; it never sends the original instead.',
  upload_integrity:
    'An upload chunk or the whole file failed its sha256 check (`RESET integrity` on the stream).',
  client_below_security_floor:
    'This app build is below the appliance’s security floor (`unsupported_version`, `details.floor`): update the app.',
  // Claim and enrollment (MA-04).
  claim_used: 'The appliance is already claimed (`conflict`).',
  claim_invalid:
    'The confirmation didn’t match: wrong letters or card secret, or not this appliance (`forbidden`). Under `code` the console now shows new letters.',
  claim_not_ready:
    'The appliance can’t take a claim by this method yet: no claim code on its console (no lookup lease, or on a community box no letters drawn yet), or no card secret (`unavailable`).',
  claim_backoff:
    'Too many wrong claim attempts: `enroll.claim.begin` is refused until `details.retryAt` (`rate_limited`, `ClaimBackoffDetails`).',
  claim_begin_missing:
    'No live `enroll.claim.begin` for this session, claim id and method (it expired, was replaced or already used): begin again (`conflict`).',
  claim_share_invalid:
    'The PAKE share isn’t a ristretto255 element, or is the identity (`validation_failed`); not counted as an attempt.',
  claim_window_closed:
    'The physical claim window is required and closed: the person asks for new letters at the box’s own screen (`forbidden`).',
  claim_rate_limited:
    'Too many claims were begun in the last hour, or this device used its tries on the letters showing: the person asks for new letters at the box’s own screen (`rate_limited`).',
  // The claim on the box's own page (1.1, CT-1302).
  claim_local_unavailable:
    'This box isn’t claimed on its own page: only a community box takes `enroll.claim.local*`; a commercial one is claimed through control (`not_allowed`).',
  claim_start_missing:
    'No live `enroll.claim.local.start` with this claim id on this session: it expired, a newer start replaced it, or it was used (`conflict`).',
  claim_proof_missing:
    'No live proof on this session for this claim id (`enroll.claim.local.prove`): it ran out, was used, or never was. Enter the letters again (`conflict`).',
  claim_busy:
    'The box couldn’t finish a step of the claim in time (its database didn’t answer): nothing was tried and nothing claimed; try again (`unavailable`).',
  claim_update_app:
    'This app sends the person’s details before the box proved itself (a session below minor 1, or `enroll.claim.local` with `confirm`): update the app (`unavailable`).',
  // The claim at the box's own address (4.3; Whombat own-address.md).
  claim_link:
    'A door session to an unclaimed box that has its own address must carry the claim link’s secret, the one on the box’s screen: missing or wrong (`forbidden`). It never counts toward the claim backoff.',
  claim_here_unavailable:
    'This box is claimed only on a page it served itself (at its own address with the claim link, or on its local network or Tailscale with the letters): not through the relay or control (`not_allowed`).',
  endpoint_enrolled: 'This endpoint key is already enrolled.',
  dev_only:
    'Only a development runtime lets a device in with `enroll.dev`, and only from the machine itself (`forbidden`).',
  // Sign in at the box's screen (0.106, CT-624; `SCREEN_SIGNIN_ERROR_CODES`, `SCREEN_SIGNIN_ERROR_STATUS`).
  screen_unavailable:
    'The box can’t show a code: it isn’t claimed, or it has no screen to show one on (no console file) (`unavailable`).',
  screen_no_account: 'Nobody on this Whombat has that email (`enroll.screen.request`, `not_found`).',
  screen_signin_missing:
    'No live screen sign-in with this id for this device key: it expired, a newer request replaced it, or it was used (`conflict`).',
  screen_begin_missing:
    'No live `enroll.screen.begin` on this session for this sign-in, or only one made before a wrong guess: begin again with the letters showing now (`conflict`).',
  screen_code_invalid:
    'The confirmation didn’t match: wrong letters, or not this box (`forbidden`). One guess; the screen now shows new letters.',
  screen_backoff:
    'Too many wrong screen codes: refused until `details.retryAt` (`rate_limited`, `ScreenBackoffDetails`).',
  screen_share_invalid:
    'The screen sign-in’s PAKE share isn’t a ristretto255 element, or is the identity (`validation_failed`); not a guess.',
  screen_rate_limited:
    'Too many codes asked for: 5 per device key or 30 per box in an hour (`SCREEN_SIGNIN_REQUESTS_PER_KEY`, `SCREEN_SIGNIN_REQUESTS_TOTAL`; `rate_limited`).',
  account_exists: 'An account with that email already exists on the appliance.',
  pairing_code_invalid: 'No pending pairing with that code.',
  pairing_expired:
    'The pairing request expired; for `desk.pair` (0.100), the letters left the desk screen: start again (`expired`).',
  pairing_fingerprint_mismatch: 'The fingerprint doesn’t match the device that asked with this code.',
  // Adding a device of your own by a link (1.1, CT-1305).
  link_unavailable:
    'The box has no direct way to put in a link right now (no local-network address, Tailscale off) (`unavailable`).',
  link_invalid: 'The link’s secret doesn’t match a live device link (`forbidden`).',
  link_expired: 'The device link’s five minutes are over: make a new one (`expired`).',
  link_used: 'The device link was used already, or a newer one replaced it (`conflict`).',
  recovery_key_missing: 'The appliance has no recovery key.',
  recovery_statement_expired: 'The recovery statement is outside the time window.',
  recovery_statement_used: 'The recovery statement was already used.',
  recovery_signature_invalid: 'The recovery signature doesn’t match the recovery key.',
  recovery_not_kit_owner: 'A recovery statement enrolls only into the account of the Whombat’s person.',
  recovery_kit_unverified: 'The recovery kit isn’t confirmed, so it can’t enroll devices.',
  recovery_key_exists:
    'A recovery key exists; replace it with `recovery.kit.rotate` (signed by the current key).',
  recovery_rotation_invalid: 'The current recovery key’s signature over the new key doesn’t verify.',
  // The box's own address and linking it to the person's account (4.3; `ACCOUNT_LINK_ERROR_CODES`).
  own_address_unavailable: 'This Whombat has no own address (yet) (`unavailable`).',
  link_code_invalid: 'No live link code like that: check the code on your account’s page (`not_found`).',
  link_code_expired: 'The link code’s ten minutes are over: make a new one (`expired`).',
  link_code_used: 'The link code was used already (`conflict`).',
  link_other_account: 'This Whombat is already linked to another account (`conflict`).',
  link_devices_allowed: 'The account’s plan allows no more Whombats (`not_allowed`).',
  link_terms: 'The account hasn’t accepted the current Whombat terms yet (`not_allowed`).',
  control_unreachable: 'Whombat’s service didn’t answer: try again in a moment (`unavailable`).',
  // Choosing and changing the own address's name (4.16, session minor 6; `OWN_ADDRESS_RENAME_ERROR_CODES`).
  label_invalid:
    'Not a name an address can have: 3 to 32 lower-case letters, digits and single hyphens, starting with a letter (`validation_failed`).',
  label_reserved: 'That name isn’t given to anyone (`not_allowed`).',
  label_taken: 'Another Whombat has or had that name (`conflict`).',
  rename_limit: 'The address was changed 3 times in the last year already (`rate_limited`).',
  link_off: 'The address can be changed only while Whombat Link is on (`not_allowed`).',
  own_address_off: 'Whombat’s service gives no addresses here (`unavailable`).',
  address_moved:
    '`boxPasskey.register.begin` at the box’s earlier address: new passkeys are made only at its current address (`conflict`, `details.host`).',
  // Whombat Link and the update channel (4.4; `LINK_ERROR_CODES`).
  whombat_link_unavailable: 'This Whombat can’t use Whombat Link (`unavailable`).',
  whombat_link_busy: 'Whombat Link is changing already: wait a moment (`conflict`).',
  whombat_link_rate_limited: 'Too many tries to start Whombat Link: try again later (`rate_limited`).',
  update_channel_unavailable: 'This Whombat can’t choose where its updates come from (`unavailable`).',
  // Passkeys (0.50, CT-282).
  passkey_invalid:
    'The passkey didn’t verify (`forbidden`): unknown or removed, its account gone or disabled, a wrong signature, RP ID, origin, challenge or user handle, no user verification, a counter going backwards, or no live `passkey.register.begin`. One code for every reason.',
  passkey_not_allowed:
    'This Whombat accepts only passkeys that stay on one device (`not_allowed`, `passkeys.policy {deviceBoundOnly}`), and this one can sync.',
  passkey_limit: 'The account already has 20 passkeys on this Whombat (`conflict`); remove one first.',
  passkeys_unavailable_here:
    'A passkey ceremony from a page that can’t run one (`forbidden`): the box’s local-network page has no secure context, and on a commercial box passkeys belong to the hosted app’s name. A community box’s Tailscale page (HTTPS) can (1.1, CT-1309).',
  // Settings → Skills on Hermes's hub and guard (2.0, CT-1419; Whombat HSK-03, HSK-06, HSK-07). The archive codes
  // (`skill_archive_too_large`, `skill_staged_*`) went with `skills.stage` (CT-1430).
  skill_hub_unavailable:
    'Hermes’s hub didn’t answer, or this Whombat has no Hermes to ask (development’s scripted one) (`unavailable`): try again later.',
  skill_blocked:
    'Hermes’s scan and install policy refused the skill: a hub install or update, or an edit Hermes finds dangerous (`not_allowed`; `details {verdict, trust}`). There is no force.',
  skill_exists: 'A skill already has that name, or the hub skill is installed already (`conflict`).',
  // Diagnostic bundles (CT-52).
  diagnostics_limit: 'There are already 10 diagnostic bundles; delete one first.',
  // Remote help (0.120, CT-935; core `REMOTE_HELP_WORDS.refusals`).
  remote_help_unavailable:
    'Remote help isn’t available on this Whombat: no support service, or its image pins no support CA (`not_allowed`).',
  forever_not_allowed:
    'Forever is only for test Whombats: the support service refused `forever` on this image (`not_allowed`).',
  passkey_required:
    '`remoteHelp.start` without `passkey` from a person who has a passkey on this Whombat (`forbidden`): confirm with it.',
  passkey_failed:
    'The passkey didn’t confirm `remoteHelp.start` (`forbidden`): no live `remoteHelp.confirmBegin`, another level or duration, not the person’s passkey, or a failed check. One code for every reason.',
  remote_help_busy: 'The support service didn’t answer in time (`unavailable`); try again in a moment.',
  // The last device (MA-10; since 3.0 without owners, CT-1509): `last_owner_endpoint` until 3.0.
  last_endpoint: 'This is your last device: add another one before you remove it.',
  // The desk screen (0.100, CT-525; `DESK_ERROR_CODES`, the words in core's `DESK_WORDS.errors`).
  wrong_code:
    'The letters typed for `desk.pair` don’t match the desk screen’s (`forbidden`, `details.triesLeft`); after five wrong tries the screen shows new letters.',
  not_paired:
    'Nobody paired the desk screen (`conflict`); for `host.bluetooth.connect`, `disconnect` and `forget` (0.109), the box isn’t paired with that device.',
  not_paired_person: 'Only the person the desk screen is paired with can do that (`forbidden`).',
  request_expired:
    'The desk screen’s unlock request ended: two minutes passed, it was answered, or the screen locked again (`expired`).',
  no_screen: 'No screen is connected, so `desk.setScreen` can’t turn it on (0.101, `conflict`).',
  no_pin:
    'The desk screen has no PIN yet, only the phone unlocks it; the desk socket’s answer to an unlock with a PIN (0.101, `conflict`).',
  easy_pin:
    'The PIN for `desk.pair` or `desk.setPin` is too easy to guess: one digit repeated, a run up or down, a pair or three digits repeated (core `deskPinTooEasy`; 0.103, `validation_failed`).',
  no_voice:
    'A voice the desk screen doesn’t have, or a sample when the box can’t speak now (0.105, `conflict`).',
  unknown_screen: 'No screen with that id: it was removed, or a monitor was never seen (3.6, `not_found`).',
  screens_full: 'There are already as many screens as a Whombat keeps; remove one first (3.6, `conflict`).',
  bad_layout:
    'A layout with a widget outside its grid, on another, or naming the wrong kind of thing (3.6, `validation_failed`).',
  // Backup (owner ops, MR-19).
  backup_unavailable: 'The appliance has no backup service (`not_allowed`).',
  backup_destination_failed:
    'The destination could not be configured (unreachable, wrong password, foreign repository).',
  backup_unprotected:
    'No destination is configured, so no checkpoint can be taken (412 from the backup service).',
  backup_busy: 'Another backup operation is running (409 from the backup service).',
  backup_failed:
    'The checkpoint failed; `details.stage` says where (preflight, quiesce, snapshot, dump, upload, verify).',
  // Backup files (0.79, CT-335; core `BACKUP_FILE_ERROR_CODES`, the sentence in `BACKUP_FILE_ERROR_TEXT`).
  'backup_file.password_too_short': 'The password is shorter than 10 characters (`validation_failed`).',
  'backup_file.wrong_password':
    'The password doesn’t open the file: its key check failed (`validation_failed`).',
  'backup_file.damaged':
    'The file is damaged or incomplete: a chunk didn’t authenticate, it ends early, or its header, archive or a record is broken (`bad_request`).',
  'backup_file.newer_format': 'A newer Whombat made the file: update this one first (`bad_request`).',
  'backup_file.not_backup_file': 'The file isn’t a Whombat backup file (`bad_request`).',
  'backup_file.too_large': 'Larger than a backup file may be, 10 GiB (`too_large`).',
  'backup_file.no_room':
    'Not enough free disk for the file, or for the upload and what it restores (`too_large`).',
  'backup_file.expired':
    'The backup file is past its 24 hours or was removed (`expired`; also a refused `backup-file` download stream).',
  'backup_file.upload_expired': 'The staged upload is past its 24 hours, used or removed (`expired`).',
  'backup_file.upload_incomplete': 'Inspect or restore before the upload finished (`conflict`).',
  'backup_file.upload_mismatch':
    'A chunk doesn’t start where the upload is (`details.received`), or the bytes don’t match the staged size or sha256 (`conflict`; also a refused `backup-file` upload stream).',
  'backup_file.nothing_chosen': 'No category chosen (`validation_failed`).',
  'backup_file.not_in_file': 'A category to restore isn’t in the file (`validation_failed`).',
  'backup_file.busy': 'A backup file is being made in this burrow already (`conflict`).',
  'backup_file.restore_running': 'A restore is running in this burrow already (`conflict`).',
  'backup_file.too_many': 'Too many backup files or uploads kept: remove one first (`conflict`).',
  'backup_file.people_only': 'Only the person makes and restores backup files, not the agent (`forbidden`).',
  'backup_file.failed': 'Making the file stopped (a job’s `error`).',
  'backup_file.restore_failed': 'The restore stopped part-way; what came back stays (a job’s `error`).',
  // Servers and their consoles (0.80.1, CT-346, CT-350).
  hosts_unavailable:
    'Whombat’s server monitoring (the hosts service) isn’t there or isn’t answering (`unavailable`, 503; also a refused `console` stream).',
  console_refused:
    'A `console` stream was refused: the token was used already, is older than 30 seconds or isn’t this person’s and session’s, or the hosts service turned the console down (`forbidden`; open the console again with `hosts.createConsole`).',
  // Servers: Incus and unRAID (0.83, CT-367; the words are `HOST_ERROR_WORDS`).
  self_guest:
    'A change to the guest this Whombat runs in, which only `HOST_SELF_GUEST_ALLOWED` allows (`conflict`, 409).',
  in_use:
    'A profile, volume or image something still uses can’t be removed (`conflict`, 409); for `host.wifi.forget` (0.102), the box depends on that network and nothing else works.',
  // The box's Wi-Fi (0.102, CT-569; `WIFI_ERROR_CODES`, `in_use` above).
  no_wifi: 'The box has no working Wi-Fi card (`not_allowed`; `HostNetwork.wifiMissing` says why).',
  busy: 'A Wi-Fi change is running on the box, or a Bluetooth pairing (0.109); wait for it to end (`conflict`).',
  not_saved: 'The box doesn’t know that Wi-Fi network, so there is nothing to forget (`not_found`).',
  // Wi-Fi only and the cable again (3.13, CT-1642; `CABLE_ERROR_CODES`, `busy` and `no_wifi` above).
  not_connected: 'Wi-Fi only was asked while the box’s Wi-Fi isn’t on a network (`conflict`).',
  no_cable: 'The cable was asked for while no cable is plugged in (`conflict`).',
  unchanged: 'The box already uses what was asked (`conflict`).',
  invalid_passphrase:
    'Not a Wi-Fi password (8 to 63 characters, or 64 hex digits), one for an open network, or none for a secured network the box doesn’t know (`validation_failed`).',
  // The box's Bluetooth (0.109, CT-675; `BLUETOOTH_ERRORS`, `busy` and `not_paired` above; `not_found` and
  // `unavailable` ride on their namesakes).
  no_bluetooth:
    'The box has no Bluetooth adapter, or it is switched off (`not_allowed`; `BluetoothState.missing` says why).',
  // Provider sign-ins and credentials (MA-10, MA-17).
  'managed.provider_gated':
    'This provider mode is gated on a managed appliance (`details.managed: true, reason: "<provider>:<mode>"`).',
  'managed.provider_excluded':
    'This provider mode is excluded by policy (`details.reason: "<provider>:<mode>"`).',
  'provider.login_unavailable': 'This sign-in mode can’t start here.',
  'provider.not_configured': 'The provider isn’t set up on this appliance.',
  'provider.login_not_found': 'No such sign-in attempt (or not yours).',
  'provider.login_not_waiting': 'The sign-in attempt isn’t waiting for that step.',
  'provider.login_expired': 'The sign-in attempt expired.',
  'provider.login_failed': 'The provider’s CLI refused the sign-in (its reason in the message).',
  'provider.login_denied': 'The sign-in was denied on the provider’s page.',
  'provider.login_disabled': 'Device sign-in isn’t enabled in the account’s security settings.',
  'provider.login_network': 'The appliance couldn’t reach the provider.',
  'provider.login_missing': 'The sign-in finished but left no credential.',
  'provider.login_cancelled': 'The sign-in was cancelled.',
  'provider.secret_invalid': 'The key or token was refused by the provider’s check.',
  'provider.token_creator_required': 'An access token needs “I created this token”.',
  'provider.token_expiry_required': 'An access token needs an expiry within 90 days.',
  'provider.signin_unavailable': 'The runner didn’t answer the sign-in step (try again).',
  // AI clients (CT-72): installing, updating and removing Claude Code and Codex.
  'client.unavailable':
    'No tested version of this client for this machine (its platform, or this Whombat’s adapter), or the tested versions couldn’t be fetched.',
  'client.busy': 'The client is being installed or removed; try again when that finished.',
  'client.install_failed':
    'Installing the client failed (the reason in the message); what was installed still runs.',
  'client.digest_mismatch': 'The downloaded client didn’t match its tested digest, so nothing was installed.',
  'client.host_managed': 'This client came with the host (self-hosted), so Whombat doesn’t remove it.',
  'client.not_installed':
    'The agent’s client isn’t installed on this Whombat (a turn refusal; the person installs it).',
  // The sign-in console (CT-71).
  'provider.console_not_found': 'No such sign-in console (or not yours).',
  'provider.console_ended': 'The sign-in console isn’t running any more (its state says why).',
  'provider.console_input_gap':
    'A console write skipped a `seq` (`details.inputSeq` is the last one applied); resend from there.',
  'provider.not_signed_in': 'The turn’s credential owner hasn’t signed in to the provider.',
  'provider.owner_required': 'The agent has no credential source chosen.',
  'provider.requester_not_signed_in':
    'The person this work is for hasn’t signed in to the agent’s provider (the explanation is meant for them; CT-69).',
  'provider.no_requester':
    'The work is for nobody (system work, a visitor’s report) and the agent’s `requester` source has no organization fallback.',
  'provider.owner_departed': 'The credential owner left the burrow or the appliance.',
  'provider.auth_expired': 'The sign-in expired.',
  'provider.auth_revoked': 'The provider revoked the sign-in.',
  'provider.quota_exhausted': 'The sign-in’s quota is exhausted.',
  'provider.outage': 'The provider is unavailable.',
  'provider.version_drift': 'The provider CLI version differs from the pinned runtime.',
  // The AI gateway (0.76, CT-332; Whombat ai-gateway.md AIG-12): a turn whose tool goes through the gateway is refused
  // before it runs; a missing or silent gateway only when none of the person's own subscriptions can take the turn
  // (`GATEWAY_REFUSAL_CODES`, `gatewayRefusalText` in core).
  'gateway.missing': 'The burrow’s AI gateway connection is gone or has no usable key.',
  'gateway.unreachable': 'The burrow’s AI gateway doesn’t answer (two polls in a row failed).',
  'gateway.used_up':
    'Every enabled account of the tool’s provider in the AI gateway is used up (until the earliest reset).',
  // Guide cards in a person's Chat (AG-03, CT-81): `guides.act` refusals (`GuideErrorCode` in core).
  guide_closed: 'The guide card was already answered or expired (`conflict`): show the locked card.',
  not_yours: 'Only the person whose Chat it is can act on its guide cards (`forbidden`).',
  invalid_values:
    'A guide form value is missing or wrong (`validation_failed`); `error.fields` is keyed by field id.',
  google_admin_only: 'Saving the Google client needs an admin of this Whombat (`forbidden`).',
  google_app_in_config:
    'The Google client is set in this Whombat’s config, so it can’t be saved here (`conflict`).',
  google_unavailable: 'Google connect is off on this Whombat (`not_allowed`).',
  // The appliance licence (LC-10, CT-77): `lapsed` and `limit` with `error.code: not_allowed`.
  'licence.lapsed':
    'The subscription ended, so the agent and automations are paused (new agent turns, AI search, new connectors). Reading and exporting still work.',
  'licence.limit':
    'The plan’s limit is reached for adding one more: `details` is `LicenceLimitDetails {code, limit: connectors, allowed}`. Nothing is removed when a plan shrinks.',
  'licence.renew_failed':
    '`licence.refresh` couldn’t renew (`unavailable`): control was unreachable or refused (`details.reason`: the manager’s error, e.g. `unreachable`, `device_unclaimed`, `device_revoked`, `devices_allowed_reached`); the stored state is unchanged. A second request within 60 s gets `rate_limited`.',
  // Tailscale for This Whombat (1.0, CT-1254; `TAILSCALE_ERROR_CODES`).
  'tailscale.unavailable':
    'No manager to ask about Tailscale (a development runtime), or it didn’t answer (`unavailable`).',
  'tailscale.busy': 'A Tailscale change is running: wait for it to end (`conflict`).',
  // Web Push from the box itself (1.1, CT-1307).
  'push.web_unavailable':
    'The box has no Web Push key of its own (a commercial box tells phones and browsers through control), so `devices.vapidKey` has nothing to give (`not_allowed`).',
  // The owner's own mail server (1.1, CT-1308; `MAIL_ERROR_CODES`).
  'mail.in_config':
    'This Whombat’s configuration sets the mail server (development’s Mailpit), so it can’t be changed or removed here (`conflict`).',
  'mail.not_set': 'No mail server is set to test: send the settings to try with the test (`conflict`).',
  'mail.busy': 'A mail test is running: wait for it to end (`conflict`).',
  // Managed-mode refusals (MA-10): `managed.<capability>` with `details.managed: true, reason: <capability>`.
  'managed.feedback_intake': 'Public feedback intake is unavailable on a managed appliance.',
  'managed.automation_webhooks': 'Inbound webhooks are unavailable on a managed appliance.',
  'managed.google_connect':
    'Connecting a Google account is turned off by this managed appliance’s policy (on by default since AG-14).',
} as const;
export type AppErrorCode = keyof typeof APP_ERROR_CODES;
export const AppErrorCode = z.enum(Object.keys(APP_ERROR_CODES) as [AppErrorCode, ...AppErrorCode[]]);

/** `error.details.code` values are `lower_snake` with optional dot-separated namespaces. */
export const AppErrorCodeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);

/** The application code of an error's details, or null (unknown codes are returned too: the set is open). */
export function appErrorCode(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && AppErrorCodeName.safeParse(code).success ? code : null;
}

/**
 * `error{code: 'unsupported_version'}` details: which majors the appliance speaks and its own version. A client
 * below the running release's security floor (CT-53) gets the same error with `code: client_below_security_floor`
 * and `floor {platform, minBuild}`; the protocol versions may well overlap.
 */
export const UnsupportedVersionDetails = z.object({
  supported: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  appliance: z.object({ major: z.number().int().min(1), minor: z.number().int().min(0) }),
  code: AppErrorCodeName.optional(),
  floor: z
    .object({
      platform: z.enum(['web', 'android', 'ios', 'desktop', 'cli']),
      /** The lowest build number the appliance serves on this platform. */
      minBuild: ClientBuildNumber,
    })
    .optional(),
});
export type UnsupportedVersionDetails = z.infer<typeof UnsupportedVersionDetails>;

/**
 * Which side must update: the client when it is below the security floor (CT-53) or its newest major is below `min`;
 * otherwise the appliance (the client is above `max`).
 */
export function whoMustUpdate(
  clientMajors: readonly number[],
  details: UnsupportedVersionDetails,
): 'client' | 'appliance' {
  if (details.code === 'client_below_security_floor') return 'client';
  return Math.max(...clientMajors) < details.supported.min ? 'client' : 'appliance';
}

/** Managed-mode refusal details (`error.code: not_allowed`). */
export const ManagedRefusalDetails = z.object({
  code: AppErrorCodeName,
  managed: z.literal(true),
  reason: z.string().min(1).max(64),
});

/** `managed.<snake_case capability>` for a managed-policy key (`feedbackIntake` → `managed.feedback_intake`). */
export function managedErrorCode(capability: string): string {
  return `managed.${capability.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}
