# @whombat/client

Everything the web app and the phone app share for talking to a Whombat and showing what it says: the encrypted
session to the box, a typed caller for every endpoint, the realtime events, the TanStack Query cache and its React
hooks, and the pure view models, words and fixture worlds of the screens. Only `@whombat/client/web` touches the DOM;
the rest runs in browsers and React Native alike.

## How the pieces fit

The person's devices reach the box only through the encrypted session (`ARCHITECTURE.md`, “The box and the encrypted
session”); nothing here builds a server URL.

```
SessionConnector ─► createSecureSession ─► ApplianceSession ─┬─► createClient ─► WhombatClient ─► createQueries
 (relay, direct,      (Noise XX pinned to    call · subscribe │                                       │
  or both)             the box's identity)   resources · …   └─► createSessionRealtime ─► Realtime ───┤
                                                                                                       ▼
                                                                         WhombatClientProvider (cache + hooks)
```

- **Connector.** `createManagedConnector` dials the relay with a ticket from control; `createDirectConnector` reaches
  the box on its local network or Tailscale; `createRoutedConnector` tries the direct ways first and starts the relay beside them when they
  haven't opened within a second.
  `secureChannelPort()` (`@whombat/client/secure-channel`) fills in the Noise XX handshake from
  `@whombat/secure-channel`.
- **Session.** `createSecureSession({ connector, client, … })` is the one `ApplianceSession`: requests (`call`),
  subscriptions, downloads and uploads, collaboration and consoles, with reconnects, a second attempt raced beside a
  slow one, stall detection and durable command tracking. An operation the contract marks destructive is never resent
  when its outcome is unknown: it fails with `OutcomeUnknownError` and a person checks.
- **Client.** `createClient({ session })` builds one caller per endpoint of `@whombat/core/contracts`: inputs are parsed
  with the endpoint's schemas before anything is sent; answers are decoded tolerantly (an item this app doesn't know is
  left out and counted by `leftOut`), security views strictly (`NeedsNewerAppError`). Reads resolve to their data;
  changes resolve to a `CommitResult`: `ok`, `pending_approval` (the keys engine asks a person) or `blocked` (a key is
  missing). `unwrap()` turns the last two into `ApprovalRequiredError` and `BlockedError`.
- **Realtime.** `createSessionRealtime(session)` gives the `Realtime` interface over one session subscription:
  ref-counted topics, typed listeners, and `onResync` when the box says a snapshot is needed.
- **Cache.** `createQueries(client)` and `queryKeys` give TanStack Query options and keys; `applyRealtimeEvent` writes
  each event into every cached answer it touches (idempotent and order-safe); a resync invalidates what the missed
  events could have changed.

```tsx
import { createClient } from '@whombat/client';
import { WhombatClientProvider, useBootstrap, useSendMessage } from '@whombat/client/react';
import { createSecureSession, createSessionRealtime } from '@whombat/client/session';

const session = createSecureSession({ connector, client: { build, platform: 'web' } });
const client = createClient({ session, validateResponses: import.meta.env.DEV });
const realtime = createSessionRealtime(session);

<WhombatClientProvider client={client} realtime={realtime} queryClient={queryClient}>
  <App />
</WhombatClientProvider>;

const { data } = useBootstrap({ params: { burrow } });     // one hook per read endpoint; null waits
const send = useSendMessage({ burrow, conversationId });   // optimistic, rolled back on failure
```

The web app wires this in `apps/web/src/app/services.ts` and `apps/web/src/managed/connect.ts`, the phone in
`apps/mobile/src/managed/`. Without a box both use a fake: `createFakeAppliance` and `createFakeSession`
(`@whombat/client/fake`) answer the same operations in memory.

## Imports

| Import | What it holds |
| --- | --- |
| `@whombat/client` | `createClient`, `unwrap` and the errors; the `Realtime` interface; the shared view models and words of the screens (Chat and threads, cards, approvals, the assistant's name, face and keys, Settings' groups, Vault, Files, Inbox, Usage, Overview, automations, council, delegation, …); the session's error types. |
| `@whombat/client/query` | `queryKeys`, `createQueries`, `applyRealtimeEvent`, `connectRealtimeToQueryClient`, optimistic updates and the cache helpers, on `@tanstack/query-core` only. |
| `@whombat/client/react` | `WhombatClientProvider`, `useWhombat`, a read hook for each endpoint the apps read (`queryHook` makes one for any other), mutations with optimistic updates (`useSendMessage`, `useDecideApproval`, `useMarkRead`, … and `useApiMutation` for any other), realtime hooks (`useSubscription`, `useRealtimeStatus`, `useRealtimeEvent`, `useTyping`) and the screens' own hooks. |
| `@whombat/client/web` | Browser helpers: `bindBrowserLifecycle` (reconnect when the tab comes back), `createObjectUrlCache` and `saveResource` for resources read through the session. |
| `@whombat/client/session` | `createSecureSession`, the connectors (`createManagedConnector`, `createDirectConnector`, `createRoutedConnector`), `createSessionRealtime`, `createCommandTracker`, cache scoping, resources and the session's types. |
| `@whombat/client/secure-channel` | `secureChannelPort()`: the connectors' Noise XX handshake and byte stream from `@whombat/secure-channel`. |
| `@whombat/client/fake` | A box in memory (`createFakeAppliance`) and sessions on it (`createFakeSession`) for fixture mode, demo worlds and tests. |
| `@whombat/client/managed` | What the apps share outside the Chat app itself: the control client, claim cards and fingerprints, pairing, passkeys, recovery and the recovery kit, backups and their places, the Whombat list and switcher, push, remote help, updates, and the words of those journeys. |
| `@whombat/client/managed/react` | Hooks for leaving a Whombat that can't be opened, opening one that already let this device in, and a Whombat's entry in the list. |
| `@whombat/client/signins` | Sign-ins to Claude, ChatGPT and GitHub and the AI programs: the sign-in console's loop, error codes, guided steps and words. |
| `@whombat/client/storage` | Expiring records in `localStorage`-like storage: a link's secret or a journey's progress, held for a while and then forgotten. |
| `@whombat/client/connections` | Connecting a service, shared by the web's form and the phone's: choices and rules, the steps' words, refusals, a connection's state in words, Found on your network. |
| `@whombat/client/desk` | The box's screen: the `desk.*` operations as a `DeskApi`, what Settings → Screens shows, the forms' checks and words. |
| `@whombat/client/desk/react` | The screen's settings in the query cache, its changes and the unlock request. |
| `@whombat/client/desk/fake` | A screen without a box, answering the `desk.*` operations in memory. |
| `@whombat/client/voice` | Voice typing: the `voice.*` operations and the recording's upload as a `VoiceApi`, the composer's controller, WAV encoding and words. |
| `@whombat/client/voice/react` | Voice typing's settings in the query cache and `useVoiceTyping`, a composer's microphone. |
| `@whombat/client/voice/fake` | A speech service in memory (`withFakeVoice`). |
| `@whombat/client/remote-help/fake` | Remote help's operations as the box and the support service answer them, in memory. |
| `@whombat/client/backup-places/fake` | Backup places on a fake box: the `backup.places` operations over one in-memory list. |
| `@whombat/client/host/fake` | The machine without a box: hardware reports and networks for three example machines. |
| `@whombat/client/hosts` | Servers: formats, levels, chart arithmetic, view models, configuration rules, console frames and refusal words. |
| `@whombat/client/hosts/react` | Servers in React: a hook per read, the live topic, and changes that refetch what they touch. |
| `@whombat/client/hosts/status` | `useHostsStatus` on its own, so the sidebar doesn't load every server hook. |
| `@whombat/client/hosts/fixtures` | The example servers (thetitan, pve-01, pve-02, blackbox, the-falcon) with guests and 24 hours of history, answering the hosts routes. |
| `@whombat/client/hosts/mobile` | A guest's screen and a server's backups on the phone. |
| `@whombat/client/skill-library` | The skill library's wire shapes, the Settings → Skills model and its words. |
| `@whombat/client/skill-library/react` | The skill library's reads and writes, and Hermes's skill hub (search, preview, install, updates). |
| `@whombat/client/skill-library/fixtures` | A skill library in memory (`createSkillLibraryWorld`) answering the library's and the hub's endpoints. |
| `@whombat/client/work-fixtures` | Plans, activity and the Work view for the fixture worlds, over the real contract. |
| `@whombat/client/pages` | Page sets: reading one file of a set out of its ZIP (`PageSetReader`) and the app's side of the viewer's frame (`PageSetHost`). |
| `@whombat/client/pages/pages-runtime.js` | The viewer's script that runs inside the sandboxed frame or WebView and asks the app for the set's files. |
| `@whombat/client/testing/contract-tripwire` | For the apps' test setups: a fake answer the app had to leave something out of fails the test, unless it calls `expectLeftOut()`. |

Everything is built from the contracts in `@whombat/core` and `@whombat/protocol`. When an endpoint or event is added
there, the caller and the read hooks pick it up; only the cache reducers in `query/apply.ts` need a new case.

## Tests

`pnpm --filter @whombat/client test`: the session against fake connectors (handshake, reconnects, stalls, uploads
and downloads, unknown outcomes), the caller's inputs and outcomes, every cache reducer (in order, duplicated
and reversed must converge), optimistic updates and rollbacks, the view models and words, and the React hooks in jsdom.
