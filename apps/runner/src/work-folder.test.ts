/**
 * A person's turn without a checkout works in the agent's work folder (one-person.md OP-S109):
 * `~/work` in the agent's home, kept between turns; never a link, never for an assessment or an outsiders' turn.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testContext } from './test-context';
import { agentWorkFolder, prepareCwd } from './workspace';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-work-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const host = () => ({
  home: join(root, 'home'),
  whombatHome: join(root, 'whombat'),
  runnerTmp: join(root, 'runner-tmp'),
  agentHome: join(root, 'agent', 'home'),
});
const commands = { productionServers: [], homeNetworks: [], lan: true };
const prepare = (over: Parameters<typeof testContext>[0] = {}) =>
  prepareCwd(testContext({ commands, ...over }), {
    root: join(root, 'workspaces'),
    checkout: true,
    host: host(),
  });

describe('the work folder (AC-24)', () => {
  it('is the cwd of a person’s turn without a checkout, ~/work of the agent’s home, and stays after the turn', async () => {
    const first = await prepare();
    const dir = agentWorkFolder(join(root, 'agent', 'home'));
    expect(first.cwd).toBe(dir);
    expect(first.workFolder).toBe(true);
    expect(first.env).toEqual({ GIT_CEILING_DIRECTORIES: join(root, 'agent', 'home') });
    writeFileSync(join(dir, 'notes.md'), 'kept');
    await first.release();
    const second = await prepare();
    expect(second.cwd).toBe(dir);
    expect(statSync(join(dir, 'notes.md')).isFile()).toBe(true);
  });

  it('is never a link, and never for an assessment or an outsiders’ turn', async () => {
    const dir = agentWorkFolder(join(root, 'agent', 'home'));
    mkdirSync(join(dir, '..'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), dir);
    await expect(prepare()).rejects.toMatchObject({ code: 'work_folder_not_private' });
    rmSync(dir);
    const base = testContext();
    const assessment = await prepare({ dispatch: { ...base.dispatch, trigger: 'feedback' } });
    expect(assessment.cwd).not.toBe(dir);
    const outside = await prepare({ commands: null, outside: true });
    expect(outside.cwd).not.toBe(dir);
    expect(outside.workFolder).toBeUndefined();
  });
});
