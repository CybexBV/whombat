# Better hardware support — build brief (2026-10-20)

Decisions: `docs/decisions/hardware-support.md` (HD-01…HD-11). **Read it first**, then §1, §2 and your stream's part of
§3. There is no mockup: follow the nearest existing pattern (web/Android: the SCREEN section on This Whombat's Overview
and DIAGNOSTICS in About; the box's screen: the desk sheets in `console/ui/src/desk/Sheet.tsx` and the claim scenes).

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-hw` | `hw` (main) | CT-560…CT-589, 0.102.0 |
| S server | Whombat | `~/Code/.wt/whombat-hw-server` | `hw-server` (`hw`) | HD-S01… |
| W web | whombat-app | `~/Code/.wt/app-hw-web` | `hw-web` (`hw`) | AP-3200…AP-3249 |
| M Android | whombat-app | `~/Code/.wt/app-hw-mobile` | `hw-mobile` (`hw`) | AP-3250…AP-3299 |
| N network | the appliance | `~/Code/.wt/appliance-hw-net` | `hw-net` (`hw`) | NX-240…NX-254, MG-100…MG-109 |
| A sound + hardware | the appliance | `~/Code/.wt/appliance-hw-sound` | `hw-sound` (`hw`) | NX-255…NX-269, MG-110…MG-119 |
| P console + installer | the appliance | `~/Code/.wt/appliance-hw-console` | `hw-console` (`hw`) | CG-100…CG-129 |

Integration branches `hw` in Whombat (`~/Code/.wt/whombat-hw`), whombat-app (`~/Code/.wt/app-hw`) and
the appliance (`~/Code/.wt/appliance-hw`, made after the appliance's `platform-neutral` work is on main) are the
lead's. C commits straight to its `hw`.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `web: …`,
  `mobile: …`, `client: …`, `nix: …`, `manager: …`, `helper: …`, `console: …`, `installer: …`), every message ending
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or another
  stream's branch, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-appliance`): other sessions work there. The lead merges, vendors and ships.
- **Contracts 0.102.0 arrive on `hw`** (Whombat and app vendor them; the appliance gets the Go module). Start with what
  doesn't need the new types, against §2's shapes; when the lead says they are vendored, `git merge hw`. Need a contract
  change? Don't edit vendored files: tell the lead the exact additive change (it becomes 0.102.1).
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet ./... && go test ./...` in what you touched; `console/ui`: `pnpm check` there; Nix: the
  `nix build`s / checks your §3 names), plus `pnpm test:server` once (S). Run single test files while you work. No CI
  waits, no VM tests except the ones your §3 names (run each once at the end). Own ports (S 4540, W 4544/5244) and
  throwaway databases; the shared `docker compose` (Postgres :55432, Mailpit) is never stopped or reset. `/tmp` runs out
  of inodes: `TMPDIR=~/.cache/wb-tmp`. Nix needs `--extra-experimental-features 'nix-command flakes'`. Temporary
  containers or VMs only through `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md`
  first), and release what you lease. NixOS VM tests run as the flake runs them (`nix build .#checks.x86_64-linux.<name>`).
- **Android emulator** (M): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5620
  (`emulator -avd whombat-mobile -port 5620 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5620 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services, DEV box or his Z13** (device `wb-h7mq-2xvd-4410`) from tests or scripts,
  never run an installer or a candidate. The lead does the real ones after the merge.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (sysfs parsing into devices and states, hwdata lookup,
  the kernel-log filter, iwd answers into networks, the guard's phases, the screen's may-change rule, the report text,
  signal bars, the words). Fakes in process. A new `*.int.test.ts` needs a reason to need Postgres. Check facts (ids,
  kinds, codes, a key phrase), never long literal text. Inject clocks and short timeouts, never sleep.
- **Copy**: plain, short English a non-developer understands (`docs/decisions/concise-replies.md`), curly quotes
  (’ “ ”), `·`, `…`, `−`. HD-11's words are the words; new ones in the same voice. Secrets (a Wi-Fi password) never in
  logs, errors, audit text or test snapshots.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file (ids in the table): Whombat `docs/decisions/hardware-support-server.md`
  (S); app `hardware-support-web.md` (W), `hardware-support-android.md` (M); appliance `nixos.md` and `manager.md` (N,
  A), `console-gui.md` (P); C in `docs/decisions/contracts.md`.
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes

Names are binding; field details may be refined by C where a rule of the contracts repo requires it (C tells the
lead). All timestamps RFC 3339 UTC. Display strings (device names, vendors, SSIDs, interface names, log lines) are
validated the way `ConsoleDisplayText` is (printable, no control or format characters) with the max lengths below;
producers clean them (drop what isn't printable) rather than fail.

### 2.1 Hardware (`@whombat/protocol/session`, `host.ts` or a new `hardware.ts`; Go generated) — C

- `HardwareKind = 'wired' | 'wifi' | 'bluetooth' | 'sound' | 'graphics' | 'display' | 'storage' | 'camera' | 'battery' |
  'input' | 'usb' | 'other'`.
- `HardwareStatus = 'ok' | 'no_driver' | 'no_firmware' | 'disabled'` (`disabled`: rfkill-blocked or switched off).
- `HardwareDevice { kind, name: 1..120, vendor?: ≤80, bus: 'pci' | 'usb' | 'platform' | 'virtual', id?: /^[0-9a-f]{4}:[0-9a-f]{4}$/
  (vendor:device), driver: ≤64 | null, status: HardwareStatus, interface?: ≤15 (network), link?: 'up' | 'down',
  speedMbps?: int ≥ 0, capture?: 0..64, playback?: 0..64 (sound: PCM devices), card?: ≤32 (sound: ALSA card id),
  connected?: boolean (display connectors), sizeBytes?: int ≥ 0 (storage) }`.
- `HostHardware { collectedAt, kernel: ≤64, machine: { vendor?: ≤80, model?: ≤120, family?: ≤80, firmware?: ≤80,
  virtual: boolean, hypervisor?: ≤32 }, cpu: { model: ≤120, cores: int, threads: int }, memoryBytes: int,
  devices: HardwareDevice[] (≤256), log: string[] (≤40 lines, each ≤240) }`. No serial numbers, no MAC addresses.
- No words in the contracts: they are the app's and the console's (HD-11). C may add a pure helper
  `hardwareProblems(h): { kind, name, status }[]` (devices whose status isn't `ok`, wifi/wired/sound/graphics first) if
  it fits the repo's style; otherwise W does it in the client.

### 2.2 Network (`@whombat/protocol/session`; Go generated) — C

- `WifiSecurity = 'open' | 'psk' | 'enterprise' | 'other'` (`psk` covers WPA2/WPA3 Personal; `other` = WEP etc.).
- `WifiSignal = 0..4` (bars; producers map dBm: ≥ −55 → 4, ≥ −67 → 3, ≥ −75 → 2, ≥ −85 → 1, else 0).
- `Ssid`: 1..32 bytes UTF-8, displayable (networks whose name isn't are left out of lists).
- `WifiPassphrase`: 8..63 printable ASCII, or 64 hex digits. A secret: never logged.
- `NetworkChangeFailure = 'wrong_password' | 'not_found' | 'no_address' | 'no_internet' | 'failed'`.
- `NetworkChange { id: /^c-[a-z0-9]{8,32}$/, kind: 'join' | 'forget', ssid: Ssid, phase: NetworkPhase (reuse the
  existing `applying | confirming | committed | reverting | reverted | failed`, or C maps it), deadline: Timestamp,
  previous?: Ssid | null, failure?: NetworkChangeFailure }`.
- `HostNetwork { online: boolean, checkedAt: Timestamp | null, wired: { interface: ≤15, connected: boolean,
  address?: ≤45 }[] (≤8), wifi: null | { interface: ≤15, state: 'disconnected' | 'connecting' | 'connected',
  ssid?: Ssid, signal?: WifiSignal, address?: ≤45, saved: { ssid: Ssid, security: WifiSecurity }[] (≤32) },
  wifiMissing?: 'no_adapter' | 'no_driver' | 'disabled' (only when `wifi` is null), change: NetworkChange | null }`.
- `WifiNetwork { ssid: Ssid, security: WifiSecurity, signal: WifiSignal, saved: boolean, connected: boolean }`;
  `WifiScan { networks: WifiNetwork[] (≤64, strongest first), scannedAt }`.

### 2.3 Session ops (`@whombat/protocol/session`) — C

Session-native, channel `app`, in `SESSION_SPECS` and the safety table; features **`host.hardware`** and
**`host.network`** (`SINCE_0_102`); bump `SESSION_API_LEVEL` as `docs/publishing.md` says.

| Op | In → Out | Who | Safety |
|---|---|---|---|
| `host.hardware` | `{}` → `{ hardware: HostHardware \| null, reason?: 'not_managed' \| 'unavailable' }` | owners | READ |
| `host.network` | `{}` → `{ network: HostNetwork \| null, reason?: 'not_managed' \| 'unavailable' }` | owners | READ |
| `host.wifi.scan` | `{}` → `{ scan: WifiScan \| null, reason?: … \| 'no_wifi' }` | owners | READ |
| `host.wifi.join` | `{ ssid, passphrase?, hidden?: boolean }` → `{ change: NetworkChange }` (secret) | owners | NEVER |
| `host.wifi.forget` | `{ ssid }` → `{ change: NetworkChange }` | owners | NEVER |

Errors: `no_wifi`, `busy` (a change is running), `in_use` (forgetting the only working connection), `not_saved`,
`invalid_passphrase`, `forbidden`. Realtime: none — the app polls `host.network` every 2 s while `change` is running.

### 2.4 Manager's local API (`@whombat/control-contracts/local`, TS + generated Go + vectors) — C; served by N and A

Peer: the runtime's uid only, as every manager route (`broker.go` `onlyN`). Bodies strict, `v: 1`.

| Path (`MANAGER_PATHS`) | Request → Response |
|---|---|
| `hostHardware` `POST /v1/host/hardware` | `{v}` → `{v, hardware: HostHardware}` (A) |
| `networkState` `POST /v1/network/state` | `{v}` → `{v, network: HostNetwork}` (N) |
| `wifiScan` `POST /v1/network/wifi/scan` | `{v}` → `{v, scan: WifiScan}` (N; waits ≤ 10 s for a fresh scan) |
| `wifiJoin` `POST /v1/network/wifi/join` | `{v, ssid, passphrase?, hidden?, confirmTimeoutSec: 30..600}` → 202 `{v, change}` (N) |
| `wifiForget` `POST /v1/network/wifi/forget` | `{v, ssid}` → 202 `{v, change}` (N) |

Errors as `{v, error: {code, message}}` with the codes of §2.3 (`no_wifi`, `busy`, `in_use`, `not_saved`,
`invalid_passphrase`). The existing `networkCandidates`/`networkStatus` (wired) stay as they are. `docs/local-ipc.md`.

### 2.5 Desk socket additions (`@whombat/control-contracts/local` `desk.ts`) — C; served by S, used by P

The console server asks the runtime (it has no network and no manager access, CG-03).

| Path (`DESK_PATHS`) | Request → Response |
|---|---|
| `network` `GET /v1/desk/network` | → `{v, network: HostNetwork, mayChange: boolean, why?: 'locked'}` |
| `wifiScan` `POST /v1/desk/network/wifi/scan` | `{v}` → `{v, scan: WifiScan}` |
| `wifiJoin` `POST /v1/desk/network/wifi/join` | `{v, ssid, passphrase?, hidden?}` → `{v, change}` |
| `wifiForget` `POST /v1/desk/network/wifi/forget` | `{v, ssid}` → `{v, change}` |

`mayChange` (HD-07): the box isn't claimed, or `network.online` is false, or the desk is unlocked. Scans are allowed
whenever `network` is. Join/forget when `mayChange` is false → 409 `locked`. Works on an unpaired screen too.

### 2.6 Inside the appliance (Go; not in contracts)

- Helper ops (N): `wifi-status`, `wifi-scan`, `wifi-join {ssid, passphrase?, hidden?, deadlineSec}`, `wifi-forget
  {ssid}`, `wifi-revert-deadman {changeId}`; (A): `hardware-log` (read-only: the kernel's firmware and driver error
  lines, filtered, ≤ 40). The helper is root and talks to iwd over D-Bus (`net.connman.iwd`); a shared package
  `helper/pkg/wifi` (N) holds the iwd client and the profile file format, and P's installer uses it.
- Console server (P): `GET /api/network`, `POST /api/network/wifi/scan|join|forget` (proxies of §2.5, bodies ≤ 1 KiB,
  strings cleaned), `/api/state` gains `network: { online, via: 'cable' | 'wifi' | 'none', ssid? }` from the same answer
  (cached 2 s).
- Installer UI (P, root, host network): `GET /api/wifi` → `{ adapter: boolean, wifiMissing?, connected?: Ssid,
  networks: WifiNetwork[] }`, `POST /api/wifi/scan`, `POST /api/wifi/join {ssid, passphrase?, hidden?}` →
  `{ connected: true } | { failure }`; `/api/install` writes the joined network's profile into the installed system.

## 3. Streams

**C — contracts.** §2.1–2.5 with tests and vectors as the repo does them (`pnpm gen`, `pnpm gen:check`, the conformance
registry and schema cases — a `wl*` candidate stays refused by `NetworkCandidate`; Wi-Fi has its own shapes —
`docs/local-ipc.md`, `docs/session-protocol.md`, CT rows in `docs/decisions/contracts.md`). Then merge the desk auto-pair release `contracts-v0.101.0` (another session’s, CT-538…) into `hw`, bump to 0.102.0, tag
`contracts-v0.102.0` on `hw` and `pnpm release` → `dist-release/0.102.0/`. Report the dist path and stop.

**S — server** (Whombat `apps/server/src/managed/` and `apps/server/src/desk/`).
- `ManagerSocketClient` + `ManagerPort`: `hostHardware()`, `networkState()`, `wifiScan()`, `wifiJoin()`, `wifiForget()`
  (2 s timeout, 15 s for scan and join's answer; answer caps as `hostMetrics`). Map manager error codes to session
  errors.
- Services and session ops §2.3 (owners only, `not_managed` without a host, `unavailable` on failure with throttled
  warnings), features advertised when managed. Wi-Fi joins and forgets write one audit entry through the pipeline
  (“{person} joined the Wi-Fi network “{ssid}”.” · “… forgot …”) if the audit log has a command for host actions;
  never the password.
- Desk socket §2.5 with the HD-07 rule: claimed from the runtime's own claim state, online from `networkState()`,
  unlocked from `DeskLock`; join/forget from the screen also touch the unlock (as decide does) and write the audit
  entry as “the screen”.
- The managed dev world / fakes: a fake manager answering hardware (a Z13-like machine: MediaTek MT7925 Wi-Fi, AMD
  HD-Audio + ACP microphone card, Radeon 8060S graphics, NVMe, a battery, a USB Ethernet adapter with `cdc_ncm` or
  `r8152`) and networks (a few SSIDs, one hidden, one enterprise; joins that succeed, fail with `wrong_password`, and
  run through `applying → confirming → committed` on a short injected clock).
- Tests: unit for the may-change rule, error mapping, the fake's phases; an int test only if an audit command is added.

**W — web** (whombat-app `packages/client` + `apps/web`).
- Client: ops in `session/managed-ops.ts`; `FEATURE_NAMES` entries; `packages/client/src/host/network.ts` (model,
  poller while a change runs, words: “Cable · Connected”, “Wi-Fi · {ssid} · {Strong|Good|Weak} signal”, failures per
  HD-11) and `hardware.ts` (grouping by kind, problems first, words per status, and `hardwareReportText(h, {burrow,
  version})` — the downloadable text: a header, machine/CPU/memory/kernel lines, one aligned line per device (kind, name,
  vendor, id, driver, status, interface/link/capture/playback), then the kernel lines). Shared with Android.
- Settings → This Whombat → **Overview**: a **NETWORK** section (feature `host.network`, owners, managed), after SCREEN:
  the connection rows (cable/Wi-Fi with signal; “No Wi-Fi card” / “This Wi-Fi card has no driver yet.” when
  `wifiMissing`), the saved networks with **Forget**, **Join a Wi-Fi network** → a dialog: the scan list (bars, a lock
  for secured, “Saved”, “Connected”, company networks disabled with a reason), **Other network…** (name + security),
  the password field with show/hide, the guard note (“If {burrow} can’t reach the internet on the new network, it goes
  back to the one it uses now.”), Joining… → Joined / the failure. A running change shows inline in the section.
- About: a **HARDWARE** section (feature `host.hardware`, owners) beside DIAGNOSTICS: problems first (one line each),
  then the groups (Network · Sound · Graphics & screens · Storage · Power · Other) as compact rows, and **Download
  report** (a `.txt` via the client helper, `whombat-hardware-YYYY-MM-DD.txt`).
- Fake world + fixtures (`hostFixtures.ts`, the managed e2e world): a Z13-like machine, a VM, and a machine with a
  driverless Wi-Fi card. Visual check 1440×900 light and dark against the surrounding Settings style; Playwright
  baselines for the new sections.

**M — Android** (whombat-app `apps/mobile`; uses W's client model — build against §2 and the client's planned API, and
`git merge hw` when the lead says W's client landed).
- The NETWORK card on the This Whombat screen (Overview) with the same rows and a Wi-Fi sheet (list, password with
  show/hide, other network, joining and failure states), the HARDWARE card on the About screen with **Share report** (the
  same text through the share sheet as a `.txt`). 44 px targets. Emulator check light and dark.

**N — network** (appliance; owns `nix/modules/network.nix`, a new `nix/modules/wifi.nix`, the installer profiles'
networking, `helper/` Wi-Fi ops and `helper/pkg/wifi`, `manager/internal/netguard` and the manager's network routes,
`third_party/whombat-contracts-go` re-vendor, a new VM test `wifi`).
- Re-vendor contracts-go 0.102.0 when C has released it (A and P merge it from `hw`); until then build against §2.
- Nix: iwd (`networking.wireless.iwd`, `General.EnableNetworkConfiguration=false`, no wpa_supplicant), networkd
  `wl*` DHCP + IPv6 RA with route metric 600 and the cable's default network at 100, `wait-online` any interface as now;
  the helper may write `/var/lib/iwd` and talk to iwd on the system bus; the egress table needs nothing (it matches no
  interfaces — check). The installer ISO gets iwd too (its own DHCP or networkd, your choice; P's installer needs scan,
  join, status and the profile file). Record why `networking.wireless.enable` stays false.
- `helper/pkg/wifi`: the iwd D-Bus client (stations, scan + ordered networks, known networks, connect with a profile
  written first, forget, state) and the profile files (`/var/lib/iwd/<encoded name>.psk|.open`, iwd's name encoding,
  0600 root). Commit its API early (the lead merges it to `hw` for P).
- Helper ops §2.6 with the dead-man revert (`systemd-run --on-active`) armed before a guarded join; a wrong password
  (iwd's `net.connman.iwd.Failed`/`InvalidFormat`, or no 4-way handshake) → `wrong_password`, profile removed.
- Manager: `networkState` (wired from `/sys/class/net` + addresses, Wi-Fi from the helper's `wifi-status`, `online`
  from the guard's control check, cached ≤ 60 s, re-checked on demand), the Wi-Fi routes, the guard's `join`/`forget`
  changes (maintenance lock, `applying → confirming → committed | reverting → reverted`, `failed` with the failure;
  confirm needed only when the box was online before; 120 s default), one change at a time (`busy`). Unit tests with a
  fake helper and clock.
- VM test `wifi`: `mac80211_hwsim` (2 radios), hostapd WPA2 on one, the appliance's iwd + networkd on the other, a DHCP
  server and a fake control endpoint on the AP side; through the manager's socket as the runtime's uid: scan finds the
  network; a wrong password fails and keeps nothing; the right one joins, gets an address, commits; with the control
  endpoint unreachable the join reverts (profile gone).
- Decisions: NX-240… (nixos.md: supersede NX-92's “no Wi-Fi”), MG-100… (manager.md: extend MG-15).

**A — sound + hardware** (appliance; owns `nix/modules/kiosk.nix`'s audio parts, a new `nix/modules/sound.nix`,
`manager/internal/hardware/`, the manager's `hostHardware` route, the helper's `hardware-log` op, `vm-tests/console-self.nix`
and `vm-tests/voice.nix` audio parts).
- Sound (HD-04): with `whombat.kiosk.desk`, `services.pipewire` system-wide with WirePlumber, ALSA and the PulseAudio
  socket; the kiosk user in the `pipewire` group and Chromium pointed at the PulseAudio socket (`PULSE_SERVER`), its
  sandbox allowing it; `alsactl init` stays; no JACK, no Bluetooth. Check what WirePlumber needs without a logind seat
  session for its own user (system mode) and that the kiosk's session still gets the cards. Measure and record the
  closure size added. Update the NX-163 text where it says ALSA only, and record HD-02 (the kernel) as an NX entry.
- `console-self`: with its emulated intel-hda card, PipeWire has a non-monitor source and a sink, and the kiosk's user
  sees them through the PulseAudio socket (`pactl` as that user); keep every existing check passing.
- Hardware (HD-03): `manager/internal/hardware` reads sysfs/procfs (roots injectable, like `hostmetrics`): DMI
  (`/sys/class/dmi/id`: sys_vendor, product_name, product_family, bios_version — never serials), CPU and memory, PCI
  (class → kind, vendor/device ids, bound driver, names from hwdata `pci.ids`), USB (interfaces' classes and drivers,
  names from `usb.ids` or the device's own strings), `/sys/class/net` (wired/wifi by `wireless`/`phy80211`, link,
  speed; no MACs), sound (`/proc/asound/cards` and `pcm`: capture/playback per card), DRM connectors, block devices
  (non-removable disks with size and model), power supplies, Bluetooth, cameras (video4linux), rfkill (`disabled`).
  Status: `no_driver` for a device class that needs one with nothing bound (not bridges, host controllers' internal
  functions, etc.), `no_firmware` when the kernel log names a firmware file the device's driver failed to load. The
  hwdata files reach the manager without a new field in its strict config (an older known-good manager must still read
  it, config.go's note) — e.g. a flag or a fixed store path. `hardware-log` in the helper: `/dev/kmsg` (or
  `journalctl -k`) lines matching firmware load failures, driver probe errors, and “no driver” hints; ≤ 40, cleaned.
  Unit tests with fixture trees, including one modelled on the Z13 (MT7925 `14c3:7925` on `mt7925e`, HD-Audio cards,
  an `acp-pdm-mic` card with one capture device, amdgpu `1002:1586`, a USB `r8152` adapter), one VM (virtio, QEMU), and
  one with an Intel Wi-Fi card without a driver.
- Decisions: NX-255… (nixos.md), MG-110… (manager.md).

**P — console + installer** (appliance; owns `console/cmd`, `console/internal` (incl. `installer`), `console/ui`).
- Console server §2.6 (dial through the existing desk client; same peer checks; `Clean` every string; the `--once
  --json` view keeps agreeing with `/api/state`).
- The box's screen: a **Wi-Fi** sheet (list with bars and locks, Saved/Connected, Other network…, the password with
  show/hide and the on-screen keyboard (HD-09: letters, digits, symbols, shift, backspace; a real keyboard works too),
  Joining… → Joined / the failure; read-only with “Unlock the screen to change Wi-Fi, or change it in the app.” when
  `mayChange` is false). Where it opens: the waiting scene (“Connect a network cable, or choose a Wi-Fi network.” +
  **Choose Wi-Fi**), the claim scenes and the claimed/desk screens (a small network chip showing cable/Wi-Fi/none that
  opens the sheet; on the desk next to the lock chip).
- Installer (HD-08): after the checks, when no wired interface has an address, a **Wi-Fi** step (the same sheet's list,
  password and keyboard; Skip), joined through `helper/pkg/wifi` (build against an interface with a fake until N's
  package is on `hw`); `/api/install` copies the joined profile into the target's `/var/lib/iwd`; the `network` check
  passes with Wi-Fi.
- Fixtures for every scene and sub-state (`?demo=`), `pnpm shots` at 1280×800, 2560×1600 and 1024×768; Go tests in
  `consoleapi` and `installer` with fakes. Decisions CG-100….

## 4. Order and shipping (the lead)

1. C (after desk auto-pair’s 0.101.0), then vendor 0.102.0 into Whombat `hw` and app `hw`; S, W, M merge `hw`.
2. After `platform-neutral` is on appliance main: appliance `hw` from main, then N, A, P; N's `helper/pkg/wifi` and
   the contracts-go re-vendor merged to `hw` early for A and P.
3. App release 0.105.0 (web vendored into Whombat, APK on DEV), Whombat main, appliance main, then
   `dev/candidate --minor --hosts <hosts rev>` (a host release: nix, manager, helper and console change); the
   Z13 takes it as a DEV box (check its rollout, device `wb-h7mq-2xvd-4410`).
4. Live: the Z13's hardware report (what it really has), Talk records the right microphone, Wi-Fi joins after the USB
   adapter is unplugged (John), and the DEV VM still Healthy.
