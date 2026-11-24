/**
 * `pnpm --filter @whombat/server onepassword:dev <action> …` — change the stand-in 1Password of a running development
 * box (`/internal/dev/onepassword`, the runner's token), as a person changes their vault in 1Password's app:
 *
 *   state                                      the vaults and their items
 *   edit <item> [field=value …]                title, url, username, password, credential, hostname
 *   add <vault> login|api title=… [field=value …]
 *   remove <item> [<item> …]                   gone from the vault, as deleting them in 1Password
 *
 * An item is named by its id or title, a vault by its id or name. Whombat notices at its next pass (Sync now, or within
 * 10 minutes).
 */
import { loadConfig, loadDotEnv } from '../config';

loadDotEnv();
const config = loadConfig();
const [action, ...rest] = process.argv.slice(2);

/** `field=value` pairs, the rest as they are. */
function fields(args: string[]): { named: Record<string, string>; plain: string[] } {
  const named: Record<string, string> = {};
  const plain: string[] = [];
  for (const arg of args) {
    const at = arg.indexOf('=');
    if (at > 0) named[arg.slice(0, at)] = arg.slice(at + 1);
    else plain.push(arg);
  }
  return { named, plain };
}

function body(): Record<string, unknown> | null {
  const { named, plain } = fields(rest);
  if (action === 'state') return { action };
  if (action === 'edit' && plain[0]) return { action, item: plain[0], ...named };
  if (action === 'add' && plain[0] && (plain[1] === 'login' || plain[1] === 'api') && named.title)
    return { action, vault: plain[0], kind: plain[1], ...named };
  if (action === 'remove' && plain.length) return { action, items: plain };
  return null;
}

const sent = body();
if (!sent) {
  console.error(
    'Usage: onepassword:dev state | edit <item> field=value… | add <vault> login|api title=… field=value… | remove <item>…',
  );
  process.exit(1);
}
const host = config.HOST === '0.0.0.0' || config.HOST === '::' ? '127.0.0.1' : config.HOST;
const token = (config.RUNNER_TOKEN ?? 'dev-runner-token').split(',')[0]?.trim() ?? '';
const url = `http://${host}:${config.PORT}/internal/dev/onepassword`;
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(sent),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`onepassword:dev ${action} failed (${res.status}): ${text}`);
    process.exitCode = 1;
  } else console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch (err) {
  console.error(`Could not reach the server at ${url}. Is \`pnpm dev\` running? (${String(err)})`);
  process.exitCode = 1;
}
