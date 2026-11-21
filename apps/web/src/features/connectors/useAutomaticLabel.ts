import { useCatalogConnections } from '@whombat/client/react';
import { type CatalogEntry, defaultConnectionLabel } from '@whombat/core/domain';

/**
 * The name a new connection gets when the person types none (Whombat home-redesign.md HR-07; app home-redesign.md
 * AP-2218): the service's name, with its address only beside a connection of the same service, as the server decides.
 */
export function useAutomaticLabel(
  burrow: string,
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
): string {
  const list = useCatalogConnections({ params: { burrow } }, { retry: false });
  const sameServiceExists = (list.data?.connections ?? []).some((c) => c.catalogId === entry.id);
  return defaultConnectionLabel(entry, fields, {
    onlyOne: !sameServiceExists && entry.category !== 'custom',
  });
}
