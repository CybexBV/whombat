import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import {
  controlTufUrl,
  PERIOD_MS,
  plan,
  readTimestamp,
  refresh,
  timestampState,
  WINDOW_MS,
} from './tuf-refresh.ts';

const H = 3_600_000;
// 2026-10-07 13:03 UTC: the DEV box's manager found the timestamp of the 2026-10-06 13:02 publish expired.
const now = Date.parse('2026-10-07T13:03:00Z');
const made: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(TMP_DIR, prefix));
  made.push(dir);
  return dir;
};

function repo(timestamp?: string): string {
  const dir = scratch('tuf-refresh-');
  mkdirSync(join(dir, 'metadata'));
  if (timestamp !== undefined) writeFileSync(join(dir, 'metadata', 'timestamp.json'), timestamp);
  return dir;
}

/** A stand-in tufrepo (`WB_TUFREPO`): records its arguments, prints what it is given, exits with `code`. */
function fakeTufrepo(stdout: string, stderr: string, code: number): { bin: string; args: string } {
  const dir = scratch('tuf-refresh-bin-');
  const bin = join(dir, 'tufrepo');
  const args = join(dir, 'args');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" > '${args}'\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`,
    { mode: 0o755 },
  );
  return { bin, args };
}

describe('the dev TUF timestamp refresher (IN-224)', () => {
  const tufrepo = process.env.WB_TUFREPO;
  afterEach(() => {
    if (tufrepo === undefined) delete process.env.WB_TUFREPO;
    else process.env.WB_TUFREPO = tufrepo;
  });
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('re-signs an expired timestamp at once', () => {
    expect(plan({ version: 84, expires: Date.parse('2026-10-07T13:02:00Z') }, now)).toEqual({
      due: true,
      why: 'expired',
      waitMs: 0,
    });
    expect(plan(null, now)).toEqual({ due: true, why: 'unreadable', waitMs: 0 });
  });

  it('re-signs one with 18 h or less left (6 h old) at once', () => {
    expect(plan({ version: 85, expires: now + 17 * H }, now)).toEqual({
      due: true,
      why: 'window',
      waitMs: 0,
    });
    expect(plan({ version: 85, expires: now + WINDOW_MS }, now).due).toBe(true);
    expect(plan({ version: 85, expires: now + 60_000 }, now).due).toBe(true);
  });

  it('leaves a fresh one until it reaches 18 h left, and looks again after a period at most', () => {
    expect(plan({ version: 86, expires: now + 20 * H }, now)).toEqual({
      due: false,
      why: 'fresh',
      waitMs: 2 * H + 1000,
    });
    // Just published (24 h): the next refresh comes a period later, as production's timer's.
    expect(plan({ version: 86, expires: now + 24 * H }, now)).toEqual({
      due: false,
      why: 'fresh',
      waitMs: PERIOD_MS,
    });
    expect(plan({ version: 86, expires: now + 30 * 24 * H }, now).waitMs).toBe(PERIOD_MS);
    // Waking up a second past the window, it is due.
    const at = now + 2 * H + 1000;
    expect(plan({ version: 86, expires: now + 20 * H }, at).due).toBe(true);
  });

  it('reads the timestamp the repository serves, and says how long it has', () => {
    const fresh = repo(
      JSON.stringify({
        signed: { _type: 'timestamp', version: 85, expires: '2026-10-08T13:54:56.268200813Z' },
      }),
    );
    const ts = readTimestamp(fresh);
    expect(ts).toEqual({ version: 85, expires: Date.parse('2026-10-08T13:54:56.268Z') });
    expect(timestampState(ts, now)).toBe('v85 expires 2026-10-08T13:54:56Z (24.9 h left)');
    expect(timestampState(ts, Date.parse('2026-10-09T00:00:00Z'))).toBe(
      'v85 expired at 2026-10-08T13:54:56Z',
    );
    expect(readTimestamp(repo())).toBeNull();
    expect(readTimestamp(repo('{"signed":{"version":"x"}}'))).toBeNull();
    expect(readTimestamp(repo('not json'))).toBeNull();
    expect(timestampState(null, now)).toBe('no readable timestamp.json');
  });

  it('points control’s update repository checks at the repository once it exists (UP-G2)', () => {
    const dir = repo();
    expect(controlTufUrl(dir, 4739)).toBeUndefined();
    writeFileSync(join(dir, 'metadata', 'root.json'), '{}');
    expect(controlTufUrl(dir, 4739)).toBe('http://127.0.0.1:4739/metadata/');
  });

  it('runs tufrepo refresh on the repository and keeps its line and warnings', async () => {
    const dir = repo();
    const ok = fakeTufrepo(
      're-signed snapshot, timestamp; timestamp v86 expires 2026-10-08T13:03:01Z\n',
      'tufrepo: warning: root expires at 2026-11-01T00:00:00Z: re-sign it (tufrepo resign-root) or rotate it (PI-12)\n',
      0,
    );
    process.env.WB_TUFREPO = ok.bin;
    expect(await refresh(dir)).toEqual({
      ok: true,
      line: 're-signed snapshot, timestamp; timestamp v86 expires 2026-10-08T13:03:01Z',
      warnings: [
        'root expires at 2026-11-01T00:00:00Z: re-sign it (tufrepo resign-root) or rotate it (PI-12)',
      ],
    });
    expect(readFileSync(ok.args, 'utf8').trim()).toBe(`refresh --dir ${dir}`);

    const locked = fakeTufrepo(
      '',
      `tufrepo: devtuf: repository ${dir} is locked by another writer: resource temporarily unavailable\n`,
      1,
    );
    process.env.WB_TUFREPO = locked.bin;
    expect(await refresh(dir)).toEqual({
      ok: false,
      line: `tufrepo refresh failed (exit 1): devtuf: repository ${dir} is locked by another writer: resource temporarily unavailable`,
      warnings: [],
    });
  });
});
