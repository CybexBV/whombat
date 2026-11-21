import { describe, expect, it } from 'vitest';
import { actionCopy, approvalCopy } from '../approvals/copy.js';
import { ERROR_STATUS, ErrorCode } from '../contracts/errors.js';
import { api } from '../contracts/index.js';
import { describeAction } from '../keys/actions.js';
import { ConnectionCallAction } from './approval.js';
import { conversationLink } from './conversation.js';
import { DeviceAction, DeviceReading } from './devices.js';
import { HostServerDetail } from './hosts.js';
import { ConversationLink, LinkRef, linkPath } from './links.js';

const HOST_INFO = {
  id: 'basalt',
  group: 'Lab',
  status: 'ok',
  roles: [],
  os: null,
  cpu: null,
  memory: null,
  uptimeS: null,
  lastBoot: null,
  address: null,
  location: null,
  agent: { version: '0.1.0', lastSyncSAgo: 4 },
  platform: 'standard',
  remoteControl: { console: true, power: false },
};

describe('contracts 0.80.1', () => {
  it('links a task chat to the chat itself, not the default DM (CT-348)', () => {
    const chat = { kind: 'dm' as const, slug: 'dm-1', prNumber: null, id: 'cnv_chat1' };
    expect(conversationLink({ ...chat, chat: { title: 'Heat pump' } })).toEqual({
      type: 'chat',
      id: 'cnv_chat1',
    });
    expect(conversationLink({ ...chat, chat: null })).toEqual({ type: 'dm' });
    expect(linkPath('home', { type: 'chat', id: 'cnv_chat1' })).toBe('/home/chats/cnv_chat1');
    const message = LinkRef.parse({
      type: 'message',
      in: { type: 'chat', id: 'cnv_chat1' },
      messageId: 'msg_1',
    });
    expect(linkPath('home', message)).toBe('/home/chats/cnv_chat1#msg_1');
    expect(ConversationLink.safeParse({ type: 'chat' }).success).toBe(false);
  });

  it('says a Servers call in the server’s words on the approval (CT-347)', () => {
    const action = ConnectionCallAction.parse({
      type: 'connection_call',
      params: {
        connectionId: 'con_servers',
        handle: 'servers',
        tool: 'guest_power',
        toolHash: 'a'.repeat(64),
        words: 'restart web on pve-02',
      },
    });
    const copy = actionCopy(action);
    expect(copy.title).toBe('Restart web on pve-02');
    expect(copy.question).toBe('Restart web on pve-02?');
    expect(copy.runs).toBe('Restart web on pve-02 once, then say how it went where it was asked');
    expect(describeAction(action)).toBe('restart web on pve-02');
    expect(
      approvalCopy({ action, title: copy.title, question: copy.question, target: copy.target }).matchesStored,
    ).toBe(true);
    const { words: _, ...generic } = action.params;
    expect(actionCopy({ ...action, params: generic }).title).toBe('Use guest_power on servers');
  });

  it('gives a device action a unit and a reading words for its codes (CT-345)', () => {
    const reading = DeviceReading.parse({
      key: 'mode',
      label: 'Mode',
      modbus: { table: 'holding', address: 40, type: 'u16' },
      choices: [
        { value: 1, label: 'Heating' },
        { value: 2, label: 'Cooling' },
      ],
    });
    expect(reading.choices?.[0]?.label).toBe('Heating');
    const action = DeviceAction.parse({
      key: 'flow_setpoint',
      label: 'Flow temperature',
      description: 'Sets the flow temperature the heat pump aims for.',
      modbus: { table: 'holding', address: 12, type: 'u16', scale: 0.1 },
      valueType: 'number',
      unit: '°C',
      min: 16,
      max: 24,
    });
    expect(action.unit).toBe('°C');
  });

  it('has a REST code for a service that is down (CT-346)', () => {
    expect(ErrorCode.parse('unavailable')).toBe('unavailable');
    expect(ERROR_STATUS.unavailable).toBe(503);
  });

  it('acknowledges Watch items and brings archived chats back (CT-349)', () => {
    expect(api.watch.acknowledge.id).toBe('watch.acknowledge');
    expect(api.watch.acknowledge.path).toBe('/burrows/:burrow/watch/acknowledge');
    expect(api.watch.acknowledge.body?.parse({ ref: { kind: 'alert', id: 'a1' } })).toEqual({
      ref: { kind: 'alert', id: 'a1' },
      acknowledged: true,
    });
    expect(api.chats.unarchive.id).toBe('chats.unarchive');
    expect(api.chats.unarchive.method).toBe('POST');
  });

  it('ignores a Needs you item for good, and takes that back (CT-352, 0.80.3)', () => {
    expect(api.needsYou.ignore.id).toBe('needsYou.ignore');
    expect(api.needsYou.ignore.method).toBe('POST');
    expect(api.needsYou.ignore.path).toBe('/burrows/:burrow/needs-you/ignore');
    expect(api.needsYou.ignore.body?.parse({ ref: { kind: 'approval', id: '12' } })).toEqual({
      ref: { kind: 'approval', id: '12' },
      ignored: true,
    });
    expect(
      api.needsYou.ignore.response.parse({ ref: { kind: 'approval', id: '12' }, ignored: false }).ignored,
    ).toBe(false);
  });

  it('reads a host page with only the platforms it has (CT-351, 0.80.2)', () => {
    const docker = { running: 3, total: 4, cpuPct: 2, memoryGb: 1.5, guests: [] };
    const detail = HostServerDetail.parse({
      asOf: '2026-10-17T09:00:00.000Z',
      server: HOST_INFO,
      live: null,
      banner: null,
      sensors: [],
      disks: [],
      virtualization: null,
      hints: [],
      workloads: { docker },
    });
    expect(detail.workloads?.docker?.running).toBe(3);
    expect(detail.workloads?.incus).toBeUndefined();
  });
});
