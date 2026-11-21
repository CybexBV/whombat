/**
 * The box's edition (Whombat hermes-engine.md HE-24, HE-25, HE-58; CT-1300): one image, two editions.
 *
 * - `commercial`: the relay to the hosted app, control (registration, admission tickets, claims, managed rollouts), remote
 *   help, the licence, phone push through control.
 * - `community`: none of those. The box is claimed, joined and reached over its direct ways only (the local network and
 *   Tailscale), takes its updates from its own signed channel, sends Web Push itself and mail through the owner's own
 *   server.
 *
 * Clients read it before a session from the box's page (`DirectIdentity.edition`, a plain GET of `DIRECT_PATH`) and in
 * every session (`Welcome.edition`), and hide what the box doesn't have (`editionHas`). Absent means `commercial`: every
 * box before contracts 1.1 is one.
 */
import { z } from 'zod';

export const EDITIONS = ['commercial', 'community'] as const;
export const Edition = z.enum(EDITIONS);
export type Edition = z.infer<typeof Edition>;

/** What a box that doesn't say is (contracts 1.0 boxes). */
export const DEFAULT_EDITION: Edition = 'commercial';

/** The edition a box said, or `commercial` when it said none. */
export function editionOf(said: Edition | null | undefined): Edition {
  return said ?? DEFAULT_EDITION;
}

/**
 * The parts only one edition has, as clients branch on them:
 * - `relay`: reaching the box through the relay and the hosted app (commercial);
 * - `control`: anything control does — claiming through control, organizations, the directory, the phone QR hand-off,
 *   managed rollouts (commercial);
 * - `remote_help`: Whombat support's remote help (commercial);
 * - `licence`: the subscription and its limits (commercial);
 * - `phone_push`: notifications on Android and iOS, which go through control (commercial);
 * - `local_claim`: the four-letter claim on the box's own page, without control (community, `enroll.claim.local*`).
 */
export const EDITION_PARTS = [
  'relay',
  'control',
  'remote_help',
  'licence',
  'phone_push',
  'local_claim',
] as const;
export type EditionPart = (typeof EDITION_PARTS)[number];

const COMMUNITY_PARTS: ReadonlySet<EditionPart> = new Set<EditionPart>(['local_claim']);

/** Whether a box of this edition has the part. Everything else (Web Push, mail, Tailscale, invites) is in both. */
export function editionHas(edition: Edition | null | undefined, part: EditionPart): boolean {
  return editionOf(edition) === 'community' ? COMMUNITY_PARTS.has(part) : part !== 'local_claim';
}
