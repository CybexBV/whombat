import { describe, expect, it } from 'vitest';
import type { Services } from '../../../services';
import { type DoorbellRing, emitDoorbellRing, onDoorbellRing, RING_FRESH_MS, ringOf } from './doorbell';

const NOW = new Date('2026-11-26T09:00:00.000Z');
const message = (over: Record<string, unknown> = {}, type = 'add') => ({
  type,
  item: {
    modelKey: 'event',
    id: 'evt_1',
    type: 'ring',
    device: 'cam_front',
    start: NOW.getTime() - 2000,
    ...over,
  },
});

describe('a ring in Protect’s event stream', () => {
  it('is a ring when the event is new, a ring, from a camera and fresh', () => {
    expect(ringOf(message(), NOW)).toEqual({
      camera: 'cam_front',
      eventId: 'evt_1',
      at: new Date(NOW.getTime() - 2000),
    });
  });

  it('is nothing for an update, another kind, no camera or an old event', () => {
    expect(ringOf(message({}, 'update'), NOW)).toBeNull();
    expect(ringOf(message({ type: 'smartDetectZone' }), NOW)).toBeNull();
    expect(ringOf(message({ device: undefined }), NOW)).toBeNull();
    expect(ringOf(message({ start: NOW.getTime() - RING_FRESH_MS - 1 }), NOW)).toBeNull();
    expect(ringOf('not a message', NOW)).toBeNull();
  });
});

describe('telling the server a ring', () => {
  const ring: DoorbellRing = {
    connectionId: 'con_protect',
    burrowId: 'brw_1',
    camera: 'cam_front',
    eventId: 'evt_1',
    at: NOW,
  };

  it('reaches every listener of that server until it stops listening, past one that fails', () => {
    const warned: string[] = [];
    const services = { log: { warn: (_: unknown, m: string) => warned.push(m) } } as unknown as Services;
    const heard: string[] = [];
    const offA = onDoorbellRing(services, () => {
      throw new Error('no');
    });
    const offB = onDoorbellRing(services, (r) => heard.push(r.camera));
    onDoorbellRing({ log: { warn() {} } } as unknown as Services, () => heard.push('another server'));
    emitDoorbellRing(services, ring);
    expect(heard).toEqual(['cam_front']);
    expect(warned).toHaveLength(1);
    offA();
    offB();
    emitDoorbellRing(services, ring);
    expect(heard).toEqual(['cam_front']);
  });
});
