/**
 * Reading device skills (docs/decisions/one-whombat-devices.md): a device connection's skill and profile, its address,
 * and the words a limit refusal uses for its tools.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ArgWords, LimitChoice } from '../connections/limits';
import type { CatalogConnectionRow, ConnectionToolRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { deviceSkills } from '../db/schema/index';
import { actionToolName, actionUnit, DEVICE_VALUE_POINTER } from './profile';
import type { DeviceAction, DeviceAddress, DeviceProfile } from './types';

/** The catalog entry device connections are made from (contracts 0.80, ONE-16). */
export const DEVICE_CATALOG_ID = 'device';

export type DeviceSkillRow = typeof deviceSkills.$inferSelect;

/** A device connection's skill (the one switched on), or null. */
export async function skillOfConnection(db: Db | Tx, connectionId: string): Promise<DeviceSkillRow | null> {
  const [row] = await db
    .select()
    .from(deviceSkills)
    .where(and(eq(deviceSkills.connectionId, connectionId), eq(deviceSkills.status, 'on')));
  return row ?? null;
}

export async function skillById(db: Db | Tx, id: string): Promise<DeviceSkillRow | null> {
  const [row] = await db.select().from(deviceSkills).where(eq(deviceSkills.id, id));
  return row ?? null;
}

/** The skills switched on in a burrow. */
export async function skillsOn(db: Db | Tx, burrowId?: string): Promise<DeviceSkillRow[]> {
  return db
    .select()
    .from(deviceSkills)
    .where(
      and(
        eq(deviceSkills.status, 'on'),
        // A connection removed a moment ago: off already (`settleRemovedDevices`).
        isNotNull(deviceSkills.connectionId),
        burrowId ? eq(deviceSkills.burrowId, burrowId) : undefined,
      ),
    );
}

/** Where a skill's device is. */
export function addressOf(row: Pick<DeviceSkillRow, 'host' | 'port' | 'unitId' | 'profile'>): DeviceAddress {
  return {
    host: row.host,
    port: row.port,
    ...(row.unitId !== null ? { unitId: row.unitId } : {}),
    ...(row.profile.defaults.basePath ? { basePath: row.profile.defaults.basePath } : {}),
  };
}

/** The slug a device connection's tools are named with (stored in its fields). */
export function slugOf(row: Pick<CatalogConnectionRow, 'fields'>): string {
  return row.fields.slug ?? 'device';
}

/** The action a device connection's tool sets, or null (`_read`, or not this profile's). */
export function actionOfTool(profile: DeviceProfile, slug: string, toolName: string): DeviceAction | null {
  return profile.actions.find((a) => actionToolName(slug, a.key) === toolName) ?? null;
}

/** How a limit refusal names a tool's arguments: a device action's label, unit and choices; else the pointer. */
export async function limitWordsFor(
  db: Db | Tx,
  row: Pick<CatalogConnectionRow, 'id' | 'catalogId' | 'fields'>,
  tool: Pick<ConnectionToolRow, 'name'>,
): Promise<(pointer: string) => ArgWords> {
  if (row.catalogId !== DEVICE_CATALOG_ID) return () => ({});
  const skill = await skillOfConnection(db, row.id);
  const action = skill ? actionOfTool(skill.profile, slugOf(row), tool.name) : null;
  if (!skill || !action) return () => ({});
  const unit = actionUnit(skill.profile, action);
  const choiceLabel = (v: LimitChoice) =>
    action.valueType === 'boolean'
      ? v === true
        ? 'on'
        : v === false
          ? 'off'
          : undefined
      : action.choices?.find((c) => c.value === v)?.label;
  return (pointer) =>
    pointer === DEVICE_VALUE_POINTER
      ? { label: action.label.toLowerCase(), ...(unit ? { unit } : {}), choiceLabel }
      : {};
}
