import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { isDatabaseUrl, postgresConnection } from './url';

describe('postgresConnection (MR-75)', () => {
  it('turns libpq’s unix-socket form into a URL and a socket directory', () => {
    expect(postgresConnection('postgresql://whombat@/whombat?host=/run/postgresql')).toEqual({
      url: 'postgresql://whombat@localhost/whombat',
      host: '/run/postgresql',
    });
    expect(postgresConnection('postgres:///whombat?host=/tmp&sslmode=disable')).toEqual({
      url: 'postgres://localhost/whombat?sslmode=disable',
      host: '/tmp',
    });
  });

  it('makes postgres.js connect to the socket as the URL’s user, to the URL’s database', async () => {
    const t = postgresConnection('postgresql://whombat@/whombat?host=/run/postgresql');
    const sql = postgres(t.url, { host: t.host });
    expect(sql.options).toMatchObject({
      path: '/run/postgresql/.s.PGSQL.5432',
      user: 'whombat',
      database: 'whombat',
    });
    await sql.end();
  });

  it('passes every other URL through', () => {
    for (const url of [
      'postgres://whombat:whombat@localhost:55432/whombat',
      'postgresql://whombat@db.internal/whombat?host=/run/postgresql',
      'postgresql://whombat@/whombat?host=db.internal',
      'postgresql://whombat@/whombat',
    ])
      expect(postgresConnection(url)).toEqual({ url });
  });

  it('accepts the appliance’s URL as a database URL, and still refuses garbage', () => {
    expect(isDatabaseUrl('postgresql://whombat@/whombat?host=/run/postgresql')).toBe(true);
    expect(isDatabaseUrl('postgres://whombat:whombat@localhost:55432/whombat')).toBe(true);
    expect(isDatabaseUrl('not a url')).toBe(false);
  });
});
