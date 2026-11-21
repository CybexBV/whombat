// `whombat-askpass` (docs/decisions/vault-simplify.md VLT-42): ssh's askpass in the agent's commands, for a server whose
// password the person kept in the Vault. ssh runs it (SSH_ASKPASS, SSH_ASKPASS_REQUIRE=force) with its own password
// prompt, `<user>@<alias>'s password: `, where the alias is the server's `HostKeyAlias` in the turn's ssh config; it
// prints that server's password from the turn's keys tmpfs and nothing else. Any other prompt — a key's passphrase,
// keyboard-interactive text a server sends, another user — gets nothing (exit 1), so the password never answers a
// question a server wrote, and it is never a command-line argument or an environment variable's value.
//
// Plain JavaScript with built-in modules only: it runs on the commands' Node, bound read-only into their wrapper.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The turn's keys tmpfs (core `VAULT_KEYS_DIR`) and the folder of the kept passwords there. */
export const ASKPASS_DIR = '/run/whombat/keys/askpass';
/** The alias Whombat gives a server with a kept password (`wbpw1.invalid`, `wbpw2.invalid`, …: names that never resolve). */
const PROMPT = /^([A-Za-z0-9._-]{1,64})@(wbpw[0-9]{1,3}\.invalid)'s password: ?$/;

/**
 * The password for ssh's prompt, or null: the prompt must be ssh's own password prompt for one of Whombat's aliases, and
 * the user the one the person kept the password for. `read(alias)` gives that alias's file (`{"user","password"}`).
 */
export function askpassAnswer(prompt, read) {
  const m = PROMPT.exec(String(prompt ?? '').replace(/\n$/, ''));
  if (!m) return null;
  let kept;
  try {
    kept = JSON.parse(read(m[2]));
  } catch {
    return null;
  }
  if (!kept || typeof kept.password !== 'string' || !kept.password || kept.user !== m[1]) return null;
  return kept.password;
}

export function main(argv = process.argv.slice(2), dir = ASKPASS_DIR) {
  const answer = askpassAnswer(argv.join(' '), (alias) => readFileSync(`${dir}/${alias}`, 'utf8'));
  if (answer === null) process.exit(1);
  process.stdout.write(`${answer}\n`);
}

const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {}
if (invoked === self || invoked === realpathSync(self)) main();
