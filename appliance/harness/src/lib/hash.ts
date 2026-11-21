/** Digests: files, and deterministic tarballs of build outputs (IN-06). */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { must } from './proc.ts';

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

export function sha256Text(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `sha256sum` format: `<hex>  <name>` per line. */
export function parseSha256Sums(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * A reproducible `.tar.gz` of `entries` (relative to `cwd`): sorted names, zero mtimes/owners, gzip without a
 * name or timestamp, so equal inputs give equal digests across clean builds.
 */
export async function deterministicTarball(
  cwd: string,
  entries: readonly string[],
  out: string,
): Promise<string> {
  await must(
    'bash',
    [
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash positional parameters
      'set -euo pipefail; tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u+rw,go-w --format=gnu -cf - "${@:2}" | gzip -n -9 > "$1"',
      'tar',
      out,
      ...entries,
    ],
    { cwd },
  );
  return sha256File(out);
}
