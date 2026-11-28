# Installing a Whombat from the ISO

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`), after
> `pnpm install --frozen-lockfile` in `harness/`.

For the operator who installs a self-installed Whombat and claims it: on a dedicated x86_64 machine (bare metal, the
main target) or as a virtual machine on any KVM hypervisor (Proxmox VE, Incus, libvirt, …; all on equal terms) (PI-01,
PI-09, PI-10, PI-18…PI-22). Decisions: `docs/decisions/prod-image.md` (PI-nn), `docs/decisions/console-gui.md`
(CG-nn), `docs/decisions/nixos.md` NX-50…NX-62, NX-78…NX-84, NX-90…NX-92, NX-189, NX-190. One ISO installs all of
them. What has run: a dedicated machine as near as QEMU gets in the VM test `install-machine` (NVMe, an Intel network
card on DHCP, the chipset's watchdog; NX-190), §5's VM settings in `install-vm`, and the image in daily use in Incus
VMs (IN-94, NX-88). Home now runs on the bare-metal Z13 (IN-377); formal hardware qualification remains separate
(`hardware-qualification.md`, NX-92). The review and reliability fixes are recorded in
`docs/decisions/installation-reliability.md`.

A self-installed Whombat has no disk encryption and no disk recovery key (PI-19, PI-20): everything it holds (the
organisation's data, its keys, its identity) is plaintext on its disk, and whoever has the disk or the console has it.

Download links sent before 2026-10-21 name the file `whombat-installer-proxmox.iso` and releases `pve-…`: the same
installer for every platform, under the names it had before PI-22 and PI-23.

## 1. What you need

- **An x86_64 machine or VM with UEFI firmware.** Secure Boot off (the ISO and the installed system are signed with
  keys the firmware doesn't know); no TPM is used (PI-02, PI-20).
- **4 cores and 8 GiB of memory** (2 and 4 at least; the installer warns below 4 and 8). **16 GiB** when the agent
  runs containers (Docker, a website or dev server it keeps up; Whombat OP-16, OP-19, NX-457): its commands and
  containers share the tasks' slice (at most 80 % of the memory, NX-19), and when memory runs out a command or a
  container goes first, never the Whombat (MP-02, NX-142, NX-457).
- **One disk of 110 GiB or more** for the Whombat alone (128 GiB for a VM, the tested size). The whole disk is erased.
- **A network with DHCP** — a cable, or Wi-Fi (WPA2/WPA3 Personal or open; a cable wins when both work, NX-240,
  NX-241) — and outbound HTTPS (443) to `api.whombat.com`, `updates.whombat.com` and
  `relay.whombat.com` (dev: the `-dev` names). Nothing needs to reach the Whombat from outside. The agent's
  commands and containers reach the network the Whombat is on (its local network, NX-144, NX-460; you can switch that
  off in the app), and people on that network open the ports the agent's services publish there
  (`http://<the Whombat's address>:20000`…`20099`, TCP, from private addresses only, never the internet: OP-19,
  NX-461). Put the Whombat on the network its agent should work in.
- **A screen and keyboard** for the installation and the claim: a monitor and keyboard on a machine, the hypervisor's
  console for a VM.
- **A computer or phone on the same network** for the claim, signed in to an organisation whose plan includes
  self-installation (CC-13).

Nothing in the installer asks for encrypted storage, a TPM or Secure Boot (PI-20).

## 2. Recommended

Recommendations, not requirements (PI-20); the installer doesn't ask.

- **Encrypted storage under the disk.** On a VM, put the virtual disk on storage that is encrypted at rest: a ZFS
  dataset with native encryption, or a host whose disks are LUKS-encrypted. Example on Proxmox VE with ZFS (the key is
  typed after every host boot, before the VM can start):

  ```sh
  zfs create -o encryption=aes-256-gcm -o keyformat=passphrase -o keylocation=prompt rpool/whombat
  pvesm add zfspool whombat-enc --pool rpool/whombat --content images --sparse 1
  # after a host reboot: zfs load-key rpool/whombat && qm start <vmid>
  ```

  On Incus, the same with a storage pool on an encrypted dataset or on LUKS disks. A key file on the host's own boot
  disk (`keylocation=file://…`) protects nothing against someone who takes the host's disks; keep the key off the host
  or type it. A dedicated machine's disk stays plaintext: keep the machine where you would keep its data.
- **Encrypted backups of the machine.** Backups of the VM contain the same plaintext. On Proxmox VE, send `vzdump`
  backups only to Proxmox Backup Server with client-side encryption (Datacenter → Storage → the PBS storage →
  Encryption → *Upload/Generate*; or `pvesm set <pbs> --encryption-key autogen`); the guest agent freezes the file
  systems during the backup (fs-freeze), so a backup is consistent. Elsewhere, encrypt the copy before it leaves the
  host; without the guest agent a copy of a running VM is only crash-consistent. Keep the encryption key and its paper
  copy apart from the host.
- **Never restore a snapshot or backup of a running Whombat, and never roll one back.** A Whombat remembers things
  that must only move forward: its licence high-water mark, TUF rollback protection, sessions and receipts that
  your devices hold. An older copy of the machine, next to or instead of the current one, breaks all of them. This
  holds for every snapshot: Proxmox and Incus snapshots, ZFS or LVM snapshots, a cloned disk. Don't take snapshots to
  “try something”. Recovering data is Whombat's own backup and restore (`restore.md`); a backup of the whole machine
  is only for losing the host, restored only after the original is gone for good.
- **Who can open the console.** Whoever sees the console while it waits can claim the Whombat with the four letters
  (CC “Remote consoles”). Give console access to nobody but the operator: on Proxmox VE `VM.Console` on this VM, on
  Incus access to its socket (the `incus-admin` group) or to the VM's project, on a machine a remote KVM or IPMI
  console. Close the console once the Whombat is claimed.

## 3. Get the installer

The ISO is `whombat-installer-vX.Y.iso`, the one Whombat image (ONE-02), from the installer download: one file at the
root of the download site, named by its version, with its `.sha256` beside it and `installer/latest.json` naming both
(ENV-22: `release/upload-iso`). It is built with its release (`release-build.md`:
`release/build prod <releaseId>`), and the release must be published before the ISO is installed: the box looks it up
at its first boot. A plain `nix build .#installer-iso-prod` names no release: its box works and can be claimed, but
never takes an update.

```sh
wget '<link>'                                  # whombat-installer-v0.12.iso, say
wget '<link>.sha256'
sha256sum -c whombat-installer-v0.12.iso.sha256  # the .sha256 names the file as the site does
mv whombat-installer-v0.12.iso whombat-installer.iso  # the name the steps below use
```

The checksum comes from the same site as the ISO: it shows the download arrived whole, not that the ISO is
Whombat's. A signed checksum is planned (`docs/decisions/installer-signature.md`).

Download it where you need it: on the computer that writes the USB stick (§4), or on the hypervisor host (§5).

## 4. Bare metal: a dedicated machine

### The machine

Any x86_64 machine with UEFI firmware, 4 cores and 8 GiB (2 and 4 at least), one internal disk of 110 GiB or more
(NVMe, SATA or eMMC, also NVMe behind Intel VMD; USB drives are never offered) and DHCP over **Ethernet or Wi-Fi**
(WPA2/WPA3 Personal or open; USB network adapters count). The image carries the drivers of common machines (NX-92).
A TPM is not used. Keep only the Whombat's disk inside if another disk ever held a Whombat: the installer refuses
while another disk has Whombat partitions. Plug in a keyboard and a monitor for the installation and the claim.

A mini PC, a desktop or a small server suits it best. A laptop works too: keep it plugged in, connected to the
network; closing the lid doesn't put it to sleep, its battery carries it through a short power cut, and holding the
power button shuts it down cleanly (a short press only wakes the screen; DK-10, DK-11).
The chipset's watchdog (Intel TCO, AMD SP5100/FCH) restarts the machine by itself if it ever hangs (NX-189).

Supported, not yet tested on real hardware (NX-92): the install and first boot on NVMe, SATA and eMMC, the graphical
console on Intel, AMD and NVIDIA graphics, common Realtek and Intel network cards, the chipset's watchdog. In QEMU
(`install-machine`, NX-190): NVMe, an Intel e1000e card on DHCP and the Intel TCO watchdog resetting a hung system.
Wi-Fi (NX-240…NX-247): a machine without a cable joins Wi-Fi in the installer, on its own screen or from the app
(Settings → This Whombat → Network); company (802.1X) networks can't be joined yet (a USB Ethernet adapter works).

### Write the USB stick

A stick of at least 4 GB; everything on it is erased. On Linux, find the stick with `lsblk` (its whole device, not a
partition) and write the ISO as it is:

```sh
lsblk
sudo dd if=whombat-installer.iso of=/dev/sdX bs=4M conv=fsync status=progress
```

On other systems, use a tool that writes the image as it is (a raw or “DD” copy), not one that copies files onto a
formatted stick.

### Firmware settings

In the firmware setup: boot mode **UEFI** (no CSM/legacy), **Secure Boot off** (the ISO and the installed system are
not signed with keys the firmware knows), and boot from the USB stick once (usually F12, F11 or Esc). Recommended:
**power on after a power loss** (“Restore on AC power loss: Power On”, often under Power or Advanced), so the Whombat
comes back by itself after a power cut. Hardware virtualization (VT-x, AMD-V) isn't needed: the agent's containers are
rootless Podman (NX-457). Then install (§6).

## 5. Virtual machines

### What every VM needs

Any KVM/QEMU hypervisor works with these settings (PI-09, PI-21); the names differ between them.

| Setting | Value | Why |
|---|---|---|
| Firmware | UEFI (OVMF), **no enrolled keys**, Secure Boot off | the boot loader and boot counting need UEFI; the Whombat creates its own Secure Boot keys and signs every system it boots, but leaves them unenrolled on this platform (NX-52) |
| TPM | **none** | not used (PI-02, PI-20) |
| Machine | `q35` (or the hypervisor's PCIe machine type) | what the VM test runs |
| Disk | one disk ≥ **128 GiB** on a virtio-scsi controller, with **discard** | the whole disk is the Whombat's; discard lets a factory reset free the blocks on thin storage (NX-55). NVMe works too (`install-machine`, NX-190); virtio-blk and SATA have drivers, untested in a VM |
| CPU | 4 vCPU, CPU model **host** | host passes on what the hardware can do; no nested virtualization is needed (the agent's containers are rootless Podman, NX-457) |
| Memory | 8 GiB (16 GiB when the agent runs containers), **ballooning off** | the services' reservations assume memory that stays; the agent's commands and containers share the tasks' slice, at most 80 % of the memory (NX-19, NX-457) |
| Network | virtio, **bridged** to the LAN (or a NAT network, see Incus), DHCP | the claim page finds the box on the same network (CC-13, CC-04); the agent's commands and containers reach the VM's own network, and people there open the ports its services publish (NX-460, NX-461) — behind NAT that is the NAT network, not your LAN |
| Display | a standard VGA or virtio-gpu display | the graphical console; without a display the text console takes over within 15 s (NX-83) |
| Watchdog | `i6300esb`, action reset (optional) | the system pets it and the VM resets by itself if it hangs (NX-05); without one, a q35 VM's own chipset watchdog does it (NX-189) |
| QEMU guest agent | optional | clean shutdown and fs-freeze for backups; only an allow-list of commands answers (NX-52) |
| Start at boot | on | |
| Boot order | the disk **before** the CD drive | an empty disk has nothing to start, so the VM falls through to the installer; after the restart it starts Whombat, even with the ISO still attached |

### Proxmox VE

The settings of PI-09 for Proxmox VE 9. Put the ISO in the host's ISO store
(`/var/lib/vz/template/iso/whombat-installer.iso`, or upload it in the GUI), then create the VM. Replace
`9100`, `whombat-enc` (storage, encrypted as in §2 if you follow it) and `vmbr0`:

```sh
qm create 9100 --name whombat --ostype l26 \
  --machine q35 --bios ovmf \
  --efidisk0 whombat-enc:1,efitype=4m,pre-enrolled-keys=0 \
  --cpu host --sockets 1 --cores 4 --memory 8192 --balloon 0 \
  --scsihw virtio-scsi-single \
  --scsi0 whombat-enc:128,discard=on,iothread=1,ssd=1 \
  --net0 virtio,bridge=vmbr0 \
  --watchdog model=i6300esb,action=reset \
  --agent enabled=1 \
  --ide2 local:iso/whombat-installer.iso,media=cdrom \
  --boot 'order=scsi0;ide2' \
  --onboot 1
```

- No TPM (`tpmstate0`): don't add one. Keep *Pre-Enroll keys* off (NX-52).
- In the GUI: *OVMF (UEFI)*, *Add EFI Disk* on the encrypted storage with *Pre-Enroll keys* unticked; *q35*; SCSI
  controller *VirtIO SCSI single*, disk 128 GiB with *Discard*, *IO thread* and *SSD emulation*; CPU type *host*;
  memory 8192 MiB without ballooning; *QEMU Guest Agent* ticked; Hardware → Add → *Watchdog* `i6300esb`, action
  `reset`.
- Display: *Default* (std VGA), seen in noVNC; *VirtIO-GPU* works too, *SPICE* is untested (NX-83).
- Boot order: `order=scsi0;ide2` puts the disk first. In the GUI: Options → *Boot Order*, the disk (`scsi0`) above
  the CD drive (`ide2`). Otherwise the installer starts again after the restart.
- Start it with `qm start 9100` and open the console (noVNC).

### Incus

Import the ISO as a volume in a storage pool (here `default`), create
an empty VM whose disk boots first and attach the ISO after it:

```sh
incus storage volume import default whombat-installer.iso whombat-installer --type=iso
incus init whombat --empty --vm \
  -c limits.cpu=4 -c limits.memory=8GiB \
  -c security.secureboot=false \
  -c raw.qemu='-device i6300esb -action watchdog=reset' \
  -c boot.autostart=true \
  -d root,size=128GiB -d root,boot.priority=20
incus config device add whombat installer disk pool=default source=whombat-installer boot.priority=10
incus start whombat
incus console whombat --type=vga        # the screen, through a SPICE viewer (e.g. remote-viewer)
```

- An Incus VM is q35 with OVMF and the host CPU model; `security.secureboot=false` keeps Secure Boot off. Don't add
  a `tpm` device. The root disk is on virtio-scsi (`/dev/sda` in the installer). The `raw.qemu` line adds the
  i6300esb watchdog; without it the q35 chipset's watchdog serves (NX-189).
- **Network:** the default profile's NIC on `incusbr0` (NAT) reaches the internet, and a computer or
  phone on the host's network can claim the box because they share the host's public address (CC-04). To put the VM on
  the LAN itself, give it a macvlan NIC on the host's network card before the first start (the host then can't reach
  the VM, which nothing needs):
  `incus config device add whombat eth0 nic nictype=macvlan parent=<host NIC>`. Behind `incusbr0`, the agent's
  commands and containers reach `incusbr0`'s network (the host and its other guests there), not your LAN, and only the
  host and those guests open the ports its services publish (NX-460, NX-461); on the LAN itself, the LAN does.
- **No guest agent:** Incus talks to VMs through its own agent, which the Whombat doesn't run; `incus exec` and
  `incus file` don't reach it, and shutdown goes through ACPI (`incus stop whombat`).
- **The graphical console** works in an Incus VM (NX-88: John's first install of the production ISO). The viewer's
  *Send key* menu sends Ctrl+Alt+F2 (§6).
- **Boot order:** the higher `boot.priority` starts first. The empty disk (20) has nothing to start, so the first
  start falls through to the ISO (10); after the installation the VM starts Whombat. Each `-d` sets one key, so the
  disk's size and priority are two flags. For a VM made without it, stop it first and then
  `incus config device set whombat root boot.priority=20` (`override` in place of `set` while the root disk still
  comes from the profile): changing a running VM's disk unplugs it.
- Remove the ISO when you like: `incus config device remove whombat installer`, then
  `incus storage volume delete default custom/whombat-installer`.

### Other hypervisors (libvirt, …)

Use the settings of the table: with libvirt (virt-manager, `virt-install`) that is the Q35 chipset, UEFI firmware
without Secure Boot and without enrolled keys, no TPM device, a VirtIO SCSI controller with one 128 GiB disk with
discard, CPU host-passthrough with 4 vCPU, 8 GiB with the memory balloon removed, a virtio NIC on a bridge (or macvtap)
to the LAN, optionally an `i6300esb` watchdog with action reset and the QEMU guest agent channel. Not tested yet.
Hypervisors other than KVM/QEMU (VMware, Hyper-V, VirtualBox) are untested; their own disk controllers may lack a
driver in the image.

## 6. Install

The installer is graphical (CG-11…CG-14): Hazel, the Assistant, walks you through it. Everything works with the keyboard
(Tab, Shift+Tab, Enter, Space, arrows), which suits a VM console.

1. Start the machine from the USB stick, or start the VM and open its console (§5). The installer shows
   “Let’s set up your Whombat”. Press **Start**.
2. **Checking this machine:** UEFI, CPU (warns below 4 cores), memory (warns below 8 GiB), a disk of at least 110 GiB,
   a network address (DHCP), and whether it reaches `api.whombat.com`, `updates.whombat.com` and `relay.whombat.com`
   (dev: the `-dev` names). A red item blocks the install (fix it, then **Check again**); warnings don't, but a box
   that can't reach those hosts will only say “Connecting to Whombat…” after the restart. When everything passes the
   page says so in one line, the items behind **Details**; a warning or a red item shows unfolded.
3. **Wi-Fi** (when a cable has no address): choose a network, enter its password if needed, and wait for the card
   to get an address. The checks run again over the connection. Its saved network is copied onto the installed
   system, so it reconnects after restarting. You can skip this and connect later on the box's screen.
4. **Choose a disk** (skipped when there is exactly one). The installer medium, USB drives, disks in use and disks
   under 110 GiB are never offered.
5. **Erase and install:** on an empty disk press **Erase and install** (or Enter); on a disk that holds something the
   page says what is on it, and you type the disk's name (e.g. `sda`, `nvme0n1`) to enable the button. **Installing** shows the
   steps and a progress bar; **Show details** shows the log. It creates a 2 GiB FAT32 boot partition, a 40 GiB ext4
   system partition and btrfs `/persist` using the remaining space, without LUKS. Updates keep existing partitions.
6. **Whombat is installed:** press **Restart**. The screen then shows what to do next: the Whombat Link code (Easy) or
   Tailscale's sign-in (Expert), then the claim. If the installer starts again, the VM's boot order puts the CD before
   the disk (§5: the disk first), or the USB stick still comes first: remove the USB stick or detach the ISO and
   restart. On Proxmox VE `qm set 9100 --delete ide2`; on Incus `incus config device remove whombat installer`.

If the installation fails, the screen shows the error and the log; **Try again** runs the checks again and returns to
the wizard (the failed attempt leaves nothing mounted).

**The command line** stays: Ctrl+Alt+F2 opens a shell on tty2 (in a VM console through its keys menu: noVNC's side
panel, the SPICE viewer's *Send key*, or `qm sendkey 9100 ctrl-alt-f2` on a Proxmox host), and

```sh
lsblk                                        # the target disk, e.g. /dev/sda in a VM, /dev/nvme0n1 on a machine
sudo whombat-install --disk /dev/sda --yes-erase-disk
```

does the same install: it prints `== installing Whombat on /dev/sda` and ends with `done: remove the installer medium
and restart` (and `@@progress` lines for the graphical installer). It refuses another platform (`--platform
factory`), installer media, USB/read-only/in-use disks, a layout that does not fit, and a second disk with Whombat
partitions. For a shell Wi-Fi install, join with `iwctl` first and pass `--wifi-profile /var/lib/iwd/<network>.psk`
(or `.open`) to copy its saved connection. Then `sudo poweroff`, remove the
medium, start again.
Without a display (no DRM device within 15 s) or when the graphical installer keeps failing, tty1 is that shell too.

## 7. First boot: the claim

The console is graphical too (CG-06…CG-09); the same screens exist as text on tty1 when there is no display (or the
graphical console keeps failing), with the same words.

1. The Whombat boots from its disk, creates its Secure Boot keys and its identity, and looks up the release it was
   installed with in the update repository (needs the network). It follows the channel that lists it: a Beta
   installer's box follows Beta, a Production one Production (MG-182). The console says “Starting Whombat…” meanwhile.
   When that can't finish, it says “Whombat can’t start yet” and why (no channel lists its release, or the update
   server is out of reach); it tries again by itself, and a restart tries at once (NX-526). There is no recovery key
   to write down (PI-19).
2. **Claim it.** The console shows “Claim this Whombat” and four letters on a sign. On a computer or phone **on the
   same network** open `app.whombat.com/claim`, sign in, choose the organisation (it
   needs self-installation in its plan) and enter the letters. The console celebrates briefly, then shows “This Whombat
   is set up.”, your burrow's name and a wombat fact.
3. On a VM, close the console.

If the console shows “Connecting to Whombat…” for long: the box has no network or can't reach control (check the
cable or Wi-Fi, the VM's bridge, DHCP and outbound 443). The installer and installed system use systemd-resolved:
the network's DNS first, with Google DNS as a secondary on ordinary Ethernet/Wi-Fi uplinks. Public DNS must be
reachable on port 53. Private/VPN DNS domains keep their own policy. Remote help's `network` command includes DNS
status. A keyboard or mouse plugged in later works right away; a display
plugged in later restarts the graphical console for a moment.

## 8. Afterwards

- **Backups:** set up Whombat's own backups in the app (`backup.md`); on a VM, schedule an encrypted backup of the
  whole VM (§2) as well.
- **Updates** arrive through TUF; host updates restart the machine by themselves, and a failing one falls back to the
  previous system unattended. Don't switch it off while it updates.
- **Shutdown:** on a dedicated machine a short press of the power button (on a laptop: hold it) shuts it down cleanly
  (not yet tried on real hardware). On Proxmox VE `qm shutdown 9100` (through the guest agent), restart with
  `qm reboot 9100` (or the GUI's Reboot), `qm stop` only if that fails; on Incus `incus stop whombat` and
  `incus restart whombat`, `--force` only if that fails: these go through the guest agent or ACPI. Ctrl+Alt+Del in the
  console does nothing while the graphical console runs (NX-82).
- **Factory reset / decommission:** `factory-reset.md` (“Self-installed”): hold Space at power-on → “Whombat
  Recovery” → 4, then type `ERASE` (no key; a box installed before PI-19 whose key was confirmed asks for that key
  first). It deletes and discards, it doesn't destroy a key: on a VM delete its snapshots and backups on the host too.
- **No way in from the apps** (Whombat Link ended, Tailscale off): hold Space at power-on → “Whombat Recovery” → 11
  *Change how you reach this Whombat* (1 Whombat Link, 2 Tailscale) or 12 *Turn on Tailscale*, type the word it asks
  for (`LINK` or `TAILSCALE`; a box with a confirmed key asks for that key), then 9 to restart. The menu writes the
  choice to `/persist/whombat/reach.json`; the manager acts on it at its next start, and the screen shows the Link code
  or Tailscale's sign-in link.
- **Moving a VM** to another host: shut it down, move its disk together with its UEFI variables (on Proxmox VE the EFI
  disk, keep *Pre-Enroll keys* off), and never run the old and new copy at the same time.

## No dev instance variant

There is one image (ONE-02, nixos.md NX-522), in one environment, production: the installer has no developer option
(`updates.md`, “One environment”).

## Community edition variant (test keys only; the install test)

`packages.installer-iso-community` installs `self-installed-community` (Whombat HE-58; nixos.md NX-445): no control,
relay, licence or remote help. The box makes its own identity at the first start, records its factory release from
its own update repository, shows four letters and its address on the network on its screen, and is claimed in the
Whombat app on the same network: type that address on the app's first screen, then the letters (console-gui.md CG-411). Tailscale is in This Whombat, also with your own login server
(Headscale). Updates come from the edition's own TUF repository without control (manager MG-136, UP-X27). **Test
keys only, nothing is published** (HE-62): the root and client keys it pins are the committed test repository's.

A release (`whombat-community-YYYYMMDD.N`):

    release/build community whombat-community-20261024.2 --updates-url http://10.0.2.2:47081/ --iso
    release/community-repo init ~/.cache/wb-tmp/community-repo        # a working copy of the test repository
    release/community-repo publish ~/.cache/wb-tmp/community-repo ~/.cache/whombat-releases/whombat-community-20261024.2

`--updates-url` is the repository the image's manager reads (the box must reach it at its first start; the image opens
its port in the egress wall). Serve the copy's `metadata/` and `targets/`, never its `keys/`. A runtime-only release
for an update: `--reuse-host <previous build.json> --runtime-label <label>`, published the same way. To build against
a Whombat commit that isn't the pin yet, use a throwaway worktree of this repository with `flake.nix`'s `whombat` input
on that commit (`nix flake update whombat`), its pnpm hash in `nix/packages/runtime` (`pnpmDepsHashes`), committed
there and never merged (IN-430).

### The install test in a VM (IN-430)

Everything through `agent-resource` (`/home/me/Code/dashboard/docs/agent-resources.md`), released at the end:

1. A lease for the containers: `L=$(agent-resource lease --task "…" --ttl 8h --disposable-data)`.
   - the update repository: `agent-resource docker-run --lease $L --publish 127.0.0.1:47081:80 --volume
     <copy>/metadata:/usr/share/nginx/html/metadata:ro --volume <copy>/targets:/usr/share/nginx/html/targets:ro
     nginx:stable-alpine` (`chmod -R a+rX` both first);
   - Headscale: `vm-tests/community-install/headscale.yaml` with `SERVER_URL` = `http://10.0.2.2:47080` (what the box
     reaches), `--publish 127.0.0.1:47080:8080`, the config and a 0777 data directory as volumes,
     `headscale/headscale:latest serve` (v0.29.5 at the test); `headscale users create owner` and a reusable pre-auth key;
   - a second Tailscale client: `tailscale/tailscale:latest` with `TS_AUTHKEY` (an env file), `TS_USERSPACE=true`,
     `TS_EXTRA_ARGS=--login-server=http://<headscale's container address>:8080`,
     `TS_OUTBOUND_HTTP_PROXY_LISTEN=0.0.0.0:1055`, `--publish 127.0.0.1:47055:1055`: this machine reaches the tailnet
     through that proxy. Never this machine's tailscaled or John's tailnet.
2. The VM, QEMU in the managed task's cgroup with its disk in the task's workspace: `WB_QEMU=<nixpkgs qemu_kvm>
   WB_OVMF=<nixpkgs OVMF.fd> agent-resource run --task "…" --ttl 6h -- vm-tests/community-install/qemu.sh <iso> <state
   dir>` (in the background; `<state dir>/workspace` names the workspace with `qmp.sock`). The box's port 4480 is
   `127.0.0.1:47480`; it reaches this machine's ports at `10.0.2.2`.
3. `WB_TESSERACT=<nixpkgs tesseract> vm-tests/community-install/install.sh <workspace> <shots dir>`: Start, the checks,
   Erase and install (Enter on the blank disk), Restart; prints the claim letters (check them against `5-claim.png`).
4. With a Whombat checkout (`WHOMBAT_APP`, installed), `$WHOMBAT_APP/node_modules/.bin/tsx
   vm-tests/community-install/client.mts …` with `--url http://10.0.2.15:4480 --connect 127.0.0.1:47480` (the box answers
   only for its own addresses): `identity` (edition `community`, `claimed: false`), `claim --letters ABCD --key
   owner.key`, `tailscale-on --key owner.key --login-server http://10.0.2.2:47080` (a Headscale link: `headscale auth
   register --auth-id <id> --user owner`), `tailscale` until `on`. Over the tailnet: `--url
   http://100.64.0.2:4480 --proxy http://127.0.0.1:47055` (or `http://whombat.hs.test:4480`) for `identity` and, with the
   key, `status` or `tailscale` (a Noise session).
5. An update: publish a newer release into the copy; the box takes it at its next TUF refresh (hourly) or at its next
   start (`qmp.py <sock> cmd system_powerdown`, then `cmd system_reset` and `cmd cont`).
6. `qmp.py <sock> quit` (the task ends and its workspace goes), `agent-resource release $L`, `agent-resource check` both.

## Production prerequisites (PI-10)

`packages.installer-iso-prod` builds when `manifest/prod/licence-keys.json` (the public `lic-prod-…` key set, LC-04) is
committed and the runtime bundle (PI-07) is the prod runtime; otherwise evaluation stops naming the missing file, or
with “prod needs the real Whombat runtime bundle, not the stand-in”. The GitHub repository's root and AI client channel
keys come from `manifest/prod/tuf-root.json` and `client-channel-keys.json` (ONE-05, NX-522); without them evaluation
stops naming the missing file.
