/**
 * Audit events. Every write is a signed event in a per-burrow hash chain:
 * `hash = sha256(canonicalJson(envelope))`, `sig = ed25519.sign(hashBytes, sk)`.
 * The log UI shows events whose `text` is set; internals are signed with `text: null`.
 */
import { z } from 'zod';
import { ApprovalId, BurrowId, EventId, PrincipalId } from '../ids.js';
import { KeyId } from '../keys/catalog.js';
import { AuditVaultDetail } from '../vault/schemas.js';
import { ApprovalState } from './approval.js';
import { Fingerprint, JsonObject, PublicKeyHex, Sha256Hex, SignatureHex, Timestamp } from './common.js';
import { LinkRef } from './links.js';

/** Display category and log filter chips (System is only under "All"). `Vault` since 0.14 (vault.md VT-50). */
export const AUDIT_KINDS = ['Code', 'Asks', 'Keys', 'Vault', 'Messages', 'Blocked', 'System'] as const;
export const AuditKind = z.enum(AUDIT_KINDS);
export type AuditKind = z.infer<typeof AuditKind>;

/** Machine event type, dotted lowercase (`message.posted`). See `EVENT_TYPES` for the known ones. */
export const EventType = z.string().regex(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/);
export type EventType = z.infer<typeof EventType>;

/** Event types the server writes, with the log kind each one gets. */
export const EVENT_TYPES = {
  'burrow.created': 'System',
  'burrow.renamed': 'System',
  'repo.enabled': 'System',
  'repo.disabled': 'System',
  'repo.added': 'System',
  'repo.renamed': 'System',
  'repo.created': 'System',
  'message.posted': 'Messages',
  'message.edited': 'Messages',
  'message.reacted': 'Messages',
  'message.more_requested': 'Messages',
  'answer.posted': 'Messages',
  'canvas.created': 'Messages',
  'canvas.edited': 'Messages',
  'canvas.commented': 'Messages',
  'tickets.tagged': 'Messages',
  'plan.created': 'Messages',
  'plan.updated': 'Messages',
  'agent.updated': 'Keys',
  'keys.granted': 'Keys',
  'keys.changed': 'Keys',
  'keys.revoked': 'Keys',
  'agent.status': 'System',
  'run.started': 'Code',
  'run.step': 'Code',
  'run.log': 'Code',
  'run.tests': 'Code',
  'run.files': 'Code',
  'run.finished': 'Code',
  'run.paused': 'Code',
  'run.resumed': 'Code',
  'run.retried': 'Code',
  'run.stalled': 'Code',
  'run.taken_over': 'Code',
  'branch.pushed': 'Code',
  'pr.opened': 'Code',
  'pr.commented': 'Code',
  'pr.changes_requested': 'Code',
  'pr.approved': 'Code',
  'pr.merged': 'Code',
  'checks.completed': 'Code',
  'job.ran': 'Code',
  'pipeline.retried': 'Code',
  'approval.requested': 'Asks',
  'approval.approved': 'Asks',
  'approval.declined': 'Asks',
  'approval.undone': 'Asks',
  'approval.executed': 'Asks',
  'approval.failed': 'Asks',
  'action.blocked': 'Blocked',
  'dispatch.created': 'System',
  'auth.signed_in': 'System',
  // Added by the server-core workstream (docs/decisions/server-core.md).
  'burrow.updated': 'System',
  'onboarding.completed': 'System',
  'conversation.updated': 'System',
  'dm.opened': 'System',
  'approval.executing': 'Asks',
  'canvas.resolved': 'Messages',
  'search.asked': 'System',
  // Added by the github workstream (docs/decisions/github.md).
  'github.connected': 'System',
  'github.disconnected': 'System',
  'github.repos_synced': 'System',
  'pr.updated': 'Code',
  'pr.closed': 'Code',
  'pr.reopened': 'Code',
  'pr.review_requested': 'Code',
  // Added by the production-readiness workstream (docs/decisions/archive/production.md); `member.updated` until 3.0.
  'person.updated': 'System',
  // Added by the selfhost-foundation workstream (docs/decisions/archive/selfhost-foundation.md).
  'agent.runtime_changed': 'Keys',
  'burrow.workdir_changed': 'Keys',
  // Added by the connectors-google-tools workstream (docs/decisions/connectors-google-tools.md): the agent's changes to
  // the account of the person a turn is for. Their texts hold no content (“Drafted an email”, PA-09).
  'mail.drafted': 'Messages',
  'mail.organized': 'Messages',
  // What the person let the agent trash without asking (`mail.delete`, `files.delete` at On).
  'mail.trashed': 'Messages',
  'files.trashed': 'Messages',
  'calendar.event_created': 'Messages',
  'calendar.event_changed': 'Messages',
  'calendar.event_deleted': 'Messages',
  'files.created': 'Messages',
  'docs.edited': 'Messages',
  'sheets.edited': 'Messages',
  // Added by the memory workstream (docs/decisions/bp-memory.md): ids, versions and scope only, never bodies
  // (BP-06). Instructions change how an agent works (Keys); knowledge is System.
  'instruction.proposed': 'Keys',
  'instruction.approved': 'Keys',
  'instruction.rejected': 'Keys',
  'instruction.deleted': 'Keys',
  'memory.proposed': 'System',
  'memory.approved': 'System',
  'memory.rejected': 'System',
  'memory.deleted': 'System',
  'checkpoint.saved': 'System',
  // Capability packs: ids, names, versions and hashes only — never secrets, tool arguments or tool output.
  // Since 0.113 only old history carries them: nothing writes a `pack.*` event any more.
  'pack.imported': 'System',
  'pack.uninstalled': 'System',
  'pack.exported': 'System',
  'pack.attached': 'Keys',
  'pack.detached': 'Keys',
  'pack.enabled': 'Keys',
  'pack.disabled': 'Keys',
  'pack.pinned': 'Keys',
  'pack.tool_approved': 'Keys',
  'pack.tool_revoked': 'Keys',
  'pack.secret_set': 'Keys',
  'pack.secret_cleared': 'Keys',
  'pack.tool_called': 'Code',
  'pack.tool_finished': 'Code',
  // The skills library (docs/decisions/skills-library.md SL-01, SL-03, SL-06): ids, skill names, statuses and scan
  // verdicts, never a skill's body or files (BP-06). A skill changes how an agent works, like an instruction (Keys).
  'pack.skill_switched': 'Keys',
  'skill.proposed': 'Keys',
  'skill.approved': 'Keys',
  'skill.rejected': 'Keys',
  // The Vault (docs/decisions/vault.md VT-50, VT-51): neutral text for everyone (“Used a private Vault entry”); payloads
  // carry ids and a hash of the owner-only detail, never names, tools, paths or statuses. Asking and deciding use the
  // approval events.
  'vault.entry.added': 'Vault',
  'vault.entry.changed': 'Vault',
  'vault.entry.secret_replaced': 'Vault',
  'vault.entry.removed': 'Vault',
  'vault.key.given': 'Vault',
  'vault.key.changed': 'Vault',
  'vault.key.taken': 'Vault',
  'vault.used': 'Vault',
  'vault.refused': 'Blocked',
  // The browser (Whombat browser.md BT-03): one hidden event per tool call (`text: null`), its payload `{tool, origin,
  // dispatchId}` — the page's origin only, never a path, query, typed text or content. A sign-in also signs
  // `vault.used`.
  'browser.used': 'System',
  // Kept sites (Whombat kept-sites.md KS-07): `{siteId, site, origins, hours, dispatchId?}` — never a cookie.
  'browser.site_kept': 'System',
  'browser.site_forgotten': 'System',
  'browser.site_stopped': 'System',
  // Contracts 0.26, the essentials (CT-173, CT-174, CT-177, CT-172): ids only, never message text.
  'message.deleted': 'Messages',
  'message.pinned': 'Messages',
  'message.unpinned': 'Messages',
  // Contracts 0.119 (CT-993): a person cleared their Chat or Feedback room (`chats.clear`); ids and counts only.
  'chat.cleared': 'Messages',
  'dispatch.retried': 'System',
  // Contracts 0.36 (Whombat agent-computer.md): an allowance of a command added (“Always allow”) or removed (ids, key and
  // target; the command only in the allowance), a skill learned at once or removed (AC-52). The computer's own
  // `agent.computer` and the sweep's `vault.swept` went with it in 3.0 (CT-1530); the person stopped one of the agent's
  // services: `service.stopped` (`{id, name, port}`, CT-1536).
  'service.stopped': 'Keys',
  'command.allowance_added': 'Keys',
  'command.allowance_removed': 'Keys',
  'skill.learned': 'Keys',
  'skill.removed': 'Keys',
  // Contracts 0.113 (CT-814; Whombat skill-store.md SST-04, SST-06, SST-17): skills without packs. Skills added to an
  // agent by an import or Add (`skill.imported`, until 2.0: history only since, CT-1416), switched on or off for it
  // (`skill.switched`), changed by a person (Edit, Undo: `skill.changed`) and reset to the shipped original
  // (`skill.reset`; since 2.0 Hermes's version of a built-in). Ids, skill names and verdicts only, never a skill's body or
  // files (BP-06); the text names the skill without a pack or version (“Learned the skill x”).
  'skill.imported': 'Keys',
  'skill.switched': 'Keys',
  'skill.changed': 'Keys',
  'skill.reset': 'Keys',
  // Contracts 0.44 (Whombat resourceful-agents.md): the LAN switch (RA-41); a person's profile changed (hidden, `text: null`: private to them, ids and counts only,
  // RA-20); an agent's notes changed by it or a person (ids and counts, never the text, RA-21); a schedule made, paused,
  // resumed or ended (ids, `when` and status, never the prompt, RA-30).
  'burrow.agents_lan_changed': 'Keys',
  'profile.changed': 'System',
  'notes.changed': 'Keys',
  'schedule.created': 'System',
  'schedule.paused': 'System',
  'schedule.resumed': 'System',
  'schedule.ended': 'System',
  // Contracts 0.48 (Whombat connections-catalog.md CX-22, CX-23; since 3.0 every connection, CT-1550): a connection
  // added, changed (label, address, tool tiers), removed or needing to be connected again, signed in its burrow; a
  // tool's tier changed (Keys: it changes what agents may do); each call and its end (connection, tool, tier, outcome,
  // ms, output bytes — never arguments or output).
  'connection.added': 'System',
  'connection.changed': 'System',
  'connection.removed': 'System',
  'connection.needs_reauth': 'System',
  'connection.tool_tier_changed': 'Keys',
  'connection.tool_called': 'Code',
  'connection.tool_finished': 'Code',
  // A person's place changed on a Find My connection an automation listens to (`FindMyPlaceChanged`: the connection,
  // the person's id and name, the place's words before and now; never a street or coordinates). Automations start on it.
  'findmy.place_changed': 'System',
  // Whombat monitoring.md MON-06: an incident opened (`thing.down`: it doesn't answer; `thing.problem`: its dot turned
  // bad) or ended (`thing.back`), signed by the Servers signer (`ThingIncidentEvent`: the thing, its name, the incident,
  // its words, when; no text, it shows in no feed). Automations start on them.
  'thing.down': 'System',
  'thing.problem': 'System',
  'thing.back': 'System',
  // Contracts 3.15 (Whombat assistant-settings.md): the assistant asked to change one of the person's settings and it
  // went ahead or was approved (`{op, deferred}`, hidden: the op signs what it changed itself).
  'setting.changed': 'System',
  // Shared links (Whombat share-links.md, contracts 3.18).
  'share.created': 'Messages',
  'share.stopped': 'Messages',
  // Contracts 0.110 (CT-710; Whombat connections-setup.md CS-53, CS-D47): a service the scan found hidden from Found on
  // your network, or shown there again (`{catalogId, host, port}`; the text names the entry and its address).
  'connection.found_hidden': 'System',
  'connection.found_shown': 'System',
  // Contracts 0.49 (Whombat files-space.md FS-04, CT-275): a file saved straight into a conversation's Files, renamed
  // or moved (`{attachmentId, conversationId}`), or removed from Files; ids only, never names or folders.
  'file.saved': 'Messages',
  'file.updated': 'Messages',
  'file.removed': 'Messages',
  // Contracts 0.55 (Whombat improvement-review RF-01, RF-02; CT-295, CT-296): a person stopped an agent's turn (hidden,
  // `text: null`: `{dispatchId, agentId}`); a deploy recorded by an agent or a deploy job (`{deploymentId, environment,
  // service, status, how, sha}` — never the summary or the URL; the text says “Deployed api to production”).
  'dispatch.cancelled': 'System',
  'deploy.recorded': 'Code',
  // Contracts 0.76 (Whombat ai-gateway.md AIG-05, AIG-06): a switch of the burrow's AI gateway turned on or off
  // (`{connectionId, provider, on}`; the text is `gatewayKeysText`, and says when it overrides a provider's terms).
  'burrow.ai_gateway_changed': 'Keys',
  // Contracts 0.124 (CT-1176; Whombat hermes-engine.md HE-32): the model on the person's network set up, changed or removed
  // (`{change}`: `set`, `changed`, `removed`; the text is `localModelKeysText`), never the key.
  'burrow.local_model_changed': 'Keys',
  // Web search (Whombat web-search.md): the Brave Search key set, changed or removed (`{change}`; the text is
  // `webSearchKeysText`), never the key.
  'burrow.web_search_changed': 'Keys',
  // Contracts 0.112 (CT-784; Whombat vault-self-serve.md VS-02, VS-07): an entry the agent saved for the person (`vault_save`,
  // signed by the agent, `vaultAuditText('entry.saved')`, the person's detail as every Vault event).
  'vault.entry.saved': 'Vault',
  // `skill.shared` (0.125, CT-1215) went in 3.0 (CT-1573, CT-1508): one skills list, nothing to share. A signed event
  // keeps its own type and kind (`EventType` is any dotted name), so a log that has it stays readable. The person's
  // memory changing signs `profile.changed` (hidden, `text: null`), the agent's notes `notes.changed`.
  // Contracts 2.0 (CT-1416; Whombat hermes-skills.md HSK-06, HSK-09): a skill installed from Hermes's hub, or updated
  // to its source's newer version (`{name, source, identifier, trust, verdict}`; the text names
  // the skill, never its text). `skill.imported` stays for the log's history (CT-1247's rule); Restore of a built-in signs
  // `skill.reset`, switching `skill.switched`, an edit `skill.changed`, a removal `skill.removed`.
  'skill.installed': 'Keys',
  'skill.updated': 'Keys',
} as const satisfies Record<string, AuditKind>;
export type KnownEventType = keyof typeof EVENT_TYPES;

/** Key reference frozen into the event (label as shown when it was signed). */
export const AuditKeyRef = z.object({ id: KeyId, label: z.string().min(1).max(160) });
export type AuditKeyRef = z.infer<typeof AuditKeyRef>;

export const AuditDecision = z.object({
  byId: PrincipalId,
  at: Timestamp,
  decision: z.enum(['approved', 'declined']),
});
export type AuditDecision = z.infer<typeof AuditDecision>;

/** Chain position: every burrow's chain starts at seq 1 with `prevHash = GENESIS_HASH`. */
export const GENESIS_HASH = '0'.repeat(64);

/** The signed content of an event. Optional fields are omitted (not null) when absent. */
export const EventEnvelope = z.object({
  /** Envelope format version. */
  v: z.literal(1),
  id: EventId,
  burrowId: BurrowId,
  seq: z.number().int().positive(),
  prevHash: Sha256Hex,
  actorId: PrincipalId,
  type: EventType,
  kind: AuditKind,
  /** Human summary shown in the log, or null for internals hidden from the log. */
  text: z.string().max(500).nullable(),
  /** "whombat/billing · PR #482", "Chat", "Run #1907", "Help widget", "Agent · Dusty". */
  where: z.string().max(200).nullable(),
  /** KEY USED, or KEY IT NEEDED for Blocked events. */
  keyUsed: AuditKeyRef.optional(),
  /** "asks a person first", "not one of Banjo’s keys". */
  keyNote: z.string().max(160).optional(),
  /** ON BEHALF OF: "Waffle’s review on PR #482", "Schedule · every day at 06:00". */
  onBehalfOf: z.string().max(200).optional(),
  /** The principal the work is for, when there is one (filters). */
  onBehalfOfId: PrincipalId.optional(),
  /** Principal the event is about (Keys events about an agent; "Only Banjo" filter matches these too). */
  aboutId: PrincipalId.optional(),
  /** Decision recorded with the event (imported history); live decisions are joined at read time. */
  decided: AuditDecision.optional(),
  /** Approval this event belongs to (Asks events). */
  approvalId: ApprovalId.optional(),
  /** Deep link for the expanded row. */
  ref: LinkRef.optional(),
  /** Machine payload (command input / result). JSON only. */
  payload: JsonObject,
  createdAt: Timestamp,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** An envelope with its hash and the actor's signature. This is what the `events` table stores. */
export const SignedEvent = EventEnvelope.extend({
  hash: Sha256Hex,
  sig: SignatureHex,
  /** Public key of the signer at signing time. */
  signer: PublicKeyHex,
});
export type SignedEvent = z.infer<typeof SignedEvent>;

/** Live state of the approval an Asks event belongs to (for the pill and DECIDED row). */
export const AuditApprovalState = z.object({
  number: z.number().int().positive(),
  state: ApprovalState,
  decidedById: PrincipalId.nullable(),
  decidedAt: Timestamp.nullable(),
  executedAt: Timestamp.nullable(),
});
export type AuditApprovalState = z.infer<typeof AuditApprovalState>;

/** An event as the audit log shows it, verified on read. */
export const AuditEvent = SignedEvent.extend({
  fingerprint: Fingerprint,
  /** Signature valid and chain link intact. */
  verified: z.boolean(),
  approval: AuditApprovalState.nullable(),
  /**
   * A Vault event's owner-only detail (vault.md VT-52): filled only for the entry's owner, on `audit.list`, `audit.get`,
   * `audit.export` and `audit.appended`; absent for everyone else. Not part of the signed envelope.
   */
  vault: AuditVaultDetail.nullable().optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
