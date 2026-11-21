/**
 * Which screens are in view, for their reads (`ScreenFocusContext` in `@whombat/client/react`): the tabs out of view and
 * the pages under the top one keep their data, but realtime frames, coming back to the app and getting online don't
 * fetch it again; a screen that shows again reads what went out of date meanwhile.
 *
 * In view: a page on top of the stack, or the tabs drawn as the left page beside it with two pages (the iPhone Duo
 * open, `SplitStack`): both pages count. A tab: the one its bar shows, while the tabs themselves are in view. Updated
 * from navigation events rather than renders, since a screen out of view is frozen and may not render.
 */
import type { NavigationState, ParamListBase } from '@react-navigation/native';
import { createScreenFocus, ScreenFocusContext } from '@whombat/client/react';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { type PaneRole, usePaneRole } from './panes';

interface Navigation {
  isFocused(): boolean;
  getState(): NavigationState<ParamListBase>;
  addListener(type: 'focus' | 'blur' | 'state', listener: () => void): () => void;
}

/**
 * Whether a screen is in view by itself (a tab: whatever the page around it). A page: on top of the stack, or the tabs
 * as the left page of two. A tab: the one its bar shows.
 */
export function screenInView(
  kind: 'page' | 'tab',
  at: {
    role: PaneRole;
    focused: boolean;
    state: Pick<NavigationState, 'index' | 'routes'>;
    routeKey: string;
  },
): boolean {
  if (kind === 'page') return at.role === 'list' || at.focused;
  return at.state.routes[at.state.index]?.key === at.routeKey;
}

export function ScreenFocusLayout({
  kind,
  navigation,
  routeKey,
  children,
}: {
  /** A page of the root stack, or a tab inside the tabs' page. */
  kind: 'page' | 'tab';
  navigation: Navigation;
  routeKey: string;
  children: ReactNode;
}) {
  const parent = useContext(ScreenFocusContext);
  const role = usePaneRole();
  const roleNow = useRef(role);
  roleNow.current = role;
  const [focus] = useState(() =>
    createScreenFocus(
      () =>
        screenInView(kind, {
          role: roleNow.current,
          // A tab's own isFocused also asks the page around it, which the parent's focus answers.
          focused: kind === 'page' && navigation.isFocused(),
          state: navigation.getState(),
          routeKey,
        }),
      parent,
    ),
  );
  useEffect(() => {
    const update = () => focus.update();
    const offs = (['focus', 'blur', 'state'] as const).map((type) => navigation.addListener(type, update));
    offs.push(focus.follow());
    return () => {
      for (const off of offs) off();
    };
  }, [focus, navigation]);
  // One page or two (the role) changes with the window, not with a navigation event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the role changes (read through a ref).
  useEffect(() => focus.update(), [focus, role]);
  return <ScreenFocusContext.Provider value={focus}>{children}</ScreenFocusContext.Provider>;
}
