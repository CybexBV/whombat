# Workstream: connectors foundation

The shared base for the three connectors streams (personal agents, connections, Google tools), built from
`connectors.md` on 2026-09-24. Everything below is settled; the spec's own decisions are not repeated.

## Role and palette (PA-01)

- **CF-01 Assistant palette.** Accent `#c26f9b`, deep `#974d76` (a rose, clear of the six mock accents: blue,
  green, violet, terracotta, ochre, teal), fur `ash`, accessory `pencil`, expression `warm`. No new geometry:
  the pencil (with its sweater pocket) and the warm face already exist; ash + warm and a rose sweater tell it
  apart from the architect (cocoa, thoughtful, blue) and support (sandy, warm, teal). Tokens:
  `--role-assistant`, `--role-assistant-deep`. Static SVGs `svg/assistant.svg` and `svg/assistant-head.svg` are
  exported with the others (the six existing files are byte-identical).
- **CF-02 Hireable roles.** `HIREABLE_ROLES` (schema `HireableRole`) is the six mock roles. `HireBody.role`,
  `CompleteOnboardingBody.roles` and onboarding's `selectedRoles` take a `HireableRole`, so the API refuses to
  hire or onboard an assistant; the hire modal and the onboarding templates list `HIREABLE_ROLES`.
  `HIRE_DEFAULTS.role` and `ONBOARDING_DEFAULT_ROLES` are typed as hireable. `createAgent` (server) takes any
  `AgentRole` so `ensurePersonalAgent` can use it.
- **CF-03 Records keyed by role** get an `assistant` entry: label “Assistant”, the spec's job line,
  `ROLE_DEFAULT_NAMES.assistant = 'Tulip'` (the first `PERSONAL_AGENT_NAMES` entry; a real personal agent picks
  a free name), DM suggestions “What’s in my inbox today?”, “What’s on my calendar tomorrow?”, “Find the latest
  invoice in my Drive”, and `ROLE_DEFAULT_KEYS.assistant` = `PERSONAL_DEFAULT_GRANTS` as a key set.
- **CF-04 Visual specs.** `apps/web/visual/avatars.spec.ts` compares the six mock roles only (the reference has
  no assistant).

## Personal agents (PA-02, PA-04)

- **CF-05 `Agent.ownerId`** is `PrincipalId.nullable().default(null)`: agents parsed from before the field
  exist keep working. Fixtures and the seed set `null` explicitly.
- **CF-06 Names.** `pickPersonalAgentName(taken)` compares case-insensitively and trims; after the 30 names it
  tries `Tulipa`…`Tulipz`, `Wattlea`…, then two-letter suffixes, and throws only if all of those are taken.
  `PERSONAL_AGENT_NAME_PATTERN` (`^[A-Z][a-z]{1,39}$`) is the rename rule's shape; “free in the burrow” is the
  server's check.
- **CF-07 Handles.** `personalAgentHandle(personHandle, taken)` keeps the `-assistant` suffix whole and cuts the
  person's part (trailing dashes trimmed) so the handle is at most 32 characters; duplicates get `-2`, `-3`, …
  with the person's part cut further to fit.

## Keys

- **CF-08** The 12 personal keys are appended to `KEY_IDS` after the people-only keys (display order for a
  personal agent's rows: search first as held, then mail, calendar, files, contacts). Group `personal`,
  `KEY_GROUP_LABELS.personal = 'Personal accounts'` (a new record for group headings). Send, invite, share and
  delete have `agentMaxTier: 'ask'`, so their rows read “always asks a person”. Descriptions are ours (the
  spec gives labels only).
- **CF-09** `PERSONAL_DEFAULT_GRANTS` is a `GrantInput[]` (search first, then catalog order);
  `personalDefaultGrants(agentId)` makes grants. `isPersonalKey()` and `personalAgentMayHold()` (personal keys
  plus `messages.search`) are the helpers PA-07's refusals use.

## Connectors vocabulary and contracts

- **CF-10** New id prefixes `con_` (connections) and `oas_` (OAuth states). The provider-label record is
  `CONNECTOR_PROVIDER_LABELS` (`PROVIDER_LABELS` already names the AI providers).
- **CF-11 `ConnectorsStatus`** = `{ mode, google: { app, setup, tested }, canConfigure, connections }`.
  `app.source` is `settings` | `config` | null; `canConfigure` is “admin of this Whombat and the app is not set
  in config”. `setup` carries the redirect URI, the enable-APIs link, the console links (project, branding,
  audience, client), every scope, and the copy-button values (app name “Whombat”, the admin's email, the
  `PUBLIC_URL` host). `tested` turns step 6 green.
- **CF-12 Endpoint groups** `api.connectors` (status, setGoogleApp, removeGoogleApp) and `api.connections`
  (startGoogle, check, remove). `SetGoogleAppBody.clientSecret` is optional so an admin can change the audience
  without pasting the secret again. `StartGoogleBody.returnTo` must be a same-origin path (`/…`, not `//…`).
  `connections.remove` answers `OkResponse`. The callback is a browser route, not a contract endpoint.
- **CF-13 Workspace item shapes** live in `domain/workspace.ts` (mail summaries/messages/drafts, events and event
  input/patch, files and their content, doc edits, sheet cells, contacts), shared by the MCP tool contracts and
  the server's `GoogleWorkspace` interface. Email inputs are trimmed and lowercased. Event times are an instant
  with offset or a date (all-day).

## MCP tools

- **CF-14** The 18 tools are defined in `contracts/mcp-connectors.ts` (`CONNECTOR_MCP_TOOLS`) and spread into
  `MCP_TOOLS`, each with `connector`. `WHOMBAT_TOOL_NAMES` lists the rest; `mcpToolConnector(name)` tells them
  apart. Until the tools stream gates them per agent, the MCP server advertises `WHOMBAT_TOOL_NAMES` only.
- **CF-15** `mcpRequiredKey`: `calendar_create_event` / `calendar_update_event` → `calendar.invite` when the
  input has guests, else `calendar.write`; `calendar_delete_event` → `calendar.write`. The server upgrades
  update/delete to `calendar.invite` when the existing event has guests. `calendarChangeKey()` is the rule.
- **CF-16** `mail_send` accepts a `draftId` or a full message (at least one recipient). The `mail_send`
  approval always references a draft (`params.draftId` required): a full message is drafted first, so what the
  owner approves is exactly what is sent.

## Approval actions

- **CF-17** `mail_send`, `calendar_invite`, `files_share`, `files_trash` join `ApprovalAction`
  (`PERSONAL_ACTION_TYPES`, `isPersonalAction`). Keys: `mail.send`, `calendar.invite`, `files.share`,
  `files.delete`. `describeAction` follows the spec's examples; more than three mail recipients read “a@b.com
  and 3 others”; an updated invite reads “send an updated calendar invite for “X” to N people”, a cancelled
  one “cancel “X” for N people”. Card targets are `Mail · mara@gmail.com`, `Calendar · Standup`,
  `Drive · Q3 plan`; verbs “send the email” / “send the invite” / “share the file” / “move the file to the
  trash”.
- **CF-18** Executed-event texts carry no content (PA-09): “Sent an email”, “Sent a calendar invite”, “Sent an
  updated calendar invite”, “Cancelled an event”, “Shared a file”, “Moved a file to the trash”. The Asks event
  text (`describeAsk`) and the failure text still name recipients/files; the tools stream decides how to keep
  those private (the approval itself is owner-only).

## Server

- **CF-19 Migration `0012_personal_agents_connectors`**, generated by `drizzle-kit generate` from the schema
  (journal and snapshot consistent): `principals.owner_id` + unique `(burrow_id, owner_id) WHERE owner_id IS NOT
  NULL`; tables `connector_apps`, `connections`, `oauth_states`. Additions to the spec's columns:
  `connections.granted_at` (when the current refresh token was granted, for `testing_expired` vs `revoked`),
  `oauth_states.created_at` and `used_at` (single use is `used_at IS NULL`). `oauth_states.id` is the `state`
  sent to Google. Foreign keys: connections and states cascade with their account; the app's
  `updated_by_account_id` is set null.
- **CF-20 Secrets.** `KeyCustody.seal(aad, text)` / `open(aad, stored)` use key custody's `v1:` AES-256-GCM
  format for any text. `connectors/crypto.ts`: AAD `connector_app:<provider>` for the client secret,
  `connection:<id>:refresh` and `connection:<id>:access` for tokens.
- **CF-21 Adapters** (`connectors/types.ts`): `GoogleOAuth` (authorizeUrl, exchangeCode, refresh, revoke,
  userinfo; `GoogleOAuthError` with `invalid_grant` etc.), `GoogleWorkspace` (one method per tool plus
  `checkService`, `mailGetDraft`, `calendarGetEvent`, `filesGet` that approvals and key upgrades need; every
  method takes the access token first; `GoogleApiError` carries `enableUrl`), `ConnectionTokens.accessFor`
  (`ConnectionUnavailableError`), `GOOGLE_HOSTS` + `isGoogleUrl`. `services.google = { mode, oauth, workspace,
  tokens }` is built by `connectors/index.ts` from one factory per file (`oauth.ts`, `workspace.ts`,
  `tokens.ts`) so the streams edit different files.
- **CF-22 Config.** `WHOMBAT_GOOGLE=real|fake|off`: default `real`, `fake` when `NODE_ENV=test` or
  `WHOMBAT_DEMO`; `fake` is refused in production. `WHOMBAT_GOOGLE_CLIENT_ID` + `WHOMBAT_GOOGLE_CLIENT_SECRET`
  (or `_FILE`) are both or neither; the secret is a `SECRET_FILE_KEYS` entry (and a CLI secret setting).
- **CF-23 Stubs.** Connector tool handlers answer `not_implemented`; the four executors fail the execution
  (“Not implemented yet: the mail_send executor.”) so nothing is sent by accident; the six endpoints and the
  callback answer 501 (`routes/connectors.ts`, listed as later-phase in `endpoints.int.test.ts`). The runner
  context sets `personal: null`.
