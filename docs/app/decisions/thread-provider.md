# A Chat thread keeps its provider (AP-5600…AP-5609)

Whombat `docs/decisions/hermes-native.md` HN-06 (John, 2026-10-25): a thread keeps the provider (Claude or ChatGPT) it
started with. Hermes stores the provider with each session, and switching a thread mid-way resumed a Claude session on a
ChatGPT sign-in. The runtime refuses a provider change on a thread that has a turn (HN-L01); the clients stop offering one.
Changes `chat-runtime.md` AP-2681's “another provider resets…” and the switch of AP-2691 inside a thread; the top-level
box (a new chat) keeps them as they are.

| ID | Decision | Why |
|---|---|---|
| AP-5600 | **In a Chat thread the popover (web) and the sheet (phone) show the thread's provider alone**: “<Name> answers with” over a single segment, picked (`chatProviderSegments(view, runtime, inThread)`), so there is nothing to switch to; its models, Effort and Fast replies as before. The top-level box shows the switch as before: the provider is chosen with a new chat's first message. Same words, layout and tokens as AP-2691 and AP-2716; the single segment fills the track. | HN-06; what answers stays visible without a choice that the Whombat would refuse. |
| AP-5601 | **The lines under it are that provider's alone** (`chatProviderHints(view, only)`): its usage line (“This 5 hours: ChatGPT 12% used”), and “… isn’t set up on this Whombat. Set it up” only when the thread's own provider can't run any more (CR-04: such a thread is refused, never moved). | The other provider's usage or set-up says nothing about this thread. |
| AP-5602 | **A refusal from the Whombat shows its words** as any refused choice (AP-2682, `chatRuntimeRefusalText`): a client that still offers another provider gets “This chat stays with Claude. To use ChatGPT, start a new chat.” and the choice is put back. Nothing new in the clients for it. | Older clients and other devices stay honest without an update. |
| AP-5603 | **The fixture worlds keep answering `chats.setThreadRuntime` as before** (web `chatChannelFixtures.ts`, phone `fixtures/chatRuntime.ts`): no click reaches another provider in a thread now, and the fixture threads that switched (Zonneplan's “Switched to ChatGPT”) stay as the divider's example: a thread that follows the assistant still changes provider when the assistant's own changes (HN-L03). | The fixtures show what the screens can reach. |
| AP-5604 | **No contract change, no version bump here** (contracts 2.0.0): `chatProviderSegments` and `chatProviderHints` take an optional argument. The lead releases. | One release with the other streams' changes. |

AP-5600…AP-5604 used; AP-5605…AP-5609 kept for this work's follow-ups.

## Checks (2026-10-25)

`pnpm check`. The web in the fixture world at 1440×900 in light and dark: Zonneplan's thread on ChatGPT (ChatGPT alone,
its usage line, its models, Effort, Fast replies on), pve-02's thread on Claude (Claude alone, fast replies on), and the
Chat's top-level box (Claude · ChatGPT as before). Not seen: the phone's sheet on a device or the Android emulator (the
same `@whombat/client` functions, two lines in `ChatRuntimeSheet.tsx`).
