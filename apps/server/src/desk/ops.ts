/**
 * The `desk.*` session ops (docs/implementation/desk-display/assignment.md §2.2; desk-display-server.md DK-S17): the
 * person's, on a Whombat whose runtime runs the desk socket. Where it doesn't, they say there's no screen.
 */
import type {
  DeskLayout,
  DeskPopups,
  DeskPreviewScenario,
  DeskSettingsPatch,
  DeskShow,
  DeskShowPatch,
  DeskWidgetRef,
  DeskWidgetSpec,
} from '@whombat/core';
import type { DeskScreenAddPageInput } from '@whombat/protocol/session';
import { ApiError } from '../lib/errors';
import type { SessionPrincipal } from '../managed/trust';
import type { DeskService } from './service';

interface DeskOpContext {
  principal: SessionPrincipal;
  desk: DeskService | undefined;
}

function deskOf(c: DeskOpContext): DeskService {
  if (!c.desk) throw new ApiError('not_implemented', 'This Whombat has no screen to show things on.');
  return c.desk;
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type DeskHandler = (c: DeskOpContext, input: any) => Promise<unknown>;

export const DESK_SESSION_HANDLERS: Readonly<Record<string, DeskHandler>> = {
  'desk.get': (c) => deskOf(c).screen(c.principal),
  'desk.startPairing': (c) => deskOf(c).startPairing(c.principal),
  'desk.pair': (c, i: { code: string; pin: string }) => deskOf(c).pair(c.principal, i),
  'desk.setPin': (c, i: { pin: string }) => deskOf(c).setPin(c.principal, i),
  'desk.update': (c, i: DeskSettingsPatch) => deskOf(c).update(c.principal, i),
  'desk.setScreen': (c, i: { on: boolean }) => deskOf(c).setScreen(c.principal, i),
  // Now *off* (DK-20): older apps' Unpair.
  'desk.unpair': (c) => deskOf(c).unpair(c.principal),
  'desk.answerUnlock': (c, i: { id: string; unlock: boolean }) => deskOf(c).answerUnlock(c.principal, i),
  // Listen (DK-51): read through an export stream only (DK-S54, `SESSION_EXPORT_OPS`).
  'desk.voiceSample': (c, i: { voice: string }) => deskOf(c).voiceSample(c.principal, i),
  // Settings → Screen (DK-119, DK-123, DK-124): the preview, *Try it on the screen* and the top bar's name.
  'desk.preview': (c, i: { scenario: DeskPreviewScenario; show?: DeskShow }) =>
    deskOf(c).preview(c.principal, i),
  'desk.tryOnScreen': (c, i: { scenario: DeskPreviewScenario; show?: DeskShow }) =>
    deskOf(c).tryOnScreen(c.principal, i),
  'desk.setName': (c, i: { name: string }) => deskOf(c).setName(c.principal, i),
  // Settings → Screens and the editor (DK-128, DK-143): the screens of widgets.
  'desk.screens': (c) => deskOf(c).screensList(c.principal),
  'desk.screen.get': (c, i: { screen: string }) => deskOf(c).screenGet(c.principal, i),
  'desk.screen.update': (
    c,
    i: {
      screen: string;
      name?: string;
      popups?: DeskPopups;
      doorbell?: 'big' | 'off';
      layout?: DeskLayout;
      show?: DeskShowPatch;
    },
  ) => deskOf(c).screenUpdate(c.principal, i),
  // The assistant's “make me a page”.
  'desk.screen.addPage': (c, i: DeskScreenAddPageInput) => deskOf(c).screenAddPage(c.principal, i),
  'desk.screen.views': (
    c,
    i: { screen: string; widgets: DeskWidgetSpec[]; scenario?: DeskPreviewScenario },
  ) => deskOf(c).screenViews(c.principal, i),
  'desk.screen.try': (c, i: { screen: string; layout: DeskLayout }) => deskOf(c).screenTry(c.principal, i),
  'desk.screen.remove': (c, i: { screen: string }) => deskOf(c).screenRemove(c.principal, i),
  'desk.widgets': (c, i: { screen: string; thing?: DeskWidgetRef }) => deskOf(c).widgets(c.principal, i),
};
