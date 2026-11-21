/**
 * `manifest/validate`: the product manifest parses with `@whombat/release`'s strict `ProductManifest`, agrees
 * with the pins (every pinned commit, no stale entry), and the build report behind it is complete and green.
 * `manifest/pin [--refresh] [id…]`: shows pins against their refs, or moves them to the refs' heads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ProductManifest, tupleDigest } from '@whombat/release';
import { revParse } from '../lib/git.ts';
import { BUILD_REPORT_FILE, type BuildReport } from './build.ts';
import { loadPins, savePins, sourceOf } from './pins.ts';
import { ANNOTATIONS_FILE, inProductManifest, PRODUCT_MANIFEST_FILE } from './product.ts';

export function validateManifest(): { ok: boolean; problems: string[]; summary: string[] } {
  const problems: string[] = [];
  const summary: string[] = [];
  const pins = loadPins();
  if (!existsSync(PRODUCT_MANIFEST_FILE))
    return { ok: false, problems: ['no product-manifest.json (run manifest/build)'], summary };
  const parsed = ProductManifest.safeParse(JSON.parse(readFileSync(PRODUCT_MANIFEST_FILE, 'utf8')));
  if (!parsed.success) {
    problems.push(`product-manifest.json does not match ProductManifest: ${parsed.error.message}`);
    return { ok: false, problems, summary };
  }
  const m = parsed.data;
  summary.push(
    `productVersion ${m.productVersion}, release ${m.tuple.releaseId}, tuple ${tupleDigest(m.tuple)}`,
  );
  for (const c of pins.components.filter(inProductManifest)) {
    if (!m.repositories.some((r) => r.name === c.repository && r.commit === c.commit))
      problems.push(`${c.id}: pinned ${c.commit.slice(0, 12)} is not in the manifest (rebuild)`);
  }
  for (const r of m.repositories)
    if (!pins.components.some((c) => c.repository === r.name && c.commit === r.commit))
      problems.push(`manifest names ${r.name}@${r.commit.slice(0, 12)}, which is no longer pinned`);
  if (!existsSync(BUILD_REPORT_FILE)) problems.push('no build-report.json');
  else {
    const report = JSON.parse(readFileSync(BUILD_REPORT_FILE, 'utf8')) as BuildReport;
    for (const c of pins.components) {
      const b = report.components.find((x) => x.id === c.id);
      if (!b) problems.push(`${c.id}: not built`);
      else if (b.commit !== c.commit)
        problems.push(`${c.id}: built ${b.commit.slice(0, 12)}, pinned ${c.commit.slice(0, 12)}`);
      else if (!b.ok) problems.push(`${c.id}: build failed (${b.error ?? 'see log'})`);
      else
        summary.push(
          `${c.id} @ ${c.commit.slice(0, 12)}: built from a clean clone, ${b.artifacts.length} artifact(s)`,
        );
    }
  }
  if (!existsSync(ANNOTATIONS_FILE))
    problems.push('no product-manifest.annotations.json (placeholders unmarked)');
  summary.push(
    `${m.artifacts.length} artifacts, ${m.packages.length} packages, ${pins.placeholders.length} placeholder notes`,
  );
  return { ok: problems.length === 0, problems, summary };
}

export async function pinStatus(refresh: boolean, only: string[]): Promise<string[]> {
  const pins = loadPins();
  const lines: string[] = [];
  let changed = false;
  for (const c of pins.components) {
    if (only.length && !only.includes(c.id)) continue;
    let head: string;
    try {
      head = await revParse(sourceOf(c), c.ref);
    } catch (err) {
      lines.push(`${c.id}: cannot resolve ${c.ref}: ${String(err).split('\n')[0]}`);
      continue;
    }
    if (head === c.commit) lines.push(`${c.id}: ${c.ref} = ${head.slice(0, 12)} (pinned)`);
    else if (refresh) {
      lines.push(`${c.id}: ${c.commit.slice(0, 12)} → ${head.slice(0, 12)} (${c.ref})`);
      c.commit = head;
      changed = true;
    } else lines.push(`${c.id}: pinned ${c.commit.slice(0, 12)}, ${c.ref} is at ${head.slice(0, 12)}`);
  }
  if (changed) {
    pins.updatedAt = Math.floor(Date.now() / 1000);
    savePins(pins);
    lines.push('pins.json updated; run manifest/build');
  }
  return lines;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'pin') {
    const refresh = rest.includes('--refresh');
    for (const l of await pinStatus(
      refresh,
      rest.filter((a) => !a.startsWith('--')),
    ))
      console.log(l);
  } else {
    const r = validateManifest();
    for (const s of r.summary) console.log(`  ${s}`);
    for (const p of r.problems) console.error(`✗ ${p}`);
    console.log(r.ok ? 'manifest: valid' : 'manifest: INVALID');
    process.exit(r.ok ? 0 : 1);
  }
}
