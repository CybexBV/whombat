/**
 * `pnpm dev` (hermes-engine.md HE-49): the server, the runner and the commands' network (`whombat-agent-net`,
 * one-person.md OP-S106) as one development box, in the one runtime
 * mode, with development's stand-ins. What this adds to the root `.env` and the environment (each only when neither sets
 * it): the scripted Hermes as the engine (`WHOMBAT_HERMES_BIN`; `pnpm hermes:install` and `WHOMBAT_HERMES_BIN` for the
 * real one) and `WHOMBAT_ALLOW_SCRIPTED=1`, so its turns run without anyone's sign-in. The rest stands in by itself
 * outside production: no licence, the box's identity made at the first start and a stand-in manager under
 * `WHOMBAT_HOME`, no relay, FakeGitHub, the agent's commands in the same wrapper as on the appliance (the host's tools
 * without `WHOMBAT_AGENT_TOOLS`, Docker only with `WHOMBAT_CONTAINERS_SOCKET`), the boot migrating the database.
 *
 * `WHOMBAT_EDITION=community pnpm dev` runs it as a community box (hermes-engine.md HE-S221): claimed on its own page,
 * `http://localhost:<PORT + 80>/`, with the claim code the server logs; a stand-in Tailscale that signs itself in.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '..');
/** The scripted ACP stand-in for Hermes (hermes-engine.md HE-33, HE-S100), as `@whombat/agent-runtime/testing/hermes` names it. */
const SCRIPTED_HERMES = join(root, 'packages/agent-runtime/src/hermes/testing/scripted-hermes.ts');
const dotEnv = existsSync(join(root, '.env')) ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : {};
const isSet = (key: string) => Boolean(process.env[key]?.trim() || dotEnv[key]?.trim());

const env: NodeJS.ProcessEnv = { ...process.env };
if (!isSet('WHOMBAT_HERMES_BIN')) {
  env.WHOMBAT_HERMES_BIN = SCRIPTED_HERMES;
  if (!isSet('WHOMBAT_ALLOW_SCRIPTED')) env.WHOMBAT_ALLOW_SCRIPTED = '1';
}
console.log(
  `[dev] engine: ${env.WHOMBAT_HERMES_BIN === SCRIPTED_HERMES ? 'the scripted Hermes' : (env.WHOMBAT_HERMES_BIN ?? dotEnv.WHOMBAT_HERMES_BIN)}`,
);

const child = spawn(
  'pnpm',
  [
    'exec',
    'concurrently',
    '-k',
    '-n',
    'server,runner,agent-net',
    '-c',
    'blue,green,magenta',
    'pnpm --filter @whombat/server dev',
    'pnpm --filter @whombat/runner dev',
    'pnpm --filter @whombat/agent-net dev',
  ],
  { cwd: root, env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
