import { customType, timestamp } from 'drizzle-orm/pg-core';

/** `timestamptz` read as a JS Date. Convert with `iso()` when building contract objects. */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Postgres `tsvector` (only ever written by a generated column). */
export const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

/** Postgres `bytea` as a Node Buffer (Yjs snapshots). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
