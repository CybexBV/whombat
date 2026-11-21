# Workstream: connectors — Google tools

What a personal agent does with its owner's connected Google account: the Workspace adapters, the 18
connector tools, their approvals and executors (`connectors.md` "Tools", CN-05, CN-08, PA-09). Built on
`connectors-foundation` on 2026-09-24. The spec's decisions are not repeated.

## Who may use them

- **GT-01 One gate** (`connectors/access.ts` `personalAccess`): the agent must be a personal agent
  (`connectionForAgent`), Google must not be `off`, and the owner's connection must be `active` and include the
  tool's service. Refusals are `not_allowed` with `details: { connector, reason }` and say the fix:
  “Only a person’s own assistant can use their mail, calendar and files.”, “Google isn’t turned on for this
  Whombat.”, `connectorMissingText` (“Mara hasn’t connected Google Drive. …”), and for `needs_reauth` “Mara’s
  Google account needs to be connected again. They can reconnect it in Settings → Connections.” MCP tool errors
  now carry the `ApiError`'s `details` in `structuredContent.error`.
- **GT-02 Only the owner's work reaches the account.** Besides PA-05 (only the owner wakes it), a connector
  call is refused when the dispatch answers a search (“Mara’s mail, calendar and files aren’t for answering
  searches.”) or is on behalf of anyone but the owner (“Tulip only works for Mara.”).
- **GT-13 `tools/list` per agent** (`mcpToolList(services, agentId)`): Whombat's tools plus the connector tools
  of the services GT-01 allows now. The list is computed per `tools/list` request, so connecting or
  disconnecting shows up on the next dispatch. The Claude permission policy allows every `MCP_TOOL_NAMES`
  entry and Codex approves every tool of the Whombat server, so both already allow the connector tools
  (a test pins it for Claude); the server's list and GT-01 are the gate.

## Tokens and errors

- **GT-03 401 → one forced refresh.** `withAccessToken` asks `services.google.tokens.accessFor` for a token and,
  when Google answers 401, once more with `{ forceRefresh: true }` (a new optional argument of
  `ConnectionTokens.accessFor`: the store refreshes even if the token has not expired). A second 401 is
  `needs_reauth` wording. Error mapping (`connectorError`): `api_disabled` → “The Gmail API is turned off in
  this Whombat’s Google project. An admin can turn it on: <activation link>” (Google's link from the 403
  `SERVICE_DISABLED` / `accessNotConfigured`, only if it is on `console.developers.google.com` /
  `console.cloud.google.com`; else `googleEnableApisUrl()`), `no_scope` → “Mara didn’t allow Gmail when
  connecting. …”, 404 → `not_found` “Google Drive has nothing with that id.”, 429 / rate-limit reasons →
  `rate_limited`, anything else → `conflict` “Gmail answered: <Google's message>”. Texts that reach the audit
  log (executor failures) never quote Google's message (`forLog`).

## The real adapter (`workspace-real.ts`, `mime.ts`)

- **GT-04** Plain `fetch`; every URL passes `isGoogleUrl` before the request (`googleUrl`), `redirect: 'error'`
  (a bearer token never follows a redirect), 20 s timeout per call, at most 5 parallel metadata fetches.
  - Mail: search = `messages.list` (`q`, `maxResults` = limit ≤ 25) + `messages.get?format=metadata` per hit;
    label ids shown by name (`labels.list`); snippets entity-decoded. Read = `messages.get` / `threads.get`
    `format=full`: text/plain preferred, HTML converted (`htmlToText`: no scripts/styles, blocks as lines,
    “- ” list items, “text (url)” links), charset from the part, attachments by file name and size, 50 000
    characters per message. Drafts are RFC 2822: `To`/`Cc`/`Bcc` (Gmail strips Bcc when sending), `Subject`
    (RFC 2047 when not ASCII), no `From` (Gmail sets the account), CR/LF stripped from header values, UTF-8
    body in base64, the whole message base64url in `raw`. A reply reads the original's `Message-ID`,
    `References` and `Subject`: `In-Reply-To`, `References` = theirs + the id, “Re: …” when no subject is
    given, and the draft's `threadId`. Organize resolves label names (case-insensitive) and creates labels it
    must add; `read`/`archive` map to `UNREAD`/`INBOX`; one `batchModify`.
  - Calendar: `singleEvents=true&orderBy=startTime`, `timeMin` defaults to now. Guests are attendees other
    than the calendar's owner (`self`) and rooms (`resource`). `sendUpdates=all` only when invites may go out
    (after approval), otherwise `none`; `addMeet` asks for a Meet link (`conferenceDataVersion=1`). Changing
    the guest list keeps the owner's entry and the answers of guests who stay.
  - Drive: plain words → `(name contains 'w' or fullText contains 'w') and … and trashed = false` (≤ 10
    words, quotes escaped). `files_read`: Docs exported as `text/markdown` (fallback `text/plain` on a 400),
    Sheets as `text/csv` (Drive exports the first sheet), text files with `alt=media` and a `Range` of
    4 × 200 000 bytes, other kinds metadata only; 200 000 characters. Create is a multipart upload converting
    Markdown to a Doc and CSV to a Sheet. Share = `permissions.create` with the notification email; trash =
    `trashed: true`. Shared drives are included (`supportsAllDrives`).
  - Docs: `append` = `insertText` at `endOfSegmentLocation`, `replace` = `replaceAllText` (case-sensitive);
    `applied` counts edits that changed the document. Sheets: read `UNFORMATTED_VALUE` (dates formatted),
    at most 20 000 cells; write `USER_ENTERED`.
  - Contacts: `people:searchContacts`; when the first answer is empty, one warm-up request (empty query, as
    Google asks) and a retry.
  - `checkService` is CN-06: `no_scope` without the scope (no call), else one call; `api_disabled` keeps the
    activation link and says “API turned off in your Google project”.

## The fake adapter (`workspace-fake.ts`)

- **GT-05** In-memory state per access token (one account per connection in fake mode), seeded on first use
  around the current time: six messages (an invoice with a PDF, a lunch question, an HTML receipt under
  “Receipts”, Q3 comments, a newsletter, one sent reply), four events (standup with two guests tomorrow,
  dentist without guests, Q3 planning with one guest, an all-day offsite), four files (the “Q3 plan” doc,
  the “Budget 2026” sheet, a text file, a PDF) and four contacts. It understands Gmail-ish queries
  (`from:`, `to:`, `subject:`, `is:`, `in:`, `label:`, `newer_than:`), A1 ranges and doc edits, and records
  what the calendar would email (`calendarMail`). Tests use `stateFor(token)` and `disable(token, service)`
  (answers like a turned-off API). `WHOMBAT_GOOGLE=off` gets a workspace whose every call fails.

## The tools as commands (`connectors/commands.ts`, `connectors/tools.ts`)

- **GT-06 Reads** check the key with the command `connector.read` (no event; a read at `ask` is refused with
  “Mara set “Read mail” to ask first, and reading can’t wait for a yes. Ask Mara to change it in your keys.”,
  because an approval could not hand the data back), then call Google after the commit, outside the burrow
  lock.
- **GT-07 Allowed writes** call Google inside their command and sign one content-free event, kind `Messages`,
  `where` = the provider's service name (“Gmail”, “Google Calendar”, “Google Drive”, “Google Docs”, “Google
  Sheets”), payload `{ tool, service }` only: `mail.drafted` “Drafted an email”, `mail.organized` “Organized
  3 emails”, `calendar.event_created` “Created an event”, `calendar.event_changed` “Changed an event”,
  `calendar.event_deleted` “Deleted an event”, `files.created` “Created a doc / a spreadsheet / a file”,
  `docs.edited` “Edited a doc”, `sheets.edited` “Edited a spreadsheet” (added to `EVENT_TYPES`). When the
  owner set such a key to ask, the pipeline's own approval re-runs the command after the yes: the commands
  are registered (`CONNECTOR_COMMANDS`) and their requirement names the owner as the only approver, the DM
  as the place and `private: true` (new `ApprovalDraft` / `NewApproval` flag: the Asks payload keeps only the
  action type). *Superseded by `connectors.md` IN-01: the person condition's `private` flag is the only mark.*
- **GT-08 Always-asking actions** (`mail_send`, invites, `files_share`, `files_trash`) ask even if a key said
  allow. The command prepares the action (drafts a full message, reads the file's name, reads the event's
  guests) and creates the approval: owner as only approver, card in the owner's DM with the agent (opened as
  the owner would if it is missing), card text “I need your yes before I send an email to a@b.com.”,
  explainer “Tulip holds “Send emails”, a key that always asks you first. If you approve, it goes ahead
  right away.”, extra WHAT HAPPENS lines `Message: “…”` (240 characters), `When: 2 Oct 14:00–14:30` and
  `Guests: …`, Asks text from `describeAsk` (content-free). The tool answers `pending_approval` with “Mara has
  to approve this first. It goes ahead once they say yes.”
- **GT-09 Calendar keys.** Create: by the input's guests. Update and delete read the event first (inside the
  requirement): its guests (GT-04) plus the input's decide (`calendarChangeKey`). An update approval always
  spells out the guest list after the change, so the stored change never reads as “no guests”.
- **GT-10 `mail_send`.** `MailSendAction.params.bcc` (core, default `[]`) and the approval's runs line show
  blind copies too. The executor re-reads the draft and sends only if recipients, subject and the start of the
  body are still what was approved (“The draft changed after it was approved. Ask again.”).
- **GT-11 Executors** run as the requester's owner connection and only when `decidedById` is the owner.

## Keeping the log content-free (PA-09)

- **GT-12a** `describeActionForLog` (core): personal actions read “send an email”, “send a calendar invite”,
  “send an updated calendar invite”, “cancel an event”, “share a file”, “move a file to the trash”; others as
  `describeAction`. Used by `describeAsk`, the approval failure and blocked texts, and approve / decline / undo
  texts (“Declined Tulip’s request to send an email”); a Blocked decide on a personal approval says
  “request #n”. Blocked tool texts come from content-free attempts (“Tried to send an email. Blocked.”).
- **GT-12b** `perform_action` and `request_approval` refuse the four personal action types (`bad_request`):
  a generic request would pick other approvers and let the agent write the copy.
- **GT-12c** Owner-only visibility of these approvals needs nothing new: approvers are only the owner and
  the card lives in the owner's DM, and `approvalVisible` already checks exactly those.

## Demo

- **GT-12 The scripted assistant** (`agent-runtime/src/scripted/assistant.ts`): a personal agent asked about
  its inbox runs `mail_search` (`in:inbox newer_than:1d`) and lists today's mail (“You have 2 emails from
  today, 2 unread: …”); asked about its calendar, `calendar_events` for tomorrow in the burrow's zone. When the
  tool refuses: “I can’t reach your account yet. Connect Google in Settings → Connections, then ask me again.”

## Tests

- `test/personal.ts` `addPersonalAgent` writes a personal agent (role, `owner_id`, default personal grants, DM)
  and a connection with sealed tokens (access token `fake-token`, an hour) straight to the tables, so these
  tests do not depend on the personal-agents and connections streams. *Superseded by `connectors.md` IN-06.*
