import { z } from 'zod';
import { BurrowId } from '../ids.js';
import { isValidBurrowSlug } from '../text/slug.js';
import { Timestamp } from './common.js';
import { BurrowAiGateway } from './gateway.js';
import { LocalModelView } from './local-model.js';
import { Place } from './place.js';
import { WebSearchView } from './web-search.js';

export const BurrowName = z.string().trim().min(1).max(80);

export const BurrowSlug = z.string().refine(isValidBurrowSlug, {
  message: 'Use lowercase letters, digits and dashes, and not a reserved name',
});

/** The tenant. `slug` is the `/:burrow` path segment: `app.whombat.com/{slug}` (`burrowAddress`). */
export const Burrow = z.object({
  id: BurrowId,
  name: BurrowName,
  slug: BurrowSlug,
  /** IANA zone used for day grouping and clock times when the viewer has none (seed: Europe/Amsterdam). */
  timeZone: z.string().min(1),
  /**
   * Link previews under messages (0.26, CT-174): absent or true = on; owners turn them off with `burrows.update`
   * (`linkPreviewsOn`).
   */
  linkPreviews: z.boolean().optional(),
  /**
   * “Agents may reach your local network” (Whombat resourceful-agents.md RA-41, 0.44.0; local-network.md LN-01, 0.56.0):
   * on a Whombat appliance, the agent's commands and Whombat itself (Vault entries, Connections, SSH, the browser) reach
   * every private address (production servers stay closed). Off: only the Vault's home network list. Absent or true =
   * on; the person switches it with `burrows.setAgentsReachLan`.
   */
  agentsReachLan: z.boolean().optional(),
  /**
   * The AI gateway (0.76, CT-332; Whombat ai-gateway.md AIG-05): the burrow's gateway connection (Fusebox or another AI
   * gateway) and whether Claude Code and ChatGPT turns go through it (`aiGatewayFor`). Null or absent: no gateway
   * connected. Owners switch it with `burrows.setAiGateway`.
   */
  aiGateway: BurrowAiGateway.nullable().optional(),
  /**
   * The model on the owner's network (0.124, CT-1170; Whombat hermes-engine.md HE-32): what turns on the provider
   * `local` run on, without its key. Null: none set. Owners change it with `burrows.setLocalModel` and
   * `burrows.clearLocalModel`; `burrows.testLocalModel` updates its `check`.
   */
  localModel: LocalModelView.nullable().default(null),
  /**
   * Web search for the agent (Whombat web-search.md): on with a Brave Search key, never the key. Null: off. The person
   * changes it with `burrows.setWebSearch` and `burrows.clearWebSearch`; `burrows.testWebSearch` updates its `check`.
   */
  webSearch: WebSearchView.nullable().default(null),
  /**
   * Where this Whombat is, for the weather and the suggested news (Whombat weather-news.md): the place the person chose,
   * else the one its time zone suggests (`guessed`, `placeFromTimeZone`); null when neither (a zone of no country). The
   * person or the assistant changes it with `place.set`.
   */
  place: Place.nullable().default(null),
  createdAt: Timestamp,
});
export type Burrow = z.infer<typeof Burrow>;

/** Whether agents may reach the local network (RA-41, LN-01; the default: yes). */
export function agentsReachLanOn(burrow: { agentsReachLan?: boolean }): boolean {
  return burrow.agentsReachLan !== false;
}

/** Whether the burrow shows link previews (the default: yes). */
export function linkPreviewsOn(burrow: { linkPreviews?: boolean }): boolean {
  return burrow.linkPreviews !== false;
}
