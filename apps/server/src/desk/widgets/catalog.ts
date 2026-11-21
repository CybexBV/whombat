/**
 * *Add a widget* (docs/decisions/desk-display.md DK-139, DK-143; `desk.widgets`): Whombat's own, each server of the
 * fleet with its widgets, each connection's and device's widgets (`ThingWidgets.groups`), the person's own accounts
 * (`AccountWidgets.groups`, DK-159) and the widgets the assistant made for Home.
 * Pure but for what the service read.
 */
import {
  DESK_OWN_WIDGETS,
  DESK_SCREEN_WORDS,
  type DeskCatalogGroup,
  type DeskCatalogItem,
  type DeskWidgetType,
  fillDeskWords,
} from '@whombat/core';
import { SERVER_SHOW_VIEWS, SERVER_SHOWS } from '@whombat/screen';
import { calmMark } from '../calm';
import { type DeskFleet, screenText, widgetTile } from '../glance';
import { serverLine } from '../options';
import type { ScreenHomeWidget } from './home';
import { SERVER_PART_WORDS } from './server-parts';

/** A group lists at most this many (the contract's). */
const GROUP_ITEMS_MAX = 48;

/** The view each of Whombat's own draws, where it has one. */
const OWN_VIEWS: Partial<Record<DeskWidgetType, DeskCatalogItem['view']>> = {
  work: 'list',
  coming: 'list',
  done: 'list',
};

const line = (text: string | null | undefined, fallback: string) => screenText(text, 120) || fallback;

/** *Whombat and {assistant}*: the clock, the calm glance's three and the assistant's three. */
export function ownGroup(assistant: string): DeskCatalogGroup {
  const fill = (t: string) => fillDeskWords(t, { assistant });
  return {
    key: 'own',
    label: screenText(fill(DESK_SCREEN_WORDS.groups.own), 80),
    items: DESK_OWN_WIDGETS.map((type) => {
      const words = DESK_SCREEN_WORDS.own[type];
      const view = OWN_VIEWS[type];
      return {
        type,
        opts: {},
        name: screenText(fill(words.name), 60),
        line: screenText(fill(words.line), 120),
        ...(view ? { view } : {}),
      };
    }),
  };
}

/**
 * *Servers* (DK-153, DK-154): a group per server of the fleet that can be named, worst first as the fleet is (`key`
 * `server:<id>`, its name, its mark), with its widgets: its overview, then its processor, memory, network, storage,
 * virtual machines and containers (when it runs any), temperature (when it reports one) and alerts.
 */
export function serverGroups(fleet: DeskFleet | null): DeskCatalogGroup[] {
  return (fleet?.cards ?? []).flatMap((card) => {
    if (!card.id) return [];
    const row = fleet?.rows.get(card.id);
    const name = screenText(card.name, 60);
    if (!name) return [];
    const mark = calmMark(card.mark);
    const ref = `server:${card.id}` as const;
    const what = row ? serverLine(row) : '';
    const shows = SERVER_SHOWS.filter((show) => {
      if (show === 'guests') return (row?.guests ?? []).some((g) => g.total > 0);
      if (show === 'temp') return row?.temperature != null;
      return true;
    });
    const items: DeskCatalogItem[] = shows.map((show) => {
      const words = SERVER_PART_WORDS[show];
      return {
        type: 'server' as const,
        ref,
        opts: show === 'overview' ? {} : ({ show } as Record<string, string>),
        name: words.name,
        line: show === 'overview' ? line(what, words.line) : words.line,
        ...(mark ? { mark } : {}),
        view: SERVER_SHOW_VIEWS[show],
        ...(show === 'alerts' ? { private: true } : {}),
      };
    });
    return [{ key: ref, label: screenText(name, 80), ...(mark ? { mark } : {}), items }];
  });
}

/** *Made by {assistant}*: the widgets on Home, each with its value now and whether it's private. */
export function homeWidgetsGroup(
  widgets: readonly ScreenHomeWidget[],
  assistant: string,
): DeskCatalogGroup | null {
  const items: DeskCatalogItem[] = widgets.slice(0, GROUP_ITEMS_MAX).flatMap((w) => {
    const name = screenText(w.title, 60);
    if (!name) return [];
    return [
      {
        type: 'widget' as const,
        ref: `widget:${w.id}`,
        opts: {},
        name,
        line: line(widgetTile(w)?.value ?? w.subtitle, DESK_SCREEN_WORDS.figures.line),
        view: 'figures' as const,
        ...(w.private ? { private: true } : {}),
      },
    ];
  });
  if (items.length === 0) return null;
  return {
    key: 'widgets',
    label: screenText(fillDeskWords(DESK_SCREEN_WORDS.groups.widgets, { assistant }), 80),
    items,
  };
}

/**
 * The whole list in its order: Whombat's own, each server, the things, the person's accounts, Home's widgets (at most
 * the contract's 200).
 */
export function deskCatalog(input: {
  assistant: string;
  fleet: DeskFleet | null;
  things: readonly DeskCatalogGroup[];
  accounts?: readonly DeskCatalogGroup[];
  widgets: readonly ScreenHomeWidget[];
}): DeskCatalogGroup[] {
  return [
    ownGroup(input.assistant),
    ...serverGroups(input.fleet),
    ...input.things,
    ...(input.accounts ?? []),
    ...[homeWidgetsGroup(input.widgets, input.assistant)].filter((g): g is DeskCatalogGroup => g !== null),
  ].slice(0, 200);
}
