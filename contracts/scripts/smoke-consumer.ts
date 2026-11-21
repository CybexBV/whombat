// Install released tarballs into a scratch consumer exactly as docs/contracts/publishing.md describes, then import
// every published JavaScript subpath with plain Node (ESM), with tsx, and typecheck the imports with `moduleResolution: nodenext`.
//
//   pnpm exec tsx contracts/scripts/smoke-consumer.ts dist-release/contracts/<version>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { publishablePackages, repoRoot, specifiers } from './lib/packages.ts';

type Release = {
  version: string;
  packages: { name: string; file: string; subpaths: string[] }[];
};

const releaseDir = resolve(process.argv[2] ?? '');
const release = JSON.parse(readFileSync(join(releaseDir, 'RELEASE.json'), 'utf8')) as Release;
const scratch = mkdtempSync(join(tmpdir(), `wb-contracts-smoke-${release.version}-`));
const vendor = `vendor/whombat-contracts/${release.version}`;
mkdirSync(join(scratch, vendor), { recursive: true });
cpSync(releaseDir, join(scratch, vendor), { recursive: true });

// Verify SHA256SUMS the way a consumer does.
for (const line of readFileSync(join(scratch, vendor, 'SHA256SUMS'), 'utf8')
  .trim()
  .split('\n')) {
  const [hex, file] = line.split(/\s+/) as [string, string];
  const actual = createHash('sha256')
    .update(readFileSync(join(scratch, vendor, file)))
    .digest('hex');
  if (actual !== hex) throw new Error(`SHA256 mismatch for ${file}`);
}

const deps = Object.fromEntries(release.packages.map((p) => [p.name, `file:${vendor}/${p.file}`]));
// What a consumer brings itself: the packages' peer dependencies (react for `@whombat/brand/react`).
const released = new Set(release.packages.map((p) => p.name));
const peers = Object.fromEntries(
  publishablePackages()
    .filter((p) => released.has(p.name))
    .flatMap((p) => Object.entries(p.peers)),
);
writeFileSync(
  join(scratch, 'package.json'),
  JSON.stringify(
    {
      name: 'contracts-smoke',
      private: true,
      type: 'module',
      dependencies: { ...deps, ...peers },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(scratch, 'pnpm-workspace.yaml'),
  `overrides:\n${Object.entries(deps)
    .map(([n, v]) => `  '${n}': '${v}'\n`)
    .join('')}`,
);

const specs = release.packages.flatMap((p) => specifiers(p));
const body = `${specs.map((s, i) => `import * as m${i} from '${s}';`).join('\n')}
const counts = { ${specs.map((s, i) => `'${s}': Object.keys(m${i}).length`).join(', ')} };
const empty = Object.entries(counts).filter(([, n]) => n === 0);
if (empty.length > 0) throw new Error('empty modules: ' + empty.map(([s]) => s).join(', '));
console.log(JSON.stringify(counts));
`;
writeFileSync(join(scratch, 'smoke.mjs'), body);
writeFileSync(join(scratch, 'smoke.ts'), `${body}export {};\n`);
writeFileSync(
  join(scratch, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ['smoke.ts'],
  }),
);

const run = (cmd: string, argv: string[]) =>
  execFileSync(cmd, argv, { cwd: scratch, stdio: 'inherit', env: process.env });
run('pnpm', ['install']);
console.log('node (dist ESM):');
run('node', ['smoke.mjs']);
console.log('tsx:');
run(join(repoRoot, 'node_modules', '.bin', 'tsx'), ['smoke.ts']);
console.log('tsc (nodenext):');
run(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json']);
console.log(
  `smoke ok: ${specs.length} subpaths from ${release.packages.length} packages in ${basename(scratch)}`,
);
console.log(`scratch consumer: ${scratch}`);
