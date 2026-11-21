/** What the assistant may do on the phone: every permission by thing, in three words. */
import { type AgentProfile, api } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import { agentMayView, type MayFacts } from './agentMay';
import { accessDraft, accessOptions, accessView } from './agentSettings';

const facts: MayFacts = {
  agent: 'Dusty',
  serversPresent: true,
  servers: [],
  connections: [],
  vault: [],
  grants: [],
  commands: 0,
};

const on = { console: true, power: true, manage: true, hostShell: true };
const off = { console: false, power: false, manage: false, hostShell: false };

async function agentProfile(): Promise<AgentProfile> {
  const client = demoClient(createFixtureFetch());
  const result = await client.request(api.agent.get, { params: { burrow: 'burrow-hq' } });
  if (result.status !== 'ok') throw new Error(result.status);
  return result.data;
}

describe('What Dusty may do', () => {
  it('starts with what it did, by its name', () => {
    const view = agentMayView(facts);
    expect(view.did.title).toBe('Everything Dusty did');
    expect(view.intro).toContain('Always allow');
  });

  it('gives each server its word, and the choice where Whombat may change something', () => {
    const view = agentMayView({
      ...facts,
      servers: [
        { id: 'pve-02', name: 'pve-02', remoteControl: on, asksFirst: 'risky' },
        { id: 'thetitan', name: 'thetitan', remoteControl: on, asksFirst: 'never', hostsThisWhombat: true },
        { id: 'nas', name: 'nas', remoteControl: off },
      ],
    });
    const [pve, beast, nas] = view.servers?.rows ?? [];
    expect(pve).toMatchObject({ thing: 'server:pve-02', word: 'ask', wordText: 'Ask me first' });
    expect(pve?.choice?.value).toBe('risky');
    expect(pve?.choice?.options.map((o) => o.label)).toEqual(['Ask me first', 'Go ahead']);
    expect(pve?.choice?.label).toContain('Dusty');
    expect(pve?.choice?.label).toContain('pve-02');
    // The server this Whombat runs on still asks before restarting it.
    expect(beast).toMatchObject({ word: 'go', choice: { value: 'never' } });
    expect(beast?.line).toContain('thetitan');
    // A server Whombat only watches has its word and nothing to choose.
    expect(nas).toMatchObject({ word: 'watch', wordText: 'Just watch', choice: null });
  });

  it('waits for the servers, says when there are none, and leaves them out without the servers service', () => {
    expect(agentMayView({ ...facts, servers: undefined }).servers).toMatchObject({
      loading: true,
      empty: null,
    });
    expect(agentMayView(facts).servers?.empty).toBe('No servers yet.');
    expect(agentMayView({ ...facts, servers: null }).servers?.empty).toBe('No servers yet.');
    expect(agentMayView({ ...facts, serversPresent: false }).servers).toBeNull();
  });

  it('gives each connection the level it was connected with', () => {
    const view = agentMayView({
      ...facts,
      connections: [
        { id: 'con_u', catalogId: 'unifi', label: 'Home UniFi', access: 'read' },
        { id: 'con_h', catalogId: 'homeassistant', label: '' },
        { id: 'con_d', catalogId: 'device', label: 'Printer', access: 'manage' },
      ],
    });
    const [unifi, ha, printer] = view.connections?.rows ?? [];
    expect(unifi).toMatchObject({ title: 'Home UniFi', word: 'watch', thing: 'connection:con_u' });
    // No label: the catalog's name; no level: Manage, which is Go ahead.
    expect(ha).toMatchObject({ title: 'Home Assistant', word: 'go' });
    expect(printer?.thing).toBe('device:con_d');
    expect(view.connections?.how).toBeTruthy();
    expect(agentMayView(facts).connections).toMatchObject({ empty: 'Nothing connected yet.', how: null });
    expect(agentMayView({ ...facts, connections: null }).connections).toBeNull();
  });

  it('counts the Vault sign-ins it may use, not the old secrets', () => {
    const view = agentMayView({
      ...facts,
      vault: [
        { name: 'Router', kind: 'login', agentOn: true },
        { name: 'NAS', kind: 'ssh', agentOn: true },
        { name: 'Bank', kind: 'login', agentOn: false },
        { name: 'Old', kind: 'secret', agentOn: true },
      ],
    });
    expect(view.signIn?.title).toContain('2 sign-ins');
    expect(view.signIn?.names).toBe('Router · NAS');
    expect(agentMayView(facts).signIn).toMatchObject({ names: null });
    expect(agentMayView({ ...facts, vault: undefined }).signIn).toBeNull();
  });

  it('sums the keys up by word, as the keys page shows them', async () => {
    const profile = await agentProfile();
    const view = agentMayView({ ...facts, grants: profile.grants, commands: 2 });
    const opts = accessOptions();
    const rows = accessView(accessDraft(profile.grants, opts), opts).rows;
    // Every row is under one word, and the words read as the shared ones.
    const labels = view.keys.words.flatMap((w) => w.labels.split(' · '));
    expect(labels.sort()).toEqual([...rows.map((r) => r.label), 'Change settings for you'].sort());
    for (const w of view.keys.words) expect(['Just watch:', 'Ask me first:', 'Go ahead:']).toContain(w.title);
    expect(view.keys.commands).toBe('2 commands always allowed.');
    expect(agentMayView({ ...facts, commands: undefined }).keys.commands).toBeNull();
  });

  it('with no keys at all, everything is Just watch', () => {
    const words = agentMayView(facts).keys.words;
    expect(words.map((w) => w.word)).toEqual(['watch']);
    expect(words[0]?.labels).toContain('Merge into main');
  });
});
