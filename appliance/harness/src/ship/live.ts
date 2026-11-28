/**
 * The scenarios that need live agents (IN-108): scenario `k` runs the image's Hermes with the real Claude Code and
 * ChatGPT, and its skills steps Hermes's own skills code, which every other scenario and the demo must not (they expect the deterministic scripted Hermes, IN-403).
 * `release/ship validate` runs them alone in a second, fresh harness environment derived from the caller's:
 * `<WB_MGD_HOME>-live`, its own Postgres container `<name>-live`, every port shifted by +400, `WB_MGD_AGENTS=live` (so
 * `dev/up` seeds the client channel from the latest tested job, IN-107) — and removes it afterwards.
 */
import { join } from 'node:path';
import { HARNESS_DIR, PG_CONTAINER, ports, STATE_HOME } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import { heavy, type ShipContext, say } from './context.ts';

/**
 * Scenario files that run only in the live environment (their tests are blocked in a scripted one): the live agents,
 * and Settings → Skills on Hermes's own code, which the scripted Hermes doesn't have.
 */
export const LIVE_SCENARIOS = ['k-live-agents.scenario.ts', 'k-live-skills.scenario.ts'];
/** vitest's file filter (a substring) that selects exactly `LIVE_SCENARIOS`. */
export const LIVE_PATTERN = 'k-live-';

/** +400: +200/+300 are the isolated suites'. */
export const LIVE_PORT_SHIFT = 400;

/** The live environment's variables, derived from the caller's harness environment. */
export function liveEnv(base: {
  home: string;
  container: string;
  ports: Record<keyof typeof ports, number>;
}): Record<string, string> {
  const p = (n: number) => String(n + LIVE_PORT_SHIFT);
  return {
    WB_MGD_HOME: `${base.home}-live`,
    WB_MGD_PG_CONTAINER: `${base.container}-live`,
    WB_MGD_PG_PORT: p(base.ports.postgres),
    CONTROL_PORT: p(base.ports.control),
    CONTROL_ADMIN_PORT: p(base.ports.controlAdmin),
    CONTROL_PANEL_PORT: p(base.ports.controlPanel),
    RELAY_PORT: p(base.ports.relay),
    RELAY_ADMIN_PORT: p(base.ports.relayAdmin),
    RUNTIME_PORT: p(base.ports.runtime),
    WB_MGD_DIRECT_PORT: p(base.ports.direct),
    WEB_PORT: p(base.ports.web),
    RESTIC_PORT: p(base.ports.restic),
    WB_MGD_TUF_PORT: p(base.ports.tuf),
    EMBED_PORT: p(base.ports.embed),
    WB_MGD_HOSTS_AGENT_PORT: p(base.ports.hostsAgent),
    WB_MGD_AGENTS: 'live',
  };
}

/** Whether a `--scenarios` pattern (vitest's file filter: a substring) selects a live scenario. */
export function selectsLive(pattern: string | null): boolean {
  return pattern === null || LIVE_SCENARIOS.some((f) => `scenarios/${f}`.includes(pattern));
}

export async function runLive(
  ctx: ShipContext,
  o: { pinsFile: string; logDir: string },
): Promise<{ exitCode: number | null; output: string; env: Record<string, string>; log: string }> {
  const env = liveEnv({ home: STATE_HOME, container: PG_CONTAINER, ports });
  const log = join(o.logDir, 'harness-validate-live.log');
  say(
    `live agents: ${LIVE_SCENARIOS.join(', ')} in a fresh environment ${env.WB_MGD_HOME} (ports +${LIVE_PORT_SHIFT}, container ${env.WB_MGD_PG_CONTAINER}); log ${log}`,
  );
  const vars = { ...env, WB_MGD_PINS: o.pinsFile };
  const r = await heavy(ctx, join(HARNESS_DIR, 'validate'), ['--skip-gates', '--scenarios', LIVE_PATTERN], {
    cwd: ctx.repo,
    env: vars,
    logFile: log,
    timeoutMs: 3 * 3_600_000,
  });
  // Torn down whatever happened: its container, its volume and its state directory.
  await run(process.execPath, [join(ctx.repo, 'harness', 'src', 'dev', 'down.ts'), '--purge'], {
    cwd: ctx.repo,
    env: vars,
    logFile: log,
    timeoutMs: 600_000,
  });
  return { exitCode: r.code, output: `${r.stderr}\n${r.stdout}`, env, log };
}
