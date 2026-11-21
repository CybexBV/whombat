#!/usr/bin/env node
// A stand-in for the plugin's ChatGPT steps (`python -m whombat_hermes.codex_auth <op>`, hermes-native.md HN-03) for
// sign-in tests: the same JSON lines on stdout, the same files in `$HERMES_HOME`. `login` waits for a control file
// (`$HERMES_HOME/.fake-device`: approve | expire | deny | disabled | network, `network` and `disabled` read before the code
// is shown). Every call is logged to `$HERMES_HOME/.fake-calls.jsonl` with its argv and environment (never stdin).
// `FAKE_CHATGPT_USAGE` (JSON) is what `usage` answers. `lend` writes a stand-in token into `to` and notes what it was
// asked in `$HERMES_HOME/.fake-lent.jsonl`; `$HERMES_HOME/.fake-lend` (`fail`) makes it fail.
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [op] = process.argv.slice(2);
const home = process.env.HERMES_HOME;
if (home)
  appendFileSync(join(home, '.fake-calls.jsonl'), `${JSON.stringify({ argv: [op], env: process.env })}\n`);
const say = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const auth = home ? join(home, 'auth.json') : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const control = () => {
  const file = join(home, '.fake-device');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
};

if (op === 'login') {
  const first = control();
  if (first === 'network' || first === 'disabled') {
    say({ event: 'done', ok: false, reason: first, detail: 'Failed to request device code' });
    process.exit(1);
  }
  process.stderr.write('Hermes noise on stderr\n');
  say({
    event: 'code',
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'FAKE-12345',
    expiresInMinutes: 15,
  });
  for (let i = 0; i < 400; i++) {
    const state = control();
    if (state === 'approve') {
      writeFileSync(
        auth,
        JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: 'x' } } } }),
        {
          mode: 0o600,
        },
      );
      say({ event: 'done', ok: true });
      process.exit(0);
    }
    if (state === 'expire' || state === 'deny') {
      say({ event: 'done', ok: false, reason: state === 'expire' ? 'expired' : 'failed', detail: state });
      process.exit(1);
    }
    await sleep(50);
  }
  say({ event: 'done', ok: false, reason: 'expired', detail: 'Login timed out after 15 minutes.' });
  process.exit(1);
}
if (op === 'token') {
  const token = readFileSync(0, 'utf8').trim();
  if (token.split('.').length !== 3) {
    say({ code: 'invalid', message: "That doesn't look like a Codex access token." });
    process.exit(1);
  }
  writeFileSync(auth, JSON.stringify({ credential_pool: { 'openai-codex': [{ auth_type: 'api_key' }] } }), {
    mode: 0o600,
  });
  say({ ok: true });
  process.exit(0);
}
if (op === 'install') {
  const { from } = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (!from || !existsSync(join(from, 'auth.json'))) {
    say({ code: 'not_found', message: "There's no staged sign-in to keep." });
    process.exit(1);
  }
  renameSync(join(from, 'auth.json'), auth);
  say({ ok: true });
  process.exit(0);
}
if (op === 'remove') {
  const there = existsSync(auth);
  rmSync(auth, { force: true });
  say({ ok: true, removed: there });
  process.exit(0);
}
if (op === 'lend') {
  const asked = JSON.parse(readFileSync(0, 'utf8') || '{}');
  appendFileSync(join(home, '.fake-lent.jsonl'), `${JSON.stringify(asked)}\n`);
  if (existsSync(join(home, '.fake-lend'))) {
    say({ code: 'failed', message: 'fake: lend failed' });
    process.exit(1);
  }
  if (!existsSync(auth)) {
    say({ code: 'not_signed_in', message: "There's no ChatGPT sign-in here." });
    process.exit(1);
  }
  writeFileSync(
    join(asked.to, 'auth.json'),
    JSON.stringify({ credential_pool: { 'openai-codex': [{ auth_type: 'api_key', access_token: 'lent' }] } }),
    { mode: 0o600 },
  );
  say({ ok: true, expiresAt: '2100-01-01T00:00:00Z' });
  process.exit(0);
}
if (op === 'status') {
  say({ signedIn: existsSync(auth) });
  process.exit(0);
}
if (op === 'usage') {
  if (!existsSync(auth)) {
    say({ code: 'not_signed_in', message: "There's no ChatGPT sign-in here." });
    process.exit(1);
  }
  say(
    process.env.FAKE_CHATGPT_USAGE
      ? JSON.parse(process.env.FAKE_CHATGPT_USAGE)
      : {
          plan: 'plus',
          windows: [{ usedPercent: 12, windowMinutes: 300, resetsAt: '2026-10-25T15:00:00Z' }],
          limited: false,
        },
  );
  process.exit(0);
}
if (op === 'models') {
  say({
    models: [
      {
        id: 'gpt-6-sol',
        efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        isDefault: true,
        fast: true,
      },
      { id: 'gpt-5.5', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], isDefault: false, fast: true },
      { id: 'gpt-5.3-codex-spark', efforts: ['low', 'high'], isDefault: false, fast: false },
    ],
  });
  process.exit(0);
}
say({ code: 'invalid', message: `fake: unsupported ${op}` });
process.exit(1);
