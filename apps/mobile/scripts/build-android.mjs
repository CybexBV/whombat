#!/usr/bin/env node
// Local Android build (no EAS): `expo prebuild` (android only) into apps/mobile/android — generated,
// gitignored — then Gradle. Prints the APK path.
//
//   pnpm --filter @whombat/mobile android:apk                     debug APK, x86_64 (emulator)
//   pnpm --filter @whombat/mobile android:apk --variant release   release APK (JS bundled; signed with the debug key)
//   pnpm --filter @whombat/mobile android:apk --arch arm64-v8a    phones
//   pnpm --filter @whombat/mobile android:apk --arch all          x86_64 + arm64-v8a (an emulator and phones)
//   pnpm --filter @whombat/mobile android:apk --clean             regenerate android/ from scratch
//   pnpm --filter @whombat/mobile android:apk --metro-port 8195   debug APK that loads JS from Metro on :8195
//
// WHOMBAT_ANDROID_KEYSTORE and WHOMBAT_ANDROID_KEYSTORE_PASS_FILE sign a release APK with the release key (AP-291).
//
// A debug APK loads its JavaScript from Metro on the emulator's host (http://10.0.2.2:<metro port>; start
// Metro with `pnpm --filter @whombat/mobile start --port <metro port>`); a release APK runs on its own.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const variant = flag('variant', 'debug');
if (variant !== 'debug' && variant !== 'release') throw new Error('--variant must be debug or release');
const arch = flag('arch', 'x86_64');
const architectures = arch === 'all' ? 'x86_64,arm64-v8a' : arch;
let clean = args.includes('--clean');

const env = {
  ...process.env,
  ANDROID_HOME: process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk'),
  // Expo's own CLI checks; the build itself is local.
  EXPO_NO_TELEMETRY: '1',
  CI: '1',
};

function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

const expo = join(mobile, 'node_modules/expo/bin/cli');
const android = join(mobile, 'android');
// app.config.cjs reads EXPO_PUBLIC_* (managed intent filters, the camera, cleartext): android/ generated for other
// values — or from another app.config.cjs (e.g. new app-link paths), or another release version (versionName and
// versionCode, AP-259) — would silently keep the old manifest, so a change of any of them regenerates it from scratch.
const configEnv = JSON.stringify({
  env: Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith('EXPO_PUBLIC_') || k === 'GOOGLE_SERVICES_JSON')
      .sort(([a], [b]) => a.localeCompare(b)),
  ),
  appConfig: createHash('sha256')
    .update(readFileSync(join(mobile, 'app.config.cjs')))
    .digest('hex'),
  version: JSON.parse(readFileSync(join(mobile, '../web/package.json'), 'utf8')).version,
  // The Firebase config's contents, not only its path: a replaced file must reach the APK (AP-754).
  googleServices:
    process.env.GOOGLE_SERVICES_JSON && existsSync(process.env.GOOGLE_SERVICES_JSON)
      ? createHash('sha256').update(readFileSync(process.env.GOOGLE_SERVICES_JSON)).digest('hex')
      : null,
});
const stamp = join(android, '.whombat-config-env.json');
if (existsSync(stamp) && readFileSync(stamp, 'utf8') !== configEnv) clean = true;
if (!existsSync(stamp) && existsSync(join(android, 'gradlew'))) clean = true;
if (clean || !existsSync(join(android, 'gradlew'))) {
  run(
    process.execPath,
    [expo, 'prebuild', '--platform', 'android', '--no-install', ...(clean ? ['--clean'] : [])],
    mobile,
  );
}

writeFileSync(stamp, configEnv);

// Debug builds fetch JavaScript from Metro at the emulator's host (10.0.2.2) on this port.
const metroPort = flag('metro-port', process.env.RCT_METRO_PORT ?? '8081');

// `EXPO_PUBLIC_*` values are inlined into the bundle, but Gradle doesn't see them as inputs and Metro's cache
// doesn't key on them: a build with other values (the demo world, harness) would ship the previous bundle.
// Drop both caches so the bundle is always made from this build's environment.
for (const dir of ['assets', 'res', 'sourcemaps'])
  rmSync(join(android, `app/build/generated/${dir}/react/${variant}`), { recursive: true, force: true });
for (const entry of readdirSync(tmpdir()))
  if (entry === 'metro-cache' || entry.startsWith('metro-file-map-'))
    rmSync(join(tmpdir(), entry), { recursive: true, force: true });

const task = variant === 'release' ? ':app:assembleRelease' : ':app:assembleDebug';
run(
  './gradlew',
  [
    task,
    '--no-daemon',
    '--max-workers=4',
    `-PreactNativeArchitectures=${architectures}`,
    `-PreactNativeDevServerPort=${metroPort}`,
  ],
  android,
);

const apk = join(android, `app/build/outputs/apk/${variant}/app-${variant}.apk`);
const outDir = join(mobile, 'build');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `whombat-${variant}.apk`);
copyFileSync(apk, out);

// The release key (AP-291): the certificate the hosted UI's /.well-known/assetlinks.json names, so the sign-in links
// open this app by themselves. The debug key is public (every React Native checkout has it): an APK signed with it
// works, but Android never verifies its links. The keystore and its password file stay off the repo.
const keystore = process.env.WHOMBAT_ANDROID_KEYSTORE;
if (variant === 'release' && keystore) {
  const passFile = process.env.WHOMBAT_ANDROID_KEYSTORE_PASS_FILE;
  if (!passFile) throw new Error('WHOMBAT_ANDROID_KEYSTORE needs WHOMBAT_ANDROID_KEYSTORE_PASS_FILE');
  const buildTools = join(env.ANDROID_HOME, 'build-tools');
  const newest = readdirSync(buildTools)
    .filter((v) => existsSync(join(buildTools, v, 'apksigner')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!newest) throw new Error(`no apksigner in ${buildTools}`);
  const apksigner = join(buildTools, newest, 'apksigner');
  // v2/v3 only (android-slim.md AP-895): the app needs Android 7 (minSdk 24), which never reads the old JAR signature —
  // its two files listed every entry again (~260 kB).
  run(
    apksigner,
    ['sign', '--v1-signing-enabled', 'false', '--ks', keystore, '--ks-pass', `file:${passFile}`, out],
    mobile,
  );
  run(apksigner, ['verify', '--print-certs', out], mobile);
} else if (variant === 'release') {
  console.log(
    'Signed with the debug key: set WHOMBAT_ANDROID_KEYSTORE for links that open the app (AP-291).',
  );
}
console.log(`APK: ${out}`);
