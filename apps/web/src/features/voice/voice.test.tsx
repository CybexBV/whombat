/**
 * Voice typing on the web (docs/decisions/dictation.md DT-01, DT-06, DT-12), against the fixture world's fake speech
 * service: the mic in Chat's composer and a thread's reply box, the recording bar, the words in the draft after Done
 * (never sent), Cancel, a model still downloading; none without voice typing; and This Whombat's VOICE TYPING.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeSession, restHandler } from '@whombat/client/fake';
import { encodeWav, VOICE_TEXT, type VoiceRecorder } from '@whombat/client/voice';
import {
  createFakeVoice,
  FAKE_TRANSCRIPT,
  type FakeVoiceWorld,
  withFakeVoice,
} from '@whombat/client/voice/fake';
import { DUTCH_VOICE_LICENCE_URL, type VoiceTyping } from '@whombat/core/domain';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PVE_THREAD } from '../../app/chatChannelFixtures';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { createAppServices } from '../../app/services';
import { fixtureServices, renderApp, testQueryClient } from '../../test/renderApp';

/** The page's microphone: two seconds of sound whatever happens. */
const recorder = vi.hoisted(() => ({
  starts: 0,
  cancels: 0,
}));
vi.mock('./webRecorder', () => ({
  webRecorderSupported: () => true,
  createWebRecorder: (): VoiceRecorder => ({
    start: async ({ onLevel }) => {
      recorder.starts += 1;
      onLevel?.(0.6);
    },
    stop: async () => encodeWav(new Int16Array(32_000).fill(1500)),
    cancel: async () => {
      recorder.cancels += 1;
    },
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const chat = (voice: FakeVoiceWorld | false = 'ready') => fixtureServices({ voice });
const room = () => screen.findByRole('region', { name: 'Chat' });
const ASK = { name: 'Ask Neo anything' };

describe('the mic in the composers (DT-01)', () => {
  it('records, shows the bar, and puts the words in Chat’s draft after Done without sending them', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', chat());
    const r = await room();
    const field = within(r).getByRole('textbox', ASK) as HTMLTextAreaElement;
    await user.type(field, 'Hello');
    await user.click(await within(r).findByRole('button', { name: VOICE_TEXT.composer.dictate }));
    const bar = await waitFor(() => {
      const found = r.querySelector('[data-voice-bar="recording"]');
      if (!found) throw new Error('no bar yet');
      return found as HTMLElement;
    });
    expect(within(bar).getByText(/^Recording 0:0\d$/)).toBeTruthy();
    expect(within(r).queryByRole('button', { name: 'Send' })).toBeNull();
    await user.click(within(bar).getByRole('button', { name: VOICE_TEXT.composer.done }));
    await waitFor(() => expect(r.querySelector('[data-voice-bar="transcribing"]')).not.toBeNull());
    await waitFor(() => expect(field.value).toBe(`Hello ${FAKE_TRANSCRIPT}`), { timeout: 4000 });
    // In the draft, not sent: no new thread opened.
    expect(within(r).getByRole('button', { name: 'Send' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('cancels: the microphone stops and the draft stays as it was', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', chat());
    const r = await room();
    await user.click(await within(r).findByRole('button', { name: VOICE_TEXT.composer.dictate }));
    const cancel = await within(r).findByRole('button', { name: VOICE_TEXT.composer.cancel });
    const before = recorder.cancels;
    await user.click(cancel);
    await waitFor(() => expect(recorder.cancels).toBeGreaterThan(before));
    expect((within(r).getByRole('textbox', ASK) as HTMLTextAreaElement).value).toBe('');
    expect(within(r).getByRole('button', { name: VOICE_TEXT.composer.dictate })).toBeTruthy();
  });

  it('has a mic in a thread’s reply box too', async () => {
    renderApp(`/chat?thread=${PVE_THREAD}`, chat());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(await within(pane).findByRole('button', { name: VOICE_TEXT.composer.dictate })).toBeTruthy();
  });

  it('says the model is still coming instead of recording', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', chat('downloading'));
    const r = await room();
    const starts = recorder.starts;
    await user.click(await within(r).findByRole('button', { name: VOICE_TEXT.composer.dictate }));
    expect(await within(r).findByText(VOICE_TEXT.errors.not_ready)).toBeTruthy();
    expect(recorder.starts).toBe(starts);
  });

  it('shows no mic where the Whombat has no voice typing, or it is off', async () => {
    renderApp('/chat?new=1', chat(false));
    const r = await room();
    await within(r).findByRole('textbox', ASK);
    expect(within(r).queryByRole('button', { name: VOICE_TEXT.composer.dictate })).toBeNull();
  });
});

describe('Settings → This Whombat → VOICE TYPING (DT-06)', () => {
  const section = async () => {
    const heading = await screen.findByRole(
      'heading',
      { level: 2, name: VOICE_TEXT.sectionLabel },
      { timeout: 5000 },
    );
    return heading.closest('section') as HTMLElement;
  };

  it('changes the switch, the model and the language, and downloads Most accurate', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance', fixtureServices({ voice: 'ready', host: true }));
    const s = await section();
    // Before AT A GLANCE, after How it’s doing.
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels.indexOf(VOICE_TEXT.sectionLabel)).toBe(labels.indexOf('AT A GLANCE') - 1);
    expect(within(s).getByText(VOICE_TEXT.model.uses.parakeet)).toBeTruthy();
    expect(within(s).getByText(VOICE_TEXT.gpu.none)).toBeTruthy();

    const fast = s.querySelector('[data-model="parakeet"]') as HTMLElement;
    expect(fast.textContent).toContain('669 MB');
    expect(within(fast).queryByRole('button')).toBeNull();

    await user.click(within(s).getByRole('radio', { name: 'Nederlands' }));
    await waitFor(() =>
      expect((within(s).getByRole('radio', { name: 'Nederlands' }) as HTMLInputElement).checked).toBe(true),
    );

    const accurate = s.querySelector('[data-model="whisper"]') as HTMLElement;
    await user.click(within(accurate).getByRole('button', { name: VOICE_TEXT.actions.download }));
    await waitFor(() => expect(accurate.getAttribute('data-state')).toBe('downloading'));
    expect(within(accurate).getByRole('progressbar')).toBeTruthy();

    await user.click(within(s).getByRole('radio', { name: VOICE_TEXT.model.choices.whisper }));
    expect(await within(s).findByText(VOICE_TEXT.model.slow, { exact: false })).toBeTruthy();

    await user.click(within(s).getByRole('switch', { name: VOICE_TEXT.on.label }));
    await waitFor(() =>
      expect(within(s).getByRole('switch', { name: VOICE_TEXT.on.label }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
  });

  it('offers Try again for a download that failed, with why', async () => {
    renderApp('/settings?tab=appliance', fixtureServices({ voice: 'failed' }));
    const s = await section();
    const accurate = s.querySelector('[data-model="whisper"]') as HTMLElement;
    expect(within(accurate).getByText(VOICE_TEXT.problems.no_room, { exact: false })).toBeTruthy();
    expect(within(accurate).getByRole('button', { name: VOICE_TEXT.actions.retry })).toBeTruthy();
  });

  it('is not there where the Whombat has no speech service', async () => {
    renderApp('/settings?tab=appliance', fixtureServices({ host: true }));
    await screen.findByRole('heading', { level: 2, name: 'AT A GLANCE' }, { timeout: 5000 });
    expect(screen.queryByRole('heading', { level: 2, name: VOICE_TEXT.sectionLabel })).toBeNull();
  });

  it('asks for Open RAIL-M agreement before downloading the Dutch voice, and removes it when switched off', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance', fixtureServices({ voice: 'ready', host: true }));
    const s = await section();
    const dutchRow = s.querySelector('[data-row="voice-dutch"]') as HTMLElement;
    const dutchSwitch = within(dutchRow).getByRole('switch', { name: VOICE_TEXT.dutchVoice.label });
    expect(dutchSwitch.getAttribute('aria-checked')).toBe('false');
    expect(dutchRow.textContent).toContain('145 MB');

    // Turning on opens the licence dialog without downloading yet.
    await user.click(dutchSwitch);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(VOICE_TEXT.dutchVoice.dialog.title)).toBeTruthy();
    const link = within(dialog).getByRole('link', { name: VOICE_TEXT.dutchVoice.dialog.licenceLink });
    expect(link.getAttribute('href')).toBe(DUTCH_VOICE_LICENCE_URL);
    expect(link.getAttribute('target')).toBe('_blank');

    // Cancelling leaves it off and starts no download.
    await user.click(within(dialog).getByRole('button', { name: VOICE_TEXT.dutchVoice.dialog.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dutchSwitch.getAttribute('aria-checked')).toBe('false');
    expect(dutchRow.getAttribute('data-state')).toBe('absent');

    // Agreeing turns it on and begins downloading.
    await user.click(dutchSwitch);
    const dialog2 = await screen.findByRole('dialog');
    await user.click(within(dialog2).getByRole('button', { name: VOICE_TEXT.dutchVoice.dialog.agree }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(dutchSwitch.getAttribute('aria-checked')).toBe('true'));
    expect(dutchRow.getAttribute('data-state')).toBe('downloading');
    expect(within(dutchRow).getByRole('progressbar')).toBeTruthy();

    // Turning it off removes the model.
    await user.click(dutchSwitch);
    await waitFor(() => expect(dutchSwitch.getAttribute('aria-checked')).toBe('false'));
    expect(dutchRow.getAttribute('data-state')).toBe('absent');
  });

  it('hides Dutch voice when an older box omits it, and keeps the licence dialog open if the box did not turn it on', async () => {
    const rest = createWebFixtureFetch({ host: true }) as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    const baseVoice = createFakeVoice();
    const withVoice = withFakeVoice(
      { handle: restHandler(rest, { origin: 'http://whombat.test' }) },
      baseVoice,
    );
    const { session: olderSession } = createFakeSession({
      ...withVoice,
      account: { id: 'acc_mara', name: 'Mara Okafor' },
      protocolMinor: 2,
      handle: async (op, input, ctx) => {
        const res = await withVoice.handle(op, input, ctx);
        if (op === 'voice.get' && res.status === 200) {
          const { dutchVoice: _omitted, ...older } = res.body as VoiceTyping;
          return { status: 200, body: older };
        }
        return res;
      },
    });
    const older = renderApp(
      '/settings?tab=appliance',
      createAppServices({ session: olderSession, realtime: null, queryClient: testQueryClient() }),
    );
    const olderSection = await section();
    expect(olderSection.querySelector('[data-row="voice-dutch"]')).toBeNull();
    older.unmount();

    // Box answers 200 OK to voice.setDutchVoice({ on: true }) without turning Dutch voice on.
    const { session: ignoredSession } = createFakeSession({
      ...withVoice,
      account: { id: 'acc_mara', name: 'Mara Okafor' },
      handle: async (op, input, ctx) => {
        if (op === 'voice.setDutchVoice') return { status: 200, body: baseVoice.state() };
        return withVoice.handle(op, input, ctx);
      },
    });
    const user = userEvent.setup();
    renderApp(
      '/settings?tab=appliance',
      createAppServices({ session: ignoredSession, realtime: null, queryClient: testQueryClient() }),
    );
    const s = await section();
    const dutchSwitch = within(s.querySelector('[data-row="voice-dutch"]') as HTMLElement).getByRole(
      'switch',
      { name: VOICE_TEXT.dutchVoice.label },
    );
    await user.click(dutchSwitch);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: VOICE_TEXT.dutchVoice.dialog.agree }));
    expect(await within(dialog).findByRole('status')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows “Still removing the Dutch voice.” while leftover files remain after turning it off', async () => {
    const rest = createWebFixtureFetch({ host: true }) as unknown as (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    const removingVoice = createFakeVoice({
      initial: {
        models: {
          supertonic: { state: 'removing', received: 65_536 },
        },
      },
    });
    const { session } = createFakeSession({
      ...withFakeVoice({ handle: restHandler(rest, { origin: 'http://whombat.test' }) }, removingVoice),
      account: { id: 'acc_mara', name: 'Mara Okafor' },
    });
    renderApp(
      '/settings?tab=appliance',
      createAppServices({ session, realtime: null, queryClient: testQueryClient() }),
    );
    const s = await section();
    const dutchRow = s.querySelector('[data-row="voice-dutch"]') as HTMLElement;
    expect(dutchRow.getAttribute('data-state')).toBe('removing');
    expect(
      within(dutchRow)
        .getByRole('switch', { name: VOICE_TEXT.dutchVoice.label })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(within(dutchRow).getByText(VOICE_TEXT.dutchVoice.removing)).toBeTruthy();
  });
});
