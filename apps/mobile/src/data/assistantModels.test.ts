/**
 * Chats, servers and the device skill card on the phone (one-whombat-mobile.md AP-1357…AP-1371), against the
 * one-Whombat demo world's data.
 */
import { agentWords } from '@whombat/client';
import type { HostGuest, WatchItem } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { heatPumpCard } from '../fixtures/assistant';
import { askAboutLine, CHATS_COPY } from './chats';
import { DEVICE_CARD_COPY, decideBody, deviceSkillView, initialTiers } from './deviceSkill';
import { canPower, guestRows } from './servers';

const _ZONE = 'Europe/Amsterdam';
const _NOW = new Date(at('14:05'));

const _item = (over: Partial<WatchItem>): WatchItem => ({
  id: 'w',
  ref: { kind: 'alert', id: 'al_1' },
  source: 'server',
  severity: 'warn',
  title: 'CPU running warm',
  body: 'It sat above 75 °C.',
  at: at('12:10'),
  serverId: 'pve-02',
  state: 'open',
  ...over,
});

describe('Ask about (AP-1358)', () => {
  it('says what the agent sees about the subject, naming it (AP-1534)', () => {
    const neo = agentWords('Neo');
    expect(askAboutLine({ kind: 'server', id: 'pve-02', name: 'pve-02' }, neo)).toContain('Neo sees');
    expect(askAboutLine({ kind: 'device', id: 'd', name: 'Heat pump' }, agentWords(null))).toContain(
      'Your agent sees',
    );
    expect(CHATS_COPY.newChatPlaceholder(neo)).toContain('Ask Neo');
  });
});

describe('Servers (AP-1363…AP-1367)', () => {
  const _server = {
    id: 'pve-02',
    name: 'pve-02',
    group: 'Home lab',
    status: 'warn' as const,
    statusNote: 'running warm',
    platform: 'proxmox' as const,
    os: 'Proxmox VE 9.0.10',
    cpu: { model: 'AMD Ryzen 7 5800X', cores: 8, threads: 16 },
    uptimeS: 19 * 86_400,
    cpuPct: 34,
    memory: { usedPct: 88, usedGb: 56.3, totalGb: 64 },
    storage: { usedPct: 55, usedTb: 1.1, capacityTb: 2 },
    temperature: { maxC: 78, limitC: 85 },
    guests: [{ platform: 'pve' as const, running: 23, total: 40 }],
    agent: { version: '0.9.2', connected: true },
    lastSeen: at('14:05'),
    cpu24h: [10, 20],
    remoteControl: { console: true, power: true },
  };

  const guest = (over: Partial<HostGuest>): HostGuest => ({
    id: 'pve:118',
    serverId: 'pve-02',
    name: 'arnica-prod-nest-01',
    platform: 'pve',
    kind: 'vm',
    image: 'debian-12',
    state: 'running',
    cpuPct: 6.2,
    memoryUsedMb: 3584,
    memoryLimitMb: 4096,
    uptimeS: 6 * 86_400,
    console: { available: true },
    vmid: 118,
    ...over,
  });

  it('lists the guests running first, by name, with their kind as a mark and their numbers (AP-1810)', () => {
    const rows = guestRows([
      guest({ id: 'a', name: 'win11', state: 'stopped', cpuPct: null, memoryUsedMb: null, vmid: 130 }),
      guest({
        id: 'b',
        name: 'pihole',
        kind: 'container',
        vmid: 122,
        cpuPct: 0.6,
        memoryUsedMb: 180,
        memoryLimitMb: 512,
      }),
      guest({ id: 'c' }),
      guest({ id: 'd', name: 'runner', state: 'paused', kind: 'container', vmid: 131 }),
    ]);
    expect(rows.map((r) => [r.name, r.stateText, r.meta, r.kind.glyph, r.kind.id])).toEqual([
      ['arnica-prod-nest-01', 'Running', 'CPU 6% · 3.5 of 4 GB', 'vm', '118'],
      ['pihole', 'Running', 'CPU 1% · 0.2 of 0.5 GB', 'lxc', '122'],
      ['runner', 'Paused', '', 'lxc', '131'],
      ['win11', 'Stopped', '', 'vm', '130'],
    ]);
    // The kind's words are what TalkBack reads; a stopped guest's row says no more than it has.
    expect(rows[0]?.label).toBe('arnica-prod-nest-01, Proxmox VM 118, Running, CPU 6% · 3.5 of 4 GB');
    expect(rows[3]?.label).toBe('win11, Proxmox VM 130, Stopped');
  });

  it('shows no tags in the list (Whombat connections-page.md CN-08, AP-2562)', () => {
    const [row] = guestRows([guest({ tags: ['webfarm', 'nightly'] })]);
    expect(row?.meta).not.toMatch(/webfarm|nightly/);
    expect(row?.label).not.toMatch(/webfarm|nightly/);
  });

  it('marks this Whombat, an Incus project and a container update in the rows (incus-unraid-mobile.md AP-1639)', () => {
    const rows = guestRows([
      guest({
        id: 'incus:whombat-dev-box',
        name: 'whombat-dev-box',
        platform: 'incus',
        project: 'default',
        self: true,
        vmid: undefined,
      }),
      guest({
        id: 'incus:ci-platform/runner',
        name: 'runner',
        platform: 'incus',
        project: 'ci-platform',
        state: 'stopped',
        vmid: undefined,
      }),
      guest({
        id: 'docker:plex',
        name: 'plex',
        platform: 'docker',
        kind: 'container',
        updateAvailable: true,
      }),
    ]);
    expect(rows.map((r) => [r.name, r.self, r.meta, r.kind.glyph])).toEqual([
      ['plex', false, 'CPU 6% · 3.5 of 4 GB · update ready', 'docker'],
      ['whombat-dev-box', true, 'CPU 6% · 3.5 of 4 GB', 'vm'],
      ['runner', false, 'ci-platform', 'vm'],
    ]);
    expect(rows[1]?.label).toBe('whombat-dev-box, Incus VM, This Whombat, Running, CPU 6% · 3.5 of 4 GB');
  });

  it('shows power where the server lets it through', () => {
    expect(canPower({ power: true })).toEqual({ ok: true });
    expect(canPower({ power: false, powerReason: 'Turned off on the agent.' })).toEqual({
      ok: false,
      reason: 'Turned off on the agent.',
    });
    expect(canPower({ power: false })).toEqual({
      ok: false,
      reason: 'Power control is off for this server.',
    });
    expect(canPower({ power: true }, false)).toEqual({ ok: false, reason: 'Offline' });
  });
});

describe('the device skill card (AP-1368…AP-1371)', () => {
  const card = heatPumpCard();

  it('says what the agent reads and may change, as mock 3', () => {
    const view = deviceSkillView(card);
    expect(view.title).toBe('Daikin Altherma heat pump');
    expect(view.sub).toBe('New skill · reads only, until you allow more');
    expect(view.badge).toBe('Tested on your unit');
    expect(view.readings.slice(0, 2)).toEqual([
      { key: 'room', label: 'Room', value: '21.0 °C' },
      { key: 'flow', label: 'Water to radiators', value: '34 °C' },
    ]);
    expect(view.more).toBe('+ 3 more');
    expect(view.actions.map((a) => a.sub)).toEqual([
      'Only between 16 and 24 °C',
      'On or off',
      'The installer’s setting, change with care',
    ]);
    expect(view.open).toBe(true);
    const on = deviceSkillView({ ...card, status: 'on' });
    expect([on.sub, on.badge, on.open]).toEqual(['Switched on', null, false]);
    expect(deviceSkillView({ ...card, status: 'declined' }).sub).toBe('Not switched on');
  });

  it('starts from the agent’s proposal (or the owner’s choices) and sends the tiers with the proposed limits', () => {
    const tiers = initialTiers(card);
    expect(tiers).toEqual({ room_setpoint: 'can', dhw_boost: 'ask', heating_curve: 'off' });
    expect(initialTiers({ ...card, decided: { dhw_boost: { tier: 'off' } } }).dhw_boost).toBe('off');
    expect(decideBody(card, { ...tiers, dhw_boost: 'can' }, true)).toEqual({
      actions: {
        room_setpoint: { tier: 'can', limits: { min: 16, max: 24, step: 0.5 } },
        dhw_boost: { tier: 'can' },
        heating_curve: { tier: 'off' },
      },
      switchOn: true,
    });
    const neo = agentWords('Neo');
    expect(DEVICE_CARD_COPY.tiersLabel('Room temperature', neo)).toBe(
      'What Neo may do with Room temperature',
    );
  });
});
