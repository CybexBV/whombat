/**
 * The root stack's rules with two pages (docs/app/decisions/iphone-duo.md). The stack stays one stack in every shape —
 * the tabs first, what they opened on top — so folding and unfolding keep the place; with two pages the tabs are the
 * list on the left and the rest shows on the right. Then:
 *
 * - Opening something from the list (or from outside: a link, a tapped notification) replaces what the right page
 *   shows, instead of piling up on it.
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

type State = StackNavigationState<ParamListBase>;

type Payload = { name?: string; params?: object; pop?: boolean } | undefined;

/**
 * The state an action from the list applies to with two pages: the list alone (what it opened gives way), the same
 * state when it asks for what the right page already shows, or null when the stack's own rules apply.
 */
export function besideBase(state: State, action: NavigationAction): State | 'same' | null {
  if (action.type !== 'NAVIGATE' && action.type !== 'PUSH') return null;
  const payload = action.payload as Payload;
  const name = payload?.name;
  if (!name || name === LIST_ROUTE || state.routes[0]?.name !== LIST_ROUTE) return null;
  if (!state.routeNames.includes(name)) return null;
  const beside = state.routes.slice(1);
  if (action.source !== undefined && beside.some((r) => r.key === action.source)) return null;
  const shown = beside[0];
  if (beside.length === 1 && shown?.name === name && sameParams(shown.params, payload?.params)) return 'same';
  return { ...state, index: 0, routes: state.routes.slice(0, 1) };
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
