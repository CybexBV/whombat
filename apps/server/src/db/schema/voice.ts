/**
 * Voice typing's settings (docs/decisions/dictation.md): the box's, since a Whombat is one person's.
 * At most one row (`id` = 1); no row means the defaults (on, Automatic, Automatic). Written only through the commit
 * pipeline (`voice/store.ts`). The speech models themselves are the model fetcher's, not the database's.
 */
import type { VoiceLanguage, VoiceModelChoice } from '@whombat/core/domain';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';

export const voiceTyping = pgTable(
  'voice_typing',
  {
    /** Always 1. */
    id: integer('id').primaryKey(),
    /** *Voice typing*. */
    enabled: boolean('enabled').notNull().default(true),
    /** *Speech model*: `auto`, `parakeet` (Fast) or `whisper` (Most accurate). */
    model: text('model').$type<VoiceModelChoice>().notNull().default('auto'),
    /** *Language*: `auto`, `en` or `nl`. */
    language: text('language').$type<VoiceLanguage>().notNull().default('auto'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    check('voice_typing_one', sql`${t.id} = 1`),
    check('voice_typing_model', sql`${t.model} IN ('auto', 'parakeet', 'whisper')`),
    check('voice_typing_language', sql`${t.language} IN ('auto', 'en', 'nl')`),
  ],
);
