import { describe, expect, it, vi } from 'vitest';
import { createLinkBus, sendLink } from './context';

describe('a link that names a Whombat', () => {
  it('waits for that Whombat’s navigator when another one shows now', () => {
    const bus = createLinkBus();
    const showing = vi.fn();
    bus.subscribe(showing);
    sendLink(bus, '/chats/cnv_1', 'wb-a', 'wb-b');
    expect(showing).not.toHaveBeenCalled();
    expect(bus.take()).toBe('/chats/cnv_1');
  });

  it('goes straight to the navigator of the Whombat it names', () => {
    const bus = createLinkBus();
    const showing = vi.fn();
    bus.subscribe(showing);
    sendLink(bus, '/chats/cnv_1', 'wb-a', 'wb-a');
    expect(showing).toHaveBeenCalledWith('/chats/cnv_1');
    expect(bus.take()).toBeNull();
  });
});
