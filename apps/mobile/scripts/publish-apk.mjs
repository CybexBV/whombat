#!/usr/bin/env node
// Publishes the managed Android app where control hands it out (CT-191, AP-529): builds a release APK for one
// environment (its control and hosted-UI origins are inlined into the bundle), signed with the release key so the
// sign-in links and the QR code open it (AP-291), and writes it with `latest.json` into control's `DOWNLOADS_DIR`.
//
//   pnpm --filter @whombat/mobile publish:apk --dir <dir>      # production, the one app for everyone (arm64-v8a)
//   … --arch all      x86_64 too, for an emulator (every phone would download its libraries)
//   … --skip-build    publish build/whombat-release.apk as it is (it must have been built for the same --env)
//
// Production is the only environment (Whombat one-environment.md): `--env` is `prod`, its default.
//
// The key: WHOMBAT_ANDROID_KEYSTORE + WHOMBAT_ANDROID_KEYSTORE_PASS_FILE, else ~/.config/whombat/android/
// whombat-release.{p12,pass}. Without a release key it refuses (a debug-signed APK never opens links by itself).
//
// Layout: <dir>/android/whombat-<version>.apk and <dir>/android/latest.json
// {version, versionCode, file, size, sha256, publishedAt}. Files are written under a temporary name and renamed, so
// control never serves half an APK; the previous APK stays (a download that started keeps working), older ones go.
// Beside them, <dir>/sourcemaps/<versionCode>-<rev>.map and .mapping.txt keep the build's bundle source map and R8's
// mapping (the newest 30 builds): outside android/, and control serves only the one APK latest.json names. Only a
// bundle map this run's build wrote is kept (with --skip-build none: it could be another build's); R8's mapping is
// kept whenever it is there.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const ENVIRONMENTS = {
  prod: { control: 'https://api.whombat.com', ui: 'https://app.whombat.com' },
};
const envName = flag('env', 'prod');
const target = ENVIRONMENTS[envName];
if (!target) throw new Error('--env must be prod (the default)');
const dirArg = flag('dir');
if (!dirArg) throw new Error('--dir <control DOWNLOADS_DIR> is required');
const downloads = resolve(dirArg.replace(/^~(?=\/|$)/, homedir()));
const arch = flag('arch', 'arm64-v8a');

const home = join(homedir(), '.config/whombat/android');
const keystore = process.env.WHOMBAT_ANDROID_KEYSTORE || join(home, 'whombat-release.p12');
const passFile = process.env.WHOMBAT_ANDROID_KEYSTORE_PASS_FILE || join(home, 'whombat-release.pass');
if (!existsSync(keystore) || !existsSync(passFile))
  throw new Error(`no release key (${keystore}, ${passFile}): links and the QR code wouldn't open the app`);
// Firebase (AP-754): without it the published app can't receive pushes (“Not available”).
const googleServices =
  process.env.GOOGLE_SERVICES_JSON || join(homedir(), '.config/whombat/firebase/google-services.json');
if (!existsSync(googleServices))
  throw new Error(`no Firebase config (${googleServices}): the published app couldn't receive notifications`);

const version = JSON.parse(readFileSync(join(mobile, '../web/package.json'), 'utf8')).version;
const m = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})$/.exec(version);
if (!m) throw new Error(`the app version ${version} (apps/web/package.json) isn't X.Y.Z`);
// app.config.cjs's versionCode (AP-259).
const versionCode = Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);

/** How many builds' maps stay: a few weeks of them, each some megabytes. */
const MAPS_KEPT = 30;

/**
 * The bundle's source map and R8's mapping, kept per build beside the published files
 * (`<dir>/sourcemaps/<versionCode>-<rev>.map`, `….mapping.txt`): an error note from the phone names lines of the
 * minified bundle (src/errors/errorNotes.ts), and a crash's Java frames are R8's short names; these turn them back into
 * the code's. Only a bundle map written since `since` (this build's start) is kept, named after `rev`, the revision the
 * build was made from. R8's mapping is kept whenever it is there: Gradle leaves it as it was when R8 had nothing new to
 * do, and then it still matches. Never stops a publish; true when the bundle map was kept.
 */
function keepMaps(since, rev) {
  try {
    const fresh = (file) => existsSync(file) && statSync(file).mtimeMs >= since;
    const maps = join(downloads, 'sourcemaps');
    mkdirSync(maps, { recursive: true });
    const name = `${versionCode}-${rev}`;
    const gradle = join(mobile, 'android/app/build');
    // React Native's Gradle plugin writes the Hermes bundle's map, composed with Metro's, under the bundle's name.
    const generated = join(gradle, 'generated/sourcemaps/react/release');
    const sourceMap = existsSync(generated)
      ? readdirSync(generated).find((entry) => entry.endsWith('.bundle.map') && fresh(join(generated, entry)))
      : undefined;
    const mapping = join(gradle, 'outputs/mapping/release/mapping.txt');
    if (sourceMap) {
      copyFileSync(join(generated, sourceMap), join(maps, `${name}.map`));
      console.log(`Kept the bundle's source map as ${join(maps, `${name}.map`)}`);
    } else
      console.warn(
        `No bundle source map from this build in ${generated}: its error notes can't be read back`,
      );
    if (existsSync(mapping)) copyFileSync(mapping, join(maps, `${name}.mapping.txt`));
    // The newest builds stay, whole: a build is the files that share its name.
    const byAge = readdirSync(maps)
      .map((entry) => ({ entry, build: entry.split('.')[0], at: statSync(join(maps, entry)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    const kept = new Set();
    for (const { build } of byAge) if (kept.size < MAPS_KEPT) kept.add(build);
    for (const { entry, build } of byAge) if (!kept.has(build)) rmSync(join(maps, entry), { force: true });
    return Boolean(sourceMap);
  } catch (error) {
    console.warn(`The build’s source map wasn’t kept: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** The revision the build is made from, `-dirty` when the working tree has changes: what its maps are named after. */
function revision() {
  const git = (...a) => spawnSync('git', ['-C', mobile, ...a], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const rev = git('rev-parse', '--short=9', 'HEAD') || 'local';
  return git('status', '--porcelain', '--untracked-files=no') ? `${rev}-dirty` : rev;
}

const built = join(mobile, 'build/whombat-release.apk');
const skipBuild = args.includes('--skip-build');
// Taken before the build starts: the maps it writes are newer, and named after what it was made from.
const buildStart = Date.now();
const buildRev = revision();
if (!skipBuild) {
  const result = spawnSync(
    process.execPath,
    [join(mobile, 'scripts/build-android.mjs'), '--variant', 'release', '--arch', arch],
    {
      cwd: mobile,
      stdio: 'inherit',
      env: {
        ...process.env,
        EXPO_PUBLIC_WHOMBAT_CONTROL_URL: target.control,
        EXPO_PUBLIC_WHOMBAT_UI_URL: target.ui,
        WHOMBAT_ANDROID_KEYSTORE: keystore,
        WHOMBAT_ANDROID_KEYSTORE_PASS_FILE: passFile,
        GOOGLE_SERVICES_JSON: googleServices,
      },
    },
  );
  if (result.status !== 0) throw new Error(`the build failed (${result.status})`);
}
if (!existsSync(built)) throw new Error(`no APK at ${built}`);
// Nothing the repository must never hold again is in the APK (scripts/scan-artifacts.sh with the maintainers' guard
// list, which a published APK requires).
const scan = spawnSync('bash', [join(mobile, '../../scripts/scan-artifacts.sh'), built], {
  stdio: 'inherit',
  env: { ...process.env, WHOMBAT_GUARDS_REQUIRED: '1' },
});
if (scan.status !== 0) throw new Error('the APK holds a forbidden text: not published');

const bytes = readFileSync(built);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const file = `whombat-${version}.apk`;
const out = join(downloads, 'android');
mkdirSync(out, { recursive: true });

const apkTmp = join(out, `.${file}.partial`);
copyFileSync(built, apkTmp);
renameSync(apkTmp, join(out, file));

const latest = join(out, 'latest.json');
const previous = existsSync(latest) ? JSON.parse(readFileSync(latest, 'utf8')).file : null;
const record = {
  version,
  versionCode,
  file,
  size: statSync(join(out, file)).size,
  sha256,
  publishedAt: new Date().toISOString(),
};
writeFileSync(`${latest}.partial`, `${JSON.stringify(record, null, 2)}\n`);
renameSync(`${latest}.partial`, latest);

for (const entry of readdirSync(out))
  if (entry.endsWith('.apk') && entry !== file && entry !== previous) rmSync(join(out, entry));

const mapKept = !skipBuild && keepMaps(buildStart, buildRev);

console.log(
  `Published ${file} (${(record.size / 1e6).toFixed(1)} MB, sha256 ${sha256}) for ${envName} in ${out}`,
);

// Said last, where it is seen: without the map this build's error notes can't be read back.
if (!mapKept)
  console.warn(
    `\n!!! NO SOURCE MAP KEPT for ${file}${skipBuild ? ' (--skip-build: the map on disk may be another build’s)' : ''}: ` +
      'error notes from this build can’t be turned back into the code’s lines. Publish without --skip-build to keep one.\n',
  );
