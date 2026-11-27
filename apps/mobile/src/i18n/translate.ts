import { createTranslator } from '@whombat/core/i18n';
import { EN, NL } from './catalog';

export const mobileTranslator = (locale?: string | null) => createTranslator({ en: EN, nl: NL }, locale);
