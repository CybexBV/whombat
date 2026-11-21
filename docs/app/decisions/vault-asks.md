# The sign-in card for every kind, and the Vault for one person (AP-6650…)

John, 2026-11-03: Dusty asks for any sign-in (a website login, a server's password, a private key, a one-time code)
with a card that saves it in the Vault and never reaches the chat; the Vault drops what was there for several people and
its MCP entries move to Connections. Spec: Whombat `docs/decisions/vault-simplify.md` (VLT-30, VLT-40…VLT-49) and the
contracts CT-1660…CT-1669 (3.14.0); the card it extends is `connect-in-chat.md` CIC-10…CIC-15. These are the app's
(stream W) decisions for the web and the phone.

## Shared (`@whombat/client`)

| ID | Decision | Why |
|---|---|---|
| AP-6650 | **`packages/client/src/vaultAsk.ts` holds the card's form rules** for both apps. `vaultAskOf(card)` is the card's `vaultAsk` on a `secret` card. `vaultAskShownFields(ask, block, way)`: a `server` card shows only the chosen way's fields (`VAULT_ASK_WAY_FIELDS`), the way's own field (the password, or the private key) needed though core marks every server field optional; every other card shows its fields as they come. `vaultAskProblems` stops the form before sending: a needed field left empty in core's `VAULT_ASK_TEXT.empty` words, and a login's authenticator key that `vaultTotpProblem` refuses. `vaultAskValues`: only the shown fields that were filled, a username, a code and an authenticator key trimmed, a password, passphrase or sign-in key as typed, a private key exactly as it is, and on a `server` card the chosen way as the value `way`. | The server reads only the way's fields (CT-1661); one rule set keeps the two apps sending the same thing, and it is unit-tested once. |
| AP-6651 | **Nothing secret stays in the form once it was sent, whatever the answer** (`vaultAskKept`): only a typed username survives; a wrong password or a refused key is typed or picked again. Other guide forms keep what was typed on a refusal, as before. | VLT-47's bar: the value lives in the app only until it leaves. Typing a password again after a wrong one is what every sign-in page does. |
| AP-6652 | **A `server` card opens on `key_once`** (`VAULT_ASK_FIRST_WAY`), its three ways listed in core's order with core's words and the assistant's name (`vaultAskWays`). | VLT-42: putting the key on is the safer way, so it is the default. |
| AP-6653 | **Words core doesn't hold are the client's, shared**: the private key's controls (`VAULT_ASK_KEY_IN`: Paste, Pick the file, Remove, “Private key pasted”, too big, unreadable, nothing to paste), the entry page's AUTHENTICATOR KEY block (`VAULT_TOTP_TEXT`), the kept password's line (`vaultKeptPasswordLine`: “Signs in with a kept password · 2 days ago”) and the move note (`VAULT_MCP_MOVE_TEXT`). The card's own words (titles, under lines, buttons, errors, locked lines) come only from core. | Both apps say the same thing; core keeps what the server says too. |
| AP-6654 | **Core's `vault/ask.ts` is exported from `@whombat/core/vault`** (it wasn't from any index). | The apps read the card's words and `VAULT_ASK_WAY_FIELDS` from core, never a copy. |

## The card (web and phone)

| ID | Decision | Why |
|---|---|---|
| AP-6655 | **The ways are radio tiles in the guide's option-tile look**: on the web real radios in a `fieldset` (legend “How to sign in” for screen readers) inside the tiles, the selected tile with the green outline and check, the focus ring on the tile; on the phone `Touchable`s with `accessibilityRole="radio"` and `checked`, at least 56 dp tall. Changing the way clears the field errors. | They look like the choices a guide card already has; a choice of one is a radio, so keyboards and screen readers say what it is. |
| AP-6656 | **Every secret field is write-only.** Web: `type="password"`, `autocomplete="new-password"` (“off” is ignored by browsers' password managers), `data-1p-ignore`, `data-lpignore`, `data-bwignore`, `data-form-type="other"`. Phone: `secureTextEntry`, `textContentType="none"`, `autoComplete="off"`, `importantForAutofill="no"`, no autocorrect or spell check, no copy menu on a password. A code field is the exception: `autocomplete`/`textContentType` `one-time-code`, so the phone offers the code from the text message that brought it. Nothing is logged. | No secret goes into another app's storage; a code from a text message is offered by the system and goes nowhere else. |
| AP-6657 | **A private key is never drawn.** Web: one dashed box that takes a paste (Ctrl/⌘+V), a dropped file or dropped text, and a Pick the file button; the box holds no text, and once a key is in only “Private key pasted” or the file's name shows, with Remove. Phone: Paste (the clipboard, through `expo-clipboard`) and Pick the file (the system's document picker, any file type since keys rarely have an extension, read as text and the picker's cached copy deleted at once, as Google's client file is). Either way a file over `GUIDE_VALUE_MAX` isn't read. | Core: a `key_file` value is “never shown again once in”; typing a key by hand isn't a thing. |
| AP-6658 | **The server's refusal shows on its field** (`invalid_values`, keyed by field id, core's `vaultAskErrorText` words chosen by the server) and the card stays open while tries are left; a refusal about a field the chosen way doesn't show is a line above the button. After the last try the server locks the card with its locked line. | CT-1662: a try that fails is a field error while tries are left. |
| AP-6659 | **The card works in any thread of the person's**: the web's `MessageCard` and the phone's `ChatView` already render and act on guide cards in every room and thread (Chat, a server's thread, an automation's thread); nothing in the app limits a `secret` card to Chat. | VLT-41: asked in the thread the work is in. |

## The Vault's pages

| ID | Decision | Why |
|---|---|---|
| AP-6660 | **A website login's AUTHENTICATOR KEY block on the web's entry page**, under PASSWORD: “Set · added 2 days ago” or “Not set. Add it and Dusty types the two-step codes itself.”, Add / Replace (a write-only field, a setup key or `otpauth://` link pasted, checked with `vaultTotpProblem` before sending) and Remove (no confirm: adding it again is one paste), all through `vault.setTotp`. | VLT-46, CT-1663: shown as set, never the value, like the password. |
| AP-6661 | **The phone's entry screen has the same block** (`VaultEntryScreenModel.totp`), Add/Replace in a sheet like Replace secret, Remove beside it. | The phone does what the web does for a login. |
| AP-6662 | **A server's kept password is a line under its check** on both apps' server rows (`vaultKeptPasswordLine`), in the check line's type, and in the row's accessibility label on the phone. | CT-1664: “shown as set”, where servers are listed. |
| AP-6663 | **The web's “To add a server” hint says the password is asked on a card**, no longer “in your chat with the server's address and password”. | VLT-43: a password in a message passes the chat and the model. |

## Connections (VLT-30)

| ID | Decision | Why |
|---|---|---|
| AP-6670 | **Add to Vault offers core's `VAULT_NEW_TEMPLATES` only, in the app's order**: the web's Advanced kinds are `login`, `token`, `basic`, `ssh` filtered by core's list (and anything core adds after them); the phone's are core's without `ssh`, and its form starts with core's first (`FIRST_PHONE_TEMPLATE`, Sign-in key), no longer an `mcp` form. Neither app has a Connection form any more. | One place decides what a new entry can be. |
| AP-6671 | **An `mcp` entry that couldn't move shows “Move it to Connections”** at the top of its page (`VaultEntry.moveToConnections`), the warn note on the web, a section on the phone, with Open Custom MCP server: Connections' Custom MCP server connect page with the entry's address filled in (`?tab=connections&connection=custom_mcp&url=…`; the phone through `connectionsScreenUrl`). The entry keeps working until the person removes it. | VLT-30; the person moves it by connecting it there, then removes it here. |

## The desk (VLT-41)

| ID | Decision | Why |
|---|---|---|
| AP-6675 | **The desk screen never shows a sign-in form, and the app has nothing to draw there yet.** A `secret` card is posted without `asks` (`guides.ask`), so it is no Needs you question and never an ask on a screen; in the screen's Talk it is a message with only a card, which the server shows as “There’s something to see in Chat.”. Saying “Dusty needs the password for github.com · Answer on your phone or computer” (`VAULT_ASK_TEXT.desk`) there is the server's: `sessionMessages` in `apps/server/src/desk/talk.ts` would give a `secret` guide card the paragraphs `[card.title, VAULT_ASK_TEXT.desk]`. Left to the server's stream. | Nothing a screen draws comes from the app; the screen already takes no secret. |

## Fixtures

| ID | Decision | Why |
|---|---|---|
| AP-6680 | **The sign-in world**: the web's `VITE_FIXTURE_CONNECT=1` and the phone's `EXPO_PUBLIC_WHOMBAT_SIGNIN=1` add two threads to Chat — “Put the new website on prod-1” with prod-1's open `server` card (key refused), and “Open the pull request for the new site on GitHub” with github.com's saved login card and its open `code` card — all made by core's `vaultAskCard`; the web's UniFi card is core's too (with the optional authenticator key). Their Vault holds `@whombat/fixtures`' `vaultSignInEntries`: the shop's login with its authenticator key set, and the Deploy key with prod-1, a production server whose password is kept. The phone's demo world answers `vault.setTotp` on the shop login (only whether one is set). Home Assistant has `moveToConnections` in the shared fixtures. | The new cards and pages can be seen and screenshotted without a Whombat. |
