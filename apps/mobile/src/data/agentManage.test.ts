/**
 * Changing the agent from the phone (AP-707, AP-713; one-agent.md AP-4965, AP-4969): why Settings → Agent didn't load,
 * its keys as the web's Keys sets them, and its parts.
 */
import { ApiError, NeedsNewerAppError, NetworkError } from '@whombat/client';
import { type AgentProfile, api } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import {
  AGENT_FAILED_TEXT,
  AGENT_GONE_TEXT,
  AGENT_OFFLINE_TEXT,
  agentLoadProblem,
  contractMismatchLine,
} from './agentLoad';
import { agentKeyParam, agentParts } from './agentPage';
import {
  accessChanges,
  accessDraft,
  accessOptions,
  accessView,
  isTierSwitch,
  keyTarget,
  sameAccess,
  settingsRefusal,
  settingsSavedText,
} from './agentSettings';

async function agentProfile(): Promise<AgentProfile> {
  const client = demoClient(createFixtureFetch());
  const result = await client.request(api.agent.get, { params: { burrow: 'burrow-hq' } });
  if (result.status !== 'ok') throw new Error(result.status);
  return result.data;
}

describe('why Settings → Agent didn’t load (AP-707)', () => {
  it('a newer Whombat’s keys: the update path; gone: no Try again; offline and the rest: what happened', () => {
    expect(
      agentLoadProblem(new NeedsNewerAppError('agent.get', { 'grants.3.keyId': ['Invalid option'] }, {})),
    ).toEqual({ kind: 'newer' });
    expect(agentLoadProblem(new ApiError(404, 'not_found', 'Not here', {}, 'agent.get'))).toEqual({
      kind: 'gone',
      text: AGENT_GONE_TEXT,
    });
    expect(agentLoadProblem(new NetworkError('agent.get', new Error('offline')))).toEqual({
      kind: 'retry',
      text: AGENT_OFFLINE_TEXT,
    });
    expect(agentLoadProblem(new ApiError(403, 'forbidden', 'You can’t see this.', {}, 'agent.get'))).toEqual({
      kind: 'retry',
      text: 'You can’t see this.',
    });
    expect(agentLoadProblem(new Error('boom'))).toEqual({ kind: 'retry', text: AGENT_FAILED_TEXT });
  });

  it('logs the paths that didn’t match, never the values', () => {
    const err = new NeedsNewerAppError(
      'agent.get',
      { 'grants.3.keyId': ['Invalid option'] },
      { secret: 'x' },
    );
    expect(contractMismatchLine(err)).toBe('agent.get: grants.3.keyId: Invalid option');
    expect(contractMismatchLine(new Error('x'))).toBeNull();
  });
});

describe('keys (AP-713, AP-4969)', () => {
  it('starts from what the agent holds and changes nothing until edited', async () => {
    const profile = await agentProfile();
    const opts = accessOptions();
    const draft = accessDraft(profile.grants, opts);
    expect(accessChanges(profile.grants, draft, draft, opts)).toBeNull();
    expect(sameAccess(draft, { ...draft, keys: { ...draft.keys } })).toBe(true);
  });

  it('a row set to On: the grants the web would send', async () => {
    const profile = await agentProfile();
    const opts = accessOptions();
    const base = accessDraft(profile.grants, opts);
    const edited = { ...base, tiers: { ...base.tiers, merge: 'can' as const } };
    expect(sameAccess(base, edited)).toBe(false);
    const grants = accessChanges(profile.grants, base, edited, opts);
    expect(grants?.some((g) => g.keyId === 'merge.main' && g.tier === 'can')).toBe(true);
  });

  it('shows the rows by risk, then All keys with a count', async () => {
    const profile = await agentProfile();
    const opts = accessOptions();
    const view = accessView(accessDraft(profile.grants, opts), opts);
    expect(view.rows.map((r) => r.label)).toContain('Merge into main');
    expect(view.all.length).toBe(opts.allOptions.length);
    expect(view.allCount).toMatch(/^\d+ of \d+ on$/);
    expect(view.all.some(isTierSwitch)).toBe(true);
  });

  it('finds the row a link points at: its row by risk, else All keys', () => {
    const opts = accessOptions();
    expect(keyTarget('deploy.production', opts)).toEqual({ place: 'row', keyId: 'deploy' });
    expect(keyTarget('web.browse', opts)?.place).toBe('all');
    expect(keyTarget(undefined, opts)).toBeNull();
  });

  it('what a save says', () => {
    expect(settingsSavedText('Dusty', 'keys')).toBe('Updated Dusty’s keys.');
    expect(settingsRefusal({ status: 'ok' })).toBeNull();
    expect(settingsRefusal({ status: 'blocked', message: 'No.' })).toBe('No.');
    expect(settingsRefusal({ status: 'pending_approval', approvalNumber: 9 })).toContain('#9');
  });
});

describe('the assistant’s parts', () => {
  it('lists the shared parts in order, What it may do by its name, Council last', () => {
    expect(agentParts('Dusty').map((p) => p.key)).toEqual([
      'profile',
      'ai',
      'memory',
      'may',
      'ahead',
      'council',
    ]);
    expect(agentParts('Dusty').find((p) => p.key === 'may')?.label).toBe('What Dusty may do');
    expect(agentParts('Dusty').find((p) => p.key === 'ahead')?.label).toBe('Looks ahead');
  });

  it('leaves Looks ahead out on a Whombat that doesn’t have it', () => {
    expect(agentParts('Dusty', { looksAhead: false }).map((p) => p.key)).not.toContain('ahead');
  });

  it('keeps a key that looks like one', () => {
    expect(agentKeyParam('deploy.production')).toBe('deploy.production');
    expect(agentKeyParam('<script>')).toBeUndefined();
  });
});
