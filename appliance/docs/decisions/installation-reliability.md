# Installation reliability — 2026-10-24

John asked for a review of the complete installation flow, Wi-Fi, connections,
DNS failover and partitioning. This work changes the appliance repository; no
runtime or contracts change is needed.

## Findings and decisions

- **IR-01: keep one network stack.** iwd joins WPA2/WPA3 Personal and open Wi-Fi;
  systemd-networkd obtains DHCP/SLAAC addresses and routes; systemd-resolved is
  the local DNS service. Ethernet's metric 100 precedes Wi-Fi's 600 in both IP
  families. The installer now shares the installed system's DNS policy and
  disables LLMNR, mDNS and DHCPv4 search domains consistently. Enterprise Wi-Fi
  and captive portals still need another network; a cable and a Wi-Fi
  association alone do not prove access to the internet. The preflight's three
  verified TLS checks remain the proof of reaching the commercial services;
  warnings still allow an offline install (CG-13).
- **IR-02: a public secondary resolver on ordinary uplinks.** resolved's
  `FallbackDNS` is used when no resolver is configured, not when DHCP advertises
  an unresponsive one. Pin Google (`8.8.8.8`, `8.8.4.4` and their IPv6 equivalents)
  for that case and append them after the network's DNS servers on physical
  default-route links. resolved owns retries and switching after server errors
  or timeouts; a negative answer is not a reason to bypass the network's policy.
  Preserve existing order, ports and TLS names. Add only the address families
  the link actually has. A 15-second timer writes through networkd, which owns
  managed links' DNS. A small ownership record in `/run` tracks the applied
  override and networkd's link-state inode/mtime. A DHCP/RA/reconnection change
  refreshes only our own DNS override from networkd's current configuration;
  unchanged links need no write. This avoids masking later DHCP DNS with a
  stale runtime override. No interface reconfiguration, resolver restart or
  disk-persistent state is needed. Do not touch virtual/VPN links
  or links with specific DNS domains (search domains also route DNS); their
  private names must not be sent to a public resolver. A newly private link
  loses our fallback; an operator's runtime DNS/security policy is respected.
  Public DNS must be reachable on port 53; it cannot repair a missing route, captive portal,
  blocked upstream DNS or internet outage. No DNS-over-HTTPS bypass is added.
- **IR-03: prove Wi-Fi got an address on its own card.** The installer's old
  join waited for any interface's address, so a working cable could hide a
  joined Wi-Fi card without DHCP. Allow 30 seconds for association and another
  30 for that card's DHCP/SLAAC; return `no_address` otherwise. General network
  checks also exclude container bridges and tunnels. Joining/scanning and
  starting an installation share a lock, so the profile cannot change while
  the installation takes it.
- **IR-04: disk safety is shared by the UI and shell.** Before `wipefs`, the
  shell calls the UI's disk parser: whole devices only, excluding the installer
  medium, mounted devices, swap, active LVM/RAID/device-mapper, read-only and
  USB disks. Check the full proposed layout and image size before erasing.
  The self-install minimum remains 110 GiB; factory/test layouts may be smaller
  when their full layout fits. One installer process owns the shared mountpoint,
  mapper names and partition labels. Resolve new partitions from the selected
  disk's own inventory, not global by-partlabel symlinks, and fail explicitly
  if a partition never appears. Keep the existing duplicate-installation check
  because installed systems still mount by their unique labels.
- **IR-05: keep separate system and data partitions; give boot more room.** New
  installs use GPT: a **2 GiB FAT32 ESP**, **40 GiB ext4 system volume**, and
  **btrfs data using the rest**. The ESP was 1 GiB, tight alongside recovery,
  signed kernels and rollback generations (see NX-64). Existing disks are
  never resized by an update. The 40 GiB system/data separation supports store
  generations and resetting data without reinstalling; btrfs subvolumes,
  PostgreSQL's no-CoW subvolume, quotas/reserves and factory-only LUKS/TPM
  protection remain as settled in NX-06, NX-07 and PI-19/20.
- **IR-06: DNS belongs in remote-help network diagnostics.** `network` and
  `report` now include `resolvectl status`, showing the configured and current
  server, per-link routing and whether fallback is present, through Look.
- **IR-07: an explicit new candidate version must be honored.** An appliance-only
  correction keeps the runtime pin. `dev/candidate --host --version <new version>`
  must start a new candidate in that case, rather than resume the already published
  version. An interrupted run for the same version still resumes normally.

## Review evidence and limits

Home (`wb-h7mq-2xvd-4410`) was inspected through remote help. Both Ethernet and
Wi-Fi were online with DHCP addresses and IPv4/IPv6 routes at the intended
metrics. Both links used the router's IPv4/IPv6 DNS. The system's built-in global
fallback list included Cloudflare, Google and Quad9 but did not supply per-link
secondary resolvers. Disk usage: 1 GiB ESP at 61%, 40 GiB system at 18%, about
913 GiB btrfs data at 1%. No data or partition was changed during inspection.

The review also followed the image's pinned closure, preflight and confirmation,
partition/filesystem creation, install, signed boot/recovery setup, Wi-Fi profile
copy, first-boot persistent-state setup, self-registration retry and claim path.
Offline installation and self-installed plaintext storage are deliberate product
decisions. Formal hardware qualification and destructive installation/VM gates
are separate from this review's quick checks; Home is not reinstalled to test a
partitioning change.

Validation: `go test -p 4 ./...`, Go vet for the changed packages, race checks
for the installer, DNS and Look, the harness's `pnpm check` (246 tests), and
the console's `pnpm check` (523 tests) passed. The DNS regression uses a
private D-Bus to exercise resolved's actual wire types, preserving primary
servers, repeated application and DHCP replacement. Nix built both Go binaries
and `checks.x86_64-linux.self-installed-config`; a generated `whombat-install`
against a small fixture system also passed its build and shell checks.

Live verification of the first host release caught an invalid resolved API call:
the manager provides `GetLink`, not `ListLinks`. Enumerate kernel interfaces and
use the object path returned by `GetLink` (index 2 is encoded as `_32`). The
private-bus regression now models that actual API and path, confirmed against
Home's live introspection. That version also requires managed-link writes to
go through networkd. The regression models resolved rejecting those writes
and networkd masking a new DHCP lease until our own override is reverted.
It checks replacement routers, state serialization, a new private domain and
handover to an operator's runtime policy. Corrected host releases and ISO
replace the first builds; no network outage or disk erasure is introduced to
test Home.

Before shipping the networkd correction, its Nix-built helper was run through
Home's existing hardened DNS service using a temporary `/run` override. It
returned success and both Ethernet and Wi-Fi showed the router's IPv4/IPv6
DNS first, followed by Google. The release's reboot removes that temporary
helper and service override; the installed unit then supplies the same policy.
