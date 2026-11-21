/**
 * Collaboration tokens (`canvases.collabToken`): short-lived, stateless, HMAC-signed grants to open one
 * canvas document on a collab stream as one principal. `wct_<base64url(payload)>.<base64url(hmac)>`, keyed from
 * `WHOMBAT_MASTER_KEY`. The token only opens the connection: access is checked when it is issued and again when it
 * is used, and the collaboration service disconnects an agent whose dispatch ended.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DEV_MASTER_KEY_CONTEXT } from '../keys/custody';

export const COLLAB_TOKEN_TTL_MS = 5 * 60_000;

export const CollabTokenPayload = z.object({
  v: z.literal(1),
  /** Canvas id. */
  c: z.string(),
  /** Burrow id. */
  b: z.string(),
  /** Principal id. */
  p: z.string(),
  /** Agent dispatch behind it. */
  d: z.string().nullable(),
  /** Expiry, epoch ms. */
  e: z.number().int(),
});
export type CollabTokenPayload = z.infer<typeof CollabTokenPayload>;

export class CollabTokens {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string | undefined) {
    const master = masterKeyBase64
      ? Buffer.from(masterKeyBase64, 'base64')
      : createHash('sha256').update(DEV_MASTER_KEY_CONTEXT).digest();
    this.key = createHash('sha256').update('whombat/collab-token/v1').update(master).digest();
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  issue(input: Omit<CollabTokenPayload, 'v' | 'e'>, now: Date, ttlMs = COLLAB_TOKEN_TTL_MS) {
    const payload: CollabTokenPayload = { v: 1, ...input, e: now.getTime() + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `wct_${body}.${this.sign(body)}`, expiresAt: new Date(payload.e) };
  }

  /** The payload of a well-signed, unexpired token; null otherwise. */
  verify(token: string, now: Date): CollabTokenPayload | null {
    const m = /^wct_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!m) return null;
    const [, body, sig] = m as unknown as [string, string, string];
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const payload = CollabTokenPayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      return payload.e > now.getTime() ? payload : null;
    } catch {
      return null;
    }
  }
}
