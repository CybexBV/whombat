/**
 * `pnpm demo:play [burrow]` / `pnpm demo:reset [burrow]` — play or rewind the demo storyline in the running
 * server (`/internal/demo/*`, runner token). Play continues a storyline that is mid-run, starts it at 11:22,
 * or replays a finished one from a rewind; reset puts it back to 11:22.
 */
import { loadConfig, loadDotEnv } from '../config';

loadDotEnv();
const config = loadConfig();
const [command, burrow] = process.argv.slice(2);
if (command !== 'play' && command !== 'reset') {
  console.error('Usage: pnpm demo:play [burrow-slug] | pnpm demo:reset [burrow-slug]');
  process.exit(1);
}
const host = config.HOST === '0.0.0.0' || config.HOST === '::' ? '127.0.0.1' : config.HOST;
const token = (config.RUNNER_TOKEN ?? 'dev-runner-token').split(',')[0]?.trim() ?? '';
const url = `http://${host}:${config.PORT}/internal/demo/${command}`;
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(burrow ? { burrow } : {}),
  });
  const body = await res.text();
  console.log(res.ok ? `demo ${command}: ${body}` : `demo ${command} failed (${res.status}): ${body}`);
  if (!res.ok) process.exitCode = 1;
} catch (err) {
  console.error(`Could not reach the server at ${url}. Is \`pnpm dev\` running? (${String(err)})`);
  process.exitCode = 1;
}
