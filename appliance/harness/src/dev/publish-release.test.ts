import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { ControlError } from '../scenario-kit/cloud.ts';
import {
  checkSums,
  hasIndexes,
  INTERNAL_ONLY,
  otherInternal,
  parseArgs,
  publishedLine,
  ROLLOUT_PRESETS,
  refusedForRecord,
  wavesFor,
} from './publish-release.ts';

describe('dev/publish-release', () => {
  it('takes a directory and an optional device to roll out to', () => {
    expect(parseArgs(['out/release'])).toMatchObject({ rollout: null });
    expect(parseArgs(['r', '--rollout', 'wb-abcd-efgh-ijkl']).rollout).toBe('wb-abcd-efgh-ijkl');
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['r', '--rollout'])).toThrow(/device id/);
    expect(() => parseArgs(['r', '--rollout', 'all'])).toThrow(/device id/);
    expect(() => parseArgs(['r', '--force'])).toThrow(/unknown option/);
    expect(() => parseArgs(['r', 's'])).toThrow(/unexpected/);
    expect(parseArgs(['r', '--waves', 'default', '--record', 'rec.json', '--json'])).toMatchObject({
      waves: 'default',
      json: true,
    });
    expect(() => parseArgs(['r', '--waves'])).toThrow(/--waves needs/);
    expect(
      parseArgs(['r', '--allow-downgrade-from', 'whombat-dev-20260928.3,whombat-dev-20260928.2'])
        .allowDowngradeFrom,
    ).toEqual(['whombat-dev-20260928.3', 'whombat-dev-20260928.2']);
    expect(() => parseArgs(['r', '--allow-downgrade-from', 'Bad Id'])).toThrow(/release ids/);
  });

  it('knows UP-E1’s presets; every wave pauses at the first failure', () => {
    expect(wavesFor(null, null)).toBeNull();
    expect(wavesFor(null, 'wb-a')).toBe(INTERNAL_ONLY);
    const d = wavesFor('default', null) ?? [];
    expect(d.map((w) => [w.cohorts.join('+'), w.basisPoints, w.minObservationS])).toEqual([
      ['internal', 10_000, 3600],
      ['pilot', 10_000, 21_600],
      ['canary', 10_000, 43_200],
      ['general', 1000, 86_400],
      ['general', 10_000, 0],
    ]);
    expect(wavesFor('all-at-once', null)?.[0]?.cohorts).toEqual(['internal', 'pilot', 'canary', 'general']);
    for (const w of [...ROLLOUT_PRESETS.default, ...ROLLOUT_PRESETS['all-at-once'], ...INTERNAL_ONLY])
      expect([w.failureThresholdBp, w.minSample]).toEqual([0, 1]);
  });

  it('reads a waves file and checks its cohorts', () => {
    const file = (text: string) => () => text;
    const w = [
      { cohorts: ['internal'], basisPoints: 10_000, minObservationS: 0, failureThresholdBp: 0, minSample: 1 },
    ];
    expect(wavesFor('w.json', null, file(JSON.stringify({ waves: w })))?.[0]?.index).toBe(0);
    expect(() => wavesFor('w.json', null, file('[{"cohorts":["everyone"]}]'))).toThrow(/cohorts among/);
    expect(() => wavesFor('w.json', null, file('[]'))).toThrow(/no waves/);
  });

  it('tells a control without release records from other refusals', () => {
    const e = (status: number, body: unknown) =>
      new ControlError(status, 'validation_failed', null, body, 'POST /releases');
    expect(
      refusedForRecord(
        e(400, { error: { code: 'validation_failed', message: 'Unrecognized key: "record"' } }),
      ),
    ).toBe(true);
    expect(refusedForRecord(e(409, { error: { code: 'release_exists' } }))).toBe(false);
    expect(refusedForRecord(new Error('x'))).toBe(false);
  });

  it('names every other live internal device (a rollout to the internal cohort would reach it)', () => {
    const devices = [
      { device: 'wb-a', internal: true, state: 'claimed' },
      { device: 'wb-b', internal: true, state: 'retired' },
      { device: 'wb-c', internal: false, state: 'claimed' },
      { device: 'wb-d', state: 'unclaimed' },
      { device: 'wb-e', internal: true, state: 'unclaimed' },
    ];
    expect(otherInternal(devices, 'wb-a')).toEqual(['wb-e']);
    expect(otherInternal(devices, 'wb-e')).toEqual(['wb-a']);
  });

  it('checks every file against SHA256SUMS and needs release.json among them', async () => {
    const dir = mkdtempSync(join(TMP_DIR, 'publish-release-'));
    writeFileSync(join(dir, 'release.json'), '{}\n');
    writeFileSync(join(dir, 'host.closure'), 'x');
    const sum = (s: string) =>
      // sha256 of the file contents above
      ({
        '{}\n': 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356',
        x: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
      })[s];
    writeFileSync(join(dir, 'SHA256SUMS'), `${sum('{}\n')}  release.json\n${sum('x')}  host.closure\n`);
    await expect(checkSums(dir)).resolves.toEqual(['release.json', 'host.closure']);
    writeFileSync(join(dir, 'host.closure'), 'y');
    await expect(checkSums(dir)).rejects.toThrow(/host.closure doesn’t match/);
    writeFileSync(join(dir, 'SHA256SUMS'), `${sum('x')}  host.closure\n`);
    writeFileSync(join(dir, 'host.closure'), 'x');
    await expect(checkSums(dir)).rejects.toThrow(/release.json/);
    writeFileSync(join(dir, 'SHA256SUMS'), 'nonsense\n');
    await expect(checkSums(dir)).rejects.toThrow(/bad line/);
    rmSync(dir, { recursive: true });
  });

  it('checks only the top-level files of a v2 directory (its nar/ blobs are tufrepo’s to verify)', async () => {
    const dir = mkdtempSync(join(TMP_DIR, 'publish-release-'));
    writeFileSync(join(dir, 'release.json'), '{}\n');
    writeFileSync(
      join(dir, 'SHA256SUMS'),
      'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  release.json\n',
    );
    mkdirSync(join(dir, 'nar'));
    writeFileSync(join(dir, 'nar', 'aa.nar.zst'), 'blob');
    await expect(checkSums(dir)).resolves.toEqual(['release.json']);
    writeFileSync(
      join(dir, 'SHA256SUMS'),
      'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356  nar/aa.nar.zst\n',
    );
    await expect(checkSums(dir)).rejects.toThrow(/bad line/);
    rmSync(dir, { recursive: true });
  });

  it('knows a directory with closure indexes and says what the publish added (UP-X14)', () => {
    expect(hasIndexes({ v: 1 })).toBe(false);
    expect(hasIndexes({ v: 2, indexes: [] })).toBe(false);
    expect(hasIndexes({ v: 2, indexes: [{}] })).toBe(true);
    const pub = {
      releaseId: 'r',
      tupleDigest: 'sha256:x',
      added: ['a', 'b'],
      reused: [],
      alreadyPublished: false,
    };
    expect(publishedLine('r', pub)).toBe('r: published (2 added, 0 reused), tupleDigest sha256:x');
    expect(publishedLine('r', { ...pub, blobsAdded: 24, blobsReused: 1094, bytesAdded: 19_400_000 })).toBe(
      'r: published (2 added, 0 reused; blobs 24 added (19 MB), 1094 reused), tupleDigest sha256:x',
    );
    expect(publishedLine('r', { ...pub, alreadyPublished: true })).toBe(
      'r: already published, tupleDigest sha256:x',
    );
  });
});
