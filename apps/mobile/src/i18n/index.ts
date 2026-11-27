import { createCatalogHook } from '@whombat/client/i18n/react';
import { EN, NL } from './catalog';

export { useI18n } from '@whombat/client/i18n/react';

const catalogs = { en: EN, nl: NL };
export const useMobileT = createCatalogHook(catalogs);
export { mobileTranslator } from './translate';
