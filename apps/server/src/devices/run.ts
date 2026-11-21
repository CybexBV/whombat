/**
 * A device connection's tools as calls run them (docs/decisions/one-whombat-devices.md): `<device>_read` reads the
 * profile's readings, `<device>_<action>` sets one value. Called by `connections/call.ts` (`runTool`) after the keys,
 * tiers and the person's limits allowed the call, so everything here is about the device itself: its address now, the
 * profile's own ranges, and the change a write makes (ONE-08: read the old value first, record the change with the
 * recipe that undoes it).
 */
import { CHANGE_UNDO_WINDOW_S, type JsonObject } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { type CallOutput, ConnectionArgumentError } from '../connections/request';
import type { CatalogConnectionRow, ConnectionToolRow } from '../connections/types';
import { deviceSkills } from '../db/schema/index';
import { recordChange } from '../home/registry';
import type { Services } from '../services';
import { VaultCallError } from '../vault/net';
import {
  DeviceCallError,
  type ReadingResult,
  type ReadingValue,
  readActionValue,
  readDevice,
  readingText,
  writeDeviceAction,
} from './driver';
import { actionUnit, deviceNoun, readToolName } from './profile';
import { actionOfTool, addressOf, type DeviceSkillRow, skillOfConnection, slugOf } from './store';
import type { DeviceAction } from './types';

/** The recipe kind that undoes a device action (`home/registry.ts`). */
export const DEVICE_UNDO_KIND = 'device.set';
/** How long Undo is offered after a device action (contracts' `CHANGE_UNDO_WINDOW_S`). */
export const DEVICE_UNDO_MS = CHANGE_UNDO_WINDOW_S * 1000;

/** What `device.set` needs to undo a change: the tool, the value before and the value it set. */
export interface DeviceUndo {
  connectionId: string;
  tool: string;
  value: ReadingValue;
  setTo: ReadingValue;
  profileHash: string;
}

/** Who a device call is for, as the connection call knows it. */
export interface DeviceCallContext {
  burrowId: string;
  agentId: string;
  callId: string;
  conversationId?: string | null;
  personId?: string | null;
}

/* Undo links: a call that undoes a change marks it undone when it records its own (ONE-DW05). */

const undoing = new Map<string, { changeId: string; byId: string; at: number }>();
const UNDO_LINK_MS = 24 * 60 * 60_000;

/** Remembers that the call `callId` undoes `changeId` (pressed by `byId`). */
export function linkUndo(callId: string, changeId: string, byId: string): void {
  const now = Date.now();
  for (const [k, v] of undoing) if (now - v.at > UNDO_LINK_MS) undoing.delete(k);
  undoing.set(callId, { changeId, byId, at: now });
}

function takeUndo(callId: string): { changeId: string; byId: string } | null {
  const link = undoing.get(callId);
  if (!link) return null;
  undoing.delete(callId);
  return { changeId: link.changeId, byId: link.byId };
}

/* Words ---------------------------------------------------------------------------------------------- */

function valueText(skill: DeviceSkillRow, action: DeviceAction, value: ReadingValue): string {
  if (action.valueType === 'boolean') return value ? 'on' : 'off';
  const unit = actionUnit(skill.profile, action);
  const reading = skill.profile.readings.find((r) => r.key === action.key);
  return readingText(
    {
      ...(unit ? { unit } : {}),
      choices: action.choices ?? [],
      modbus: reading?.modbus ?? action.modbus,
    },
    value,
  );
}

/** “Set the heat pump’s room temperature to 21.5 °C”, “Turned on the heat pump’s hot water boost” (mock 1's Done recently). */
export function changeTitle(skill: DeviceSkillRow, action: DeviceAction, value: ReadingValue): string {
  const whose = `${deviceNoun(skill.name)}’s ${action.label.toLowerCase()}`;
  if (action.valueType === 'boolean') return `Turned ${value ? 'on' : 'off'} ${whose}`;
  return `Set ${whose} to ${valueText(skill, action, value)}`;
}

/** The small line under it: “20.0 °C → 21.5 °C”; nothing for on and off (the title says it). */
export function changeDetail(
  skill: DeviceSkillRow,
  action: DeviceAction,
  before: ReadingValue | null,
  value: ReadingValue,
): string | null {
  if (before === null || before === value || action.valueType === 'boolean') return null;
  return `${valueText(skill, action, before)} → ${valueText(skill, action, value)}`;
}

/* Recording ------------------------------------------------------------------------------------------ */

/** A device action's change, recorded as the Whombat that made it (ONE-08). */
export const recordDeviceChange = defineCommand({
  name: 'device.record_change',
  schema: z.object({
    connectionId: z.string(),
    label: z.string().max(200),
    title: z.string().max(200),
    detail: z.string().max(1000).nullable(),
    conversationId: z.string().nullable(),
    personId: z.string().nullable(),
    undo: z.custom<DeviceUndo>().nullable(),
    undoes: z.object({ changeId: z.string(), byId: z.string() }).nullable(),
  }),
  async apply(_tx, ctx, input) {
    const id = await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      agentId: ctx.actor.kind === 'agent' ? ctx.actor.id : null,
      personId: input.personId,
      kind: 'device.action',
      title: input.title,
      detail: input.detail,
      subject: { kind: 'device', id: input.connectionId, name: input.label },
      undo: input.undo
        ? { kind: DEVICE_UNDO_KIND, payload: input.undo, until: new Date(ctx.now.getTime() + DEVICE_UNDO_MS) }
        : null,
      conversationId: input.conversationId,
      at: ctx.now,
      undoes: input.undoes,
    });
    return { changeId: id };
  },
});

/** Keeps a skill's last reading for Home (not signed: a cache of what the device said). */
export async function keepLastRead(
  services: Services,
  skillId: string,
  readings: ReadingResult[] | null,
  error: string | null,
): Promise<void> {
  const now = services.clock();
  await services.pipeline.transactAccount(async (tx) => {
    await tx
      .update(deviceSkills)
      .set(
        readings
          ? { lastRead: readings, lastReadAt: now, lastReadError: null, updatedAt: now }
          : { lastReadError: error, updatedAt: now },
      )
      .where(eq(deviceSkills.id, skillId));
  });
}

/* Running -------------------------------------------------------------------------------------------- */

function failedOutput(message: string): CallOutput {
  return { content: message, isError: true, truncated: false, bytes: 0 };
}

/** A device failure as the call reports it: a refused address or bad arguments as the call's own failures. */
function deviceFailure(err: unknown): CallOutput {
  if (err instanceof DeviceCallError) {
    if (err.reason === 'destination') throw new VaultCallError('not_allowed');
    if (err.reason === 'invalid') throw new ConnectionArgumentError(err.message);
    return failedOutput(err.message);
  }
  throw err;
}

function readKeys(skill: DeviceSkillRow, args: Readonly<Record<string, unknown>>): string[] | undefined {
  const keys = args.keys;
  if (keys === undefined || keys === null) return undefined;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))
    throw new ConnectionArgumentError('keys: a list of reading keys.');
  const known = new Set(skill.profile.readings.map((r) => r.key));
  const unknown = (keys as string[]).filter((k) => !known.has(k));
  if (unknown.length)
    throw new ConnectionArgumentError(`No reading called ${unknown.slice(0, 3).join(', ')}.`);
  return keys as string[];
}

/** What `_read` answers: the values by key (a widget's pointers read `/values/<key>`), their words and units. */
export function readOutput(readings: readonly ReadingResult[], at: Date): CallOutput {
  const values: JsonObject = {};
  const units: JsonObject = {};
  const text: JsonObject = {};
  const errors: JsonObject = {};
  for (const r of readings) {
    values[r.key] = r.value;
    text[r.key] = r.text;
    if (r.unit) units[r.key] = r.unit;
    if (r.error) errors[r.key] = r.error;
  }
  const structured: JsonObject = {
    values,
    text,
    units,
    ...(Object.keys(errors).length ? { errors } : {}),
    readAt: at.toISOString(),
  };
  const lines = readings.map((r) => `${r.label}: ${r.error ? `couldn’t read (${r.error})` : r.text}`);
  const content = `${lines.join('\n')}\n\n${JSON.stringify(structured)}`;
  return { content, structured, isError: false, truncated: false, bytes: Buffer.byteLength(content) };
}

/** Runs one tool of a device connection. */
export async function runDeviceTool(
  services: Services,
  row: CatalogConnectionRow,
  tool: Pick<ConnectionToolRow, 'name'>,
  args: Readonly<Record<string, unknown>>,
  /** The call a write belongs to (its change names it); reads need none. */
  call?: DeviceCallContext,
): Promise<CallOutput> {
  const skill = await skillOfConnection(services.db, row.id);
  if (!skill) throw new ConnectionArgumentError('This device isn’t switched on any more.');
  const slug = slugOf(row);
  const address = addressOf(skill);
  if (tool.name === readToolName(slug)) {
    const keys = readKeys(skill, args);
    try {
      const readings = await readDevice(services, skill.profile, address, keys);
      if (!keys) await keepLastRead(services, skill.id, readings, null);
      return readOutput(readings, services.clock());
    } catch (err) {
      if (!keys && err instanceof DeviceCallError) await keepLastRead(services, skill.id, null, err.message);
      return deviceFailure(err);
    }
  }
  const action = actionOfTool(skill.profile, slug, tool.name);
  if (!action) throw new ConnectionArgumentError(`${tool.name} isn’t available on this device.`);
  if (!call) throw new ConnectionArgumentError(`${tool.name} changes the device; it runs only as a call.`);
  const value = args.value;
  if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string')
    throw new ConnectionArgumentError('value: required.');
  let before: ReadingValue | null = null;
  try {
    // The old value first, for Undo; a device that can't say it still takes the write, without Undo.
    before = await readActionValue(services, skill.profile, address, action).catch(() => null);
    await writeDeviceAction(services, skill.profile, address, action, value);
  } catch (err) {
    return deviceFailure(err);
  }
  const title = changeTitle(skill, action, value);
  const undoes = takeUndo(call.callId);
  await services.pipeline
    .commit(
      recordDeviceChange,
      {
        connectionId: row.id,
        label: row.label.slice(0, 200),
        title,
        detail: changeDetail(skill, action, before, value),
        conversationId: call.conversationId ?? null,
        personId: call.personId ?? null,
        undo:
          before !== null && before !== value
            ? {
                connectionId: row.id,
                tool: tool.name,
                value: before,
                setTo: value,
                profileHash: skill.profileHash,
              }
            : null,
        undoes,
      },
      { burrowId: call.burrowId, actorId: call.agentId },
    )
    .catch((err: unknown) =>
      services.log.warn(
        { err: err instanceof Error ? err.message : 'error' },
        'devices: could not record a change',
      ),
    );
  const content = `${title}.`;
  return {
    content,
    structured: {
      key: action.key,
      value,
      ...(before !== null ? { before } : {}),
    },
    isError: false,
    truncated: false,
    bytes: 0,
  };
}
