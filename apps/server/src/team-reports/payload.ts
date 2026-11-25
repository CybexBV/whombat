/**
 * The words inside the team report device ops (docs/decisions/team-reports.md): one of core's team report shapes
 * as UTF-8 JSON, base64url without padding. So the free text never has to fit the cross-language string patterns, and
 * the manager forwards it without reading it. Both ends check the shape: what comes back from control is parsed here
 * before anything keeps or shows it.
 */
import type { z } from 'zod';

/** A shape as the device ops carry it. */
export function encodeTeamPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** A payload read back as `schema` says; throws when it isn't base64url JSON of that shape. */
export function decodeTeamPayload<S extends z.ZodType>(schema: S, payload: string): z.output<S> {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new TeamPayloadError('not base64url');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new TeamPayloadError('not JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new TeamPayloadError('not the shape');
  return parsed.data;
}

/** A payload that isn't what the contract says (control's fault, or a fake's). */
export class TeamPayloadError extends Error {
  override name = 'TeamPayloadError';
}
