import { z } from 'zod';
import { LOCALE_TAG_RE } from './locale.js';

/**
 * A BCP-47 language with an optional script and region (`nl`, `en-GB`, `zh-Hant-TW`). Kept apart from `locale.ts`
 * so a bundle that only translates can load the runtime without the schema library.
 */
export const LocaleTag = z.string().min(2).max(35).regex(LOCALE_TAG_RE);
export type LocaleTag = z.infer<typeof LocaleTag>;
