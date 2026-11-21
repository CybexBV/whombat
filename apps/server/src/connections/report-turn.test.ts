import { describe, expect, it } from 'vitest';
import {
  filterOwnThreads,
  quotedStranger,
  reportTurnLaunchArgs,
  reportTurnLists,
  subagentParentOfRead,
} from './report-turn';

describe('a report turn in T3 Code (outsiders-turns.md)', () => {
  it('lists only finding a project, starting a thread and following it', () => {
    for (const tool of [
      't3_project_list',
      't3_thread_launch',
      't3_thread_wait',
      't3_thread_read',
      't3_thread_send',
      't3_thread_list',
    ])
      expect(reportTurnLists(tool)).toBe(true);
    for (const tool of [
      'schedule_task',
      't3_environment_link',
      't3_thread_transfer',
      't3_project_create',
      't3_project_delete',
      'toString',
    ])
      expect(reportTurnLists(tool)).toBe(false);
  });

  it('starts a thread in a new worktree: added when none is given, kept as asked, anything else refused', () => {
    expect(reportTurnLaunchArgs({ projectId: 'p1', title: 'Look' })).toEqual({
      ok: true,
      args: { projectId: 'p1', title: 'Look', workspaceStrategy: { type: 'worktree', baseRef: 'HEAD' } },
    });
    const asked = { type: 'worktree', baseRef: 'main', branch: 'feat/tracker-15', startFromOrigin: true };
    expect(reportTurnLaunchArgs({ projectId: 'p1', workspaceStrategy: asked })).toEqual({
      ok: true,
      args: { projectId: 'p1', workspaceStrategy: asked },
    });
    expect(
      reportTurnLaunchArgs({
        projectId: 'p1',
        workspaceStrategy: { type: 'existing_worktree', worktreePath: '/x' },
      }).ok,
    ).toBe(false);
    expect(reportTurnLaunchArgs({ scratch: true }).ok).toBe(false);
  });

  it('lists only its own threads and the reviews they handed out', () => {
    const own = new Set(['mcp:fix']);
    const listed = filterOwnThreads(
      {
        currentThreadId: 'mine',
        total: 4,
        nextCursor: null,
        threads: [
          { threadId: 'mcp:fix', title: 'Fix Acme #23' },
          { threadId: 'review-1', parentThreadId: 'mcp:fix', relationshipToParent: 'subagent' },
          { threadId: 'review-2', parentThreadId: 'mcp:other', relationshipToParent: 'subagent' },
          { threadId: 'johns-work', title: 'Something of the person' },
          { threadId: 'moved', parentThreadId: 'mcp:fix', relationshipToParent: 'fork' },
        ],
      },
      own,
    );
    expect(listed?.threads).toEqual([
      { threadId: 'mcp:fix', title: 'Fix Acme #23' },
      { threadId: 'review-1', parentThreadId: 'mcp:fix', relationshipToParent: 'subagent' },
    ]);
    expect(listed).not.toHaveProperty('currentThreadId');
    expect(listed).not.toHaveProperty('total');
    expect(filterOwnThreads('not a list', own)).toBeNull();
  });

  it('reads whose review a thread is from T3 Code’s answer', () => {
    expect(
      subagentParentOfRead({ thread: { parentThreadId: 'mcp:fix', relationshipToParent: 'subagent' } }),
    ).toBe('mcp:fix');
    expect(subagentParentOfRead({ thread: { parentThreadId: null } })).toBeNull();
    expect(
      subagentParentOfRead({ thread: { parentThreadId: 'x', relationshipToParent: 'fork' } }),
    ).toBeNull();
    expect(subagentParentOfRead(null)).toBeNull();
  });

  it('finds the customer’s own words in what a thread is handed, eight in a row, spelling aside', () => {
    const report =
      'At DEMO-01 computer details page at Diagnostics there is a HUGE list of issues, this is not very helpful.';
    expect(
      quotedStranger(
        `Fix this. Customer report: "At DEMO-01 computer details page at Diagnostics there is a huge list"`,
        report,
      ),
    ).toBe('at demo 01 computer details page at diagnostics');
    // In the agent's own words: nothing quoted, even with a few of theirs.
    expect(
      quotedStranger(
        'A customer finds the Diagnostics section of a computer too long: old, fixed problems are listed with current ones.',
        report,
      ),
    ).toBeNull();
    // A short report can't be quoted at length.
    expect(quotedStranger('This is a test, not a bug report.', 'This is a test.')).toBeNull();
  });
});
