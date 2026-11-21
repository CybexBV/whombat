import { describeActivity } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { activityCopy } from './activity-copy';

const base = { kind: 'whombat' as const, object: null, exitCode: null, failure: null, keyNeeded: null };

describe('activity copy from core (WS-14, CT-89)', () => {
  it('names the assistant’s connector tools in plain words, never what they searched', () => {
    expect(describeActivity({ ...base, tool: 'whombat.mail_search', status: 'running' }).title).toBe(
      'Searching mail',
    );
    expect(describeActivity({ ...base, tool: 'whombat.mail_search', status: 'done' }).title).toBe(
      'Searched mail',
    );
    expect(
      describeActivity({ ...base, tool: 'whombat.mail_send', status: 'failed', failure: 'error' }).title,
    ).toBe('Couldn’t send the email');
    // Asking the owner first (mail_send always asks) is still waiting for approval.
    expect(describeActivity({ ...base, tool: 'whombat.mail_send', status: 'waiting' }).title).toBe(
      'Waiting for approval',
    );
  });

  it('leaves every other tool to core', () => {
    expect(describeActivity({ ...base, tool: 'whombat.post_message', status: 'done' }).title).toBe(
      'Posted a message',
    );
  });
});

describe('a command the runner didn’t run (health-command-loops.md HC-05)', () => {
  const command = {
    kind: 'command' as const,
    tool: 'Bash',
    status: 'failed' as const,
    object: 'pnpm build:widget',
    exitCode: 1,
    failure: 'blocked' as const,
    keyNeeded: null,
  };

  it('says it wasn’t run and why, instead of core’s “Blocked”', () => {
    expect(describeActivity(command).title).toBe('Blocked');
    expect(activityCopy(command)).toEqual({
      title: 'Command not run',
      detail: 'kept failing the same way',
      important: true,
    });
  });

  it('leaves a blocked row that needed a key, and every other row, to core', () => {
    const keyed = { ...command, keyNeeded: 'Deploy' };
    expect(activityCopy(keyed)).toEqual(describeActivity(keyed));
    const failed = { ...command, failure: 'error' as const };
    expect(activityCopy(failed)).toEqual(describeActivity(failed));
    expect(activityCopy(failed).title).toBe('Command failed');
    const whombat = {
      ...base,
      tool: 'whombat.merge_pr',
      status: 'failed' as const,
      failure: 'blocked' as const,
    };
    expect(activityCopy(whombat)).toEqual(describeActivity(whombat));
  });
});

describe('a command Codex couldn’t start: its folder isn’t there (RN-R4)', () => {
  const failed = {
    kind: 'command' as const,
    tool: 'shell',
    status: 'failed' as const,
    object: 'npm run test:e2e',
    exitCode: null,
    failure: 'error' as const,
    keyNeeded: null,
  };
  const codex = 'Failed to create unified exec process: No such file or directory (os error 2)';

  it('says so in plain words instead of the command line or the exit code', () => {
    expect(describeActivity(failed)).toMatchObject({ title: 'Command failed', detail: 'npm run test:e2e' });
    expect(activityCopy(failed, codex)).toEqual({
      title: 'Command failed',
      detail: 'The folder it ran in doesn’t exist.',
      important: true,
    });
    expect(activityCopy({ ...failed, exitCode: -1 }, `exec_command failed: ${codex}\n`).detail).toBe(
      'The folder it ran in doesn’t exist.',
    );
  });

  it('leaves any other failure, and the same words outside a failed command, to core', () => {
    expect(activityCopy(failed, 'npm ERR! missing script: test:e2e')).toEqual(describeActivity(failed));
    expect(activityCopy(failed)).toEqual(describeActivity(failed));
    const done = { ...failed, status: 'done' as const, failure: null };
    expect(activityCopy(done, codex)).toEqual(describeActivity(done));
    const read = { ...failed, kind: 'read' as const };
    expect(activityCopy(read, codex)).toEqual(describeActivity(read));
  });
});
