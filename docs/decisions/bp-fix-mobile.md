# Workstream: fix/mobile (Android verification findings)

Fixes for the independent Android verification of the buzz-parity branch (`review/android`,
`~/.cache/wb-tmp/android/`). Attachments decisions are in `bp-attachments.md` (BP-A17–A20), the packs one in
`bp-packs.md` (BP-D23); this file records the rest. Scope: `apps/mobile` only; no contract changes.

| # | Decision | Why |
|---|---|---|
| BP-M01 | **The chat follows to the native end.** `ChatView` scrolls with the underlying ScrollView's `scrollToEnd` (`getNativeScrollRef()`), not FlatList's: FlatList computes the end from the last row's frame — an estimate for a row that has not been measured yet — and leaves out the content container's bottom padding, so a message just sent (keyboard up or not) stopped under the composer. | The newest message must be visible after a send. |
| BP-M02 | **Switches take their colors from the theme** (`switchColors`): on = `ok` track and a paper thumb (`brandColors.paper`; `btnfg` turned near-black and vanished on dark rows — Android smoke on 835cbc5), off = `line2` track and `mut` thumb, in both themes (Android's teal thumb is gone). `ListRow` gets a `control` slot: a control on the right of the whole row, centred on it and its own TalkBack stop, so a switch no longer pushes the title line down; its label is the automation's name (the switch role says on / off). | Tokens only; the row keeps its type layout. |
| BP-M03 | **Back buttons say “Back” when they name no place** (`backButtonLabel`): “Back to Inbox”, but “Back” for a “‹ Back” button (Memory, Packs), never “Back to Back”. | TalkBack reads the label. |
| BP-M04 | **A conversation one is not in says so, without Try again** (`conversationLoadError`): the server answers 403 / 404 for it (the same for one that does not exist, no probing), shown as “You’re not in this conversation.”; the connection and 5xx keep “This conversation didn’t load.” with Try again. | Trying again cannot help. |
| BP-M05 | **The Attach dialog has a body**: “Add a photo from your gallery, or any file from your phone.” (Photo / File / Cancel). The system dialog stays (Android shows three buttons; an app sheet would be a new component for one choice). | An empty dialog body looked broken. |

## Verified

Emulator `whombat-mobile` read-only on port 5612, debug APK from this branch, own server on :4596 with a
throwaway database. Screenshots: `~/.cache/wb-tmp/fix-mobile/shots/`.
