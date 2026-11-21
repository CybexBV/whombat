#!/usr/bin/env node
// A fake `claude` CLI for the sign-in console tests (CT-71): `auth login --claudeai` prints a sign-in URL and a
// prompt, then reads lines from its terminal. `good` writes a credential into $CLAUDE_CONFIG_DIR and exits 0,
// `nosignin` exits 0 without one, `size` prints the terminal size, `big` prints 40 000 bytes, anything else exits 1.
// `auth status` prints `{"loggedIn": …}` (exit 0/1) like Claude Code 2.1; `auth logout` removes the credential and
// rewrites `.claude.json` (through a link, as the real CLI does).
// Every call is logged to `<HOME>/../.fake-claude-calls.jsonl` (the credentials root, which outlives the staging
// home) with its argv and environment keys and HOME / CLAUDE_CONFIG_DIR / TERM (never its input).
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const home = process.env.HOME;
const config = process.env.CLAUDE_CONFIG_DIR;
if (home)
  appendFileSync(
    join(dirname(home), '.fake-claude-calls.jsonl'),
    `${JSON.stringify({
      argv: args,
      envKeys: Object.keys(process.env).sort(),
      HOME: home,
      CLAUDE_CONFIG_DIR: config ?? null,
      TERM: process.env.TERM ?? null,
      cwd: process.cwd(),
      tty: Boolean(process.stdin.isTTY),
    })}\n`,
  );
const credential = config ? join(config, '.credentials.json') : null;
const out = (s) => process.stdout.write(`${s}\r\n`);

if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = Boolean(credential && existsSync(credential));
  process.stdout.write(
    `${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }, null, 2)}\n`,
  );
  process.exit(loggedIn ? 0 : 1);
}
if (args[0] === 'auth' && args[1] === 'logout') {
  if (credential) rmSync(credential, { force: true });
  // Like Claude Code 2.1.283: its global config (`<config>/.claude.json`) is rewritten on the way out, following a link.
  if (config) writeFileSync(join(config, '.claude.json'), `${JSON.stringify({ migrationVersion: 14 })}\n`);
  out('Successfully logged out from your Anthropic account.');
  process.exit(0);
}
if (!(args[0] === 'auth' && args[1] === 'login' && args[2] === '--claudeai' && args.length === 3)) {
  process.stderr.write(`fake claude: unsupported ${args.join(' ')}\n`);
  process.exit(2);
}

out('Opening browser to sign in…');
out('\u001b[1mBrowser didn’t open? Use the url below to sign in:\u001b[0m');
out('https://claude.ai/oauth/authorize?code=true&client_id=fake&state=fake');
process.stdout.write('Paste code here if prompted > ');
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on('line', (raw) => {
  const line = raw.trim();
  if (line === 'size') {
    out(`SIZE ${process.stdout.columns}x${process.stdout.rows}`);
    return;
  }
  if (line === 'big') {
    process.stdout.write(`${'x'.repeat(39_998)}é`);
    out('');
    return;
  }
  if (line === 'good') {
    writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }), { mode: 0o600 });
    out('Login successful.');
    process.exit(0);
  }
  if (line === 'nosignin') process.exit(0);
  out('OAuth error: Invalid code');
  process.exit(1);
});
