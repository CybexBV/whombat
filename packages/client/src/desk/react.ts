/**
 * The desk in React (Whombat desk-display.md DK-02…DK-09; app desk-display-web.md AP-3001, AP-3002): `desk.get` in the
 * query cache under `desk.get` (so `desk.changed` and a resync of `me` refetch it, `query/apply.ts`), the changes that
 * put the screen they answer straight into it, and the unlock request with its clock. The same on the web and the phone
 * (`@whombat/client/desk/react`); the platform brings its `DeskApi` (`deskApi(session)`, or a fixture's).
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { applyDeskSettingsPatch, applyDeskShowPatch } from '@whombat/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QUERY_ROOT } from '../query/keys';
import type { DeskApi } from './api';
import type {
  DeskLayout,
  DeskPreviewInput,
  DeskScreen,
  DeskScreenAddInput,
  DeskScreenDetail,
  DeskScreensList,
  DeskScreenUpdateInput,
  DeskScreenViewsInput,
  DeskUpdateInput,
  DeskVoice,
} from './contract';
import { type DeskUnlockRequest, deskListenErrorText, deskUnlockRequest } from './model';

/** Where `desk.get` is kept: an endpoint-shaped key, so `queryKeys.scope('desk.get')` finds it. */
export const DESK_QUERY_KEY = [QUERY_ROOT, 'desk.get', {}, {}] as const;

/**
 * The screen (`desk.get`), or no data where there is no desk here (`api` null) or the Whombat doesn't offer it
 * (`enabled` false). Not retried: a refusal is an answer.
 */
export function useDesk(api: DeskApi | null, enabled = true) {
  return useQuery({
    queryKey: DESK_QUERY_KEY,
    queryFn: () => (api as DeskApi).get(),
    enabled: api !== null && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * Settings → Screen's preview (3.2; Whombat desk-display.md DK-123): the calm glance for `input` (its `show` may be
 * choices not saved yet), kept while the next one loads, read again every 30 s and when the screen changes. Null
 * `input`: no preview (a runtime before 3.2, or the screen not paired).
 */
export function useDeskPreview(api: DeskApi | null, input: DeskPreviewInput | null) {
  return useQuery({
    queryKey: [QUERY_ROOT, 'desk.preview', input ?? {}, {}] as const,
    queryFn: () => (api as DeskApi).preview(input as DeskPreviewInput),
    enabled: api !== null && input !== null,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Where `desk.screens` is kept (3.6): `desk.changed` refetches it as it does `desk.get`. */
export const DESK_SCREENS_KEY = [QUERY_ROOT, 'desk.screens', {}, {}] as const;
/** What `desk.changed` refetches of Settings → Screens: the list and every screen's own read. */
export const DESK_SCREENS_CHANGED = [
  [QUERY_ROOT, 'desk.screens'],
  [QUERY_ROOT, 'desk.screen.get'],
] as const;
/** Where one screen's `desk.screen.get` is kept. */
export const deskScreenKey = (screen: string) => [QUERY_ROOT, 'desk.screen.get', { screen }, {}] as const;

/**
 * Settings → Screens (3.6, DK-128): every screen, or an error where the runtime doesn't answer `desk.screens` (before
 * 3.6: `unknown_op`), which keeps the old *Screen* tab (DK-149). Not retried: a refusal is an answer.
 */
export function useDeskScreens(api: DeskApi | null, enabled = true) {
  return useQuery<DeskScreensList>({
    queryKey: DESK_SCREENS_KEY,
    queryFn: () => (api as DeskApi).screens(),
    enabled: api !== null && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** One screen with its layout and choices (`desk.screen.get`); null `screen`: none asked. */
export function useDeskScreen(api: DeskApi | null, screen: string | null) {
  return useQuery<DeskScreenDetail>({
    queryKey: deskScreenKey(screen ?? ''),
    queryFn: () => (api as DeskApi).screen(screen as string),
    enabled: api !== null && screen !== null,
    retry: false,
    staleTime: 30_000,
  });
}

/** How often a screen's live views are read again in Settings (DK-143: the editor's “live data”). */
export const DESK_VIEWS_REFRESH_MS = 30_000;

/**
 * The views of a screen's widgets as it draws them now (`desk.screen.views`): a list's thumbnail or the editor's live
 * preview. Kept while the next one loads (a draft's new widget doesn't blank the others), read again every 30 s.
 */
export function useDeskScreenViews(api: DeskApi | null, input: DeskScreenViewsInput | null) {
  return useQuery({
    queryKey: [QUERY_ROOT, 'desk.screen.views', input ?? {}, {}] as const,
    queryFn: () => (api as DeskApi).screenViews(input as DeskScreenViewsInput),
    enabled: api !== null && input !== null,
    retry: false,
    staleTime: 10_000,
    refetchInterval: DESK_VIEWS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

/** *Add a widget*'s groups (`desk.widgets`); with `thing`, that thing's widgets read now (a partial group opened). */
export function useDeskWidgets(api: DeskApi | null, input: { screen: string; thing?: string } | null) {
  return useQuery({
    queryKey: [QUERY_ROOT, 'desk.widgets', input ?? {}, {}] as const,
    queryFn: () => (api as DeskApi).widgets(input as { screen: string; thing?: string }),
    enabled: api !== null && input !== null,
    retry: false,
    staleTime: 60_000,
  });
}

export interface DeskScreenActions {
  /** A screen's name, pop-ups, choices or layout; the screen shows it at once and is put back when refused. */
  update(input: DeskScreenUpdateInput): Promise<DeskScreenDetail>;
  /** *Add a screen* with a device's six letters. */
  add(input: DeskScreenAddInput): Promise<DeskScreenDetail>;
  /** *Remove* a device's (or forget a monitor's) screen. */
  remove(screen: string): Promise<void>;
  /** *Try on the screen*: until when it shows the draft. */
  tryLayout(input: { screen: string; layout: DeskLayout }): Promise<{ until: string }>;
}

/** Settings → Screens' changes, each keeping `desk.screens` and the screen's own read as the runtime answered. */
export function useDeskScreenActions(api: DeskApi | null): DeskScreenActions {
  const qc = useQueryClient();
  return useMemo(() => {
    const need = (): DeskApi => {
      if (!api) throw new Error('There is no desk screen here.');
      return api;
    };
    const put = (detail: DeskScreenDetail) => {
      qc.setQueryData(deskScreenKey(detail.id), detail);
      const list = qc.getQueryData<DeskScreensList>(DESK_SCREENS_KEY);
      if (list) {
        const { layout: _layout, show: _show, ...summary } = detail;
        const known = list.screens.some((x) => x.id === detail.id);
        qc.setQueryData<DeskScreensList>(DESK_SCREENS_KEY, {
          ...list,
          screens: known
            ? list.screens.map((x) => (x.id === detail.id ? summary : x))
            : [...list.screens, summary],
        });
      }
      return detail;
    };
    return {
      async update(input) {
        const key = deskScreenKey(input.screen);
        const before = qc.getQueryData<DeskScreenDetail>(key);
        if (before)
          qc.setQueryData<DeskScreenDetail>(key, {
            ...before,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.popups ? { popups: input.popups } : {}),
            ...(input.layout ? { layout: input.layout, pages: input.layout.pages.length } : {}),
            ...(input.show ? { show: applyDeskShowPatch(before.show, input.show) } : {}),
          });
        try {
          return put(await need().updateScreen(input));
        } catch (error) {
          if (before) qc.setQueryData(key, before);
          throw error;
        }
      },
      async add(input) {
        const detail = put(await need().addScreen(input));
        void qc.invalidateQueries({ queryKey: DESK_SCREENS_KEY });
        return detail;
      },
      async remove(screen) {
        await need().removeScreen(screen);
        const list = qc.getQueryData<DeskScreensList>(DESK_SCREENS_KEY);
        if (list)
          qc.setQueryData<DeskScreensList>(DESK_SCREENS_KEY, {
            ...list,
            screens: list.screens.filter((x) => x.id !== screen),
          });
        qc.removeQueries({ queryKey: deskScreenKey(screen) });
        void qc.invalidateQueries({ queryKey: DESK_SCREENS_KEY });
      },
      tryLayout: (input) => need().tryScreen(input),
    };
  }, [api, qc]);
}

export interface DeskActions {
  /** The screen shows four letters for 10 minutes; resolves to when they change. */
  startPairing(): Promise<{ expiresAt: string }>;
  pair(input: { code: string; pin: string }): Promise<DeskScreen>;
  setPin(pin: string): Promise<DeskScreen>;
  /** Shown at once; put back as it was when refused. */
  update(patch: DeskUpdateInput): Promise<DeskScreen>;
  unpair(): Promise<DeskScreen>;
  /**
   * Show Whombat on this screen, or not (DK-20): the switch moves at once and is put back when refused; the answer
   * brings the pairing (on pairs to the caller, off ends it).
   */
  setScreen(on: boolean): Promise<DeskScreen>;
  /** Unlock or keep locked; the request leaves the cache either way (answered, or no longer there). */
  answerUnlock(input: { id: string; unlock: boolean }): Promise<void>;
}

/** The desk's changes, each keeping `desk.get`'s cache as the server answered. */
export function useDeskActions(api: DeskApi | null): DeskActions {
  const qc = useQueryClient();
  return useMemo(() => {
    const need = (): DeskApi => {
      if (!api) throw new Error('There is no desk screen here.');
      return api;
    };
    const read = () => qc.getQueryData<DeskScreen>(DESK_QUERY_KEY);
    const put = (screen: DeskScreen) => {
      qc.setQueryData(DESK_QUERY_KEY, screen);
      return screen;
    };
    const patch = (change: (s: DeskScreen) => DeskScreen) => {
      const now = read();
      if (now) qc.setQueryData(DESK_QUERY_KEY, change(now));
    };
    return {
      async startPairing() {
        const r = await need().startPairing();
        patch((s) => ({ ...s, pairing: { expiresAt: r.expiresAt } }));
        return r;
      },
      pair: async (input) => put(await need().pair(input)),
      setPin: async (pin) => put(await need().setPin(pin)),
      async update(change) {
        const before = read();
        if (before)
          put({
            ...before,
            settings: applyDeskSettingsPatch(before.settings, change),
          });
        try {
          return put(await need().update(change));
        } catch (error) {
          if (before) put(before);
          throw error;
        }
      },
      unpair: async () => put(await need().unpair()),
      async setScreen(on) {
        const before = read();
        if (before) put({ ...before, on, onChosen: true });
        try {
          return put(await need().setScreen(on));
        } catch (error) {
          if (before) put(before);
          throw error;
        }
      },
      async answerUnlock(input) {
        try {
          await need().answerUnlock(input);
        } finally {
          patch((s) => (s.unlockRequest?.id === input.id ? { ...s, unlockRequest: null } : s));
          void qc.invalidateQueries({ queryKey: DESK_QUERY_KEY });
        }
      },
    };
  }, [api, qc]);
}

/** `Date.now()`, ticking every `ms` while `on`. */
export function useDeskClock(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return on ? now : Date.now();
}

/**
 * The screen's unlock request (DK-04): shown from `desk.changed` until answered here or elsewhere, or until its 2
 * minutes are over (a clock ticks while there is one).
 */
export function useDeskUnlockRequest(api: DeskApi | null, enabled = true): DeskUnlockRequest | null {
  const desk = useDesk(api, enabled);
  const pending = Boolean(desk.data?.unlockRequest);
  const now = useDeskClock(pending);
  return deskUnlockRequest(desk.data, now);
}

/** Listen in Settings (DK-51): which voice's sample is on its way or playing, and the buttons' one action. */
export interface DeskListen {
  /** The voice whose sample is on its way or playing (its button says “Playing…”), or null. */
  playing: DeskVoice | null;
  /** Plays `voice`'s sample, stopping any other; pressed again while it plays, stops it. */
  toggle(voice: DeskVoice): void;
  stop(): void;
}

export interface DeskListenOptions {
  /** The assistant's name: the sample says it (“Hi, I’m Neo.”), so a new name is a new sample. */
  assistant: string;
  /** The platform plays the WAV: settles once it ended, at once when `signal` aborts; rejects when it can't. */
  play(wav: Uint8Array, signal: AbortSignal): Promise<void>;
  /** A sample that didn't arrive or couldn't play, in words (`DESK_WORDS`). */
  onFailed(text: string): void;
}

/**
 * Listen (DK-51) on the web and the phone: one sample at a time, from the box (`desk.voiceSample`) the first time and
 * then from memory while the section shows. Starting another, pressing the one playing, or leaving stops it (the
 * request too, when it is still on its way); a failure says why unless it was stopped.
 */
export function useDeskListen(api: DeskApi | null, options: DeskListenOptions): DeskListen {
  const [playing, setPlaying] = useState<DeskVoice | null>(null);
  const current = useRef<{ voice: DeskVoice; abort: AbortController } | null>(null);
  const samples = useRef(new Map<string, Uint8Array>());
  const latest = useRef(options);
  latest.current = options;
  const stop = useCallback(() => {
    const was = current.current;
    current.current = null;
    was?.abort.abort();
    setPlaying(null);
  }, []);
  useEffect(() => stop, [stop]);
  const toggle = useCallback(
    (voice: DeskVoice) => {
      const again = current.current?.voice === voice;
      stop();
      if (again || !api) return;
      const mine = { voice, abort: new AbortController() };
      const { signal } = mine.abort;
      current.current = mine;
      setPlaying(voice);
      const key = `${voice}\n${latest.current.assistant}`;
      void (async () => {
        try {
          let wav = samples.current.get(key);
          if (!wav) {
            wav = await api.voiceSample(voice, { signal });
            samples.current.set(key, wav);
          }
          if (!signal.aborted) await latest.current.play(wav, signal);
        } catch (error) {
          if (!signal.aborted) latest.current.onFailed(deskListenErrorText(error));
        } finally {
          if (current.current === mine) {
            current.current = null;
            setPlaying(null);
          }
        }
      })();
    },
    [api, stop],
  );
  return { playing, toggle, stop };
}
