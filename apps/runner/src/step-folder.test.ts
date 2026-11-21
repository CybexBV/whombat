/**
 * An automation step's own folder (docs/decisions/automation-recipes.md AR-43; one-person.md OP-S109):
 * `~/work/.automation/<dispatch>` in the agent's home, made for an automation's turn with commands, named in its
 * request, removed when the turn ends; a turn that never ended leaves one the daily cleanup removes.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import { turnPrompt } from './prompt';
import { commandsTurnContext, testContext } from './test-context';
import { buildTurnInput } from './turn';
import { automationStepFolder, removeStaleStepFolders } from './workspace';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-step-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const commands = { productionServers: [], homeNetworks: [], lan: true };
/** Where an automation's step keeps what only it needs (any path: the prompt names it). */
const FOLDER = '/persist/whombat/agent/home/work/.automation/dsp_fix';
/** What every step's request says about its folder (AR-43): it is gone after the turn, tool caches stay home (RN-R3). */
function expectStepFolder(prompt: string, folder: string) {
  const own = prompt.split('\n').find((l) => l.startsWith(`This step’s own folder: ${folder}.`));
  expect(own).toContain('deleted when this turn ends');
  expect(own).toContain('~/.cache');
  return own ?? '';
}
const base = testContext();
const automationTurn = (over: Parameters<typeof testContext>[0] = {}) =>
  testContext({ commands, dispatch: { ...base.dispatch, trigger: 'automation' }, ...over });

const agentHome = () => join(root, 'agent', 'home');

function deps() {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    api: {} as unknown as RunnerApi,
    serverUrl: 'http://127.0.0.1:1',
    workspacesRoot: join(root, 'workspaces'),
    host: { home, whombatHome: join(root, 'whombat'), runnerTmp: join(root, 'tmp'), agentHome: agentHome() },
  };
}

describe('an automation step’s own folder (AR-43)', () => {
  it('is made for an automation’s turn with commands, named in its request, and removed after it', async () => {
    const ctx = automationTurn();
    const { input, cwd } = await buildTurnInput(ctx, deps());
    const folder = automationStepFolder(agentHome(), ctx.dispatch.id);
    expect(cwd.stepFolder).toBe(folder);
    expect(statSync(folder).isDirectory()).toBe(true);
    // The agent's and the container engine's group's (I-3): `docker run -v` works there.
    expect(statSync(folder).mode & 0o007).toBe(0);
    expectStepFolder(input.prompt, folder);
    writeFileSync(join(folder, 'claude-code-2.1.295.tgz'), 'a download');
    await cwd.release();
    expect(existsSync(folder)).toBe(false);
  });

  it('starts empty when a retry of the same turn finds one', async () => {
    const ctx = automationTurn();
    const folder = automationStepFolder(agentHome(), ctx.dispatch.id);
    mkdirSync(folder, { recursive: true, mode: 0o770 });
    writeFileSync(join(folder, 'left.log'), 'from the first attempt');
    const { cwd } = await buildTurnInput(ctx, deps());
    expect(existsSync(join(folder, 'left.log'))).toBe(false);
    await cwd.release();
  });

  it('isn’t there for other turns, nor without commands', async () => {
    for (const ctx of [testContext({ commands }), automationTurn({ commands: null })]) {
      const { input, cwd } = await buildTurnInput(ctx, deps());
      expect(cwd.stepFolder).toBeUndefined();
      expect(input.prompt).not.toContain('This step’s own folder');
      await cwd.release();
    }
    expect(turnPrompt(automationTurn())).not.toContain('This step’s own folder');
  });

  it('is where an automation’s reviewer copies only what it must run; elsewhere a read-only checkout goes home', () => {
    const workspace = {
      repo: 'acme/Fusebox',
      branch: 'feat/issue-5',
      baseBranch: 'main',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/acme/Fusebox.git',
      access: 'read' as const,
      writeApproved: false,
    };
    const review = turnPrompt(automationTurn({ workspace }), { stepFolder: FOLDER });
    expect(review).toContain('read-only checkout of acme/Fusebox on feat/issue-5');
    expect(review).toContain('this step’s own folder');
    expect(review).not.toContain('into your home first');
    // It reads the change first and leaves the full checks to CI (RN-R3).
    expect(review).toContain('Read the change and its tests first');
    expectStepFolder(review, FOLDER);
    // An investigator reads its base branch: no change to review.
    expect(turnPrompt(automationTurn({ workspace: { ...workspace, branch: 'main' } }))).not.toContain(
      'Read the change and its tests first',
    );
    // Outside an automation, a commands turn copies a read-only checkout into its home to build it.
    const chat = turnPrompt(testContext({ commands, workspace }));
    expect(chat).toContain('into your home first');
    expect(chat).not.toContain('Read the change and its tests first');
  });

  it('a writable checkout is built and tested where it is, its checks only what changed (RN-R3)', () => {
    const base = commandsTurnContext();
    const fix = commandsTurnContext({ dispatch: { ...base.dispatch, trigger: 'automation' } });
    const checks = 'Run the checks for what you changed';
    const own = turnPrompt(fix, { stepFolder: FOLDER });
    expect(own).toContain(checks);
    expectStepFolder(own, FOLDER);
    // The same checkout when a person asked: their work, their checks.
    expect(turnPrompt(base)).not.toContain(checks);
    // Without commands too: the pull request's CI runs the full checks either way.
    expect(turnPrompt({ ...fix, commands: null })).toContain(checks);
  });

  it('left behind by a turn that never ended, goes with the daily cleanup once it is old', async () => {
    const old = automationStepFolder(agentHome(), 'dsp_old');
    const fresh = automationStepFolder(agentHome(), 'dsp_fresh');
    for (const dir of [old, fresh]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'build.log'), 'x');
    }
    const now = Date.now();
    const threeDaysAgo = (now - 3 * 86_400_000) / 1000;
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    expect(await removeStaleStepFolders(agentHome(), 2 * 86_400_000, now)).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Nothing to do without a work folder yet.
    expect(await removeStaleStepFolders(join(root, 'none'), 1, now)).toEqual([]);
  });
});
