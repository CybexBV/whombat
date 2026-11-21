# Contracts 0.26.0 — what the essentials streams build on

Released 2026-09-30: whombat-contracts main `ba3b2b9`, tag `contracts-v0.26.0`, decisions CT-166…CT-184 in
`~/Code/whombat-contracts/docs/decisions/contracts.md` (CT-184 lists every name that differs from the assignment).
Vendored into Whombat main (`0dae72a8`) and whombat-app main (`97d06fc`). Source of truth: the code in
`~/Code/whombat-contracts/packages/{core,protocol}/src` — read it for exact types. Everything is optional/additive.

## Enums and unions
- `DispatchTrigger` + `approval_granted`, `retry`. `WorkAction` + `retry_turn`. `ConversationKind` + `direct`.
- `NotificationKind` + `direct`, `reply` (`PushPayload.kind` too). `MessageCard`/`StoredCard` + `TurnFailedCard`
  (`CARD_KINDS` + `turn_failed`). `ConversationLink`/`LinkRef` + `DirectLink {type:'direct', id}`. `PrLink.repo?`.

## Failed turns (4)
- `TurnFailureCode` = signin | usage_limit | provider | sandbox | timeout | runner | workspace | internal;
  `TurnFailure {code, reason ≤200}`; `TurnFailureReport {code, resetsAt?}` in `CompleteBody.failure?` (runner → server;
  `error` stays the technical text); `TURN_FAILURE_REASON_MAX` 200, `TURN_FAILURE_DETAIL_MAX` 2000;
  `turnFailureDetail(raw)` (redacts, last 2000 chars).
- `TurnFailedCard {kind:'turn_failed', dispatchId, agentId, code, reason, retriedAt|null, retryDispatchId|null}`;
  `canRetryTurn(card, agent, viewer)`. `DispatchSummary.failure?`. `WorkItem.failure?: WorkFailure {code, reason,
  detail|null (owners/admins only), retriedAt, retryDispatchId}`. `DispatchContext.retry?: RetryContext`.
- `dispatches.retry` POST `/burrows/:burrow/dispatches/:dispatchId/retry` → `{dispatchId}` (200), area `api.dispatches`.
- Text: `turnFailureText(code, {provider?, resetsAt?, now?, timeZone?})`, `TURN_FAILURE_LABELS`, `TURN_RETRY_LABEL`
  ('Try again'), `TURN_RETRIED_LABEL` ('Tried again'), `turnRetriedText(at, tz)`.

## Approvals (1–3)
- `DispatchContext.grantedApproval?: Approval|null` for `approval_granted`. Sliding token: no shape change (CT-169).

## Branch rooms (5)
- `RepoFullName` (domain, ≤200). `BranchRoomSummary.repo?`. `linkPath` → `/:b/pr/:n?repo=owner/name[&tab=files]`.
  `conversationLink(c & {id?, repo?}, dmAgentHandle?)`.

## Direct conversations (9)
- `DIRECT_MEMBERS_MIN` 2, `DIRECT_MEMBERS_MAX` 9, `DIRECT_OTHERS_MAX` 8, `DIRECT_TITLE` 'Direct';
  `directMemberKey(ids)`; `ConversationSummary.memberIds?`; `Sidebar.direct?`; `linkPath` → `/:b/direct/:id`;
  `conversationLabel(c, directName?)`; `composerPlaceholder({kind:'direct', title})`; `directTitle(members, viewerId)`;
  `DIRECT_AGENTS_HINT`, `NEW_DIRECT_MESSAGE`.
- `conversations.openDirect` POST `/burrows/:burrow/direct` `{principalIds: 1–8 distinct}` → `ConversationDetail`.

## Channels (11)
- `ChannelVisibility` public|private; `Conversation.visibility?` (nullable), `.archivedAt?`, `.createdById?`;
  `ConversationSummary.visibility?`, `.archivedAt?`; `channelVisibility(c)` (absent = private), `isArchived(c)`,
  `canArchiveChannel(c, viewer)`, `ARCHIVED_CHANNEL_TEXT`. `createChannel.visibility` (default public),
  `update.visibility?`.
- `conversations.browse` GET `/burrows/:burrow/channel-directory` `{q?≤80, archived?, limit=200≤500}` →
  `{channels: BrowseChannel[]}` `{id, slug, title, topic, visibility, joined, memberCount, archivedAt, createdById,
  lastMessageAt}`; `conversations.join` POST `…/conversations/:id/join` → detail; `conversations.archive` POST
  `…/conversations/:id/archive` `{archived}` → detail.

## Messages (8, 14)
- `Message.deletedAt?`, `.pinnedAt?`, `.pinnedById?`, `.previews?: LinkPreview[] ≤3`, `.broadcast?`.
  `LinkPreview {url, title 1–200, description ≤300|null, siteName ≤100|null}`, `normalizeLinkPreview(raw)`.
  `MESSAGE_DELETED_TEXT`, `MESSAGE_EDITED_LABEL`, `PINS_MAX` 50; `isDeletedMessage`, `canEditMessage`,
  `canDeleteMessage`, `canPinMessage` `(m, viewer {id, kind, role?})`, `addedMentions(before, after)`.
- `messages.edit` PATCH `/burrows/:burrow/messages/:messageId` `{text}` → `{message}`; `messages.delete` DELETE same →
  `{messageId, message|null}` (message only when tombstoned); `messages.pin` PUT `…/messages/:id/pin` `{pinned}` →
  `{message}`; `conversations.pins` GET `…/conversations/:id/pins` → `{messages}` newest pin first.
- `Burrow.linkPreviews?`, `linkPreviewsOn(burrow)`, `burrows.update.linkPreviews?`.

## Notifications (12)
- `NotifyLevel` all|mentions|none; `defaultNotifyLevel(kind)`; `notifyLevelOf(c)`; `NOTIFY_LEVEL_LABELS`;
  `ConversationSummary.notify?`, `ConversationDetail.notify?`; `conversations.setNotify` PUT `…/conversations/:id/notify`
  `{notify|null}` → `{conversationId, notify}`.
- `Preferences.notifications?: NotificationPreferences {dndUntil, schedule: QuietHours {enabled, start, end 'HH:MM',
  days}, email off|hourly|daily (default hourly), threadReplies (default true)}`; `DEFAULT_NOTIFICATION_PREFERENCES`,
  `notificationPreferencesOf`, `isDndActive`, `inQuietHours`, `isQuietNow`, `zonedInstant`, `DndPreset`,
  `DND_PRESET_LABELS`, `dndUntilFor(preset, now, tz)`, `EMAIL_UNREAD_AFTER_MS`, `EMAIL_HOURLY_MS`, `EMAIL_DAILY_AT`,
  `notifyReason({...})` → mention|broadcast|reply|direct|all|null; `INBOX_SECTIONS` + DIRECT, REPLIES;
  `parseBroadcast(text)`; `BROADCAST_HINTS`; markdown renders `@channel`/`@here` as mentions;
  `Bootstrap.capabilities?: {emailNotifications, webPush}`.

## People and agents (10)
- `Person.removedAt?`, `Agent.retiredAt?`; `isActivePrincipal`, `principalStatusLabel`, `FORMER_MEMBER_LABEL`,
  `RETIRED_LABEL`, `retiredAgentText(name)`; `canRemoveMember(viewer, target, ownerCount)`,
  `canSetMemberRole(viewer, target, role, ownerCount)`, `canRetireAgent(viewer, agent)`.
- `members.remove` DELETE `/burrows/:burrow/members/:principalId` → `{person}`; `members.setRole` PUT
  `…/members/:principalId/role` `{role}` → `{person}`; `agents.retire` POST `/burrows/:burrow/agents/:agent/retire` →
  `{agent}`.

## Smaller (14, 6)
- `text/emoji.ts`: `EMOJI` (387 `{char, name, keywords, group}`), `EMOJI_GROUPS`, `EMOJI_GROUP_LABELS`, `emojiByChar`,
  `searchEmoji(q, limit=48)`, `QUICK_REACTIONS`, `RECENT_EMOJI_MAX` 16, `pushRecentEmoji`.
- `Bootstrap.presence?: PresenceEntry[] {principalId, state}`, `PresenceState`, `PRESENCE_IDLE_AFTER_MS` (10 min).
- `search.query`: `SearchQuery {q, type, limit ≤100, from?: Handle, in?: ConversationId, after?/before?: IsoDate,
  cursor?}`; `SearchResponse.next?`.
- `GitHubStatusResponse.via?: 'gh'|'signin'`, `.signInNeeded?`.

## Realtime, audit, protocol
- Event `conversation.notify {conversationId, notify}` on `me`; `conversation.updated` topics `['burrow','me']`.
- `EVENT_TYPES` + `message.deleted`, `message.pinned`, `message.unpinned`, `member.role_changed`, `agent.retired`,
  `channel.joined`, `channel.archived`, `channel.unarchived`, `direct.opened`, `dispatch.retried`.
- `SESSION_API_LEVEL` 24 (window 22–25). Runtime features: `messages.edit`, `messages.pins`, `messages.previews`,
  `conversations.direct`, `channels.browse`, `members.manage`, `agents.retire`, `notifications.levels`,
  `dispatches.retry`, `search.filters`, `prs.repo`, `presence`, `github.signin`. The runtime lists them in
  `apps/server/src/managed/runtime-features.ts` `NOT_IMPLEMENTED` until a stream implements one and moves it to
  `IMPLEMENTED_FEATURES`. The app's `FEATURE_NAMES` has copy for each.
