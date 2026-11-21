/**
 * The drop's keys in the runtime (docs/decisions/feedback-drop.md FD-07 … FD-09): one Ed25519 site signing key for
 * all sites (its `fbk_…` pin is the snippet's `data-key`; made once, never rotated automatically) and X25519
 * encryption keys, one current, replaced every 30 days and kept 22 days after their successor became current.
 *
 * Private halves are sealed with the master key (`KeyCustody.seal`, AAD `feedback_drop_key:<kid>`), so a backup
 * carries them sealed and the master key restores them. Appliance infrastructure written here directly, not burrow
 * commands; creation and rotation are logged at info, without key material.
 */
import {
  dropKeyId,
  dropPublicKeyOf,
  FEEDBACK_DROP_KEY_RETAIN_S,
  FEEDBACK_DROP_KEY_ROTATE_S,
  generateDropKeyPair,
  generateSiteSigningKey,
  siteSigningKeyOf,
} from '@whombat/core/feedback/drop';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { feedbackDropKeys } from '../../db/schema/index';
import type { Services } from '../../services';

export function dropKeyAad(kid: string): string {
  return `feedback_drop_key:${kid}`;
}

export interface SigningKey {
  seed: Uint8Array;
  /** base64url, what `card.signingKey` carries. */
  publicKey: string;
  /** `fbk_…`: the snippet's `data-key`. */
  fingerprint: string;
}

export interface EncryptionKey {
  kid: string;
  /** base64url, what `card.encryption.publicKey` carries. */
  publicKey: string;
  currentSince: Date;
}

/** Serializes key creation and rotation (one runtime, but two quick calls must not both create a key). */
const KEY_LOCK = sql`select pg_advisory_xact_lock(hashtext('whombat:feedback_drop_keys'))`;

export class DropKeys {
  /** Opened private keys by kid (the rows are immutable; a deleted key is dropped by `sweep`). */
  readonly #opened = new Map<string, Uint8Array>();

  constructor(private readonly services: Services) {}

  #open(kid: string, sealed: string): Uint8Array {
    let key = this.#opened.get(kid);
    if (!key) {
      key = new Uint8Array(Buffer.from(this.services.custody.open(dropKeyAad(kid), sealed), 'base64url'));
      this.#opened.set(kid, key);
    }
    return key;
  }

  #seal(kid: string, key: Uint8Array): string {
    return this.services.custody.seal(dropKeyAad(kid), Buffer.from(key).toString('base64url'));
  }

  /** The site signing key, made when `create` and there is none yet (the first integration, FD-26). */
  async signingKey(options: { create: boolean }): Promise<SigningKey | null> {
    const existing = await this.#currentSigning();
    if (existing || !options.create) return existing;
    return this.services.db.transaction(async (tx) => {
      await tx.execute(KEY_LOCK);
      const [row] = await tx
        .select()
        .from(feedbackDropKeys)
        .where(and(eq(feedbackDropKeys.kind, 'signing'), isNull(feedbackDropKeys.retiredAt)));
      if (row) return this.#signingOf(row);
      const made = generateSiteSigningKey();
      const now = this.services.clock();
      await tx.insert(feedbackDropKeys).values({
        kid: made.fingerprint,
        kind: 'signing',
        publicKey: made.publicKey,
        privateSealed: this.#seal(made.fingerprint, made.seed),
        createdAt: now,
        currentSince: now,
      });
      this.services.log.info({ key: made.fingerprint }, 'feedback drop: site signing key created');
      return { seed: made.seed, publicKey: made.publicKey, fingerprint: made.fingerprint };
    });
  }

  async #currentSigning(): Promise<SigningKey | null> {
    const [row] = await this.services.db
      .select()
      .from(feedbackDropKeys)
      .where(and(eq(feedbackDropKeys.kind, 'signing'), isNull(feedbackDropKeys.retiredAt)));
    return row ? this.#signingOf(row) : null;
  }

  #signingOf(row: typeof feedbackDropKeys.$inferSelect): SigningKey {
    const seed = this.#open(row.kid, row.privateSealed);
    const derived = siteSigningKeyOf(seed);
    // A row whose public half doesn't match its seed is corrupt: never sign with it.
    if (derived.publicKey !== row.publicKey || derived.fingerprint !== row.kid)
      throw new Error('feedback drop: the stored signing key does not match its public key');
    return { seed, publicKey: derived.publicKey, fingerprint: derived.fingerprint };
  }

  /** The `data-key` pin, or null before the key exists. */
  async fingerprint(): Promise<string | null> {
    const [row] = await this.services.db
      .select({ kid: feedbackDropKeys.kid })
      .from(feedbackDropKeys)
      .where(and(eq(feedbackDropKeys.kind, 'signing'), isNull(feedbackDropKeys.retiredAt)));
    return row?.kid ?? null;
  }

  /** Whether the current encryption key is missing or due for replacement (30 days, FD-08). */
  async rotationDue(): Promise<boolean> {
    const current = await this.#currentEncryption();
    return !current || this.#due(current.currentSince);
  }

  #due(currentSince: Date): boolean {
    return this.services.clock().getTime() - currentSince.getTime() >= FEEDBACK_DROP_KEY_ROTATE_S * 1000;
  }

  async #currentEncryption(): Promise<EncryptionKey | null> {
    const [row] = await this.services.db
      .select()
      .from(feedbackDropKeys)
      .where(and(eq(feedbackDropKeys.kind, 'encryption'), isNull(feedbackDropKeys.retiredAt)));
    return row ? { kid: row.kid, publicKey: row.publicKey, currentSince: row.currentSince } : null;
  }

  /**
   * The current encryption key: made when there is none, replaced when it is 30 days old (the retired one is kept
   * 22 more days, FD-08). Cards are issued with it.
   */
  async currentEncryptionKey(): Promise<EncryptionKey> {
    const current = await this.#currentEncryption();
    if (current && !this.#due(current.currentSince)) return current;
    return this.services.db.transaction(async (tx) => {
      await tx.execute(KEY_LOCK);
      const [row] = await tx
        .select()
        .from(feedbackDropKeys)
        .where(and(eq(feedbackDropKeys.kind, 'encryption'), isNull(feedbackDropKeys.retiredAt)));
      if (row && !this.#due(row.currentSince))
        return { kid: row.kid, publicKey: row.publicKey, currentSince: row.currentSince };
      const now = this.services.clock();
      if (row)
        await tx
          .update(feedbackDropKeys)
          .set({ retiredAt: now, deleteAfter: new Date(now.getTime() + FEEDBACK_DROP_KEY_RETAIN_S * 1000) })
          .where(eq(feedbackDropKeys.kid, row.kid));
      const made = generateDropKeyPair();
      await tx.insert(feedbackDropKeys).values({
        kid: made.kid,
        kind: 'encryption',
        publicKey: made.publicKeyB64,
        privateSealed: this.#seal(made.kid, made.privateKey),
        createdAt: now,
        currentSince: now,
      });
      this.services.log.info(
        { kid: made.kid, retired: row?.kid ?? null },
        row ? 'feedback drop: encryption key rotated' : 'feedback drop: encryption key created',
      );
      return { kid: made.kid, publicKey: made.publicKeyB64, currentSince: now };
    });
  }

  /** The X25519 private key of `kid` while it is kept (current or retired within 22 days), else null. */
  async privateKeyFor(kid: string): Promise<Uint8Array | null> {
    const [row] = await this.services.db
      .select()
      .from(feedbackDropKeys)
      .where(and(eq(feedbackDropKeys.kid, kid), eq(feedbackDropKeys.kind, 'encryption')));
    if (!row) return null;
    if (row.deleteAfter && row.deleteAfter.getTime() <= this.services.clock().getTime()) return null;
    const key = this.#open(row.kid, row.privateSealed);
    if (dropPublicKeyOf(key) !== row.publicKey || dropKeyId(row.publicKey) !== row.kid) return null;
    return key;
  }

  /** Deletes retired encryption keys past their 22 days (the hourly check). */
  async sweep(): Promise<number> {
    const gone = await this.services.db
      .delete(feedbackDropKeys)
      .where(
        and(isNotNull(feedbackDropKeys.deleteAfter), lt(feedbackDropKeys.deleteAfter, this.services.clock())),
      )
      .returning({ kid: feedbackDropKeys.kid });
    for (const { kid } of gone) this.#opened.delete(kid);
    if (gone.length)
      this.services.log.info(
        { kids: gone.map((g) => g.kid) },
        'feedback drop: retired encryption keys deleted',
      );
    return gone.length;
  }
}
