/**
 * Signing keys and signatures of a bundle's `SHA256SUMS` (docs/decisions/bp-distribution.md BP-F20):
 *
 * ```
 * pnpm --filter @whombat/package sign --keygen <dir>          a new key pair: <dir>/whombat-release.pem (600,
 *                                                             the secret) and .pub.pem; prints the keys.ts entry
 * pnpm --filter @whombat/package sign <dir> --key <file>      signs <dir>/SHA256SUMS → <dir>/SHA256SUMS.sig
 *     [--require-pinned]                                      …only with a key pinned in apps/cli/src/release/keys.ts
 * pnpm --filter @whombat/package sign <dir> --check [--release-key <file>]
 *                                                             checks <dir>/SHA256SUMS.sig against the pinned keys
 * ```
 *
 * The signatures are raw Ed25519 over SHA256SUMS: OpenSSL makes and checks the same bytes.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  generateReleaseKey,
  RELEASE_KEYS,
  type ReleaseKey,
  readReleaseKey,
  SUMS,
  SUMS_SIG,
  signSums,
  verifySums,
} from '@whombat/cli/release';

const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

/** Writes a new key pair into `dir`; returns the entry for keys.ts. */
export function keygen(dir: string): { privateKey: string; publicKey: string; key: ReleaseKey } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privateKey = join(dir, 'whombat-release.pem');
  const publicKey = join(dir, 'whombat-release.pub.pem');
  if (existsSync(privateKey)) throw new Error(`${privateKey} exists already: not replacing a key`);
  const pair = generateReleaseKey();
  writeFileSync(privateKey, pair.privatePem, { mode: 0o600, flag: 'wx' });
  chmodSync(privateKey, 0o600);
  writeFileSync(publicKey, pair.publicPem, { mode: 0o644 });
  return { privateKey, publicKey, key: pair.key };
}

/** Signs `<dir>/SHA256SUMS` with the private key in `keyFile`; `requirePinned`: only a key keys.ts lists. */
export function signDir(dir: string, keyFile: string, requirePinned = false): ReleaseKey {
  const key = readReleaseKey(keyFile);
  if (requirePinned && !RELEASE_KEYS.some((k) => k.publicKey === key.publicKey))
    throw new Error(`the key in ${keyFile} (${key.id}) isn’t pinned in apps/cli/src/release/keys.ts`);
  const sums = readFileSync(join(dir, SUMS));
  writeFileSync(join(dir, SUMS_SIG), signSums(sums, readFileSync(keyFile, 'utf8')), { mode: 0o644 });
  return key;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keygen: { type: 'string' },
      key: { type: 'string' },
      'require-pinned': { type: 'boolean' },
      check: { type: 'boolean' },
      'release-key': { type: 'string', multiple: true },
    },
  });
  const say = (l: string) => process.stdout.write(`[sign] ${l}\n`);
  if (values.keygen) {
    const r = keygen(here(values.keygen));
    say(`private key: ${r.privateKey} (mode 600) — the secret: keep it nowhere else`);
    say(`public key:  ${r.publicKey}`);
    say('pin it in apps/cli/src/release/keys.ts:');
    process.stdout.write(
      `  { id: '${r.key.id}', publicKey: '${r.key.publicKey}', note: 'Whombat release key' },\n`,
    );
    return 0;
  }
  const dir = positionals[0];
  if (!dir) throw new Error('usage: sign <dir> --key <file> | sign <dir> --check | sign --keygen <dir>');
  if (values.check) {
    const keys = [...RELEASE_KEYS, ...(values['release-key'] ?? []).map((f) => readReleaseKey(here(f)))];
    const signer = verifySums(
      readFileSync(join(here(dir), SUMS)),
      readFileSync(join(here(dir), SUMS_SIG)),
      keys,
    );
    say(signer ? `${SUMS_SIG}: signed by ${signer.id}` : `${SUMS_SIG}: not signed by a trusted key`);
    return signer ? 0 : 1;
  }
  if (!values.key) throw new Error('--key <private key file> is needed to sign');
  const key = signDir(here(dir), here(values.key), Boolean(values['require-pinned']));
  say(`${join(here(dir), SUMS_SIG)}: signed with ${key.id}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`[sign] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
