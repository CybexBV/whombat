/**
 * Devices Whombat doesn't support yet (Whombat one-whombat.md ONE-16…ONE-19, contracts 0.80.0, CT-340): a device
 * skill is a description, not code. Whombat writes a `DeviceProfile` (driver, address defaults, readings, actions with
 * types, ranges and choices, the manual it came from); the server's built-in drivers (Modbus TCP, local HTTP/JSON) do
 * the reading and writing. The owner chooses each action's tier and limits on the `device_skill` card; nothing changes
 * on the device until they press Switch on. Limits live with the owner's choice, never in the profile.
 */

import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { DeviceSkillProposalId } from '../ids.js';
import { Count, JsonObject, Timestamp } from './common.js';
import { ConnectionToolTier } from './connections-catalog.js';
import { ToolArgLimit } from './tool-limits.js';

export const DEVICE_DRIVERS = ['modbus_tcp', 'http_json'] as const;
export const DeviceDriver = z.enum(DEVICE_DRIVERS);
export type DeviceDriver = z.infer<typeof DeviceDriver>;

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Label = z.string().trim().min(1).max(80);
const Unit = z.string().max(16);
/** A local path on the device's web server: `/api/status`. */
const DevicePath = z
  .string()
  .max(300)
  .regex(/^\/[^\s]*$/);
/** RFC 6901 pointer into the device's JSON answer: `/temperature/flow`. */
const Pointer = z
  .string()
  .max(300)
  .regex(/^(\/([^~/]|~[01])*)*$/);

export const ModbusTable = z.enum(['holding', 'input', 'coil', 'discrete']);
export type ModbusTable = z.infer<typeof ModbusTable>;
export const ModbusType = z.enum(['u16', 's16', 'u32', 's32', 'f32', 'bool']);
export type ModbusType = z.infer<typeof ModbusType>;

/** Where a value lives in a Modbus device: table, 0-based address, type, scale (value = raw × scale), word order. */
export const ModbusAddress = z.object({
  table: ModbusTable,
  address: z.number().int().min(0).max(65_535),
  type: ModbusType,
  scale: z.number().positive().optional(),
  /** 32-bit values: `big` (high word first, the default) or `little`. */
  wordOrder: z.enum(['big', 'little']).optional(),
});
export type ModbusAddress = z.infer<typeof ModbusAddress>;

/** A coded value and its words: `{value: 1, label: 'Heating'}`. */
export const DeviceChoice = z.object({ value: z.union([z.number(), z.string().max(80)]), label: Label });
export type DeviceChoice = z.infer<typeof DeviceChoice>;

export const DeviceReading = z.object({
  key: Key,
  label: Label,
  unit: Unit.optional(),
  modbus: ModbusAddress.optional(),
  http: z.object({ method: z.literal('GET'), path: DevicePath, pointer: Pointer }).optional(),
  /**
   * Words for a coded value (0.80.1, CT-345): the reading shows “Heating” instead of 1 (“Mode · Heating”). A value
   * without a choice shows as it is.
   */
  choices: z.array(DeviceChoice).max(32).optional(),
});
export type DeviceReading = z.infer<typeof DeviceReading>;

export const DeviceValueType = z.enum(['number', 'boolean', 'choice']);
export type DeviceValueType = z.infer<typeof DeviceValueType>;

/**
 * Something Whombat can change on the device. A Modbus write goes to a `holding` register (FC6/FC16) or a `coil`
 * (FC5/FC15); an HTTP write sends `body` with the value put at `valuePointer` (absent: the body is the value).
 */
export const DeviceAction = z.object({
  key: Key,
  label: Label,
  /** What it does, in plain words: “Sets the flow temperature the heat pump aims for.” */
  description: z.string().trim().min(1).max(300),
  modbus: ModbusAddress.extend({ table: z.enum(['holding', 'coil']) }).optional(),
  http: z
    .object({
      method: z.enum(['POST', 'PUT', 'PATCH']),
      path: DevicePath,
      body: JsonObject.optional(),
      valuePointer: Pointer.optional(),
    })
    .optional(),
  valueType: DeviceValueType,
  /** The value's unit (0.80.1, CT-345): `°C`, shown with the value and the owner's limits. */
  unit: Unit.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  choices: z.array(DeviceChoice).max(32).optional(),
  /** Always asks a person, whatever its tier (a mode that stops heating, a reset). */
  sensitive: z.boolean().optional(),
});
export type DeviceAction = z.infer<typeof DeviceAction>;

/** A device's description (ONE-16), written by Whombat from the manual and tested read-only before it is proposed. */
export const DeviceProfile = z.object({
  name: Label,
  vendor: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  driver: DeviceDriver,
  defaults: z
    .object({
      port: z.number().int().min(1).max(65_535).optional(),
      unitId: z.number().int().min(0).max(255).optional(),
      basePath: DevicePath.optional(),
    })
    .default({}),
  readings: z.array(DeviceReading).min(1).max(64),
  actions: z.array(DeviceAction).max(32).default([]),
  /** Where the description came from: the manual's link and title, and a note (“register map from the installer manual, page 41”). */
  source: z
    .object({
      url: z.url().max(2048).optional(),
      title: z.string().max(200).optional(),
      note: z.string().max(500).optional(),
    })
    .default({}),
});
export type DeviceProfile = z.infer<typeof DeviceProfile>;
export type DeviceProfileInput = z.input<typeof DeviceProfile>;

/** The default Modbus TCP port and unit. */
export const MODBUS_DEFAULT_PORT = 502;
export const MODBUS_DEFAULT_UNIT_ID = 1;

/* The owner's choice ------------------------------------------------------------------------------ */

/** One action's tier and limits: Off · Ask me · Allowed (`off`, `ask`, `can`). */
export const DeviceActionChoice = z.object({ tier: ConnectionToolTier, limits: ToolArgLimit.optional() });
export type DeviceActionChoice = z.infer<typeof DeviceActionChoice>;

const DEVICE_TIER_LABELS_KEYS = ['off', 'ask', 'can'] as const;

/** The card's tier labels (mock 3): Off · Ask me · Allowed. */
export function deviceTierLabels(
  locale?: string | null,
): Readonly<Record<(typeof DEVICE_TIER_LABELS_KEYS)[number], string>> {
  return coreWords(locale, 'device.tier', DEVICE_TIER_LABELS_KEYS);
}

export const DEVICE_TIER_LABELS: Record<ConnectionToolTier, string> = deviceTierLabels('en');

/* The card ---------------------------------------------------------------------------------------- */

export const DeviceSkillStatus = z.enum(['proposed', 'on', 'declined']);
export type DeviceSkillStatus = z.infer<typeof DeviceSkillStatus>;

/**
 * The skill Whombat proposes for a device (mock 3, ONE-18): what it can read, with the real values from the read-only
 * test, and every action with Whombat's proposed tier and limits. Server-made only (`propose_device_skill`); the same
 * shape is stored. `decided` holds the owner's choices once switched on.
 */
export const DeviceSkillCard = z.object({
  kind: z.literal('device_skill'),
  proposalId: DeviceSkillProposalId,
  name: Label,
  model: z.string().max(120).optional(),
  readings: z
    .array(z.object({ key: Key, label: Label, value: z.string().max(60), unit: Unit.optional() }))
    .max(12),
  /** Readings the card leaves out (“and 14 more”). */
  moreReadings: Count,
  actions: z
    .array(
      z.object({
        key: Key,
        label: Label,
        description: z.string().max(300),
        proposed: DeviceActionChoice,
        valueType: DeviceValueType.optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        unit: Unit.optional(),
        sensitive: z.boolean().optional(),
      }),
    )
    .max(32),
  testedAt: Timestamp,
  status: DeviceSkillStatus,
  decided: z.record(z.string(), DeviceActionChoice).optional(),
  /** The `device` connection made by Switch on. */
  connectionId: z
    .string()
    .regex(/^con_[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});
export type DeviceSkillCard = z.infer<typeof DeviceSkillCard>;

const DEVICE_SKILL_COPY_KEYS = [
  'canRead',
  'canChange',
  'switchOn',
  'decline',
  'on',
  'declined',
  'nothingChanges',
] as const;

/** The card's words (mock 3). */
export function deviceSkillCopy(
  locale?: string | null,
): Readonly<Record<(typeof DEVICE_SKILL_COPY_KEYS)[number], string>> {
  return coreWords(locale, 'device.skill', DEVICE_SKILL_COPY_KEYS);
}

export const DEVICE_SKILL_COPY = deviceSkillCopy('en');
