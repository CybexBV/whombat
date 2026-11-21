/**
 * The scripted Hermes for tests and the demo (docs/decisions/hermes-engine.md HE-33): its path, a launcher that starts
 * it at a test's pace, and the words it answers with. Exported as `@whombat/agent-runtime/testing/hermes`.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  CANNED_REPLY,
  DECLINED_REPLY,
  INBOX_TODAY_QUERY,
  NOT_CONNECTED_REPLY,
  SEND_ASKED_REPLY,
} from './scripted-turn';

/**
 * A stand-in `hermes` for a person's pod's tests (hermes-native.md HN-W01): `gateway run` stays up, `acp` answers each
 * line with its pid, working directory and a few variables, or what it sees at the paths of a `{"probe":[…]}` line.
 */
export const FAKE_POD_HERMES = fileURLToPath(
  new URL('../../access/managed/testing/fake-pod-hermes.mjs', import.meta.url),
);

/** The scripted Hermes itself (`<path> acp`): executable, Node runs it as it is. */
export const SCRIPTED_HERMES = fileURLToPath(new URL('./scripted-hermes.ts', import.meta.url));

export interface ScriptedPace {
  /** Thinking before a reply (default the mock's 1.6 s). */
  thinkMs?: number;
  /** Between two LIVE lines of the storyline run (default the mock's 2.6 s). */
  tickMs?: number;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Writes `<dir>/hermes`, a launcher of the scripted Hermes at `pace` on this Node, and returns its path: what a test
 * gives the runner as the Hermes binary (`WHOMBAT_HERMES_BIN`). The pace travels on the command line, so nothing has to
 * pass the turn's environment.
 */
export async function scriptedHermesLauncher(dir: string, pace: ScriptedPace = {}): Promise<string> {
  const flags = [
    ...(pace.thinkMs !== undefined ? ['--think-ms', String(pace.thinkMs)] : []),
    ...(pace.tickMs !== undefined ? ['--tick-ms', String(pace.tickMs)] : []),
  ];
  const path = join(dir, 'hermes');
  const args = [process.execPath, SCRIPTED_HERMES].map(quote).join(' ');
  await writeFile(path, `#!/bin/sh\nexec ${args} "$@" ${flags.join(' ')}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}
