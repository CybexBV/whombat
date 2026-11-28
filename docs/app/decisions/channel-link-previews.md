# Link previews on or off per channel (AP-1101…)

John, 2026-10-10, on automation posts in a channel whose GitHub preview card repeats the issue line right above it:
“I would like the option to switch off the previews of the URLs in a message … So turn off the preview cards”, then
“Make it configurable per channel”. Contracts 0.74.0 (CT-330: `Conversation.linkPreviews`, `conversations.update`'s
`linkPreviews`, `conversationLinkPreviewsOn`, `CHANNEL_LINK_PREVIEWS_COPY`, feature `conversations.link_previews`);
Whombat `docs/decisions/essentials-conversations.md` EC-23 for the server, which stops fetching for that channel. This
is the app side. Without the feature every screen stays as it was. No HTML mock exists: the switch follows the private
switch in the same settings.

| ID | Decision | Why |
|---|---|---|
| AP-1101 | **Superseded by essentials-conversations.md EC-32.** **Web: “Link previews” in CHANNEL SETTINGS** (the channel's menu → Channel settings), a `ToggleRow` under the private switch with “Show a card with the page’s title under links posted here.”, plus “Link previews are off for the whole burrow.” when an owner switched them off for everyone (EC-21). Any member sees it, on a Whombat with `conversations.link_previews` whose channel says `linkPreviews`. Saved with Save like the rest; only a changed value is sent. The toast is “Link previews are off in this channel.” / “… on …” when that was the only change, else “Saved #name.”. **Off hides the cards already there**: the room and the thread pane provide `LinkPreviewsShown` from `conversationLinkPreviewsOn(conversation)`, and `LinkPreviews` draws nothing when it is false; back on, they show again. | A setting for the channel, where its name and topic are changed; hiding instead of deleting keeps it reversible. |
| AP-1102 | **Superseded by essentials-conversations.md EC-32.** **Android: the same row** in the channel's settings screen (`KeySwitchRow`, the same words), `channelChanges` sends `linkPreviews` only where the runtime and the channel say and only when changed, `channelSavedText` says the web's toasts. `chatItems`' `previews: false` (from `conversationLinkPreviewsOn(roomConversation)` in `ChatView`, threads included) leaves the cards out. | Same behaviour on the phone. |
