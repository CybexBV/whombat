/**
 * The claimed console names the burrows (appliance CG-08, contracts CT-116, MR-78) against a real database:
 * claimed without a burrow the file has no `burrows`; creating and renaming its burrow rewrite it through the commit
 * pipeline's bus (a second burrow is refused, one-agent.md OA-S03); a name the console can't show is cleaned; and the
 * names never reach the manager. Its own throwaway database: the appliance starts unclaimed and is claimed once.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleState, consoleStateValid } from '@whombat/control-contracts/local';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createBurrow, updateBurrow } from '../commands/burrows';
import { TEST_APP_URL } from '../test/harness';
import { useManagedRuntime } from '../test/managed';
import { testIdentity } from './testing';

/** Invisible characters, spelled out so the source shows them. */
const NBSP = String.fromCharCode(0x00a0);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

const dir = mkdtempSync(join(tmpdir(), 'wb-console-burrows-'));
const consoleFile = join(dir, 'console.json');
const m = useManagedRuntime({ env: { WHOMBAT_CONSOLE_FILE: consoleFile } });
const URL = `${TEST_APP_URL}/claim`;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function readConsole(): ConsoleState {
  const state = ConsoleState.parse(JSON.parse(readFileSync(consoleFile, 'utf8')));
  expect(consoleStateValid(state)).toBe(true);
  return state;
}

/** The bus listener refreshes after the commit returns: wait for the file to show `want`. */
const eventually = (want: unknown) =>
  vi.waitFor(() => expect(readConsole()).toEqual(want), { timeout: 5_000 });

describe('the claimed console names the burrows', () => {
  let accountId = '';
  let owner = '';
  let firstBurrow = '';

  it('claimed without a burrow: no burrows member', async () => {
    const { claim } = await m.claim(await m.client(testIdentity()), {
      deviceId: 'dev-console',
      name: 'Olive',
    });
    expect(claim).toMatchObject({ t: 'result' });
    accountId = (claim as unknown as { output: { accountId: string } }).output.accountId;
    expect(readConsole()).toEqual({ v: 1, state: 'claimed', url: URL });
  });

  it('creating the first burrow puts its name on the console', async () => {
    const created = await createBurrow(m.t.services, accountId, 'Dusty’s Burrow');
    firstBurrow = created.burrowId;
    owner = created.principalId;
    await eventually({ v: 1, state: 'claimed', url: URL, burrows: { first: 'Dusty’s Burrow', more: 0 } });
  });

  it('a second burrow is refused; the console keeps the one', async () => {
    await expect(createBurrow(m.t.services, accountId, 'Wombat Labs')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readConsole()).toEqual({
      v: 1,
      state: 'claimed',
      url: URL,
      burrows: { first: 'Dusty’s Burrow', more: 0 },
    });
  });

  it('renaming the burrow rewrites the file; a name it can’t show is cleaned', async () => {
    const renamed = await m.t.services.pipeline.commit(
      updateBurrow,
      { name: 'Dusty HQ' },
      { burrowId: firstBurrow, actorId: owner },
    );
    expect(renamed.status).toBe('ok');
    await eventually({ v: 1, state: 'claimed', url: URL, burrows: { first: 'Dusty HQ', more: 0 } });

    const odd = await m.t.services.pipeline.commit(
      updateBurrow,
      { name: `Dusty${RLO}${ZWSP}${NBSP}Burrow\u001b[2J` },
      { burrowId: firstBurrow, actorId: owner },
    );
    expect(odd.status).toBe('ok');
    await eventually({ v: 1, state: 'claimed', url: URL, burrows: { first: 'Dusty Burrow[2J', more: 0 } });
  });

  it('the claim state refresh (at start, after the claim) reads the burrows too', async () => {
    m.runtime.trust.ceremony.setBurrows(undefined);
    expect(readConsole()).toEqual({ v: 1, state: 'claimed', url: URL });
    await m.runtime.trust.refreshClaimConsole();
    expect(readConsole()).toEqual({
      v: 1,
      state: 'claimed',
      url: URL,
      burrows: { first: 'Dusty Burrow[2J', more: 0 },
    });
  });

  it('the names never reach the manager', () => {
    const sent = JSON.stringify({
      claimed: m.manager.claimed,
      pushes: m.manager.pushes,
      revocations: m.manager.revocations,
    });
    for (const name of ['Dusty', 'Wombat Labs']) expect(sent).not.toContain(name);
  });
});
