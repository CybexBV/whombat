# Workstream: better hardware support — a hardware report, a sound server, Wi-Fi (2026-10-20)

John, 2026-10-20 (main checkout): “I installed a whombat appliance and the mic is not working, also WiFi is not working
by default. Is there a way to implement better hardware support, including WiFi? … I also would like to know which kernel
is being installed by default.” After the findings below and a proposal (1 a hardware report, 2 a sound server, 3 Wi-Fi,
4 keep the LTS kernel): “I am currently using the Flow Z13, but we should support other devices as well. Currently it's
online via USB network adapter. … Yes, build 1-3 when platform-neutral is merged.”

What was there (appliance main 3718f56, nixpkgs nixos-26.05 c508844):
- **Kernel** 6.18.53, NixOS 26.05's default LTS; the appliance never sets `boot.kernelPackages`. `linuxPackages_latest`
  there is 7.2.7.
- **Firmware** complete: `hardware.enableRedistributableFirmware` brings linux-firmware 20260916, sof-firmware
  2025.12.2, alsa-firmware and wireless-regdb. The kernel config has the Wi-Fi drivers (iwlwifi/mvm/mld, mt7921e/mt7925e,
  rtw88/rtw89, ath11k/ath12k, brcmfmac) and the sound ones (HDA, AMD ACP/PS/SOF ACP 7.0, Intel SOF/AVS, CS35L41).
- **Microphone:** NX-163 chose “ALSA, no sound server”: Chromium records from ALSA's `default` device, card 0. On the
  Z13 the microphone is a card of its own (NX-179: `acp-pdm-mic`), so Talk shows but records the wrong card; laptops
  whose microphone is switched on by a UCM profile (Intel SOF) need a sound server too.
- **Wi-Fi:** none by design (appliance NX-92: “no Wi-Fi on the appliance”): networkd matches only `en* eth*`, no iwd or
  wpa_supplicant, the installer forces `networking.wireless.enable = false`, nowhere to choose a network. The manager's
  network change guard (appliance MG-15) exists, but nothing calls it and its candidates are wired only.
- **Nobody can look inside a machine of its own:** the Incus agent works only in VMs and there is no shell, so a
  customer's (or John's Z13's) devices are unknown to us.

Numbering: HD-01… here; server HD-S01… (`hardware-support-server.md`); contracts CT-560… (0.102.0); app AP-3200…AP-3249
web (`hardware-support-web.md`), AP-3250…AP-3299 Android (`hardware-support-android.md`); appliance NX-240…NX-254 and
MG-100…MG-109 (network), NX-255…NX-269 and MG-110…MG-119 (sound and hardware), CG-100…CG-129 (console and installer).
Build brief: `docs/implementation/hardware-support/assignment.md`.

## Decided

- **HD-01 Any machine, not one laptop.** Everything here works from what the machine reports (sysfs, the sound cards,
  the Wi-Fi card iwd sees), never from a list of known models. The Z13 is the first real machine it is tried on.
  *Why:* John: “we should support other devices as well”; the appliance is bare metal first (feedback-platform-neutral).
- **HD-02 The kernel stays NixOS's LTS** (*superseded by HD-12 the same day: the newest stable kernel*) (6.18 today) and moves when NixOS moves it; the image switches to a newer one
  only when a machine shows a need the LTS can't meet (the hardware report says which driver is missing). No second
  “newer hardware” image. *Why:* the newest kernels change every few weeks, so each release would carry a new kernel and
  its regressions; nothing found here points at the kernel; two kernels double what has to be tried.
- **HD-03 A hardware report.** The manager collects it when asked (sysfs and procfs: PCI and USB devices with their
  drivers, network interfaces, sound cards with their capture and playback devices, graphics and screens, storage,
  batteries, Bluetooth; names from the hwdata database; the kernel's firmware and driver errors through a read-only
  helper op). Owners see it in the app (Settings → This Whombat → About → **Hardware**, beside Diagnostics) and can
  **Download report** (a text file the app makes from the same data, to send to support). It never carries serial
  numbers or MAC addresses. *Why:* without it nobody can tell why a machine's microphone or Wi-Fi doesn't work; About is
  where facts you look up live (AP-1231).
- **HD-04 PipeWire is the sound server** (system-wide PipeWire, WirePlumber and the PulseAudio socket), on machines with
  the desk kiosk; Chromium uses it (it is built with PulseAudio support); WirePlumber picks the default microphone and
  speaker the way desktops do. Supersedes NX-163's “ALSA, no sound server”. `alsactl init` on new cards stays. *Why:*
  built-in microphones are often a sound card of their own or need a UCM profile; a sound server handles both, and USB
  headsets and speakerphones plugged in later.
- **HD-05 Wi-Fi with iwd; a cable wins.** iwd joins networks, networkd gives every `wl*` interface DHCP and IPv6 like a
  cable, with a higher route metric (cable 100, Wi-Fi 600) so a cable is used when both work. WPA2/WPA3 Personal and
  open networks, hidden ones by name; company (802.1X) networks and WEP are listed but can't be joined yet. Saved
  networks live in iwd's own state (`/var/lib/iwd`, root only) and are not in backups. *Why:* iwd is small, needs
  nothing beside it (no wpa_supplicant + NetworkManager), and works with networkd, which the appliance already uses.
- **HD-06 Changing Wi-Fi from the app is guarded.** Owners join, switch and forget networks in Settings → This Whombat →
  Overview → **Network**. A join that leaves the box unable to reach Whombat (when it could before) is undone after 2
  minutes: the new network is forgotten and the previous one comes back (the guard's pattern, MG-15, with its dead-man
  revert). A wrong password fails at once and keeps nothing. Forgetting the network the box depends on is refused while
  nothing else works (`in_use`). *Why:* a typo in a remote change must not cut the box off for good.
- **HD-07 The box's screen may choose Wi-Fi when it is safe to.** On the screen, Wi-Fi can be chosen when the box isn't
  claimed yet, when it can't reach Whombat right now, or when the screen is unlocked (the desk PIN or the phone, DK-04);
  otherwise the screen shows the network it uses and says to unlock or use the app. Supersedes DK-15's “Wi-Fi setup on
  the screen: not now”. *Why:* someone standing at a box without a network could plug in a cable anyway, so letting them
  choose Wi-Fi adds no risk; a box that works shouldn't be re-pointed by anyone walking past.
- **HD-08 The installer offers Wi-Fi when there is no cable.** After the checks, when no wired interface has an address,
  the installer shows a Wi-Fi step (choose a network, type its password; it joins to prove the password works) before
  choosing the disk; the network goes into the installed system so the box is online on its first boot. **Skip** stays
  possible. *Why:* a laptop without an Ethernet port (the Z13) must be able to reach Whombat to be claimed.
- **HD-09 The screen has its own keyboard.** Text fields on the box's screen (a Wi-Fi password, a hidden network's name)
  come with an on-screen keyboard; a real keyboard works too. *Why:* touch-only machines and a Z13 without its cover have
  no keys, and Chromium in the kiosk brings no keyboard of its own.
- **HD-10 “Online” means the box reached Whombat**: the manager connected to control's endpoint in its last check (at most
  60 s ago). The screen's rule (HD-07) and the guard (HD-06) use the same fact.
- **HD-11 Words** (concise-replies): “Cable · Connected”, “Wi-Fi · Home · Strong signal”, “Join a Wi-Fi network”,
  “That password didn’t work.”, “Joined Home, but Whombat couldn’t reach the internet there, so it went back to Office.”,
  “This Wi-Fi card has no driver yet.”, “This Wi-Fi card needs firmware that isn’t there.”. Kinds and states cross the
  wire; the words are made where they're shown (app and console).

- **HD-12 The newest stable kernel, everywhere** (2026-10-20; supersedes HD-02; appliance NX-340…NX-343). John, the
  same evening: “For maximum compatibility with newer computers, laptops, and tablets, I think we should consider using
  the latest kernel that NixOS provides us instead of the LTS. We don't really care about the long-term support because
  we will update frequently anyway. Also, for all the appliances, I would like to have full compatibility with AMD,
  Intel, etc. And … the best network compatibility, Wi-Fi compatibility, and Bluetooth.” The appliance, the installer
  and the recovery environment boot nixpkgs' `linuxPackages_latest` (7.2 today) and move with each nixpkgs bump.
  Beside it: every disk controller the installer can see is in the installed system's initrd (servers' SAS and RAID
  cards, other hypervisors' virtual disks), Wi-Fi keeps no power saving, USB Wi-Fi sticks that start as a driver CD
  are switched to Wi-Fi, and Wi-Fi switched off by a laptop's key comes back at the next start. *Why:* new laptops,
  tablets and mini PCs need the newest drivers (Wi-Fi 7 cards, new AMD and Intel graphics, sound and network chips),
  a box takes an update every few weeks anyway, and boot counting brings the previous kernel back when a new one doesn't
  start. Bluetooth: the drivers and firmware are there and the hardware report shows the adapter; nothing on the box
  pairs a device yet (still “not now”).

## Not now

Bluetooth (audio or pairing), company (802.1X) Wi-Fi, captive portals, a Wi-Fi hotspot to set up a machine without a
screen, a Wi-Fi file on the install stick, choosing the default microphone in the app, static
addresses over Wi-Fi (the guard's wired candidates stay as they are), the box's country for Wi-Fi channels (the access
point's country is used).
