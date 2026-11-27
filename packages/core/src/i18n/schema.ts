import { z } from 'zod';
import { LOCALE_TAG_RE } from './locale.js';

/**
 * A BCP-47 locale tag (`en-GB`, `nl-NL`, `nl`, `de-DE`) as a schema. Kept apart from `locale.ts` so a bundle that only
 * translates never loads the schema library.
 */
export const LocaleTag = z.string().min(2).max(35).regex(LOCALE_TAG_RE);
export type LocaleTag = z.infer<typeof LocaleTag>;
