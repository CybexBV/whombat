#!/usr/bin/env node
// Publishes the iPhone app to TestFlight, as publish-apk.mjs publishes the Android one (ios-build.md AP-5802): the
// internal group “Whombat” gets every build, and an iPhone with TestFlight's automatic updates installs it by itself.
// A production build also joins the external group “Public” (the public link's testers), without a review request.
//
//   pnpm --filter @whombat/mobile publish:ios [--env prod] [--rev <commit>]   # production
//   … --setup    only the signing keychain, the group and its testers (on the Mac)
//   … --check    archives and signs, uploads nothing: Apple's side accepts new capabilities or extensions
//
// On Linux it copies the commit (default HEAD) to the Mac that builds it and runs itself there: WHOMBAT_IOS_MAC, else the
// first line of ~/.config/whombat/ios/mac, an ssh target (`user@host`). The checkout ~/Code/Whombat-publish on the
// Mac is its own, its generated ios/ and node_modules stay. On the
// Mac it installs, prebuilds, archives, uploads and waits until App Store Connect has processed the build. A build
// number goes up only with the version (app.config.cjs), so a version is published once: bump apps/web/package.json.
//
// Nobody needs to be at the Mac: an App Store Connect API key with Admin access, in ~/.config/whombat/ios/ (asc.json
// {keyId, issuerId} and AuthKey_<keyId>.p8), lets Xcode make the profiles and sign for the App Store in Apple's cloud,
// and the archive is signed from a keychain of the script's own (whombat-build, its password beside the key) with an
// Apple Development certificate it makes through the same key. SSH sessions find the login keychain locked, and only
// the Mac's owner knows its password.
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(mobile, '../..');

/** How many builds' symbols stay on the Mac: a few weeks of them, each some hundred megabytes. */
const SYMBOLS_KEPT = 30;

/**
 * The archive's dSYMs, kept per build beside the source maps (`~/whombat-ios-build/dsyms/<build>-<rev>/`) before the
 * next publish removes the archive: what iOS reports about a crash in native code names a binary's UUID and an offset
 * (src/errors/diagnostics.ts), and only that build's dSYM turns them into the code's names. Never stops a publish.
 */
function keepSymbols(archive, name) {
  try {
    const from = join(archive, 'dSYMs');
    if (!existsSync(from)) return;
    const all = join(homedir(), 'whombat-ios-build/dsyms');
    const to = join(all, name);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(all, { recursive: true });
    cpSync(from, to, { recursive: true });
    const byAge = readdirSync(all)
      .map((entry) => ({ entry, at: statSync(join(all, entry)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of byAge.slice(SYMBOLS_KEPT))
      rmSync(join(all, old.entry), { recursive: true, force: true });
  } catch (error) {
    console.warn(`The build’s dSYMs weren’t kept: ${error instanceof Error ? error.message : error}`);
  }
}
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const ENVIRONMENTS = {
  prod: { control: 'https://api.whombat.com', ui: 'https://app.whombat.com' },
};
const setup = args.includes('--setup');
const check = args.includes('--check');
// Production is the only environment (Whombat one-environment.md).
const envName = flag('env', 'prod');
if (!setup && !ENVIRONMENTS[envName]) throw new Error('--env must be prod (the default)');

const TEAM = '4R8P9MTF9T';
const BUNDLE = 'com.whombat.mobile';
const GROUP = 'Whombat';
const PUBLIC_GROUP = 'Public';
const CHECKOUT = 'Code/Whombat-publish';
// macOS's LibreSSL: a .p12 from Homebrew's OpenSSL 3 or later is protected in a way `security import` can't read.
const OPENSSL = '/usr/bin/openssl';

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (result.status !== 0)
    throw new Error(`${cmd} ${argv[0] ?? ''} failed (${result.status ?? result.signal})`);
  return result;
}
const output = (cmd, argv) =>
  run(cmd, argv, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).stdout;

if (process.platform !== 'darwin') forward();
else await publish();

// The Mac to build on, as an ssh target. There is no default: every publisher has their own Mac.
function buildMac() {
  const fromEnv = process.env.WHOMBAT_IOS_MAC?.trim();
  if (fromEnv) return fromEnv;
  const file = join(homedir(), '.config/whombat/ios/mac');
  const fromFile = existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].trim() : '';
  if (fromFile) return fromFile;
  throw new Error(
    `no Mac to build on: set WHOMBAT_IOS_MAC to its ssh target (user@host), or put that in ${file}`,
  );
}

function forward() {
  const mac = buildMac();
  const rev = output('git', ['-C', repo, 'rev-parse', '--verify', `${flag('rev', 'HEAD')}^{commit}`]).trim();
  // Two publishes would build in the same checkout.
  const busy = spawnSync('ssh', [mac, 'pgrep -f "[p]ublish-ios.mjs"'], { encoding: 'utf8' });
  if (busy.status === 0) throw new Error(`another publish is running on ${mac} (pid ${busy.stdout.trim()})`);

  // The maintainers' guard list goes to the Mac beside the App Store key, for the archive's scan there.
  const guards = output('bash', [join(repo, 'scripts/guards.sh')]).trim();
  if (!guards) throw new Error('no guard list (scripts/guards.sh): a published app is scanned against it');
  run('rsync', ['-a', guards, `${mac}:.config/whombat/ios/forbid.txt`]);

  const copy = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'publish-ios-'));
  try {
    run('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, rev, copy]);
    writeFileSync(join(copy, '.source-rev'), `${rev}\n`);
    run('rsync', [
      '-az',
      '--delete',
      '--exclude',
      'node_modules',
      '--exclude',
      '/apps/mobile/ios/',
      '--exclude',
      '/apps/mobile/android/',
      `${copy}/`,
      `${mac}:${CHECKOUT}/`,
    ]);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  console.log(`${rev.slice(0, 9)} copied to ${mac}:${CHECKOUT}`);
  // The environment goes along by name, so the Mac builds for the one chosen here, the default included.
  const kept = args.filter((a, i) => a !== '--rev' && args[i - 1] !== '--rev');
  const forwarded = (kept.includes('--env') || setup ? kept : ['--env', envName, ...kept]).join(' ');
  run('ssh', [
    mac,
    'export PATH=$HOME/.local/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH LANG=en_US.UTF-8 ' +
      'WHOMBAT_GUARDS_REQUIRED=1 SCAN_FORBID_FILE=$HOME/.config/whombat/ios/forbid.txt; ' +
      `cd ${CHECKOUT} && node apps/mobile/scripts/publish-ios.mjs ${forwarded}`,
  ]);
}

async function publish() {
  const config = join(homedir(), '.config/whombat/ios');
  if (!existsSync(join(config, 'asc.json')))
    throw new Error(
      `no App Store Connect API key in ${config} (asc.json {keyId, issuerId}, AuthKey_<keyId>.p8)`,
    );
  const { keyId, issuerId } = JSON.parse(readFileSync(join(config, 'asc.json'), 'utf8'));
  const keyPath = join(config, `AuthKey_${keyId}.p8`);
  const api = client(keyId, issuerId, readFileSync(keyPath));

  const app = (await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE}`)).data[0];
  if (!app) throw new Error(`App Store Connect has no app ${BUNDLE}: create it there (Apps → +)`);
  const version = JSON.parse(readFileSync(join(repo, 'apps/web/package.json'), 'utf8')).version;
  const m = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})$/.exec(version);
  if (!setup && !m) throw new Error(`the app version ${version} (apps/web/package.json) isn't X.Y.Z`);
  // app.config.cjs's buildNumber, the Android versionCode (AP-259).
  const buildNumber = m ? String(Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3])) : '';
  const uploaded = () =>
    api('GET', `/v1/builds?filter[app]=${app.id}&filter[version]=${buildNumber}&limit=1`);
  if (!setup && !check && (await uploaded()).data.length)
    throw new Error(
      `${version} (${buildNumber}) is already on TestFlight: bump apps/web/package.json's version`,
    );

  await testers(api, app);
  const keychain = await identity(api, config);
  if (setup) return;

  const source = existsSync(join(repo, '.source-rev'))
    ? readFileSync(join(repo, '.source-rev'), 'utf8').trim()
    : '';
  console.log(`Building Whombat ${version} (${buildNumber}) ${source.slice(0, 9)} for ${envName}`);
  // The bundle's source map, kept per build on the Mac: an error the app tells its Whombat names lines of the bundle,
  // and this turns them back into the code's (src/errors/errorNotes.ts).
  const maps = join(homedir(), 'whombat-ios-build/sourcemaps');
  mkdirSync(maps, { recursive: true });
  const env = {
    ...process.env,
    EXPO_PUBLIC_WHOMBAT_CONTROL_URL: ENVIRONMENTS[envName].control,
    EXPO_PUBLIC_WHOMBAT_UI_URL: ENVIRONMENTS[envName].ui,
    SOURCEMAP_FILE: join(maps, `${buildNumber}-${source.slice(0, 9) || 'local'}.map`),
  };
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: repo, env });
  run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install'], {
    cwd: mobile,
    env,
  });
  run('pod', ['install'], { cwd: join(mobile, 'ios'), env });

  const out = join(homedir(), 'whombat-ios-build/testflight');
  rmSync(join(out, 'Whombat.xcarchive'), { recursive: true, force: true });
  rmSync(join(out, 'export'), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const auth = [
    '-allowProvisioningUpdates',
    '-authenticationKeyPath',
    keyPath,
    '-authenticationKeyID',
    keyId,
    '-authenticationKeyIssuerID',
    issuerId,
  ];
  listed(keychain, () =>
    xcodebuild(join(out, 'archive.log'), [
      '-workspace',
      'Whombat.xcworkspace',
      '-scheme',
      'Whombat',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      join(out, 'Whombat.xcarchive'),
      '-derivedDataPath',
      join(out, 'dd'),
      ...auth,
      `DEVELOPMENT_TEAM=${TEAM}`,
      'archive',
    ]),
  );
  // Nothing the repository must never hold again is in the archive (scripts/scan-artifacts.sh with the guard list the
  // publishing machine sent, SCAN_FORBID_FILE; required).
  const scan = spawnSync('bash', [join(repo, 'scripts/scan-artifacts.sh'), join(out, 'Whombat.xcarchive')], {
    stdio: 'inherit',
    env: { ...process.env, WHOMBAT_GUARDS_REQUIRED: '1' },
  });
  if (scan.status !== 0) throw new Error('the archive holds a forbidden text: not uploaded');
  keepSymbols(join(out, 'Whombat.xcarchive'), `${buildNumber}-${source.slice(0, 9) || 'local'}`);
  if (check) {
    console.log(`Whombat ${version} (${buildNumber}) archived and signed; --check uploads nothing`);
    return;
  }
  writeFileSync(
    join(out, 'export.plist'),
    plist({
      method: 'app-store-connect',
      destination: 'upload',
      teamID: TEAM,
      signingStyle: 'automatic',
      manageAppVersionAndBuildNumber: false,
      uploadSymbols: true,
    }),
  );
  xcodebuild(join(out, 'export.log'), [
    '-exportArchive',
    '-archivePath',
    join(out, 'Whombat.xcarchive'),
    '-exportPath',
    join(out, 'export'),
    '-exportOptionsPlist',
    join(out, 'export.plist'),
    ...auth,
  ]);
  console.log('Uploaded; waiting for App Store Connect to process it');

  // Processing takes a few minutes, sometimes half an hour.
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const build = (await uploaded()).data[0];
    const state = build?.attributes.processingState;
    if (state === 'VALID') {
      const detail = await api('GET', `/v1/builds/${build.id}/buildBetaDetail`);
      console.log(
        `Whombat ${version} (${buildNumber}) is on TestFlight for the “${GROUP}” group ` +
          `(${detail.data.attributes.internalBuildState}); iPhones with automatic updates install it by themselves`,
      );
      if (envName === 'prod') await toPublic(api, app, build);
      return;
    }
    if (state === 'FAILED' || state === 'INVALID')
      throw new Error(`App Store Connect refused the build: ${state}`);
    if (Date.now() > deadline)
      throw new Error(`still ${state ?? 'not listed'} after an hour: look in App Store Connect`);
    await sleep(30_000);
  }

  function xcodebuild(log, argv) {
    const fd = openSync(log, 'w');
    const result = spawnSync('xcodebuild', argv, {
      cwd: join(mobile, 'ios'),
      env,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    if (result.status === 0) return;
    const lines = readFileSync(log, 'utf8').split('\n');
    console.error([...new Set(lines.filter((l) => /error:|\*\* .* FAILED/.test(l)))].slice(0, 30).join('\n'));
    throw new Error(`xcodebuild failed (${result.status}); the whole log is ${log}`);
  }
}

// Xcode takes the signing identity from the keychain search list (`--keychain` in OTHER_CODE_SIGN_FLAGS doesn't change
// its choice), and with this keychain listed it chooses this keychain's identity, in other SSH sessions too, which find
// this keychain locked: their device builds would fail. So it's listed only while the archive is signed.
function listed(keychain, build) {
  const others = () =>
    output('security', ['list-keychains', '-d', 'user'])
      .split('\n')
      .map((l) => l.trim().replace(/^"|"$/g, ''))
      .filter((k) => k && k !== keychain);
  // A hang-up or Ctrl-C stops xcodebuild too; without a handler it would also stop this before it unlists.
  const hold = () => {};
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, hold);
  run('security', ['list-keychains', '-d', 'user', '-s', ...others(), keychain]);
  try {
    build();
  } finally {
    run('security', ['list-keychains', '-d', 'user', '-s', ...others()]);
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.off(signal, hold);
  }
}

// The public link's testers (the external group “Public”) follow new builds only when each one is added to their
// group; an external group has no “all builds”. A production build is added and nothing is sent for review: Apple
// reviews it when someone submits it in App Store Connect, and only then do public testers get it.
async function toPublic(api, app, build) {
  const groups = await api('GET', `/v1/apps/${app.id}/betaGroups?limit=200`);
  const group = groups.data.find((g) => g.attributes.name === PUBLIC_GROUP && !g.attributes.isInternalGroup);
  if (!group) {
    console.log(`No external TestFlight group “${PUBLIC_GROUP}”: the build stays with the internal testers`);
    return;
  }
  await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, {
    data: [{ type: 'builds', id: build.id }],
  });
  console.log(`Added to the “${PUBLIC_GROUP}” group; public testers get it once Apple has reviewed it`);
}

// The internal group gets every build without anyone choosing it; every user of the team tests in it.
async function testers(api, app) {
  const groups = await api('GET', `/v1/apps/${app.id}/betaGroups?limit=200`);
  let group = groups.data.find((g) => g.attributes.name === GROUP);
  if (!group) {
    group = (
      await api('POST', '/v1/betaGroups', {
        data: {
          type: 'betaGroups',
          attributes: { name: GROUP, isInternalGroup: true, hasAccessToAllBuilds: true },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      })
    ).data;
    console.log(`Made the internal TestFlight group “${GROUP}”`);
  }
  const inGroup = await api('GET', `/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  const emails = new Set(inGroup.data.map((t) => t.attributes.email?.toLowerCase()));
  for (const user of (await api('GET', '/v1/users?limit=200')).data) {
    const { username: email, firstName, lastName } = user.attributes;
    if (emails.has(email.toLowerCase())) continue;
    await api('POST', '/v1/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: { email, firstName, lastName },
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } },
      },
    });
    console.log(`Invited ${email} to test`);
  }
}

// The build keychain and its Apple Development identity, made again a month before the certificate runs out.
async function identity(api, config) {
  const keychain = join(homedir(), 'Library/Keychains/whombat-build.keychain-db');
  const passFile = join(config, 'keychain.pass');
  const stateFile = join(config, 'identity.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  const valid = () =>
    existsSync(keychain) && output('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
  const unlock = (pass) => {
    run('security', ['unlock-keychain', '-p', pass, keychain]);
    // Locks itself again after two idle hours.
    run('security', ['set-keychain-settings', '-lut', '7200', keychain]);
  };

  if (
    state &&
    existsSync(passFile) &&
    Date.parse(state.expirationDate) - Date.now() > 30 * 86_400_000 &&
    valid()?.includes(state.sha1)
  ) {
    unlock(readFileSync(passFile, 'utf8').trim());
    return keychain;
  }

  const pass = randomBytes(24).toString('hex');
  if (existsSync(keychain)) run('security', ['delete-keychain', keychain]);
  writeFileSync(passFile, `${pass}\n`, { mode: 0o600 });
  run('security', ['create-keychain', '-p', pass, keychain]);
  unlock(pass);

  const work = mkdtempSync(join(config, 'identity-'));
  try {
    const key = join(work, 'key.pem');
    const csr = join(work, 'csr.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(key, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
    run(OPENSSL, ['req', '-new', '-key', key, '-out', csr, '-subj', '/CN=Whombat build']);
    const made = await api('POST', '/v1/certificates', {
      data: {
        type: 'certificates',
        attributes: { certificateType: 'DEVELOPMENT', csrContent: readFileSync(csr, 'utf8') },
      },
    });
    try {
      const der = Buffer.from(made.data.attributes.certificateContent, 'base64');
      writeFileSync(join(work, 'cert.pem'), new X509Certificate(der).toString());
      const p12 = join(work, 'id.p12');
      const p12Pass = randomBytes(12).toString('hex');
      run(OPENSSL, [
        'pkcs12',
        '-export',
        '-inkey',
        key,
        '-in',
        join(work, 'cert.pem'),
        '-out',
        p12,
        '-passout',
        `pass:${p12Pass}`,
      ]);
      run('security', ['import', p12, '-k', keychain, '-P', p12Pass, '-T', '/usr/bin/codesign']);
      // Lets codesign use the key without a click on the Mac's screen.
      run(
        'security',
        ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', pass, keychain],
        {
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      );
      const sha1 = createHash('sha1').update(der).digest('hex').toUpperCase();
      if (!valid()?.includes(sha1)) throw new Error(`the new identity ${sha1} isn't valid in ${keychain}`);
      const { expirationDate } = made.data.attributes;
      writeFileSync(
        stateFile,
        `${JSON.stringify({ certificateId: made.data.id, sha1, expirationDate }, null, 2)}\n`,
      );
      console.log(`Made the signing identity ${sha1} (until ${expirationDate.slice(0, 10)})`);
    } catch (error) {
      // A certificate nobody holds the key of only counts against the team's limit.
      await api('DELETE', `/v1/certificates/${made.data.id}`).catch((e) => console.error(e.message));
      throw error;
    }
    if (state?.certificateId)
      await api('DELETE', `/v1/certificates/${state.certificateId}`).catch((e) => console.error(e.message));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return keychain;
}

function client(keyId, issuerId, pem) {
  const key = createPrivateKey(pem);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return async (method, path, body) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString(
      'base64url',
    );
    const request = () =>
      fetch(`https://api.appstoreconnect.apple.com${path}`, {
        method,
        headers: { authorization: `Bearer ${unsigned}.${signature}`, 'content-type': 'application/json' },
        body: body && JSON.stringify(body),
      });
    // After a long build the kept-alive connection is gone (EPIPE): a read asks again, a write doesn't.
    const res = await request().catch(async (error) => {
      if (method !== 'GET') throw error;
      await sleep(5_000);
      return request();
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `App Store Connect ${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 500)}`,
      );
    return text ? JSON.parse(text) : null;
  };
}

function plist(values) {
  const entries = Object.entries(values).map(
    ([k, v]) => `  <key>${k}</key>${typeof v === 'boolean' ? `<${v}/>` : `<string>${v}</string>`}`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${entries.join('\n')}
</dict></plist>
`;
}
