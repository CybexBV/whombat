/**
 * Limits an owner puts on a tool's arguments (Whombat one-whombat.md ONE-18, contracts 0.80.0, CT-341): numbers within
 * `min`/`max` on a `step` grid, or one of `choices`. Every connection tool can have them (`ConnectionToolView.limits`,
 * `connections.setToolLimits`); a device action's limits are the same shape. The server checks them before the keys
 * decide (`apps/server/src/connections/limits.ts`).
 */
import { z } from 'zod';

export const ToolArgLimit = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  choices: z
    .array(z.union([z.number(), z.string().max(80), z.boolean()]))
    .max(64)
    .optional(),
});
export type ToolArgLimit = z.infer<typeof ToolArgLimit>;

/** RFC 6901 pointer into a tool's arguments: `/value`, `/data/brightness`. */
export const ToolArgPointer = z
  .string()
  .min(2)
  .max(200)
  .regex(/^(\/([^~/]|~[01])*)+$/);

/** A tool's limits, by the JSON pointer of the argument each one covers. */
export const ConnectionToolLimits = z.object({
  args: z.record(ToolArgPointer, ToolArgLimit),
});
export type ConnectionToolLimits = z.infer<typeof ConnectionToolLimits>;

/** The most arguments one tool's limits cover. */
export const TOOL_LIMITS_ARGS_MAX = 16;

/** The plain sentence for a limit: “only between 16 and 24 °C”, “only 16 or more”, “only Eco or Comfort”. */
export function limitText(
  limit: ToolArgLimit,
  unit?: string,
  labels?: Readonly<Record<string, string>>,
): string | null {
  const u = unit ? ` ${unit}` : '';
  if (limit.choices?.length) {
    const names = limit.choices.map((c) => labels?.[String(c)] ?? String(c));
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
    return `only ${list}`;
  }
  if (limit.min !== undefined && limit.max !== undefined)
    return `only between ${limit.min} and ${limit.max}${u}`;
  if (limit.min !== undefined) return `only ${limit.min}${u} or more`;
  if (limit.max !== undefined) return `only up to ${limit.max}${u}`;
  return null;
}
