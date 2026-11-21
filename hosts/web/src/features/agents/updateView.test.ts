import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../api/types';
import { rolloutRunning, updatableCount, updateView } from './updateView';

type A = Pick<AgentInfo, 'version' | 'connected' | 'update'>;
const a = (update: A['update'], version = '0.14.0', connected = true): A => ({ version, connected, update });

describe('updateView', () => {
  it('stays quiet without a hub build, offline or up to date', () => {
    expect(updateView(a(undefined)).kind).toBe('none');
    expect(updateView(a({ available: false, reason: 'The hub has no signed agent build (dist/agent/manifest.json).' })).kind).toBe('none');
    expect(updateView(a({ available: false, version: '0.15.0', reason: 'The agent is not connected.' }, '0.14.0', false)).kind).toBe('none');
    expect(updateView(a({ available: false, version: '0.15.0', reason: 'Up to date.' }, '0.15.0')).kind).toBe('none');
  });
  it('offers the update when the agent can take it', () => {
    expect(updateView(a({ available: true, version: '0.15.0' }))).toEqual({ kind: 'available', version: '0.15.0', canUpdate: true });
  });
  it('explains why an older agent cannot update itself', () => {
    const v = updateView(a({ available: false, version: '0.15.0', reason: 'Updates are turned off in the agent’s configuration ([update] allow).' }));
    expect(v.kind).toBe('blocked');
    expect(v.canUpdate).toBe(false);
    expect(v.text).toContain('[update] allow');
  });
  it('shows a running or failed rollout', () => {
    expect(updateView(a({ available: false, version: '0.15.0', state: 'updating', message: 'Sending 0.15.0' }))).toMatchObject({ kind: 'busy', text: 'Sending 0.15.0' });
    expect(updateView(a({ available: true, version: '0.15.0', state: 'failed', message: 'bad signature' }))).toMatchObject({ kind: 'failed', canUpdate: true });
  });
  it('counts what Update all would do', () => {
    const list = [a({ available: true, version: '2' }), a({ available: false, version: '2', reason: 'x' }), a({ available: true, version: '2', state: 'updating' })];
    expect(updatableCount(list)).toBe(1);
    expect(rolloutRunning(list)).toBe(true);
  });
});
