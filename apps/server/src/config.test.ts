import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PASSKEY_ANDROID_ORIGINS } from '@whombat/protocol/session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertServer,
  DEV_APP_URL,
  loadConfig,
  loadDotEnv,
  managedAppOrigin,
  managedEmbedOrigin,
  managedPasskeyRelyingParty,
  readLicenceKeySet,
  serverIssues,
  useBoxPageAsApp,
} from './config';

/** The licence key set managed suites use (TEST, `managed/testing.ts` signs with it). */
const TEST_LICENCE_KEYS = join(import.meta.dirname, 'managed/__fixtures__/licence-keys.json');

describe('loadConfig', () => {
  it('talks to the real Google by default, the fake one in tests and the demo (connectors.md CN-08)', () => {
    expect(loadConfig({}).WHOMBAT_GOOGLE).toBe('real');
    expect(loadConfig({ NODE_ENV: 'test' }).WHOMBAT_GOOGLE).toBe('fake');
    expect(loadConfig({ WHOMBAT_DEMO: '1' }).WHOMBAT_GOOGLE).toBe('fake');
    expect(loadConfig({ WHOMBAT_GOOGLE: 'off' }).WHOMBAT_GOOGLE).toBe('off');
    expect(() =>
      loadConfig({ WHOMBAT_GOOGLE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com' }),
    ).toThrow(
      /WHOMBAT_GOOGLE_CLIENT_SECRET: set WHOMBAT_GOOGLE_CLIENT_ID and WHOMBAT_GOOGLE_CLIENT_SECRET together/,
    );
    const both = loadConfig({
      WHOMBAT_GOOGLE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com',
      WHOMBAT_GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
    });
    expect(both.WHOMBAT_GOOGLE_CLIENT_SECRET).toBe('GOCSPX-secret');
  });

  it('validates the master key and requires it in production', () => {
    expect(() => loadConfig({ WHOMBAT_MASTER_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/WHOMBAT_MASTER_KEY/);
    const key = Buffer.alloc(32, 7).toString('base64');
    const rest = {
      DATABASE_URL: 'postgres://w:w@127.0.0.1:55440/whombat',
      RUNNER_TOKEN: 'r'.repeat(40),
      WHOMBAT_MANAGER_SOCKET: '/run/whombat-manager/api.sock',
      WHOMBAT_CONTENT_KEY_FILE: '/persist/identity/content.key',
    };
    expect(loadConfig({ NODE_ENV: 'production', WHOMBAT_MASTER_KEY: key, ...rest }).WHOMBAT_MASTER_KEY).toBe(
      key,
    );
  });

  it('listens on loopback only: clients come through sessions (MA-10)', () => {
    expect(loadConfig({}).HOST).toBe('127.0.0.1');
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/HOST: must be loopback/);
  });

  it('stands in for the box outside production (HE-49): no licence, the dev hosted UI, the admin socket at home', () => {
    const dev = loadConfig({ WHOMBAT_HOME: '/tmp/wb-home' });
    expect(dev.WHOMBAT_LICENCE).toBe('off');
    expect(dev.WHOMBAT_APP_URL).toBe(DEV_APP_URL);
    expect(dev.WHOMBAT_ADMIN_SOCKET).toBe('/tmp/wb-home/admin.sock');
    expect(dev.WHOMBAT_MANAGER_SOCKET).toBeUndefined();
    expect(loadConfig({ WHOMBAT_LICENCE: 'on' }).WHOMBAT_LICENCE).toBe('on');
  });

  it('keeps the outbound private-address allowance out of production', () => {
    expect(loadConfig({}).WHOMBAT_OUTBOUND_ALLOW_PRIVATE).toBe(false);
    expect(loadConfig({ WHOMBAT_OUTBOUND_ALLOW_PRIVATE: 'true' }).WHOMBAT_OUTBOUND_ALLOW_PRIVATE).toBe(true);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(() =>
      loadConfig({ NODE_ENV: 'production', WHOMBAT_MASTER_KEY: key, WHOMBAT_OUTBOUND_ALLOW_PRIVATE: 'true' }),
    ).toThrow(/WHOMBAT_OUTBOUND_ALLOW_PRIVATE/);
  });
});

describe('secrets from files and production validation', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const token = 'r'.repeat(40);
  let dir: string;
  const secret = (name: string, value: string, mode = 0o600) => {
    const file = join(dir, name);
    writeFileSync(file, value, { mode });
    chmodSync(file, mode);
    return file;
  };
  const production = (extra: Record<string, string> = {}) => ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://whombat:secret@127.0.0.1:55440/whombat',
    WHOMBAT_MASTER_KEY: key,
    RUNNER_TOKEN: token,
    WHOMBAT_MANAGER_SOCKET: '/run/whombat-manager/api.sock',
    WHOMBAT_CONTENT_KEY_FILE: '/persist/identity/content.key',
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whombat-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses both a value and its file, relative paths, missing and empty files', () => {
    const file = secret('token', token);
    expect(() => loadConfig({ RUNNER_TOKEN: token, RUNNER_TOKEN_FILE: file })).toThrow(
      /RUNNER_TOKEN: set either RUNNER_TOKEN or RUNNER_TOKEN_FILE, not both/,
    );
    expect(() => loadConfig({ RUNNER_TOKEN_FILE: 'token' })).toThrow(/must be an absolute path/);
    expect(() => loadConfig({ RUNNER_TOKEN_FILE: join(dir, 'nope') })).toThrow(/cannot read .*ENOENT/);
    expect(() => loadConfig({ RUNNER_TOKEN_FILE: secret('empty', '\n') })).toThrow(/is empty/);
  });

  it('refuses secret files readable by others in production only', () => {
    const loose = secret('master-key', key, 0o644);
    expect(loadConfig({ WHOMBAT_MASTER_KEY_FILE: loose }).WHOMBAT_MASTER_KEY).toBe(key);
    const env = production({ WHOMBAT_MASTER_KEY: '', WHOMBAT_MASTER_KEY_FILE: loose });
    expect(() => loadConfig(env)).toThrow(/readable by group or others .*chmod 600/);
  });

  it('takes 0440 credential files from a private systemd credentials directory (MR-74)', () => {
    const creds = join(dir, 'credentials');
    mkdirSync(creds);
    const file = join(creds, 'master-key');
    writeFileSync(file, key);
    chmodSync(file, 0o440);
    chmodSync(creds, 0o550);
    const env = production({ WHOMBAT_MASTER_KEY: '', WHOMBAT_MASTER_KEY_FILE: file });
    expect(loadConfig({ ...env, CREDENTIALS_DIRECTORY: creds }).WHOMBAT_MASTER_KEY).toBe(key);
    // Anywhere else, or when others may open the directory, the mode rule holds.
    expect(() => loadConfig(env)).toThrow(/readable by group or others/);
    chmodSync(creds, 0o755);
    expect(() => loadConfig({ ...env, CREDENTIALS_DIRECTORY: creds })).toThrow(/readable by group or others/);
    chmodSync(creds, 0o750);
  });

  it('production needs a manager and an identity; the licence is off whatever is set (whombat-link.md LNK-04)', () => {
    const cfg = loadConfig(production());
    expect(cfg.WHOMBAT_LICENCE).toBe('off');
    expect(cfg.WHOMBAT_ADMIN_SOCKET).toBe('/run/whombat/admin.sock');
    // An older unit file that still says either parses: the runtime runs without a licence all the same.
    expect(loadConfig(production({ WHOMBAT_LICENCE: 'off' })).WHOMBAT_LICENCE).toBe('off');
    expect(loadConfig(production({ WHOMBAT_LICENCE: 'on' })).WHOMBAT_LICENCE).toBe('on');
    expect(() => loadConfig(production({ WHOMBAT_MANAGER_SOCKET: '' }))).toThrow(/WHOMBAT_MANAGER_SOCKET/);
    expect(() => loadConfig(production({ WHOMBAT_CONTENT_KEY_FILE: '' }))).toThrow(
      /WHOMBAT_CONTENT_KEY_FILE/,
    );
  });

  it('the old edition switch still parses but rules nothing (whombat-link.md LNK-01)', () => {
    expect(loadConfig({}).WHOMBAT_EDITION).toBe('commercial');
    for (const edition of ['community', 'commercial']) {
      const cfg = loadConfig(production({ WHOMBAT_EDITION: edition }));
      expect(cfg.WHOMBAT_LICENCE).toBe('off');
      // No box needs the hosted UI, and none is refused its direct port or a licence setting.
      expect(serverIssues(cfg)).toEqual([]);
      expect(() =>
        loadConfig(production({ WHOMBAT_EDITION: edition, WHOMBAT_DIRECT_PORT: 'off' })),
      ).not.toThrow();
      expect(() => loadConfig({ WHOMBAT_EDITION: edition, WHOMBAT_LICENCE: 'on' })).not.toThrow();
    }
    expect(() => loadConfig({ WHOMBAT_EDITION: 'enterprise' })).toThrow(/WHOMBAT_EDITION/);
  });

  it('a box’s own page stands for the hosted UI, even where the image names one (HE-S202, LNK-01)', () => {
    const box = loadConfig(production());
    expect(box.WHOMBAT_APP_URL).toBeUndefined();
    expect(serverIssues(box)).toEqual([]);
    expect(loadConfig({ WHOMBAT_EDITION: 'community' }).WHOMBAT_APP_URL).toBeUndefined();
    expect(() => managedAppOrigin(box)).toThrow(/WHOMBAT_APP_URL/);
    let page: string | null = 'http://192.168.1.20:4480/';
    useBoxPageAsApp(box, () => page);
    expect(managedAppOrigin(box)).toBe('http://192.168.1.20:4480');
    page = 'https://box.tail0000.ts.net:4480/';
    expect(managedAppOrigin(box)).toBe('https://box.tail0000.ts.net:4480');
    // Every environment names its hosted app now: the box's own page still wins, the hosted app stands in without one.
    const named = loadConfig(production({ WHOMBAT_APP_URL: 'https://app.whombat.com' }));
    expect(managedAppOrigin(named)).toBe('https://app.whombat.com');
    useBoxPageAsApp(named, () => page);
    expect(managedAppOrigin(named)).toBe('https://box.tail0000.ts.net:4480');
    page = null;
    expect(managedAppOrigin(named)).toBe('https://app.whombat.com');
  });

  it('secrets from systemd credentials, the admin socket in /run/whombat (NX-20, MR-37)', () => {
    const creds = mkdtempSync(join(tmpdir(), 'wb-creds-'));
    writeFileSync(join(creds, 'master-key'), key, { mode: 0o400 });
    writeFileSync(join(creds, 'runner-token'), token, { mode: 0o400 });
    writeFileSync(join(creds, 'content-identity'), 'x', { mode: 0o400 });
    writeFileSync(join(creds, 'claim'), '{}', { mode: 0o400 });
    const { WHOMBAT_MASTER_KEY: _k, RUNNER_TOKEN: _t, WHOMBAT_CONTENT_KEY_FILE: _c, ...rest } = production();
    const cfg = loadConfig({ ...rest, CREDENTIALS_DIRECTORY: creds });
    expect(cfg.WHOMBAT_MASTER_KEY).toBe(key);
    expect(cfg.RUNNER_TOKEN).toBe(token);
    expect(cfg.WHOMBAT_CONTENT_KEY_FILE).toBe(join(creds, 'content-identity'));
    expect(cfg.WHOMBAT_CLAIM_FILE).toBe(join(creds, 'claim'));
    expect(cfg.WHOMBAT_ADMIN_SOCKET).toBe('/run/whombat/admin.sock');
    expect(cfg.WHOMBAT_ADMIN_GROUP).toBe('whombat-admin');
    // Explicit settings win over credentials.
    expect(
      loadConfig({ ...rest, CREDENTIALS_DIRECTORY: creds, WHOMBAT_CONTENT_KEY_FILE: '/elsewhere' })
        .WHOMBAT_CONTENT_KEY_FILE,
    ).toBe('/elsewhere');
    rmSync(creds, { recursive: true, force: true });
  });

  it('a named hosted UI origin must be https (MR-45): http only on loopback outside production', () => {
    const managed = (extra: Record<string, string>) => loadConfig({ ...production(), ...extra });
    // loadConfig itself doesn't require it: the appliance's `whombat schema-check|migrate --env` share the config. No
    // box needs one any more (LNK-01).
    const without = managed({});
    expect(serverIssues(without)).toEqual([]);
    expect(() => assertServer(without)).not.toThrow();
    expect(serverIssues(managed({ WHOMBAT_APP_URL: 'https://app.whombat.com' }))).toEqual([]);
    expect(serverIssues(managed({ WHOMBAT_APP_URL: 'https://dev.whombat.com/' }))).toEqual([]);
    const plain = /WHOMBAT_APP_URL: must be an https:\/\/ origin/;
    expect(serverIssues(managed({ WHOMBAT_APP_URL: 'http://app.whombat.com' }))).toEqual([
      expect.stringMatching(plain),
    ]);
    expect(() => assertServer(managed({ WHOMBAT_APP_URL: 'http://app.whombat.com' }))).toThrow(
      /Invalid server configuration:\n {2}WHOMBAT_APP_URL: must be an https/,
    );
    // Production: never http, not even on loopback.
    expect(serverIssues(managed({ WHOMBAT_APP_URL: 'http://localhost:5173' }))).toEqual([
      expect.stringMatching(plain),
    ]);
    // Development: http on a loopback address (the dev harness's hosted UI), nowhere else.
    const dev = (url: string) => serverIssues(loadConfig({ NODE_ENV: 'development', WHOMBAT_APP_URL: url }));
    for (const url of ['http://localhost:5173', 'http://127.0.0.1:4700', 'http://[::1]:8080'])
      expect(dev(url)).toEqual([]);
    expect(dev('http://192.168.1.20:5173')).toEqual([expect.stringMatching(plain)]);
    // Only an origin (the schema): a path is refused by loadConfig.
    expect(() => managed({ WHOMBAT_APP_URL: 'https://app.whombat.com/appliances' })).toThrow(
      /WHOMBAT_APP_URL/,
    );
    // Outside production the development hosted UI stands in.
    expect(serverIssues(loadConfig({}))).toEqual([]);
  });

  it('the feedback widget’s embed origin (feedback-drop FD-31): WHOMBAT_EMBED_URL, else the hosted UI’s origin', () => {
    const managed = (extra: Record<string, string>) =>
      loadConfig({
        ...production(),
        WHOMBAT_LICENCE_KEYS_FILE: TEST_LICENCE_KEYS,
        WHOMBAT_APP_URL: 'https://app.whombat.com/',
        ...extra,
      });
    expect(managedEmbedOrigin(managed({}))).toBe('https://app.whombat.com');
    const embed = managed({ WHOMBAT_EMBED_URL: 'https://embed.whombat.com/' });
    expect(managedEmbedOrigin(embed)).toBe('https://embed.whombat.com');
    expect(serverIssues(embed)).toEqual([]);
    expect(serverIssues(managed({ WHOMBAT_EMBED_URL: 'http://embed.whombat.com' }))).toEqual([
      expect.stringMatching(/^WHOMBAT_EMBED_URL: must be an https:\/\/ origin/),
    ]);
    expect(() => managed({ WHOMBAT_EMBED_URL: 'https://embed.whombat.com/v1' })).toThrow(/WHOMBAT_EMBED_URL/);
  });

  it('the passkey relying party (passkeys.md PK-02): the hosted UI’s host, its origin, Android’s and the extra ones', () => {
    const cfg = { WHOMBAT_APP_URL: 'https://dev.whombat.com/' };
    expect(managedPasskeyRelyingParty(cfg)).toEqual({
      rpId: 'dev.whombat.com',
      origins: ['https://dev.whombat.com', ...PASSKEY_ANDROID_ORIGINS],
    });
    expect(
      managedPasskeyRelyingParty({
        ...cfg,
        WHOMBAT_PASSKEY_EXTRA_ORIGINS: ' http://localhost:5180/, ,https://dev.whombat.com',
      }).origins,
    ).toEqual(['https://dev.whombat.com', ...PASSKEY_ANDROID_ORIGINS, 'http://localhost:5180']);
  });

  it('the licence key set is checked when read, never required to boot (MR-55, MR-60; LNK-04)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whombat-licence-keys-'));
    try {
      const read = (extra: Record<string, string>) =>
        readLicenceKeySet(loadConfig({ NODE_ENV: 'development', WHOMBAT_LICENCE: 'on', ...extra }));
      const issues = (extra: Record<string, string>) => {
        const r = read(extra);
        return r.ok ? [] : r.issues;
      };
      // The server boots without one, licence on or off.
      expect(serverIssues(loadConfig({ NODE_ENV: 'development', WHOMBAT_LICENCE: 'on' }))).toEqual([]);
      expect(issues({})).toEqual([expect.stringMatching(/^WHOMBAT_LICENCE_KEYS_FILE: required/)]);
      expect(issues({ WHOMBAT_LICENCE_KEYS_FILE: join(dir, 'missing.json') })).toEqual([
        expect.stringMatching(/cannot read .*ENOENT/),
      ]);
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ v: 1, env: 'test', keys: [] }));
      expect(issues({ WHOMBAT_LICENCE_KEYS_FILE: bad })).toEqual([
        expect.stringMatching(/is not a licence key set/),
      ]);
      expect(issues({ WHOMBAT_LICENCE_KEYS_FILE: TEST_LICENCE_KEYS })).toEqual([]);
      expect(
        issues({
          WHOMBAT_LICENCE_KEYS_FILE: TEST_LICENCE_KEYS,
          WHOMBAT_LICENCE_GRACE_S: '60',
          WHOMBAT_LICENCE_CLOCK_OFFSET_S: '-86400',
        }),
      ).toEqual([]);
      // Dev overrides are refused with a production key set.
      const prod = join(dir, 'prod.json');
      writeFileSync(
        prod,
        JSON.stringify({ ...JSON.parse(readFileSync(TEST_LICENCE_KEYS, 'utf8')), env: 'prod' }),
      );
      expect(issues({ WHOMBAT_LICENCE_KEYS_FILE: prod })).toEqual([]);
      expect(
        issues({
          WHOMBAT_LICENCE_KEYS_FILE: prod,
          WHOMBAT_LICENCE_GRACE_S: '60',
          WHOMBAT_LICENCE_CLOCK_OFFSET_S: '-86400',
        }),
      ).toEqual([
        'WHOMBAT_LICENCE_GRACE_S: only with a local, dev or test licence key set (this one is prod)',
        'WHOMBAT_LICENCE_CLOCK_OFFSET_S: only with a local, dev or test licence key set (this one is prod)',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads GitHub through the person’s own sign-in in production, the fake elsewhere', () => {
    expect(loadConfig({}).WHOMBAT_GITHUB_POLL_MS).toBe(30_000);
    expect(() => loadConfig({ WHOMBAT_GITHUB: 'real' })).toThrow(/WHOMBAT_GITHUB/);
  });

  it('loads WHOMBAT_ENV_FILE without overriding the environment', () => {
    const file = secret('production.env', 'PORT=4410\nWHOMBAT_APP_URL=https://app.whombat.com\n');
    const env: Record<string, string | undefined> = { WHOMBAT_ENV_FILE: file, PORT: '4999' };
    loadDotEnv(env);
    expect(env.PORT).toBe('4999');
    expect(env.WHOMBAT_APP_URL).toBe('https://app.whombat.com');
    expect(() => loadDotEnv({ WHOMBAT_ENV_FILE: join(dir, 'missing.env') })).toThrow(/cannot read/);
  });

  it('refuses a production env file readable by others', () => {
    const file = secret('production.env', 'NODE_ENV=production\n', 0o644);
    expect(() => loadDotEnv({ WHOMBAT_ENV_FILE: file })).toThrow(/chmod 600/);
  });
});
