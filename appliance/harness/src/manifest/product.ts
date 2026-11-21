/**
 * The strict product integration manifest (`@whombat/release` `ProductManifest`, MA-01/R-04) from the pins and a
 * build report. Parts that don't exist yet (Nix closures, provider bundles) get deterministic, syntactically valid
 * placeholder values; `pins.placeholders` lists them and `product-manifest.annotations.json` repeats that list
 * next to the manifest, because the strict schema has no room for the marker (IN-02).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_PROTOCOL } from '@whombat/protocol/session';
import { ProductManifest, type ReleaseTuple, RepositoryName, tupleDigest } from '@whombat/release';
import type { BuildReport } from './build.ts';
import { type Component, MANIFEST_FILES, type Pins } from './pins.ts';

export const PRODUCT_MANIFEST_FILE = MANIFEST_FILES.product;
export const ANNOTATIONS_FILE = MANIFEST_FILES.annotations;

const NIX32 = '0123456789abcdfghijklmnpqrsvwxyz';

/** Deterministic, valid Nix store path for a placeholder (same construction as release-tools/devtuf). */
export function fakeStorePath(name: string): string {
  const sum = createHash('sha256').update(name).digest();
  let s = '';
  for (let i = 0; i < 32; i++) s += NIX32[(((sum[i % 32] ?? 0) + i) % 256) % 32];
  return `/nix/store/${s}-${name}`;
}

/**
 * Whether the strict manifest can name a component's repository: the contracts' `RepositoryName` (the vendored
 * `@whombat/release`). One it doesn't know is left out of `repositories` — its build, artifacts and pin are in the
 * build report and the annotations. Since the harness vendors contracts 0.123.0 that list has whombat-hosts too
 * (NX-152, CT-344; it had six at 0.25.0), so the product manifest names it (IN-389).
 */
export function inProductManifest(c: Pick<Component, 'repository'>): boolean {
  return RepositoryName.safeParse(c.repository).success;
}

const fakeHash = (label: string) =>
  `sha256:${createHash('sha256').update(`placeholder:${label}`).digest('hex')}`;

/**
 * Schema versions are journal positions after the chain's `schemaBase` (managed-db MD-01; Whombat report-trackers.md):
 * with base 0 `0028_managed_runtime` is 29; a chain that carries on an earlier one numbers on from its base.
 */
export function schemaRange(compatJson: string): { reads: number; writes: number } {
  const compat = JSON.parse(compatJson) as {
    schemaBase?: number;
    runtime: { readsFrom: string; writesFrom: string };
    migrations: Record<string, unknown>;
  };
  const base = compat.schemaBase ?? 0;
  const tags = Object.keys(compat.migrations).sort();
  const pos = (tag: string) => {
    const i = tags.indexOf(tag);
    if (i < 0) throw new Error(`compat.json: unknown tag ${tag}`);
    return base + i + 1;
  };
  return { reads: pos(compat.runtime.readsFrom), writes: base + tags.length };
}

const PACKAGE_OF: Record<string, string> = {
  'whombat-canvas-schema': '@whombat/canvas-schema',
  'whombat-control-contracts': '@whombat/control-contracts',
  'whombat-core': '@whombat/core',
  'whombat-fixtures': '@whombat/fixtures',
  'whombat-protocol': '@whombat/protocol',
  'whombat-release': '@whombat/release',
  'whombat-secure-channel': '@whombat/secure-channel',
  'whombat-contracts-go': 'whombat-contracts-go',
  'whombat-contracts-schema': 'whombat-contracts-schema',
};

export function productManifest(
  pins: Pins,
  report: BuildReport,
): { manifest: ProductManifest; tupleDigest: string } {
  const byId = new Map(report.components.map((c) => [c.id, c]));
  const art = (component: string, name: string) =>
    byId.get(component)?.artifacts.find((a) => a.name === name)?.sha256 ?? null;

  // Packages: the contracts release (sha256 as in SHA256SUMS) and other contracts versions still consumed.
  const packages: ProductManifest['packages'] = [];
  const contracts = byId.get(pins.contracts.component);
  const sums = contracts?.artifacts.find((a) => a.files)?.files ?? [];
  for (const f of sums) {
    const m = /^(.+)-(\d+\.\d+\.\d+)\.(tgz|tar\.gz)$/.exec(f.file);
    if (!m?.[1] || !m[2]) continue;
    packages.push({ name: PACKAGE_OF[m[1]] ?? m[1], version: m[2], sha256: f.published ?? f.sha256 });
  }
  const consumed = new Set<string>();
  for (const c of report.components) {
    for (const v of c.contracts.vendored) if (v !== pins.contracts.version) consumed.add(`ts:${v}`);
    if (c.contracts.goModule && c.contracts.goModule !== pins.contracts.version)
      consumed.add(`go:${c.contracts.goModule}`);
  }
  for (const k of [...consumed].sort()) {
    const [lang, v] = k.split(':') as [string, string];
    packages.push({ name: lang === 'go' ? 'whombat-contracts-go' : '@whombat/core', version: v });
  }

  // Artifacts.
  const artifacts: ProductManifest['artifacts'] = [];
  for (const c of report.components) {
    for (const a of c.artifacts) {
      if (a.files) {
        for (const f of a.files)
          artifacts.push({
            name: `${a.name}/${f.file}`,
            kind: 'tarball',
            digest: `sha256:${f.published ?? f.sha256}`,
            ref: `${c.repository}@${c.commit.slice(0, 12)}:dist-release/${f.file}`,
          });
        continue;
      }
      if (!a.sha256) continue;
      artifacts.push({
        name: a.name,
        kind: a.kind as ProductManifest['artifacts'][number]['kind'],
        digest: `sha256:${a.sha256}`,
        ref: `${c.repository}@${c.commit.slice(0, 12)}`,
      });
    }
  }

  // Tuple.
  const runtime = pins.components.find((c) => c.repository === 'Whombat');
  const runtimeBuild = runtime ? byId.get(runtime.id) : undefined;
  let schema = { reads: 0, writes: 0 };
  const compatFile = runtimeBuild
    ? join(runtimeBuild.checkout, 'apps/server/src/db/migrations/compat.json')
    : null;
  try {
    if (compatFile) schema = schemaRange(readFileSync(compatFile, 'utf8'));
  } catch {
    // scratch removed: keep the range recorded in the previous manifest
    try {
      const prev = JSON.parse(readFileSync(PRODUCT_MANIFEST_FILE, 'utf8')) as ProductManifest;
      schema = { reads: prev.tuple.runtime.schemaReads.min, writes: prev.tuple.runtime.schemaWrites };
    } catch {
      // none
    }
  }
  const protocolCode = SESSION_PROTOCOL.major * 1000 + SESSION_PROTOCOL.minor;
  const manager = pins.components.find((c) => c.id === 'appliance-manager');
  const tuple: ReleaseTuple = {
    releaseId: pins.tuple.releaseId,
    runtime: {
      version: runtime?.version ?? '0.0.0',
      storePath: fakeStorePath(`whombat-runtime-${runtime?.commit.slice(0, 12) ?? 'none'}`),
      narHash: art(runtime?.id ?? '', 'whombat-runtime/source')
        ? `sha256:${art(runtime?.id ?? '', 'whombat-runtime/source')}`
        : fakeHash('runtime'),
      schemaReads: { min: schema.reads, max: schema.writes },
      schemaWrites: schema.writes,
      protocol: { min: SESSION_PROTOCOL.major * 1000, max: protocolCode },
      hostAbi: pins.tuple.runtimeHostAbi,
    },
    providers: pins.tuple.providers.map((p) => ({
      provider: p.provider,
      version: p.version,
      storePath: fakeStorePath(`whombat-provider-${p.provider}-${p.version}`),
      narHash: fakeHash(`provider-${p.provider}-${p.version}`),
    })),
    host: {
      version: '0.0.0-placeholder',
      storePath: fakeStorePath('nixos-system-whombat-placeholder'),
      narHash: fakeHash('host'),
      abi: pins.tuple.hostAbi,
    },
    manager: {
      version: manager?.version ?? '0.0.0',
      storePath: fakeStorePath(`whombat-manager-${manager?.commit.slice(0, 12) ?? 'none'}`),
      narHash: art('appliance-manager', 'whombat-manager/bin')
        ? `sha256:${art('appliance-manager', 'whombat-manager/bin')}`
        : fakeHash('manager'),
    },
  };

  const manifest = ProductManifest.parse({
    manifestVersion: 1,
    productVersion: pins.productVersion,
    createdAt: pins.updatedAt,
    repositories: pins.components.filter(inProductManifest).map((c) => ({
      name: c.repository,
      commit: c.commit,
      ...(c.tag ? { tag: c.tag } : {}),
    })),
    packages,
    artifacts,
    tuple,
    supported: {
      clientProtocol: { min: SESSION_PROTOCOL.major * 1000, max: protocolCode },
      relayProtocol: [1],
      upgradeFromSchema: { min: 1, max: schema.writes },
    },
    upgradePaths: pins.upgradePaths,
    evidence: pins.evidence,
  });
  return { manifest, tupleDigest: tupleDigest(manifest.tuple) };
}

export async function writeProductManifest(pins: Pins, report: BuildReport): Promise<void> {
  const { manifest, tupleDigest: digest } = productManifest(pins, report);
  writeFileSync(PRODUCT_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    ANNOTATIONS_FILE,
    `${JSON.stringify(
      {
        $schema: 'whombat.product-manifest-annotations/1',
        productVersion: manifest.productVersion,
        tupleDigest: digest,
        buildRun: report.runId,
        placeholders: pins.placeholders,
        providerBundles: pins.tuple.providers,
        components: pins.components.map((c) => {
          const b = report.components.find((x) => x.id === c.id);
          return {
            id: c.id,
            repository: c.repository,
            ref: c.ref,
            commit: c.commit,
            contracts: b?.contracts ?? null,
            built: b ? b.ok : null,
            notes: c.notes,
          };
        }),
      },
      null,
      2,
    )}\n`,
  );
}
