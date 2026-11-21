/**
 * The desk display on the web (desk-display-web.md AP-3003…AP-3021, AP-3100…, AP-3300…, AP-5830…; one-person.md
 * AP-5695): Settings → This Whombat → Screen, the person's (settings-groups.md); pairing the screen and its choices
 * in Lock and PIN, Night and Talk; PINs of 4 to 6 digits and the easy ones; the voice under Talk with Listen; Lock again
 * and Use the camera to see when you’re here; What it shows with its preview, its choices and the strip's order; the
 * Whombat's name for the top bar; the unlock request as a notice and a NEEDS YOU row; the power line in “How it’s doing”.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DESK_TEXT, DESK_VOICES, DESK_WORDS } from '@whombat/client/desk';
import {
  createFakeDesk,
  type FakeDesk,
  type FakeDeskOptions,
  type FakeDeskPerson,
  fakeDeskApi,
} from '@whombat/client/desk/fake';
import { DESK_QUERY_KEY } from '@whombat/client/desk/react';
import { mara } from '@whombat/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeskFixtureKind, deskSeed } from '../../app/deskFixtures';
import { hostMetricsFixture, hostPowerFixture } from '../../app/hostFixtures';
import type { AppServices, ManagedContext } from '../../app/services';
import { fixtureServices, renderApp } from '../../test/renderApp';

const MARA: FakeDeskPerson = { personId: mara.id, name: mara.name };
/** The PIN fields' label (“Choose a PIN of 4 to 6 digits”). */
const PIN = DESK_TEXT.dialog.pin;

/** The fixture world with a box screen in `kind`'s state, Mara asking. */
function world(
  kind: DeskFixtureKind | null,
  more: Partial<FakeDeskOptions> = {},
): { services: AppServices; desk: FakeDesk } {
  const desk = createFakeDesk({ ...deskSeed(kind, Date.now()), ...more });
  const base = fixtureServices({ host: true });
  const services: AppServices = { ...base, desk: fakeDeskApi(desk, MARA) };
  desk.onChange(() => void base.queryClient.invalidateQueries({ queryKey: DESK_QUERY_KEY }));
  return { services, desk };
}

const W = DESK_WORDS.settings;

/** This Whombat → Screen (`?tab=appliance&section=screen`), once it's on the page (the first render loads the chunks). */
const SCREEN = '/settings?tab=appliance&section=screen';

/** Settings → This Whombat → Screen, once it's on the page (the first render of a file loads the app's chunks). */
async function tab(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector('[data-screen-tab]');
      if (!el) throw new Error('no Screen tab yet');
      return el as HTMLElement;
    },
    { timeout: 5000 },
  );
}

/** Opens one of the tab's parts. */
async function part(user: ReturnType<typeof userEvent.setup>, name: string) {
  const parts = await screen.findByRole('group', { name: W.openScreen });
  await user.click(within(parts).getByRole('radio', { name }));
}

/** This Whombat's parts (Overview, Backups, Screen, About). */
const whombatParts = () => screen.findByRole('group', { name: 'Parts of This Whombat' });

describe('Settings → This Whombat → Screen (AP-5830…)', () => {
  it('is a part of This Whombat, before About, on a box with a screen', async () => {
    renderApp(SCREEN, world('pinned').services);
    await tab();
    expect(screen.getByRole('heading', { level: 1, name: 'Screens' })).toBeTruthy();
    const labels = within(await whombatParts())
      .getAllByRole('radio')
      .map((r) => r.closest('label')?.textContent);
    expect(labels.indexOf(W.tab)).toBe(labels.indexOf('About') - 1);
    expect(within(await whombatParts()).getByRole('radio', { name: W.tab })).toHaveProperty('checked', true);
  });

  it('isn’t there without a screen, and its old address shows This Whombat', async () => {
    renderApp('/settings?tab=screen', fixtureServices({ host: true }));
    await screen.findByRole('heading', { level: 2, name: 'AT A GLANCE' }, { timeout: 5000 });
    expect(screen.queryByRole('radio', { name: W.tab })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'This Whombat' })).toBeTruthy();
  });

  it('isn’t there on a box with no screen connected and none paired', async () => {
    const none = { connected: false, real: false, builtIn: false, name: null };
    const { services } = world('unpaired', { display: none });
    const get = vi.spyOn(services.desk as NonNullable<AppServices['desk']>, 'get');
    renderApp('/settings?tab=appliance', services);
    await screen.findByRole('heading', { level: 2, name: 'AT A GLANCE' }, { timeout: 5000 });
    // Once the screen answered, there is nothing to show for it.
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(() => get.mock.results[0]?.value);
    expect(screen.queryByRole('radio', { name: W.tab })).toBeNull();
  });

  it('opens from This Whombat’s parts', async () => {
    const user = userEvent.setup();
    const app = renderApp('/settings?tab=appliance', world('pinned').services);
    const parts = await whombatParts();
    await user.click(await within(parts).findByRole('radio', { name: W.tab }, { timeout: 5000 }));
    await tab();
    expect(app.location()).toBe(SCREEN);
  });

  it('opens This Whombat’s old SCREEN address and the old Screen tab on the part', async () => {
    const first = renderApp('/settings?tab=appliance#screen', world('pinned').services);
    await tab();
    expect(first.location()).toBe(SCREEN);
    first.unmount();
    const app = renderApp('/settings?tab=screen&part=lock', world('pinned').services);
    await tab();
    const search = new URLSearchParams(app.history.location.search);
    expect(Object.fromEntries(search)).toEqual({ tab: 'appliance', section: 'screen', part: 'lock' });
  });

  it('pairs the screen: its letters and a PIN typed twice', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('unpaired');
    renderApp(SCREEN, services);
    const s = await tab();
    // Nothing to choose before it's paired.
    expect(screen.queryByRole('group', { name: W.openScreen })).toBeNull();
    await user.click(within(s).getByRole('button', { name: 'Pair the screen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair the screen' });
    await waitFor(() => expect(desk.letters()).not.toBeNull());
    expect(within(dialog).getByText(/They change in \d+ min\./)).toBeTruthy();

    const letters = within(dialog).getByLabelText('Type the 4 letters on the screen');
    const pin = within(dialog).getByLabelText(PIN);
    const again = within(dialog).getByLabelText('Type it again');
    await user.type(letters, 'WWWW');
    await user.type(pin, '24681a0');
    await user.type(again, '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect(await within(dialog).findByText(/4 tries left/)).toBeTruthy();

    await user.type(letters, (desk.letters() as string).toLowerCase());
    await user.clear(again);
    await user.type(again, '246811');
    await user.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('don’t match');

    await user.clear(again);
    await user.type(again, '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(desk.snapshot().paired).toMatchObject({ personId: mara.id, pin: '246810' });
    expect(await within(s).findByText(/paired with you since/)).toBeTruthy();
    expect(await screen.findByRole('group', { name: W.openScreen })).toBeTruthy();
  });

  it('gives the paired person their PIN, what a locked screen shows, quiet hours and Talk, in their parts', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('paired');
    renderApp(SCREEN, services);
    const s = await tab();
    expect(await within(s).findByText(/paired with you since/)).toBeTruthy();
    // No Unpair (the switch is how it goes off); Pair the screen only replaces someone else.
    expect(within(s).queryByRole('button', { name: 'Unpair' })).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Pair the screen' })).toBeNull();

    await part(user, W.parts.lock);
    const locked = within(s).getByRole('group', { name: 'While locked it shows' });
    expect(within(locked).getByRole('radio', { name: 'A summary' })).toHaveProperty('checked', true);
    await user.click(within(locked).getByRole('radio', { name: 'Everything' }));
    await waitFor(() => expect(desk.snapshot().settings.lockedView).toBe('everything'));
    expect(within(s).getByText(/Anyone walking past/)).toBeTruthy();

    await part(user, W.parts.night);
    const night = within(s).getByRole('group', { name: 'At night' });
    await user.click(within(night).getByRole('radio', { name: 'Black' }));
    await waitFor(() => expect(desk.snapshot().settings.night).toBe('black'));
    const from = within(s).getByLabelText('From') as HTMLInputElement;
    expect(from.value).toBe('23:00');
    await user.click(within(s).getByRole('switch', { name: 'Quiet hours' }));
    await waitFor(() => expect(desk.snapshot().settings.quietHours.enabled).toBe(false));
    expect(within(s).queryByLabelText('From')).toBeNull();

    await part(user, W.parts.talk);
    const talk = within(s).getByRole('switch', { name: /^Talk to / });
    expect(talk.getAttribute('aria-checked')).toBe('true');
    await user.click(talk);
    await waitFor(() => expect(desk.snapshot().settings.voice).toBe(false));

    await part(user, W.parts.lock);
    await user.click(within(s).getByRole('button', { name: 'Change PIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change PIN' });
    await user.type(within(dialog).getByLabelText(PIN), '135790');
    await user.type(within(dialog).getByLabelText('Type it again'), '135790');
    await user.click(within(dialog).getByRole('button', { name: 'Change PIN' }));
    await waitFor(() => expect(desk.snapshot().paired?.pin).toBe('135790'));
  });

  it('opens the part the address names', async () => {
    renderApp(`${SCREEN}&part=night`, world('pinned').services);
    const s = await tab();
    expect(await within(s).findByRole('switch', { name: 'Quiet hours' })).toBeTruthy();
    expect(within(s).getByRole('radio', { name: W.parts.night })).toHaveProperty('checked', true);
  });

  it('turns Talk off with the reason on a box without a microphone', async () => {
    renderApp(`${SCREEN}&part=talk`, world('nomic').services);
    const s = await tab();
    const talk = await within(s).findByRole('switch', { name: /^Talk to / });
    expect(talk.hasAttribute('disabled')).toBe(true);
    expect(within(s).getByText(/no microphone/)).toBeTruthy();
  });
});

describe('the switch (AP-3100…AP-3109)', () => {
  it('a virtual machine’s screen reads off; turning it on pairs it to you, and you choose a PIN', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('vm');
    renderApp(SCREEN, services);
    const s = await tab();
    const sw = await within(s).findByRole('switch', { name: 'Show Whombat on this screen' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(within(s).getByText('QEMU Monitor · connected')).toBeTruthy();
    expect(within(s).getByText(/virtual machine/)).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Pair the screen' })).toBeNull();

    await user.click(sw);
    await waitFor(() => expect(desk.snapshot()).toMatchObject({ on: true, paired: { personId: mara.id } }));
    expect(await within(s).findByText(/paired with you since/)).toBeTruthy();
    expect(within(s).queryByText(/virtual machine/)).toBeNull();
    // No Unpair: the switch is how it goes off. No PIN yet: Choose a PIN (DK-18).
    expect(within(s).queryByRole('button', { name: 'Unpair' })).toBeNull();
    await part(user, W.parts.lock);
    expect(within(s).getByText(/^No PIN yet/)).toBeTruthy();
    await user.click(within(s).getByRole('button', { name: 'Choose a PIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a PIN' });
    await user.type(within(dialog).getByLabelText(PIN), '135790');
    await user.type(within(dialog).getByLabelText('Type it again'), '135790');
    await user.click(within(dialog).getByRole('button', { name: 'Save PIN' }));
    await waitFor(() => expect(desk.snapshot().paired?.pin).toBe('135790'));
    expect(await within(s).findByRole('button', { name: 'Change PIN' })).toBeTruthy();
  });

  it('a screen that paired itself has your choices; turning it off asks first, then says what off means', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('auto');
    renderApp(SCREEN, services);
    const s = await tab();
    const sw = await within(s).findByRole('switch', { name: 'Show Whombat on this screen' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(within(s).getByText(/^Built-in screen · paired with you since/)).toBeTruthy();
    // The choices don't wait for a PIN.
    await part(user, W.parts.lock);
    expect(within(s).getByRole('button', { name: 'Choose a PIN' })).toBeTruthy();
    expect(within(s).getByRole('group', { name: 'While locked it shows' })).toBeTruthy();

    await user.click(sw);
    const ask = await screen.findByRole('dialog', { name: 'Turn the screen off?' });
    expect(within(ask).getByText(/unpairs it/)).toBeTruthy();
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(desk.snapshot().paired).not.toBeNull();

    await user.click(sw);
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Turn the screen off?' })).getByRole('button', {
        name: 'Turn off',
      }),
    );
    await waitFor(() => expect(desk.snapshot()).toMatchObject({ on: false, paired: null }));
    expect(await within(s).findByText(/goes dark after 10 minutes/)).toBeTruthy();
    expect(within(s).queryByText(/paired with/)).toBeNull();
    expect(screen.queryByRole('group', { name: W.openScreen })).toBeNull();
  });

  it('says when no screen is connected right now', async () => {
    renderApp(SCREEN, world('unplugged').services);
    const s = await tab();
    expect(await within(s).findByText(/^No screen is connected right now\./)).toBeTruthy();
    expect(
      within(s).getByRole('switch', { name: 'Show Whombat on this screen' }).getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('a PIN of 4 to 6 digits (AP-3300…)', () => {
  it('pairs with a 4-digit PIN; one too easy to guess is refused before anything is sent', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('unpaired');
    renderApp(SCREEN, services);
    const s = await tab();
    await user.click(within(s).getByRole('button', { name: 'Pair the screen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair the screen' });
    await waitFor(() => expect(desk.letters()).not.toBeNull());
    const pin = within(dialog).getByLabelText(PIN) as HTMLInputElement;
    expect(pin.maxLength).toBe(6);
    await user.type(
      within(dialog).getByLabelText('Type the 4 letters on the screen'),
      desk.letters() as string,
    );
    await user.type(pin, '1234');
    await user.type(within(dialog).getByLabelText('Type it again'), '1234');
    await user.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('too easy');
    expect(desk.snapshot().paired).toBeNull();

    await user.clear(pin);
    await user.type(pin, '2580');
    await user.clear(within(dialog).getByLabelText('Type it again'));
    await user.type(within(dialog).getByLabelText('Type it again'), '2580');
    await user.click(within(dialog).getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(desk.snapshot().paired).toMatchObject({ personId: mara.id, pin: '2580' });
    await part(user, W.parts.lock);
    expect(await within(s).findByText(DESK_TEXT.pinMeta)).toBeTruthy();
  });
});

describe('the screen’s voice (AP-3400…)', () => {
  /** The browser's audio, stubbed: each sample played, its Blob, and the element to end it. */
  function stubAudio(play: (audio: HTMLMediaElement) => Promise<void> = () => Promise.resolve()) {
    const played: { audio: HTMLMediaElement; blob: Blob }[] = [];
    const blobs = new Map<string, Blob>();
    const create = vi.fn((blob: Blob) => {
      const url = `blob:sample-${blobs.size}`;
      blobs.set(url, blob);
      return url;
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      played.push({ audio: this, blob: blobs.get(this.src) as Blob });
      return play(this);
    });
    return { played, revoke };
  }
  afterEach(() => vi.restoreAllMocks());

  it('offers the voices under Talk and saves a choice at once; none while Talk is off', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('pinned');
    renderApp(`${SCREEN}&part=talk`, services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.voice });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual([...DESK_VOICES]);
    expect(within(group).getByRole('radio', { name: 'Heart' })).toHaveProperty('checked', true);
    expect(within(group).getByText(DESK_TEXT.voiceKinds.george)).toBeTruthy();
    expect(within(group).getAllByRole('button', { name: /^Listen / })).toHaveLength(6);
    await user.click(within(group).getByRole('radio', { name: 'George' }));
    await waitFor(() => expect(desk.snapshot().settings.speechVoice).toBe('george'));
    expect(within(group).getByRole('radio', { name: 'George' })).toHaveProperty('checked', true);

    await user.click(within(s).getByRole('switch', { name: /^Talk to / }));
    await waitFor(() => expect(within(s).queryByRole('group', { name: DESK_TEXT.voice })).toBeNull());
  });

  it('Listen plays the box’s sample as audio/wav, “Playing…” until it ends, one at a time', async () => {
    const user = userEvent.setup();
    const { played, revoke } = stubAudio();
    renderApp(`${SCREEN}&part=talk`, world('pinned').services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.voice });
    await user.click(within(group).getByRole('button', { name: 'Listen Bella' }));
    await waitFor(() => expect(played).toHaveLength(1));
    expect(played[0]?.blob.type).toBe('audio/wav');
    const bella = within(group).getByRole('button', { name: /Bella$/ });
    expect(bella.textContent).toBe(DESK_TEXT.playing);
    expect(bella.getAttribute('aria-pressed')).toBe('true');
    // Another voice stops Bella's.
    await user.click(within(group).getByRole('button', { name: 'Listen Emma' }));
    await waitFor(() => expect(played).toHaveLength(2));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(bella.textContent).toBe(DESK_TEXT.listen);
    act(() => played[1]?.audio.onended?.(new Event('ended')));
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: /Emma$/ }).textContent).toBe(DESK_TEXT.listen),
    );
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('says when the voice couldn’t play', async () => {
    const user = userEvent.setup();
    stubAudio(() => Promise.reject(new DOMException('No sound', 'NotAllowedError')));
    renderApp(`${SCREEN}&part=talk`, world('pinned').services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.voice });
    await user.click(within(group).getByRole('button', { name: 'Listen Heart' }));
    expect(await screen.findByText(DESK_TEXT.sampleFailed)).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Listen Heart' }).textContent).toBe(DESK_TEXT.listen);
  });

  it('isn’t there on a Whombat from before 0.105', async () => {
    renderApp(`${SCREEN}&part=talk`, world('paired').services);
    const s = await tab();
    await within(s).findByRole('switch', { name: /^Talk to / });
    expect(within(s).queryByRole('group', { name: DESK_TEXT.voice })).toBeNull();
  });
});

describe('Lock again and the camera to see when you’re here (AP-3600…)', () => {
  it('chooses when the screen locks again in Lock and PIN, and turns the camera on in Night', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('pinned');
    renderApp(`${SCREEN}&part=lock`, services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.lockAgain });
    const rows = [...s.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'));
    expect(rows.slice(rows.indexOf('desk-pin'))).toEqual(['desk-pin', 'desk-locked', 'desk-lock-again']);
    expect(within(s).queryByRole('switch', { name: DESK_TEXT.presence })).toBeNull();
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['idle', 'away', 'never']);
    expect((within(group).getByRole('radio', { name: 'After 2 minutes' }) as HTMLInputElement).checked).toBe(
      true,
    );
    // The chosen one's hint, under the title, describes the group.
    const hint = document.getElementById(group.getAttribute('aria-describedby') as string);
    expect(hint?.textContent).toContain('2 minutes');

    await user.click(within(group).getByRole('radio', { name: 'When you press Lock' }));
    await waitFor(() =>
      expect(desk.snapshot().settings).toMatchObject({ stayUnlocked: true, presence: false }),
    );
    expect(hint?.textContent).toContain('until you press Lock');
    expect(hint?.textContent).not.toContain('{assistant}');
    await user.click(within(group).getByRole('radio', { name: 'When you leave' }));
    await waitFor(() =>
      expect(desk.snapshot().settings).toMatchObject({ stayUnlocked: false, presence: true }),
    );

    await part(user, W.parts.night);
    const camera = within(s).getByRole('switch', { name: DESK_TEXT.cameraWake });
    expect(camera.getAttribute('aria-checked')).toBe('false');
    await user.click(camera);
    await waitFor(() => expect(desk.snapshot().settings.cameraWake).toBe(true));
  });

  it('puts the choice back and says why when the Whombat refuses it', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('pinned');
    const update = vi.spyOn(services.desk as NonNullable<AppServices['desk']>, 'update');
    update.mockRejectedValueOnce(new Error('offline'));
    renderApp(`${SCREEN}&part=lock`, services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.lockAgain });
    await user.click(within(group).getByRole('radio', { name: 'When you press Lock' }));
    expect(await screen.findByText(DESK_TEXT.errors.failed)).toBeTruthy();
    expect((within(group).getByRole('radio', { name: 'After 2 minutes' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(desk.snapshot().settings.stayUnlocked).toBe(false);
  });

  it('without a camera: no When you leave and no camera switch', async () => {
    const user = userEvent.setup();
    renderApp(`${SCREEN}&part=lock`, world('nocamera').services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.lockAgain });
    expect((within(group).getAllByRole('radio') as HTMLInputElement[]).map((r) => r.value)).toEqual([
      'idle',
      'never',
    ]);
    await part(user, W.parts.night);
    expect(within(s).queryByRole('switch', { name: DESK_TEXT.cameraWake })).toBeNull();
  });

  it('shows the choices as they were made, to change', async () => {
    const user = userEvent.setup();
    renderApp(`${SCREEN}&part=lock`, world('monitor').services);
    const s = await tab();
    const group = await within(s).findByRole('group', { name: DESK_TEXT.lockAgain });
    expect(group.hasAttribute('disabled')).toBe(false);
    expect((within(group).getByRole('radio', { name: 'When you leave' }) as HTMLInputElement).checked).toBe(
      true,
    );
    await part(user, W.parts.night);
    const camera = within(s).getByRole('switch', { name: DESK_TEXT.cameraWake });
    expect(camera.getAttribute('aria-checked')).toBe('true');
    expect(camera.hasAttribute('disabled')).toBe(false);
  });
});

describe('What it shows (AP-5835…)', () => {
  /** The preview's picture: its label says what the screen would say. */
  const preview = (s: HTMLElement) => within(s).findByRole('img', { name: /^Preview: / });

  it('saves a choice at once, and the preview draws the page’s choices', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('pinned');
    renderApp(SCREEN, services);
    const s = await tab();
    expect((await preview(s)).getAttribute('aria-label')).toContain('All fine');
    const plex = within(s).getByRole('radiogroup', { name: 'Plex' });
    expect(within(plex).getByRole('radio', { name: W.levels.matters })).toHaveProperty('checked', true);
    await user.click(within(plex).getByRole('radio', { name: W.levels.off }));
    await waitFor(() => expect(desk.snapshot().settings.show.items['connection:con_plex']).toBe('off'));
    expect(within(plex).getByRole('radio', { name: W.levels.off })).toHaveProperty('checked', true);

    const network = within(s).getByRole('radiogroup', { name: W.barItems.network.name });
    await user.click(within(network).getByRole('radio', { name: W.levels.matters }));
    await waitFor(() => expect(desk.snapshot().settings.show.bar.network).toBe('matters'));

    // Remote help and the camera can't be hidden: Always, with no choice.
    expect(within(s).getByText(W.alwaysShown)).toBeTruthy();
    expect(within(s).queryByRole('radiogroup', { name: W.alwaysShown })).toBeNull();

    await user.click(within(s).getByRole('switch', { name: W.doneToday.name }));
    await waitFor(() => expect(desk.snapshot().settings.show.doneToday).toBe(false));
    const clock = within(s).getByRole('radiogroup', { name: W.clock.name });
    await user.click(within(clock).getByRole('radio', { name: W.clocks.small }));
    await waitFor(() => expect(desk.snapshot().settings.show.clock).toBe('small'));
  });

  it('previews a scenario and tries it on the screen for a minute', async () => {
    const user = userEvent.setup();
    renderApp(SCREEN, world('pinned').services);
    const s = await tab();
    await preview(s);
    const scenarios = within(s).getByRole('group', { name: W.preview });
    await user.click(within(scenarios).getByRole('radio', { name: W.scenarios.wrong }));
    await waitFor(async () => expect((await preview(s)).getAttribute('aria-label')).toMatch(/wrong/));
    await user.click(within(s).getByRole('button', { name: /^Try “Something’s wrong”/ }));
    expect(await within(s).findByText(W.trying)).toBeTruthy();
  });

  it('orders the servers with Move up and Move down, keeping focus on the button', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('pinned');
    renderApp(SCREEN, services);
    const s = await tab();
    const down = await within(s).findByRole('button', { name: 'Move pve-01 down' });
    await user.click(down);
    await waitFor(() =>
      expect(desk.snapshot().settings.show.order.slice(0, 2)).toEqual(['pve-02', 'pve-01']),
    );
    expect(document.activeElement).toBe(down);
    const servers = [...s.querySelectorAll('[data-row^="server:"]')].map((r) => r.getAttribute('data-row'));
    expect(servers.slice(0, 2)).toEqual(['server:pve-02', 'server:pve-01']);
    // At the top, Move up does nothing.
    await user.click(within(s).getByRole('button', { name: 'Move pve-02 up' }));
    expect(desk.snapshot().settings.show.order.slice(0, 2)).toEqual(['pve-02', 'pve-01']);
  });

  it('isn’t there on a Whombat whose runtime doesn’t list the choices', async () => {
    renderApp(SCREEN, world('pinned', { world: null }).services);
    const s = await tab();
    const parts = await screen.findByRole('group', { name: W.openScreen });
    expect(within(parts).queryByRole('radio', { name: W.parts.shows })).toBeNull();
    expect(within(parts).getByRole('radio', { name: W.parts.lock })).toHaveProperty('checked', true);
    expect(within(s).getByRole('button', { name: 'Change PIN' })).toBeTruthy();
  });
});

describe('the Whombat’s name on the screen (AP-5840…)', () => {
  it('gives the box the directory’s name when Screen opens and the box has another', async () => {
    const { services, desk } = world('pinned');
    const managed = {
      applianceId: 'wb-1',
      applianceName: 'Old name',
      whombats: {
        list: async () => [{ device: 'wb-1', name: 'Home' }],
        known: () => undefined,
        open: () => {},
        claim: () => {},
      },
    } as unknown as ManagedContext;
    renderApp(SCREEN, { ...services, managed });
    await tab();
    await waitFor(() => expect(desk.snapshot().name).toBe('Home'));
  });

  it('gives nothing in a world without a directory', async () => {
    const { services, desk } = world('pinned');
    renderApp(SCREEN, services);
    await tab();
    expect(desk.snapshot().name).toBeUndefined();
  });
});

describe('the unlock request (AP-3008, AP-3009)', () => {
  it('asks above every screen, and as NEEDS YOU on This Whombat', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('paired');
    desk.requestUnlock();
    const app = renderApp('/settings', services);
    const notice = await screen.findByTestId('desk-unlock-notice');
    expect(notice.textContent).toContain('Your desk screen wants to unlock');

    // On This Whombat's Overview the row stands in for the notice, and the part counts it.
    await app.history.push('/settings?tab=appliance');
    const needs = await screen.findByRole('heading', { level: 2, name: 'NEEDS YOU' });
    const row = (needs.closest('section') as HTMLElement).querySelector('[data-desk-unlock]') as HTMLElement;
    expect(row).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('desk-unlock-notice')).toBeNull());
    expect(within(row).getByText(/Ends in 2\smin\./)).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(desk.unlocked()).toBe(true));
    await waitFor(() => expect(document.querySelector('[data-desk-unlock]')).toBeNull());
  });

  it('keeps the screen locked on No', async () => {
    const user = userEvent.setup();
    const { services, desk } = world('paired');
    desk.requestUnlock();
    renderApp('/settings', services);
    const notice = await screen.findByTestId('desk-unlock-notice');
    await user.click(within(notice).getByRole('button', { name: 'No' }));
    await waitFor(() => expect(screen.queryByTestId('desk-unlock-notice')).toBeNull());
    expect(desk.unlocked()).toBe(false);
  });
});

describe('the power line (AP-3020)', () => {
  it('says the box is on battery, with the time left', async () => {
    const base = fixtureServices({ host: true });
    const services: AppServices = {
      ...base,
      hostMetrics: async (input) => {
        const now = Date.now();
        return hostMetricsFixture(input, now, hostPowerFixture('battery', now));
      },
    };
    renderApp('/settings?tab=appliance', services);
    const heading = await screen.findByRole('heading', { level: 2, name: 'How it’s doing' });
    const s = heading.closest('section') as HTMLElement;
    const power = await waitFor(() => {
      const el = s.querySelector('[data-power]');
      if (!el) throw new Error('no power line yet');
      return el;
    });
    expect(power.getAttribute('data-power')).toBe('battery');
    expect(power.textContent?.replaceAll('\u00a0', ' ')).toContain('On battery · 64 %');
    expect(power.textContent).toContain('3 h 10 min');
  });

  it('has no line without a battery', async () => {
    renderApp('/settings?tab=appliance', fixtureServices({ host: true }));
    await screen.findByText('Live · checked every 10 seconds');
    expect(document.querySelector('[data-power]')).toBeNull();
  });
});
