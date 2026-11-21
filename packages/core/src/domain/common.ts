import { z } from 'zod';

/** ISO 8601 instant with offset (`2026-09-23T09:22:00.000Z` or `2026-09-23T11:22:00+02:00`). */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** Calendar date `YYYY-MM-DD`. */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

/** URL handle for people and agents (`banjo`, `mara`). Lowercase, digits, inner dashes. */
export const Handle = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, { message: 'Expected a lowercase handle' });
export type Handle = z.infer<typeof Handle>;

/**
 * `owner/name` of a GitHub repository (`acme/Whombat`). Moved here from `contracts/burrows.ts` in 0.26 (CT-170)
 * so links can carry it; `@whombat/core/contracts` still exports it under the same name.
 */
export const RepoFullName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name');
export type RepoFullName = z.infer<typeof RepoFullName>;

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export type HexColor = z.infer<typeof HexColor>;

/** Lowercase hex string of an exact byte length. */
export function hexBytes(bytes: number) {
  return z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), { message: `Expected ${bytes} hex bytes` });
}

export const Sha256Hex = hexBytes(32);
export const PublicKeyHex = hexBytes(32);
export const SignatureHex = hexBytes(64);
/** Fingerprint shown in the UI: `xxxx xxxx` (first 8 hex chars of sha256(publicKey)). */
export const Fingerprint = z.string().regex(/^[0-9a-f]{4} [0-9a-f]{4}$/);

export const Email = z.email();
export type Email = z.infer<typeof Email>;

export const Count = z.number().int().nonnegative();
/** Percentage 0–100. */
export const Percent = z.number().min(0).max(100);

/** Semantic tone used for pills, labels and dots. Maps to tokens `ok` / `warn` / `bad` / `mut`. */
export const Tone = z.enum(['ok', 'warn', 'bad', 'neutral']);
export type Tone = z.infer<typeof Tone>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** Any JSON value (finite numbers only). */
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine(Number.isFinite, { message: 'Expected a finite number' }),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);
export const JsonObject = z.record(z.string(), JsonValue);
export type JsonObject = z.infer<typeof JsonObject>;

/** Diff totals: `+214 −12 · 6 files`. */
export const DiffStat = z.object({
  add: Count,
  del: Count,
  files: Count,
});
export type DiffStat = z.infer<typeof DiffStat>;

/** A file touched by a change: `billing/pdf/format.ts +34 −9`. */
export const FileChange = z.object({
  path: z.string().min(1),
  add: Count,
  del: Count,
});
export type FileChange = z.infer<typeof FileChange>;

/** Test totals: `41 of 41`. */
export const TestCounts = z.object({
  passed: Count,
  total: Count,
});
export type TestCounts = z.infer<typeof TestCounts>;

/** Opaque cursor for keyset pagination. */
export const Cursor = z.string().min(1).max(512);
