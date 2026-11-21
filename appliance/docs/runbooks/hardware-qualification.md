# Hardware qualification (appliance host)

Three kinds of host, each with its own rows: the factory platform, a Whombat device with a TPM (HQ rows, below); a
self-installed Whombat on a dedicated machine (SQ rows, “Dedicated machines”, the main target for self-installation,
PI-21); a self-installed Whombat in a VM (PQ rows, “Virtual machines”).

**Status: NOT RUN.** No sold hardware exists yet (blocker X-04). Nothing below has been executed on hardware,
and no VM result substitutes for it: VM tests (`vm-tests/`) prove the software paths (boot counting logic, TPM
policy with swtpm, LUKS, Secure Boot enrolment in OVMF), not firmware, real TPMs, watchdog silicon, power loss
or thermals. Every row in the record sheet starts as `NOT RUN`.

## Units and build

- At least **3 units** of the exact SKU (board, firmware version, NVMe model, RAM), plus 1 spare NVMe.
- A qualification build: the appliance system with `whombat.environment = "dev"` and
  `whombat.qualification.consoleShell = true` (root shell on the local console only; asserted off for prod;
  scripts at `/etc/whombat/qualification-scripts`). Install with the installer ISO exactly like the factory
  (`docs/runbooks/provisioning.md`), provision against the dev control.
- Equipment: switched PDU (or a person with a stopwatch at the plug), USB keyboard + display, a `WBFACTORY`
  FAT stick for evidence (`hq-export.sh`), an external host on the same LAN with `nmap`, a thermometer for
  ambient.
- Firmware setup: set a firmware administrator password; leave Secure Boot in **setup mode** before the first
  appliance boot (the device enrols its own keys, NX-11); disable network/USB boot after installation.

## Procedures

Each script writes evidence to `/persist/hq/<serial>/<test>/<timestamp>/` and a `result.tsv` line. `PASS`
from a script only covers what it can observe; items marked `INCONCLUSIVE` need the operator's observation
(timings, console messages) written into the record sheet.

| ID | What | How | Pass criteria |
|---|---|---|---|
| HQ-00 | Baseline | `hq-baseline.sh` after provisioning | Secure Boot `enabled (user)`; both LUKS volumes list `tpm2` (PCR 7) + `password` slots; `/var/lib/whombat-storage/tpm-seal` = `pcrs=7`; `wdctl` shows a device owned by systemd with 30 s timeout; no failed units |
| HQ-01 | Watchdog | `hq-watchdog.sh arm` (kernel hang, `panic=0`); after the reset `hq-watchdog.sh verify` | Unit resets by itself within 60 s of the hang (stopwatch), boots the same generation, `/persist` unlocks unattended. Repeat 5× per unit |
| HQ-01b | PID 1 / userspace hang | Hold `SIGSTOP` on journald + fill memory (`stress-ng --vm` in `whombat-tasks.slice`) | Critical slice keeps PostgreSQL and manager alive (oomd kills in tasks slice only); no reset needed |
| HQ-02 | TPM unlock and changes | `hq-tpm.sh record` before/after each change: (a) firmware update to the next vendor release, (b) Secure Boot dbx update, (c) toggle Secure Boot off/on, (d) TPM clear in firmware, (e) move the NVMe to a second unit | (a)/(b): either unattended unlock, or the console asks for the recovery key and the recovery environment "Re-seal" restores unattended unlock next boot. (c) off: must **not** unlock unattended. (d)/(e): must not unlock unattended; the recovery key unlocks; re-seal on the new TPM works. Record PCR 7 values each time |
| HQ-03 | Secure Boot enforcement | `hq-secureboot.sh plant`, reboot, `hq-secureboot.sh verify`; then boot a Microsoft-signed foreign USB image (e.g. a distro with shim) | Unsigned entry refused; foreign image may boot (MS keys enrolled for option ROMs) but must **not** unlock either volume (PCR 7 differs) — check with its own `cryptsetup open` attempt |
| HQ-03b | Boot counting on hardware | Install a candidate whose assessment fails (qualification build with `/run/whombat-standin/unhealthy`), as in `vm-tests/install-boot-luks.nix` | After `tries` attempts the known-good generation boots unattended; candidate entry named `+0-N`; both generations unlocked unattended |
| HQ-04 | Power loss at each update transition | Real manager build required (W1-MG). For each state `Downloading, Verified, Staged, WaitingForSafeBoundary, Activating, Verifying, Healthy` and for host activation (`activate-host-on-reboot` before and after `switch-to-configuration boot`): `hq-powerloss.sh watch <State>`, cut power at the printed moment, restore, `hq-powerloss.sh verify`. Also cut power during `nix-store --import` and during an ESP write | Manager resumes or rolls back per its journal (never a half-activated runtime); ESP still boots (vfat damage → systemd-boot fallback entry works); PostgreSQL recovers, every acknowledged commit present (compare with the runtime's receipts); no fsck prompt. 10 cuts per state across the 3 units |
| HQ-05 | Storage | `hq-storage.sh`; fill `/persist` (as in the VM disk-full test); pull power during heavy fsync load; spare NVMe: simulate failure by removing it hot, then boot | TRIM passes through dm-crypt; write cache flushes honoured (no lost acknowledged commits across HQ-04); ENOSPC keeps PostgreSQL writing; missing disk → device shows the initrd reboot loop / console message, no data corruption on reinsertion |
| HQ-06 | Thermals | `hq-thermal.sh 3600` in the retail enclosure at 35 °C ambient | No thermal throttling of the CPU below the sustained target; NVMe below its throttle temperature; no resets |
| HQ-07 | Network | `hq-network.sh`; external `nmap -Pn -sT -p- <unit>`; unplug 60 s; DHCP server off; IPv6-only network; static candidate via the manager's network change with a wrong gateway | No open port; relay reconnects within 2 min of link return; wrong candidate reverts by the dead-man within `confirmTimeoutSec + 30 s` |
| HQ-08 | Clock | Remove the RTC battery (if any), boot offline, then online | Clock never before the last timesync floor; TUF refresh refuses stale metadata until time sync; no expired-metadata acceptance |
| HQ-09 | Recovery environment | Hold Space at power-on, choose "Whombat Recovery" | Boots only while signed (HQ-03 applies to it too); every data action asks for the recovery key; network off until enabled |

## Record sheet

One row per (test, unit, run). Keep it with the evidence tarball from `hq-export.sh`.

```
test_id | unit_serial | sku | firmware | appliance_generation | date_utc | operator | steps_done | expected | observed | evidence_path | result
HQ-00   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-01   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-01b  |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-02a…e|             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-03   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-03b  |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-04-* |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-05   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-06   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-07   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-08   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
HQ-09   |             |     |          |                      |          |          |            |          |          |               | NOT RUN
```

`result` ∈ `PASS`, `FAIL`, `NOT RUN`. A row is `PASS` only with evidence from real hardware of the sold SKU.
Any `FAIL` blocks release (R-55, R-56, R-57) until fixed and re-run on all units.

## Dedicated machines (PI-18, PI-21, PI-22; NX-92, NX-189, NX-190)

**Status: NOT RUN** on any real machine. A self-installed Whombat on a machine of its own (a mini PC, a desktop, a small
server, a laptop on its charger) is the first target for self-installation; it is supported, not qualified. What has
run is QEMU: the VM test `install-machine` installs the ISO's image with `whombat-install` and boots it on NVMe with an
Intel e1000e card on DHCP, no virtio disk or network, no i6300esb and no guest agent; the Intel TCO watchdog (q35's
ICH9) is the only one, PID 1 pets it, and a system that stops petting it is reset. That proves the image's paths, not
firmware, graphics, network silicon, a real TPM-less board's watchdog or power.

### The machine

| Setting | Value | Why |
|---|---|---|
| CPU | x86_64, 4 cores (2 at least) | the installer warns below 4; VT-x/AMD-V not needed (the agent's containers are rootless Podman, NX-457) |
| Memory | 8 GiB (16 GiB when the agent runs containers) | as install.md §1 |
| Disk | one internal disk ≥ 110 GiB: NVMe, SATA or eMMC (also NVMe behind Intel VMD) | USB drives are never offered |
| Network | a wired card (or a USB Ethernet adapter) on the LAN, DHCP; or Wi-Fi (WPA2/WPA3 Personal or open, iwd) | a cable wins when both work (route metric 100 against Wi-Fi's 600, NX-241); company (802.1X) Wi-Fi can't be joined yet |
| Firmware | UEFI, Secure Boot **off**, power on after a power loss | the boot loader and boot counting need UEFI; the keys stay unenrolled (NX-52); the box comes back after a power cut |
| Watchdog | the chipset's: Intel TCO (`iTCO_wdt`) or AMD SP5100/FCH (`sp5100_tco`) | PID 1 pets it (`RuntimeWatchdogSec` 30 s, NX-05, NX-189) |
| Display | the built-in graphics (Intel, AMD, NVIDIA) and a monitor for the install and the claim | the graphical console; no display: the text console within 15 s (NX-83) |

### Procedures

With a qualification build (`whombat.qualification.consoleShell`) where a script is named; the rest with the ISO as
shipped. One run per machine model.

| ID | What | How | Pass criteria |
|---|---|---|---|
| SQ-00 | The machine | `lscpu`, `lsblk -o NAME,TRAN,MODEL,SIZE`, `lspci -nnk`, the firmware's version and settings (a photo) | the table above; Secure Boot off; power on after a power loss set |
| SQ-01 | Install and first boot | install.md §4, §6, §7 from a USB stick | the installer offers the internal disk, not the stick; `whombat-install` reports `installing Whombat on /dev/<disk>`; the machine boots from the disk without the stick; `bootctl status` shows `Secure Boot: disabled (setup)`; no failed units |
| SQ-02 | Graphics | the console on the machine's own display, then with no monitor at boot | the claim code on the graphical console; without a display the text console within 15 s |
| SQ-03 | Network | `ip -4 addr`, `ethtool -i <nic>`; unplug the cable 60 s; the claim from a phone on the same LAN | an address by DHCP; the driver named in the sheet; it comes back after the cable returns; the claim works (CC-13) |
| SQ-04 | Watchdog | `wdctl`; `hq-watchdog.sh arm`, as HQ-01 | one watchdog, the chipset's, owned by systemd with a 30 s timeout; the machine resets by itself within 60 s of the hang and boots the same generation. 3× |
| SQ-05 | Power loss | pull the plug during a runtime update, during `nix-store --import`, during an ESP write, and once idle | as HQ-04: the manager resumes or rolls back; the ESP still boots; PostgreSQL recovers; the machine powers on by itself when the power returns |
| SQ-06 | Power button, lid | a short press of the power button (on a laptop: holding it; a short press only wakes the screen); on a laptop also close the lid, then pull the charger for 5 minutes | the button shuts it down cleanly (journal: PostgreSQL stopped); the lid changes nothing; on battery it keeps running and the app says so (DK-10, DK-11) |
| SQ-07 | Host update, boot counting | a host release with a failing assessment (as `install-vm`), then a good one | the failing one falls back to the known-good after `tries`; the good one is blessed; nobody at the console |
| SQ-08 | Factory reset | recovery menu (hold Space) → 4, a wrong word, then `ERASE` | the wrong word erases nothing; the reset leaves an unprovisioned box that registers again; the SSD's blocks are discarded |
| SQ-09 | A day's work | 24 hours with the agent running a job (a command or a container) | no thermal throttling in the journal, no failed units, the box healthy in the app |

Record rows `SQ-00…SQ-09` in the sheet below with `sku` = the machine's make and model, `firmware` = its firmware
version.

## Virtual machines (PI-09, PI-21; NX-50…NX-59)

**Status: NOT RUN** as a qualification on any hypervisor host. A self-installed Whombat runs on a dedicated x86_64
UEFI machine or as a VM on any KVM hypervisor, on equal terms (PI-18, PI-21). A self-installed dedicated machine is
supported, not qualified (what is untested: nixos.md NX-92); the HQ rows above are the factory hardware design (LUKS +
TPM), not it (“Dedicated machines” above is). The VM test `install-vm` runs the self-install software paths in QEMU
with the device model below (q35, OVMF in setup mode, no TPM, virtio-scsi, i6300esb, guest agent); it does not stand in
for the rows below.
Operator steps: `docs/runbooks/install.md` §5.

### The VM

The generic settings; the platforms below give each one's names.

| Setting | Value | Why |
|---|---|---|
| Hypervisor | KVM/QEMU, x86_64 | the image carries the virtio drivers |
| Machine | `q35` | PCIe; what the VM test runs |
| Firmware | UEFI (OVMF) with its variables kept with the VM, **no enrolled keys** | UEFI for lanzaboote/systemd-boot and boot counting; no Microsoft or distribution keys. Secure Boot stays off: the appliance generates its keys and signs every generation but doesn't enrol them (PI-02, NX-52) |
| TPM | **none** | no guest encryption on this platform: storage is `host-encrypted` (PI-02; the name is historical, PI-20) |
| Disk controller | virtio-scsi | found by partition label, virtio-scsi in the initrd and the recovery UKI |
| Disk | one disk ≥ **128 GiB**, discard on (encrypted host storage recommended, PI-20) | 1 GiB ESP, 40 GiB system, the rest `/persist`; discard lets `whombat-secure-erase` free the blocks on thin storage (NX-55) |
| Network | virtio, bridged to the home LAN, DHCP (or NAT sharing the host's public address) | the claim page finds the box on the same network (CC-13, CC-04) |
| CPU | 4 vCPU, CPU model `host` | what the hardware can do; no nested virtualization is needed (PI-21; the per-agent computers it was for are gone, NX-455) |
| RAM | 8 GiB, ballooning off | the slices' reservations assume memory that stays |
| Watchdog | `i6300esb`, action `reset` (optional) | PID 1 pets it (`RuntimeWatchdogSec` 30 s, NX-05); without one, a q35 VM's chipset watchdog (ICH9 TCO, NX-189) |
| QEMU guest agent | on where the hypervisor offers it | clean shutdown and fs-freeze for backups only: `qemu-ga --allow-rpcs=` an allow-list (NX-52); `guest-exec`, file, user and password RPCs are closed |
| Display | std VGA or virtio-gpu | the graphical console (kiosk) on tty1: the claim code; std VGA (bochs, 1280×800 in the test VM) and *VirtIO-GPU* seen working, *SPICE*/QXL untested (NX-83). No display: the text console within 15 s |
| Start at boot | on | |

### Platforms

| Platform | Status | Settings |
|---|---|---|
| Proxmox VE 9 | **NOT RUN** (PI-09's target; the rows below need a Proxmox VE 9 host) | `qm create` in install.md §5: `--machine q35 --bios ovmf`, EFI disk `efitype=4m,pre-enrolled-keys=0`, no `tpmstate0`, `virtio-scsi-single` with `discard=on,iothread=1,ssd=1`, `--cpu host`, `--balloon 0`, `virtio,bridge=vmbr0`, `--watchdog model=i6300esb,action=reset`, `--agent enabled=1`, display *Default*, `--onboot 1` |
| Incus | **NOT RUN** as a qualification. The image runs in Incus VMs every day: the DEV box (`dev/devbox`, IN-94) and John's box (NX-88), with the graphical installer and console | install.md §5: q35 with OVMF and the host CPU model, `security.secureboot=false`, no `tpm` device, root disk 128 GiB on virtio-scsi, `limits.cpu=4`, `limits.memory=8GiB`, `raw.qemu=-device i6300esb -action watchdog=reset`, `boot.autostart=true`; NIC on `incusbr0` (NAT) or macvlan on the host's NIC. No QEMU guest agent (Incus's own agent isn't in the image), so PQ-04 and PQ-05's fs-freeze don't apply |
| libvirt, others | **NOT RUN**, untested | the generic table |

### Procedures

Run per platform. Where a command differs, Proxmox VE and Incus are given.

| ID | What | How | Pass criteria |
|---|---|---|---|
| PQ-00 | VM matches the table | Proxmox VE `qm config <vmid>`; Incus `incus config show <vm> --expanded` | every row above; no TPM device; no enrolled keys (Proxmox VE: `efidisk0` has `pre-enrolled-keys=0`; Incus: `security.secureboot=false`) |
| PQ-01 | Install and first boot | `docs/runbooks/install.md` §5–§7 | `whombat-install` reports `installing Whombat on /dev/sda`; the VM boots from the disk; `bootctl status` in the qualification build shows `Secure Boot: disabled (setup)`; no failed units |
| PQ-02 | Claim screen at first boot | install.md §7 | no recovery key screen (PI-19): the claim code appears once the box is registered, and again after a reboot |
| PQ-03 | Watchdog | qualification build (`whombat.qualification.consoleShell`): `hq-watchdog.sh arm`, as HQ-01 | the VM resets by itself within 60 s through the i6300esb, or the ICH9 TCO without one (not the hypervisor's HA), boots the same generation |
| PQ-04 | Guest agent (where offered) | Proxmox VE: `qm agent <vmid> ping`, `qm agent <vmid> fsfreeze-status`, `qm guest exec <vmid> -- /bin/true` | ping and status answer; `guest exec` is refused (“has been disabled”); `qm shutdown <vmid>` shuts the appliance down cleanly (journal: PostgreSQL stopped). Incus: no agent; `incus stop <vm>` (ACPI) shuts it down cleanly |
| PQ-05 | Backup with fs-freeze | Proxmox VE: a `vzdump` to the encrypted PBS store (install.md §2) while the box runs | the job log shows “issuing guest-agent 'fs-freeze'” and thaw; the appliance keeps running; the backup is marked encrypted in PBS. Incus: not applicable (no fs-freeze) |
| PQ-06 | Host update, boot counting | a host release with a failing assessment (as `install-vm`), then a good one | the failing one falls back to the known-good after `tries`; the good one is blessed; both without anyone at the console |
| PQ-07 | Power loss | a hard stop (Proxmox VE `qm stop <vmid>`, Incus `incus stop <vm> --force`) during a runtime update, during `nix-store --import`, during an ESP write | as HQ-04: the manager resumes or rolls back; the ESP still boots; PostgreSQL recovers |
| PQ-08 | Factory reset | recovery menu (hold Space) → 4, a wrong key, then the right one (since PI-19 without a key: a wrong word, then `ERASE`) | the wrong key or word erases nothing; the reset leaves an unprovisioned box that registers again with a new key; discard freed the space on the host (`zfs list` / LVM-thin usage drops) |
| PQ-09 | Remote console | open the VM console as a host user without console rights (Proxmox VE: without `VM.Console`; Incus: without access to the socket or the VM's project) | refused; only the operator's account can see the claim code |

Record rows `PQ-00…PQ-09` in the sheet below with `sku` = the platform and version (`proxmox-ve9-vm`, `incus-<version>-vm`),
`firmware` = the host's OVMF (edk2) version (on Proxmox VE the pve-edk2 version).
