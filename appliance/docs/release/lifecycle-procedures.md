# Key and ownership lifecycle procedures

Customer and operator procedures for the lifecycle events of requirement R-20 (assignment §5): key rotation,
staff departure, lost browser storage, a stolen device, ownership transfer, total loss of the appliance and loss
of the recovery kit. Each procedure names the decisions that implement it and the verification that exercised
it (`docs/implementation/verification.md`). **Not implemented** marks what doesn't exist; nothing is described as
working that wasn't built.

Decision prefixes: MA (architecture), MR (Whombat managed runtime, `docs/decisions/managed-runtime.md`), AP
(whombat-app `docs/decisions/app-managed.md`), CT (whombat-contracts), CL (control), NX (appliance
`docs/decisions/nixos.md`), BK (appliance `docs/decisions/backup.md`), PV (Whombat
`docs/decisions/managed-providers.md`), MG (appliance `docs/decisions/manager.md`).

Which identity is which (MA-03): **endpoint keys** (one per browser profile or app install) authenticate the person's
devices to the appliance; the **recovery key** (in the customer's kit) can enroll a new device of theirs and holds the
backup password; the appliance's **content identity** is what clients pin (its fingerprint is on the claim card);
its **management key** authenticates the box to control; the **disk recovery key** (disk recovery card) unlocks
the disks in the recovery environment. A cloud account only lets someone *find* the box; a cloud password reset
grants nothing on it (CL-13, MA-03; verified by the V-30 scenario “cloud-reset bypass: a new cloud session without local enrollment gets no content”).

## 1. Key rotation

### 1.1 Endpoint keys (a person's device)
- **Customer:** on the device, “Set up this device again” deletes its key and makes a new one, then pairs it
  through a device that is still trusted (the approver compares fingerprints, AP-37, AP-39). Then remove the old
  entry from the device list on any trusted device (`endpoints.revoke`).
- **Effect:** revocation bumps the account's authorization generation, closes the old key's sessions at once and
  makes compliant clients clear their caches (MR-12, AP-17); the appliance reports it to control as `pending`
  then `applied` (content-free mirror).
- **Implemented:** MR-10, MR-12, MR-32, AP-37, AP-39. **Verified:** V-30 scenarios (pairing with fingerprint,
  re-setup, revocation), V-24 (Android pairing; revocation from web clears the phone's cache), V-11 (revocation
  closes sessions in < 10 ms, applied at control).
- There is no scheduled rotation of endpoint keys; they're per device, non-extractable in browsers (WebCrypto,
  AP-20) and in the platform keystore on phones.

### 1.2 Recovery kit (recovery key)
- **Customer (with the current kit):** in the app, make a new kit: the app generates a new recovery
  key and the **current** kit's key signs it (`recovery.kit.rotate`); you save the new kit and confirm it
  by typing two groups back (`recovery.kit.confirm`). Until confirmed, the old key keeps working and the new one is
  pending. You are notified on your devices (content-free `security` push and a signed appliance event).
- **Implemented:** MR-25 (MA-19a, CT-45), AP-21, AP-32 (phone), web and phone screens. **Verified:** V-23 and
  V-30 runtime gates (`sec1.int.test.ts`: rotation needs the current key's signature; a malicious rotation
  is refused), V-30 “recovery-kit enrollment” scenario.
- Without the current kit, see §8.

### 1.3 Backup repository password
- Part of the kit (BK-15). You can display the backup section again (`backup.recoveryMaterial`, a query that never
  lands in a receipt, MR-19/MR-27). Rotating the restic key: **not implemented** as an
  operation (the custody table in the threat model names `restic key add/remove`; no op or runbook step exists).

### 1.4 Appliance content identity and management key
- **Not implemented** as an in-place rotation. Both are generated on the device at provisioning (MA-04, NX-24) and
  never backed up (BK-07). The only way to new keys is re-provisioning: factory reset (`factory-reset.md`) and a
  new provisioning run, or a replacement box (§7). Clients then re-pin the new content identity through the
  recovery-kit ceremony and trusted devices (`replacement.md` “identity-repin”; contract gap: a recovery-key-signed
  “appliance succession” statement).
- A compromised management key: control's operator **retires** the device (CL-23, final: its device API is
  refused), then re-provision. A device-signed rotation API in control (old key signs the new) is named in the
  threat model's custody table but **not implemented**.
- **Verified:** V-29 (reset + re-provision: the old key opens neither volume, N-7), V-19 (claim proof).

### 1.5 Cloud-side and release keys (operators)
- Admission signing keys (JWKS current/next/retired): control `docs/runbooks/key-rotation.md`, the relay
  `docs/runbooks/admission-key-rotation.md` (CL-07).
- Assignment keys (with ≥ 90-day grace for long-offline devices): `updates-release-signing.md`, CT-34/CT-35, MG-21.
- TUF root/targets/snapshot/timestamp: `updates-release-signing.md` (production ceremony not held yet, X-05).
- Push credentials (APNs/FCM/VAPID), operator tokens, OKMS certificates: control `key-rotation.md`,
  `incident-response.md`.
- Secure Boot keys are per device (NX-11); disk unlock policy key rotation revokes old generations (MA-21b).

## 2. Staff departure

A Whombat is one person's (Whombat one-person.md OP-01, OP-03, OP-11, 2026-10-25): nobody else has devices, a role or
sign-ins on it to remove, and there are no owner roles, burrow members or agents on a colleague's sign-in any more. When
the person leaves:

1. **The box** stays theirs, or goes to someone else as in §6 (export, release, factory reset, a new claim); it is never
   handed over with their data, devices or sign-ins on it.
2. **Their provider and GitHub sign-ins** on the box: they sign out first (`providers.logout`) and revoke the session or
   key at the provider, which is their account; the factory reset of §6 removes what is left.
3. **Control:** the organization has one account (Whombat OP-12): an operator **releases** the device (CL-23), so the
   old account gets no routing tickets for it.

**Implemented:** CL-13, CL-23, the factory reset (NX-25). *Superseded by Whombat OP-03 and OP-11 (2026-10-25): an owner
removing a colleague's devices, `admins.revoke` and last-owner protection (MR-22), burrow members, agents stopping with
`provider.owner_departed` and moving team agents (PV-05), GitHub reconnected with another person's sign-in (PV-06) and
org roles (CL-03).*

## 3. Lost browser storage or a lost device (own device, not stolen)

- **Another trusted device available:** on the new or wiped device, “Add this device” → pairing code and
  fingerprint → approve on the trusted device (AP-37, MR-10). Then remove the lost entry (`endpoints.revoke`).
- **No trusted device left, with the kit:** “Lost access? Use your recovery kit” on the new device: the kit
  signs a statement bound to this appliance, this device's key, your account, the time and a fresh
  nonce; the appliance enrolls the device into your account (AP-41, MR-25). The kit enrolls only into the account
  that set it up (MA-19a).
- **No trusted device and no kit:** nothing on the box admits a new device (§8). *Superseded by Whombat OP-11
  (2026-10-25): owner-assisted re-enrollment (MR-23's missing ceremony) and the workaround of an invite under a new
  account; there is nobody else on the box to ask.*
- **Verified:** V-30 scenarios b2 (pairing with fingerprint; a removed device pairs in again with a new key) and b3
  (the person enrolls with the kit; a statement for another account and an unconfirmed kit are refused), V-24 (Android
  pairing).

## 4. A stolen device (phone, laptop)

1. From any trusted device, remove the stolen device from the list (`endpoints.revoke`). If the thief is online,
   their session closes immediately; if offline, the revocation refuses them at the next connection and a
   compliant app clears its cache then (AP-17).
2. The appliance reports the revocation to control: you see **pending** until control has it, then
   **applied** (MR-12). Control can only add revocations, never remove them.
3. What can't be done: erase what was already on the device (downloaded files, cached views while the device is
   offline, anything the thief copied), or stop a modified client from keeping what it had. The app says so
   (AP-17; threat model T5).
4. If the device held provider sessions (a phone doesn't; provider sign-ins live on the appliance) nothing else is
   needed. If the person also used the device for their cloud account, they sign out of other sessions / change
   their email password: that protects routing tickets, not content (CL-13).
- **Verified:** V-11 and V-30 revocation scenarios; V-24 (revocation from web clears the phone's cache).

## 5. A stolen appliance

1. **Disks:** encrypted (LUKS2); the TPM releases the key only on the box's own measured normal boot path (PCR 7 +
   signed PCR 11 + PCR 15 for /persist, MA-21b). A thief who boots it normally gets a running appliance without
   any enrolled device of theirs; a thief who boots something else gets ciphertext. **Hardware behaviour is
   VM-verified only** (V-25/V-28/V-29 `recovery-tpm`, `install-boot-luks`; X-04).
2. **Operator:** retire the device in control (CL-23): no tickets, no claims, no updates for that id.
3. **Customer:** treat the box as lost (§7): replacement from backup in quarantine; and **rotate every credential
   the box held**, because relay revocation alone doesn't stop a running box from calling providers or GitHub
   directly (`replacement.md` §5): provider sessions/keys, GitHub tokens and app installations, the backup REST
   user for that box (storage side).
4. Backups are unaffected: append-only, off-device, encrypted with the kit's password (BK-09, T10).

## 6. Ownership transfer (the box to a new owner)

1. The current owner exports what they want to keep (`recovery-export.md`) and keeps their backups.
2. The current owner releases the device in the app / an operator **releases** it in control (back to unclaimed,
   CL-23; the org's log shows it).
3. Factory reset at the console (recovery menu **4 Factory reset**, disk recovery key): `/persist` is
   cryptographically erased and a new one sealed to this TPM; the box is now unprovisioned (`factory-reset.md`,
   NX-25). A previous owner's keys leave the system volume too (N-7, V-29).
4. Re-provisioning with a factory medium gives new identities, a new claim card and a new disk recovery card; this
   happens at Whombat (refurbishment) or at a provisioning station sent to the new owner.
5. The new owner claims it like a new box.
- **Not implemented:** keeping the device identity across a reset (a device-signed claim-material rotation in
  control), so a transfer always goes through re-provisioning (`factory-reset.md` “Ownership transfer”).
- **Verified:** V-29 (`install-boot-luks`: reset + re-provision, old key opens neither volume) — in VMs only.

## 7. Total loss of the appliance

`replacement.md` is the procedure; in short:
1. A new box with **fresh** identities (never restored, BK-07); claimed into the same org.
2. You join the existing backup repository with the kit (`whombat-backup destination adopt -kit …`).
3. Restore **in quarantine** (`quarantine apply`): every drill check first; database read-only; runner, schedules,
   automations, polls and pushes don't run while the marker exists (MR-20, BK-13).
4. Reconcile and record each item: old appliance (decommissioned or credentials rotated — required before
   release), revocations after the checkpoint (re-applied, using control's revocation mirror), endpoints reviewed,
   provider logins re-verified or re-done, external outcomes reconciled (nothing replays automatically), clients
   re-pin the new identity (yours via the recovery ceremony, your other devices through a trusted one).
5. `quarantine release`, then retire the old id in control.
- **Implemented:** BK-07, BK-12, BK-13, BK-15, MR-20. **Verified:** V-10 (`TestReplacementQuarantine`, drills,
  append-only qualification), V-30 slice C (verified backup checkpoint during drain). **Not verified:** the runtime's
  quarantine behaviour on a restored replacement end to end, and on real hardware.

## 8. Loss of the recovery kit

| Situation | What still works | What doesn't |
|---|---|---|
| Kit lost, you still have a trusted device | Everything day to day. Backups stay readable: you can display the backup section again (`backup.recoveryMaterial`) and save it as a new backup-only record. | **The recovery key can't be replaced**: rotation must be signed by the current kit (MR-25, by design so a hijacked session can't swap the recovery authority). There is also no op to revoke the lost key. Anyone who finds the kit *and* can open an enrollment session to the box (which needs a cloud account in the org, CL-06) could enroll a device into your account. **Not implemented:** revoking or replacing a lost recovery key without the old kit. |
| Kit lost and every device of yours lost | Nothing on the appliance can admit a new device. Backups: the backup password is gone with the kit, so they can't be read either. | The appliance's data is reachable only with the **disk recovery key** at the console (recovery menu **1 Export**, `recovery-export.md` `export-disk`), then a new appliance restored from that export (manual). |
| Kit lost and the box lost | Backups can't be decrypted without the kit's password. | Data is lost unless you had saved the backup section separately. |

Mitigations to tell every customer (pilot package): keep the kit in two places, have at least two live
devices, and record the backup section separately from the recovery key if their policy allows.

**Proposed follow-up (contracts first):** a delayed-and-notified recovery-key replacement for a lost kit (announced
on every device of yours, effective after a waiting period; an owner quorum needs several people, which a Whombat no
longer has, OP-01); it must not let a single compromised session replace the recovery authority silently.
