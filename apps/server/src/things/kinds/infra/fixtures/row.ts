/** A connection row for the infra kinds' pure tests: only what pages and buttons read. */
import type { CatalogConnectionRow } from '../../../../connections/types';

export function rowOf(
  catalogId: string,
  access: 'manage' | 'read' = 'manage',
  fields: Record<string, string> = {},
): CatalogConnectionRow {
  return {
    id: 'con_test',
    catalogId,
    label: 'Test',
    access,
    scope: 'shared',
    fields,
    baseUrl: fields.url ?? 'https://service.example.com',
    signIn: 'token',
    transport: 'rest',
    credentialVersion: 1,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  } as unknown as CatalogConnectionRow;
}

/** A page's buttons' connection: Manage, or Look only. */
export const buttonsOf = (catalogId: string, access: 'manage' | 'read' = 'manage') => ({
  row: rowOf(catalogId, access),
});
