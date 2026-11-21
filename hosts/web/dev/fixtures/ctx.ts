// Request context shared by the fixture route handlers.

import { type FixtureSet, loadFixtures } from './data.ts';
import type { FxRequest } from './http.ts';
import type { BrowserState, FixtureStore } from './state.ts';

export interface Ctx {
  store: FixtureStore;
  st: BrowserState;
  req: FxRequest;
  /** Fresh fixture copies, loaded on first use per request. */
  fx: () => FixtureSet;
}

export function makeCtx(store: FixtureStore, st: BrowserState, req: FxRequest): Ctx {
  let cached: FixtureSet | null = null;
  return { store, st, req, fx: () => (cached ??= loadFixtures()) };
}
