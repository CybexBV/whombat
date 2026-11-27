/**
 * The root stack's rules with two pages (docs/app/decisions/iphone-duo.md). The stack stays one stack in every shape —
 * the tabs first, what they opened on top — so folding and unfolding keep the place; with two pages the tabs are the
 * list on the left and the rest shows on the right. A list page (Servers, Connections: servers-connections-places.md)
 * right above the tabs is the list instead, the tabs waiting under it. Then:
 *
 * - Opening something from the list (or from outside: a link, a tapped notification) replaces what the right page
 *   shows, instead of piling up on it. With a list page as the list only what it opens stays beside it; anything else
 *   from outside opens beside the tabs again.
 * - Opening a list page, from anywhere, makes it the list: what was beside goes.
 * - Opening something from the right page goes on top of it there, as on a phone.
 * - Going to the tabs from the right page goes back to the list's own route rather than opening a second one.
 *
 * With one page the stack's own rules apply unchanged.
 */
import type {
  NavigationAction,
  ParamListBase,
  Router,
  RouterConfigOptions,
  StackNavigationState,
} from '@react-navigation/native';

/** The stack's first route: the tabs, which are the list with two pages. */
export const LIST_ROUTE = 'Tabs';

/** The pages that, right above the tabs, are the list with two pages: Servers and Connections. */
export const LIST_PAGES: readonly string[] = ['ServersPlace', 'ConnectionsPlace'];

/** Where the list is in the stack: 1 when a list page is right above the tabs, else 0 (the tabs themselves). */
export function listIndex(routes: readonly { name: string }[]): 0 | 1 {
  return routes[0]?.name === LIST_ROUTE && LIST_PAGES.includes(routes[1]?.name ?? '') ? 1 : 0;
}

type State = StackNavigationState<ParamListBase>;

/**
 * When the window opens to two pages with a list page somewhere higher in the stack (opened on a narrow phone from
 * Search, say), the routes that make it the list: the tabs, then that list page and what it opened. Null when the list
 * is already in its place or there is none.
 */
export function promotedList<R extends { name: string }>(routes: readonly R[]): R[] | null {
  if (routes[0]?.name !== LIST_ROUTE) return null;
  let at = -1;
  for (let i = routes.length - 1; i >= 1; i--) {
    if (LIST_PAGES.includes(routes[i]?.name ?? '')) {
      at = i;
      break;
    }
  }
  if (at < 2) return null;
  return [routes[0] as R, ...routes.slice(at)];
}

type Payload = { name?: string; params?: object; pop?: boolean } | undefined;

/**
 * The state an action from the list applies to with two pages: the list alone (what it opened gives way), the tabs
 * alone (a list page opening, or a link while a list page is the list), the same state when it asks for what the right
 * page already shows (or the list page that is the list), or null when the stack's own rules apply.
 */
export function besideBase(state: State, action: NavigationAction): State | 'same' | null {
  if (action.type !== 'NAVIGATE' && action.type !== 'PUSH') return null;
  const payload = action.payload as Payload;
  const name = payload?.name;
  if (!name || name === LIST_ROUTE || state.routes[0]?.name !== LIST_ROUTE) return null;
  if (!state.routeNames.includes(name)) return null;
  const tabsAlone = { ...state, index: 0, routes: state.routes.slice(0, 1) };
  const at = listIndex(state.routes);
  if (LIST_PAGES.includes(name)) return at === 1 && state.routes[1]?.name === name ? 'same' : tabsAlone;
  const beside = state.routes.slice(at + 1);
  if (action.source !== undefined && beside.some((r) => r.key === action.source)) return null;
  if (at === 1 && action.source !== state.routes[1]?.key) return tabsAlone;
  const shown = beside[0];
  if (beside.length === 1 && shown?.name === name && sameParams(shown.params, payload?.params)) return 'same';
  return { ...state, index: at, routes: state.routes.slice(0, at + 1) };
}

/** Going to the tabs from the right page: back to the list's route, with its params (the tab to show). */
export function toList(state: State, action: NavigationAction): NavigationAction | null {
  if (action.type !== 'NAVIGATE' || state.index === 0) return null;
  const payload = action.payload as Payload;
  if (payload?.name !== LIST_ROUTE || payload.pop) return null;
  return { ...action, payload: { ...payload, pop: true } } as NavigationAction;
}

function sameParams(a: object | undefined, b: object | undefined): boolean {
  const x = (a ?? {}) as Record<string, unknown>;
  const y = (b ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

/**
 * The options of a screen on the right page, by its place there (0 is the first). What the list opens replaces the
 * right page's first screen, and that swap shows at once, as a mail app's reading pane does: the phone's slide would
 * carry the old thread out to the left, across the list. What opens on top of it there still slides in.
 */
export function besideOptions<Options extends { animation?: string }>(
  options: Options,
  place: number,
): Options {
  return place === 0 ? { ...options, animation: 'none' } : options;
}

/** The overrides for the stack's router; `twoPages` says whether the window shows two pages right now. */
export function splitRouter<Action extends NavigationAction>(
  original: Router<State, Action>,
  twoPages: () => boolean,
): Partial<Router<State, Action>> {
  return {
    getStateForAction(state: State, action: Action, options: RouterConfigOptions) {
      if (twoPages()) {
        const base = besideBase(state, action);
        if (base === 'same') return state;
        if (base) return original.getStateForAction(base, action, options);
        const back = toList(state, action);
        if (back) return original.getStateForAction(state, back as Action, options);
      }
      return original.getStateForAction(state, action, options);
    },
  };
}
