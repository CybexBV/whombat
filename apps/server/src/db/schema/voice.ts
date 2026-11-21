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
    /** *Dutch voice* (Supertonic 3, BigScience Open RAIL-M): off until the person agrees to its licence. */
    dutchVoice: boolean('dutch_voice').notNull().default(false),
    /** Principal id of the person who agreed to the Dutch voice licence; null when off. */
    dutchVoiceAgreedBy: text('dutch_voice_agreed_by'),
    /** When the person agreed to the Dutch voice licence; null when off. */
    dutchVoiceAgreedAt: ts('dutch_voice_agreed_at'),
    /** Licence version agreed to for the Dutch voice; null when off. */
    dutchVoiceLicenceVersion: text('dutch_voice_licence_version'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    check('voice_typing_one', sql`${t.id} = 1`),
    check('voice_typing_model', sql`${t.model} IN ('auto', 'parakeet', 'whisper')`),
    check('voice_typing_language', sql`${t.language} IN ('auto', 'en', 'nl')`),
    check(
      'voice_typing_dutch_agreement',
      sql`NOT ${t.dutchVoice} OR (${t.dutchVoiceAgreedBy} IS NOT NULL AND ${t.dutchVoiceAgreedAt} IS NOT NULL AND ${t.dutchVoiceLicenceVersion} IS NOT NULL)`,
    ),
  ],
);
