import { describe, expect, it } from 'vitest';
import { Conversation, chatSubjectLine, chatTitleFrom } from './conversation.js';
import { DeviceProfile, DeviceSkillCard } from './devices.js';
import { HomeOverview, jsonPointerGet, parseThingId, thingHref, thingId, WidgetSource } from './home.js';
import { HostServer } from './hosts.js';
import { limitText } from './tool-limits.js';

const T = '2026-10-17T09:00:00.000Z';

describe('task chats (CT-337)', () => {
  it('titles a chat by its first line, at most 60 characters', () => {
    expect(chatTitleFrom('## Keep an eye on the heat pump\nIt makes noise at night')).toBe(
      'Keep an eye on the heat pump',
    );
    expect(chatTitleFrom('   \n\n')).toBe('New chat');
    expect(chatTitleFrom('- **Fix** _my_app.py_ on pve-02')).toBe('Fix my_app.py on pve-02');
    expect(chatTitleFrom('-5 °C tonight, `turn` the heat up?')).toBe('-5 °C tonight, turn the heat up?');
    expect(chatTitleFrom('> ## Quote')).toBe('Quote');
    const long = chatTitleFrom(
      'Why does pve-02 keep running out of memory every night around three in the morning since the update',
    );
    expect([...long].length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
    expect(chatSubjectLine({ kind: 'server', id: 'pve-02', name: 'pve-02' })).toBe(
      'This chat is about the server pve-02.',
    );
  });

  it('keeps conversations without `chat` valid', () => {
    const c = {
      id: 'cnv_dm1',
      burrowId: 'bur_hq',
      kind: 'dm',
      slug: 'dm-1',
      title: 'Whombat',
      topic: '',
      memberIds: [],
      actions: [],
      prNumber: null,
      repoId: null,
      dmPersonId: 'prn_mara',
      createdAt: T,
      lastMessageAt: null,
    };
    expect(Conversation.safeParse(c).success).toBe(true);
    expect(Conversation.safeParse({ ...c, chat: { title: 'pve-02 updates', subject: null } }).success).toBe(
      true,
    );
  });
});

describe('Home (CT-336)', () => {
  it('names things and reads JSON pointers', () => {
    expect(thingId('server', 'pve-02')).toBe('server:pve-02');
    expect(parseThingId('device:con_abc')).toEqual({ kind: 'device', id: 'con_abc' });
    expect(parseThingId('planet:x')).toBeNull();
    expect(thingHref('server', 'pve-02')).toBe('/things/server%3Apve-02');
    const doc = { data: [{ temp: 21.5 }], 'a/b': { '~': 1 } };
    expect(jsonPointerGet(doc, '/data/0/temp')).toBe(21.5);
    expect(jsonPointerGet(doc, '/a~1b/~0')).toBe(1);
    expect(jsonPointerGet(doc, '/data/1/temp')).toBeUndefined();
    expect(jsonPointerGet(doc, '')).toBe(doc);
  });

  it('parses an empty Home and both widget sources', () => {
    expect(
      HomeOverview.safeParse({
        summary: { needsYou: 0, working: 0, problems: 0 },
        needsYou: [],
        chats: [],
        things: [],
        automationsToday: [],
        widgets: [],
        doneRecently: [],
        generatedAt: '2026-10-24T09:00:00.000Z',
      }).success,
    ).toBe(true);
    // Chat's Done today (status-line.md): optional, a fix marked, Undo by its change.
    const home = {
      summary: { needsYou: 0, working: 0, problems: 0 },
      needsYou: [],
      chats: [],
      things: [],
      automationsToday: [],
      widgets: [],
      doneRecently: [],
      generatedAt: '2026-10-24T09:00:00.000Z',
    };
    const item = {
      id: 'dnt_1',
      text: 'Restarted Zigbee',
      at: '2026-10-24T03:10:00.000Z',
      href: '/chat?thread=msg_1',
    };
    expect(
      HomeOverview.safeParse({ ...home, doneToday: [{ ...item, fixed: true, undo: { changeId: 'chg_1' } }] })
        .success,
    ).toBe(true);
    expect(HomeOverview.safeParse({ ...home, doneToday: [{ ...item, fixed: false }] }).success).toBe(false);
    expect(HomeOverview.safeParse({ ...home, doneToday: [{ ...item, text: '' }] }).success).toBe(false);
    expect(
      WidgetSource.safeParse({
        kind: 'connection_tool',
        connectionId: 'con_ha',
        tool: 'GetLiveContext',
        args: {},
        values: [{ key: 'flow', label: 'Flow', unit: '°C', path: '/flow' }],
      }).success,
    ).toBe(true);
    expect(
      WidgetSource.safeParse({ kind: 'server_metric', serverId: 'pve-02', series: ['cpu_pct'] }).success,
    ).toBe(true);
  });
});

describe('tool limits (CT-341)', () => {
  it('words a limit plainly', () => {
    expect(limitText({ min: 16, max: 24 }, '°C')).toBe('only between 16 and 24 °C');
    expect(limitText({ choices: ['eco', 'comfort', 'boost'] }, undefined, { eco: 'Eco' })).toBe(
      'only Eco, comfort or boost',
    );
  });
});

describe('devices (CT-340)', () => {
  it('parses a heat pump profile and its card', () => {
    const profile = DeviceProfile.parse({
      name: 'Heat pump',
      vendor: 'Ecoforest',
      driver: 'modbus_tcp',
      readings: [
        {
          key: 'flow_temp',
          label: 'Flow temperature',
          unit: '°C',
          modbus: { table: 'input', address: 1, type: 's16', scale: 0.1 },
        },
      ],
      actions: [
        {
          key: 'set_flow_temp',
          label: 'Set the flow temperature',
          description: 'Sets the flow temperature the heat pump aims for.',
          modbus: { table: 'holding', address: 135, type: 's16', scale: 0.1 },
          valueType: 'number',
          min: 10,
          max: 60,
        },
      ],
    });
    expect(profile.defaults).toEqual({});
    expect(
      DeviceSkillCard.safeParse({
        kind: 'device_skill',
        proposalId: 'dvp_hp1',
        name: 'Heat pump',
        readings: [{ key: 'flow_temp', label: 'Flow temperature', value: '38.5', unit: '°C' }],
        moreReadings: 0,
        actions: [],
        testedAt: T,
        status: 'proposed',
      }).success,
    ).toBe(true);
  });
});

describe('hosts (CT-339)', () => {
  it('parses a server row as Home’s Servers card draws it', () => {
    expect(
      HostServer.safeParse({
        id: 'pve-02',
        name: 'pve-02',
        group: 'Lab',
        status: 'ok',
        platform: 'proxmox',
        os: 'Proxmox VE 9.0.10',
        cpu: { model: 'AMD Ryzen 9 7950X', cores: 16, threads: 32 },
        uptimeS: 86_400,
        cpuPct: 12.5,
        memory: { usedPct: 61, totalGb: 128 },
        storage: { usedPct: 40, capacityTb: 8 },
        temperature: { maxC: 58, limitC: 85 },
        guests: [{ platform: 'pve', running: 7, total: 9 }],
        agent: { version: '0.1.0', connected: true },
        lastSeen: T,
        cpu24h: [10, 12, null],
        remoteControl: { console: true, power: true },
      }).success,
    ).toBe(true);
  });
});
