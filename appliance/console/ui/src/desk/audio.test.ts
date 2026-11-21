import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../lib/client';
import { playAnswer } from './audio';

/** An <audio> element that records what the page does with it; `play()` waits for the test. */
class FakeAudio {
  static made: FakeAudio[] = [];
  played = 0;
  paused = 0;
  letPlay: () => void = () => {};
  constructor(readonly src: string) {
    FakeAudio.made.push(this);
  }
  addEventListener() {}
  removeAttribute() {}
  load() {}
  pause() {
    this.paused++;
  }
  play() {
    this.played++;
    return new Promise<void>((resolve) => {
      this.letPlay = resolve;
    });
  }
}

/** A client whose audio arrives when the test says so. */
function slowClient() {
  let arrive: (b: Blob | null) => void = () => {};
  const client: Client = {
    state: () => Promise.reject(new Error('unused')),
    post: () => Promise.reject(new Error('unused')),
    get: () => Promise.reject(new Error('unused')),
    blob: () =>
      new Promise((resolve) => {
        arrive = resolve;
      }),
  };
  return { client, arrive: (b: Blob | null) => arrive(b) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('playAnswer (CG-52)', () => {
  beforeEach(() => {
    FakeAudio.made = [];
    vi.stubGlobal('Audio', FakeAudio);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:answer');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('plays the answer once it has it', async () => {
    const { client, arrive } = slowClient();
    playAnswer(client, 'talk-0001');
    arrive(new Blob(['wav']));
    await settle();
    expect(FakeAudio.made).toHaveLength(1);
    expect(FakeAudio.made[0]?.played).toBe(1);
  });

  it('never plays when stopped while the audio is still coming (locked, Talk closed)', async () => {
    const { client, arrive } = slowClient();
    const pb = playAnswer(client, 'talk-0001');
    pb.stop();
    arrive(new Blob(['wav']));
    await settle();
    expect(FakeAudio.made).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('stops an answer that is starting to play, and lets go of its URL', async () => {
    const { client, arrive } = slowClient();
    const pb = playAnswer(client, 'talk-0001');
    arrive(new Blob(['wav']));
    await settle();
    pb.stop();
    expect(FakeAudio.made[0]?.paused).toBe(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:answer');
  });

  it('plays nothing when Whombat has no audio, or the fetch fails', async () => {
    const { client, arrive } = slowClient();
    playAnswer(client, 'talk-0001');
    arrive(null);
    const failing: Client = { ...client, blob: () => Promise.reject(new Error('HTTP 502')) };
    playAnswer(failing, 'talk-0002');
    await settle();
    expect(FakeAudio.made).toHaveLength(0);
  });

  it('says once when it is over, however it ends (CG-172)', async () => {
    const ends: string[] = [];
    const { client, arrive } = slowClient();
    const stopped = playAnswer(client, 'talk-0001', () => ends.push('stopped early'));
    stopped.stop();
    arrive(new Blob(['wav']));
    await settle();
    const none = slowClient();
    playAnswer(none.client, 'talk-0002', () => ends.push('no audio'));
    none.arrive(null);
    const playing = slowClient();
    const pb = playAnswer(playing.client, 'talk-0003', () => ends.push('stopped playing'));
    playing.arrive(new Blob(['wav']));
    await settle();
    expect(ends).toEqual(['stopped early', 'no audio']);
    pb.stop();
    pb.stop();
    expect(ends).toEqual(['stopped early', 'no audio', 'stopped playing']);
  });
});
