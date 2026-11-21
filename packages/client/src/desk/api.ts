/**
 * The desk's session ops as one object (Whombat desk-display.md DK-12): the managed session's `desk.*`, or a fixture
 * world's stand-in (`createFakeDesk`), so the screens and hooks don't care which. None on a self-hosted server: the
 * desk is the box's own screen.
 */
import type { NewEndpoint } from '@whombat/protocol/session';
import type { z } from 'zod';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type {
  DeskCatalog,
  DeskLayout,
  DeskPreview,
  DeskPreviewInput,
  DeskScreen,
  DeskScreenAddInput,
  DeskScreenDetail,
  DeskScreensList,
  DeskScreenUpdateInput,
  DeskScreenViews,
  DeskScreenViewsInput,
  DeskStartPairingOutput,
  DeskUpdateInput,
  DeskVoice,
  EnrollDisplayRequestOutput,
  EnrollDisplayStatusOutput,
  ScreenImage,
  ScreenLock,
  ScreenStateOutput,
} from './contract';
import { deskSampleWav } from './model';

export interface DeskApi {
  get(): Promise<DeskScreen>;
  startPairing(): Promise<z.output<typeof DeskStartPairingOutput>>;
  pair(input: { code: string; pin: string }): Promise<DeskScreen>;
  setPin(pin: string): Promise<DeskScreen>;
  update(patch: DeskUpdateInput): Promise<DeskScreen>;
  /** Turns the screen off where the runtime has the switch (DK-20); unpairs on older runtimes. */
  unpair(): Promise<DeskScreen>;
  /** Show Whombat on this screen, or not (runtimes with `display`, DK-20). */
  setScreen(on: boolean): Promise<DeskScreen>;
  answerUnlock(input: { id: string; unlock: boolean }): Promise<{ ok: true }>;
  /**
   * *Listen* (0.105, DK-51): the screen's sample sentence said in `voice` by the box, as WAV bytes. Only where the
   * screen lists its `voices` (older runtimes don't serve it); `no_voice` when the box can't say it now.
   */
  voiceSample(voice: DeskVoice, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /** Settings' preview (3.2, DK-123): the calm glance with `show` (the saved choices when absent) for `scenario`. */
  preview(input: DeskPreviewInput): Promise<DeskPreview>;
  /** *Try it on the screen* (3.2, DK-124): until when the screen shows it. */
  tryOnScreen(input: DeskPreviewInput): Promise<{ until: string }>;
  /** The Whombat's name for the screen's top bar (3.2, DK-119). */
  setName(name: string): Promise<DeskScreen>;
  /*
   * Screens of widgets (3.6, DK-126…DK-149): Settings → Screens and the editor. A runtime before 3.6 answers
   * `unknown_op` to each (`deskScreensOffered`).
   */
  /** Every screen, the box's own first, and whether another can be added. */
  screens(): Promise<DeskScreensList>;
  /** One screen with its layout and its choices; `unknown_screen` once it's gone. */
  screen(id: string): Promise<DeskScreenDetail>;
  /** Its name (not the box's), pop-ups, layout (whole; `bad_layout`) or *What’s going on* / *Servers* choices. */
  updateScreen(input: DeskScreenUpdateInput): Promise<DeskScreenDetail>;
  /** The views of any widgets as that screen draws them now: the editor's live preview, a draft's widgets included. */
  screenViews(input: DeskScreenViewsInput): Promise<DeskScreenViews>;
  /** *Try on the screen*: until when that screen shows the draft. */
  tryScreen(input: { screen: string; layout: DeskLayout }): Promise<{ until: string }>;
  /** *Add a screen* with the six letters a tablet or computer shows (`wrong_code`, `pairing_expired`, `screens_full`). */
  addScreen(input: DeskScreenAddInput): Promise<DeskScreenDetail>;
  /** *Remove*: a device's screen ends at once; a monitor's forgets its layout. */
  removeScreen(id: string): Promise<{ ok: true }>;
  /** *Add a widget*: Whombat's own, the servers, the things; with `thing`, that thing's widgets read now. */
  widgets(input: { screen: string; thing?: string }): Promise<DeskCatalog>;
}

/** The desk over this session. */
export function deskApi(session: ApplianceSession): DeskApi {
  return {
    get: () => sessionOps.deskGet(session),
    startPairing: () => sessionOps.deskStartPairing(session),
    pair: (input) => sessionOps.deskPair(session, input),
    setPin: (pin) => sessionOps.deskSetPin(session, pin),
    update: (patch) => sessionOps.deskUpdate(session, patch),
    unpair: () => sessionOps.deskUnpair(session),
    setScreen: (on) => sessionOps.deskSetScreen(session, on),
    answerUnlock: (input) => sessionOps.deskAnswerUnlock(session, input),
    voiceSample: async (voice, options) =>
      deskSampleWav(await sessionOps.deskVoiceSample(session, { voice }, options)),
    preview: (input) => sessionOps.deskPreview(session, input),
    tryOnScreen: (input) => sessionOps.deskTryOnScreen(session, input),
    setName: (name) => sessionOps.deskSetName(session, name),
    screens: () => sessionOps.deskScreens(session),
    screen: (id) => sessionOps.deskScreenGet(session, id),
    updateScreen: (input) => sessionOps.deskScreenUpdate(session, input),
    screenViews: (input) => sessionOps.deskScreenViews(session, input),
    tryScreen: (input) => sessionOps.deskScreenTry(session, input),
    addScreen: (input) => sessionOps.deskScreenAdd(session, input),
    removeScreen: async (id) => {
      await sessionOps.deskScreenRemove(session, id);
      return { ok: true };
    },
    widgets: (input) => sessionOps.deskWidgets(session, input),
  };
}

/** What a new screen endpoint says about itself (`enroll.display.request`): how it shows in Settings. */
export type DisplayEndpoint = z.input<typeof NewEndpoint>;

/**
 * A device becoming a screen (3.6, DK-146), on its own unenrolled endpoint: the six letters to type in Settings, then
 * whether the person typed them. Then the endpoint is a screen's and reconnects for the `screen` channel.
 */
export interface DisplayEnrolApi {
  request(endpoint: DisplayEndpoint): Promise<z.output<typeof EnrollDisplayRequestOutput>>;
  status(requestId: string): Promise<z.output<typeof EnrollDisplayStatusOutput>>;
}

/** A screen elsewhere (3.6, DK-146): only its own state, its lock and the pictures its widgets name. */
export interface ScreenApi {
  /** What it draws, or `{same}` when nothing changed since `known`. */
  state(input: { size: { width: number; height: number }; known?: string }): Promise<ScreenStateOutput>;
  unlock(pin: string): Promise<ScreenLock>;
  lock(): Promise<ScreenLock>;
  /** A picture one of its views names, as its bytes and type. */
  image(
    input: { thing: string; ref: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ type: ScreenImage['type']; bytes: Uint8Array }>;
}

/** The six letters' side over an unenrolled session. */
export function displayEnrolApi(session: ApplianceSession): DisplayEnrolApi {
  return {
    request: (endpoint) => sessionOps.enrollDisplayRequest(session, { endpoint }),
    status: (requestId) => sessionOps.enrollDisplayStatus(session, requestId),
  };
}

/** A screen's own ops over its session (the `screen` channel). */
export function screenApi(session: ApplianceSession): ScreenApi {
  return {
    state: (input) => sessionOps.screenState(session, input),
    unlock: (pin) => sessionOps.screenUnlock(session, pin),
    lock: () => sessionOps.screenLock(session),
    image: async (input, options) => screenImageBytes(await sessionOps.screenImage(session, input, options)),
  };
}

/** A picture's base64 as bytes. */
export function screenImageBytes(image: ScreenImage): { type: ScreenImage['type']; bytes: Uint8Array } {
  const raw = atob(image.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { type: image.type, bytes };
}
