/**
 * “Asks you first” on the phone (Whombat server-asks.md SA-05…SA-08; server-asks-mobile.md AP-1740…AP-1745): the row on
 * a server's page, what a change takes, and “Don’t ask again on thetitan” on a Servers approval.
 */

import { OutcomeRedactedError, OutcomeUnknownError } from '@whombat/client';
import { type Approval, HOST_ASKS_FIRST_WORDS, KEY_CATALOG } from '@whombat/core';
import { deployApproval, mara, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { serverAsksApproval } from '../fixtures/serverAsks';
import { worldContext } from '../test/world';
import {
  answerMayHaveGoneThrough,
  approvalByline,
  approvalScreen,
  scopedApproveToast,
  stopAskingServer,
} from './approval';
import { cardSummary } from './messages';
import { serverAsksChange, serverAsksRow } from './serverAsks';

const row = (over: Partial<Parameters<typeof serverAsksRow>[0]> = {}) =>
  serverAsksRow({
    server: 'thetitan',
    asksFirst: undefined,
    hostsThisWhombat: false,
    available: true,
    ...over,
  });

describe('the “Asks you first” row (SA-08)', () => {
  it('is Never when the server has no setting, with its hint', () => {
    // The hint names updates since contracts 0.98.0 (Whombat server-updates.md SWU-09).
    expect(HOST_ASKS_FIRST_WORDS.hint.risky).toContain('updates');
    expect(row()).toEqual({
      label: HOST_ASKS_FIRST_WORDS.label,
      value: 'never',
      options: [
        { value: 'risky', label: 'Ask me first' },
        { value: 'never', label: 'Go ahead' },
      ],
      hint: HOST_ASKS_FIRST_WORDS.hint.never,
      selfNote: null,
      accessibilityLabel: HOST_ASKS_FIRST_WORDS.labelOn('thetitan'),
    });
  });

  it('says Whombat acts on its own on Never', () => {
    expect(row({ asksFirst: 'never' })).toMatchObject({
      value: 'never',
      hint: HOST_ASKS_FIRST_WORDS.hint.never,
      selfNote: null,
    });
  });

  it('adds that it still asks before restarting the server this Whombat runs on (SA-03)', () => {
    const note = row({ asksFirst: 'never', hostsThisWhombat: true })?.selfNote;
    expect(note).toBe(HOST_ASKS_FIRST_WORDS.selfNote('thetitan'));
    expect(note).toContain('thetitan');
    expect(row({ asksFirst: 'risky', hostsThisWhombat: true })?.selfNote).toBeNull();
  });

  it('is for a Whombat with hosts.asks only (SA-05)', () => {
    expect(row({ available: false })).toBeNull();
  });
});

describe('changing it (SA-08)', () => {
  it('asks before Never, in core’s words', () => {
    expect(serverAsksChange('thetitan', 'risky', 'never')).toEqual({
      confirm: {
        title: HOST_ASKS_FIRST_WORDS.confirmTitle('thetitan'),
        body: HOST_ASKS_FIRST_WORDS.confirmBody('thetitan'),
        confirm: HOST_ASKS_FIRST_WORDS.confirm,
        cancel: 'Cancel',
      },
      toast: HOST_ASKS_FIRST_WORDS.changed('thetitan', 'never'),
    });
  });

  it('goes back to Before risky actions without a question', () => {
    expect(serverAsksChange('thetitan', 'never', 'risky')).toEqual({
      confirm: null,
      toast: HOST_ASKS_FIRST_WORDS.changed('thetitan', 'risky'),
    });
  });

  it('does nothing when the choice is the same', () => {
    expect(serverAsksChange('thetitan', 'never', 'never')).toBeNull();
  });
});

describe('“Don’t ask again on thetitan” on a Servers approval (SA-07)', () => {
  it('answers Yes, do it · No and offers it apart, naming the server’s page to change it back', () => {
    const approval = serverAsksApproval();
    expect(stopAskingServer(approval)).toEqual({ id: 'thetitan', name: 'thetitan' });
    const model = approvalScreen(approval, worldContext(), 'Clean up Docker on thetitan');
    expect(model.footer).toEqual({
      kind: 'answers',
      canApprove: true,
      canDecline: true,
      answers: [
        { id: 'now', label: 'Yes, do it', filled: false },
        { id: 'no', label: 'No', filled: false },
      ],
    });
    expect(model.lasting?.link).toContain('thetitan');
    expect(model.lasting?.body).toContain('thetitan’s page');
    expect([model.lasting?.confirm, model.lasting?.keep]).toEqual([expect.any(String), 'Keep asking']);
  });

  it('offers Yes, now · Yes, tonight · No, none of them filled, when a later time is offered', () => {
    const model = approvalScreen(serverAsksApproval(), worldContext(), undefined, SEED_NOW.toISOString());
    expect(model.footer).toMatchObject({
      kind: 'answers',
      answers: [
        { id: 'now', label: 'Yes, now', filled: false },
        { id: 'later', label: 'Yes, tonight', filled: false },
        { id: 'no', label: 'No', filled: false },
      ],
    });
  });

  it('says so when it went through', () => {
    const approval = serverAsksApproval();
    expect(scopedApproveToast(approval, 'agent', worldContext())).toBe(
      'Approved. Whombat won’t ask again on thetitan.',
    );
  });

  it('isn’t offered on a Servers call without a server (an older Whombat), or on other approvals', () => {
    const plain = serverAsksApproval();
    const action = plain.action as Extract<Approval['action'], { type: 'connection_call' }>;
    const { server: _server, ...params } = action.params;
    const older = { ...plain, action: { ...action, params } };
    expect(stopAskingServer(older)).toBeNull();
    expect(approvalScreen(older, worldContext()).lasting).toBeNull();
    expect(stopAskingServer(deployApproval())).toBeNull();
  });

  it('ends the decided card with what changed', () => {
    const decided = serverAsksApproval({
      state: 'approved',
      scope: 'agent',
      decidedById: mara.id,
      decidedAt: SEED_NOW.toISOString(),
      executedAt: SEED_NOW.toISOString(),
      execution: {
        state: 'succeeded',
        startedAt: SEED_NOW.toISOString(),
        finishedAt: SEED_NOW.toISOString(),
        durationMs: 1800,
        resultUrl: null,
        error: null,
      },
    });
    expect(approvalScreen(decided, worldContext()).message).toContain(
      'From now on Whombat acts on thetitan without asking.',
    );
  });
});

describe('an everyday ask in plain words (handle-it.md)', () => {
  it('asks “{assistant} needs your OK”, its facts before the answers, the tool folded under Details', () => {
    const approval = serverAsksApproval();
    const screen = approvalScreen(approval, worldContext());
    expect(screen.label).toMatch(/ needs your OK$/);
    expect(screen.footer).toMatchObject({ kind: 'answers' });
    expect(screen.facts?.happens).toEqual(approval.whatHappens);
    expect(screen.facts?.permission.text).toContain(KEY_CATALOG[approval.keyId].label);
    // No later time offered: nothing says what tonight means.
    expect(screen.facts?.tonight).toBeNull();
    expect(
      approvalScreen(approval, worldContext(), undefined, '2026-09-24T01:00:00.000Z').facts?.tonight?.at,
    ).toBe('Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam');
    expect(screen.conditions).toEqual([]);
    expect(screen.technical?.label).toBe('Details');
    expect(screen.technical?.text).toContain('server_command');
    // Code keeps the mocks' words.
    expect(approvalScreen(deployApproval(), worldContext()).technical).toBeNull();
  });
});

describe('the approval page’s byline and conditions', () => {
  it('names a conversation called after the one who asks only once', () => {
    expect(approvalByline('Neo', 'Neo', '14:03')).toBe('Neo · 14:03');
    expect(approvalByline('Neo', '#billing-v2', '14:03')).toBe('Neo · #billing-v2 · 14:03');
    expect(approvalByline('Neo', undefined, '14:03')).toBe('Neo · 14:03');
  });

  it('leaves out the card when an everyday ask waits only for the person’s yes', () => {
    const model = approvalScreen(serverAsksApproval(), worldContext(), 'Neo');
    expect(model.conditions).toEqual([]);
  });
});

describe('the thread’s approval card as a door (AP-1747)', () => {
  it('waits with a door, then says where it is once answered, in the shared words', () => {
    const waiting = cardSummary({ kind: 'approval', approval: serverAsksApproval() }, worldContext());
    expect(waiting?.approvalDoor).toEqual({ waiting: true, state: null });
    const declined = serverAsksApproval({
      state: 'declined',
      decidedById: mara.id,
      decidedAt: SEED_NOW.toISOString(),
    });
    const answered = cardSummary({ kind: 'approval', approval: declined }, worldContext());
    expect(answered?.approvalDoor?.waiting).toBe(false);
    expect(answered?.approvalDoor?.state?.text).toMatch(/^You said no/);
    // Code keeps its own words and no answer line.
    expect(
      cardSummary({ kind: 'approval', approval: deployApproval() }, worldContext())?.approvalDoor?.state,
    ).toBeNull();
  });
});

describe('an answer whose outcome is unknown (command-safety.md)', () => {
  it('may have gone through after a lost reply, never after a refusal or a kept completion', () => {
    expect(answerMayHaveGoneThrough(new OutcomeUnknownError('approvals.decide', 'r1'))).toBe(true);
    expect(answerMayHaveGoneThrough(new OutcomeRedactedError('approvals.decide', 'r1', null))).toBe(true);
    expect(answerMayHaveGoneThrough(new OutcomeRedactedError('approvals.decide', 'r1', 'completed'))).toBe(
      false,
    );
    expect(answerMayHaveGoneThrough(new Error('refused'))).toBe(false);
  });
});
