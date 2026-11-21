/**
 * A page's buttons (`things.action`; connection-pages.md CP-12; connection-pages-server.md CP-S18; service-dashboards.md
 * SD-07, SD-08, SD-S04): a person's change to the thing itself — Restart on the head, Approve on a request, a light's
 * switch — for the person, after they confirmed it where it matters; refused on Look only
 * (CS-10). The body says which button (`action`), on which row or entity (`target`) and with which value (`value`).
 *
 * The rules stay here (`actionFor`): the person, not on Look only, an action its kind offers
 * (`kinds/index.ts`); the kind's action then checks its own target and value and runs as the connection. The call runs
 * first (the op is never resent, CT-393), then one commit signs it: a change a person would want to find (“Restarted
 * Home Assistant”, kind `thing.<action>`, no Undo), or an everyday switch (kind `thing.control.<action>`, SD-08) that
 * only the thing's own changes list. The connection's kept reads are forgotten, and the answer tells the client to read
 * the page again at once: it shows the new state.
 *
 * A declared setting's change (service-settings.md SST-01…SST-04) also keeps how to put it back (undo kind
 * `thing.action`, 7 days): Put it back runs the same action as the person with the old value, and the original change is
 * marked undone by it. When the assistant ran it (after the person's yes), the change names the assistant too.
 */
import { thingHref } from '@whombat/core';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { type ConnectionViewer, visibleConnections } from '../connections/store';
import type { CatalogConnectionRow } from '../connections/types';
import { EVERYDAY_CHANGE_PREFIX } from '../home/changes';
import { type DirectUndoer, recordChange } from '../home/registry';
import { ApiError, badRequest, forbidden } from '../lib/errors';
import { actingAgentId } from '../managed/acting-assistant';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { buttonRefusal } from './kinds/buttons';
import { kindOf } from './kinds/index';
import { forgetConnectionReads } from './kinds/read';
import type { KindAction, KindActionInput, KindActionWords } from './kinds/registry';
import { SETTING_ACTION, SETTING_UNDO_MS } from './kinds/settings';
import { findThing } from './page';
import { displayName } from './part-of';

/** What a button sends (contracts CT-1006). */
export interface ThingActionInput extends KindActionInput {
  action: string;
}

/** What a button answers: the toast, the change it made, and “read the page again”. */
export interface ThingActionOutcome {
  message: string;
  changeId?: string;
  refresh: boolean;
  /** The change can be put back (SST-03). */
  undoable?: boolean;
}

/** The undo recipe of a page action that can be put back (SST-03). */
export const THING_ACTION_UNDO_KIND = 'thing.action';

const UndoPayload = z.object({
  connectionId: z.string().min(1).max(64),
  action: z.string().min(1).max(40),
  target: z.string().max(200).optional(),
  value: z.union([z.string().max(200), z.number(), z.boolean()]),
  expect: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
});
type UndoPayload = z.infer<typeof UndoPayload>;

/** The kind of change a button leaves: an everyday switch's stays on the thing's page only (SD-08). */
export function actionChangeKind(action: string, everyday: boolean): string {
  return everyday ? `${EVERYDAY_CHANGE_PREFIX}${action}` : `thing.${action}`;
}

/** Signs a page action once it ran, and records it as a change of the thing (no Undo). */
export const recordThingAction = defineCommand({
  name: 'thing.action',
  schema: z.object({
    connectionId: z.string().min(1).max(64),
    action: z.string().min(1).max(40),
    title: z.string().min(1).max(200),
    name: z.string().min(1).max(120),
    everyday: z.boolean().optional(),
    /** The change's kind after `thing.` when not the action's (`setting.remote_quality`). */
    changeKind: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,70}$/)
      .optional(),
    detail: z.string().max(200).optional(),
    undo: UndoPayload.optional(),
    /** The assistant that asked for it (it ran after the person's yes, SST-04). */
    agentId: z.string().min(1).max(64).optional(),
    /** The change this one puts back. */
    undoes: z.string().min(1).max(64).optional(),
  }),
  async apply(_tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can use a page’s actions.');
    const everyday = input.everyday === true;
    await ctx.emit({
      type: 'thing.action',
      kind: 'System',
      // Everyday switches stay out of the burrow's log (SD-08).
      text: everyday ? null : input.title,
      where: everyday ? null : 'Connections',
      payload: { connectionId: input.connectionId, action: input.action, ...(everyday ? { everyday } : {}) },
    });
    const changeId = await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      personId: ctx.actor.id,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      kind: input.changeKind ? `thing.${input.changeKind}` : actionChangeKind(input.action, everyday),
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      subject: { kind: 'connection', id: input.connectionId, name: input.name },
      link: thingHref('connection', input.connectionId),
      ...(input.undo
        ? {
            undo: {
              kind: THING_ACTION_UNDO_KIND,
              payload: input.undo,
              until: new Date(ctx.now.getTime() + SETTING_UNDO_MS),
            },
          }
        : {}),
      ...(input.undoes ? { undoes: { changeId: input.undoes, byId: ctx.actor.id } } : {}),
      at: ctx.now,
    });
    return { changeId };
  },
});

/**
 * The central checks (SD-S04), in this order: an action the connection's kind offers, a person, not set to Look only. The kind's action, or an `ApiError` in plain words.
 */
export function actionFor(
  row: Pick<CatalogConnectionRow, 'catalogId' | 'access' | 'label' | 'fields'>,
  viewer: Pick<ConnectionViewer, 'principal'>,
  action: string,
): KindAction {
  const kind = kindOf(row.catalogId);
  const actions = kind?.actions;
  const run =
    action === SETTING_ACTION && kind?.settings
      ? kind.settings.action
      : actions && Object.hasOwn(actions, action)
        ? actions[action]
        : undefined;
  if (!run) throw badRequest('This has no such action.');
  if (viewer.principal.kind !== 'person') throw forbidden('Only you can use a page’s actions.');
  // The words a disabled button shows (`kinds/buttons.ts`).
  const refusal = buttonRefusal({ row });
  if (refusal) throw forbidden(refusal);
  return run;
}

async function executeThingAction(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  input: ThingActionInput,
  timeZone = 'UTC',
  undoes?: string,
): Promise<{ outcome: ThingActionOutcome; uncertain: boolean }> {
  const target = await findThing(services, viewer, value);
  if (target.kind !== 'connection') throw badRequest('This has no such action.');
  const row = target.row;
  const run = actionFor(row, viewer, input.action);
  let done: Awaited<ReturnType<typeof run>>;
  try {
    done = await run(
      { services, row, now: services.clock(), timeZone },
      {
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(undoes && input.expect !== undefined ? { expect: input.expect } : {}),
      },
    );
  } finally {
    // Whatever it changed there, the page read right after shows it (SD-S10): its kept reads go.
    forgetConnectionReads(services, row.id);
  }
  // Already so: nothing changed, nothing to record.
  if (done.unchanged) return { outcome: { message: done.message.slice(0, 200), refresh: true }, uncertain: false };
  const uncertain = done.uncertain === true;
  const agentId = actingAgentId();
  const result = await services.pipeline.commit(
    recordThingAction,
    {
      connectionId: row.id,
      action: input.action,
      title: done.title.slice(0, 200),
      name: displayName(row).slice(0, 120),
      ...(done.everyday ? { everyday: true } : {}),
      ...(done.changeKind ? { changeKind: done.changeKind } : {}),
      ...(done.detail ? { detail: done.detail.slice(0, 200) } : {}),
      ...(done.undo && !uncertain
        ? {
            undo: {
              connectionId: row.id,
              action: input.action,
              ...(done.undo.target !== undefined ? { target: done.undo.target } : {}),
              value: done.undo.value,
              ...(done.undo.expect !== undefined ? { expect: done.undo.expect } : {}),
            },
          }
        : {}),
      ...(agentId ? { agentId } : {}),
      ...(undoes && !uncertain ? { undoes } : {}),
    },
    { burrowId: viewer.burrowId, actorId: viewer.principal.id },
  );
  const changeId = result.status === 'ok' ? result.result.changeId : undefined;
  return {
    outcome: {
      message: done.message.slice(0, 200),
      ...(changeId ? { changeId } : {}),
      ...(changeId && done.undo && !uncertain ? { undoable: true } : {}),
      refresh: true,
    },
    uncertain,
  };
}

/** `things.action`: runs one of the page's buttons for the person. */
export async function runThingAction(
  services: Services,
  viewer: ConnectionViewer,
  value: string,
  input: ThingActionInput,
  timeZone = 'UTC',
  /** Put it back (SST-03): the change this run undoes. */
  undoes?: string,
): Promise<ThingActionOutcome> {
  return (await executeThingAction(services, viewer, value, input, timeZone, undoes)).outcome;
}

/**
 * A page action in Whombat's words for the assistant's approval card (SST-04): the kind's own (“Change a Plex
 * setting”, “Quality outside your home: 8 Mbps → 20 Mbps”), or null for the generic words. Never throws.
 */
export async function describeThingAction(
  services: Services,
  burrowId: string,
  thing: unknown,
  body: unknown,
  timeZone = 'UTC',
): Promise<KindActionWords | null> {
  try {
    // A session may pass the thingId still encoded (`connection%3Acon_…`).
    const id = typeof thing === 'string' ? (/%3a/i.test(thing) ? decodeURIComponent(thing) : thing) : '';
    if (!id.startsWith('connection:')) return null;
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.action !== 'string') return null;
    const row = (await visibleConnections(services.db, { burrowId })).find(
      (r) => r.id === id.slice('connection:'.length),
    );
    const kind = row ? kindOf(row.catalogId) : undefined;
    if (!row || !kind) return null;
    const value = b.value;
    const input: KindActionInput = {
      ...(typeof b.target === 'string' ? { target: b.target } : {}),
      ...(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? { value }
        : {}),
    };
    const ctx = { services, row, now: services.clock(), timeZone };
    if (b.action === SETTING_ACTION && kind.settings) return await kind.settings.describe(ctx, input);
    return kind.describe ? await kind.describe(ctx, b.action, input) : null;
  } catch {
    return null;
  }
}

/**
 * Put it back (SST-03): the recipe's action again, as the person who pressed it, with the old value — refused in plain
 * words when the setting was changed since. The new change marks the original undone.
 */
export const undoThingAction: DirectUndoer = async (ctx, change) => {
  const parsed = UndoPayload.safeParse(change.undo.payload);
  if (!parsed.success) return { ok: false, reason: 'Whombat can’t put this one back.' };
  const recipe: UndoPayload = parsed.data;
  const principal = await loadPrincipalRow(ctx.services.db, ctx.person.id);
  if (!principal?.accountId) return { ok: false, reason: 'Only you can put this back.' };
  const viewer: ConnectionViewer = { accountId: principal.accountId, burrowId: ctx.burrowId, principal };
  let uncertain = false;
  let outcome: ThingActionOutcome;
  try {
    ({ outcome, uncertain } = await executeThingAction(
      ctx.services,
      viewer,
      `connection:${recipe.connectionId}`,
      {
        action: recipe.action,
        ...(recipe.target !== undefined ? { target: recipe.target } : {}),
        value: recipe.value,
        ...(recipe.expect !== undefined ? { expect: recipe.expect } : {}),
      },
      'UTC',
      change.id,
    ));
  } catch (err) {
    // Changed again since, refused, or the service didn't answer: its words.
    if (err instanceof ApiError) return { ok: false, reason: err.message };
    throw err;
  }
  if (uncertain) return { ok: false, reason: outcome.message };
  return { ok: true, state: 'undone' };
};

export const THING_COMMANDS = [recordThingAction];
