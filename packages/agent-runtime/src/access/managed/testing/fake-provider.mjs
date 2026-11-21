// A provider CLI stand-in: what Claude Code / Codex do in a coding turn — run git (the repository's hooks run),
// install dependencies (their lifecycle scripts run), start an MCP server — plus a call to the Whombat MCP
// endpoint through the sandbox. Prints one JSON line with what it saw.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const out = {};
const run = (file, args) => {
  try {
    execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return 'ok';
  } catch (err) {
    return `failed: ${String(err.stderr ?? err.message)
      .trim()
      .split('\n')
      .pop()}`;
  }
};
out.commit = run('git', [
  '-c',
  'user.name=Agent',
  '-c',
  'user.email=a@example.com',
  'commit',
  '-q',
  '--allow-empty',
  '-m',
  'probe',
]);
out.npm = run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--foreground-scripts']);
out.mcpServer = run(process.execPath, [`${here}fake-mcp-server.mjs`]);
try {
  const res = await fetch(process.env.PROBE_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  out.mcp = res.status;
  const other = await fetch(process.env.PROBE_MCP_URL.replace(/\/mcp.*$/, '/api/v1/health'));
  out.serverOther = other.status;
} catch (err) {
  out.mcp = `failed: ${err.cause?.code ?? err.message}`;
}
out.leaked = Object.entries(process.env)
  .filter(([, v]) => String(v).includes('LEAK-'))
  .map(([k]) => k);
writeFileSync('provider-done.txt', 'written by the provider');
process.stdout.write(`${JSON.stringify(out)}\n`);
