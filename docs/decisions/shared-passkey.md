# One passkey across Whombats

## SPK-01 — Shared owner identity

One discoverable passkey signs in to the cloud and opens every Whombat the person explicitly adds it to. A new credential uses `wo1:<base64url Ed25519 owner public key>` as its WebAuthn user handle. Existing `wb1:` credentials continue to work. This replaces PK-01’s per-appliance credential choice for new clients (John, 2026-11-04).

The client creates the owner seed. The passkey PRF wraps it with a credential-bound HKDF key. Control stores only the encrypted seed and an owner-signed directory containing the credential’s COSE public key and approved appliance identities. The authenticator’s user handle roots directory verification. A directory alone grants no access: each Whombat stores the credential only from an enrolled session and verifies fresh, session-bound WebAuthn assertions itself.

## SPK-02 — Explicit linking and independent keys

Adding or upgrading a passkey reuses the account’s newest shared credential, including when it is already linked locally. Linking to another Whombat requires an enrolled session there, a fresh assertion bound to that Whombat and session, and an owner-signed directory naming it. The same sign-in assertion can enroll the device on the signed directory’s Whombats, checking up to four Whombats concurrently so an offline one does not hold up the others. Each appliance receives only its own HKDF-derived backup key; PRF output and owner seed stay on the client. Removing the credential on one Whombat removes local access and recovery material only. Cloud removal remains a separate account-wide action. Retiring one Whombat does not retire a shared passkey. The additional-credential setup choice is superseded by SPK-05.

## SPK-03 — Safe upgrades and recovery proof

Old credentials without PRF cannot acquire it later in all providers, including 1Password. When no shared credential exists, a replacement uses a different owner user handle so creating it does not overwrite the old credential. An existing shared credential is reused. Existing access remains until SPK-05’s checks allow retirement or the person explicitly removes it. Missing PRF is distinguished from cancellation and failed decryption. No browser-brand inference is used.

Backups are verified by opening the stored recovery envelope and answering a short-lived encrypted challenge with
a fresh passkey evaluation. A new credential needs an evaluation after creation; an existing shared credential can
finish with its linking evaluation as specified in SPK-08. The server records verification only for the unchanged key and current envelope. Saving, waiting
for verification, and verified recovery are distinct. A successful touch or registration alone is not reported as
successful backup protection.

## SPK-04 — Superseded by SPK-07

Overview, Inbox, Devices and Backups share the passkey action's state for the current appliance session. When a touch reports that an upgrade is needed, every entry point offers “Upgrade my passkey” and its next click reuses the shared credential, creating one only when none exists. Status refreshes, moving between these screens and dismissing a prompt preserve that next step. A new passkey moves the action to verification. Concurrent touches and consolidation on the same appliance join the ceremony already running. Feedback stays visible in the Inbox item until recovery is verified; the phone does not close the item merely because a touch returned a message.

## SPK-05 — One permanent passkey and guarded retirement

John, 2026-11-05: one passkey for the account, every appliance and backups, without creating another item during an
upgrade. Setup and backup unlock prefer the same newest shared credential; cancellation, an unavailable provider or
a missing encryption key never create another credential as a fallback. An older sign-in-only key is excluded from
backup selection once a shared key exists. SPK-07 makes this the default setup action on web and phone, with a quiet recheck in Passkey details.

That explicit action checks every organization’s live appliances. It links the chosen credential only over an
already enrolled session whose identity matches this device’s pin, using a fresh appliance- and session-bound
assertion for each. For configured external backups it independently opens the saved envelope and answers the
verification challenge for that exact credential, even if another credential already made the aggregate status
verified. Temporary sessions have bounded connection waits and are always closed. Unpaired, offline, saving or
failed checks stay pending with a useful next step; no directory metadata alone authorizes access.

Older local credentials are removed through the existing appliance operations only after their scopes were checked.
Cloud retirement uses `auth.retirePasskey`, which under the kit-write account lock requires the unchanged older
directory, the replacement’s signed coverage of every checked old appliance, and no recovery envelope needing the
old key. Kit writes under that same lock require a credential still in the account, so a later stale write cannot
reintroduce a retired key. Any unresolved scope or older/retired recovery envelope keeps the old credential and says
so. The app says an old vault item is safe to delete only after retirement succeeded. WebAuthn removal signals are
advisory; Whombat cannot edit or delete an item in 1Password’s vault.

## SPK-06 — Bounded prompts with visible progress

John, 2026-11-05: completing two prompts then cancelling looked like an endless request for the newly created key.
When the signed directory already includes a Whombat, the fresh session-bound linking assertion also requests PRF
to open the owner seed. If the exact credential already has saved, current recovery details, prepare its verification
challenge before the touch and open that stored envelope with the same fresh evaluation. Confirm it without setting
the key again. Retrying that Whombat takes one provider request. The default setup action uses this direct check too.

A new directory scope still needs the owner seed before signing its linking challenge. SPK-08 supersedes the
requirement for another evaluation after arming backups with an existing shared credential. Missing PRF,
failed decryption, a refused or expired challenge and a changed envelope stop the check without fallback creation or
retirement. PRF output and owner seeds remain client-only, and transient byte buffers are wiped on every exit.

Before every provider request, web and phone show the Whombat, its place in the checks, and whether the touch
prepares access, checks access, or checks saved backups. The shared action state carries progress across screens.
Cancellation explicitly says the check stopped, how to resume, and that existing passkeys were kept; it never runs
the retirement phase. Browser journeys count actual WebAuthn requests and cover a cancelled backup check followed
by the one-prompt retry.

## SPK-07 — One default setup and one status

John, 2026-11-05: “Default and only behavior should be that a single passkey is used for login, unlock Whombat and
unlock backups. … Single passkey, period.” Overview, Devices, Backups, Inbox, the first-use nudge, restore completion
and recovery-kit setup use `setUpOnePasskey`. There is no separate sign-in-only registration, backup touch, upgrade or optional
consolidation action in the normal app. An existing shared credential is reused; a new one is created only when
there is none. Cancellation, an unsupported provider and failed checks never create another credential as fallback.

Web and phone share a session-scoped setup status read from the person's own appliance credentials, their account's
credentials, the live appliance directory and backup verification status. Without any passkey it says “Set up your
passkey” with “Set up my passkey”. A legacy credential, a shared credential not linked here, missing appliance scopes
or unverified backups say “Finish setting up your passkey” with “Finish setup”. A shared account credential remains
an existing passkey after local removal: finishing setup links it again rather than offering another creation.
Only completed setup says “Passkey ready”; without configured backups its words do not claim recovery was checked.
Pending checks on other appliances stay visible after navigation. Unknown or failed reads do not authorize creation.

Overview has one passkey row in Needs you, in Devices; backup readiness never adds a second competing passkey row
or a simultaneous ready claim at a glance. Devices has one summary and one setup button while needed. Individual
credential records, removal, device-bound policy and a recheck of a ready passkey are behind “Passkey details”.
Older credentials still needed by unresolved scopes or recovery envelopes remain under those details with the
existing guarded-retirement explanation. The app cannot remove their items from a password manager's vault.

All entry points join the same running ceremony and retain progress and feedback while navigating. Inbox completion
uses the structured setup result, never success inferred from a returned sentence. The cryptographic checks,
existing device enrollment, signed directory, exact-credential recovery proof and client-only PRF remain unchanged.
This replaces SPK-04 and the setup/status words and layout of AP-6970…AP-6975; necessary provider checks and optional
paper recovery remain available.

## SPK-08 — Finish existing passkey setup with one authorization

John, 2026-11-05: Finish setup asked twice for the existing 1Password passkey. Its fresh linking assertion already
opens the previously saved owner-seed envelope. This proves the credential reproduces its encryption key, even
when this Whombat has no backup envelope yet. Keep that output only inside this ceremony until the derived backup
key is saved and its current stored envelope and one-use, session-bound verification challenge have been opened.
Confirm the proof before reporting verified recovery; do not ask the provider again for this backup check.

An already stored backup envelope is checked directly without rewriting the key. If the new envelope is still being
saved, leave Finish setup pending with a saving message, without another prompt. A missing PRF, wrong owner seed,
changed salt, failed decryption or refused proof stops setup and preserves older credentials. Wipe the owner seed,
PRF output and temporary key copies on exit; persist none on the client. Each appliance still verifies its own
session-bound linking assertion. Creating a brand-new credential and adding a new signed appliance scope retain
their necessary creation and linking checks. This supersedes the extra backup evaluation in SPK-03 and SPK-06 for
existing shared credentials; it changes no wire contracts or server verification rules.
