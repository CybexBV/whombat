/**
 * Commands people (and, for drafts only, agents) use on automations. Each is a commit-pipeline command, so it
 * is signed by whoever did it and keyed: publishing, switching on, keys and test runs need “Change the agent and its
 * keys” (`agents.manage`, the person only), the webhook needs the person (docs/decisions/bp-automations.md BP-C03).
 */
import {
  AUTOMATION_KEYS,
  type AutomationDefinition,
  AutomationDefinition as AutomationDefinitionSchema,
  type AutomationExport,
  AutomationGrant,
  AutomationId,
  type AutomationRecipe,
  AutomationRunId,
  AutomationStepId,
  buildRecipe,
  buildTemplate,
  clampTier,
  conversationLabel,
  DispatchId,
  decide,
  definitionHash,
  type JsonObject,
  JsonObject as JsonObjectSchema,
  mailDefinitionProblems,
  NewAutomationSource,
  NumberParam,
  newId,
  parseAutomationExport,
  RepoFullName,
  recipeDefinition,
  recipeHasEarlierWords,
  recipeOf,
  recipeProblem,
  recipeWithTodaysWords,
  renameRepoInJson,
  TemplateParams,
  type TrackerRecipeWords,
  topics,
  validateDefinition,
} from '@whombat/core';
import { and, eq, inArray, max, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applyContext } from '../commit/pipeline';
import type { ApplyContext, TxSession } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  automationCursors,
  automationDestinations,
  automationRunSteps,
  automationRuns,
  automations,
  automationVersions,
  catalogConnections,
  dispatches,
  events,
  grants,
  principals,
  repos,
  trackerFixes,
} from '../db/schema/index';
import { briefAgent } from '../domain/agent-brief';
import { postMessage } from '../domain/messages';
import { findMyBackgroundFor } from '../hosts/findmy-background';
import { findMyConnectionRow } from '../hosts/findmy-connection';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { checkOutboundUrl } from '../lib/outbound';
import { newSecret } from '../lib/secrets';
import { mailConnectionRow } from '../mail-triggers/index';
import { inBurrow, loadConversationRow } from '../read/conversations';
import { engineActor, loadPrincipalRow, toActor } from '../read/principals';
import { publishDispatch } from '../runtime/activity';
import { outsidersTurn } from '../runtime/person';
import { trackerConnectionRow } from '../trackers/connection';
import { driverIdOf, noDriverText, recipeWordsOf } from '../trackers/drivers';
import { stopRunRequests } from '../trackers/features';
import { scopeReport, type TrackerRunItem, TrackerRunItemSchema, trackerItemScope } from '../trackers/items';
import { nextContinueStepId, unlandedReason } from '../trackers/unlanded';
import { automationAgent, publisherCheck } from './authority';
import { planDirectAction } from './direct-action';
import { GitHubItem, githubItemScope, itemRef, sampleTrigger } from './github-items';
import { smartHomeTriggersFor } from './home-triggers';
import { postRunNotice } from './notice';
import { republishPlanCards } from './plan-cards';
import { createAutomationPrincipal } from './principal';
import { proposeConnectionActions } from './proposed-actions';
import { createRun } from './runs';
import {
  ACTIVE_RUN_STATUSES,
  type AutomationRunRow,
  automationGrants,
  listensToEvents,
  loadAutomationRow,
  loadStepRows,
  publishAutomation,
  publishRun,
  scheduleNext,
} from './store';
import { type AgainMark, resetOutput, resetStepsFrom } from './tries';
import { hasWebhookTrigger, NO_WEBHOOK_TRIGGER_TEXT, refuseWebhookTrigger } from './webhook-trigger';

export const webhookSecretAad = (automationId: string) => `automation:${automationId}:webhook`;

export const cap = (s: string) => s.slice(0, 80);

/**
 * Starts the burrow's trigger cursor at its latest event, so publishing (or switching on) never replays history
 * (BP-C07). The engine moves a cursor only while some live automation of the burrow reads events (SV-03): when no
 * other one does, the cursor waited where it was and moves to the latest event now.
 */
export async function ensureCursor(tx: Tx, burrowId: string, now: Date, automationId: string): Promise<void> {
  const [row] = await tx
    .select({ seq: max(events.seq) })
    .from(events)
    .where(eq(events.burrowId, burrowId));
  const [other] = await tx
    .select({ id: automations.id })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.burrowId, burrowId),
        eq(automations.status, 'published'),
        ne(automations.id, automationId),
        listensToEvents(automationVersions.definition),
      ),
    )
    .limit(1);
  const insert = tx.insert(automationCursors).values({ burrowId, seq: row?.seq ?? 0, updatedAt: now });
  if (other) await insert.onConflictDoNothing();
  else
    await insert.onConflictDoUpdate({
      target: automationCursors.burrowId,
      set: { seq: sql`greatest(${automationCursors.seq}, excluded.seq)`, updatedAt: now },
    });
}

/** Every conversation a definition names (triggers, steps, its own room). */
export function definitionConversations(def: AutomationDefinition): string[] {
  const ids = new Set<string>([def.conversationId]);
  for (const t of def.triggers) if ('conversationId' in t) ids.add(t.conversationId);
  for (const s of def.steps)
    if ((s.kind === 'dispatch_agent' || s.kind === 'post_message') && s.conversation !== 'run')
      ids.add(s.conversation);
  return [...ids];
}

/**
 * What only the server can check about a definition: the rooms, agents and approvers it names exist in this burrow
 * (every room of it is the person's), and callback URLs are allowed.
 */
export async function referenceProblems(
  ctx: ApplyContext,
  def: AutomationDefinition,
  forPublish: boolean,
): Promise<string[]> {
  const problems: string[] = [...mailDefinitionProblems(def)];
  if (hasWebhookTrigger(def)) problems.push(NO_WEBHOOK_TRIGGER_TEXT);
  // A tracker trigger listens to one of the burrow's tracker connections; a mail trigger to one of the person's mailboxes.
  for (const t of def.triggers) {
    if (t.kind === 'tracker' && !(await trackerConnectionRow(ctx.tx, ctx.burrow.id, t.connectionId)))
      problems.push(`There is no tracker connection ${t.connectionId} on this Whombat.`);
    if (t.kind === 'mail' && !(await mailConnectionRow(ctx.tx, ctx.burrow.id, t.connectionId)))
      problems.push(`There is no connected mailbox ${t.connectionId} on this Whombat.`);
    if (t.kind === 'findmy' && !(await findMyConnectionRow(ctx.tx, ctx.burrow.id, t.connectionId)))
      problems.push(`There is no Find My connection ${t.connectionId} on this Whombat.`);
    // Home Assistant and UniFi Protect triggers name one of the person's connections of that kind.
    if (t.kind === 'home_state' || t.kind === 'protect') {
      const catalogId = t.kind === 'home_state' ? 'homeassistant' : 'unifi_protect';
      const [row] = await ctx.tx
        .select({ catalogId: catalogConnections.catalogId })
        .from(catalogConnections)
        .where(
          and(eq(catalogConnections.id, t.connectionId), eq(catalogConnections.burrowId, ctx.burrow.id)),
        );
      if (row?.catalogId !== catalogId)
        problems.push(
          `There is no ${t.kind === 'home_state' ? 'Home Assistant' : 'UniFi Protect'} connection ${t.connectionId} on this Whombat.`,
        );
    }
  }
  for (const id of definitionConversations(def))
    if (!(await inBurrow(ctx.tx, ctx.burrow.id, id)))
      problems.push(`There is no conversation ${id} on this Whombat.`);
  // The agent runs every step for the automation's person (one-agent.md OA-15): a step names no agent of its own.
  if (def.steps.some((s) => s.kind === 'dispatch_agent') && !(await automationAgent(ctx.tx, ctx.burrow.id)))
    problems.push('This Whombat has no agent to ask.');
  for (const s of def.steps) {
    if (s.kind === 'request_approval')
      for (const id of s.approverIds) {
        const [p] = await ctx.tx.select().from(principals).where(eq(principals.id, id));
        if (!p || p.burrowId !== ctx.burrow.id || p.kind !== 'person')
          problems.push(`Step “${s.id}”: approvers must be people on this Whombat.`);
      }
    if (
      (s.kind === 'tracker_update' || s.kind === 'tracker_reply' || s.kind === 'tracker_decision') &&
      !(await trackerConnectionRow(ctx.tx, ctx.burrow.id, s.connectionId))
    )
      problems.push(`Step “${s.id}”: there is no tracker connection ${s.connectionId} on this Whombat.`);
    // A step that acts by itself names a thing this Whombat has, and a call it can make (`direct-action.ts`).
    if (s.kind === 'run_action') {
      // Something only out of reach now (a server's agent, a sign-in) doesn't stop it being drafted: it says so when
      // it runs.
      const plan = await planDirectAction(ctx.tx, ctx.services, ctx.burrow.id, s);
      if (!plan.ok && (plan.fatal || plan.gone)) problems.push(`Step “${s.id}”: ${plan.reason}`);
      else if (plan.ok && s.thing.startsWith('server:') && !plan.server)
        problems.push(`Step “${s.id}”: there is no server ${s.thingName} on this Whombat.`);
    }
    if (s.kind === 'http_callback') {
      try {
        checkOutboundUrl(s.url, { allowPrivate: ctx.services.config.WHOMBAT_OUTBOUND_ALLOW_PRIVATE });
      } catch (err) {
        problems.push(`Step “${s.id}”: ${err instanceof Error ? err.message : 'that URL can’t be called'}.`);
      }
      if (forPublish && ctx.actor.kind !== 'person')
        problems.push(`Step “${s.id}” calls ${new URL(s.url).host}: only you can approve a new destination.`);
    }
  }
  return problems;
}

export function requirePerson(ctx: ApplyContext): void {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can do this.');
}

/** Who may publish: the person, with “Change the agent and its keys” (`agents.manage`; one-person.md OP-S07). */
export function mayPublish(ctx: ApplyContext): boolean {
  return (
    ctx.actor.kind === 'person' && decide(engineActor(ctx.actor), [], 'agents.manage').outcome === 'allow'
  );
}

/**
 * Who may save or throw away a draft (BP-C22): the person when they may publish it, or when they started an
 * automation that was never published. Agents write drafts only through `draft_automation`.
 */
function requireDraftEditor(ctx: ApplyContext, row: { createdById: string; currentVersion: number | null }) {
  requirePerson(ctx);
  if (mayPublish(ctx)) return;
  if (row.currentVersion === null && row.createdById === ctx.actor.id) return;
  throw forbidden('Only you can change this draft.');
}

/**
 * Who may delete an automation (automation-recipes.md): the person when they may publish, or when they started a draft
 * that was never published. Agents never.
 */
function requireDeleter(ctx: ApplyContext, row: { createdById: string; currentVersion: number | null }) {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can delete an automation.');
  if (mayPublish(ctx)) return;
  if (row.currentVersion === null && row.createdById === ctx.actor.id) return;
  throw forbidden('Only you can delete it.');
}

/** Every room the definition uses is still the burrow's (BP-C19): they are all the person's. */
async function requireRoomsHere(ctx: ApplyContext, def: AutomationDefinition): Promise<void> {
  for (const id of definitionConversations(def))
    if (!(await inBurrow(ctx.tx, ctx.burrow.id, id))) throw notFound('Conversation');
}

export async function storeDraft(
  ctx: ApplyContext,
  automationId: string,
  patch: { name?: string; description?: string; definition: JsonObject | null },
) {
  refuseWebhookTrigger(patch.definition);
  await ctx.services.newerAutomations.refuse(patch.definition);
  await ctx.tx
    .update(automations)
    .set({
      ...(patch.name ? { name: cap(patch.name) } : {}),
      ...(patch.description !== undefined ? { description: patch.description.slice(0, 500) } : {}),
      draftJson: patch.definition,
      draftUpdatedById: ctx.actor.id,
      draftUpdatedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(eq(automations.id, automationId));
}

/** A new automation row with its principal; the draft is whatever the source gave. */
export async function insertAutomation(
  ctx: ApplyContext,
  args: { name: string; description: string; draft: JsonObject | null },
): Promise<string> {
  refuseWebhookTrigger(args.draft);
  await ctx.services.newerAutomations.refuse(args.draft);
  const id = newId('automation');
  const principalId = await createAutomationPrincipal(ctx, { name: args.name, createdAt: ctx.now });
  await ctx.tx.insert(automations).values({
    id,
    burrowId: ctx.burrow.id,
    name: cap(args.name),
    description: args.description.slice(0, 500),
    status: 'draft',
    draftJson: args.draft,
    draftUpdatedById: ctx.actor.id,
    draftUpdatedAt: ctx.now,
    principalId,
    createdById: ctx.actor.id,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return id;
}

/**
 * An automation principal's keys, replaced by `list` (unknown and repeated keys left out, tiers clamped), signed as
 * `automation.keys_changed` by the person. What `automation.set_keys` and a recipe's “answer on GitHub” write.
 */
export async function writeGrants(
  ctx: ApplyContext,
  row: { id: string; name: string; principalId: string },
  list: readonly AutomationGrant[],
): Promise<void> {
  const seen = new Set<string>();
  await ctx.tx.delete(grants).where(eq(grants.agentId, row.principalId));
  let position = 0;
  for (const g of list) {
    if (seen.has(g.keyId) || !(AUTOMATION_KEYS as readonly string[]).includes(g.keyId)) continue;
    seen.add(g.keyId);
    await ctx.tx.insert(grants).values({
      burrowId: ctx.burrow.id,
      agentId: row.principalId,
      keyId: g.keyId,
      tier: clampTier(g.keyId, g.tier),
      scope:
        g.repos?.length || g.connections?.length
          ? {
              ...(g.repos?.length ? { repos: g.repos } : {}),
              // A tracker connection's key (`report.update`, report-trackers.md TA-12).
              ...(g.connections?.length ? { connections: g.connections } : {}),
            }
          : null,
      position: position++,
    });
  }
  await ctx.emit({
    type: 'automation.keys_changed',
    kind: 'Keys',
    text: `Changed the keys of the automation “${row.name}”`,
    where: null,
    aboutId: row.principalId,
    payload: { automationId: row.id, grants: list.map((g) => ({ keyId: g.keyId, tier: g.tier })) },
  });
}

/** A grant's connections must be tracker connections of the burrow (report-trackers.md TA-12). */
async function checkGrantConnections(ctx: ApplyContext, list: readonly AutomationGrant[]): Promise<void> {
  for (const id of new Set(list.flatMap((g) => g.connections ?? [])))
    if (!(await trackerConnectionRow(ctx.tx, ctx.burrow.id, id)))
      throw badRequest(`There is no tracker connection ${id} on this Whombat.`);
}

/** The catalog entry of the T3 Code connection a recipe may hand its code work to (TA-37). */
const T3CODE_CATALOG_ID = 't3code';

/**
 * The simple form's answers as an automation file (automation-recipes.md): what only the server can check — the agent
 * is one an automation can ask and is in the channel, the channel is the burrow's and the person is in it, a repository
 * is one of the burrow's and switched on (named as the burrow has it) — then `buildRecipe`. With “answer on GitHub”
 * the automation needs “Comment on pull requests” for the repo; fixing bugs (AR-32) needs agents an automation can ask
 * to fix and to review, and “Open pull requests” for the repo.
 */
export async function recipeFile(
  ctx: ApplyContext,
  given: AutomationRecipe,
): Promise<{ file: AutomationExport; grants: AutomationGrant[] }> {
  const tx = ctx.tx;
  // The agent does every part (one-agent.md OA-15): it fixes, and a fresh turn of it reviews (no memory of the fix).
  const agent = await automationAgent(tx, ctx.burrow.id);
  if (!agent) throw badRequest('This Whombat has no agent to ask.');
  const problem = recipeProblem(given);
  if (problem) throw badRequest(problem);
  const input: AutomationRecipe = given;
  // T3 Code does the code work (TA-37): one of the burrow's T3 Code connections, at Manage, since it starts threads.
  if (input.t3) {
    const [t3] = await tx
      .select({ access: catalogConnections.access })
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, ctx.burrow.id),
          eq(catalogConnections.catalogId, T3CODE_CATALOG_ID),
          eq(catalogConnections.handle, input.t3),
        ),
      );
    if (!t3)
      throw badRequest(
        `There’s no T3 Code connection ${input.t3} on this Whombat: give its handle, or leave t3 out.`,
      );
    if (t3.access !== 'manage')
      throw badRequest(
        `T3 Code (${input.t3}) only looks, so it can’t start threads that change code: set it to Manage in Settings → Connections.`,
      );
  }
  const room = await loadConversationRow(tx, input.conversationId);
  if (!room || room.burrowId !== ctx.burrow.id) throw badRequest('Pick a chat on this Whombat.');
  const label = conversationLabel(room);
  // A tracker recipe's connection (report-trackers.md TA-17): one of the burrow's tracker connections, working, read by
  // a driver installed here, whose words the recipe keeps.
  let connection: string | undefined;
  let words: TrackerRecipeWords | undefined;
  if (input.when.kind === 'tracker') {
    const row = await trackerConnectionRow(tx, ctx.burrow.id, input.when.connectionId);
    if (!row) throw badRequest('Choose one of this Whombat’s tracker connections (Settings → Connections).');
    if (row.status !== 'active')
      throw badRequest(`${row.label} needs a new token: connect it again in Settings → Connections first.`);
    const driver = ctx.services.tracker.drivers.get(driverIdOf(row));
    if (!driver) throw badRequest(noDriverText(row, ctx.services.tracker.drivers.failure(driverIdOf(row))));
    connection = row.label;
    words = recipeWordsOf(driver);
  }
  if (input.when.kind === 'mail') {
    const row = await mailConnectionRow(tx, ctx.burrow.id, input.when.connectionId);
    if (!row) throw badRequest('Connect a mail account in Settings → Connections first.');
    if (row.status !== 'active')
      throw badRequest(`${row.email} needs you to sign in again in Settings → Connections first.`);
    connection = row.email;
  }
  let recipe = input.when.kind === 'tracker' && words ? { ...input, when: { ...input.when, words } } : input;
  const named = input.when.kind === 'github' ? input.when.repo : input.repo;
  if (named) {
    const [repo] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), sql`lower(${repos.fullName}) = lower(${named})`));
    if (!repo?.enabled)
      throw badRequest(`${named} isn’t one of the repositories on this Whombat. Check its name.`);
    if (input.when.kind === 'github' && repo.source !== 'github')
      throw badRequest(
        `${repo.fullName} is kept on this Whombat, not on GitHub, so it has no issues or pull requests to start from.`,
      );
    recipe =
      recipe.when.kind === 'github'
        ? { ...recipe, when: { ...recipe.when, repo: repo.fullName } }
        : { ...recipe, repo: repo.fullName };
  }
  const file = buildRecipe(recipe, {
    agent: agent.name,
    room: label,
    ...(connection ? { connection } : {}),
  });
  return { file, grants: recipeGrants(recipe) };
}

/**
 * The keys a recipe's automation needs (AR-03, AR-32, AR-44): “Comment on pull requests” for “Also answer on GitHub”,
 * “Open pull requests” when it fixes bugs, and “Merge into main” when it merges the fix once its checks pass — each at
 * Can, for the recipe's repo only.
 */
function recipeGrants(recipe: AutomationRecipe): AutomationGrant[] {
  const when = recipe.when;
  if (when.kind === 'tracker') {
    // Writing the assessment back needs “Update reports” for its connection (TA-12), replying to the customer
    // “Reply to customers” (TA-27: John wants replies to go out on their own from day one); fixing needs “Open pull
    // requests” for the repository it fixes in (TA-18, AR-36), and merging the fix “Merge into main” (TA-39). All at Can.
    const steps = recipeDefinition(recipe).steps;
    const writes = steps.some((s) => s.kind === 'tracker_update');
    const replies = steps.some((s) => s.kind === 'tracker_reply');
    return [
      ...(writes
        ? [{ keyId: 'report.update' as const, tier: 'can' as const, connections: [when.connectionId] }]
        : []),
      ...(replies
        ? [{ keyId: 'report.reply' as const, tier: 'can' as const, connections: [when.connectionId] }]
        : []),
      ...(recipe.fix && recipe.repo
        ? [{ keyId: 'pr.open' as const, tier: 'can' as const, repos: [recipe.repo] }]
        : []),
      ...(recipe.fix?.merge === 'checks' && recipe.repo
        ? [{ keyId: 'merge.main' as const, tier: 'can' as const, repos: [recipe.repo] }]
        : []),
    ];
  }
  if (when.kind !== 'github') return [];
  return [
    ...(recipe.replyOnGitHub
      ? [{ keyId: 'pr.comment' as const, tier: 'can' as const, repos: [when.repo] }]
      : []),
    ...(recipe.fix ? [{ keyId: 'pr.open' as const, tier: 'can' as const, repos: [when.repo] }] : []),
    ...(recipe.fix?.merge === 'checks'
      ? [{ keyId: 'merge.main' as const, tier: 'can' as const, repos: [when.repo] }]
      : []),
  ];
}

/**
 * A recipe published again (edited in the form, say to start fixing bugs): the keys it needs that the automation holds
 * no row of at all are added (AR-33). A key a person set on the Keys tab — Asks, No, other repos — stays as they set it.
 */
async function addMissingRecipeGrants(
  ctx: ApplyContext,
  row: { id: string; name: string; principalId: string },
  recipe: AutomationRecipe,
): Promise<void> {
  const held = await automationGrants(ctx.tx, row.principalId);
  const missing = recipeGrants(recipe).filter((g) => !held.some((h) => h.keyId === g.keyId));
  if (missing.length && mayPublish(ctx)) await writeGrants(ctx, row, [...held, ...missing]);
}

/**
 * A definition published as the next version and switched on (or off): the callback destinations the person approves
 * with it (BP-C11), the timer, the trigger cursor and the signed `automation.published`. The caller checked the draft.
 */
export async function publishVersion(
  ctx: ApplyContext,
  row: { id: string; name: string; currentVersion: number | null },
  def: AutomationDefinition,
  enable: boolean,
): Promise<number> {
  await ctx.services.newerAutomations.refuse(def);
  const tx = ctx.tx;
  const [currentAuto] = await tx
    .select({ status: automations.status, mailActiveAt: automations.mailActiveAt })
    .from(automations)
    .where(eq(automations.id, row.id));
  const prevDef =
    row.currentVersion !== null
      ? (
          await tx
            .select({ definition: automationVersions.definition })
            .from(automationVersions)
            .where(
              and(eq(automationVersions.automationId, row.id), eq(automationVersions.n, row.currentVersion)),
            )
        )[0]?.definition
      : undefined;
  const prevMailConnections = new Set(
    (prevDef?.triggers ?? []).flatMap((t) => (t.kind === 'mail' ? [t.connectionId] : [])),
  );
  const nextMailConnections = def.triggers.flatMap((t) => (t.kind === 'mail' ? [t.connectionId] : []));
  const prevHadMail = prevMailConnections.size > 0;
  const nextHasMail = nextMailConnections.length > 0;
  // Keep an active mail trigger's activation time across edits to steps/wording while staying enabled on the same
  // mailbox(es); record a fresh activation time when turning on, adding mail, or switching to a new mailbox.
  const sameLiveMail =
    enable &&
    nextHasMail &&
    currentAuto?.status === 'published' &&
    currentAuto.mailActiveAt !== null &&
    nextMailConnections.every((c) => prevMailConnections.has(c));
  const mailActiveAt = !enable || !nextHasMail ? null : sameLiveMail ? currentAuto.mailActiveAt : ctx.now;
  const n = (row.currentVersion ?? 0) + 1;
  const hash = definitionHash(def);
  await tx.insert(automationVersions).values({
    automationId: row.id,
    n,
    definition: def,
    definitionHash: hash,
    publishedById: ctx.actor.id,
    publishedAt: ctx.now,
  });
  // The person publishing a callback approves its destination (BP-C11).
  for (const s of def.steps)
    if (s.kind === 'http_callback')
      await tx
        .insert(automationDestinations)
        .values({ burrowId: ctx.burrow.id, url: s.url, approvedById: ctx.actor.id, approvedAt: ctx.now })
        .onConflictDoNothing();
  await tx
    .update(automations)
    .set({
      currentVersion: n,
      status: enable ? 'published' : 'disabled',
      draftJson: null,
      draftUpdatedAt: ctx.now,
      draftUpdatedById: ctx.actor.id,
      scheduleAnchor: ctx.now,
      mailActiveAt,
      thingActiveAt: enable && def.triggers.some((t) => t.kind === 'thing') ? ctx.now : null,
      nextFireAt: enable ? scheduleNext(def, ctx.now, ctx.now) : null,
      updatedAt: ctx.now,
    })
    .where(eq(automations.id, row.id));
  await ensureCursor(tx, ctx.burrow.id, ctx.now, row.id);
  await ctx.emit({
    type: 'automation.published',
    kind: 'System',
    text: `Published “${row.name}” (version ${n})`,
    where: null,
    payload: {
      automationId: row.id,
      version: n,
      definitionHash: hash,
      enabled: enable,
    },
  });
  const services = ctx.services;
  const touchesMail = prevHadMail || def.triggers.some((t) => t.kind === 'mail');
  const touchesFindMy = [...(prevDef?.triggers ?? []), ...def.triggers].some((t) => t.kind === 'findmy');
  const touchesHome = [...(prevDef?.triggers ?? []), ...def.triggers].some(
    (t) => t.kind === 'home_state' || t.kind === 'protect',
  );
  ctx.after(async () => {
    services.automations.nudge();
    if (touchesMail) services.mailTriggers.nudge();
    // A Find My connection an automation listens to reads at least every 15 minutes from now on, or no longer does.
    if (touchesFindMy) findMyBackgroundFor(services).nudge();
    // Home Assistant's entities it names are followed from now on, or no longer are.
    if (touchesHome) void smartHomeTriggersFor(services).tick();
  });
  return n;
}

export const createAutomation = defineCommand({
  name: 'automation.create',
  schema: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    source: NewAutomationSource,
    /** Publish it and switch it on at once (automation-recipes.md): people who may publish; not for `describe`. */
    publish: z.boolean().default(false),
  }),
  requiredKey: (input) => (input.publish ? MANAGE(input.name ?? 'a new automation', 'publish') : null),
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const src = input.source;
    let name = input.name ?? 'New automation';
    let description = input.description ?? '';
    let draft: JsonObject | null = null;
    let keys: AutomationGrant[] = [];
    if (input.publish) {
      if (src.kind === 'describe')
        throw badRequest('An agent drafts this one first: publish it once you’ve checked the draft.');
      if (!mayPublish(ctx)) throw forbidden('Only you can publish an automation.');
    }
    if (src.kind === 'recipe') {
      const made = await recipeFile(ctx, src.recipe);
      name = input.name ?? made.file.name;
      description = input.description ?? made.file.description;
      draft = made.file.definition as unknown as JsonObject;
      // Its keys come with it only from someone who may set them (people who may publish).
      if (mayPublish(ctx)) keys = made.grants;
    } else if (src.kind === 'blank') {
      draft = {
        version: 1,
        conversationId: src.conversationId,
        triggers: [{ kind: 'manual' }],
        steps: [{ id: 'hello', kind: 'post_message', text: 'Hello from an automation.' }],
      };
    } else if (src.kind === 'template') {
      const params = TemplateParams.safeParse({ ...src.params, template: src.template });
      if (!params.success) throw badRequest('Fill in every field of the template.');
      const file = buildTemplate(params.data);
      name = input.name ?? file.name;
      description = input.description ?? file.description;
      draft = file.definition as unknown as JsonObject;
    } else if (src.kind === 'import') {
      const parsed = parseAutomationExport(src.file);
      if (!parsed.ok)
        throw badRequest(
          `This file isn’t an automation Whombat can import: ${parsed.problems.slice(0, 3).join(' ')}`,
        );
      name = input.name ?? parsed.file.name;
      description = input.description ?? parsed.file.description;
      draft = parsed.file.definition as unknown as JsonObject;
    } else if (!(await automationAgent(tx, ctx.burrow.id)))
      throw badRequest('This Whombat has no agent to ask.');
    // Published at once: only a definition that is valid and whose rooms, agents and URLs check out — refused, not
    // saved as a broken draft.
    let live: AutomationDefinition | null = null;
    if (input.publish) {
      const check = validateDefinition(draft, ctx.now.getTime());
      if (!check.ok) throw badRequest(`Fix it first: ${check.problems.slice(0, 3).join(' ')}`);
      const problems = await referenceProblems(ctx, check.definition, true);
      if (problems.length) throw badRequest(problems.slice(0, 3).join(' '));
      live = check.definition;
    }
    const id = await insertAutomation(ctx, { name, description, draft });
    await ctx.emit({
      type: 'automation.created',
      kind: 'System',
      text: `Created the automation “${cap(name)}”`,
      where: null,
      payload: { automationId: id, source: src.kind },
    });
    if (keys.length) await writeGrants(ctx, await loadAutomationRow(tx, ctx.burrow.id, id), keys);
    if (live) await publishVersion(ctx, { id, name: cap(name), currentVersion: null }, live, true);
    if (src.kind === 'describe') {
      const conversation = await loadConversationRow(tx, src.conversationId);
      if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
      const agent = await automationAgent(tx, ctx.burrow.id);
      if (!agent) throw badRequest('This Whombat has no agent to ask.');
      // The person asks the agent in their own words (a normal mention); the agent can only write the draft. Which
      // draft and which tool are the agent's to know, not the chat's.
      const posted = await postMessage(ctx, {
        conversation,
        text: `Please draft an automation for me: ${src.text}`,
        mentions: [agent.id],
      });
      await briefAgent(ctx, {
        messageId: posted.id,
        agentId: agent.id,
        brief: `Write it with draft_automation (automationId ${id}). ${ctx.actor.shortName} reviews and publishes it.`,
      });
    }
    await publishAutomation(ctx, ctx.burrow.id, id);
    return { automationId: id };
  },
});

export const saveAutomationDraft = defineCommand({
  name: 'automation.save_draft',
  schema: z.object({
    automationId: AutomationId,
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    definition: JsonObjectSchema,
  }),
  async apply(_tx, ctx, input) {
    const row = await loadAutomationRow(ctx.tx, ctx.burrow.id, input.automationId);
    requireDraftEditor(ctx, row);
    await storeDraft(ctx, row.id, input);
    const check = validateDefinition(input.definition);
    await ctx.emit({
      type: 'automation.draft_saved',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        automationId: row.id,
        valid: check.ok,
        ...(check.ok ? { draftHash: definitionHash(check.definition) } : {}),
      },
    });
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id, problems: check.problems };
  },
});

export const discardAutomationDraft = defineCommand({
  name: 'automation.discard_draft',
  schema: z.object({ automationId: AutomationId }),
  async apply(tx, ctx, input) {
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    requireDraftEditor(ctx, row);
    if (!row.currentVersion) throw conflict('This automation has only a draft. Keep editing it instead.');
    await storeDraft(ctx, row.id, { definition: null });
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id };
  },
});

export const MANAGE = (name: string, attempt: string) => ({
  keyId: 'agents.manage' as const,
  attempt: `${attempt} “${name}”`,
  where: null,
});

export async function nameOf(db: Db, burrowId: string, id: string) {
  const [row] = await db
    .select({ name: automations.name })
    .from(automations)
    .where(and(eq(automations.burrowId, burrowId), eq(automations.id, id)));
  return row?.name ?? 'an automation';
}

export const publishAutomationDraft = defineCommand({
  name: 'automation.publish',
  schema: z.object({
    automationId: AutomationId,
    enable: z.boolean().default(true),
    /** `definitionHash` of the draft the person reviewed: publishing is bound to exactly that draft (BP-C21). */
    definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  async requiredKey(input, { db, burrow }) {
    return MANAGE(await nameOf(db, burrow.id, input.automationId), 'publish');
  },
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const [row] = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.burrowId, ctx.burrow.id), eq(automations.id, input.automationId)))
      .for('update');
    if (!row || row.deletedAt) throw notFound('Automation');
    if (!row.draftJson) throw conflict('There is no draft to publish.');
    const check = validateDefinition(row.draftJson, ctx.now.getTime());
    if (!check.ok) throw badRequest(`Fix the draft first: ${check.problems.slice(0, 3).join(' ')}`);
    const def = check.definition;
    if (definitionHash(def) !== input.definitionHash)
      throw conflict('The draft changed since you looked at it. Check it again, then publish.');
    const problems = await referenceProblems(ctx, def, true);
    if (problems.length) throw badRequest(problems.slice(0, 3).join(' '));
    // A recipe edited to another channel gets the keys it needs that it holds none of (AR-33).
    const recipe = recipeOf(def);
    if (recipe) await addMissingRecipeGrants(ctx, row, recipe);
    const n = await publishVersion(ctx, row, def, input.enable);
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id, version: n };
  },
});

/**
 * An automation that still has exactly an earlier version's own words takes today's: a
 * new version of the same recipe, on, off or with its timer as it was, its publisher unchanged — what it runs keeps
 * running with that person's authority. Committed as the automation itself, after an update of Whombat. One whose words
 * anyone changed, or that someone is editing (a draft), is left alone.
 */
export const updateAutomationWords = defineCommand({
  name: 'automation.words_updated',
  schema: z.object({ automationId: AutomationId }),
  async apply(tx, ctx, input): Promise<{ version: number | null }> {
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    if (ctx.actor.id !== row.principalId)
      throw forbidden('Only the automation itself takes Whombat’s new words.');
    if (!row.currentVersion || row.draftJson) return { version: null };
    const [current] = await tx
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, row.id), eq(automationVersions.n, row.currentVersion)));
    if (!current || !recipeHasEarlierWords(current.definition)) return { version: null };
    const def = recipeWithTodaysWords(current.definition);
    if (!def) return { version: null };
    const n = row.currentVersion + 1;
    const hash = definitionHash(def);
    await tx.insert(automationVersions).values({
      automationId: row.id,
      n,
      definition: def,
      definitionHash: hash,
      publishedById: current.publishedById,
      publishedAt: ctx.now,
    });
    await tx
      .update(automations)
      .set({ currentVersion: n, updatedAt: ctx.now })
      .where(eq(automations.id, row.id));
    await ctx.emit({
      type: 'automation.published',
      kind: 'System',
      text: `Updated “${row.name}” to this version’s wording (version ${n})`,
      where: null,
      payload: {
        automationId: row.id,
        version: n,
        definitionHash: hash,
        enabled: row.status === 'published',
        previousVersion: current.n,
        previousPublisherId: current.publishedById,
        words: true,
      },
    });
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { version: n };
  },
});

/**
 * A repository GitHub renamed (github/rename.ts) is renamed in the automation too: its current version, and a draft
 * someone is writing, name the new one. Like new wording, it is a new version committed as the automation itself, still
 * published by whoever published it, so nobody has to publish it again and a recipe's steps stay today's.
 */
export const renameAutomationRepo = defineCommand({
  name: 'automation.repo_renamed',
  schema: z.object({ automationId: AutomationId, from: RepoFullName, to: RepoFullName }),
  async apply(tx, ctx, input): Promise<{ version: number | null }> {
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    if (ctx.actor.id !== row.principalId)
      throw forbidden('Only the automation itself takes a repository’s new name.');
    if (row.draftJson) {
      const draft = renameRepoInJson(row.draftJson, input.from, input.to);
      if (draft !== row.draftJson)
        await tx.update(automations).set({ draftJson: draft }).where(eq(automations.id, row.id));
    }
    if (!row.currentVersion) return { version: null };
    const [current] = await tx
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, row.id), eq(automationVersions.n, row.currentVersion)));
    if (!current) return { version: null };
    const renamed = renameRepoInJson(current.definition, input.from, input.to);
    if (renamed === current.definition) return { version: null };
    // Its shape only, as with new wording: the rename itself adds no problem, and an older one mustn't keep the old name.
    const parsed = AutomationDefinitionSchema.safeParse(renamed);
    if (!parsed.success) throw badRequest('The renamed automation isn’t valid.');
    const def = parsed.data;
    const n = row.currentVersion + 1;
    const hash = definitionHash(def);
    await tx.insert(automationVersions).values({
      automationId: row.id,
      n,
      definition: def,
      definitionHash: hash,
      publishedById: current.publishedById,
      publishedAt: ctx.now,
    });
    await tx
      .update(automations)
      .set({ currentVersion: n, updatedAt: ctx.now })
      .where(eq(automations.id, row.id));
    await ctx.emit({
      type: 'automation.published',
      kind: 'System',
      text: `Updated “${row.name}” to ${input.to}, the repository’s new name on GitHub (version ${n})`,
      where: null,
      payload: {
        automationId: row.id,
        version: n,
        definitionHash: hash,
        enabled: row.status === 'published',
        previousVersion: current.n,
        previousPublisherId: current.publishedById,
        repoRenamed: { from: input.from, to: input.to },
      },
    });
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { version: n };
  },
});

export const setAutomationEnabled = defineCommand({
  name: 'automation.set_enabled',
  schema: z.object({ automationId: AutomationId, enabled: z.boolean() }),
  async requiredKey(input, { db, burrow }) {
    return MANAGE(
      await nameOf(db, burrow.id, input.automationId),
      input.enabled ? 'switch on' : 'switch off',
    );
  },
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    if (!row.currentVersion) throw conflict('Publish it first.');
    const [current] = await tx
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, row.id), eq(automationVersions.n, row.currentVersion)));
    if (!current) throw notFound('Automation version');
    const def = current.definition;
    if (input.enabled) await ctx.services.newerAutomations.refuse(def);
    const watchesMail = def.triggers.some((t) => t.kind === 'mail');
    const watchesThings = def.triggers.some((t) => t.kind === 'thing');
    const watchesFindMy = def.triggers.some((t) => t.kind === 'findmy');
    const watchesHome = def.triggers.some((t) => t.kind === 'home_state' || t.kind === 'protect');
    // Switching on someone else's automation makes you its publisher (SUB-31): what it runs from now on runs with your
    // authority and for you, never again on the person who switched it off (to stop spending, say). Published as a
    // new version of the same definition, checked and signed the way publishing is.
    if (input.enabled && row.status !== 'published' && current.publishedById !== ctx.actor.id) {
      const problems = await referenceProblems(ctx, def, true);
      if (problems.length) throw badRequest(problems.slice(0, 3).join(' '));
      const n = row.currentVersion + 1;
      await tx.insert(automationVersions).values({
        automationId: row.id,
        n,
        definition: def,
        definitionHash: current.definitionHash,
        publishedById: ctx.actor.id,
        publishedAt: ctx.now,
      });
      await tx
        .update(automations)
        .set({
          currentVersion: n,
          status: 'published',
          scheduleAnchor: ctx.now,
          mailActiveAt: watchesMail ? ctx.now : null,
          thingActiveAt: watchesThings ? ctx.now : null,
          nextFireAt: scheduleNext(def, ctx.now, ctx.now),
          updatedAt: ctx.now,
        })
        .where(eq(automations.id, row.id));
      await ensureCursor(tx, ctx.burrow.id, ctx.now, row.id);
      await ctx.emit({
        type: 'automation.published',
        kind: 'System',
        text: `Switched on “${row.name}” and published it as version ${n}`,
        where: null,
        payload: {
          automationId: row.id,
          version: n,
          definitionHash: current.definitionHash,
          enabled: true,
          previousVersion: current.n,
          previousPublisherId: current.publishedById,
        },
      });
      await publishAutomation(ctx, ctx.burrow.id, row.id);
      const services = ctx.services;
      ctx.after(async () => {
        services.automations.nudge();
        if (watchesMail) services.mailTriggers.nudge();
        if (watchesFindMy) findMyBackgroundFor(services).nudge();
        if (watchesHome) void smartHomeTriggersFor(services).tick();
      });
      return { automationId: row.id };
    }
    const nextMailActiveAt =
      !input.enabled || !watchesMail
        ? null
        : row.status === 'published' && row.mailActiveAt
          ? row.mailActiveAt
          : ctx.now;
    await tx
      .update(automations)
      .set({
        status: input.enabled ? 'published' : 'disabled',
        scheduleAnchor: input.enabled ? ctx.now : row.scheduleAnchor,
        mailActiveAt: nextMailActiveAt,
        thingActiveAt: !input.enabled || !watchesThings ? null : (row.thingActiveAt ?? ctx.now),
        nextFireAt: input.enabled ? scheduleNext(def, ctx.now, ctx.now) : null,
        updatedAt: ctx.now,
      })
      .where(eq(automations.id, row.id));
    if (input.enabled) await ensureCursor(tx, ctx.burrow.id, ctx.now, row.id);
    await ctx.emit({
      type: input.enabled ? 'automation.enabled' : 'automation.disabled',
      kind: 'System',
      text: `${input.enabled ? 'Switched on' : 'Switched off'} “${row.name}”`,
      where: null,
      payload: { automationId: row.id, version: row.currentVersion },
    });
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    // Its first fire (or the events it reads) on time, not at the engine's next safety tick (SV-03).
    const services = ctx.services;
    if (input.enabled || watchesMail || watchesFindMy || watchesHome) {
      ctx.after(async () => {
        if (input.enabled) services.automations.nudge();
        if (watchesMail) services.mailTriggers.nudge();
        if (watchesFindMy) findMyBackgroundFor(services).nudge();
        if (watchesHome) void smartHomeTriggersFor(services).tick();
      });
    }
    return { automationId: row.id };
  },
});

export const setAutomationKeys = defineCommand({
  name: 'automation.set_keys',
  schema: z.object({ automationId: AutomationId, grants: z.array(AutomationGrant).max(10) }),
  async requiredKey(input, { db, burrow }) {
    return MANAGE(await nameOf(db, burrow.id, input.automationId), 'change the keys of');
  },
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    await checkGrantConnections(ctx, input.grants);
    await writeGrants(ctx, row, input.grants);
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id };
  },
});

export const setAutomationWebhook = defineCommand({
  name: 'automation.webhook',
  schema: z.object({
    automationId: AutomationId,
    enabled: z.boolean(),
    rotateSecret: z.boolean().default(false),
  }),
  async requiredKey(input, { db, burrow }) {
    return {
      keyId: 'burrow.manage' as const,
      attempt: `change the webhook of “${await nameOf(db, burrow.id, input.automationId)}”`,
      where: null,
    };
  },
  async apply(tx, ctx, input): Promise<{ automationId: string; secret: string | null }> {
    requirePerson(ctx);
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    let secret: string | null = null;
    let sealed = row.webhookSecretEnc;
    if (input.rotateSecret || (input.enabled && !sealed)) {
      secret = newSecret('whk');
      sealed = ctx.services.custody.seal(webhookSecretAad(row.id), secret);
    }
    await tx
      .update(automations)
      .set({ webhookEnabled: input.enabled, webhookSecretEnc: sealed, updatedAt: ctx.now })
      .where(eq(automations.id, row.id));
    await ctx.emit({
      type: 'automation.webhook',
      kind: 'Keys',
      text: `${input.enabled ? 'Turned on' : 'Turned off'} the webhook of “${row.name}”${secret ? ' with a new secret' : ''}`,
      where: null,
      payload: { automationId: row.id, enabled: input.enabled, rotated: !!secret },
    });
    await publishAutomation(ctx, ctx.burrow.id, row.id);
    return { automationId: row.id, secret };
  },
});

export const runAutomationNow = defineCommand({
  name: 'automation.run_now',
  // Automations are paused while the licence is lapsed (LC-10), test runs too.
  licence: 'agentTurn',
  schema: z.object({
    automationId: AutomationId,
    test: z.boolean().default(false),
    text: z.string().max(2000).optional(),
    /**
     * A test run as if this issue or pull request had just arrived (automation-recipes.md), or (report-trackers.md
     * TA-19) this report of the tracker trigger's connection.
     */
    sample: z
      .union([z.object({ number: z.number().int().positive() }), z.object({ reportId: z.string() })])
      .optional(),
    /** Set by the route only: the sample as GitHub has it now (read before the commit, `fetchGitHubItem`). */
    sampleItem: GitHubItem.optional(),
    /** Set by the route only: the report as its tracker has it now (read before the commit, TA-19). */
    sampleReport: TrackerRunItemSchema.optional(),
  }),
  async requiredKey(input, { db, burrow }) {
    return MANAGE(await nameOf(db, burrow.id, input.automationId), input.test ? 'test-run' : 'run');
  },
  async apply(tx, ctx, input) {
    requirePerson(ctx);
    const row = await loadAutomationRow(tx, ctx.burrow.id, input.automationId);
    let def: AutomationDefinition;
    let version: number;
    let publishedById: string;
    if (input.test && row.draftJson) {
      const check = validateDefinition(row.draftJson, ctx.now.getTime());
      if (!check.ok) throw badRequest(`Fix the draft first: ${check.problems.slice(0, 3).join(' ')}`);
      const problems = await referenceProblems(ctx, check.definition, true);
      if (problems.length) throw badRequest(problems.slice(0, 3).join(' '));
      def = check.definition;
      version = 0;
      publishedById = ctx.actor.id;
    } else {
      if (!row.currentVersion) throw conflict('Publish it first, or test-run the draft.');
      const [v] = await tx
        .select()
        .from(automationVersions)
        .where(
          and(eq(automationVersions.automationId, row.id), eq(automationVersions.n, row.currentVersion)),
        );
      if (!v) throw notFound('Automation version');
      def = v.definition;
      version = v.n;
      // A test run acts with the authority of the person testing it; Run now with the publisher's.
      publishedById = input.test ? ctx.actor.id : v.publishedById;
      // Run now stands in for a trigger only when the automation is meant to be started by hand (BP-C19); an
      // automation that starts on its own can be tried with a test run.
      if (!input.test && !def.triggers.some((t) => t.kind === 'manual'))
        throw conflict('This automation starts on its own. Try it with a test run instead.');
    }
    await ctx.services.newerAutomations.refuse(def);
    // A run acts in the rooms its definition names: each must still be the burrow's (BP-C19).
    await requireRoomsHere(ctx, def);
    // A test run on a sample (“Try it on …”): `trigger.*` as a real event about that issue or pull request fills it,
    // in a thread of its own.
    const sample = input.sample ? sampleRun(def, input) : null;
    const runId = await createRun(ctx, {
      automation: row,
      definition: def,
      version,
      publishedById,
      trigger: {
        kind: sample?.kind ?? 'manual',
        summary: sample?.summary ?? `${input.test ? 'Test run' : 'Run'} by ${ctx.actor.shortName}`,
        actorId: ctx.actor.id,
        eventId: null,
        messageId: null,
        scheduledFor: null,
      },
      triggerKey: `manual:${newId('event')}`,
      scope: sample?.scope ?? { text: input.text ?? '', kind: 'manual', authorId: ctx.actor.id },
      conversationId: def.conversationId,
      threadRootId: null,
      causalDepth: 0,
      causalChain: [],
      startedById: ctx.actor.id,
      test: input.test,
    });
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { runId };
  },
});

/**
 * A test run's sample (automation-recipes.md): only for test runs of an automation that starts from GitHub, with the
 * issue or pull request the route read from the trigger's repo; the scope a real event about it would give.
 */
function sampleRun(
  def: AutomationDefinition,
  input: {
    test: boolean;
    sample?: { number: number } | { reportId: string } | undefined;
    sampleItem?: GitHubItem | undefined;
    sampleReport?: TrackerRunItem | undefined;
  },
): { scope: JsonObject; summary: string; kind: 'github' | 'tracker' } {
  if (!input.test) throw badRequest('Try it on an issue or pull request with a test run.');
  if (input.sample && 'reportId' in input.sample) {
    // A tracker report (report-trackers.md TA-19): the scope a mirrored report would give, read live by the route.
    const report = input.sampleReport;
    const trigger = def.triggers.find((t) => t.kind === 'tracker');
    if (!trigger) throw badRequest('This automation doesn’t start from a tracker’s reports.');
    if (!report || report.reportId !== input.sample.reportId || report.connectionId !== trigger.connectionId)
      throw conflict('That report couldn’t be read from its tracker. Try again.');
    return {
      scope: trackerItemScope(report),
      summary: `Tried on ${report.connection} #${report.number}`,
      kind: 'tracker',
    };
  }
  const item = input.sampleItem;
  const repo = def.triggers.find((t) => t.kind === 'github')?.repo;
  if (!repo) throw badRequest('This automation doesn’t start from GitHub.');
  const number = input.sample && 'number' in input.sample ? input.sample.number : null;
  if (!item || item.number !== number || item.repo.toLowerCase() !== repo.toLowerCase())
    throw conflict('That issue or pull request couldn’t be read from GitHub. Try again.');
  const trigger = sampleTrigger(def, item.item);
  if (!trigger)
    throw badRequest(
      item.item === 'issue'
        ? `#${item.number} is an issue, and this automation starts from pull requests.`
        : `#${item.number} is a pull request, and this automation starts from issues.`,
    );
  return {
    scope: githubItemScope(trigger.event, item, { checksState: trigger.checksState ?? null }),
    summary: `Tried on ${itemRef(item)}`,
    kind: 'github',
  };
}

const RunRef = z.object({ number: NumberParam });

async function runByNumber(tx: Tx, burrowId: string, number: number) {
  const [row] = await tx
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.burrowId, burrowId), eq(automationRuns.number, number)));
  if (!row) throw notFound('Automation run');
  return row;
}

async function controllable(ctx: ApplyContext, number: number) {
  requirePerson(ctx);
  return runByNumber(ctx.tx, ctx.burrow.id, number);
}

/** Stops the dispatches of a run's waiting steps: the runner stops the turn at its next beat. */
export async function cancelRunDispatches(
  tx: Tx,
  runId: string,
  now: Date,
  session?: Pick<TxSession, 'publish'>,
): Promise<void> {
  const waiting = await tx
    .select({ dispatchId: automationRunSteps.dispatchId })
    .from(automationRunSteps)
    .where(and(eq(automationRunSteps.runId, runId), sql`${automationRunSteps.dispatchId} is not null`));
  for (const { dispatchId } of waiting) {
    if (!dispatchId) continue;
    const cancelled = await tx
      .update(dispatches)
      .set({ state: 'cancelled', cancelReason: 'cancelled', error: 'automation_cancelled', finishedAt: now })
      .where(and(eq(dispatches.id, dispatchId), sql`${dispatches.state} in ('queued', 'claimed', 'running')`))
      .returning();
    if (session) for (const d of cancelled) publishDispatch(session, d);
  }
}

/**
 * What cancelling a run does after its status: its agent turns stop, its unfinished steps are cancelled, and the thread
 * it started from hears it stopped (BP-C28), from the automation itself, in this commit.
 */
async function stopRunTail(ctx: ApplyContext, run: AutomationRunRow, reason: string): Promise<void> {
  const tx = ctx.tx;
  await cancelRunDispatches(tx, run.id, ctx.now, ctx);
  // A feature request it waited on no longer waits (report-trackers.md TA-44).
  await stopRunRequests(ctx, run.id);
  await tx
    .update(automationRunSteps)
    .set({ state: 'cancelled', finishedAt: ctx.now, updatedAt: ctx.now })
    .where(
      and(
        eq(automationRunSteps.runId, run.id),
        sql`${automationRunSteps.state} in ('pending', 'running', 'waiting', 'uncertain')`,
      ),
    );
  const [automation] = await tx.select().from(automations).where(eq(automations.id, run.automationId));
  const principal = automation ? await loadPrincipalRow(tx, automation.principalId) : undefined;
  if (automation && principal)
    await postRunNotice(
      applyContext(ctx, { ...ctx, actor: toActor(principal), decision: null, requirement: null }),
      run,
      automation.name,
      'cancelled',
      reason,
    );
}

/**
 * Cancels a run still in progress for a reason of Whombat's own, as Cancel does: its agents' turns stop, its unfinished
 * steps are cancelled, its thread hears why (`reason`), and it is signed and published. `payload` adds to the signed
 * event's. The caller checked the run is active and locked it.
 */
export async function cancelRunFor(
  ctx: ApplyContext,
  run: AutomationRunRow,
  reason: string,
  payload: Record<string, string | number | boolean> = {},
): Promise<void> {
  await ctx.tx
    .update(automationRuns)
    .set({
      status: 'cancelled',
      finishedAt: ctx.now,
      error: reason,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: ctx.now,
    })
    .where(eq(automationRuns.id, run.id));
  await stopRunTail(ctx, run, reason);
  await ctx.emit({
    type: 'automation.run.cancelled',
    kind: 'System',
    text: `Cancelled automation run #${run.number}`,
    where: null,
    payload: { automationId: run.automationId, runId: run.id, number: run.number, ...payload },
  });
  await publishRun(ctx, run.id);
}

/**
 * Deletes an automation (automation-recipes.md, contracts `automations.delete`): it stops at once — runs in progress are
 * cancelled as Cancel does (their agents' turns stop), it is switched off, its webhook goes off and its secret and keys
 * go — and it leaves every list (`automation.deleted`). Its runs and everything it signed stay; it never runs again.
 * People who may publish, or whoever started a draft that was never published.
 */
/**
 * An automation deleted (automation-recipes.md): runs in progress cancelled, switched off, its keys gone, signed and
 * announced; the cards of its plans say so (automation-chat.md). The caller checked who may. Returns how many runs
 * it cancelled.
 */
export async function removeAutomation(
  ctx: ApplyContext,
  row: typeof automations.$inferSelect,
): Promise<number> {
  const tx = ctx.tx;
  const reason = `${row.name} was deleted by ${ctx.actor.shortName}.`;
  const active = await tx
    .select()
    .from(automationRuns)
    .where(
      and(eq(automationRuns.automationId, row.id), inArray(automationRuns.status, [...ACTIVE_RUN_STATUSES])),
    );
  for (const run of active) await cancelRunFor(ctx, run, reason, { deleted: true });
  await tx
    .update(automations)
    .set({
      deletedAt: ctx.now,
      status: row.status === 'published' ? 'disabled' : row.status,
      mailActiveAt: null,
      nextFireAt: null,
      webhookEnabled: false,
      webhookSecretEnc: null,
      updatedAt: ctx.now,
    })
    .where(eq(automations.id, row.id));
  await tx.delete(grants).where(eq(grants.agentId, row.principalId));
  await ctx.emit({
    type: 'automation.deleted',
    kind: 'System',
    text: `Deleted the automation “${row.name}”`,
    where: null,
    aboutId: row.principalId,
    payload: { automationId: row.id, cancelledRuns: active.length, version: row.currentVersion },
  });
  ctx.publish(topics.burrow(ctx.burrow.id), { type: 'automation.deleted', automationId: row.id });
  await republishPlanCards(ctx, row.id);
  const services = ctx.services;
  ctx.after(async () => {
    services.mailTriggers.nudge();
    findMyBackgroundFor(services).nudge();
    void smartHomeTriggersFor(services).tick();
  });
  return active.length;
}

export const deleteAutomation = defineCommand({
  name: 'automation.delete',
  schema: z.object({ automationId: AutomationId }),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.burrowId, ctx.burrow.id), eq(automations.id, input.automationId)))
      .for('update');
    if (!row || row.deletedAt) throw notFound('Automation');
    requireDeleter(ctx, row);
    const cancelledRuns = await removeAutomation(ctx, row);
    return { id: row.id, cancelledRuns };
  },
});

export const controlAutomationRun = defineCommand({
  name: 'automation.control_run',
  schema: RunRef.extend({ action: z.enum(['pause', 'resume', 'cancel']) }),
  async apply(tx, ctx, input) {
    const run = await controllable(ctx, input.number);
    const finished = ['succeeded', 'failed', 'cancelled', 'skipped'].includes(run.status);
    if (finished) throw conflict('This run has finished.');
    if (input.action === 'pause' && run.status === 'paused') throw conflict('It is paused already.');
    if (input.action === 'resume' && run.status !== 'paused') throw conflict('It isn’t paused.');
    const status = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'running' : 'cancelled';
    await tx
      .update(automationRuns)
      .set({
        status,
        updatedAt: ctx.now,
        ...(status === 'cancelled'
          ? { finishedAt: ctx.now, error: `Cancelled by ${ctx.actor.shortName}.` }
          : {}),
      })
      .where(eq(automationRuns.id, run.id));
    if (status === 'cancelled') await stopRunTail(ctx, run, `Cancelled by ${ctx.actor.shortName}.`);
    await ctx.emit({
      type: `automation.run.${input.action === 'cancel' ? 'cancelled' : input.action === 'pause' ? 'paused' : 'resumed'}`,
      kind: 'System',
      text: `${input.action === 'cancel' ? 'Cancelled' : input.action === 'pause' ? 'Paused' : 'Resumed'} automation run #${run.number}`,
      where: null,
      payload: { automationId: run.automationId, runId: run.id, number: run.number },
    });
    await publishRun(ctx, run.id);
    await publishAutomation(ctx, ctx.burrow.id, run.automationId);
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { runId: run.id };
  },
});

export const reviewAutomationStep = defineCommand({
  name: 'automation.review_step',
  schema: RunRef.extend({ stepId: AutomationStepId, resolution: z.enum(['done', 'failed', 'retry']) }),
  requiredKey: (input) => ({
    keyId: 'agents.manage' as const,
    attempt: `settle a step of automation run #${input.number}`,
    where: null,
  }),
  async apply(tx, ctx, input) {
    const run = await controllable(ctx, input.number);
    const [step] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.stepId, input.stepId)));
    if (!step) throw notFound('Step');
    if (step.state !== 'uncertain') throw conflict('Only a step whose outcome is uncertain needs settling.');
    const state =
      input.resolution === 'done' ? 'succeeded' : input.resolution === 'failed' ? 'failed' : 'pending';
    await tx
      .update(automationRunSteps)
      .set({
        state,
        attempt: input.resolution === 'retry' ? step.attempt + 1 : step.attempt,
        finishedAt: state === 'pending' ? null : ctx.now,
        wakeAt: null,
        error: input.resolution === 'failed' ? `${ctx.actor.shortName} said it didn’t happen.` : step.error,
        output: { ...(step.output as JsonObject), reviewedBy: ctx.actor.id, resolution: input.resolution },
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, step.idx)));
    await tx
      .update(automationRuns)
      .set({
        status: 'running',
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, 'needs_review')));
    await ctx.emit({
      type: 'automation.step.reviewed',
      kind: 'System',
      text: `Settled step “${step.name}” of automation run #${run.number}: ${
        input.resolution === 'done'
          ? 'it happened'
          : input.resolution === 'failed'
            ? 'it didn’t happen'
            : 'try again'
      }`,
      where: null,
      payload: { runId: run.id, stepId: step.stepId, resolution: input.resolution },
    });
    await publishRun(ctx, run.id);
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { runId: run.id };
  },
});

/** Maximum kept length of `steps.fix.output.reply` after appending a follow-up note. */
const FIX_REPLY_NOTE_MAX = 12_000;

/**
 * Resumes a finished report automation run in the current thread whose fix started but did not land yet, from the
 * requested step (or the earliest incomplete step at or after `fix`). Only callable from a person's turn in that
 * run's thread — never from outsiders' turns or automation steps.
 */
export const continueAutomationRun = defineCommand({
  name: 'automation.continue_run',
  schema: z.object({
    runId: AutomationRunId,
    dispatchId: DispatchId,
    fromStepId: z.enum(['fix', 'review', 'pr', 'merge']).optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  }),
  async apply(tx, ctx, input) {
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.burrowId, ctx.burrow.id)));
    if (!dispatch || dispatch.agentId !== ctx.actor.id) throw notFound('Turn');
    if (dispatch.trigger === 'automation' || outsidersTurn(dispatch) || !dispatch.threadRootId)
      throw forbidden('Only a person’s turn in the report’s thread can continue an unlanded run.');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.id, input.runId), eq(automationRuns.burrowId, ctx.burrow.id)))
      .for('update');
    if (!run) throw notFound('Automation run');
    if (run.conversationId !== dispatch.conversationId || run.threadRootId !== dispatch.threadRootId)
      throw forbidden('You can only continue the report run of this thread.');
    const [automation] = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.id, run.automationId), eq(automations.burrowId, ctx.burrow.id)));
    if (!automation || automation.deletedAt) throw conflict('This automation was deleted.');
    const [version] = await tx
      .select()
      .from(automationVersions)
      .where(
        and(eq(automationVersions.automationId, run.automationId), eq(automationVersions.n, run.version)),
      );
    if (!version) throw conflict('This automation’s version is gone.');
    const who = await publisherCheck(tx, run.burrowId, version.publishedById);
    if (!who.ok) throw forbidden('The person who turned this automation on can no longer run it.');
    if (!scopeReport(run.scope)) throw conflict('Only a report automation run can be continued this way.');
    if (run.status !== 'succeeded' && run.status !== 'failed')
      throw conflict('Only a finished unlanded report run can be continued.');
    const [landed] = await tx
      .select({ id: trackerFixes.id })
      .from(trackerFixes)
      .where(
        and(
          eq(trackerFixes.runId, run.id),
          inArray(trackerFixes.state, ['merged', 'development', 'live', 'confirmed']),
        ),
      )
      .limit(1);
    if (landed) throw conflict('This report’s fix is already merged.');
    const stepRows = await loadStepRows(tx, run.id);
    const why = unlandedReason(run.definition.steps, stepRows, run.status);
    if (!why?.fix) throw conflict('This run has no unlanded fix to continue.');
    const fixRow = stepRows.find((s) => s.stepId === 'fix');
    if (!fixRow) throw conflict('This run has no fix step.');
    const chosenId = input.fromStepId ?? nextContinueStepId(run.definition.steps, stepRows);
    const fromRow = chosenId ? stepRows.find((s) => s.stepId === chosenId && s.idx >= fixRow.idx) : undefined;
    if (!fromRow)
      throw badRequest(`This run has no "${input.fromStepId ?? 'review'}" step at or after its fix step.`);
    // Past a review that asked for changes nothing can land: the merge reads that verdict and leaves the pull request
    // for the person, so the run would only stop again one step later. Past one that never finished the merge would
    // have no review to go by. The turn hears it instead of promising a merge. A review step that gives no verdict
    // (a definition of the person's own) holds nothing back.
    const reviewRow = stepRows.find((s) => s.stepId === 'review' && s.idx > fixRow.idx);
    if (
      reviewRow &&
      fromRow.idx > reviewRow.idx &&
      reviewRow.state !== 'skipped' &&
      (reviewRow.state !== 'succeeded' ||
        (reviewRow.output as { verdict?: unknown } | null)?.verdict === 'changes_needed')
    )
      throw conflict(
        'This run’s review hasn’t approved the fix, and Whombat merges nothing past it. Continue from "review" so it reads the newest review; if the person wants it merged without that, they merge the pull request themselves.',
      );
    // When resuming after `fix`, append the follow-up note to `steps.fix.output.reply` so `review` and `pr` see what
    // changed in the follow-up (the server still verifies the reviewer and GitHub branch head independently). After a
    // person looked, the count of tries the engine makes by itself starts over (`again.ts`), and the review's one
    // re-read of an unread reviewer is this restart's too.
    const restart: AgainMark | null =
      reviewRow && reviewRow.idx >= fromRow.idx ? { tries: 1, reviewAttempt: reviewRow.attempt + 1 } : null;
    const written = await resetStepsFrom(tx, run.id, stepRows, fromRow.idx, ctx.now);
    const { again: _tries, ...prevOut } =
      fromRow.idx > fixRow.idx
        ? ((fixRow.output ?? {}) as JsonObject)
        : (written.get(fixRow.idx) ?? resetOutput(fixRow.output));
    const prevReply = typeof prevOut.reply === 'string' ? prevOut.reply.trim() : '';
    const combined =
      input.note && fromRow.idx > fixRow.idx
        ? prevReply
          ? `${prevReply}\n\nFollow-up:\n${input.note}`
          : input.note
        : null;
    await tx
      .update(automationRunSteps)
      .set({
        output: {
          ...prevOut,
          ...(combined ? { reply: combined.slice(0, FIX_REPLY_NOTE_MAX) } : {}),
          ...(restart ? { again: { ...restart } } : {}),
        },
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, fixRow.idx)));
    const deadlineAt = new Date(ctx.now.getTime() + run.definition.limits.runTimeoutMinutes * 60_000);
    await tx
      .update(automationRuns)
      .set({
        status: 'running',
        finishedAt: null,
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        deadlineAt,
        updatedAt: ctx.now,
      })
      .where(eq(automationRuns.id, run.id));
    await ctx.emit({
      type: 'automation.run.resumed',
      kind: 'System',
      text: `Continued automation run #${run.number} from step “${fromRow.name}”`,
      where: null,
      payload: {
        automationId: run.automationId,
        runId: run.id,
        number: run.number,
        fromStepId: fromRow.stepId,
      },
    });
    await publishRun(ctx, run.id);
    await publishAutomation(ctx, ctx.burrow.id, run.automationId);
    const services = ctx.services;
    ctx.after(async () => services.automations.nudge());
    return { runId: run.id, fromStepId: fromRow.stepId, status: 'running' as const };
  },
});

export const AUTOMATION_COMMANDS = [
  createAutomation,
  saveAutomationDraft,
  discardAutomationDraft,
  deleteAutomation,
  publishAutomationDraft,
  setAutomationEnabled,
  setAutomationKeys,
  setAutomationWebhook,
  runAutomationNow,
  controlAutomationRun,
  continueAutomationRun,
  reviewAutomationStep,
  proposeConnectionActions,
];
