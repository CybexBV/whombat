import {
  createNavigationContainerRef,
  getActionFromState,
  getStateFromPath,
  type NavigationProp,
  useNavigation,
} from '@react-navigation/native';
import type { LinkRef } from '@whombat/core';
import { useCallback } from 'react';
import { Linking } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { UI_ORIGINS } from '../managed/config';
import { useBurrowSwitch, useManaged } from '../managed/context';
import {
  APP_SCHEME,
  appOrigins,
  appScreenUrlForPath,
  LINKING_SCREENS,
  type RootStackParamList,
  type Route,
  routeForLink,
  stripLinkedActionParams,
  urlTarget,
  webUrlForLink,
} from './routes';

export type AppNavigation = NavigationProp<RootStackParamList>;

/** The app's one navigation container, for what lives outside it (notification taps, the share bridge). */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

export function useAppNavigation(): AppNavigation {
  return useNavigation<AppNavigation>();
}

export function navigateTo(navigation: AppNavigation, route: Route): void {
  // The union is exhaustive over the stack's routes; TypeScript cannot pair name and params itself.
  (navigation.navigate as (name: string, params: unknown) => void)(route.name, route.params);
}

/** The web app's origins whose links open the app's screens (AP-709). */
export const APP_ORIGINS = appOrigins(UI_ORIGINS);

/** True when tapping `url` opens a screen of the app rather than the browser (for a link's accessibility hint). */
export function opensInApp(url: string): boolean {
  return urlTarget(url, APP_ORIGINS)?.kind === 'app';
}

type LinkingConfig = Parameters<typeof getStateFromPath>[1];

/** The navigator's linking config (`LINKING_SCREENS`). */
const linkingConfig = { screens: LINKING_SCREENS } as unknown as LinkingConfig;

/**
 * Opens an app link (`whombat://c/general`) in the navigator, as React Navigation's `useLinkTo` does, but through the
 * container's ref so it works from outside a screen too (a notification tap). Action params are stripped as for
 * every incoming link (`stripLinkedActionParams`). False when the navigator isn't up or the link names no screen.
 */
export function openAppUrl(url: string): boolean {
  if (!navigationRef.isReady()) return false;
  const path = url.replace(new RegExp(`^${APP_SCHEME}://`, 'i'), '/');
  const parsed = getStateFromPath(path, linkingConfig);
  if (!parsed) return false;
  const state = stripLinkedActionParams(parsed);
  const action = getActionFromState(state, linkingConfig);
  if (action) navigationRef.dispatch(action);
  else navigationRef.resetRoot(state as Parameters<typeof navigationRef.resetRoot>[0]);
  return true;
}

/**
 * Opens a URL someone tapped (a link in a message, a link preview, a digest item; AP-709): Whombat web links and
 * `whombat://` links open the app's screen — another burrow of this person's first, as a link from outside does
 * (`AppLinks`) — and every other web page (or a page the phone has no screen for) opens in the browser.
 */
export function useOpenUrl(): (href: string) => void {
  const { slug } = useBurrowBase();
  const managed = useManaged();
  const switchBurrow = useBurrowSwitch();
  return useCallback(
    (href: string) => {
      const target = urlTarget(href, APP_ORIGINS);
      if (!target) return;
      if (target.kind === 'system') {
        void Linking.openURL(target.url).catch(() => {});
        return;
      }
      if (target.burrow && target.burrow !== slug && managed) {
        // The next navigator (the other burrow's) takes the path; one they aren't in opens nothing new.
        if (target.path && switchBurrow?.(target.burrow)) managed.links.hold(target.path);
        else openAppUrl(`${APP_SCHEME}://inbox`);
        return;
      }
      openAppUrl(target.url);
    },
    [slug, managed, switchBurrow],
  );
}

/**
 * Open a `LinkRef` (inbox row, receipt, search result). External links have no screen: they open in the browser
 * (AP-709), an external link to the web app at its screen. A canvas opens its read-only screen where the Whombat gives
 * its text (`canvases.content`, MQ-05), else the web page in the browser. False only when nothing opens.
 */
export function useOpenLink(): (link: LinkRef, back?: string) => boolean {
  const navigation = useAppNavigation();
  // The sidebar is read when a link is opened, so a screen with links doesn't re-render for every message (AP-900).
  const { currentBootstrap, slug } = useBurrowBase();
  const openUrl = useOpenUrl();
  return useCallback(
    (link: LinkRef, back?: string) => {
      const route = routeForLink(link, currentBootstrap().sidebar, back, { deployments: true });
      if (route && (route.name !== 'Canvas' || true)) {
        navigateTo(navigation, route);
        return true;
      }
      const web = webUrlForLink(link, slug, APP_ORIGINS[0] ?? 'https://app.whombat.com');
      if (!web) return false;
      // A canvas's page straight to the browser: `openUrl` would bring a Whombat link back to the canvas screen.
      if (link.type === 'canvas') void Linking.openURL(web).catch(() => {});
      else openUrl(web);
      return true;
    },
    [navigation, currentBootstrap, slug, openUrl],
  );
}

/**
 * Opens an app path of the one-Whombat shell (contracts 0.80 `HomeHref`: `/things/server%3Apve-02`, `/chats/cnv_…`,
 * `/chat?thread=msg_…`, `/watch`, `/automations/aut_…`; AP-1351) at its screen; a path the phone has no screen for
 * opens Connections (AP-2550).
 */
export function openHref(href: string): boolean {
  return openAppUrl(appScreenUrlForPath(href) ?? `${APP_SCHEME}://connected`);
}
