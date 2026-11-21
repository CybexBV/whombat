# Factory reset, secure erase, refurbishment and ownership transfer

Decisions: NX-12, NX-13, NX-25. Tools: `whombat-secure-erase`, `whombat-factory-reset`, `whombat-storage-init`,
`whombat-storage-status` (package `whombat-appliance-tools`), reachable from the recovery environment (local
console) — the appliance has no remote shell.

## Cryptographic erase
All customer data is on the `whombat-persist` LUKS2 volume. `cryptsetup luksErase` destroys every keyslot and
token; without a keyslot the volume key cannot be recovered, so the ciphertext is unreadable regardless of SSD
wear levelling or remapped blocks. `blkdiscard` follows as best effort (it is not relied on). The system volume
(`whombat-root`) holds no customer data except the committed network configuration and the journal (metadata,
no content), which factory reset deletes; `--all` erases it too (decommission).

## Customer factory reset (you, at the console)
1. Power on holding Space → "Whombat Recovery" → **4 Factory reset**.
2. Type the disk recovery key (authorisation: only you hold it). Wrong key → nothing is erased.
3. The tool erases `/persist`, creates a new `/persist` sealed to this TPM (PCR 7 when Secure Boot is on),
   forgets the network configuration and the journal. VM-verified in `install-boot-luks` (old key no longer
   opens the volume, the new volume unlocks unattended, the appliance is unprovisioned).
4. The appliance is now **unprovisioned**: it has no identity, no claim secret, no recovery key. It must be
   provisioned again with a factory medium (new appliance id, new claim card, new disk recovery card). Until
   then no runtime, manager or helper runs.

Consequences you must know: backups are unaffected (they are off-device and encrypted with the key in
your recovery kit); control still lists the old appliance id as your org's device — you release
it in the hosted UI (control "release"), and an operator retires the old id.

## Self-installed: dedicated machine or virtual machine (host-encrypted storage; PI-02, PI-18, PI-21, NX-55, NX-91)
A self-installed Whombat (`whombat.platform = "self-installed"`, from the ISO; `proxmox-vm` before PI-22) has no LUKS volume and no TPM. The same
menu entries and tools work, with these differences:

- **Authorisation:** no disk recovery key (PI-19): type `ERASE` (reset) or `ERASE EVERYTHING` (secure erase); export,
  verify and network ask for `EXPORT`, `VERIFY`, `NETWORK`. A wrong word erases nothing. A box installed before PI-19
  whose key was confirmed at its console still asks for that key (checked against its Argon2id hash in
  `/persist/secrets/recovery-key.argon2id`); a wrong key erases nothing.
- **Erase:** every btrfs subvolume and file on `/persist` is deleted, the file system signatures are wiped and the
  partition is discarded (`blkdiscard`; on a VM with discard on, the host frees the blocks on thin storage), else
  zeroed. **This is not cryptographic erasure.** On a VM, copies in the hypervisor's snapshots and backups (e.g.
  Incus snapshots and exports, Proxmox VE snapshots and PBS/vzdump backups), replicas, and blocks the host storage hasn't
  reused yet survive it; destroy those on the host (delete the VM's snapshots and backups, or the whole encrypted
  dataset and its key) when the data must be gone. On a dedicated machine, blocks the disk hasn't reused may survive
  too; destroy the disk when the data must be gone.
- **Factory reset** creates a new empty btrfs `/persist` (no TPM seal), forgets the network, journal and helper
  records like on hardware. The box is unprovisioned and **provisions itself again** at the next boot: new identity
  (no recovery key), then a new claim code. It comes back with the same hardware serial, so control refuses its
  registration while the old record lives (CL-34) and lists it as a **pending re-registration** (UP-E5): in the admin
  panel “Reinstalled — retire the old record”, or `infra/hetzner/deploy.sh registrations` then `deploy.sh registrations
  retire-existing <id> <reason>` (in the private whombat-cloud repository). The box tries again within the hour (every 2 minutes, backing off to an
  hour); restart it to register now. Unclaimed registrations older than 14 days are deleted by retention.
- **Re-seal** (menu 3) does nothing on this platform.

Covered by `install-vm` (with an earlier image's key: wrong key refused, right key resets; without a key: a
wrong word touches nothing, `ERASE` resets); passed 2026-10-20 (NX-190).

## Ownership transfer
Because a reset appliance must be re-provisioned, a transfer goes through Whombat (refurbishment below) or a
provisioning station the new owner is sent. Keeping the identity across a reset would need a control API to
rotate the claim material bound to the device (device-signed) — not implemented; tracked as an open item.

## Refurbishment (Whombat, returned unit with working storage)
1. Recovery → **5 Secure erase everything** with `--factory` authority is only available to the station build
   (physical custody); otherwise the customer resets before returning (above).
2. Reinstall with the installer ISO (`docs/runbooks/provisioning.md` step 2): new LUKS volumes, new Secure Boot
   keys (reset the firmware keys to setup mode first), new identity at provisioning.
3. Retire the old appliance id at control.

## Decommission
Recovery → **5 Secure erase everything** (`whombat-secure-erase --all`): both volumes' keyslots destroyed; the
unit no longer boots into the appliance. Retire the id at control. For storage that cannot be erased because
it failed, see `rma.md`.
