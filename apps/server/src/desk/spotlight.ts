/**
 * Moments that take over a screen (docs/decisions/desk-display.md; desk-display-server.md): when
 * the doorbell rings, every screen of its Whombat whose choice is *Show it big* shows the doorbell's camera big for a
 * minute (`DeskGrid.spotlight`), a new ring starting the minute again. Memory only, like *Try on the screen*: a restart
 * ends it. Pure but for the clock passed in.
 */
import { DESK_SPOTLIGHT_S, type DeskSpotlight, type DeskWidgetSpec } from '@whombat/core';
import type { DoorbellRing } from '../things/kinds/home/doorbell';
import type { ScreenRecord } from './widgets/types';

/** The widget the moment shows, by an id no layout uses (the editor names its own `w_n…`). */
export const SPOTLIGHT_WIDGET_ID = 'w_spotlight';

/** The doorbell's camera as a widget: the camera of the Protect connection's *Cameras*, as *Add a widget* offers it. */
export function doorbellWidget(ring: Pick<DoorbellRing, 'connectionId' | 'camera'>): DeskWidgetSpec {
  return {
    id: SPOTLIGHT_WIDGET_ID,
    type: 'panel',
    ref: `connection:${ring.connectionId}`,
    opts: { panel: 'cameras', item: ring.camera },
  };
}

/** The moment's id, from Protect's event: Back on a screen hides this one until the next ring. */
export function ringMomentId(ring: Pick<DoorbellRing, 'eventId' | 'at'>): string {
  const clean = ring.eventId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 58);
  return `ring_${clean || ring.at.getTime().toString(36)}`;
}

interface Moment {
  id: string;
  widget: DeskWidgetSpec;
  until: number;
  reason: DeskSpotlight['reason'];
}

/** Each screen's moment while it lasts. */
export class ScreenSpotlights {
  readonly #by = new Map<string, Moment>();

  /**
   * The doorbell rang: each of the burrow's screens whose choice is *Show it big* shows it until a minute from `now`.
   * Answers the screens that show it.
   */
  ring(
    ring: DoorbellRing,
    screens: readonly Pick<ScreenRecord, 'id' | 'burrowId' | 'doorbell'>[],
    now: number,
  ) {
    const moment: Moment = {
      id: ringMomentId(ring),
      widget: doorbellWidget(ring),
      until: now + DESK_SPOTLIGHT_S * 1000,
      reason: 'doorbell',
    };
    const shown: string[] = [];
    for (const screen of screens) {
      if (screen.burrowId !== ring.burrowId || screen.doorbell === 'off') continue;
      // Screens removed long ago leave their entry until it ends; far past any box's screens, start over.
      if (this.#by.size > 64 && !this.#by.has(screen.id)) this.#by.clear();
      this.#by.set(screen.id, moment);
      shown.push(screen.id);
    }
    return shown;
  }

  /** A screen's moment at `now`, as the grid carries it; null once it's over (forgotten then). */
  of(screenId: string, now: number): DeskSpotlight | null {
    const m = this.#by.get(screenId);
    if (!m) return null;
    if (m.until <= now) {
      this.#by.delete(screenId);
      return null;
    }
    return { id: m.id, widget: m.widget, until: new Date(m.until).toISOString(), reason: m.reason };
  }

  /** A screen removed, or its choice now *Don’t*: its moment ends. */
  forget(screenId: string): void {
    this.#by.delete(screenId);
  }
}

/**
 * The widgets a screen resolves: its layout's, and the moment's first so the screen's limit never leaves it out (a
 * widget of the layout with the moment's id gives way).
 */
export function withSpotlight(
  specs: readonly DeskWidgetSpec[],
  spotlight: Pick<DeskSpotlight, 'widget'> | null,
  max: number,
): DeskWidgetSpec[] {
  if (!spotlight) return specs.slice(0, max);
  return [spotlight.widget, ...specs.filter((s) => s.id !== spotlight.widget.id)].slice(0, max);
}
