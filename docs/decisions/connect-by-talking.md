# Connecting an MCP server or API by talking (CBT)

John, 2026-11-05 (main checkout): “just like we can chat to Dusty to create an automation, it should be able to create
a new connection also.” `connection_add` only opened the connect form for catalog services, and nothing told the
assistant that any MCP server or HTTP API can be connected as a Custom entry (`custom_mcp`, `custom_api`). Built on
`connect-in-chat.md` (the connect card, the write-only Vault card) and the Custom entries (`connections-catalog.md`
CX-61, CX-62).

Code: `packages/core/src/domain/connect-ask.ts` (`connectHereAsk`, `connectHereCard`, `connectSignInCard`, the card's
words), `packages/core/src/contracts/mcp-setup.ts` (`connection_add`'s input and description),
`packages/core/src/domain/guides.ts` (`GuideConnectAsk`, `GuideAnswer.connectionId`), `apps/server/src/connections/ask.ts`
(`connectByTalking`, `answerConnectHere`), `apps/server/src/guides/` (the act route, `answerConnectCard`, `guide_act`),
`packages/agent-runtime/src/persona/prompt.ts` (`connectCardLine`); tests `connect-ask.test.ts`,
`connections/connect-in-chat.int.test.ts` (Postgres: the pipeline, the connect side's real check against the fake
services, the dispatch queue).

| # | Decision | Why |
|---|---|---|
| CBT-01 | **The assistant sets up anything outside the catalog itself**, as `custom_mcp` (a remote MCP server's Streamable HTTP address) or `custom_api` (an HTTP API's base address, how it signs in and notes on its endpoints), from the service's documentation, with a name. It asks the person only what only they know. One tool, `connection_add`, with optional `name`, `signIn`, `keyName`, `keyPrefix`, `username` and `notes`; its description and its “unknown service” answer name the two entries. | Like automations by talking (`automation-chat.md` AT-01): the assistant does the setting up, the person agrees. One tool keeps every turn's tool list short. |
| CBT-02 | **The card connects on the card** (topic `add_connection`, node `here`): what it connects and where (“An API at api.example.com/v1.”), how it signs in, the level in the entry's words, then a write-only field (a token, a key, or a username and password) and Connect, and Not now. An MCP server without a sign-in gets Connect alone. The card is Whombat's words; the assistant's notes go to the connection's guide, not the card. | The person sees exactly what is connected and types only the key, never in chat (CIC-01's rule). The card's destination is server-written (`GuideConnectAsk`) and read back from the stored card, as a Vault card's is (CIC-11). |
| CBT-03 | **Whombat asks an MCP server itself how it signs in** before posting (the probe, CX-61): open → no field; a 401 without OAuth metadata → a token field (Bearer, or the header the assistant named); OAuth → the connect form's link (“Sign in to Linear”), since that sign-in needs the browser; no answer → the tool fails with `unreachable` and posts nothing. | The server knows better than the assistant's guess; the person is never shown a card that can't work. |
| CBT-04 | **Checked before asking**: the address may be reached (the connections' destination rule, `not_allowed` in its words), the Whombat has room (`full`), the same entry isn't already connected at that address (`already_connected` with its id), and the sign-in shape fits the entry (`invalid_sign_in`: a header's or parameter's name, a header Whombat can't send). Nothing is posted on a refusal. | As `vault_ask` checks before asking (CIC-12). |
| CBT-05 | **Connect is the connect form's own path** (`createConnection`) run as the person who answered: the entry's check with the key, the connection saved only when it passes, its tools read. A refusal (the key turned down, the check failed) comes back on the card's field in the connections' words and the card stays open. A second send of the same card while one connects is refused (`guide_closed`). | One way to connect, whoever starts it; a double tap makes one connection. |
| CBT-06 | **Connected wakes the assistant in the card's thread**, with the connection's id in the answer (`GuideAnswer.connectionId`, `[guide: …; connection con_…]` in its history) and a preface line that it is connected and how to use it (`connectCardLine`), so it carries on with what the person wanted. Not now wakes nobody. | “Connect Linear and show my issues” finishes in one go; a card nobody wanted lingers in nothing (AT-09). |
| CBT-07 | **The key is never in a message, event, realtime frame, log line or the woken turn** (tested), only sealed in the connection. | The connect-in-chat security bar (CIC-15). |
| CBT-08 | **Look only to start** for both Custom entries (the risk rule, CIC-04), unless the assistant chooses Manage because the person wants it to change things there. | A hand-connected service's tools are unknown until read. |
| CBT-09 | **No contracts release and no app release**: `GuideConnectAsk`, `GuideAnswer.connectionId` and the tool's new input are additive and read only by this repository's runtime; the web and phone draw the card from its blocks (the generic secure form and buttons) and drop the fields they don't know. | Older apps show and answer the card as it is. |

## Not now

- A Custom entry's OAuth sign-in on the card itself (it needs the browser's redirect; the card opens the form).
- Catalog services' token sign-in on the card: their form already explains where the token comes from.
- Replacing a waiting connect card when the assistant posts a newer one for the same address.
- A Hermes skill on writing an API's notes; the tool's descriptions carry it.

## Rows for DECISIONS.md

| # | Decision |
|---|---|
| CBT-01…CBT-09 | **Any MCP server or API is connected by talking**: the assistant sets it up as a Custom entry from its documentation, Whombat checks it and asks an MCP server how it signs in, and the card takes the key in a write-only field, connects as the person and wakes the assistant with the new connection. (`connect-by-talking.md`) |
