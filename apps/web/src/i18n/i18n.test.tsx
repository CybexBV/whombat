/**
 * The web app's language: English by default, Dutch loaded only when asked for, the pseudo-locale for QA, `<html lang>`
 * kept right, queries asked again after a change, each box's language remembered in this browser, the Settings choice
 * (which never turns on the Dutch voice), visitors of a shared link in their own language, the legal pages' notice and
 * the push worker's words without a preview.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pushText } from '@whombat/client/managed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegalPage } from '../legal/LegalPage';
import { fixtureServices, renderApp } from '../test/renderApp';
import { EN } from './en';
import { LOCALE_LAST_KEY, LOCALE_OVERRIDE_KEY, localeBoxKey } from './locale';
import { NL } from './nl';
import {
  currentLocale,
  useOwnerLocaleSync,
  useWebI18n,
  useWebLocaleControl,
  type WebI18nControl,
  WebI18nProvider,
} from './provider';

function Probe() {
  const { t, language, tag } = useWebI18n();
  return (
    <p data-probe="" data-language={language} data-tag={tag ?? ''}>
      {t('settings.language.title')}
    </p>
  );
}

let control: WebI18nControl | null = null;
function Control() {
  control = useWebLocaleControl();
  return null;
}

function Owner({ locale }: { locale: string | null | undefined }) {
  useOwnerLocaleSync(locale);
  return <Probe />;
}

const probe = async () => (await screen.findByText(/./, { selector: '[data-probe]' })) as HTMLElement;
const at = (url: string) => window.history.replaceState(null, '', url);

beforeEach(() => {
  at('/');
  localStorage.clear();
  sessionStorage.clear();
  control = null;
});

afterEach(() => {
  at('/');
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('the language provider', () => {
  it('shows English by default and says so on <html lang>', async () => {
    render(
      <WebI18nProvider>
        <Probe />
      </WebI18nProvider>,
    );
    const p = await probe();
    expect(p.textContent).toBe(EN['settings.language.title']);
    expect(p.dataset.language).toBe('en');
    // English gives the shared packages no locale, so their English stays exactly as it was.
    expect(p.dataset.tag).toBe('');
    expect(currentLocale()).toBeUndefined();
    expect(document.documentElement.lang).toBe('en-GB');
  });

  it('loads Dutch when ?lang=nl asks for it, and keeps it for the tab', async () => {
    at('/?lang=nl');
    render(
      <WebI18nProvider>
        <Probe />
      </WebI18nProvider>,
    );
    await waitFor(async () => expect((await probe()).textContent).toBe(NL['settings.language.title']));
    expect(document.documentElement.lang).toBe('nl-NL');
    expect(currentLocale()).toBe('nl-NL');
    expect(sessionStorage.getItem(LOCALE_OVERRIDE_KEY)).toBe('nl-NL');
  });

  it('shows the pseudo-locale for QA', async () => {
    at('/?lang=pseudo');
    render(
      <WebI18nProvider>
        <Probe />
      </WebI18nProvider>,
    );
    const p = await probe();
    expect(p.dataset.language).toBe('en');
    expect(p.textContent).not.toBe(EN['settings.language.title']);
    expect(document.documentElement.lang).toBe('en-XA');
  });

  it('asks the queries again when the language changes, not on the first paint', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['probe'], 1);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <WebI18nProvider queryClient={queryClient}>
        <Control />
        <Probe />
      </WebI18nProvider>,
    );
    await probe();
    expect(invalidate).not.toHaveBeenCalled();
    act(() => control?.setLocale('nl-NL'));
    await waitFor(async () => expect((await probe()).textContent).toBe(NL['settings.language.title']));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it('follows the owner’s stored language and remembers it per box', async () => {
    const first = render(
      <WebI18nProvider boxId="box_a">
        <Owner locale="nl-NL" />
      </WebI18nProvider>,
    );
    await waitFor(async () => expect((await probe()).textContent).toBe(NL['settings.language.title']));
    expect(localStorage.getItem(localeBoxKey('box_a'))).toBe('nl-NL');
    expect(localStorage.getItem(LOCALE_LAST_KEY)).toBe('nl-NL');
    first.unmount();

    // The next visit to that box starts in Dutch before the box has answered.
    render(
      <WebI18nProvider boxId="box_a">
        <Owner locale={undefined} />
      </WebI18nProvider>,
    );
    await waitFor(async () => expect((await probe()).textContent).toBe(NL['settings.language.title']));
  });

  it('keeps a visitor in their own browser’s language, never the owner’s', async () => {
    localStorage.setItem(LOCALE_LAST_KEY, 'nl-NL');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US', 'en']);
    render(
      <WebI18nProvider scope="visitor">
        <Owner locale="nl-NL" />
      </WebI18nProvider>,
    );
    const p = await probe();
    expect(p.textContent).toBe(EN['settings.language.title']);
    expect(document.documentElement.lang).toBe('en-GB');
  });

  it('gives a visitor with a Dutch browser Dutch', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['nl-BE', 'en']);
    render(
      <WebI18nProvider scope="visitor">
        <Probe />
      </WebI18nProvider>,
    );
    await waitFor(async () => expect((await probe()).textContent).toBe(NL['settings.language.title']));
  });
});

describe('the legal pages', () => {
  it('say in Dutch that the English text governs, and keep the English text', async () => {
    at('/?lang=nl');
    render(
      <WebI18nProvider>
        <LegalPage text={'# Terms\n\nThe English text.'} />
      </WebI18nProvider>,
    );
    expect(await screen.findByText(NL['legal.englishGoverns'])).toBeTruthy();
    expect(screen.getByText('The English text.').closest('[lang="en"]')).not.toBeNull();
  });

  it('show no notice in English', async () => {
    render(
      <WebI18nProvider>
        <LegalPage text={'# Terms\n\nThe English text.'} />
      </WebI18nProvider>,
    );
    expect(await screen.findByText('The English text.')).toBeTruthy();
    expect(screen.queryByText(NL['legal.englishGoverns'])).toBeNull();
  });
});

describe('Settings → You → Language', () => {
  it('switches the app to Dutch, saves it, and only points at the Dutch voice', async () => {
    const user = userEvent.setup();
    const services = fixtureServices({ voice: 'ready' });
    const save = vi.spyOn(services.client.me, 'updatePreferences');
    renderApp('/settings?part=profile', services);
    const group = await screen.findByRole('radiogroup', { name: EN['settings.language.title'] });
    await user.click(within(group).getByRole('radio', { name: 'Nederlands' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('nl-NL'));
    expect(save).toHaveBeenCalledWith({ body: { locale: 'nl-NL' } });
    const note = await waitFor(() => {
      const found = document.querySelector('[data-dutch-voice-note]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(note).getByRole('link').getAttribute('href')).toContain('tab=appliance');
    // Choosing Dutch asks the box nothing about the voice: it stays off until the person agrees to its licence.
    const voice = await services.voice.get();
    expect(voice.dutchVoice?.on).toBe(false);
  });
});

/** `public/sw.js` in a fake worker scope, loaded from `url`, with or without the Cache API. */
function worker(url: string, withCache = false) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Array<{ title: string; body: unknown }> = [];
  const store = new Map<string, string>();
  const caches = {
    open: async () => ({
      match: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? undefined : { text: async () => value };
      },
      put: async (key: string, response: Response) => {
        store.set(key, await response.text());
      },
    }),
  };
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    registration: {
      showNotification: async (title: string, options: { body: unknown }) => {
        shown.push({ title, body: options.body });
      },
      getNotifications: async () => [],
    },
    location: { origin: 'https://app.example', href: `https://app.example${url}` },
    clients: { matchAll: async () => [], openWindow: async () => null },
  };
  const source = readFileSync(resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(source, {
    self,
    Object,
    URL,
    Response,
    encodeURIComponent,
    ...(withCache ? { caches } : {}),
  });
  const send = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
    });
    await done;
  };
  const push = (payload: unknown) => send('push', { data: { json: () => payload } });
  const message = (data: unknown) => send('message', { data });
  return { push, message, shown };
}

describe('the push worker’s language', () => {
  const dutch = pushText('nl-NL');
  const english = pushText();

  it('hides a preview the payload marks private, in the language of its address', async () => {
    const w = worker('/sw.js?lang=nl');
    await w.push({ title: 'Mara', body: 'The secret plan', kind: 'message', ref: 'r1', preview: false });
    await w.push({ title: 'Mara', body: 'The secret plan', kind: 'approval', ref: 'r2', generic: true });
    expect(w.shown).toEqual([
      { title: 'Whombat', body: dutch.message },
      { title: 'Whombat', body: dutch.approval },
    ]);
  });

  it('still reads control’s fixed English text as no preview', async () => {
    const w = worker('/sw.js?lang=nl');
    await w.push({ title: 'Whombat', body: 'Whombat needs you', kind: 'run', ref: 'r3' });
    expect(w.shown).toEqual([{ title: 'Whombat', body: dutch.run }]);
  });

  it('shows a real preview as it came', async () => {
    const w = worker('/sw.js?lang=nl');
    await w.push({ title: 'Mara', body: 'Lunch?', kind: 'message', ref: 'r4' });
    expect(w.shown).toEqual([{ title: 'Mara', body: 'Lunch?' }]);
  });

  it('is English without a language, and takes the page’s language from a message', async () => {
    const w = worker('/sw.js', true);
    await w.push({ title: 'Mara', body: 'x', kind: 'message', ref: 'r5', preview: false });
    await w.message({ type: 'locale', lang: 'nl' });
    await w.push({ title: 'Mara', body: 'x', kind: 'message', ref: 'r6', preview: false });
    expect(w.shown.map((s) => s.body)).toEqual([english.message, dutch.message]);
  });
});
