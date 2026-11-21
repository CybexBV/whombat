#!/usr/bin/env node
// A fake `gh` CLI for sign-in tests (gh 2.101.0's observable behaviour without a terminal, PV-06):
// `auth login --web | --with-token`, `auth status`, `auth token`, `auth logout`, `--version`. The device flow waits
// for `$GH_CONFIG_DIR/.fake-device` (approve | expire | deny). Calls are logged to `$GH_CONFIG_DIR/.fake-calls.jsonl`.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.GH_CONFIG_DIR;
if (dir)
  appendFileSync(join(dir, '.fake-calls.jsonl'), `${JSON.stringify({ argv: args, env: process.env })}\n`);
const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const hosts = dir ? join(dir, 'hosts.yml') : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (token, user = 'octo') =>
  writeFileSync(
    hosts,
    `github.com:\n    users:\n        ${user}:\n            oauth_token: ${token}\n    oauth_token: ${token}\n    user: ${user}\n    git_protocol: https\n`,
    { mode: 0o600 },
  );
const token = () =>
  hosts && existsSync(hosts) ? /oauth_token: (\S+)/.exec(readFileSync(hosts, 'utf8'))?.[1] : null;

if (args[0] === '--version') {
  out('gh version 2.101.0 (2026-09-15)');
  process.exit(0);
}
if (args[0] !== 'auth') process.exit(2);
if (args[1] === 'login') {
  if (!args.includes('--insecure-storage')) {
    err('fake gh: expected --insecure-storage');
    process.exit(2);
  }
  if (args.includes('--with-token')) {
    const t = readFileSync(0, 'utf8').trim();
    if (!t || t.startsWith('ghp_bad')) {
      err('error validating token: HTTP 401: Bad credentials (https://api.github.com/)');
      process.exit(1);
    }
    save(t);
    process.exit(0);
  }
  if (args.includes('--web')) {
    err('! First copy your one-time code: ABCD-1234');
    err('Open this URL to continue in your web browser: https://github.com/login/device');
    const control = join(dir, '.fake-device');
    for (let i = 0; i < 400; i++) {
      const state = existsSync(control) ? readFileSync(control, 'utf8').trim() : '';
      if (state === 'approve') {
        save('gho_fakeDeviceToken');
        err('✓ Authentication complete.');
        err('✓ Logged in as octo');
        process.exit(0);
      }
      if (state === 'expire') {
        err('failed to authenticate via web browser: expired_token');
        process.exit(1);
      }
      if (state === 'deny') {
        err('failed to authenticate via web browser: access_denied');
        process.exit(1);
      }
      await sleep(50);
    }
    process.exit(1);
  }
}
if (args[1] === 'status') {
  if (!token()) {
    err('You are not logged into any GitHub hosts. To log in, run: gh auth login');
    process.exit(1);
  }
  out(`github.com\n  ✓ Logged in to github.com account octo (${hosts})\n  - Active account: true`);
  process.exit(0);
}
if (args[1] === 'token') {
  const t = token();
  if (!t) {
    err('no oauth token found for github.com');
    process.exit(1);
  }
  out(t);
  process.exit(0);
}
if (args[1] === 'logout') {
  if (hosts && existsSync(hosts)) rmSync(hosts);
  err('✓ Logged out of github.com account octo');
  process.exit(0);
}
process.exit(2);
