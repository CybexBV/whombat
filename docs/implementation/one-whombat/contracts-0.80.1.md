# Contracts 0.80.1 and 0.80.2 as released (one Whombat, the gaps and consoles)

Released 2026-10-17 from `whombat-contracts` main: **0.80.1** at `36a244f` (tag `contracts-v0.80.1`, CT-344…CT-350) and
**0.80.2** at `12e0404` (tag `contracts-v0.80.2`, CT-351); decisions in the contracts repo's `docs/decisions/contracts.md`.
Vendored as **0.80.2** (it contains 0.80.1) on Whombat `one-console` and whombat-app `one-console`. All additive.
**`SESSION_API_LEVEL` stays 39**, no new feature name: 0.80.0 never reached a runtime, and what a runtime may lack is
negotiated by the protocol (`stream.console`) or answered `unknown_op`. Stream CS's decisions:
`docs/decisions/one-whombat-consoles.md` (ONE-DC01…ONE-DC14).

## What changed

| # | Item | Shape |
|---|---|---|
| CT-344 | `@whombat/release` `RepositoryName` | gains `'whombat-hosts'` (the product manifest names the hosts service's repository) |
| CT-345 | Devices | `DeviceAction.unit?: string (≤ 16)`; `DeviceReading.choices?: DeviceChoice[] (≤ 32)` with `DeviceChoice {value: number \| string, label}` (now declared before `DeviceReading`) |
| CT-346 | REST error | `ErrorCode` gains **`unavailable`**, `ERROR_STATUS.unavailable = 503`; the app's code stays in `details.code` (`hosts_unavailable`). `SessionErrorCode` lists `unavailable` once (it was already a protocol code). `APP_ERROR_CODES` documents `hosts_unavailable` and `console_refused`. |
| CT-347 | Approval words | `ConnectionCallAction.params.words?: string` (trimmed, 1…`CONNECTION_CALL_WORDS_MAX` = 150), written by the server from the call's arguments (“restart web on pve-02”). `actionCopy`: title “Restart web on pve-02”, question “Restart web on pve-02?”, runs “Restart web on pve-02 once, then say how it went where it was asked”; `describeAction` uses the words for a shared connection (a personal one still says “use a personal connected service”). |
| CT-348 | Task chat links | `ChatLink {type: 'chat', id: ConversationId}` in `ConversationLink` (so `MessageLink.in`, `ApprovalLink.in`, `PlanLink.in`) and `LinkRef`; `linkPath` → `/:burrow/chats/:id`; `conversationLink(c)` answers it for a `dm` with `c.chat` and `c.id`; `auditLinkLabel` “Open the chat”. |
| CT-349 | Watch acknowledge | `watch.acknowledge` POST `/burrows/:burrow/watch/acknowledge` body `AcknowledgeWatchBody {ref: HomeRef, acknowledged: boolean = true}` → `AcknowledgeWatchResponse {ref, state: 'acknowledged' \| 'open'}`; session safety `never` (an alert's case calls the hosts service). |
| CT-349 | Chat unarchive | `chats.unarchive` POST `/burrows/:burrow/chats/:conversationId/unarchive` → `ChatResponse {conversation}`; session safety `receipt`. |
| CT-350 | Console stream | `StreamSpec` gains `{kind: 'console', burrow, sessionId (1…200), token (1…500)}`; `StreamMeta` gains `{kind: 'console', protocol (1…32)}`; capability **`stream.console`** (`CAPABILITIES.console`); `CONSOLE_MAX_MESSAGE_BYTES` = 2 MiB (`@whombat/protocol`); subpath **`@whombat/protocol/console`**: `encodeConsoleMessages(messages)`, `consoleDataPayloads(encoded, maxData?)`, `ConsoleMessageDecoder` (the collab framing `[u32 len][message]` with the console bound; `encodeCollabMessages` and `CollabMessageDecoder` take an optional bound now, collab's default unchanged). |
| CT-351 (0.80.2) | Host page | `HostServerDetail.workloads` is `z.partialRecord(enum docker \| incus \| libvirt, HostPlatformWorkload)` (Zod 4's `z.record` over an enum required every key, so a Docker host's page failed validation). No other record in hosts, Home, devices or tool limits is keyed by an enum. Allocated-disk totals (“overbooked”) were **not** added: the hosts service doesn't report guests' provisioned disk sizes. |

## The console stream

1. The client calls `hosts.createConsole` (a secret op) as before and gets `{sessionId, token, protocol, …}`.
2. It opens `open{stream, spec: {kind: 'console', burrow, sessionId, token}}` on the interactive connection (only when
   `welcome.capabilities` has `stream.console`).
3. The appliance checks the person (an owner of the burrow that sees servers) and redeems the ticket (same person, same
   session, once, 30 s), connects the hosts service's console over its unix socket (service token, `X-Whombat-Actor`,
   `rackoon.console.v1` + `rackoon.token.<t>`), and only then answers `opened{meta: {kind: 'console', protocol}}`.
   Refusals: `error{stream_refused}` with `details.code` `console_refused`, `hosts_unavailable` or `forbidden`.
4. DATA both ways: the hosts service's WebSocket messages unchanged (`kind | channel (u16 BE) | payload`; kind 1 JSON
   controls such as `status`, `resize`, `ping`/`pong`, `activity`, `closed`), each `[u32 len][message]`. Credit is the
   back-pressure; the client grants a 1 MiB window after `opened`.
5. The service ending the console: its `closed` control (with the reason) in DATA, then END; a broken service socket:
   RESET `internal`. The client leaves with RESET `cancelled` and answers an END with its own.

## For the lead at merge

- Whombat `one-console` and whombat-app `one-console` both vendor **0.80.2** and remove `vendor/whombat-contracts/0.80.0`
  (package.json, pnpm-workspace.yaml overrides, lockfile). No migration.
- whombat-app: `ApplianceSession` gained a required `openConsole` (HTTP returns null); test doubles that build a session
  by hand with `as unknown as ApplianceSession` are unaffected.
- Follow-ups: the app can switch Watch's acknowledge/snooze split (AP-1259, AP-1362) to `watch.acknowledge`, and show
  archived chats with an Unarchive button (`chats.unarchive`); Android can open consoles through `openConsole` (the
  socket is Hermes-safe); “overbooked” needs the hosts service to report provisioned disk sizes first; the appliance's
  product manifest can name `whombat-hosts` once its manifest code moves to 0.80.x.
