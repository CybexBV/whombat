# Remote console: design and security requirements

Requirements C1 to C9 in `PRODUCT-SPEC.md` say what the console does; `SCREENS.md` section 5 says how it looks. This file says how to build it safely. The console lets a user type into a machine, so it is the riskiest feature in the product: read the security part (sections 5 to 9) before writing code, and treat the checklist in section 10 as acceptance criteria.

As everywhere in this package, the interface names below come from general knowledge and must be **verified against the versions you target** (see section 11).

## 1. What must work

| Guest | Connection types in the UI | What the user gets | Browser client |
|---|---|---|---|
| libvirt VM | VNC, SPICE, Serial | Graphical screen with keyboard and mouse; text serial console | noVNC; spice-html5; xterm.js |
| Incus VM | VGA (SPICE), Serial | Same | spice-html5; xterm.js |
| Incus container | Shell, Console | Interactive shell (exec); the container's console (tty) | xterm.js |
| Proxmox QEMU VM | noVNC, SPICE, Serial | Same as libvirt | noVNC; spice-html5; xterm.js |
| Proxmox LXC | xterm.js (shell), Console | Shell; container console | xterm.js |
| Docker | none | Out of scope | n/a |

Plus, for VMs: toolbar actions (Ctrl+Alt+Del, Paste, Screenshot, Shutdown, Reboot, Force stop), and for containers (Paste, Copy output, Restart, Stop). Plus the **Screens wall** of live thumbnails.

## 2. Data path

```
 browser (noVNC / spice-html5 / xterm.js)
    │  WSS, single-use session token
    ▼
 HUB console gateway ── authz, rate limits, audit, byte counters
    │  logical channel inside the agent's existing mTLS WebSocket
    ▼
 AGENT console broker ── opens the local endpoint, never exposes a port
    │  Unix socket / loopback / hypervisor API
    ▼
 guest display or serial (libvirt, Incus, Proxmox)
```

- The browser never connects to a hypervisor, a guest, or an agent directly.
- The agent is the only component that holds hypervisor credentials or tickets. It authenticates to the local hypervisor itself and hands the hub only a byte stream.
- The hub relays opaque bytes plus control messages (resize, close). It does not interpret the guest's screen content.

## 3. Session lifecycle

1. **Request.** The UI calls `POST /servers/{id}/guests/{guestId}/console-sessions` (`API.md` section 3). The hub checks: user is authenticated; role is operator or admin; "Remote control" is enabled on the server; the guest exists and supports the requested protocol; per-user and per-server session limits; the agent is connected. Any failure is a `403` or `409` with a `code`, and **an audit record is written** (outcome `denied`).
2. **Token.** The hub creates a random 256-bit token, stores only its hash with `{user, server, guest, protocol, session_id, expires_at, used: false}`, and returns the WebSocket URL and the token. TTL 30 s. Single use.
3. **Upgrade.** The browser opens the WebSocket. The hub validates the `Origin` header against its own origin, validates the token, marks it used, and tells the agent to open the channel.
4. **Open.** The agent opens the local endpoint for that guest and protocol (section 4), reports `console.opened` (with resolution if known), and the hub starts relaying. The UI shows "Connected · {protocol} · encrypted".
5. **Run.** Either side can send control messages (resize, clipboard text, close). The hub counts bytes, enforces limits, and extends nothing: the session has an idle timeout (default 15 minutes without user input) and a maximum age (default 8 hours).
6. **Close.** On user close, guest power off, idle timeout, max age, token revocation, role change, or server remote-control disabled, the hub closes the channel, the agent closes the local endpoint, and the hub writes the closing audit record with duration and byte counts.
7. **Reconnect.** A dropped connection shows "Connection lost · Reconnect" in the status line. Reconnecting creates a **new session and token**; old tokens are never reused.

## 4. Per-platform integration (verify each)

| Target | Agent attaches to | Notes |
|---|---|---|
| libvirt VM, VNC | The domain's graphics endpoint (see the domain XML `<graphics type='vnc'>`: Unix socket or loopback port), or a graphics file descriptor opened through the libvirt API | QEMU's VNC speaks RFB, not WebSocket; the agent wraps it. Prefer having the **agent complete the RFB authentication with the guest** and present "no authentication" to the browser over the already-authenticated tunnel, so the VNC password never reaches the browser. libvirt offers a way to open graphics with authentication skipped for privileged callers; check the current API. |
| libvirt VM, SPICE | The domain's SPICE endpoint | SPICE uses several channels (main, display, inputs, ...), each its own connection; the broker must multiplex them over one session, and spice-html5 must be pointed at that multiplexed stream. **Highest effort and highest risk; build last.** |
| libvirt VM, Serial | libvirt console stream for the domain | Needs a serial console configured in the guest. Show a clear message if the device does not exist. |
| Incus VM, VGA / Serial; Incus container, Console | Incus REST API on its Unix socket: console endpoint for the instance (text and VGA types), which returns an operation with WebSocket secrets that the agent connects to locally | Check which protocol "VGA" is in your Incus version (the mockup assumes SPICE). The agent uses its own trust to the socket. |
| Incus container, Shell | Incus REST API instance `exec` with an interactive PTY over WebSocket | Resize messages map to the PTY size. |
| Proxmox QEMU, noVNC / SPICE / Serial | Proxmox API console proxies for the VM (VNC proxy, SPICE proxy, terminal proxy) | These return a one-time ticket and a port; the agent consumes the ticket itself. **Do not pass Proxmox tickets or passwords to the browser.** Check whether your API token can create console tickets in the target version, or whether a service account with a user ticket is needed; if so store its credential only on the host. |
| Proxmox LXC, shell / console | The terminal proxy for the container | Same ticket rules. |

Cross-cutting:

- Only attach to guests that the host's inventory lists. Validate `guestId` against the inventory; never accept an arbitrary socket path or port from the hub.
- Local endpoints must be reached over Unix sockets or loopback only. If a hypervisor can only listen on a TCP port, bind it to loopback and firewall it, and have the agent verify the port belongs to the right guest.
- Per session the agent must allocate its own ephemeral resources and release them on close.

## 5. Permissions

Separate, explicit, off by default.

| Permission | Who | What it allows |
|---|---|---|
| Remote control enabled (per server) | Admin toggles | Gate for everything below. Default **off**. The agent also needs its local config flag `console = true`; the hub value alone is not enough. |
| `console` | Operator, admin | Open consoles and shells, see the Screens wall, use keyboard, mouse, Paste, Screenshot, Copy output. |
| `power` | Operator, admin (separate toggle per server) | Start, Shutdown, Reboot, Force stop, Restart, Stop. A server can allow console without power. |
| Audit log access | Admin | Read and export the audit records (section 8). |

Viewers see the guest tables and Screens placeholders but not live screens: the Screens wall shows screen content, so it needs the `console` permission too. A user without it sees the guest list, and the Console / Shell button is hidden or disabled with a tooltip stating why.

## 6. Hardening requirements

1. **TLS everywhere**: browser to hub (TLS 1.2+, TLS 1.3 preferred), agent to hub (mTLS, TLS 1.3). Never serve the console over plain `ws://`.
2. **Tokens**: random, single use, 30 s TTL, bound to user, server, guest, protocol; stored hashed; sent as a WebSocket subprotocol or first frame, never in the URL query or logs.
3. **Origin and CSRF**: check `Origin` on the upgrade; session cookies `HttpOnly; Secure; SameSite=Lax`; state-changing HTTP calls need a CSRF token.
4. **Re-authorize on every use**: revoking a role, disabling remote control, or deleting the server closes live sessions within seconds.
5. **Limits**: max concurrent sessions per user (default 5), per server (default 10), per agent (default 20); max frame size; per-session bandwidth cap; backpressure so a slow browser cannot grow hub memory without bound.
6. **Input safety**: Paste is sent as text with a size cap (default 64 KB); strip control characters other than newline and tab unless the user explicitly chooses raw paste; the keyboard shortcut Ctrl+Alt+Del is sent to the guest, never interpreted by the browser.
7. **Clipboard**: browser clipboard access only on user gesture. Never read the clipboard silently. Guest-to-host clipboard (if added later) must be opt-in per session.
8. **Thumbnails**: `Cache-Control: no-store`; ≤ 320 px; refreshed about every 5 s **only while the tile is visible**; one in-flight capture per guest; same authorization as a console; rate-limited per user.
9. **Secrets**: hypervisor credentials, Proxmox tickets and tokens, VNC/SPICE passwords stay on the host and in agent memory; they are not sent to the hub, not stored in the database, not logged, and not included in error messages. Redact them from crash reports.
10. **Untrusted content**: guest names, images, and anything rendered from the guest are attacker-controlled; escape on output. Terminal output is rendered by xterm.js only; do not interpret it as HTML.
11. **Isolation**: a console session must not reach beyond its guest. One agent channel per session; closing it closes the local endpoint.
12. **Fail closed**: if the agent cannot verify the target guest, it refuses; if the hub cannot write the audit record for a *session start*, it refuses to start the session.
13. **Rate-limit failures**: repeated denied requests from one user or IP raise an alert and are throttled.

## 7. Power actions

- The toolbar buttons call `POST .../actions` (`API.md`). The real UI **must confirm**: a modal that names the guest and the action, a primary button labeled with the action ("Shut down web-01"), and Esc to cancel. **Force stop** and **Stop** use the `--serious` color and need an extra explicit step (type the guest name or hold-to-confirm). The mockup only shows a confirmation chip; do not copy that.
- Actions are idempotent where possible; if the target is already in the requested state, return success with `noop: true`.
- Verify the outcome: poll the guest state for up to 60 s and emit `action.finished` with `ok` or `error` and the observed state.
- Shutdown uses the graceful path (ACPI or guest agent); Force stop is a hard power-off and the confirmation says data may be lost.
- Each action is audited before it is sent and updated with the result.
- A stopped guest's toolbar is disabled; **Start** is the only enabled action (needs `power`).

## 8. Audit

Record, append-only, one entry per event:

| Field | Notes |
|---|---|
| `id`, `at` (UTC) | |
| `user`, `role`, `client_ip`, `user_agent` | |
| `server`, `guest`, `platform` | |
| `event` | `console.requested`, `console.denied`, `console.opened`, `console.closed`, `console.switched` (side list), `action.requested`, `action.finished`, `remote_control.enabled`, `remote_control.disabled`, `screens.viewed` (once per view, not per thumbnail) |
| `protocol` | `vnc`, `spice`, `serial`, `shell`, `tty` |
| `outcome` | `ok`, `denied`, `error` plus `code` |
| `duration_s`, `bytes_in`, `bytes_out` | On close |

**Never record** keystrokes, clipboard contents, screen content, tokens, or terminal output. Retention default 1 year. Only admins can read it. Provide an export. Deleting audit records is not supported from the UI.

## 9. Threat model (short)

| Threat | Mitigation |
|---|---|
| Stolen browser session opens a console | Short role-gated permissions, per-server enablement, session limits, audit, idle timeout, optional step-up auth (re-enter passkey) for first console in a session (recommended, not designed) |
| Token interception or replay | TLS, 30 s TTL, single use, bound to user and guest, not in URLs |
| Cross-site WebSocket hijacking | Origin check, SameSite cookies, token required for the upgrade |
| Malicious or compromised agent | mTLS identity, per-agent session caps, hub treats all agent messages as untrusted input, strict schemas |
| Hub compromise | Agents hold hypervisor credentials; the hub does not. Console still needs the agent's local opt-in flag |
| Guest escapes into the console path | Console stream is bytes only; no code execution in agent or hub from guest data; sizes and rates bounded |
| Information leak via thumbnails | Same permission as console, `no-store`, only while visible |
| Denial of service by many sessions | Limits per user, server and agent; backpressure |
| Credential leak in logs | Redaction at the logger, tests that grep logs for token patterns |

## 10. Security checklist (acceptance for M7)

Mark each item with evidence (test name or manual note) in `NOTES.md`.

- [ ] Remote control is **off** on a freshly enrolled server; the Console and Shell buttons are not usable until an admin enables it.
- [ ] A viewer cannot open a console, see a live thumbnail, or call the console-session or action endpoints (all return 403 and write a `denied` audit record).
- [ ] An operator on a server where `console` is enabled but `power` is not can open a console but every power button is disabled and the API refuses.
- [ ] Console tokens expire after 30 s and fail on second use.
- [ ] A console token for guest A fails for guest B and for another user.
- [ ] The WebSocket upgrade from a foreign `Origin` is rejected.
- [ ] No token, ticket, VNC password, API token or key appears in browser URLs, the hub's logs, the agent's logs, API responses, or the audit log (automated grep of logs after a full session).
- [ ] The agent opens no listening socket on a routable interface (check with `ss -ltn` during a session).
- [ ] Disabling remote control or deleting the server closes live sessions within 10 s.
- [ ] Idle timeout and maximum age close sessions; the UI shows the lost-connection state with Reconnect.
- [ ] Concurrent-session limits are enforced and return a readable error.
- [ ] Pasting a 1 MB string is rejected with a message; pasting text with control characters is sanitized or the user is asked.
- [ ] Every console open, close, switch and power action has exactly one audit record with the user, guest, protocol and outcome; stopping the audit store prevents new sessions.
- [ ] Destructive actions require the confirmation step in the UI **and** `confirm: true` in the API.
- [ ] Thumbnails are not requested for tiles outside the viewport and stop when the tab is hidden.
- [ ] Keyboard focus can leave the console screen (Ctrl+Alt, as the hint line says) so the page stays operable by keyboard.

## 11. Verify before building

1. **Each platform's console API** in the exact versions you support (Incus, libvirt/QEMU, Proxmox VE): authentication of the console endpoints, one-time ticket lifetimes, and WebSocket support.
2. **Browser SPICE**: whether spice-html5 can be driven through a multiplexed relay in your target setup. If not, ship VNC and serial first and mark SPICE as "unavailable" in the connection-type control (grey it out with a tooltip), instead of showing it and failing.
3. **Proxmox tickets** and API tokens (section 4).
4. **Keyboard handling** in noVNC and spice-html5 for non-US layouts and for Ctrl+Alt+Del.
5. **Performance**: a 1920x1080 guest over a WAN link; the latency number shown in the status line must be measured (round-trip of a control ping), not made up.

## 12. UI states to implement

| State | Where | Behavior |
|---|---|---|
| Disabled by admin | Console / Shell button | Disabled, tooltip "Remote control is turned off for this server" (link for admins) |
| Not permitted | Button hidden or disabled | Tooltip "Requires operator access" |
| Connecting | Screen area + status line | Spinner, "Connecting · {protocol}" |
| Connected | Status line | Dot + "Connected · {protocol} · encrypted", resolution, measured latency |
| Connection lost | Status line | "Connection lost · Reconnect" button |
| Guest stopped | Screen area | Power icon, "{name} is powered off", Start button (needs `power`) |
| Protocol unavailable | Connection-type control | Option disabled with a reason |
| Session limit | Toast / inline | "Too many open consoles. Close one and try again." |
| Action pending | Toolbar | Buttons disabled, status chip "Shutting down…", then result |
