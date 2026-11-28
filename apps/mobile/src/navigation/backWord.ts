/**
 * The “‹ …” of a page opened without a `back` of its own (a link, a push, a row that names none): the page under it in
 * the stack, by its name in the person's language — the tab the tabs show, Servers or Connections, a page's title — else
 * “Back”. Pure.
 */
import { listPlaceOfScreen, placeWords } from '../data/places';
import { knownTab, tabWords } from '../data/shell';
import { mobileTranslator } from '../i18n/translate';

interface StackLike {
  index?: number;
  routes: readonly { key?: string; name: string; params?: object; state?: unknown }[];
}

export function backWordUnder(state: StackLike | undefined, key: string, locale?: string | null): string {
  const tr = mobileTranslator(locale ?? undefined);
  const back = tr.t('screens2.common.back');
  if (!state) return back;
  const at = state.routes.findIndex((r) => r.key === key);
  const under = state.routes[(at < 0 ? state.routes.length : at) - 1];
  if (!under) return back;
  if (under.name === 'Tabs') {
    const tabs = under.state as StackLike | undefined;
    const asked = (under.params as { screen?: unknown } | undefined)?.screen;
    const tab = tabs?.routes[tabs.index ?? 0]?.name ?? (typeof asked === 'string' ? asked : undefined);
    return tabWords(locale ?? undefined)[knownTab(tab)];
  }
  const place = listPlaceOfScreen(under.name);
  if (place) return placeWords(locale ?? undefined)[place];
  const title = (under.params as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title ? title : back;
}
