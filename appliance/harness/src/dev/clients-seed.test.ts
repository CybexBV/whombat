import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { testedClientBundles } from './services.ts';

describe('the client channel a live environment is seeded with (IN-107)', () => {
  it('takes Claude Code’s newest tested bundle whose artifact is still there, and no Codex (IN-432)', () => {
    const root = mkdtempSync(join(TMP_DIR, 'clients-seed-'));
    const bundles = join(root, 'bundles');
    const markers = join(root, 'markers');
    const artifacts = join(root, 'artifacts');
    for (const d of [bundles, markers, artifacts]) mkdirSync(d);
    const add = (p: string, v: string, o: { ok?: boolean; art?: boolean; arch?: string } = {}) => {
      const arch = o.arch ?? 'x86_64';
      const art = join(artifacts, `${p}-${v}-linux-${arch}.tar.gz`);
      if (o.art !== false) writeFileSync(art, 'x');
      writeFileSync(
        join(bundles, `${p}-${v}-${arch}.json`),
        JSON.stringify({ ArtifactFile: art, Bundle: {} }),
      );
      if (o.ok !== false) writeFileSync(join(markers, `${p}-${v}-${arch}.ok`), '');
    };
    add('claude', '2.1.283');
    add('claude', '2.1.284');
    add('claude', '2.1.290', { ok: false }); // failed or untested
    add('claude', '2.1.299', { art: false }); // artifact gone
    add('claude', '2.1.300', { arch: 'aarch64' });
    add('codex', '0.157.1'); // an older run's: no longer offered
    expect(testedClientBundles(bundles, 'x86_64').map((b) => `${b.provider} ${b.version}`)).toEqual([
      'claude 2.1.284',
    ]);
    expect(testedClientBundles(join(root, 'none'), 'x86_64')).toEqual([]);
  });
});
