import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { targetFromEnv } from './schema';

// `--env` as the appliance's update helper runs it (MD-10, MR-73): the runtime user, NODE_ENV=production,
// and WHOMBAT_ENV_FILE, none of the server's secrets.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whombat-schema-env-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const helperEnv = (file: string) => ({
  PATH: '/run/current-system/sw/bin',
  LANG: 'C.UTF-8',
  NODE_ENV: 'production',
  WHOMBAT_ENV_FILE: file,
});

function envFile(text: string, mode: number): string {
  const file = join(dir, 'runtime.env');
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

describe('targetFromEnv', () => {
  it('takes the database from WHOMBAT_ENV_FILE without the server configuration', () => {
    const file = envFile(
      'NODE_ENV=production\nDATABASE_URL=postgresql://whombat@/whombat?host=/run/postgresql\n',
      0o600,
    );
    expect(targetFromEnv(helperEnv(file)).url).toBe('postgresql://whombat@/whombat?host=/run/postgresql');
  });

  it('refuses a file readable by group or others in production, as the server does', () => {
    const file = envFile('DATABASE_URL=postgresql://whombat@/whombat\n', 0o640);
    expect(() => targetFromEnv(helperEnv(file))).toThrow(/readable by group or others/);
    expect(targetFromEnv({ ...helperEnv(file), NODE_ENV: 'development' }).url).toBe(
      'postgresql://whombat@/whombat',
    );
  });

  it('prefers DATABASE_URL from the environment; says so when neither names a database', () => {
    const file = envFile('DATABASE_URL=postgresql://from-file@/x\n', 0o600);
    expect(targetFromEnv({ ...helperEnv(file), DATABASE_URL: 'postgresql://from-env@/y' }).url).toBe(
      'postgresql://from-env@/y',
    );
    expect(() => targetFromEnv(helperEnv(envFile('NODE_ENV=production\n', 0o600)))).toThrow(
      /no DATABASE_URL/,
    );
    expect(() => targetFromEnv(helperEnv(join(dir, 'missing.env')))).toThrow(/cannot read/);
  });
});
