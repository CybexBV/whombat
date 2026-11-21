import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalLiveActivity, runLiveActivity } from '@whombat/core';
import { bootstrap, run, runFinished } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { peopleFrom } from '../../../src/data/people';
import { mobileMomentApproval } from '../../../src/fixtures/fixture-server';
import { liveViewer } from '../../../src/live/viewer';
import { reconcileActivities, runLiveFor } from './content';

const b = bootstrap();
const mara = liveViewer(b, peopleFrom(b.principals));

describe('who sees a live activity', () => {
  it('shows the runs you asked for, and the agent’s own only in a conversation of yours', () => {
    expect(runLiveFor({ ...run, askedById: mara.id }, mara)).not.toBeNull();
    const agentAsked = { ...run, askedById: run.agentId };
    expect(runLiveFor(agentAsked, mara)).not.toBeNull();
    expect(runLiveFor({ ...agentAsked, conversationId: 'cnv_elsewhere' }, mara)).toBeNull();
  });
});

describe('pushes and reconnects', () => {
  it('shows what is current, finishes what ended while the app was away, in this burrow only', () => {
    const live = runLiveActivity({ ...run, id: 'run_2001' }, 'Banjo');
    const approval = approvalLiveActivity(mobileMomentApproval(), 'Neo');
    const done = runLiveActivity(runFinished, 'Banjo');
    const plan = reconcileActivities(
      [
        { key: live.display.key, burrow: 'burrow-hq' },
        { key: done.display.key, burrow: 'burrow-hq' },
        { key: 'run:run_old', burrow: 'burrow-hq' },
        { key: 'run:run_other', burrow: 'other-burrow' },
      ],
      [live, approval, done],
      'burrow-hq',
    );
    expect(plan.show.map((s) => s.display.key)).toEqual([live.display.key, approval.display.key]);
    expect(plan.finish.map((s) => s.display)).toEqual([done.display]);
    expect(plan.end).toEqual(['run:run_old']);
  });

  it('refreshes what is on screen and shows what is new, but leaves one that timed out or was swiped away (MN-02)', () => {
    const onScreen = runLiveActivity({ ...run, id: 'run_2001' }, 'Banjo');
    const gone = runLiveActivity({ ...run, id: 'run_2002' }, 'Banjo');
    const fresh = runLiveActivity({ ...run, id: 'run_2003' }, 'Banjo');
    const plan = reconcileActivities(
      [{ key: onScreen.display.key, burrow: 'burrow-hq' }],
      [onScreen, gone, fresh],
      'burrow-hq',
      new Set([onScreen.display.key, gone.display.key]),
    );
    expect(plan.show.map((s) => s.display.key)).toEqual([onScreen.display.key, fresh.display.key]);
    expect(plan.end).toEqual([]);
  });
});

describe('managed pushes shown natively', () => {
  it('use exactly the shared content-free words, one line per kind', async () => {
    const { PUSH_TEXT } = await import('@whombat/client/managed');
    const kotlin = readFileSync(
      join(__dirname, '../android/src/main/java/com/whombat/live/LiveNotifications.kt'),
      'utf8',
    );
    const native = Object.fromEntries(
      [...kotlin.matchAll(/"(\w+)" to "([^"]+)"/g)].map((m) => [m[1] as string, m[2] as string]),
    );
    expect(native).toEqual(PUSH_TEXT);
  });
});

describe('an approval’s live button', () => {
  it('says Review and opens the approval as is, on both platforms, so nothing claims to approve', () => {
    const kotlin = readFileSync(
      join(__dirname, '../android/src/main/java/com/whombat/live/LiveNotifications.kt'),
      'utf8',
    );
    const widget = readFileSync(join(__dirname, '../ios/widget/WhombatLiveWidget.swift'), 'utf8');
    const attributes = readFileSync(join(__dirname, '../ios/WhombatLiveAttributes.swift'), 'utf8');
    expect(kotlin).toMatch(/"approve" -> "Review"/);
    expect(widget).toMatch(/action == "approve" \? "Review"/);
    for (const source of [kotlin, widget, attributes]) expect(source).not.toContain('decide=');
  });
});
