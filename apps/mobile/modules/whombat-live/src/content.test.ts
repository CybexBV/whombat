import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalLiveActivity, runLiveActivity } from '@whombat/core';
import { bootstrap, run, runFinished } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { peopleFrom } from '../../../src/data/people';
import { mobileMomentApproval } from '../../../src/fixtures/fixture-server';
import { liveViewer } from '../../../src/live/viewer';
import { approvalLiveFor, reconcileActivities, runLiveFor } from './content';

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
  it.each([
    ['en-GB', 'values'],
    ['nl-NL', 'values-nl'],
  ])('uses the shared content-free words for %s', async (locale, folder) => {
    const { pushText } = await import('@whombat/client/managed');
    const xml = readFileSync(join(__dirname, `../android/src/main/res/${folder}/strings.xml`), 'utf8');
    const native = Object.fromEntries(
      [...xml.matchAll(/<string name="whombat_push_(\w+)">([^<]+)<\/string>/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    expect(native).toEqual(pushText(locale));
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
    expect(kotlin).toMatch(/"approve" -> words.getString\(R.string.whombat_action_review\)/);
    expect(widget).toContain('state.actionLabel(action)');
    expect(attributes).toMatch(/case "approve": return dutch \? "Bekijken" : "Review"/);
    for (const source of [kotlin, widget, attributes]) expect(source).not.toContain('decide=');
  });
});

it('uses Dutch for a run and an approval while preserving their titles and URLs', () => {
  const owned = { ...run, status: 'paused' as const, askedById: mara.id };
  const english = runLiveFor(owned, mara, 'en-GB');
  const dutch = runLiveFor(owned, mara, 'nl-NL');
  expect(dutch?.display).toMatchObject({ key: english?.display.key, title: owned.title });
  expect(dutch?.display.text).toContain('Gepauzeerd');
  expect(english?.display.text).toContain('Paused');
  const approval = mobileMomentApproval();
  const viewer = {
    ...mara,
    id: approval.conditions.flatMap((c) => (c.kind === 'person_approves' ? c.approverIds : []))[0] ?? mara.id,
  };
  expect(approvalLiveFor(approval, viewer, 'nl-NL')?.display.text).toContain('voorwaarden');
});
