/**
 * Device skills (docs/decisions/one-whombat.md ONE-16…ONE-18; one-whombat-devices.md ONE-DD06…DD08): Whombat proposes a
 * tested profile as a `device_skill` card; the person chooses each action's tier and limits and presses Switch on, which
 * makes (or updates) the burrow's `device` connection with one tool per action.
 *
 * - **Propose** (`device_skill.propose`, the agent's): the profile and what the read-only test read (the MCP tool reads
 *   the device before it commits) become a proposal and a card in the chat. An earlier proposal for the same device that
 *   nobody switched on is replaced (its card reads as not switched on), so a rewritten profile starts again from the
 *   defaults (ONE-18).
 * - **Decide** (`device_skill.decide`, `deviceSkills.decide`; the person, `burrow.manage`): the choices are checked
 *   against the profile (keys, limits that fit the action) and kept with the proposal. `switchOn` makes the connection
 *   live: a new `device` connection, or the device's existing one with this profile's tools (same id: its page, widgets
 *   and history stay). A skill already on takes new choices at once either way (tightening must count straight away).
 * - **Decline** (`device_skill.decline`): Not now; nothing is made.
 */
import {
  ConversationId,
  canonicalJson,
  conversationLabel,
  DEVICE_TIER_LABELS,
  DeviceActionChoice,
  DeviceProfile,
  type DeviceSkillCard,
  DispatchId,
  MessageId,
  newId,
  sha256Hex,
  topics,
} from '@whombat/core';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext, TxSession } from '../commit/types';
import { defineCommand } from '../commit/types';
import { limitsSetProblems, limitText } from '../connections/limits';
import { requireRoom, takenHandles } from '../connections/store';
import type { Tx } from '../db/client';
import { catalogConnections, connectionTools, deviceSkills, messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import type { ReadingResult } from './driver';
import {
  actionRange,
  actionUnit,
  deviceHandleBase,
  deviceNoun,
  deviceSlug,
  deviceToolDefinitions,
  profileHash,
  proposedChoice,
  toolLimitsOf,
} from './profile';
import { DEVICE_CATALOG_ID, type DeviceSkillRow } from './store';
import type { DeviceAction } from './types';

/** Readings the card shows (mock 3: six and “+ 3 more”). */
export const CARD_READINGS = 6;
/** Proposals waiting in one burrow at most. */
export const PROPOSALS_WAITING_MAX = 10;
const WHERE_THINGS = 'Things';

/** A new proposal id (`dvp_…`, contracts' `deviceSkillProposal`). */
export function newProposalId(): string {
  return newId('deviceSkillProposal');
}

/** “Daikin Altherma heat pump” with vendor Daikin and model Altherma → “Heat pump” (the sidebar's name, mock 1). */
export function shortDeviceName(profile: Pick<DeviceProfile, 'name' | 'vendor' | 'model'>): string {
  const drop = new Set(
    [profile.vendor, profile.model]
      .filter((w): w is string => !!w)
      .flatMap((w) => w.toLowerCase().split(/\s+/))
      .filter(Boolean),
  );
  const kept = profile.name.split(/\s+/).filter((w) => !drop.has(w.toLowerCase()));
  const short = kept.join(' ').trim() || profile.name;
  return (short.charAt(0).toUpperCase() + short.slice(1)).slice(0, 80);
}

/** A tested reading as the card shows it: the value without its unit (“21.0” and “°C”). */
function cardReading(r: ReadingResult): DeviceSkillCard['readings'][number] {
  const unit = r.unit && r.text.endsWith(` ${r.unit}`) ? r.unit : r.unit === '%' ? '%' : undefined;
  const value = unit ? r.text.slice(0, r.text.length - (unit === '%' ? 1 : unit.length + 1)) : r.text;
  return { key: r.key, label: r.label, value: value.slice(0, 60), ...(unit ? { unit } : {}) };
}

/** The card of a proposal as it stands. */
export function skillCard(row: DeviceSkillRow): DeviceSkillCard {
  const profile = row.profile;
  const tested = row.tested.filter((r) => r.value !== null);
  const decided = row.choices ?? undefined;
  return {
    kind: 'device_skill',
    proposalId: row.id,
    name: profile.name,
    ...(profile.model || profile.vendor
      ? { model: [profile.vendor, profile.model].filter(Boolean).join(' ').slice(0, 120) }
      : {}),
    readings: tested.slice(0, CARD_READINGS).map(cardReading),
    moreReadings: Math.max(0, tested.length - CARD_READINGS),
    actions: profile.actions.map((a) => {
      const unit = actionUnit(profile, a);
      return {
        key: a.key,
        label: a.label,
        description: a.description.slice(0, 300),
        proposed: decided?.[a.key] ?? proposedChoice(a),
        valueType: a.valueType,
        ...(a.min !== undefined ? { min: a.min } : {}),
        ...(a.max !== undefined ? { max: a.max } : {}),
        ...(unit ? { unit } : {}),
        ...(a.sensitive ? { sensitive: true } : {}),
      };
    }),
    testedAt: row.testedAt.toISOString(),
    // A proposal a newer one replaced reads as not switched on (the card has no other word for it).
    status: row.status === 'replaced' ? 'declined' : row.status,
    ...(decided ? { decided } : {}),
    ...(row.connectionId && row.status === 'on' ? { connectionId: row.connectionId } : {}),
  };
}

/** Puts the proposal's card on its message again and publishes it. */
export async function republish(
  ctx: Pick<TxSession, 'tx' | 'publish'>,
  row: DeviceSkillRow,
  eventId?: string,
): Promise<void> {
  if (!row.messageId) return;
  const [updated] = await ctx.tx
    .update(messages)
    .set({ card: skillCard(row) })
    .where(eq(messages.id, row.messageId))
    .returning();
  if (!updated) return;
  const [loaded] = await loadMessages(ctx.tx, [updated], null);
  if (loaded)
    ctx.publish(
      topics.conversation(updated.conversationId),
      { type: 'message.updated', message: loaded },
      eventId ? { eventId } : {},
    );
}

/* Propose ------------------------------------------------------------------------------------------- */

export const proposeDeviceSkill = defineCommand({
  name: 'device_skill.propose',
  schema: z.object({
    profile: DeviceProfile,
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    unitId: z.number().int().min(0).max(255).nullable(),
    tested: z.custom<ReadingResult[]>((v) => Array.isArray(v)),
    testedAt: z.iso.datetime({ offset: true }),
    conversationId: ConversationId,
    threadRootId: MessageId.nullable().default(null),
    dispatchId: DispatchId.nullable().default(null),
    personId: z.string().nullable().default(null),
  }),
  async apply(tx, ctx, input) {
    const agent = await loadPrincipalRow(tx, ctx.actor.id);
    if (agent?.kind !== 'agent') throw forbidden('Only a person’s assistant proposes device skills.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const waiting = await tx
      .select({ id: deviceSkills.id })
      .from(deviceSkills)
      .where(and(eq(deviceSkills.burrowId, ctx.burrow.id), eq(deviceSkills.status, 'proposed')));
    const device = { host: input.host.toLowerCase(), port: input.port, unitId: input.unitId };
    const earlier = await tx
      .select()
      .from(deviceSkills)
      .where(
        and(
          eq(deviceSkills.burrowId, ctx.burrow.id),
          inArray(deviceSkills.status, ['proposed', 'declined']),
          eq(deviceSkills.host, device.host),
          eq(deviceSkills.port, device.port),
        ),
      );
    const replaced = earlier.filter((r) => r.unitId === device.unitId);
    if (waiting.length - replaced.filter((r) => r.status === 'proposed').length >= PROPOSALS_WAITING_MAX)
      throw conflict(`${PROPOSALS_WAITING_MAX} device skills are waiting for a decision already.`);
    const id = newProposalId();
    const hash = profileHash(input.profile);
    const row: DeviceSkillRow = {
      id,
      burrowId: ctx.burrow.id,
      agentId: agent.id,
      personId: input.personId ?? null,
      conversationId: conversation.id,
      messageId: null,
      name: shortDeviceName(input.profile),
      profile: input.profile,
      profileHash: hash,
      host: device.host,
      port: device.port,
      unitId: device.unitId,
      tested: input.tested,
      testedAt: new Date(input.testedAt),
      status: 'proposed',
      choices: null,
      connectionId: null,
      decidedById: null,
      decidedAt: null,
      lastRead: null,
      lastReadAt: null,
      lastReadError: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    await tx.insert(deviceSkills).values(row);
    // A rewritten profile starts from the defaults (ONE-18): the earlier card for this device steps aside.
    for (const old of replaced) {
      const [gone] = await tx
        .update(deviceSkills)
        .set({ status: 'replaced', updatedAt: ctx.now })
        .where(eq(deviceSkills.id, old.id))
        .returning();
      if (gone) await republish(ctx, gone);
    }
    const posted = await postMessage(ctx, {
      conversation,
      text: 'I can read it now. Pick what I’m allowed to change before I switch that on.',
      card: skillCard(row),
      threadRootId: input.threadRootId,
      dispatch: false,
    });
    await tx.update(deviceSkills).set({ messageId: posted.id }).where(eq(deviceSkills.id, id));
    await ctx.emit({
      type: 'device_skill.proposed',
      kind: 'Keys',
      text: `Proposed a skill for ${deviceNoun(row.name)} (it reads only until someone switches it on)`,
      where: conversation.kind === 'dm' ? 'A DM' : conversationLabel(conversation),
      payload: {
        proposalId: id,
        name: row.name,
        driver: input.profile.driver,
        profileHash: hash,
        readings: input.profile.readings.length,
        actions: input.profile.actions.length,
        messageId: posted.id,
      },
    });
    return { proposalId: id, messageId: posted.id };
  },
});

/* Decide -------------------------------------------------------------------------------------------- */

/** Why a choice doesn't fit its action, or null. */
export function choiceProblem(action: DeviceAction, choice: DeviceActionChoice): string | null {
  const limits = choice.limits;
  if (!limits || Object.keys(limits).length === 0) return null;
  const problems = limitsSetProblems({ args: { '/value': limits } });
  if (problems) return Object.values(problems)[0] ?? 'Those limits don’t work.';
  if (action.valueType === 'number') {
    if (limits.choices) return `${action.label} is a number: give a range, not choices.`;
    const range = actionRange(action);
    if (range?.min !== undefined && limits.max !== undefined && limits.max < range.min)
      return `${action.label} can’t go below ${range.min}.`;
    if (range?.max !== undefined && limits.min !== undefined && limits.min > range.max)
      return `${action.label} can’t go above ${range.max}.`;
    return null;
  }
  if (limits.min !== undefined || limits.max !== undefined || limits.step !== undefined)
    return `${action.label} has no range; pick from its choices.`;
  const allowed: unknown[] =
    action.valueType === 'boolean' ? [true, false] : (action.choices ?? []).map((c) => c.value);
  if (limits.choices?.some((c) => !allowed.includes(c))) return `${action.label} has no such choice.`;
  return null;
}

/** How a decision reads in the log: “room temperature Allowed (only between 16 and 24 °C) · hot water boost Ask me”. */
function decisionText(row: DeviceSkillRow, choices: Record<string, DeviceActionChoice>): string {
  const parts = row.profile.actions.map((a) => {
    const c = choices[a.key] ?? { tier: 'off' as const };
    const limit = c.limits ? limitText(c.limits, { unit: actionUnit(row.profile, a) ?? '' }) : null;
    const words = limit ? limit.replace(/^Only /, 'only ') : null;
    return `${a.label.toLowerCase()} ${DEVICE_TIER_LABELS[c.tier]}${words && c.tier !== 'off' ? ` (${words})` : ''}`;
  });
  return parts.length ? parts.join(' · ') : 'reads only';
}

/** The tool rows a profile's choices give its connection (one per action, `_read` Allowed); a restore's too. */
export function toolRowsFor(
  row: DeviceSkillRow,
  slug: string,
  choices: Record<string, DeviceActionChoice>,
  now: Date,
) {
  return deviceToolDefinitions(row.profile, slug).map((def, position) => {
    const choice = def.actionKey ? (choices[def.actionKey] ?? { tier: 'off' as const }) : null;
    return {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      access: def.access,
      tier: choice ? choice.tier : ('can' as const),
      // Bound to the profile too: an approval asked under another profile is refused (CX-21).
      hash: sha256Hex(canonicalJson({ ...def, profileHash: row.profileHash })),
      isNew: false,
      origin: def.origin,
      position,
      limits: choice ? toolLimitsOf(choice.limits) : null,
      updatedAt: now,
    };
  });
}

async function freeHandle(tx: Tx, burrowId: string, base: string): Promise<string> {
  const taken = new Set(await takenHandles(tx, burrowId));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 28)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The device's connection made live with the skill's profile and choices; returns its id. */
async function switchOn(
  ctx: ApplyContext,
  row: DeviceSkillRow,
  choices: Record<string, DeviceActionChoice>,
): Promise<{ connectionId: string; created: boolean }> {
  const tx = ctx.tx;
  // The device's live skill (an earlier profile): its connection carries on with this one.
  const [live] = await tx
    .select()
    .from(deviceSkills)
    .where(
      and(
        eq(deviceSkills.burrowId, row.burrowId),
        eq(deviceSkills.status, 'on'),
        eq(deviceSkills.host, row.host),
        eq(deviceSkills.port, row.port),
        ne(deviceSkills.id, row.id),
      ),
    );
  const previous = live && live.unitId === row.unitId ? live : null;
  const existingId = row.connectionId ?? previous?.connectionId ?? null;
  const [existing] = existingId
    ? await tx.select().from(catalogConnections).where(eq(catalogConnections.id, existingId))
    : [];
  const slug = existing?.fields.slug ?? deviceSlug(row.name);
  const fields: Record<string, string> = {
    skillId: row.id,
    slug,
    host: row.host,
    port: String(row.port),
    driver: row.profile.driver,
    ...(row.unitId !== null ? { unitId: String(row.unitId) } : {}),
  };
  const scheme = row.profile.driver === 'modbus_tcp' ? 'modbus' : row.port === 443 ? 'https' : 'http';
  const host = row.host.includes(':') ? `[${row.host}]` : row.host;
  const baseUrl = `${scheme}://${host}:${row.port}${row.profile.driver === 'http_json' ? (row.profile.defaults.basePath ?? '') : ''}`;
  let connectionId: string;
  let created = false;
  if (existing) {
    connectionId = existing.id;
    await tx
      .update(catalogConnections)
      .set({ label: row.name, fields, baseUrl, status: 'active', updatedAt: ctx.now })
      .where(eq(catalogConnections.id, connectionId));
  } else {
    await requireRoom(tx, row.burrowId);
    const handle = await freeHandle(tx, row.burrowId, deviceHandleBase(row.name));
    const [made] = await tx
      .insert(catalogConnections)
      .values({
        id: newId('connection'),
        catalogId: DEVICE_CATALOG_ID,
        burrowId: row.burrowId,
        connectedById: ctx.actor.id,
        label: row.name,
        handle,
        transport: 'builtin',
        signIn: 'none',
        baseUrl,
        fields,
        status: 'active',
        access: 'manage',
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    if (!made) throw new Error('device connection not inserted');
    connectionId = made.id;
    created = true;
  }
  const tools = toolRowsFor(row, slug, choices, ctx.now);
  await tx.delete(connectionTools).where(eq(connectionTools.connectionId, connectionId));
  if (tools.length) await tx.insert(connectionTools).values(tools.map((t) => ({ connectionId, ...t })));
  await tx
    .update(catalogConnections)
    .set({ toolCount: tools.length, toolsSyncedAt: ctx.now })
    .where(eq(catalogConnections.id, connectionId));
  if (previous) {
    const [gone] = await tx
      .update(deviceSkills)
      .set({ status: 'replaced', connectionId: null, updatedAt: ctx.now })
      .where(eq(deviceSkills.id, previous.id))
      .returning();
    if (gone) await republish(ctx, gone);
  }
  return { connectionId, created };
}

async function lockedSkill(tx: Tx, burrowId: string, id: string): Promise<DeviceSkillRow> {
  const [row] = await tx.select().from(deviceSkills).where(eq(deviceSkills.id, id)).for('update');
  if (!row || row.burrowId !== burrowId) throw notFound('Device skill');
  return row;
}

export const decideDeviceSkill = defineCommand({
  name: 'device_skill.decide',
  schema: z.object({
    proposalId: z.string().min(1).max(64),
    actions: z.record(z.string(), DeviceActionChoice),
    switchOn: z.boolean(),
  }),
  requiredKey: () => ({ keyId: 'burrow.manage', attempt: 'switch on a device skill', where: WHERE_THINGS }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only a person switches a device skill on.');
    const row = await lockedSkill(tx, ctx.burrow.id, input.proposalId);
    if (row.status === 'replaced') throw conflict('A newer skill for this device replaced this one.');
    const known = new Map(row.profile.actions.map((a) => [a.key, a]));
    const choices: Record<string, DeviceActionChoice> = {};
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input.actions)) {
      const action = known.get(key);
      if (!action) {
        fields[`actions.${key}`] = 'This device has no such action.';
        continue;
      }
      const choice = raw;
      const problem = choiceProblem(action, choice);
      if (problem) fields[`actions.${key}`] = problem;
      choices[key] = {
        tier: choice.tier,
        ...(choice.limits && Object.keys(choice.limits).length ? { limits: choice.limits } : {}),
      };
    }
    if (Object.keys(fields).length)
      throw new ApiError(
        'validation_failed',
        Object.values(fields)[0] ?? 'Those choices don’t fit this device.',
        {
          fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]])),
        },
      );
    // Everything not chosen stays off (mock 3: “Everything else stays off.”).
    for (const a of row.profile.actions) choices[a.key] ??= { tier: 'off' };
    const live = input.switchOn || row.status === 'on';
    let connectionId = row.connectionId;
    let created = false;
    if (live) ({ connectionId, created } = await switchOn(ctx, row, choices));
    const [saved] = await tx
      .update(deviceSkills)
      .set({
        choices,
        status: live ? 'on' : row.status === 'declined' ? 'proposed' : row.status,
        connectionId,
        decidedById: ctx.actor.id,
        decidedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(eq(deviceSkills.id, row.id))
      .returning();
    if (!saved) throw conflict('The device skill wasn’t saved.');
    const event = await ctx.emit({
      type: live ? 'device_skill.switched_on' : 'device_skill.decided',
      kind: 'Keys',
      // Every assistant here uses the device's shared connection (AN-01: the assistants, not “Whombat”).
      text: `${live ? (row.status === 'on' ? 'Changed what assistants may do with' : 'Switched on') : 'Chose what assistants may do with'} ${deviceNoun(row.name)}: ${decisionText(row, choices)}`.slice(
        0,
        500,
      ),
      where: WHERE_THINGS,
      payload: {
        proposalId: row.id,
        connectionId,
        created,
        profileHash: row.profileHash,
        choices: choices as Record<string, never>,
      },
    });
    await republish(ctx, saved, event.id);
    return { row: saved, connectionId: live ? connectionId : null, eventId: event.id };
  },
});

export const declineDeviceSkill = defineCommand({
  name: 'device_skill.decline',
  schema: z.object({ proposalId: z.string().min(1).max(64) }),
  requiredKey: () => ({ keyId: 'burrow.manage', attempt: 'decline a device skill', where: WHERE_THINGS }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only a person declines a device skill.');
    const row = await lockedSkill(tx, ctx.burrow.id, input.proposalId);
    if (row.status === 'on')
      throw conflict('This device is switched on. Remove it in Settings → Connections to switch it off.');
    if (row.status === 'replaced') throw conflict('A newer skill for this device replaced this one.');
    const [saved] = await tx
      .update(deviceSkills)
      .set({ status: 'declined', decidedById: ctx.actor.id, decidedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(deviceSkills.id, row.id))
      .returning();
    if (!saved) throw conflict('The device skill wasn’t saved.');
    const event = await ctx.emit({
      type: 'device_skill.declined',
      kind: 'Keys',
      text: `Didn’t switch on the skill for ${deviceNoun(row.name)}`,
      where: WHERE_THINGS,
      payload: { proposalId: row.id },
    });
    await republish(ctx, saved, event.id);
    return { row: saved, eventId: event.id };
  },
});

/**
 * A device connection removed in Settings → Connections (CX-24): its skill is off (the card reads “Not switched on”),
 * and nothing reads the device any more (ONE-DD15).
 */
export async function settleRemovedDevices(services: Services): Promise<number> {
  return services.pipeline.transactAccount(async (tx, session) => {
    const gone = await tx
      .update(deviceSkills)
      .set({ status: 'declined', updatedAt: services.clock() })
      .where(and(eq(deviceSkills.status, 'on'), isNull(deviceSkills.connectionId)))
      .returning();
    for (const row of gone) await republish(session, row);
    return gone.length;
  });
}

export const DEVICE_COMMANDS = [proposeDeviceSkill, decideDeviceSkill, declineDeviceSkill];
