import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { DatabaseFailure, errorForLog, isDatabaseError, sqlState, withoutValues } from './db-errors';

/** A failed insert as drizzle and the driver throw it: the statement and its values, and the driver's own words. */
function failedInsert(): Error {
  const driver = Object.assign(
    new Error('duplicate key value violates unique constraint "accounts_email_unique"'),
    {
      code: '23505',
      detail: 'Key (email)=(zebedee.quince@example.com) already exists.',
      constraint_name: 'accounts_email_unique',
      table_name: 'accounts',
    },
  );
  return new DrizzleQueryError(
    'insert into "accounts" ("id", "email", "name") values ($1, $2, $3)',
    ['acc_1', 'zebedee.quince@example.com', 'Zebedee Quince'],
    driver,
  );
}

describe('what a log may say of a failed database statement', () => {
  it('is its class, its error code and the schema’s own names: never a value', () => {
    const about = errorForLog(failedInsert());
    expect(about).toEqual({
      err: 'DrizzleQueryError',
      sqlState: '23505',
      constraint: 'accounts_email_unique',
      table: 'accounts',
    });
    const text = JSON.stringify(about);
    for (const value of ['Zebedee', 'zebedee.quince', 'insert into']) expect(text).not.toContain(value);
  });

  it('keeps the text and stack of anything else', () => {
    const about = errorForLog(new TypeError('x is not a function'));
    expect(about.err).toBe('TypeError: x is not a function');
    expect(about.stack).toContain('TypeError');
  });

  it('knows a failed statement without an error code (a lost connection) by its values', () => {
    const lost = new DrizzleQueryError(
      'select 1',
      ['zebedee.quince@example.com'],
      new Error('socket closed'),
    );
    expect(isDatabaseError(lost)).toBe(true);
    expect(JSON.stringify(errorForLog(lost))).not.toContain('zebedee');
  });
});

describe('a failure passed on without its values', () => {
  it('keeps the error code where it is looked for, and nothing of the statement', () => {
    const passed = withoutValues(failedInsert());
    expect(passed).toBeInstanceOf(DatabaseFailure);
    expect(sqlState(passed)).toBe('23505');
    const all = `${String(passed)} ${(passed as Error).stack} ${JSON.stringify(passed)} ${JSON.stringify(errorForLog(passed))}`;
    for (const value of ['Zebedee', 'zebedee.quince', 'insert into']) expect(all).not.toContain(value);
    expect((passed as { cause?: unknown }).cause).toBeUndefined();
  });

  it('leaves other errors as they are', () => {
    const other = new Error('not the database');
    expect(withoutValues(other)).toBe(other);
  });
});
