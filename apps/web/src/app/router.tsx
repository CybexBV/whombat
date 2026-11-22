/**
 * Routes (ARCHITECTURE "Web app"). Every screen is deep-linkable; panes and modals are URL state. Burrow screens have
 * no burrow in the path (ui-improvements L, AP-360…): the open burrow is the session's (managed: the open appliance's;
 * self-hosted: remembered per tab and browser, else the first membership; `routing/currentBurrow.ts`).
 *
 *   /mobile  /brand (logo package, unlinked)
 *   /onboarding                     ?burrow=&step= (resume)
 *   /connect-ai                     the claim's last step, Connect your AI (Whombat first-day.md), then /
 *   /                               → /chat (chat-channel.md AP-2401)
 *   /chat  /feedback                Chat and the Feedback room (AP-2401) ?thread=<msgId> (beside it) ?settled=1 (the
 *                                   settled threads, AP-6252)
 *   /code                           → /chat, the query kept: the old address of software work, which is Chat's now
 *   /connections                    Connections (the Dashboard before, connections-page.md AP-2501): Needs you, Servers,
 *                                   Services, Pinned; ?add=1 Add a server (and its sign-in fields, AP-2523)
 *   /dashboard                      → /connections, the query kept (AP-2501)
 *   /watch                          Watch (AP-1259)
 *   /chats  /chats/:id  /chats/new  old chat addresses → /chat or /feedback (AP-2403)
 *   /things/:thing                  a server, connection or device (`server:pve-02`; the things screens, AP-1258);
 *                                   /things/servers?view=guests every guest of every server, /things/servers otherwise
 *                                   → /connections with its query (CN-09, AP-2523)
 *   /skills                         → /settings?tab=skills (AP-2305, hermes-skills.md AP-5530)
 *   /done                           Everything Whombat did, with Undo (AP-1263)
 *   /pr/:number                     ?repo=owner/name (several repos can have a PR #1; AP-496)  ?tab=files
 *                                   ?thread=<msgId>[&focus=1]  ?plan=…&step=…
 *   /runs/:number
 *   /inbox                          ?item=<id> (the Inbox, inbox.md IBX-01); /needs-you and /watch → /inbox
 *   /deploys                        the environments board and the history (work-removal.md AP-850; was WE-17's tab)
 *   /work  /work/deploys            the Work view's old addresses (AP-851): /work[?section=] → /inbox,
 *                                   /work/deploys → /deploys (`workPath`)
 *   /canvases  /canvases/:slug
 *   /log                            ?actor=&kind=&who=&open=
 *   /search                         ?q=&type=
 *   /automations                    /automations/:id
 *   /vault                          ?entry=<vlt_…> (an open entry; AP-671, was /settings?tab=vault)
 *   /files                          the conversations with files (files-space.md AP-773)
 *   /files/dm/chat|feedback  /files/direct/:id  /files/pr/:number[?repo=]
 *                                   one conversation's Files, ?folder=A/B (AP-774)
 *   /automation-runs/:number
 *   /settings/agent                 → /settings?tab=agent, `?part=` and `?key=` kept (the agent's link, AgentLink;
 *                                   AP-4922); its old Skills part → /settings?tab=skills (AP-5530)
 *   /settings                       the home (Often used, the five groups) · ?part=profile|notifications|… (You) ·
 *                                   ?tab=notifications · ?tab=agent [&part=] (AP-4923) ·
 *                                   ?tab=skills (AP-5530) · ?tab=ai
 *                                   · ?tab=connections [&connection=github|google|feedback] · ?tab=screen
 *                                   [&part=lock|night|talk] (the box's own screen) · ?tab=appliance (This
 *                                   Whombat; SS-01) [&section=backups|devices|access|about] (its parts, AP-1221); the
 *                                   tabs from before redirect (SS-02, `settingsRedirect`)
 *   /settings/screens/:id/layout    a screen's layout editor (Whombat desk-display.md DK-143, AP-5950)
 *   /settings/feedback/new          ?step=reports|widget (New integration, AP-400)
 *   /settings/feedback/:id          ?step=install (right after Create) — an integration's page
 *   any burrow page                 ?approval=<number> (approval modal)
 *                                   ?burrow=<slug>: open that burrow (a member's), then the same page without it
 *   /<burrow>/<any of the above>    the old form (every link the servers make): switches to <burrow> when the person
 *                                   belongs to it and replaces the address with /<rest>, search and hash kept;
 *                                   otherwise Not found. A path that is a burrow screen as it stands is never the old
 *                                   form (`/inbox` is the Inbox); `/inbox/c/general` is (AP-362, `splitBurrowPath`).
 *
 * In managed mode `ManagedRoot` owns its own paths first (`/auth/verify`, `/appliances…`, `/claim`, `/connect/google`,
 * `/billing`, `/signup`, `/waitlist`, `/invitations/accept`, `/account/delete`, `/legal/…`); every other path is this
 * router's.
 *
 * Screens live in `src/features/<feature>/` and take plain props, so a feature can be replaced
 * without touching this file.
 */
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  lazyRouteComponent,
  notFound,
  Outlet,
  type RouterHistory,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import {
  chatRedirectPath,
  chatRoomsOf,
  isAdvancedPart,
  isAgentGroupPart,
  isYouPart,
  splitBurrowPath,
  workPath,
} from '@whombat/client';
import { CONNECTIONS_HREF } from '@whombat/core';
import type { ReactNode } from 'react';
import { validateAgentKey, validateAgentPart } from '../features/agent/parts';
import { validateScreenPart } from '../features/desk/screenTab';
import { validateFeedbackIntegrationSearch, validateFeedbackNewSearch } from '../features/feedback/search';
import { AuthLayout } from './auth/AuthLayout';
import loginStyles from './auth/AuthLayout.module.css';
import { fixtureMode } from './fixtureMode';
import { chooseBurrow } from './routing/currentBurrow';
import { useSearchUpdate } from './routing/navigation';
import { useOpenBurrow } from './routing/openBurrow';
import {
  currentSettingsTab,
  currentWhombatPart,
  settingsHome,
  settingsRedirect,
  validateAutomationsSearch,
  validateBranchSearch,
  validateBurrowSearch,
  validateConversationSearch,
  validateFilesSearch,
  validateLogSearch,
  validateOnboardingSearch,
  validateRoomSearch,
  validateSearchSearch,
  validateSettingsSearch,
  validateVaultSearch,
} from './routing/search';
import type { AppServices } from './services';
import { BurrowShell } from './shell/BurrowShell';
import { firstRoom, warmBurrow } from './shell/firstReads';
import { INBOX_PATH } from './shell/location';
import { ShellPending } from './shell/ShellLayout';

export interface RouterContext {
  services: AppServices;
}

/* Screens ---------------------------------------------------------------------------------------

Every screen is in its feature's own chunk (docs/decisions/web-efficiency.md WE-01): the router loads it with its route
(and on hover, `defaultPreload: 'intent'`), so a screen never suspends the page it replaces. `withScreens` gives a route
component the screens' `preload` (TanStack Router awaits a route component's `preload` before rendering it). */

const BranchRoomScreen = lazyRouteComponent(
  () => import('../features/branch/BranchRoomScreen'),
  'BranchRoomScreen',
);
const RunScreen = lazyRouteComponent(() => import('../features/runs/RunScreen'), 'RunScreen');
const DeploysScreen = lazyRouteComponent(() => import('../features/deploys/DeploysScreen'), 'DeploysScreen');
const CanvasesScreen = lazyRouteComponent(
  () => import('../features/canvas/CanvasesScreen'),
  'CanvasesScreen',
);
const CanvasScreen = lazyRouteComponent(() => import('../features/canvas/CanvasScreen'), 'CanvasScreen');
const AuditLogScreen = lazyRouteComponent(() => import('../features/audit/AuditLogScreen'), 'AuditLogScreen');
const SettingsScreen = lazyRouteComponent(
  () => import('../features/settings/SettingsScreen'),
  'SettingsScreen',
);
const ScreenEditorPage = lazyRouteComponent(
  () => import('../features/screens/editor/ScreenEditor'),
  'ScreenEditorPage',
);
// Through fixture mode's door: a production build has no fake box to play a screen on, so the page draws nothing there
// and ships none of the mock world.
const FixtureScreenMode = lazyRouteComponent(async () => {
  const mode = await fixtureMode?.screenMode();
  return { FixtureScreenMode: mode?.FixtureScreenMode ?? NoFixtureScreen };
}, 'FixtureScreenMode');
function NoFixtureScreen(_: { as?: string | undefined }) {
  return null;
}
const FeedbackNewIntegrationPage = lazyRouteComponent(
  () => import('../features/feedback/IntegrationPages'),
  'FeedbackNewIntegrationPage',
);
const FeedbackIntegrationPage = lazyRouteComponent(
  () => import('../features/feedback/IntegrationPages'),
  'FeedbackIntegrationPage',
);
const SearchScreen = lazyRouteComponent(() => import('../features/search/SearchScreen'), 'SearchScreen');
const VaultScreen = lazyRouteComponent(() => import('../features/vault/VaultScreen'), 'VaultScreen');
const FilesScreen = lazyRouteComponent(() => import('../features/files/FilesScreen'), 'FilesScreen');
const FilesSpaceScreen = lazyRouteComponent(
  () => import('../features/files/FilesSpaceScreen'),
  'FilesSpaceScreen',
);
const AutomationsScreen = lazyRouteComponent(
  () => import('../features/automations/AutomationsScreen'),
  'AutomationsScreen',
);
const AutomationScreen = lazyRouteComponent(
  () => import('../features/automations/AutomationScreen'),
  'AutomationScreen',
);
const AutomationRunScreen = lazyRouteComponent(
  () => import('../features/automations/AutomationRunScreen'),
  'AutomationRunScreen',
);
const HomeScreen = lazyRouteComponent(() => import('../features/home/HomeScreen'), 'HomeScreen');
const NeedsYouScreen = lazyRouteComponent(
  () => import('../features/needsYou/NeedsYouScreen'),
  'NeedsYouScreen',
);
const ConnectionsPages = lazyRouteComponent(
  () => import('../features/settings/ConnectionsPages'),
  'ConnectionsPages',
);
const DoneScreen = lazyRouteComponent(() => import('../features/home/DoneScreen'), 'DoneScreen');
const ChatRoomScreen = lazyRouteComponent(() => import('../features/chats/ChatRoomScreen'), 'ChatRoomScreen');
const ThingScreen = lazyRouteComponent(() => import('../features/things/ThingScreen'), 'ThingScreen');
// The Skills page of a Whombat without the skill library (AP-1261, AP-2305).
const BrandPage = lazyRouteComponent(() => import('./pages/brand/BrandPage'), 'BrandPage');
const MobileInfoPage = lazyRouteComponent(() => import('./pages/MobileInfoPage'), 'MobileInfoPage');
const OnboardingScreen = lazyRouteComponent(
  () => import('../features/onboarding/OnboardingScreen'),
  'OnboardingScreen',
);
const ConnectAiScreen = lazyRouteComponent(
  () => import('../features/first-day/ConnectAiScreen'),
  'ConnectAiScreen',
);

/** `component` with the `preload` of the lazy screens it renders. */
function withScreens<C extends (props: never) => ReactNode>(
  screens: readonly { preload?: () => Promise<void> | undefined }[],
  component: C,
): C & { preload: () => Promise<void> } {
  return Object.assign(component, {
    preload: async () => {
      await Promise.all(screens.map((screen) => screen.preload?.()));
    },
  });
}

/**
 * Who this is and their burrows (`me.get`): the session's account. A box admits only enrolled devices, so there is no
 * signed-out page here — a session that can't be had is the root's to say (hermes-engine-app.md AP-5321).
 */
function requireSession({ services }: RouterContext, _href?: string) {
  return services.queryClient.ensureQueryData(services.queries.me.get());
}

function loadBootstrap({ services }: RouterContext, burrow: string) {
  return services.queryClient.ensureQueryData(
    services.queries.conversations.bootstrap({ params: { burrow } }),
  );
}

function parseNumberParam(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

/* Root ------------------------------------------------------------------------------------------ */

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  validateSearch: validateOnboardingSearch,
  beforeLoad: async ({ context, location }) => ({
    session: await requireSession(context, location.href),
  }),
  component: withScreens([OnboardingScreen], function OnboardingRoute() {
    const navigate = useNavigate();
    const { burrow, step } = onboardingRoute.useSearch();
    const { session } = onboardingRoute.useRouteContext();
    return (
      <OnboardingScreen
        personName={session.account.name}
        onDone={(burrow) => navigate({ to: '/', search: { burrow } })}
        onSkip={() => navigate({ to: '/' })}
        resumeBurrow={burrow}
        resumeStep={step}
      />
    );
  }),
});

/**
 * Connect your AI (Whombat first-day.md): the claim's last step, where the hosted claim and the box's setup go next;
 * outside the shell, as the claim's other steps are. Without a burrow there is nothing to connect yet: on to the
 * Whombat (on the box's page its onboarding asks Set up your AI there).
 */
const connectAiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connect-ai',
  beforeLoad: async ({ context, location }) => {
    const session = await requireSession(context, location.href);
    const burrow = chooseBurrow(session.memberships, context.services.burrowMemory.get());
    if (!burrow) throw redirect({ to: '/', replace: true });
    // On the box's own page this step ends the box's setup: it carries on that count.
    const page = context.services.managed?.page;
    const afterBoxSetup =
      page?.kind === 'box'
        ? {
            atAddress: page.atAddress ?? false,
            fromLink: page.fromLink ?? false,
            knowsAccount: page.knowsAccount ?? false,
          }
        : null;
    return { burrow, afterBoxSetup };
  },
  component: withScreens([ConnectAiScreen], function ConnectAiRoute() {
    const navigate = useNavigate();
    const { burrow, afterBoxSetup } = connectAiRoute.useRouteContext();
    return (
      <ConnectAiScreen
        burrow={burrow}
        afterBoxSetup={afterBoxSetup}
        onDone={() => navigate({ to: '/', replace: true })}
      />
    );
  }),
});

/**
 * `/mobile`: with a Whombat open it is Settings → Phone app, inside the app (settings-phone-link.md SPL-23); its own page
 * in the sign-in frame stays for where there is none (fixture mode signed out, the self-hosted server; ManagedRoot has
 * its own for a box's account without a Whombat open).
 */
const mobileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mobile',
  beforeLoad: ({ context }) => {
    if (context.services.managed)
      throw redirect({ to: '/settings', search: { tab: 'phone' }, replace: true } as never);
  },
  component: withScreens([MobileInfoPage], function MobileRoute() {
    return <MobileInfoPage />;
  }),
});

/**
 * A device as a screen in fixture mode (desk-display-web.md AP-5966): the screen page on the page's fake box, which a
 * box's own page and the hosted app open before anyone is signed in (`ScreenModeRoot`).
 */
const useAsScreenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/use-as-screen',
  validateSearch: (raw: Record<string, unknown>): { as?: string } =>
    typeof raw.as === 'string' && /^[a-z]{1,20}$/.test(raw.as) ? { as: raw.as } : {},
  component: withScreens([FixtureScreenMode], function UseAsScreenRoute() {
    const { as } = useAsScreenRoute.useSearch();
    return <FixtureScreenMode as={as} />;
  }),
});

const brandRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/brand',
  component: withScreens([BrandPage], function BrandRoute() {
    return <BrandPage />;
  }),
});

/* Burrow ---------------------------------------------------------------------------------------- */

/**
 * The session and, when `slug` isn't among its memberships, the session asked again: the cached one may predate the
 * membership (a burrow just created in onboarding, an invite just accepted). Null when the person isn't a member.
 */
async function sessionWithMember(context: RouterContext, href: string, slug: string) {
  let session = await requireSession(context, href);
  const member = (s: typeof session) => s.memberships.some((m) => m.burrowSlug === slug);
  if (member(session)) return session;
  const { services } = context;
  session = await services.queryClient.fetchQuery({ ...services.queries.me.get(), staleTime: 0 });
  return member(session) ? session : null;
}

/** `?burrow=` as the search parser left it (an all-digit slug comes back as a number). */
function burrowParam(search: Record<string, unknown>): string | null {
  const v = search.burrow;
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * Every burrow screen (no path of its own, AP-360): picks the open burrow (AP-361) and puts it in the route context.
 * `?burrow=<slug>` switches to that burrow and is taken out of the address (replace).
 */
const burrowRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_burrow',
  validateSearch: validateBurrowSearch,
  beforeLoad: async ({ context, location }) => {
    const { burrowMemory } = context.services;
    const asked = burrowParam(location.search as Record<string, unknown>);
    if (asked !== null) {
      if (!(await sessionWithMember(context, location.href, asked))) throw notFound();
      burrowMemory.set(asked);
      const { burrow: _, ...rest } = location.search as Record<string, unknown>;
      throw redirect({
        to: location.pathname,
        search: rest,
        hash: location.hash || undefined,
        replace: true,
      } as never);
    }
    const remembered = burrowMemory.get();
    // The remembered burrow's first reads and Chat's code go out beside the account's (open-speed.md AP-4404, AP-4405).
    if (remembered) warmBurrow(context.services, remembered, location.pathname);
    if (firstRoom(location.pathname)) void ChatRoomScreen.preload?.();
    const session = await requireSession(context, location.href);
    let burrow = chooseBurrow(session.memberships, remembered);
    if (remembered && burrow !== remembered) {
      // Remembered but not in the cached memberships: ask again once, then forget it if it is really gone.
      const fresh = await sessionWithMember(context, location.href, remembered);
      if (fresh) burrow = remembered;
      else burrowMemory.set(null);
    }
    if (!burrow) throw redirect({ to: '/onboarding' });
    // The one opened is remembered, so the next open can ask its reads at once (AP-4404).
    if (burrow !== burrowMemory.get()) burrowMemory.set(burrow);
    warmBurrow(context.services, burrow, location.pathname);
    return { burrow };
  },
  loader: ({ context }) => loadBootstrap(context, context.burrow),
  pendingComponent: ShellPending,
  // The skeleton has the shell's own shape, so the shell replaces it as soon as it is loaded; the router's default
  // held it for at least half a second once shown, on exactly the slow opens (AP-4407).
  pendingMinMs: 0,
  component: BurrowShell,
});

/**
 * The old form, `/<burrow>/<rest>` (AP-363): what every link the servers make looks like. A burrow the person belongs
 * to is opened and the address becomes `/<rest>` (replace), search and hash kept; anything else is Not found. The
 * router tries the burrow-less routes first, so this only sees paths none of them is.
 */
const oldFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  beforeLoad: async ({ context, location }) => {
    const split = splitBurrowPath(location.pathname);
    if (split?.form !== 'old') throw notFound();
    if (!(await sessionWithMember(context, location.href, split.burrow))) throw notFound();
    context.services.burrowMemory.set(split.burrow);
    throw redirect({
      href: `${split.path}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`,
      replace: true,
    });
  },
  component: () => null,
});

/** `/`: Chat (Whombat chat-channel.md CHT-21; AP-2401), what opens first. A burrow-wide `?approval=` stays. */
const burrowIndexRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: '/',
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/chat${location.searchStr}`, replace: true });
  },
  component: () => null,
});

/** Connections (Whombat connections-page.md CN-01, CN-03; AP-2501): Needs you, Servers, Services and what was pinned. */
const connectionsRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'connections',
  component: withScreens([HomeScreen, ConnectionsPages], function ConnectionsRoute() {
    const burrow = useOpenBurrow();
    // Add a connection and a connection's own pages are the Connections page's (settings-groups.md).
    const raw = useLocation({ select: (l) => l.search as Record<string, unknown> });
    const pages = raw.connection || raw.connected || raw.connect_error;
    if (pages)
      return (
        <ConnectionsPages burrow={burrow} search={validateSettingsSearch({ ...raw, tab: 'connections' })} />
      );
    return <HomeScreen burrow={burrow} />;
  }),
});

/** The Dashboard's address, in older messages and bookmarks: Connections, the query and the anchor kept (AP-2501). */
const dashboardRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'dashboard',
  beforeLoad: ({ location }) => {
    throw redirect({
      href: `${CONNECTIONS_HREF}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`,
      replace: true,
    });
  },
  component: () => null,
});

/** Chat (CHT-01, CHT-02; AP-2404): the person's room with their assistant, every question a thread beside it. */
const chatRoomRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'chat',
  validateSearch: validateRoomSearch,
  component: withScreens([ChatRoomScreen], function ChatRoomRoute() {
    const burrow = useOpenBurrow();
    return <ChatRoomScreen key="chat" burrow={burrow} room="chat" />;
  }),
});

/**
 * Code's old address, in older messages, pushes and bookmarks: software work is in Chat, so its thread and its Settled
 * open there (`?thread=`, `?settled=1` kept).
 */
const codeRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'code',
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/chat${location.searchStr}`, replace: true });
  },
  component: () => null,
});

/** The Feedback room (CHT-03; AP-2410): website reports and assessing automations, each a thread. */
const feedbackRoomRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'feedback',
  validateSearch: validateRoomSearch,
  component: withScreens([ChatRoomScreen], function FeedbackRoomRoute() {
    const burrow = useOpenBurrow();
    return <ChatRoomScreen key="feedback" burrow={burrow} room="feedback" />;
  }),
});

/**
 * An old chat address (`/chats`, `/chats/<id>`, `/chats/new`; CHT-21, AP-2403): the Feedback room's id to `/feedback`,
 * anything else to `/chat`, a `?thread=` with it.
 */
async function chatsRedirect(
  context: RouterContext & { burrow: string },
  id: string | null,
  thread: unknown,
): Promise<void> {
  await loadBootstrap(context, context.burrow);
  const { services } = context;
  const list = id
    ? await services.queryClient
        .ensureQueryData(services.queries.chats.list({ params: { burrow: context.burrow }, query: {} }))
        .catch(() => null)
    : null;
  const rooms = chatRoomsOf(list?.chats);
  throw redirect({
    href: chatRedirectPath(rooms, id, typeof thread === 'string' && thread ? thread : null),
    replace: true,
  });
}

/**
 * The Inbox (inbox.md IBX-01; needs-you-list.md NYL-01, NYL-05): the one list of what needs the person, in its groups;
 * `?item=` marks one (a push, a link). The sidebar's Inbox row opens it.
 */
const inboxRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'inbox',
  component: withScreens([NeedsYouScreen], function InboxRoute() {
    const burrow = useOpenBurrow();
    return <NeedsYouScreen burrow={burrow} />;
  }),
});

/**
 * The Inbox's older addresses: Needs you's (`NEEDS_YOU_HREF`, which pushes, links and older phones still name) and
 * Watch's (ONE-07), with the item they name.
 */
const needsYouRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'needs-you',
  beforeLoad: ({ location }) => {
    throw redirect({ href: `${INBOX_PATH}${location.searchStr}`, replace: true });
  },
  component: () => null,
});

const watchRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'watch',
  beforeLoad: ({ location }) => {
    throw redirect({ href: `${INBOX_PATH}${location.searchStr}`, replace: true });
  },
  component: () => null,
});

/** Everything Whombat did (ONE-08; AP-1263): Done recently's whole list, with Undo. */
const doneRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'done',
  component: withScreens([DoneScreen], function DoneRoute() {
    const burrow = useOpenBurrow();
    return <DoneScreen burrow={burrow} />;
  }),
});

/** The old list of every chat (HR-21; home-redesign.md AP-2215): Chat. */
const chatsRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'chats',
  beforeLoad: ({ context }) => chatsRedirect(context, null, null),
  component: () => null,
});

/** An old task chat (ONE-06; AP-1260), `new` too: Chat or Feedback (AP-2403). */
const chatRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'chats/$id',
  params: {
    parse: (p) => {
      if (p.id !== 'new' && !/^cnv_[A-Za-z0-9_-]{1,76}$/.test(p.id)) throw notFound();
      return { id: p.id };
    },
    stringify: (p) => ({ id: p.id }),
  },
  validateSearch: validateConversationSearch,
  beforeLoad: ({ context, params, search }) =>
    chatsRedirect(context, params.id === 'new' ? null : params.id, search.thread),
  component: () => null,
});

/**
 * A server, connection or device (AP-1258); the things screens are stream WT's (`features/things`). The servers list
 * is part of Connections (CN-09; AP-2523): `/things/servers` goes there with its query (Add a server and its fields),
 * except the view of every guest (`?view=guests`).
 */
const thingRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'things/$thing',
  beforeLoad: ({ params, location }) => {
    const search = location.search as Record<string, unknown>;
    if (params.thing === 'servers' && search.view !== 'guests')
      throw redirect({ href: `${CONNECTIONS_HREF}${location.searchStr}`, replace: true });
  },
  component: withScreens([ThingScreen], function ThingRoute() {
    const burrow = useOpenBurrow();
    const { thing } = thingRoute.useParams();
    return <ThingScreen key={thing} burrow={burrow} thing={thing} />;
  }),
});

/**
 * Skills was a page of its own (AP-1261), then a Settings tab (Whombat all-skills.md SK-16, AP-2305), the agent's in
 * Settings → Agent (one-agent.md AP-4922), and is Settings' own tab again (hermes-skills.md HSK-12, AP-5530): old links,
 * bookmarks and the phone's text open it there, anchor kept.
 */
const skillsRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'skills',
  beforeLoad: ({ location }) => {
    throw redirect({
      to: '/settings',
      search: { tab: 'advanced', part: 'skills' },
      hash: location.hash,
      replace: true,
    } as never);
  },
});

const prRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'pr/$number',
  params: {
    parse: (p) => ({ number: parseNumberParam(p.number) }),
    stringify: (p) => ({ number: String(p.number) }),
  },
  validateSearch: validateBranchSearch,
  component: withScreens([BranchRoomScreen], function PrRoute() {
    const burrow = useOpenBurrow();
    const { number } = prRoute.useParams();
    const { repo, tab, thread, file } = prRoute.useSearch();
    const updateSearch = useSearchUpdate();
    return (
      <BranchRoomScreen
        key={`${repo ?? ''}#${number}`}
        burrow={burrow}
        number={number}
        repo={repo}
        tab={tab ?? 'conversation'}
        file={file}
        threadId={thread}
        onTabChange={(next) =>
          updateSearch((s) => ({ ...s, tab: next === 'files' ? 'files' : undefined, file: undefined }), {
            replace: true,
          })
        }
      />
    );
  }),
});

const runRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'runs/$number',
  params: {
    parse: (p) => ({ number: parseNumberParam(p.number) }),
    stringify: (p) => ({ number: String(p.number) }),
  },
  component: withScreens([RunScreen], function RunRoute() {
    const burrow = useOpenBurrow();
    const { number } = runRoute.useParams();
    return <RunScreen key={number} burrow={burrow} number={number} />;
  }),
});

/**
 * The Work view's old addresses (work-removal.md AP-851): there is no Work view any more, so `/work` opens the Inbox
 * (`?section=needs_you` its Needs you) and `/work/deploys` opens Deploys, replacing the address. Links in old messages,
 * emails and pushes, and the servers' `{ type: 'work' }` links, keep working (`workPath`, shared with the phone).
 */
const workRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'work',
  beforeLoad: ({ location }) => {
    throw redirect({ href: workPath((location.search as Record<string, unknown>).section), replace: true });
  },
});

const workDeploysRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'work/deploys',
  beforeLoad: () => {
    throw redirect({ href: workPath('deploys'), replace: true });
  },
});

/** Deploys (work-removal.md AP-850; web-efficiency.md WE-17): what runs where, and every recorded deploy. */
const deploysRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'deploys',
  component: withScreens([DeploysScreen], function DeploysRoute() {
    const burrow = useOpenBurrow();
    return <DeploysScreen burrow={burrow} />;
  }),
});

/**
 * The agent's own address (`AgentLink`, `/settings/agent`): Settings → Agent, a part (`?part=`) and a key row (`?key=`,
 * a skill's “Turn on …”) kept (one-agent.md AP-4922).
 */
const settingsAgentRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'settings/agent',
  beforeLoad: ({ location }) => {
    const search = location.search as Record<string, unknown>;
    // Skills was one of its parts: it is Settings' own tab again (AP-5530).
    if (search.part === 'skills')
      throw redirect({
        to: '/settings',
        search: { tab: 'advanced', part: 'skills' },
        replace: true,
      } as never);
    const part = validateAgentPart(search.part);
    const key = validateAgentKey(search.key);
    throw redirect({
      to: '/settings',
      search: { tab: 'agent', ...(part ? { part } : {}), ...(key ? { key } : {}) },
      replace: true,
    } as never);
  },
});

const canvasesRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'canvases',
  component: withScreens([CanvasesScreen], function CanvasesRoute() {
    const burrow = useOpenBurrow();
    return <CanvasesScreen burrow={burrow} />;
  }),
});

const canvasRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'canvases/$slug',
  component: withScreens([CanvasScreen], function CanvasRoute() {
    const burrow = useOpenBurrow();
    const { slug } = canvasRoute.useParams();
    return <CanvasScreen key={slug} burrow={burrow} slug={slug} />;
  }),
});

const logRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'log',
  validateSearch: validateLogSearch,
  component: withScreens([AuditLogScreen], function LogRoute() {
    const burrow = useOpenBurrow();
    const search = logRoute.useSearch();
    const updateSearch = useSearchUpdate();
    return (
      <AuditLogScreen
        burrow={burrow}
        actor={search.actor ?? 'everyone'}
        kind={search.kind ?? 'all'}
        who={search.who}
        open={search.open}
        onChange={(next) =>
          updateSearch(
            (s) =>
              validateLogSearch({
                ...s,
                ...next,
              }) as Record<string, unknown>,
            { replace: !('who' in next) },
          )
        }
      />
    );
  }),
});

const settingsRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'settings',
  validateSearch: validateSettingsSearch,
  // The tabs from before SS-01 open where their content is now, in place of the old entry (SS-02); the Vault was a
  // Settings tab too: its links (agents' messages, older clients) open its page (AP-671).
  beforeLoad: ({ search, location }) => {
    const next = settingsRedirect(search, location.hash);
    if (next) throw redirect({ to: next.to, search: next.search, hash: next.hash, replace: true } as never);
  },
  component: withScreens([SettingsScreen], function SettingsRoute() {
    const burrow = useOpenBurrow();
    const search = settingsRoute.useSearch();
    const { tab, section, part, key, screen } = search;
    const hash = useLocation({ select: (l) => l.hash });
    const navigate = useNavigate();
    const updateSearch = useSearchUpdate();
    const current = currentSettingsTab(tab);
    const whombatPart = currentWhombatPart(section);
    return (
      <SettingsScreen
        burrow={burrow}
        home={settingsHome(search, hash)}
        tab={current}
        youPart={current === 'you' && isYouPart(part) ? part : undefined}
        agentPart={current === 'agent' && isAgentGroupPart(part) ? part : undefined}
        advancedPart={current === 'advanced' && isAdvancedPart(part) ? part : undefined}
        // A part's address is replaced, like the tabs'.
        // You's first part stays named: `/settings` alone is the home.
        onPartChange={(next) =>
          void updateSearch((s) => ({ tab: s.tab, part: next === 'profile' && s.tab ? undefined : next }), {
            replace: true,
          })
        }
        agentKey={key}
        section={whombatPart}
        // This Whombat's parts (this-whombat-sections.md AP-1221, AP-1233): the address is replaced, the hash only kept
        // when a step asks for a place in the part (“Set up backups” → `#set-up`).
        onSectionChange={(next, hash) =>
          void updateSearch((s) => ({ tab: s.tab, section: next === 'overview' ? undefined : next }), {
            replace: true,
            hash,
          })
        }
        screenPart={
          current === 'appliance' && whombatPart === 'screen' ? validateScreenPart(part) : undefined
        }
        // Screen's parts: the address is replaced, as This Whombat's.
        onScreenPartChange={(next) =>
          void updateSearch((s) => ({ ...s, part: next === 'shows' || next === 'bar' ? undefined : next }), {
            replace: true,
          })
        }
        // Screens (3.6): a screen's page is a step the browser's Back undoes; the editor a page of its own.
        {...(screen ? { screen } : {})}
        onScreenChange={(next) => void updateSearch((s) => ({ ...s, screen: next, part: undefined }))}
        onEditLayout={(next) =>
          void navigate({ to: '/settings/screens/$id/layout', params: { id: next } } as never)
        }
      />
    );
  }),
});

/**
 * Settings → Screens → a screen → *Edit layout* (Whombat desk-display.md DK-143; desk-display-web.md AP-5950): the
 * editor, a page of its own; *‹ Screens* goes back to the list.
 */
const screenLayoutRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'settings/screens/$id/layout',
  params: {
    parse: (p) => {
      if (!/^(box|out_[a-z0-9-]{1,40}|scr_[A-Za-z0-9_-]{8,40})$/.test(p.id)) throw notFound();
      return { id: p.id };
    },
    stringify: (p) => ({ id: p.id }),
  },
  component: withScreens([ScreenEditorPage], function ScreenLayoutRoute() {
    const burrow = useOpenBurrow();
    const { id } = screenLayoutRoute.useParams();
    const navigate = useNavigate();
    return (
      <ScreenEditorPage
        key={id}
        burrow={burrow}
        id={id}
        onBack={() => void navigate({ to: '/settings', search: { tab: 'screen' } } as never)}
      />
    );
  }),
});

/** Settings → Connections → Website feedback's pages (AP-400, SS-05): New integration in steps, and an integration's own page. */
const feedbackNewRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'settings/feedback/new',
  validateSearch: validateFeedbackNewSearch,
  component: withScreens([FeedbackNewIntegrationPage], function FeedbackNewRoute() {
    const burrow = useOpenBurrow();
    const { step } = feedbackNewRoute.useSearch();
    const updateSearch = useSearchUpdate();
    return (
      <FeedbackNewIntegrationPage
        burrow={burrow}
        step={step ?? 'site'}
        onStepChange={(next, options) =>
          updateSearch((s) => ({ ...s, step: next === 'site' ? undefined : next }), options)
        }
      />
    );
  }),
});

const feedbackIntegrationRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'settings/feedback/$id',
  params: {
    parse: (p) => {
      if (!/^fbi_[A-Za-z0-9_-]{1,76}$/.test(p.id)) throw notFound();
      return { id: p.id };
    },
    stringify: (p) => ({ id: p.id }),
  },
  validateSearch: validateFeedbackIntegrationSearch,
  component: withScreens([FeedbackIntegrationPage], function FeedbackIntegrationRoute() {
    const burrow = useOpenBurrow();
    const { id } = feedbackIntegrationRoute.useParams();
    const { step } = feedbackIntegrationRoute.useSearch();
    return <FeedbackIntegrationPage key={id} burrow={burrow} id={id} setup={step === 'install'} />;
  }),
});

const searchRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'search',
  validateSearch: validateSearchSearch,
  component: withScreens([SearchScreen], function SearchRoute() {
    const burrow = useOpenBurrow();
    const { q, type, from, in: inId, after, before } = searchRoute.useSearch();
    const updateSearch = useSearchUpdate();
    return (
      <SearchScreen
        burrow={burrow}
        q={q ?? ''}
        type={type ?? 'all'}
        filters={{ from, in: inId, after, before }}
        onChange={(next) =>
          updateSearch((s) => validateSearchSearch({ ...s, ...next }) as Record<string, unknown>, {
            replace: true,
          })
        }
      />
    );
  }),
});

/** The Vault (docs/decisions/vault.md; a page of its own since AP-671). */
const vaultRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'vault',
  validateSearch: validateVaultSearch,
  component: withScreens([VaultScreen], function VaultRoute() {
    const burrow = useOpenBurrow();
    const { entry, add } = vaultRoute.useSearch();
    const updateSearch = useSearchUpdate();
    return (
      <VaultScreen
        burrow={burrow}
        entry={entry}
        onEntryChange={(next) => updateSearch((s) => ({ ...s, entry: next }), { replace: true })}
        adding={!!add}
        onAddingChange={(open) =>
          updateSearch((s) => ({ ...s, add: open ? 1 : undefined }), { replace: true })
        }
      />
    );
  }),
});

/** Files (docs/decisions/files-space.md AP-773, AP-774): the Chat's files, then another conversation's. */
const filesRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'files',
  validateSearch: validateFilesSearch,
  component: withScreens([FilesScreen], function FilesRoute() {
    const burrow = useOpenBurrow();
    const { folder } = filesRoute.useSearch();
    return <FilesScreen burrow={burrow} folder={folder ?? ''} />;
  }),
});

const filesDmRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'files/dm/$room',
  validateSearch: validateFilesSearch,
  component: withScreens([FilesSpaceScreen], function FilesDmRoute() {
    const burrow = useOpenBurrow();
    const { room } = filesDmRoute.useParams();
    const { folder } = filesDmRoute.useSearch();
    // The person's Chat or Feedback room (FilesPlace `dm`); any other name is not here.
    const place = room === 'chat' || room === 'feedback' ? ({ type: 'dm', room } as const) : null;
    return <FilesSpaceScreen key={room} burrow={burrow} place={place} folder={folder ?? ''} />;
  }),
});

const filesDirectRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'files/direct/$id',
  validateSearch: validateFilesSearch,
  component: withScreens([FilesSpaceScreen], function FilesDirectRoute() {
    const burrow = useOpenBurrow();
    const { id } = filesDirectRoute.useParams();
    const { folder } = filesDirectRoute.useSearch();
    return <FilesSpaceScreen key={id} burrow={burrow} place={{ type: 'direct', id }} folder={folder ?? ''} />;
  }),
});

const filesPrRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'files/pr/$number',
  params: {
    parse: (p) => ({ number: parseNumberParam(p.number) }),
    stringify: (p) => ({ number: String(p.number) }),
  },
  validateSearch: validateFilesSearch,
  component: withScreens([FilesSpaceScreen], function FilesPrRoute() {
    const burrow = useOpenBurrow();
    const { number } = filesPrRoute.useParams();
    const { folder, repo } = filesPrRoute.useSearch();
    return (
      <FilesSpaceScreen
        key={`${repo ?? ''}#${number}`}
        burrow={burrow}
        place={repo ? { type: 'pr', number, repo } : { type: 'pr', number }}
        folder={folder ?? ''}
      />
    );
  }),
});

// Supervised automations (docs/decisions/automation-chat.md): the overview, one automation, a run.
const automationsRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'automations',
  validateSearch: validateAutomationsSearch,
  component: withScreens([AutomationsScreen], function AutomationsRoute() {
    const burrow = useOpenBurrow();
    const search = automationsRoute.useSearch();
    const updateSearch = useSearchUpdate();
    return (
      <AutomationsScreen
        burrow={burrow}
        asking={!!search.new}
        onAsked={() => updateSearch((s) => ({ ...s, new: undefined }), { replace: true })}
      />
    );
  }),
});

const automationRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'automations/$id',
  component: withScreens([AutomationScreen], function AutomationRoute() {
    const burrow = useOpenBurrow();
    const { id } = automationRoute.useParams();
    return <AutomationScreen key={id} burrow={burrow} id={id} />;
  }),
});

const automationRunRoute = createRoute({
  getParentRoute: () => burrowRoute,
  path: 'automation-runs/$number',
  params: {
    parse: (p) => ({ number: parseNumberParam(p.number) }),
    stringify: (p) => ({ number: String(p.number) }),
  },
  component: withScreens([AutomationRunScreen], function AutomationRunRoute() {
    const burrow = useOpenBurrow();
    const { number } = automationRunRoute.useParams();
    return <AutomationRunScreen key={number} burrow={burrow} number={number} />;
  }),
});

export const routeTree = rootRoute.addChildren([
  onboardingRoute,
  connectAiRoute,
  mobileRoute,
  brandRoute,
  useAsScreenRoute,
  burrowRoute.addChildren([
    burrowIndexRoute,
    connectionsRoute,
    dashboardRoute,
    chatRoomRoute,
    codeRoute,
    feedbackRoomRoute,
    needsYouRoute,
    watchRoute,
    doneRoute,
    chatsRoute,
    chatRoute,
    thingRoute,
    skillsRoute,
    prRoute,
    runRoute,
    workRoute,
    workDeploysRoute,
    inboxRoute,
    deploysRoute,
    settingsAgentRoute,
    canvasesRoute,
    canvasRoute,
    logRoute,
    searchRoute,
    settingsRoute,
    screenLayoutRoute,
    feedbackNewRoute,
    feedbackIntegrationRoute,
    automationsRoute,
    automationRoute,
    automationRunRoute,
    vaultRoute,
    filesRoute,
    filesDmRoute,
    filesDirectRoute,
    filesPrRoute,
  ]),
  oldFormRoute,
]);

export interface CreateAppRouterOptions {
  services: AppServices;
  /** Memory history in tests and Storybook; browser history by default. */
  history?: RouterHistory;
}

export function createAppRouter({ services, history }: CreateAppRouterOptions) {
  return createRouter({
    routeTree,
    context: { services },
    ...(history && { history }),
    defaultPreload: 'intent',
    // Route data comes from the TanStack Query cache; the router should not cache loaders itself.
    defaultPreloadStaleTime: 0,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

/* Fallback pages -------------------------------------------------------------------------------- */

function NotFoundPage() {
  return (
    <AuthLayout
      kicker="NOT FOUND"
      title="Nothing lives here"
      sub="The link may be old, or what it pointed to was renamed."
      tip="Search with ⌘K once you’re back in."
    >
      <div className={loginStyles.actions}>
        <a href="/" className={loginStyles.inlineLink}>
          ← Back to your Whombat
        </a>
      </div>
    </AuthLayout>
  );
}

function ErrorPage({ reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <AuthLayout
      kicker="SOMETHING WENT WRONG"
      title="Can’t reach your Whombat"
      sub="Whombat didn’t answer. Check your connection and try again."
      tip="If it keeps happening, the server may be restarting. Give it a minute."
    >
      <div className={loginStyles.actions}>
        <button
          type="button"
          className={loginStyles.inlineLink}
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </button>
      </div>
    </AuthLayout>
  );
}
