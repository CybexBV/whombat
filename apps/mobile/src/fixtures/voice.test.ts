/**
 * Voice typing in the demo world (docs/decisions/dictation.md DT-12): the demo box answers `voice.*` and turns a
 * recording into the fake's sentence through the same session and upload as a Whombat; `?voice=<world>` starts it
 * over as another world.
 */
import { encodeWav, voiceApi, voiceMicOf } from '@whombat/client/voice';
import { FAKE_TRANSCRIPT } from '@whombat/client/voice/fake';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';
import { createDemoVoice, demoVoice, isVoiceDemoWorld } from './voice';

function demoBox() {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(new Date(), Date.now()),
  });
  const client = demoClient(server.fetch);
  return { client, api: voiceApi(client.session) };
}

describe('voice typing in the demo world', () => {
  it('answers the settings and turns a recording into text', async () => {
    const { client, api } = demoBox();
    try {
      demoVoice().reset('ready');
      const voice = await api.get();
      expect(voiceMicOf(voice)).toBe('ready');
      const said = await api.transcribe({
        burrow: 'burrow-hq',
        wav: encodeWav(new Int16Array(16_000).fill(800)),
      });
      expect(said).toMatchObject({ text: FAKE_TRANSCRIPT, model: 'parakeet' });
      expect((await api.update({ language: 'nl' })).language).toBe('nl');
    } finally {
      client.session.close();
    }
  });

  it('starts over as another world', async () => {
    const demo = createDemoVoice('ready');
    let changes = 0;
    demo.onChange(() => {
      changes += 1;
    });
    demo.reset('downloading');
    expect(voiceMicOf(demo.current().state())).toBe('not_ready');
    demo.reset('off');
    expect(voiceMicOf(demo.current().state())).toBe('hidden');
    expect(changes).toBeGreaterThanOrEqual(2);
    demo.current().dispose();
    expect(isVoiceDemoWorld('gpu')).toBe(true);
    expect(isVoiceDemoWorld('nope')).toBe(false);
  });
});
