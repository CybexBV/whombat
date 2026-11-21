# Bluetooth — build brief (2026-10-20)

Decisions: `docs/decisions/bluetooth.md` (BT-01…BT-11). **Read it first**, then §1, §2 and your stream's part of §3.
There is no mockup: follow the nearest existing pattern — Wi-Fi, built earlier today (Whombat
`docs/decisions/hardware-support.md`, `docs/implementation/hardware-support/assignment.md`): web
`apps/web/src/features/machine/NetworkSection.tsx` + `WifiDialog.tsx`, Android `apps/mobile/src/managed/NetworkSection.tsx`
+ `WifiSheet.tsx`, the box's screen `console/ui/src/wifi/` and the desk's sheets (`console/ui/src/desk/Sheet.tsx`),
the server's `apps/server/src/managed/host-network.ts` and `apps/server/src/desk/network.ts`, the presence socket
(contracts `packages/control-contracts/src/local/presence.ts`, server `apps/server/src/desk/presence.ts`, appliance
`nix/modules/presence.nix` and `presence/`).

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-bt` | `bt` (main) | CT-670…CT-699, 0.109.0 |
| S server | Whombat | `~/Code/.wt/whombat-bt-server` | `bt-server` (`bt`) | BT-S01… |
| W web | whombat-app | `~/Code/.wt/app-bt-web` | `bt-web` (`bt`) | AP-3700…AP-3749 |
| M Android | whombat-app | `~/Code/.wt/app-bt-mobile` | `bt-mobile` (`bt`) | AP-3750…AP-3799 |
| B Bluetooth service + system | the appliance | `~/Code/.wt/appliance-bt-service` | `bt-service` (`bt`) | NX-350…NX-369 |
| P box's screen | the appliance | `~/Code/.wt/appliance-bt-console` | `bt-console` (`bt`) | CG-200…CG-229 |

Integration branches `bt` in Whombat (`~/Code/.wt/whombat-bt`), whombat-app (`~/Code/.wt/app-bt`) and
the appliance (`~/Code/.wt/appliance-bt`) are the lead's. C commits straight to its `bt`.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `web: …`,
  `mobile: …`, `client: …`, `nix: …`, `bluetooth: …`, `console: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or another stream's
  branch, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-appliance`): other sessions work there. The lead merges, vendors and ships.
- **Contracts 0.109.0 arrive on `bt`** (Whombat and app vendor them; the appliance gets the Go module). Start with what
  doesn't need the new types, against §2's shapes (a local stand-in type you delete later is fine); when the lead says
  they are vendored, `git merge bt`. Need a contract change? Don't edit vendored files: tell the lead the exact additive
  change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet` and `go test` of what you touched; `console/ui`: `pnpm check` there; Nix: the `nix build`s /
  checks your §3 names), plus `pnpm test:server` once (S). Run single test files while you work. No CI waits, no VM tests
  except the one §3 names (run it once at the end). Own ports (S 4560, W 4564/5264) and throwaway databases; the shared
  Postgres :55432 and Mailpit are never stopped or reset. `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`. Nix needs
  `--extra-experimental-features 'nix-command flakes'`. Temporary containers or VMs only through
  `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first), and release what you
  lease. NixOS VM tests run as the flake runs them (`nix build .#checks.x86_64-linux.<name>`). Node 24:
  `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`.
- **Android emulator** (M): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5622
  (`emulator -avd whombat-mobile -port 5622 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5622 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services, DEV box (`whombat-dev-box`, `wb-k2rt-8pwn-5521`) or his Z13**
  (`wb-h7mq-2xvd-4410`) from tests or scripts, never run an installer or a candidate. The lead does the real ones.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (BlueZ's answers into devices and kinds, the agent's
  callbacks into phases, failures from BlueZ errors, signal bars, ordering and filtering, the may-change rule, the
  words). Fakes in process. A new `*.int.test.ts` needs a reason to need Postgres. Check facts (kinds, phases, codes, a
  key phrase), never long literal text. Inject clocks and short timeouts, never sleep.
- **Copy**: BT-11's words are the words; new ones in the same voice (plain, short, `docs/decisions/concise-replies.md`),
  curly quotes (’ “ ”), `·`, `…`. Device addresses never in logs or audit text (BT-10).
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file (ids in the table): Whombat `docs/decisions/bluetooth-server.md` (S);
  app `bluetooth-web.md` (W), `bluetooth-android.md` (M); appliance `nixos.md` (B), `console-gui.md` (P); C in
  `docs/decisions/contracts.md`.
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes

Names are binding; field details may be refined by C where a rule of the contracts repo requires it (C tells the lead).
Timestamps RFC 3339 UTC. Display strings (device and adapter names) are validated as `ConsoleDisplayText` is (printable,
no control or format characters) with the max lengths below; producers clean them rather than fail.

### 2.1 Shapes (`@whombat/protocol/session`, a new `bluetooth.ts`; Go generated) — C

- `BluetoothAddress`: `/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/` (upper case; producers upper-case).
- `BluetoothKind = 'keyboard' | 'mouse' | 'headphones' | 'headset' | 'speaker' | 'gamepad' | 'other'` (mouse covers
  trackpads and pens; phones and computers never cross the wire, BT-01).
- `BluetoothSignal = 0..4` (bars; producers map RSSI dBm: ≥ −60 → 4, ≥ −70 → 3, ≥ −80 → 2, ≥ −90 → 1, else 0).
- `BluetoothDevice { address, name: 1..80, kind, connected: boolean, battery?: 0..100, signal?: BluetoothSignal }`.
- `BluetoothScan { until: Timestamp, devices: BluetoothDevice[] (≤64; not paired; named only; strongest first) }`.
- `BluetoothPairingPhase = 'pairing' | 'code' | 'confirm' | 'connecting' | 'done' | 'failed'`;
  `BluetoothPairingFailure = 'rejected' | 'timeout' | 'not_found' | 'canceled' | 'failed'`.
- `BluetoothPairing { id: /^p-[a-z0-9]{8,32}$/, address, name: 1..80, kind, phase, deadline: Timestamp,
  code?: /^[0-9]{4,6}$/ (phase `code` or `confirm`), typed?: 0..6 (phase `code`: digits typed so far, when the device says),
  failure?: BluetoothPairingFailure (phase `failed`) }`.
- `BluetoothState { adapter: { name: 1..80, powered: boolean } | null, missing?: 'no_adapter' | 'no_driver' | 'disabled'
  (when `adapter` is null or not powered), devices: BluetoothDevice[] (paired, ≤32, connected first then by name),
  scan: BluetoothScan | null (while looking), pairing: BluetoothPairing | null (the running one, or the last one for 60 s
  after it ended) }`.
- Constants: `BLUETOOTH_SCAN_S = 60`, `BLUETOOTH_PAIRING_S = 90`, `BLUETOOTH_POLL_MS = 1000` (clients poll state this
  often while `scan` or a running `pairing` is there), `BLUETOOTH_RESULT_KEEP_S = 60`.
- Errors (`BLUETOOTH_ERRORS`): `no_bluetooth` (no adapter, or it is off), `busy` (a pairing runs), `not_found` (no
  device with that address in the scan or the paired list; a pairing id that isn't the current one), `not_paired`,
  `unavailable`.

### 2.2 Session ops (`@whombat/protocol/session`) — C

Session-native, channel `app`, in `SESSION_SPECS` and the safety table; feature **`host.bluetooth`** (`SINCE_0_109`);
bump `SESSION_API_LEVEL` (41 → 42) as `docs/publishing.md` says. Owners only.

| Op | In → Out | Safety |
|---|---|---|
| `host.bluetooth` | `{}` → `{ bluetooth: BluetoothState \| null, reason?: 'not_managed' \| 'unavailable' }` | READ |
| `host.bluetooth.scan` | `{}` → `{ scan: BluetoothScan \| null, reason?: … \| 'no_bluetooth' }` | READ |
| `host.bluetooth.pair` | `{ address }` → `{ pairing }` | NEVER |
| `host.bluetooth.confirm` | `{ pairingId, accept: boolean }` → `{ pairing }` | NEVER |
| `host.bluetooth.cancel` | `{ pairingId }` → `{ pairing }` | NEVER |
| `host.bluetooth.connect` | `{ address }` → `{ device }` | NEVER |
| `host.bluetooth.disconnect` | `{ address }` → `{ device }` | NEVER |
| `host.bluetooth.forget` | `{ address }` → `{}` | NEVER |

Errors: §2.1's codes mapped onto the session error registry the way `host.wifi.*` did (C picks; `forbidden` for
non-owners). Realtime: none — the app polls `host.bluetooth` every `BLUETOOTH_POLL_MS` while looking or pairing.
Audit: two appliance event types (BT-08) in `APPLIANCE_EVENT_TYPES`: `bluetooth.device_paired` and
`bluetooth.device_removed`, payload `{ name, kind, via: 'app' | 'screen' }` (no address).

### 2.3 The Bluetooth socket (`@whombat/control-contracts/local`, a new `bluetooth.ts`, TS + generated Go + vectors) — C; served by B, used by S

The runtime → the appliance's `whombat-bluetooth`, HTTP/1.1 JSON over a unix socket at `WHOMBAT_BLUETOOTH_SOCKET`
(`BLUETOOTH_SOCKET_DEFAULT = '/run/whombat-bluetooth/bluetooth.sock'`; unset: no Bluetooth, the server says
`not_managed`). Bodies strict, `v: 1`, ≤ `BLUETOOTH_REQUEST_MAX_BYTES` (1 KiB). Errors `LocalError` with §2.1's codes plus
`bad_request` (400), `too_large` (413); `no_bluetooth`, `busy`, `not_paired` 409; `not_found` 404; `unavailable` 503.

| Path (`BLUETOOTH_PATHS`) | Request → Answer |
|---|---|
| `state` `GET /v1/bluetooth/state` | → `{v, bluetooth: BluetoothState}` |
| `scan` `POST /v1/bluetooth/scan` | `{v}` → `{v, scan: BluetoothScan}` (starts looking or keeps it on `BLUETOOTH_SCAN_S` more) |
| `pair` `POST /v1/bluetooth/pair` | `{v, address}` → 202 `{v, pairing}` (stops looking; runs in the background) |
| `confirm` `POST /v1/bluetooth/pairing/confirm` | `{v, pairingId, accept}` → `{v, pairing}` |
| `cancel` `POST /v1/bluetooth/pairing/cancel` | `{v, pairingId}` → `{v, pairing}` |
| `connect` `POST /v1/bluetooth/connect` | `{v, address}` → `{v, device}` (waits ≤ 15 s) |
| `disconnect` `POST /v1/bluetooth/disconnect` | `{v, address}` → `{v, device}` |
| `forget` `POST /v1/bluetooth/forget` | `{v, address}` → `{v}` |

### 2.4 Desk socket additions (`@whombat/control-contracts/local` `desk.ts`) — C; served by S, used by P

| Path (`DESK_PATHS`) | Request → Answer |
|---|---|
| `bluetooth` `GET /v1/desk/bluetooth` | → `{v, bluetooth: BluetoothState, mayChange: boolean, why?: 'locked'}` |
| `bluetoothScan` `POST /v1/desk/bluetooth/scan` | `{v}` → `{v, scan}` |
| `bluetoothPair` `POST /v1/desk/bluetooth/pair` | `{v, address}` → `{v, pairing}` |
| `bluetoothConfirm` `POST /v1/desk/bluetooth/confirm` | `{v, pairingId, accept}` → `{v, pairing}` |
| `bluetoothCancel` `POST /v1/desk/bluetooth/cancel` | `{v, pairingId}` → `{v, pairing}` |
| `bluetoothConnect` / `bluetoothDisconnect` `POST /v1/desk/bluetooth/connect` / `…/disconnect` | `{v, address}` → `{v, device}` |
| `bluetoothForget` `POST /v1/desk/bluetooth/forget` | `{v, address}` → `{v}` |

`mayChange` (BT-02): the box isn't claimed, or the desk is unlocked. Every POST when `mayChange` is false → 409 `locked`;
§2.1's codes pass through. When the runtime has no Bluetooth socket: 409 `no_bluetooth` (GET answers
`bluetooth.adapter: null, missing: 'no_adapter'`).

## 3. Streams

**C — contracts.** §2.1–2.4 with tests and vectors as the repo does them (`pnpm gen`, `pnpm gen:check`, the conformance
registry and schema cases, `docs/local-ipc.md`, `docs/session-protocol.md`, CT rows in `docs/decisions/contracts.md`).
Bump to 0.109.0, tag `contracts-v0.109.0` on `bt` and `pnpm release` → `dist-release/0.109.0/`. Report the dist path
and stop. (Check `git log origin/main` first: if another session released a 0.109.0 meanwhile, tell the lead before
tagging.)

**S — server** (Whombat `apps/server/src/managed/` and `apps/server/src/desk/`).
- A Bluetooth socket client (as the presence client: `WHOMBAT_BLUETOOTH_SOCKET` in `config.ts`, 2 s timeout, 15 s for
  `connect`, answer caps), a service, the session ops §2.2 (owners only, `not_managed` without the socket, `unavailable`
  on failure with throttled warnings), the feature advertised only when the socket is configured.
- Pairing (when it reaches `done`) and forgetting write one appliance audit event each (§2.2, as HD-S06 did for Wi-Fi:
  its own transaction once the service answered; actor the owner's account and device, none from the screen). The
  server learns a pairing finished by polling state while one it started runs, or when it next reads state — pick the
  simplest that never writes the same pairing twice.
- Desk socket §2.4 with BT-02's rule (claimed from the runtime's claim state, unlocked from `DeskLock`); changes from the
  screen also touch the unlock as `decide` does.
- The managed dev world / fakes: a fake Bluetooth service with an adapter, two paired devices (“Keychron K3” keyboard,
  connected, battery 80; “WH-1000XM5” headphones, not connected) and a scan that finds “MX Master 3S” (mouse, pairs
  without a code), “Magic Keyboard” (keyboard, phase `code` with `typed` rising, then done), “JBL Flip 6” (speaker), a
  “Pixel 9” phone that never shows (BT-01) and one device whose pairing fails `rejected`; phases on a short injected clock.
- Tests: unit for the may-change rule, error mapping, the audit-once rule, the fake's phases; an int test only if the
  audit write needs one.

**W — web** (whombat-app `packages/client` + `apps/web`).
- Client: ops in `session/managed-ops.ts`; `FEATURE_NAMES` entry; `packages/client/src/host/bluetooth.ts` (model: kind
  words and icons' names, rows ordered as §2.1, the poller while looking or pairing, phase and failure words per BT-11,
  `battery` as “Battery 80 %”), shared with Android; the fake world (`apps/web/src/managed/fake/world.ts`) as S's fake.
- Settings → This Whombat → **Overview**: a **BLUETOOTH** section after NETWORK (feature `host.bluetooth`, owners,
  managed; hidden when `missing` is `no_adapter`; the missing words otherwise): one row per paired device (kind icon,
  name, “Connected · Battery 80 %” / “Not connected”, a menu with Connect or Disconnect and Remove → confirm), **Add a
  device** → a dialog: the hint, “Looking for devices…” with the list (kind icon, name, bars), choose → “Pairing with
  {name}…” → the code (large digits, the typed ones marked) or the Yes/No question → “{name} is ready.” / the failure with
  **Try again**; closing the dialog cancels a running pairing.
- Visual check 1440×900 light and dark against the surrounding Settings style; Playwright baselines for the new section
  and the dialog's states.

**M — Android** (whombat-app `apps/mobile`; uses W's client model — W commits it first, the lead merges it to `bt` and
tells you; until then build the UI against §2 and W's planned API).
- The BLUETOOTH card on the This Whombat screen (Overview) with the same rows and actions, and an **Add a device** sheet
  (looking, list, pairing, code, Yes/No, done, failure). 44 px targets. Emulator check light and dark.

**B — Bluetooth service + system** (appliance; owns a new `nix/modules/bluetooth.nix`, the Bluetooth parts of
`nix/modules/sound.nix`, a new Go tree `bluetooth/` (like `presence/`), `pkgs.whombat-bluetooth`, `runtime.nix`'s
`WHOMBAT_BLUETOOTH_SOCKET`, the factory reset's `/var/lib/bluetooth`, `third_party/whombat-contracts-go` re-vendor, a new VM
test `bluetooth`).
- Re-vendor contracts-go 0.109.0 when C has released it (P merges it from `bt`); until then build against §2.
- Nix (`whombat.bluetooth.enable`, default off, **on with `whombat.kiosk.desk`** like sound): BlueZ
  (`hardware.bluetooth`, powered at boot, never discoverable, `AlwaysPairable=false`, `JustWorksRepairing=never`,
  `input.conf` `ClassicBondedOnly=true`, reconnecting trusted devices); a D-Bus policy that lets only root, PipeWire's
  user and `whombat-bluetooth` reach `org.bluez` (BT-09; prove another user is refused); `rfkill unblock bluetooth` at
  boot (as `whombat-wifi-on` does for Wi-Fi); WirePlumber's Bluetooth monitor on (it was off, NX-255) with what system-wide
  mode needs (no seat monitoring), A2DP and headset profiles; check that a connected Bluetooth sink becomes the default
  and the box's speaker comes back after (BT-06), and record what Talk's microphone does; `/var/lib/bluetooth` emptied by
  the factory reset (NX-247's place). Measure and record the closure size added.
- `whombat-bluetooth` (Go, its own user, socket 0660 as presence's, on demand like presence, no network): §2.3 over the
  system bus with godbus — `org.bluez` objects (Adapter1 discovery with a filter, Device1 Pair/Connect/Disconnect/Trusted,
  Adapter1.RemoveDevice, Battery1), an `org.bluez.Agent1` registered as default **only while a pairing runs**, capability
  `DisplayYesNo` (BT-04: `DisplayPasskey` → phase `code` with `typed`, `DisplayPinCode` → `code`, `RequestConfirmation`
  → `confirm` and waits for the answer, `RequestAuthorization`/`AuthorizeService` → yes only for the device being paired,
  `RequestPinCode` → `0000` once, `RequestPasskey` → refused), then Trusted + Connect (`connecting` → `done`). Kinds from
  `Icon`, then `Appearance`/`Class` (phones and computers left out); names cleaned; RSSI → bars; BlueZ errors → failures.
  Unit tests against a fake BlueZ (interfaces in process), including each agent path and the deadline.
- VM test `bluetooth` (run once at the end): BlueZ with a virtual controller (`hci_vhci`, e.g. bluez's `btvirt` or
  `btvirt`-like tooling if nixpkgs' bluez has it); `whombat-bluetooth` answers state through its socket as the runtime's
  uid; another user is refused by D-Bus; if two virtual controllers can see each other within reasonable effort, a
  pairing without a code runs to `done`. Record what it does and doesn't cover.
- Decisions NX-350… in `nixos.md`.

**P — box's screen** (appliance; owns `console/cmd`, `console/internal`, `console/ui`).
- Console server: `GET /api/bluetooth` and `POST /api/bluetooth/scan|pair|confirm|cancel|connect|disconnect|forget`
  (proxies of §2.4 through the existing desk client; bodies ≤ 1 KiB, strings cleaned, the same peer checks).
- The box's screen (claimed desk, and the unclaimed scenes only if they already have a settings-like place; else desk
  only): a Bluetooth chip next to the network chip where there is an adapter, opening a **Bluetooth** sheet: paired
  devices (icon, name, Connected · Battery / Not connected; Connect/Disconnect, Remove with a confirm), **Add a device**
  (hint, looking list, pairing, the code in very large digits with the typed ones marked, the Yes/No question, done,
  failures with Try again); read-only with the locked words when `mayChange` is false. Touch targets as the Wi-Fi sheet.
- Fixtures for every state (`?demo=`), `pnpm shots` at 1280×800, 2560×1600 and 1024×768; Go tests in `consoleapi` with
  fakes. Decisions CG-200….

## 4. Order and shipping (the lead)

1. C, then vendor 0.109.0 into Whombat `bt` and app `bt`, contracts-go into appliance `bt` (B does it there); S, W, M,
   P merge `bt`.
2. W's client merged to app `bt` early for M.
3. App release 0.111.0 (web vendored into Whombat, APK on DEV), Whombat main, appliance main, then
   `dev/candidate --minor --hosts 53ba825` (a host release); the Z13 takes it as a DEV box.
4. Live: the DEV VM still Healthy with BlueZ and the service (it has no adapter: `missing: no_adapter`); on the Z13 John
   pairs a keyboard, a mouse and a speaker.
