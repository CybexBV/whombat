/**
 * Central registry of every co-located i18n catalog in the monorepo (docs/decisions/i18n.md).
 * Each package owns its own declarative English and translated catalogs; this registry lets
 * `scripts/i18n/check.ts` and `scripts/i18n/po.ts` validate and export all of them together.
 */
import type { MessageCatalog, SupportedLanguage } from '../../packages/core/src/i18n/index';

export interface CatalogEntry {
  /** Package / surface identifier, e.g. `core`, `client`, `web`, `server`. */
  name: string;
  /** Canonical English messages. */
  en: MessageCatalog;
  /** Translations keyed by non-English supported language. */
  locales: Record<Exclude<SupportedLanguage, 'en'>, MessageCatalog>;
  /** Optional translator context notes keyed by message key. */
  context?: Readonly<Record<string, string>>;
}

interface RawCatalogModule {
  EN?: MessageCatalog;
  NL?: MessageCatalog;
  CONTEXT?: Readonly<Record<string, string>>;
}

const LOADERS: ReadonlyArray<{ name: string; load: () => Promise<RawCatalogModule> }> = [
  { name: 'core', load: () => import('../../packages/core/src/i18n/catalog.ts') },
  { name: 'client', load: () => import('../../packages/client/src/i18n/catalog.ts') },
  { name: 'screen', load: () => import('../../packages/screen/src/i18n/catalog.ts') },
  { name: 'server', load: () => import('../../apps/server/src/i18n/catalog.ts') },
  { name: 'web', load: () => import('../../apps/web/src/i18n/catalog.ts') },
  { name: 'mobile', load: () => import('../../apps/mobile/src/i18n/catalog.ts') },
  { name: 'widget', load: () => import('../../apps/widget/src/i18n/catalog.ts') },
  { name: 'console-ui', load: () => import('../../appliance/console/ui/src/i18n/catalog.ts') },
];

export async function loadCatalogs(): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const item of LOADERS) {
    const mod = await item.load();
    if (!mod.EN || !mod.NL) {
      throw new Error(`i18n catalog "${item.name}" is missing EN or NL exports`);
    }
    entries.push({
      name: item.name,
      en: mod.EN,
      locales: { nl: mod.NL },
      ...(mod.CONTEXT ? { context: mod.CONTEXT } : {}),
    });
  }
  return entries;
}
