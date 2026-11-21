import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { createFakeSession, restHandler, restResources } from '@whombat/client/fake';
import { beforeAll } from 'vitest';
import { App } from '../app/App';
import type { WebFixtureOptions } from '../app/fixtureFetch';
import { routeTree } from '../app/router';
import { type AppServices, type CreateServicesOptions, createAppServices } from '../app/services';
import { loadPaneChunks } from '../app/shell/hosts';

interface ScreenRoute {
  options: { component?: { preload?: () => unknown } };
  children?: readonly ScreenRoute[];
}

function routeScreens(route: ScreenRoute): unknown[] {
  return [route.options.component?.preload?.(), ...(route.children ?? []).flatMap(routeScreens)];
}

/**
 * Every screen, pane and modal the app loads on first use. In a test run the first load of a screen means
 * transforming its whole module graph, shared with every other worker: on a cold cache with the machine busy that
 * takes longer than a `findBy` waits, and the first tests of a file failed on an empty page. Loading them before the
 * file's tests start leaves each test's waits for what the app does.
 */
async function loadScreens(): Promise<void> {
  await Promise.all([
    ...routeScreens(routeTree as unknown as ScreenRoute),
    loadPaneChunks(),
    import('../features/things/tasks/HostTasks'),
  ]);
}

// Every file that renders the app imports this module, so the hook is registered on each of them. Its wait is for
// the bundler, not for the app: it is long enough for a cold run on a busy machine and still ends a hung load.
beforeAll(loadScreens, 120_000);

export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
}

/** Fixture-mode services (the mock world, no socket), signed in as Mara unless told otherwise. */
export function fixtureServices(options: WebFixtureOptions = {}): AppServices {
  return createAppServices({ fixtures: options, queryClient: testQueryClient() });
}

/**
 * Services on a box that answers with a mocked REST `fetch` (relative `/api/v1/…` paths; no realtime): a session on
 * the in-memory box (hermes-engine-app.md AP-5303).
 */
export function mockedServices(
  fetch: typeof globalThis.fetch,
  extra: CreateServicesOptions = {},
): AppServices {
  const rest = fetch as unknown as (url: string, init: RequestInit) => Promise<Response>;
  const { session } = createFakeSession({
    handle: restHandler(rest, { origin: '' }),
    resources: restResources(rest, ''),
    account: { id: 'acc_mara', name: 'Mara Okafor' },
  });
  return createAppServices({
    session,
    realtime: null,
    queryClient: testQueryClient(),
    ...extra,
  });
}

/** Renders the whole app (router, shell, providers) at `url`. */
export function renderApp(url: string, services: AppServices = fixtureServices()) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const utils = render(<App services={services} history={history} />);
  const location = () => `${history.location.pathname}${history.location.search}`;
  return { ...utils, services, history, location };
}
