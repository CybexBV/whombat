/**
 * A service page a group adds to fixture mode (docs/service-pages.md, step 5): one entry in its group's file
 * (`first.ts`, `home.ts`, …) shows the page in the web's and the phone's fixture mode at `/things/<thing>`, lists the
 * connection in the sidebar, Home and Connections, and answers its buttons — with no edit to `servicePages.ts`.
 *
 * ```ts
 * export const STORAGE_PAGES: FixtureServicePage[] = [
 *   {
 *     thing: 'connection:con_truenas',
 *     catalogId: 'truenas',
 *     name: 'TrueNAS',
 *     fields: { url: 'https://10.100.0.30' },
 *     make: ({ now, ago, lookOnly }) => {
 *       let scrubbing = false; // what the buttons change, kept for this world
 *       return {
 *         page: () => ({ id: 'connection:con_truenas', kind: 'connection', … }), // a ThingPage, in slots
 *         row: () => ({ line: '3 pools · 62 % used', facts: [{ label: 'Pools', value: '3' }] }),
 *         action: ({ action, target }) =>
 *           action === 'scrub' && !scrubbing ? ((scrubbing = true), { message: 'Scrubbing tank.' }) : null,
 *         checks: [{ check: 'truenas.pool', name: 'Pools filling up', nature: 'problem', perItem: true }],
 *       };
 *     },
 *   },
 * ];
 * ```
 *
 * A page the fixture world already draws (UniFi `connection:con_unifi`, Hetzner `connection:con_hetzner`, Protect
 * `connection:con_protect`) is replaced by giving its thing id: the group's page and row win. Pictures come from
 * `../pictures.js` (`fixtureImage`); `servicePages.test.ts` parses every page and row with the contract.
 */
import type { ThingActionBody } from '@whombat/core/contracts';
import type { ThingPage, ThingSummary, ThingWatchCheck } from '@whombat/core/domain';

/** What a group's page is built with: the fixture world's clock and whether every button is Look only. */
export interface FixtureServiceCtx {
  /** Now, in milliseconds: every time on the page is relative to it. */
  now(): number;
  /** That long ago, as an ISO time. */
  ago(ms: number): string;
  /** Every button drawn as on Look only; presses are refused before `action` is asked. */
  lookOnly: boolean;
}

/** One world's copy of a group's page: its state lives in the closure `make` returns. */
export interface FixtureService {
  /** The page as the server would answer it now (`ThingPage`, its Summary in slots). */
  page(): ThingPage;
  /** Its row in the sidebar, Home and Connections; absent, the page's badge. Its status is the page's. */
  row?(): { line?: string; facts?: ThingSummary['facts']; reason?: string };
  /** A pressed button: the words Whombat says (`recorded`: it shows in Changes), or null for “nothing to do”. */
  action?(body: ThingActionBody): { message: string; recorded?: boolean } | null;
  /** What Whombat watches on it, after every connection's own checks. */
  checks?: Omit<ThingWatchCheck, 'on' | 'off' | 'exceptions'>[];
}

export interface FixtureServicePage {
  /** `connection:con_<name>`; the id of a page the world draws already replaces it. */
  thing: `connection:${string}`;
  /** The catalog's id (`truenas`, `unifi_network`): its icon and its Settings tab's tools in the web's world. */
  catalogId: string;
  /** Its name in the sidebar. */
  name: string;
  /** Its connection's fields in the web's world (the service's address), shown in its Settings tab. */
  fields?: Record<string, string>;
  /** Makes this world's copy (called once per fixture world). */
  make(ctx: FixtureServiceCtx): FixtureService;
}
