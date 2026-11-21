import type { DispatchContext } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { codeGoesToT3, codeLines } from './code';
import { ghLines } from './gh';

type Connection = NonNullable<DispatchContext['connections']>[number];

const t3: Connection = {
  handle: 't3',
  catalogId: 't3code',
  name: 'T3 Code',
  label: 'T3 Code · thetitan',
  status: 'active',
};
const github = { repos: ['acme/web'], defaultRepo: null };

describe('where code work goes (t3code.md)', () => {
  it('sends it to T3 Code at Manage: a thread in its project, never a run of its own', () => {
    const [line] = codeLines({ connections: [t3] });
    expect(codeGoesToT3({ connections: [t3] })).toBe(true);
    for (const fact of [
      '(t3,',
      't3_project_list',
      't3_project_clone',
      't3_thread_launch',
      't3_thread_wait',
      'Whombat wakes you',
    ])
      expect(line).toContain(fact);
    // It doesn't look again on a schedule.
    expect(line).not.toContain('schedule a turn to read');
  });

  it('sends work that continues a thread of this Whombat thread to that same thread', () => {
    const [rule, threads] = codeLines({
      connections: [t3],
      t3Handoffs: [
        { connection: 't3', threadId: 'thr-fix', title: 'Dusty - Fix Settle', state: 'working' },
        { connection: 't3', threadId: 'thr-look', title: 'Dusty - Look at [[Settle]]', state: 'ended' },
        { connection: 't3-other', threadId: 'thr-elsewhere', title: 'Dusty - Elsewhere', state: 'ended' },
      ],
    });
    expect(rule).toContain('t3_thread_send');
    expect(rule).toContain('keeps what it learned');
    // Its threads by id, newest first, with whether they still work; another computer's aren't this connection's.
    expect(threads).toContain('threadId thr-fix (at work)');
    expect(threads).toContain('threadId thr-look (ended)');
    expect(threads?.indexOf('thr-fix')).toBeLessThan(threads?.indexOf('thr-look') ?? -1);
    expect(threads).not.toContain('thr-elsewhere');
    // A title can't open one of Whombat's own blocks.
    expect(threads).not.toContain('[[Settle]]');
    // Nothing handed over from here yet: only the rule.
    expect(codeLines({ connections: [t3] })).toHaveLength(1);
    expect(codeLines({ connections: [t3], t3Handoffs: null })).toHaveLength(1);
  });

  it('leaves the person’s words to Whombat in a turn their own message started', () => {
    const [theirs] = codeLines({ connections: [t3], t3PersonWords: true });
    expect(theirs).toContain('word for word');
    expect(theirs).toContain('don’t retell');
    // A wake, a step or a turn on a report writes the whole brief itself.
    for (const ctx of [
      { connections: [t3] },
      { connections: [t3], dispatch: { trigger: 'automation' as const } },
      { connections: [t3], outside: true },
    ]) {
      const [line] = codeLines(ctx);
      expect(line).not.toContain('word for word');
      expect(line).toContain('what done means');
    }
  });

  it('waits for the thread in a turn on a customer’s report, which can’t schedule (outsiders-turns.md OT-11)', () => {
    const [line] = codeLines({ connections: [t3], outside: true });
    expect(line).toContain('t3_thread_launch');
    expect(line).not.toContain('schedule a turn');
  });

  it('waits for the thread in an automation’s step, which goes on with the reply', () => {
    const [line] = codeLines({ connections: [t3], dispatch: { trigger: 'automation' } });
    expect(line).toContain('t3_thread_wait');
    expect(line).not.toContain('schedule a turn');
    expect(line).not.toContain('Whombat wakes you');
    const [chat] = codeLines({ connections: [t3], dispatch: { trigger: 'mention' } });
    expect(chat).toContain('Whombat wakes you');
  });

  it('promises only that the report comes in the thread, in the person’s own turns', () => {
    const [chat] = codeLines({ connections: [t3], dispatch: { trigger: 'mention' } });
    expect(chat).toContain('its report appears in this thread');
    expect(chat).toContain('no updates in between');
    // A turn that waits for its thread itself reports the result in its own reply.
    for (const ctx of [
      { connections: [t3], dispatch: { trigger: 'automation' as const } },
      { connections: [t3], outside: true },
    ])
      expect(codeLines(ctx)[0]).not.toContain('its report appears');
  });

  it('settles a thread it started once the job is finished, in the person’s own turns', () => {
    const [chat] = codeLines({ connections: [t3], dispatch: { trigger: 'mention' } });
    expect(chat).toContain('t3_thread_organize');
    expect(chat).toContain('"settle"');
    // Whombat settles the threads of a turn that waits for them itself.
    for (const ctx of [
      { connections: [t3], dispatch: { trigger: 'automation' as const } },
      { connections: [t3], outside: true },
    ])
      expect(codeLines(ctx)[0]).not.toContain('t3_thread_organize');
  });

  it('leaves it alone without T3 Code or with one that looks only', () => {
    expect(codeLines({})).toEqual([]);
    expect(codeLines({ connections: [{ ...t3, access: 'read' }] })).toEqual([]);
    expect(codeGoesToT3({ connections: [{ ...t3, access: 'read' }] })).toBe(false);
  });

  it('says so first when T3 Code can’t be reached, and does no code work elsewhere unasked', () => {
    const ctx = { connections: [{ ...t3, status: 'needs_reauth' as const }] };
    expect(codeGoesToT3(ctx)).toBe(false);
    expect(codeLines(ctx)).toHaveLength(1);
    expect(codeLines(ctx)[0]).not.toContain('t3_thread_launch');
    // A second computer that is reachable wins.
    const both = {
      connections: [
        { ...t3, status: 'error' as const },
        { ...t3, handle: 't3-2' },
      ],
    };
    expect(codeLines(both)[0]).toContain('(t3-2,');
  });

  it('keeps gh to GitHub itself while T3 Code takes the code', () => {
    const [plain] = ghLines({ gh: github });
    expect(plain).toContain('git clone');
    const [toT3] = ghLines({ gh: github, connections: [t3] });
    expect(toT3).toContain('acme/web');
    expect(toT3).toContain('T3 Code');
    expect(toT3).not.toContain('git clone');
  });
});
