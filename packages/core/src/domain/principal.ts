import { z } from 'zod';
import { AccountId, BurrowId, PrincipalId } from '../ids.js';
import { AgentFace, AgentRuntime, AgentStatus } from './agent.js';
import { Email, Fingerprint, Handle, HexColor, PublicKeyHex, Timestamp } from './common.js';

/** Human avatar tones in the order the mock assigns them (`TONES`). */
export const HUMAN_TONES = ['#bfd0bf', '#dcc0cc', '#c3cad9', '#d9c3a9', '#cfd2b8'] as const;

/** Tone for the n-th person. */
export function toneFor(index: number): (typeof HUMAN_TONES)[number] {
  const i = ((index % HUMAN_TONES.length) + HUMAN_TONES.length) % HUMAN_TONES.length;
  return HUMAN_TONES[i] ?? HUMAN_TONES[0];
}

const PrincipalBase = z.object({
  id: PrincipalId,
  burrowId: BurrowId,
  name: z.string().min(1).max(80),
  handle: Handle,
  /** Ed25519 public key, hex. */
  publicKey: PublicKeyHex,
  /** `xxxx xxxx`, first 8 hex chars of sha256(publicKey). */
  fingerprint: Fingerprint,
  createdAt: Timestamp,
});

export const Person = PrincipalBase.extend({
  kind: z.literal('person'),
  /** First name used in copy ("Mara approved"); defaults to the first word of `name`. */
  shortName: z.string().min(1).max(40).optional(),
  /** Uppercase initials; any script's letters ("MO", "ÉK", "李"). */
  initials: z.string().regex(/^[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{N}]{1,3}$/u),
  tone: HexColor,
  /** "Engineering lead" under the name in the sidebar footer. */
  title: z.string().max(80).optional(),
  /**
   * Their photo (0.47, CT-265): the attachment URL (`/api/v1/burrows/{slug}/attachments/{id}`), set with
   * `me.setAvatar`. Absent or null: the initials on `tone`. Clients load it like an image attachment and show
   * the initials until it arrives or when it fails.
   */
  avatarUrl: z.string().min(1).max(300).nullable().optional(),
  email: Email,
  accountId: AccountId.optional(),
});
export type Person = z.infer<typeof Person>;

/** The Whombat's one agent (Whombat one-agent.md OA-01): created with the Whombat, never hired or retired. */
export const Agent = PrincipalBase.extend({
  kind: z.literal('agent'),
  /** The drawing it wears (OA-08), chosen in setup and changed in Settings → Agent. */
  face: AgentFace,
  status: AgentStatus,
  /** What it is doing right now: "Rounding VAT before formatting on feat/invoice-pdf." */
  doing: z.string().max(280),
  runtime: AgentRuntime,
});
export type Agent = z.infer<typeof Agent>;

/**
 * What a system principal is (OA-17): `github` (the GitHub mirror), `automation` (an automation's own signer,
 * docs/decisions/bp-automations.md) and `feedback` (Whombat Feedback's receiver, FB-14).
 */
export const SystemKind = z.enum(['github', 'automation', 'feedback']);
export type SystemKind = z.infer<typeof SystemKind>;

/** A signer that is neither a person nor the agent (OA-17): nothing that looks for the agent finds it. */
export const SystemPrincipal = PrincipalBase.extend({
  kind: z.literal('system'),
  system: SystemKind,
});
export type SystemPrincipal = z.infer<typeof SystemPrincipal>;

export const Principal = z.discriminatedUnion('kind', [Person, Agent, SystemPrincipal]);
export type Principal = z.infer<typeof Principal>;
export type PrincipalKind = Principal['kind'];

/** "Mara" for Mara Okafor; the name for the agent and system principals. */
export function shortNameOf(p: Pick<Principal, 'name' | 'kind'> & { shortName?: string }): string {
  if (p.kind === 'person') return p.shortName ?? p.name.split(/\s+/)[0] ?? p.name;
  return p.name;
}

/** Letters and digits only, one entry per character (not per UTF-16 unit). */
function lettersOf(word: string): string[] {
  return [...word.normalize('NFC')].filter((c) => /[\p{L}\p{N}]/u.test(c));
}

/**
 * Two-letter initials: "Mara Okafor" → "MO", "Banjo" → "BA", "Éva Kovács" → "ÉK", "joris.devries" → "JD".
 * Punctuation is skipped; a name without letters or digits gets "?" (people's names are `PersonName`s, which
 * always have one).
 */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._]+/)
    .map(lettersOf)
    .filter((w) => w.length > 0);
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) return '?';
  const raw = words.length === 1 ? first.slice(0, 2).join('') : `${first[0]}${last[0]}`;
  return [...raw.toUpperCase()].slice(0, 3).join('');
}

/** A person's display name: 1–80 characters with at least one letter or digit, trimmed. */
export const PersonName = z
  .string()
  .trim()
  .min(1, 'Tell us your name.')
  .max(80, 'Keep it under 80 characters.')
  .refine((v) => /[\p{L}\p{N}]/u.test(v), 'Use at least one letter.');

/** "Engineering lead": optional, up to 80 characters, trimmed ("" clears it). */
export const PersonTitle = z.string().trim().max(80, 'Keep it under 80 characters.');

/** Initials the invite list shows for an email address (mock: first two characters, uppercased). */
export function emailInitials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}
