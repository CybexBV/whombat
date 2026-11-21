// A fake `claude` CLI for the questions Whombat asks Claude Code without a model turn (the usage probe, the model
// list): speaks the stream-JSON host protocol's `initialize` and `get_usage` the way the pinned Claude Code does and
// records what it was started with and sent (argv, env, cwd, every request) as JSON lines. A user message is only
// recorded: no turn runs here (turns run on Hermes, claude-directsdk.md CDS-01). `fakeClaude()` writes a per-test
// launcher script with the scenario baked in.
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{
 *   record: string;
 *   initializeError?: string;
 *   usage?: object;
 *   usageError?: string;
 *   models?: object[];
 * }} Scenario
 */

/** Writes a launcher for `scenario` and returns its path (use as the CLI's executable). */
export function fakeClaude(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fake-claude-'));
  const path = join(dir, 'claude.mjs');
  const self = fileURLToPath(import.meta.url);
  writeFileSync(
    path,
    `import { runFakeClaude } from ${JSON.stringify(self)};\nawait runFakeClaude(${JSON.stringify(scenario)});\n`,
  );
  return path;
}

/** @param {Scenario} scenario */
export async function runFakeClaude(scenario) {
  const argv = process.argv.slice(2);
  const record = (entry) => appendFileSync(scenario.record, `${JSON.stringify(entry)}\n`);
  record({ kind: 'start', argv, env: process.env, cwd: process.cwd() });
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const m = JSON.parse(line);
    if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
      record({ kind: 'initialize', request: m.request });
      send({
        type: 'control_response',
        response: scenario.initializeError
          ? { subtype: 'error', request_id: m.request_id, error: scenario.initializeError }
          : {
              subtype: 'success',
              request_id: m.request_id,
              // The model list (model-effort.md ME-04): Claude Code's `initialize` answers it.
              response: { commands: [], models: scenario.models ?? [] },
            },
      });
    } else if (m.type === 'control_request' && m.request?.subtype === 'get_usage') {
      // The usage probe (src/usage/claude.ts): the scripted answer, or the error an older CLI gives.
      record({ kind: 'get_usage', request: m.request });
      send({
        type: 'control_response',
        response:
          scenario.usage && !scenario.usageError
            ? { subtype: 'success', request_id: m.request_id, response: scenario.usage }
            : {
                subtype: 'error',
                request_id: m.request_id,
                error: scenario.usageError ?? 'Unsupported control request subtype: get_usage',
              },
      });
    } else if (m.type === 'user') record({ kind: 'user', message: m });
  });
  lines.on('close', () => {
    record({ kind: 'stdin-closed' });
    process.exit(0);
  });
}
