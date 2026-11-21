/** ISO 8601 (UTC, millisecond precision) of a Date, the only timestamp format the server emits. */
export function iso(date: Date): string {
  return date.toISOString();
}

/** `iso()` for nullable columns. */
export function isoOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Normalises any accepted timestamp input to the canonical ISO form (signed envelopes rely on this). */
export function normalizeIso(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid timestamp: ${String(value)}`);
  return d.toISOString();
}

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
