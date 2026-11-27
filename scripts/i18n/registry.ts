/**
 * Central registry of every co-located i18n catalog in the monorepo (docs/decisions/i18n.md I18N-02).
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

export async function loadCatalogs(): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const candidates: Array<{ name: string; load: () => Promise<CatalogEntry | null> }> = [
    {
      name: 'core',
      load: async () => tryLoad('core', '../../packages/core/src/i18n/catalog'),
    },
    {
      name: 'client',
      load: async () => tryLoad('client', '../../packages/client/src/i18n/catalog'),
    },
    {
      name: 'screen',
      load: async () => tryLoad('screen', '../../packages/screen/src/i18n/catalog'),
    },
    {
      name: 'server',
      load: async () => tryLoad('server', '../../apps/server/src/i18n/catalog'),
    },
    {
      name: 'web',
      load: async () => tryLoad('web', '../../apps/web/src/i18n/catalog'),
    },
    {
      name: 'mobile',
      load: async () => tryLoad('mobile', '../../apps/mobile/src/i18n/catalog'),
    },
    {
      name: 'widget',
      load: async () => tryLoad('widget', '../../apps/widget/src/i18n/catalog'),
    },
    {
      name: 'console-ui',
      load: async () => tryLoad('console-ui', '../../appliance/console/ui/src/i18n/catalog'),
    },
  ];
  for (const c of candidates) {
    const loaded = await c.load();
    if (loaded) entries.push(loaded);
  }
  return entries;
}

async function tryLoad(name: string, specifier: string): Promise<CatalogEntry | null> {
  try {
    const mod = (await import(specifier)) as {
      EN?: MessageCatalog;
      NL?: MessageCatalog;
      CONTEXT?: Readonly<Record<string, string>>;
    };
    if (!mod.EN || !mod.NL) return null;
    return {
      name,
      en: mod.EN,
      locales: { nl: mod.NL },
      ...(mod.CONTEXT ? { context: mod.CONTEXT } : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
    throw err;
  }
}
