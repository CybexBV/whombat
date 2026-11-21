/**
 * Voice typing in the demo world (docs/decisions/dictation.md DT-12): the web's fake speech service
 * (`createFakeVoice`, `@whombat/client/voice/fake`) on the demo box, so the composers' mic records on the phone and the
 * box “hears” its fixed sentence, and This Whombat shows VOICE TYPING with downloads that take a few seconds. It starts
 * with Fast downloaded; Settings → This Whombat takes `?voice=<world>` (`whombat://settings/whombat?voice=downloading`)
 * to start over as another world (`FAKE_VOICE_WORLDS`). Pure TypeScript.
 */
import {
  createFakeVoice,
  FAKE_VOICE_WORLDS,
  type FakeVoice,
  type FakeVoiceWorld,
  fakeVoiceSeed,
} from '@whombat/client/voice/fake';

export interface DemoVoice {
  /** The service the demo box answers with now. */
  current(): FakeVoice;
  /** Starts over as `world`. */
  reset(world: FakeVoiceWorld): void;
  /** After every change (the runtime's `voice.changed`). */
  onChange(listener: () => void): () => void;
}

export function isVoiceDemoWorld(value: unknown): value is FakeVoiceWorld {
  return (FAKE_VOICE_WORLDS as readonly unknown[]).includes(value);
}

export function createDemoVoice(world: FakeVoiceWorld = 'ready'): DemoVoice {
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  let voice!: FakeVoice;
  let off = () => {};
  const reset = (next: FakeVoiceWorld) => {
    off();
    voice?.dispose();
    voice = createFakeVoice({ initial: fakeVoiceSeed(next) });
    off = voice.onChange(emit);
    emit();
  };
  reset(world);
  return {
    current: () => voice,
    reset,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let demo: DemoVoice | null = null;

/** The demo world's one speech service, made on first use; it keeps its state while the app runs. */
export function demoVoice(): DemoVoice {
  demo ??= createDemoVoice();
  return demo;
}

/** The demo service as a fake box's speech service (the one answering now, after a reset too). */
export function demoVoiceService(): FakeVoice {
  const d = demoVoice();
  return {
    call: (op, input) => d.current().call(op, input),
    dictate: (bytes) => d.current().dictate(bytes),
    state: () => d.current().state(),
    onChange: (listener) => d.onChange(listener),
    refuseNext: (code) => d.current().refuseNext(code),
    heard: () => d.current().heard(),
    dispose: () => d.current().dispose(),
  };
}
