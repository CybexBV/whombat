/**
 * The backup app's compose (backup-places.md BPL-01, BPL-02, BPL-09): its structure, `$` kept as it is through
 * compose's own reading, and read back for a redeploy.
 */
import { PLACE_KIT_PASSWORD, PLACE_KIT_USER } from '@whombat/core/backup';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PLACE_KEEP_90 } from '../keep';
import {
  composeEscape,
  composeUnescape,
  containerNames,
  FIRST_PLACE_PORT,
  freePlacePort,
  kitPathOf,
  placeAppName,
  placeCompose,
  REST_CONTAINER_PORT,
  REST_SERVER_IMAGE,
  RESTIC_IMAGE,
  readPlaceCompose,
  validClient,
} from './compose';
import { htpasswdLine, htpasswdMatches, newPlacePassword, PLACE_KIT_HTPASSWD } from './htpasswd';

const CLIENT = 'whombat-home-3fkq';
const LINE = `${CLIENT}:$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234`;

/** Compose's reading of a value: `$$` is one `$`, a lone `$NAME` a variable (an error here). */
function composeReads(value: string): string {
  if (/\$(?!\$)/.test(value.replace(/\$\$/g, ''))) throw new Error(`an unescaped $ in ${value}`);
  return value.replace(/\$\$/g, '$');
}

function services(text: string) {
  return (parse(text) as { services: Record<string, Record<string, unknown>> }).services;
}

describe('placeCompose', () => {
  const input = {
    client: CLIENT,
    port: 8750,
    dataPath: '/mnt/tank/whombat-backups/whombat-home-3fkq',
    statusPath: '/mnt/tank/whombat-backups/.whombat',
    htpasswd: LINE,
    cleanup: { repositoryPassword: 'pa$$word "with" $quotes\'', keep: PLACE_KEEP_90 },
  };

  it('runs the REST server only adding, one user to its own folder, on container port 8000', () => {
    const s = services(placeCompose(input)).server as Record<string, unknown>;
    expect(s.image).toBe(REST_SERVER_IMAGE);
    expect(String(s.image)).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(s.container_name).toBe(containerNames(CLIENT).server);
    expect(s.entrypoint).toEqual(['/bin/sh', '-c']);
    const script = composeReads((s.command as string[])[0] as string);
    expect(script).toContain('--append-only');
    expect(script).toContain('--private-repos');
    expect(script).toContain(`--listen :${REST_CONTAINER_PORT}`);
    expect(script).toContain('"$HTPASSWD"');
    expect(s.ports).toEqual([`8750:${REST_CONTAINER_PORT}`]);
    expect(s.volumes).toEqual([
      `${input.dataPath}:/data/${CLIENT}`,
      `${kitPathOf(input.dataPath)}:/data/${PLACE_KIT_USER}`,
    ]);
    expect(composeReads((s.environment as Record<string, string>).HTPASSWD as string)).toBe(LINE);
    expect(s.labels).toMatchObject({ 'whombat.client': CLIENT, 'whombat.role': 'server' });
  });

  it('adds the weekly cleanup with the repository password, the days and the status folder', () => {
    const c = services(placeCompose(input)).cleanup as Record<string, unknown>;
    expect(c.image).toBe(RESTIC_IMAGE);
    expect(String(c.image)).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(c.container_name).toBe(containerNames(CLIENT).cleanup);
    expect(c.entrypoint).toEqual(['/bin/sh', '-c']);
    const env = c.environment as Record<string, string>;
    expect(composeReads(env.RESTIC_PASSWORD as string)).toBe(input.cleanup.repositoryPassword);
    expect(env.KEEP_DAYS).toBe('90');
    expect(env.RESTIC_REPOSITORY).toBe(`/data/${CLIENT}`);
    expect(c.volumes).toEqual([
      `${input.dataPath}:/data/${CLIENT}`,
      `${input.statusPath}:/status`,
      `${kitPathOf(input.dataPath)}:/kit`,
    ]);
    const script = composeReads((c.command as string[])[0] as string);
    for (const part of ['forget', '--keep-within', '--prune', '--retry-lock 2h', '604800', '.cleanup.json'])
      expect(script).toContain(part);
  });

  it('gives the server the kit user, its own folder beside the backups, and the cleanup keeps 10 of its files', () => {
    const out = services(placeCompose(input));
    const s = out.server as Record<string, unknown>;
    const env = s.environment as Record<string, string>;
    const kitLine = composeReads(env.KIT_HTPASSWD as string);
    expect(kitLine).toBe(PLACE_KIT_HTPASSWD);
    expect(kitLine.startsWith(`${PLACE_KIT_USER}:$2y$`)).toBe(true);
    expect(htpasswdMatches(kitLine, PLACE_KIT_PASSWORD)).toBe(true);
    expect(composeReads((s.command as string[])[0] as string)).toContain('"$KIT_HTPASSWD"');
    expect(kitPathOf(`${input.dataPath}/`)).toBe(`${input.dataPath}.kit`);
    const c = out.cleanup as Record<string, unknown>;
    expect((c.environment as Record<string, string>).KIT_KEEP).toBe('10');
    expect(composeReads((c.command as string[])[0] as string)).toContain('/kit/keys');
    // The same compose every time: a redeploy changes nothing for the kit user.
    expect(placeCompose(input)).toBe(placeCompose(input));
  });

  it('reads the backups’ folder back, never the kit user’s, and no client is called kit', () => {
    expect(readPlaceCompose(placeCompose(input)).dataPath).toBe(input.dataPath);
    expect(validClient(PLACE_KIT_USER)).toBe(false);
  });

  it('every $ of every value is doubled, so compose substitutes nothing', () => {
    const walk = (v: unknown): void => {
      if (typeof v === 'string') composeReads(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(parse(placeCompose(input)));
  });

  it('leaves the cleanup out when it has no repository password (by hand)', () => {
    const out = services(placeCompose({ ...input, cleanup: null }));
    expect(Object.keys(out)).toEqual(['server']);
    expect(placeCompose({ ...input, cleanup: null })).not.toContain('RESTIC_PASSWORD');
  });

  it('a version line only when asked (Container Station)', () => {
    expect(
      (parse(placeCompose({ ...input, withVersion: true })) as Record<string, unknown>).version,
    ).toBeDefined();
    expect((parse(placeCompose(input)) as Record<string, unknown>).version).toBeUndefined();
  });

  it('refuses a client, port or user line a place can’t take', () => {
    expect(() => placeCompose({ ...input, client: 'Bad Name' })).toThrow();
    expect(() => placeCompose({ ...input, port: 80 })).toThrow();
    expect(() => placeCompose({ ...input, htpasswd: `${CLIENT}:plain` })).toThrow();
    expect(() => placeCompose({ ...input, htpasswd: `other:${LINE.split(':')[1]}` })).toThrow();
    expect(() => placeCompose({ ...input, statusPath: undefined })).toThrow();
  });
});

describe('readPlaceCompose', () => {
  it('reads back the port, folder, user line and cleanup from the text or the parsed config', () => {
    const text = placeCompose({
      client: CLIENT,
      port: 8749,
      dataPath: '/volume1/docker/whombat-backups/x',
      statusPath: '/volume1/docker/whombat-backups/.whombat',
      htpasswd: LINE,
      cleanup: { repositoryPassword: 'a$b', keep: { ...PLACE_KEEP_90, allDays: 30 } },
    });
    const want = {
      port: 8749,
      dataPath: '/volume1/docker/whombat-backups/x',
      htpasswd: LINE,
      cleanup: { repositoryPassword: 'a$b', keep: { ...PLACE_KEEP_90, allDays: 30 } },
    };
    expect(readPlaceCompose(text)).toEqual(want);
    // TrueNAS's app.config: the parsed compose, values as stored.
    expect(readPlaceCompose(parse(text) as Record<string, unknown>)).toEqual(want);
  });

  it('takes the list form of the environment and the long form of ports', () => {
    const doc = {
      services: {
        server: {
          ports: [{ target: 8000, published: '8800' }],
          environment: [`HTPASSWD=${composeEscape(LINE)}`],
          volumes: [{ type: 'bind', source: '/srv/b', target: `/data/${CLIENT}` }],
        },
      },
    };
    expect(readPlaceCompose(doc)).toMatchObject({
      port: 8800,
      htpasswd: LINE,
      dataPath: '/srv/b',
      cleanup: null,
    });
  });

  it('answers nothing for text that isn’t a backup app', () => {
    expect(readPlaceCompose('not: [yaml')).toEqual({
      port: null,
      dataPath: null,
      htpasswd: null,
      cleanup: null,
    });
    expect(readPlaceCompose(null)).toEqual({ port: null, dataPath: null, htpasswd: null, cleanup: null });
  });
});

describe('names, ports and the user', () => {
  it('shortens an app name to the NAS’s limit, keeping long names apart', () => {
    expect(placeAppName(CLIENT, 40)).toBe(`whombat-backup-${CLIENT}`);
    const a = placeAppName('whombat-a-very-long-whombat-name-0001', 32);
    const b = placeAppName('whombat-a-very-long-whombat-name-0002', 32);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
  });

  it('picks the first free port from 8747', () => {
    expect(freePlacePort([])).toBe(FIRST_PLACE_PORT);
    expect(freePlacePort([8747, 8748, 9000])).toBe(8749);
  });

  it('escapes and unescapes $', () => {
    expect(composeEscape('a$b$$c')).toBe('a$$b$$$$c');
    expect(composeUnescape(composeEscape('a$b$$c'))).toBe('a$b$$c');
  });

  it('makes a bcrypt line in Apache’s spelling for the password, and a URL-safe password', () => {
    const password = newPlacePassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const line = htpasswdLine(CLIENT, password, 4);
    expect(line.startsWith(`${CLIENT}:$2y$04$`)).toBe(true);
    expect(htpasswdMatches(line, password)).toBe(true);
    expect(htpasswdMatches(line, 'other')).toBe(false);
    expect(validClient(CLIENT)).toBe(true);
    expect(validClient('-x')).toBe(false);
  });
});

describe('the cleanup with the person’s windows (BKO-03…BKO-05)', () => {
  it('passes the windows and the limit, runs daily, and reads them back', () => {
    const keep = { allDays: 2, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12, limitBytes: 50_000_000_000 };
    const text = placeCompose({
      client: 'wb-home',
      port: 8747,
      dataPath: '/mnt/x/wb-home',
      statusPath: '/mnt/x/.whombat',
      htpasswd: 'wb-home:$2y$10$abc',
      cleanup: { repositoryPassword: 'r', keep },
    });
    expect(text).toContain('KEEP_DAILY');
    expect(text).toContain('--keep-within-monthly');
    expect(text).not.toContain('keep-last');
    expect(readPlaceCompose(text).cleanup).toEqual({ repositoryPassword: 'r', keep });
  });
});
