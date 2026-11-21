# Macs as servers: assignment

Decisions: `docs/decisions/macos-servers.md` (MAC-01…MAC-11). Read them first. This file fixes the shapes that cross
the streams' boundaries; anything inside one stream is that stream's to decide (record it: hosts in the hosts service
`docs/decisions/hosts.md` from HS-263, Whombat in `docs/decisions/macos-servers.md` from MAC-12, the app's in the same
file). Real target: John's Mac Studio (user `john`, macOS 27.2.1, arm64, passwordless sudo, Screen Sharing on and
offering RFB security types 30, 33, 36, 35, auto-login as john, FileVault off, SIP on, no MDM, Xcode 27.1, Swift 6.4).

## Rules for every stream

- Read the repository's `CLAUDE.md`, `AGENTS.md` and `CLAUDE.local.md` first. Commit on your own branch, small
  commits, messages ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge
  into `main`: the lead merges. Never `--no-verify`.
- The Mac Studio is John's working Mac: no `brew install`/`upgrade`, no keychain changes except the ones a step below
  names, nothing in `~/Code/whombat-app`, `~/Code/Whombat-publish`, `~/Code/Whombat-ipa` or `~/whombat-ios-build`. Your
  own files go in `~/whombat-macos/<stream>/` there and are removed when you finish. Don't log out, restart, or change
  Sharing, Privacy or login settings. Lock the screen again (`pmset displaysleepnow`) if you unlocked it.
- Heavy runs (whole test suites, wide builds) go through `fast-test` / `fast-test run -- <cmd>` (The Titan); a single
  package's `go test` or one Vitest file is fine locally. `TMPDIR` is `/scratch/tmp/john`.
- No secrets in commits, logs, tests or messages. The Mac password, when a step needs it, is in the file the lead names
  (read it only inside the command that uses it).

## 1. Hosts protocol (`hosts/internal/proto`, CBOR, all additive)

`AgentInfo.OS` (`os`, omitempty): `"darwin"` from macOS agents; absent means `linux`.

`Report.MacOS` (`macos`, omitempty, `*MacOS`), only from macOS agents:

```go
type MacOS struct {
	Version     string    `cbor:"version"`                // "27.2.1" (sw_vers)
	Build       string    `cbor:"build,omitempty"`        // "26B131"
	Model       string    `cbor:"model,omitempty"`        // hw.model "Mac14,14"
	ModelName   string    `cbor:"model_name,omitempty"`   // "Mac Studio" (system_profiler, once a day)
	Chip        string    `cbor:"chip,omitempty"`         // "Apple M2 Ultra"
	SIP         *bool     `cbor:"sip,omitempty"`
	FileVault   *bool     `cbor:"filevault,omitempty"`
	AutoLogin   string    `cbor:"auto_login,omitempty"`   // the auto-login user, "" none
	ConsoleUser string    `cbor:"console_user,omitempty"` // at the screen now; "" = the login window
	Screen      MacScreen `cbor:"screen"`
	Helper      MacHelper `cbor:"helper"`
}
type MacScreen struct {
	Sharing  bool   `cbor:"sharing"`             // Screen Sharing answers on 127.0.0.1:5900
	Account  string `cbor:"account,omitempty"`   // user the agent signs in as; "" = not set
	SignIn   string `cbor:"sign_in,omitempty"`   // "ok" | "failed" | "" (not tried); last check
	SignInAt time.Time `cbor:"sign_in_at,omitempty"`
	Locked   *bool  `cbor:"locked,omitempty"`    // from the helper; nil unknown
	Width    int    `cbor:"w,omitempty"`         // framebuffer size from the last sign-in
	Height   int    `cbor:"h,omitempty"`
}
type MacHelper struct {
	Installed     bool   `cbor:"installed"`
	Version       string `cbor:"version,omitempty"`
	Running       bool   `cbor:"running"`               // answered on its socket within the last minute
	Accessibility *bool  `cbor:"ax,omitempty"`          // AXIsProcessTrusted() of the running helper
	User          string `cbor:"user,omitempty"`        // whose session it runs in
}
```

Updates fill the existing `SystemInfo.UpdatesPending`, `SecurityUpdates` (0 on macOS unless Apple marks them),
`UpdatesCheckedAt`, `RebootRequired`/`RebootReason` (an installed update waiting for a restart). Disks fill `Disk` with
`SMARTStatus`-like fields as Linux does where they exist (`diskutil info -plist`'s `SMARTStatus`: `Verified` = passed).

New stream kind `screen` (hub → agent), one request per stream, runtime enforces `Policy.HostShell` (answer
`remote_control_disabled` otherwise; `op: status` also allowed with `Policy.Diagnose`):

```go
type ScreenRequest struct {
	Op      string   `cbor:"op"`
	X, Y    int      `cbor:"x,omitempty"`, `cbor:"y,omitempty"`        // framebuffer pixels
	ToX,ToY int      `cbor:"to_x,omitempty"`, `cbor:"to_y,omitempty"`  // drag end
	Button  string   `cbor:"button,omitempty"`  // left (default) | right | middle
	Clicks  int      `cbor:"clicks,omitempty"`  // 1 (default) | 2 | 3
	DX, DY  int      `cbor:"dx,omitempty"`, `cbor:"dy,omitempty"`      // scroll steps
	Text    string   `cbor:"text,omitempty"`    // type / ui.set value
	Keys    string   `cbor:"keys,omitempty"`    // "cmd+q", "return", "cmd+shift+4", "tab tab space"
	MaxW    int      `cbor:"max_w,omitempty"`   // look: scale down to this width (0 = full)
	Format  string   `cbor:"format,omitempty"`  // png (default) | jpeg
	App     string   `cbor:"app,omitempty"`     // ui.*: app name or bundle id; "" = frontmost
	Window  string   `cbor:"window,omitempty"`  // ui.list: window title (contains); "" = all of the app's
	Name    string   `cbor:"name,omitempty"`    // ui.press / ui.set: title, description, value or identifier
	Role    string   `cbor:"role,omitempty"`    // button | checkbox | switch | text_field | menu_item | link | tab | row | popup | radio | any
	Index   int      `cbor:"index,omitempty"`   // the n-th match (0 = the first)
	Path    []string `cbor:"path,omitempty"`    // ui.menu: ["File", "Save…"]
	Limit   int      `cbor:"limit,omitempty"`   // ui.list: max elements (default 300, max 1000)
	Target  string   `cbor:"target,omitempty"`  // ui.open: "accessibility" | an app name | an https URL
	Account *ScreenAccount `cbor:"account,omitempty"` // account.set only
}
type ScreenAccount struct{ User, Password string } // cbor "user", "password"; never logged, never answered
type ScreenResponse struct {
	OK       bool          `cbor:"ok"`
	Code     string        `cbor:"code,omitempty"`
	Message  string        `cbor:"message,omitempty"`
	Image    []byte        `cbor:"image,omitempty"`   // look
	Format   string        `cbor:"format,omitempty"`
	W, H     int           `cbor:"w,omitempty"`, `cbor:"h,omitempty"`          // the image's size
	ScreenW, ScreenH int   `cbor:"screen_w,omitempty"`, `cbor:"screen_h,omitempty"` // framebuffer size (click space)
	Elements []UIElement   `cbor:"elements,omitempty"` // ui.list
	Apps     []UIApp       `cbor:"apps,omitempty"`     // ui.apps
	Element  *UIElement    `cbor:"element,omitempty"`  // ui.press / ui.set: what was acted on
	Status   *MacScreen    `cbor:"status,omitempty"`   // status, account.set, account.check, unlock
	Helper   *MacHelper    `cbor:"helper,omitempty"`   // status
	Truncated bool         `cbor:"truncated,omitempty"`
}
type UIElement struct {
	ID string `cbor:"id"`  // the helper's path, e.g. "w0.3.1" (stable for one list only)
	Role, Subrole, Title, Description, Value, Identifier string // cbor role, subrole, title, desc, value, ident
	Enabled, Focused bool                                         // cbor enabled, focused
	X, Y, W, H int  // framebuffer pixels (the agent converts from the helper's points)
	Actions []string // AXPress, AXShowMenu, …
	App, Window string
}
type UIApp struct{ Name, BundleID string; PID int; Active bool; Windows []string } // cbor name, bundle_id, pid, active, windows
```

Ops: `status`, `look`, `click`, `drag`, `scroll`, `type`, `keys`, `unlock`, `account.set`, `account.check`,
`account.clear`, `ui.apps`, `ui.list`, `ui.press`, `ui.set`, `ui.menu`, `ui.focus`, `ui.open`. Codes besides the
runtime's: `invalid_request`, `unsupported` (not a Mac, or an older agent), `no_screen` (Screen Sharing off or not
answering), `no_account` (no screen account), `sign_in_failed` (the stored account was refused: `account.check` sets
`SignIn` `failed`), `no_helper` (helper not installed or not running in the console user's session), `no_access`
(helper running without Accessibility), `not_found` (ui.press/set/menu matched nothing; `Message` lists up to 10 close
names), `locked` (ui.* while the screen is locked: unlock first), `busy`, `timeout`, `failed`.
`unlock`: wakes the display, and when the lock screen or login window shows, types the stored password and Return;
answers `Status` after 3 s. `account.set` stores the account only after signing in with it succeeded (else
`sign_in_failed`, nothing stored).

## 2. The helper (WhombatHelper ↔ agent)

Socket `/var/run/whombat-agent/ui/<uid>/helper.sock`. The agent creates `/var/run/whombat-agent/ui` (root, 0755) and
`<uid>` (owned by that user, 0700) for the console user when it sees one (checked every 10 s); the helper waits for the
folder (2 s polls), removes a stale socket, listens. One request per connection: one JSON line in, one JSON line out,
then close; 10 s per request on the helper's side, 16 MiB max answer. Fields are snake_case; coordinates are global
display **points**, top-left origin of the main display.

Request: `{"v": 1, "op": "...", ...op fields}`. Answer: `{"ok": true, ...}` or `{"ok": false, "code": "...",
"message": "..."}` with codes `no_access`, `not_found`, `invalid_request`, `failed`, `locked`.

| op | request | answer |
|---|---|---|
| `status` | — | `version`, `ax` (AXIsProcessTrusted), `locked` (CGSessionCopyCurrentDictionary `CGSSessionScreenIsLocked`), `user`, `front_app`, `front_window`, `displays: [{id, x, y, w, h, scale, main}]` |
| `apps` | — | `apps: [{name, bundle_id, pid, active, windows: [title]}]` (regular apps only) |
| `list` | `app?`, `window?`, `limit?`, `depth?` (default 12) | `elements: [{id, role, subrole, title, desc, value, ident, enabled, focused, x, y, w, h, actions, app, window}]`, `truncated` — every window of the app (or the focused window only when `window` names it), its sheets and dialogs first, menus excluded; values cut to 200 characters; secure text fields' values never read |
| `press` | `app?`, `name`, `role?`, `index?` | `element` — finds by name (exact, case-insensitive, then contains) over title, description, value, identifier; prefers enabled elements in the frontmost window/sheet; performs `AXPress` (or `AXPick`/`AXConfirm`, or toggles a checkbox/switch with AXPress); when the element has no action, clicks its centre with a CGEvent |
| `set` | `app?`, `name?`, `role?`, `index?`, `value` | `element` — sets `AXValue` of a text field (or focuses it and types); with no `name`, types into the focused element |
| `type` | `text` | — types with CGEvent unicode strings into whatever has focus |
| `menu` | `app?`, `path` | `element` — the menu item it picked (menu bar path, `…` and `...` match each other) |
| `focus` | `app` | — activates the app (unhides it) |
| `open` | `target` | — `accessibility` opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`; an app name launches it; an https URL opens it |

The agent maps role words to AX roles (`button` AXButton, `checkbox` AXCheckBox, `switch` AXCheckBox/AXSwitch,
`text_field` AXTextField/AXTextArea/AXSecureTextField/AXSearchField, `menu_item` AXMenuItem, `link` AXLink, `tab`
AXRadioButton in an AXTabGroup, `row` AXRow/AXCell, `popup` AXPopUpButton/AXMenuButton, `radio` AXRadioButton,
`any`), passes them as AX roles to the helper (`role` may be a comma list), and converts points to framebuffer pixels
(`px = round((pt - display.origin) * framebuffer_w / main_display_w_points)` on the main display; elements on other
displays keep their points and `x`/`y` beyond the framebuffer).

Install (hosts `install.sh` on Darwin): `/Library/Application Support/Whombat/Whombat Helper.app` (root:wheel,
from the hub's `/download/whombat-helper-macos.zip`, sha256 baked into the script like the agent's, unpacked with
`ditto -x -k`), `/Library/LaunchAgents/com.whombat.helper.plist` (`LimitLoadToSessionType` Aqua, `RunAtLoad`,
`KeepAlive`, `ProcessType` Interactive, program `…/Whombat Helper.app/Contents/MacOS/WhombatHelper`), then `launchctl
bootstrap gui/<console uid>` for whoever is at the screen. Uninstall removes both and boots it out. The hub reads
`whombat-helper-macos.zip` and `whombat-helper-macos.json` (`{"version", "sha256", "size"}`) from `--agent-dist`;
without them a Mac installs without the helper (`MacHelper.Installed` false).

## 3. Hosts service (REST, snake_case JSON)

- Agent downloads: `/download/whombat-agent-darwin-{arm64,amd64}` and `/download/whombat-helper-macos.zip` beside the
  Linux ones. The manifest's file entries may carry `"os": "darwin"` (absent = linux); the hub picks the update build
  by the agent's `os` and `arch`.
- `detail_view` `macos` when the report has `macos`. The server detail (`GET /servers/{id}`) gains `"macos": {version,
  build, model, model_name, chip, sip, filevault, auto_login, console_user, screen: {sharing, account, sign_in,
  sign_in_at, locked, w, h}, helper: {installed, version, running, ax, user}}`; the fleet card's `os` is
  `macOS 27.2.1` and the server gains `os_family: "macos"`.
- Host console: for a `macos` server the host guest's protocols are `logs`, `shell` and `vnc` (`vnc` and `shell` only
  with the host-shell switch on both sides; `vnc` only when `screen.sharing` and `screen.account`), default `vnc`.
- `POST /servers/{id}/screen {op, x, y, to_x, to_y, button, clicks, dx, dy, text, keys, max_w, format, app, window, name,
  role, index, path, limit, target, account: {user, password}}` → 200 `{server, op, ok: true, image_b64?, format?, w?, h?,
  screen_w?, screen_h?, elements?, apps?, element?, status?, helper?, truncated?, audit_id?}`; 200 `{ok: false, code,
  message}` for the agent's own codes (`not_found`, `no_helper`, `no_access`, `locked`, `sign_in_failed`, `no_account`,
  `no_screen`); errors like exec: 400 `invalid_value`, 403 `insufficient_role`, 403 `host_shell_disabled`, 409
  `agent_offline`, 501 `unsupported` (not a Mac), 502 `agent_error`. Role: operator for `status`, `look`, `ui.apps`,
  `ui.list`; admin for everything else. Audited: every op but `status`, `look`, `ui.apps`, `ui.list`, as
  `screen.<op>` with its target (coordinates, name, keys, menu path; typed text as its length only; never the
  password). Timeout 30 s (the agent's own steps bound themselves to 25 s).
- Health: the existing offline, volume-full and disk-failing rules apply (a disk whose `diskutil` verdict isn't
  `Verified` is failing). New hints, all off by default in Whombat (MAC-10): `macos.helper_off` (installed but not
  running in the console user's session for 5 minutes), `macos.helper_no_access`, `macos.screen_sign_in`
  (`sign_in: failed`), `macos.screen_sharing_off`.

## 4. Whombat (contracts, server, web, phone)

- `HostServerPlatform` gains `macos`; `HostServerDetail.macos` (`HostMacosDetail`, camelCase of the hub's block);
  `HostConsoleProtocol` already has `vnc` (the web's host console offers it for a Mac). A Mac mark for `hostOsMark`
  (an Apple-free generic “Mac” glyph: no Apple logo, which is a trademark; use the word mark style of the other OS
  marks).
- `hosts.screen` op (server route + client), schemas in `@whombat/core` mirroring §3, `imageB64` → the agent tool's
  image.
- Agent tools (Servers catalog, `packages/core/src/domain/connections-catalog/whombat_servers.ts`): `mac_screen`
  `{server, action: look|click|double_click|right_click|drag|scroll|type|keys|unlock, x?, y?, to_x?, to_y?, dx?, dy?,
  text?, keys?}` and `mac_ui` `{server, action: apps|list|press|set|menu|focus|open, app?, window?, name?, role?,
  index?, value?, path?, target?, limit?}`. `look` (and every click/type/keys, which return a fresh look so the
  assistant sees what happened) answers with the screenshot as MCP image content (scaled to at most 1280 px wide,
  JPEG) next to a text part giving `screen_w`/`screen_h` and the scale, so the assistant clicks in framebuffer
  pixels. Both are sensitive except `look`, `apps`, `list` (they ask only when the server's “Asks you first” asks).
  The guide text tells the assistant: name first (`mac_ui press`), `look` and click by position only when nothing
  matches; `unlock` when the screen is locked; never ask the person for the Mac's password.
- `connection_call` (and the MCP layer) passes an image a Servers tool attaches (`withImage`) the way
  `browser_preview` does.
- Sign in once on a Mac: `uname -s` `Darwin` is allowed (macOS 13+ from `sw_vers -productVersion`, else
  `unsupported` with Mac words); after the install, when the user Whombat signed in as is the console user and a
  password was used, it calls `screen` `account.set` with that user and password (never stored by Whombat). The words
  for a Mac's install problems are Mac words (Screen Sharing off, too old a macOS).
- The Mac's page (web `ServerPage`, phone `ServerScreen`): the usual system tabs with macOS facts (model, chip,
  macOS version, SIP, FileVault, auto-login), and a **Screen** part: the screen view (web: the host `vnc` console;
  phone: a still `look` refreshed on demand, no live console), Screen Sharing state, the screen account (“Set the
  Mac's password” form calling `account.set`, “Check”, “Forget”), the helper (installed / running / Accessibility,
  with “Open the setting on the Mac” → `ui.open accessibility`) and “Unlock the screen”. Copy is plain and short
  (CLAUDE.md); the person never types the password anywhere but this form or Sign in once.
- Watch checks (`packages/core/src/domain/host-watch.ts`): the four `macos.*` hints, all `startsOn: false`.
- Approvals: `mac_screen`/`mac_ui` follow `HOST_ASKS_FIRST` like `server_command`.

## 5. Streams

| Stream | Repository / branch | Owns |
|---|---|---|
| **HA** agent core | the hosts service `macos-agent` | proto §1 (report types, `AgentInfo.OS`), the macOS collector, broker (power, shell, logs, inspect, packages), diagnose catalog and exec, launchd install / self-update / restart, `install.sh` Darwin branch (agent and helper), hub: downloads, manifest `os`, update choice, `detail_view`, the `macos` block, health hints. Darwin builds in the Makefile. |
| **HS** screen | the hosts service `macos-screen` | proto §1 screen types and stream kind, runtime stream, RFB type 30 in `broker/rfb.go`, the host `vnc` console on a Mac (a function the HA broker calls), the screen package (RFB capture and input, unlock, the account file, the helper client and the point→pixel mapping), `whombat-agent screen …` CLI for tests, hub `screen` route and audit, host console protocols. |
| **HH** helper | the hosts service `macos-helper` | `macos/helper/` (Swift package or Xcode project), the socket server and ops of §2, `build.sh` (universal build, Developer ID signing, notarization, zip, `whombat-helper-macos.json`), the signed zip committed under `macos/helper/dist/`. |
| **W** Whombat | Whombat `macos-w` | §4: contracts, server, web, phone, and Whombat's decision rows MAC-12+. |

HA and HS share `internal/proto/proto.go` (`Report`, stream kinds) and `cmd/whombat-agent/main.go`: HA adds `Report.MacOS`
and wires the darwin collector/broker/diagnostics; HS adds the stream kind constant, the `agent.Screen` interface
(`Screen(ctx, proto.ScreenRequest) proto.ScreenResponse`) and its runtime case, and exports
`screen.Console(ctx) (agent.ConsoleSession, proto.ConsoleResponse)` that HA's darwin broker returns for the host's
`vnc`. Keep those edits small; the lead merges `macos-agent` first, then `macos-screen`.
