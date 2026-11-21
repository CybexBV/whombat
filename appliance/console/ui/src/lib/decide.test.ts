import { describe, expect, it } from 'vitest';
import { constList, deskSocketSource } from './contractsSource';
import { DECIDE_SCOPES, decideBody, decideNeedsPin, parseDecideAnswer } from './decide';

describe('the answer to a decision (DK-61, DK-62, CG-193)', () => {
  it('is decided from a runtime before 0.108 and from one after, with the talk that follows', () => {
    expect(parseDecideAnswer(200, { v: 1 })).toEqual({ result: 'decided', talk: null });
    expect(parseDecideAnswer(200, { v: 1, result: 'decided', talk: 'dtk_follow0001' })).toEqual({
      result: 'decided',
      talk: 'dtk_follow0001',
    });
    expect(parseDecideAnswer(200, { v: 1, result: 'decided', talk: '../x' })).toEqual({
      result: 'decided',
      talk: null,
    });
  });

  it('reads a wrong PIN and the wait as the unlock does', () => {
    expect(parseDecideAnswer(200, { v: 1, result: 'wrong', triesLeft: 3 })).toEqual({
      result: 'wrong',
      triesLeft: 3,
    });
    expect(parseDecideAnswer(200, { v: 1, result: 'backoff', retryAt: '2026-10-20T12:36:00Z' })).toEqual({
      result: 'backoff',
      retryAt: '2026-10-20T12:36:00Z',
    });
  });

  it('maps Whombat’s refusals as the console server passes them on', () => {
    expect(parseDecideAnswer(403, { message: 'pin_needed' })).toEqual({ result: 'pinNeeded' });
    expect(parseDecideAnswer(403, { message: 'on_phone' })).toEqual({ result: 'onPhone' });
    expect(parseDecideAnswer(403, { message: 'not_offered' })).toEqual({ result: 'notOffered' });
    expect(parseDecideAnswer(404, { message: 'not_found' })).toEqual({ result: 'gone' });
    expect(parseDecideAnswer(409, { message: 'decided' })).toEqual({ result: 'gone' });
    expect(parseDecideAnswer(409, { message: 'locked' })).toEqual({ result: 'locked' });
    expect(parseDecideAnswer(502, { message: 'failed' })).toEqual({ result: 'failed' });
    expect(parseDecideAnswer(200, { v: 1, result: 'maybe' })).toEqual({ result: 'failed' });
  });
});

describe('a decision’s scope (0.116, TF-14, CG-281)', () => {
  it('knows the contracts’ scopes and their rules', () => {
    expect(deskSocketSource).toContain('export const DESK_DECIDE_SCOPES = COMMAND_SCOPES;');
    expect(DECIDE_SCOPES).toEqual(['once', ...constList(deskSocketSource, 'DESK_CHOICE_SCOPES')]);
    expect(deskSocketSource).toContain(
      "return ask.approveWithPin === true || (request.scope !== undefined && request.scope !== 'once');",
    );
  });

  it('needs the PIN for every wider choice and a risky approve, never for Deny or Not now', () => {
    expect(decideNeedsPin({}, { decision: 'approve' })).toBe(false);
    expect(decideNeedsPin({}, { decision: 'approve', scope: 'once' })).toBe(false);
    expect(decideNeedsPin({}, { decision: 'approve', scope: 'agent' })).toBe(true);
    expect(decideNeedsPin({}, { decision: 'approve', scope: 'task' })).toBe(true);
    expect(decideNeedsPin({ approveWithPin: true }, { decision: 'approve' })).toBe(true);
    expect(decideNeedsPin({ approveWithPin: true }, { decision: 'deny' })).toBe(false);
    expect(decideNeedsPin({}, { decision: 'decline', scope: 'agent' })).toBe(false);
  });

  it('sends a scope only with approve, and nothing new when approving once', () => {
    expect(decideBody(7, 'approve')).toEqual({ number: 7, decision: 'approve' });
    expect(decideBody(7, 'approve', { pin: '2580', scope: 'agent' })).toEqual({
      number: 7,
      decision: 'approve',
      pin: '2580',
      scope: 'agent',
    });
    expect(decideBody(7, 'deny', { scope: 'agent' })).toEqual({ number: 7, decision: 'deny' });
    expect(decideBody(7, 'approve', { pin: '2580' })).toEqual({
      number: 7,
      decision: 'approve',
      pin: '2580',
    });
  });
});
