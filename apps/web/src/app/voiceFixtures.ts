/**
 * Voice typing in fixture mode (docs/decisions/dictation.md DT-12): the fake speech service of `@whombat/client/voice/fake`
 * on the fixture session, so the composers' mic records and turns a recording into its fixed sentence, and This
 * Whombat shows VOICE TYPING with downloads that take a few seconds. `VITE_FIXTURE_VOICE` (option `voice`) picks the
 * world (or `localStorage['whombat:fixture-voice']` for the visual suite): `ready`, `gpu`, `downloading`, `failed` or
 * `off`. Without one the box answers `voice.get` as one without voice
 * typing, so the screens stay as the mocks draw them. In development the service is `window.__WHOMBAT_VOICE__`
 * (`refuseNext('busy')`, …).
 */
import {
  createFakeVoice,
  FAKE_VOICE_WORLDS,
  type FakeVoice,
  type FakeVoiceWorld,
  fakeVoiceSeed,
} from '@whombat/client/voice/fake';

/** Where the visual suite picks a world before the page loads (fixture mode only). */
export const VOICE_FIXTURE_KEY = 'whombat:fixture-voice';

const known = (v: unknown): v is FakeVoiceWorld => (FAKE_VOICE_WORLDS as readonly unknown[]).includes(v);

/** The world from `voice`, else `VITE_FIXTURE_VOICE`, else the page's storage; null: none. */
export function voiceFixtureWorld(option?: FakeVoiceWorld | false | null): FakeVoiceWorld | null {
  if (option === false) return null;
  if (option) return option;
  const env = import.meta.env.VITE_FIXTURE_VOICE;
  if (known(env)) return env;
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(VOICE_FIXTURE_KEY);
  return known(stored) ? stored : null;
}

/** The page's own service (`VITE_FIXTURE_VOICE`): one per page, however often its services are made (StrictMode). */
let pageVoice: { world: FakeVoiceWorld; voice: FakeVoice } | null = null;

/** The fixture world's speech service; null without one. An option's world (tests, stories) is new each time. */
export function voiceFixture(option?: FakeVoiceWorld | false): FakeVoice | null {
  const world = voiceFixtureWorld(option);
  if (!world) return null;
  if (option === undefined) {
    if (pageVoice?.world !== world) pageVoice = { world, voice: newVoice(world) };
    return pageVoice.voice;
  }
  return newVoice(world);
}

function newVoice(world: FakeVoiceWorld): FakeVoice {
  const voice = createFakeVoice({ initial: fakeVoiceSeed(world) });
  if (import.meta.env.DEV && typeof window !== 'undefined')
    (window as unknown as { __WHOMBAT_VOICE__?: FakeVoice }).__WHOMBAT_VOICE__ = voice;
  return voice;
}
