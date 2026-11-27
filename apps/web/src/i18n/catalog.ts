/**
 * The web app's catalogs for the repository's i18n checks and exports (`scripts/i18n/registry.ts`). Runtime code never
 * imports this file: it would put the Dutch words in every English page. The app reads `en.ts` directly and loads
 * `nl.ts` only when Dutch is shown (`provider.tsx`).
 */
export { EN } from './en';
export { NL } from './nl';
