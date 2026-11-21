import type { SandboxSession } from '@whombat/agent-runtime';
import { describe, expect, it } from 'vitest';
import type { TurnFiles } from '../attachments';
import type { TurnCommands } from '../commands/turn';
import type { TurnConversationFiles } from '../files';
import type { GatewayForwarder } from '../gateway';
import type { GhService } from '../gh';
import type { TurnFollowUps } from '../steering';
import type { PreparedCwd } from '../workspace';
import { TurnResources } from './resources';

/** Everything a turn can hold, each saying when it was let go of; `failing` ones fail to. */
function held(failing: string[] = []) {
  const order: string[] = [];
  const done = (name: string) => async () => {
    order.push(name);
    if (failing.includes(name)) throw new Error(`${name} would not let go`);
  };
  const resources = new TurnResources();
  resources.gh = { close: done('gh') } as unknown as GhService;
  resources.aiGateway = { close: done('gateway') } as unknown as GatewayForwarder;
  resources.commands = { close: done('commands') } as unknown as TurnCommands;
  resources.sandbox = { close: done('sandbox') } as unknown as SandboxSession;
  resources.prepared = { release: done('workdir') } as unknown as PreparedCwd;
  resources.turnFiles = { release: done('attachments') } as unknown as TurnFiles;
  resources.followUps = { release: done('follow-ups') } as unknown as TurnFollowUps;
  resources.conversationFiles = { release: done('files') } as unknown as TurnConversationFiles;
  return { resources, order };
}

describe('what a turn holds', () => {
  it('ends the provider’s side with the provider, and keeps the task for what is read of it after (AC-21)', async () => {
    const { resources, order } = held();
    await resources.endWithProvider();
    expect(order.sort()).toEqual(['commands', 'gateway', 'gh']);
  });

  it('lets go of the task’s processes before its folders, and of the Files after the commands (FS-09)', async () => {
    const { resources, order } = held();
    await resources.release();
    const before = (a: string, b: string) => expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    for (const side of ['gh', 'gateway', 'commands']) before(side, 'sandbox');
    for (const folder of ['workdir', 'attachments', 'follow-ups', 'files']) before('sandbox', folder);
    before('commands', 'files');
    expect(new Set(order).size).toBe(8);
  });

  it('lets go of everything else when one part can’t', async () => {
    const { resources, order } = held(['gh', 'sandbox', 'workdir']);
    await expect(resources.release()).resolves.toBeUndefined();
    expect(new Set(order).size).toBe(8);
  });
});
