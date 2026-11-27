/**
 * The box's language is its owner's: another account changing its own language never changes what the box says.
 */
import { describe, expect, it } from 'vitest';
import type { Services } from '../services';
import { boxLocale, configuredAccountLocale, notifyLocaleChanged } from './locale';

/** A database with these accounts, oldest (the owner) first. */
function servicesWith(accounts: { id: string; locale: string | null }[]): {
  services: Services;
  reads: () => number;
} {
  let reads = 0;
  const rows = accounts.map((a) => ({ id: a.id, preferences: a.locale ? { locale: a.locale } : {} }));
  const db = {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: async () => {
            reads += 1;
            return rows.slice(0, 1);
          },
        }),
        where: async () => rows.slice(1, 2),
      }),
    }),
  };
  return { services: { db } as unknown as Services, reads: () => reads };
}

describe('the box’s locale', () => {
  it('follows the owner’s change and ignores another account’s', async () => {
    const { services } = servicesWith([
      { id: 'acc_owner', locale: 'en-GB' },
      { id: 'acc_mate', locale: 'nl-NL' },
    ]);
    expect(await boxLocale(services)).toBe('en-GB');
    notifyLocaleChanged(services, 'acc_mate', 'nl-NL');
    expect(await boxLocale(services)).toBe('en-GB');
    expect(await configuredAccountLocale(services, 'acc_mate')).toBe('nl-NL');
    expect(await boxLocale(services)).toBe('en-GB');
    notifyLocaleChanged(services, 'acc_owner', 'nl-NL');
    expect(await boxLocale(services)).toBe('nl-NL');
  });

  it('checks a change made before the owner is known against the database', async () => {
    const { services, reads } = servicesWith([
      { id: 'acc_owner', locale: 'en-GB' },
      { id: 'acc_mate', locale: 'nl-NL' },
    ]);
    notifyLocaleChanged(services, 'acc_mate', 'nl-NL');
    expect(await boxLocale(services)).toBe('en-GB');
    expect(await boxLocale(services)).toBe('en-GB');
    expect(reads()).toBe(1);
  });

  it('uses the change it was told while the database can’t be read', async () => {
    const services = { db: {} } as unknown as Services;
    notifyLocaleChanged(services, 'acc_1', 'nl-NL');
    expect(await boxLocale(services)).toBe('nl-NL');
  });
});
